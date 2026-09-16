// [LAW:decomposition] The unit player: it plays the timeline's segments — the synthesis
// worker's PCM frames for the speech, silence for the gaps — through Web Audio as one
// sequence on the context clock, and answers where playback is. One sentence, no "and":
// this module turns a layout and delivered frames into scheduled audio. It does not decide
// which units to synthesize or when (the scheduler, q35.wuv), it does not know the
// manifest or paint a cursor (the panel, q35.9), and it never touches the worker protocol —
// the scheduler translates `audio`/`done` messages into the deliveries below, so this
// module is driven in its check by a stub device and a hand-built frame stream
// [LAW:composability].
//
// THE SEQUENCE IS THE TIMELINE'S LAYOUT. The player is built over the layout timeline.ts
// lays the clock on — speech slots naming units, silence slots of their own length,
// between speakers — and plays the slots in order, so the slot the player is in and the
// segment the clock is in are one index [LAW:one-source-of-truth]. A silence slot belongs
// to no unit: it is cued as silence of its own length at the schedule's rate like every
// slot, its `ended` event marks its end like every other boundary, and a position inside it
// is an offset into that slot, never an offset of any unit. Audio for the speech after a
// gap starts no earlier than the gap's end, because that is where the schedule puts it;
// audio that arrives later starts when it arrives, at the sample the schedule ran dry at —
// which is the starvation rule below, unchanged — so a late unit lengthens the gap and
// nothing ever shortens it [LAW:dataflow-not-control-flow].
//
// WHY BUFFER SOURCES, NOT AN AUDIOWORKLET RING. The ticket's deciding question is whether a
// seek within a unit must be sample-accurate; both mechanisms can be, so the choice falls
// to what each costs. One AudioBufferSourceNode per 80 ms frame, each started at an exact
// context time, makes position a pure reading of `context.currentTime` against the times
// the slots were scheduled to begin — no sample counter inside a worklet, no message port
// carrying it back late, no second clock [LAW:one-source-of-truth]. A seek is
// `start(when, offset)` on the frame that holds the target sample, which the context
// honours to the sample. And there is no second module to bundle as a worklet processor.
// A worklet's real advantage, tolerance for main-thread jitter, matters when buffers are a
// few milliseconds; ours are 80 ms and scheduled ahead of the clock, so a stall long enough
// to empty this schedule would equally empty a ring. Cost, stated once: twelve and a half
// nodes a second, each released when it ends, and a per-frame copy into an AudioBuffer.
//
// ONE CLOCK. The context's clock is the only timing authority here: no setTimeout, no
// requestAnimationFrame, no counter. While speaking, position is derived on every read;
// while paused, the state holds the sample it stopped at and the context is suspended, so
// the state's own shape says which representation is authoritative and the two can never
// disagree [LAW:no-ambient-temporal-coupling]. A slot boundary is gapless because the next
// slot's first frame is scheduled at exactly the previous slot's last sample end, as soon
// as it is delivered, while the current one is still playing.
//
// STARVATION. When playback reaches the end of everything delivered, the schedule simply
// has nothing after its cursor: the position clamps to that edge, the last live source
// ends, and the state reads `speaking` with `flow: "waiting"` at the exact sample the next
// frame must supply — the honest "synthesizing ahead" the scheduler shows rather than a
// stall nobody named [LAW:no-silent-failure]. The next delivery re-anchors the schedule at
// the clock and continues from that sample.
//
// THE DELIVERY CONTRACT, stated here so the scheduler reads the same sentence: a unit's
// frames arrive in order from frameIndex 0, each exactly `frameSamples` long; `complete`
// closes a unit that has at least one frame, once; re-synthesizing a unit requires `drop`
// first; and the unit whose slot the schedule is about to play cannot be dropped. Every
// violation is a RangeError at the delivery, not a silent skip [LAW:no-silent-failure].
//
// SLOT BOUNDARIES ARE REPORTED. Every frame is its own source and the last frame of a slot
// ends exactly at the boundary — a silence slot is one frame of its whole length — so its
// `ended` event is the context's own notice that the cursor has crossed into the next slot;
// `onState` fires there. This is not a second clock — no timer is set — it is the one
// clock's event, and it is the tick the scheduler needs to slide its window without
// polling [LAW:no-ambient-temporal-coupling].
//
// SPEED SHIFTS PITCH, AND THAT IS THE CHOSEN COST. A rate belongs to the schedule, not to a
// source: every source in one schedule is started at the same `playbackRate`, and a change
// re-anchors the schedule at the sample under the clock, exactly as a seek does. That keeps
// position a pure reading of `context.currentTime` against the times slots were scheduled to
// begin — the one clock this module exists to preserve [LAW:one-source-of-truth]. The
// alternative the ticket weighed, a pitch-preserving time-stretch in an AudioWorklet, cannot
// keep it: a stretcher's output is its own sample counter behind a message port, which is a
// second clock reporting late, and every reading here — the cursor, the scrubber, the slot
// boundary the scheduler slides its window on — would have to come from it instead. So the
// resampling shift is accepted and stated: at 1.25x the voice is a little brighter, at 2.5x
// it is plainly higher. A gap at 2x is a quarter of a second, like every other segment.
//
// Not here, deliberately: the word cursor (the panel samples `state().at` on its paint
// clock and asks the timeline — a boundary timer in this module would be a second clock),
// the lookahead window and memory bound (the scheduler decides what to `drop`), and a fade
// on seek and pause (a cut mid-sample can click; the UX epic owns the ramp).

import { MODEL_ASSETS } from "./modelAssets";
import { NORMAL, type Speed } from "./performer";
import type { Slot } from "./timeline";

// ── the PCM the player speaks ──────────────────────────────────────────────────────────

export interface PcmFormat {
  readonly sampleRate: number;
  readonly frameSamples: number;
}

// [LAW:one-source-of-truth] The model's format, read from the asset manifest that every
// frame-time reading already derives from.
export const MODEL_PCM: PcmFormat = { sampleRate: MODEL_ASSETS.weights.sampleRate, frameSamples: MODEL_ASSETS.weights.frameSamples };

// How far ahead of the clock a fresh schedule starts. It must outlast the gap between
// reading `currentTime` on the main thread and the render thread picking up the first
// source — a render quantum or two plus main-thread jitter — and every later frame is
// scheduled against the cursor, so this is paid once per play, resume, seek or relief.
export const SCHEDULE_LEAD_S = 0.05;

// ── the device seam ────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] Exactly the surface of Web Audio this module uses, so a real
// AudioContext satisfies it structurally and the check's stub implements nothing more.
export interface PcmBuffer {
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void;
}

export interface PcmSource {
  buffer: PcmBuffer | null;
  readonly playbackRate: { value: number };
  onended: ((event: Event) => unknown) | null;
  connect(destination: unknown): unknown;
  start(when: number, offset: number): void;
  stop(): void;
}

export interface PlaybackDevice {
  readonly currentTime: number;
  readonly destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): PcmBuffer;
  createBufferSource(): PcmSource;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

// `AudioContext` in the page: what opens a device.
export type DeviceFactory = new (options: { readonly sampleRate: number }) => PlaybackDevice;

// [LAW:parse-dont-validate] A device is opened by `openDevice` alone, at the PCM's rate,
// and travels with the format it was opened at, so a frame seam is never resampled and the
// sample arithmetic below is exact on the context's clock: held by construction, never
// checked.
export interface OpenDevice {
  readonly device: PlaybackDevice;
  readonly format: PcmFormat;
}

// [LAW:no-ambient-temporal-coupling] Called by the device's owner: on the reader's gesture
// when there is one, since a context opened inside the tap is what lets audio scheduled
// later — once the model is warm — sound; or outside any gesture for a voice built on a
// standing consent, which opens suspended and is resumed by the reader's first Play
// through the player. The owner closes what it opened; the player borrows it.
export const openDevice = (Device: DeviceFactory, format: PcmFormat = MODEL_PCM): OpenDevice => ({
  device: new Device({ sampleRate: format.sampleRate }),
  format,
});

// ── the store ──────────────────────────────────────────────────────────────────────────

export interface UnitAudio {
  readonly frames: ReadonlyArray<Float32Array<ArrayBuffer>>;
  readonly complete: boolean;
}

// What the planner reads: the frames delivered so far per unit index, and whether the
// unit is closed. A unit's audio is `frames.length * frameSamples` samples, exactly the
// `durationMs` the worker reports for it.
export type UnitStore = ReadonlyMap<number, UnitAudio>;

// [LAW:one-type-per-behavior] What a slot plays, in the store's own shape: a speech slot
// plays what has been delivered of its unit, in frames of `frameSamples`; a silence slot
// plays one frame of zeros, its whole length, complete from the start. The schedule walks
// both by one rule; only these two readings know which is which. A zero-length silence
// would be a frame no sample can fall in: `createUnitPlayer` refuses such a layout at its
// door, so it never reaches here.
export const silenceSamples = (slot: Extract<Slot, { kind: "silence" }>, format: PcmFormat): number =>
  Math.round((slot.ms * format.sampleRate) / 1000);
const audioOf = (slot: Slot, store: UnitStore, format: PcmFormat): UnitAudio | undefined =>
  slot.kind === "silence" ? { frames: [new Float32Array(new ArrayBuffer(4 * silenceSamples(slot, format)))], complete: true } : store.get(slot.span);
const frameSamplesOf = (slot: Slot, format: PcmFormat): number => (slot.kind === "silence" ? silenceSamples(slot, format) : format.frameSamples);

// ── the schedule: pure ─────────────────────────────────────────────────────────────────

// A position in samples: a slot of the layout and a sample into it, integers, so every
// comparison below is exact.
export interface Sample {
  readonly slot: number;
  readonly sample: number;
}

// The context time at which sample 0 of a slot plays under the current schedule.
export interface SlotStart {
  readonly slot: number;
  readonly time: number;
}

// Everything scheduled since the last anchor. `cursor` is the context time the next
// scheduled sample would play — the end of the audio the context holds. `need` is that
// sample: the next one to schedule, or `slot === layout.length`, one past the end, when the
// last slot has been scheduled to its last sample. `starts` always holds the anchored slot
// first, so a position lookup is total. `rate` is the speed every source in this schedule
// was started at, which is what makes context seconds and samples convertible both ways; a
// change of speed opens a new schedule rather than mixing two rates under one set of times.
export interface Schedule {
  readonly anchor: number;
  readonly cursor: number;
  readonly starts: readonly [SlotStart, ...SlotStart[]];
  readonly need: Sample;
  readonly rate: Speed;
}

// [LAW:single-enforcer] Samples of audio per second of the CONTEXT's clock at a given
// speed: the one conversion every time below is stated in terms of, so a rate can never be
// applied to the cursor and forgotten on the position, or the other way about.
const perSecond = (format: PcmFormat, rate: Speed): number => format.sampleRate * rate;

// One frame to hand the device: play `pcm`, whatever its length, at `when`, skipping its
// first `skip` samples.
export interface Cue {
  readonly pcm: Float32Array<ArrayBuffer>;
  readonly when: number;
  readonly skip: number;
}

export const openSchedule = (from: Sample, anchor: number, format: PcmFormat, rate: Speed = NORMAL): Schedule => ({
  anchor,
  cursor: anchor,
  need: from,
  rate,
  starts: [{ slot: from.slot, time: anchor - from.sample / perSecond(format, rate) }],
});

// [LAW:effects-at-boundaries] Schedule every frame the layout and the store can supply at
// the cursor, as data: the cues for the device and the schedule after them. The same
// three-way question is asked per step — the frame is here, or the slot is still open, or
// the slot is closed and the next begins at the cursor — so a seek past a unit's end
// resolves to the start of the following slot by the same rule that carries ordinary
// playback across a boundary, and a silence slot, one frame long and closed from the
// start, is walked by the very same steps [LAW:dataflow-not-control-flow].
export const extend = (
  schedule: Schedule,
  store: UnitStore,
  layout: ReadonlyArray<Slot>,
  format: PcmFormat,
): { readonly schedule: Schedule; readonly cues: ReadonlyArray<Cue> } => {
  const perSec = perSecond(format, schedule.rate);
  const cues: Cue[] = [];
  const starts: [SlotStart, ...SlotStart[]] = [...schedule.starts];
  let { cursor, need } = schedule;
  for (let slot = layout[need.slot]; slot !== undefined; slot = layout[need.slot]) {
    const audio = audioOf(slot, store, format);
    if (audio === undefined) break;
    const frameSamples = frameSamplesOf(slot, format);
    const frame = Math.floor(need.sample / frameSamples);
    const pcm = audio.frames[frame];
    if (pcm !== undefined) {
      const skip = need.sample - frame * frameSamples;
      cues.push({ pcm, when: cursor, skip });
      cursor += (frameSamples - skip) / perSec;
      need = { slot: need.slot, sample: (frame + 1) * frameSamples };
      continue;
    }
    if (!audio.complete) break;
    need = { slot: need.slot + 1, sample: 0 };
    if (need.slot < layout.length) starts.push({ slot: need.slot, time: cursor });
  }
  return { schedule: { ...schedule, cursor, need, starts }, cues };
};

// [LAW:one-source-of-truth] Where playback is at context time `time`, read off the
// schedule: clamped to the audio actually scheduled, so before the anchor it is the
// position played from and at or past the cursor it is exactly the next sample needed.
export const positionAt = (schedule: Schedule, time: number, format: PcmFormat): Sample => {
  const t = Math.min(Math.max(time, schedule.anchor), schedule.cursor);
  let start = schedule.starts[0];
  for (const candidate of schedule.starts) if (candidate.time <= t) start = candidate;
  return { slot: start.slot, sample: Math.round((t - start.time) * perSecond(format, schedule.rate)) };
};

// ── the player ─────────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] Where playback is, in the player's own coordinates: a
// segment of the layout — the timeline's segment of the same index — and how far into it.
// Inside a gap it is an offset into that silence segment, of no unit; the neural
// performer turns it into a time on the conversation's timeline, which is what everything
// else reads. The offset is never negative: a slot begins at its own sample zero.
export interface SegmentOffset {
  readonly segment: number;
  readonly offsetMs: number;
}

// The performer's three kinds (performer.ts), as the panel reads them; `at` is derived
// from the clock on every read while speaking. `flow` says whether the context holds
// audio or playback has caught up with delivery and is waiting for the sample at `at`.
export type Flow = "audio" | "waiting";

export type PlayerState =
  | { readonly kind: "idle" }
  | { readonly kind: "speaking"; readonly at: SegmentOffset; readonly flow: Flow }
  | { readonly kind: "paused"; readonly at: SegmentOffset };

// Everything that moves the player, as data, from its two speakers: the reader's controls
// and the scheduler's deliveries. One closed set, one `send`, one place effects happen
// [LAW:single-enforcer].
export type PlayerEvent =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "stop" }
  | { readonly kind: "seek"; readonly to: SegmentOffset }
  | { readonly kind: "rate"; readonly to: Speed }
  | { readonly kind: "frame"; readonly unit: number; readonly frameIndex: number; readonly pcm: Float32Array<ArrayBuffer> }
  | { readonly kind: "complete"; readonly unit: number }
  | { readonly kind: "drop"; readonly unit: number };

export interface UnitPlayerConfig {
  // The device the player plays on, borrowed from the owner that opened it.
  readonly device: OpenDevice;
  // The timeline's layout: the sequence the player plays, slot for slot. A speech slot's
  // span is the unit whose frames it plays; the units are numbered by these spans.
  readonly layout: ReadonlyArray<Slot>;
  // Called after every discontinuity — play, pause, stop, seek, starvation and its relief,
  // the end of the last slot — and after every slot boundary the clock crosses, which is
  // the scheduler's cue to synthesize further ahead. Continuous motion within a slot is
  // read with `state()`.
  readonly onState: (state: PlayerState) => void;
}

export interface UnitPlayer {
  readonly send: (event: PlayerEvent) => void;
  readonly state: () => PlayerState;
  // Stops: the sources silenced, the device suspended and handed back to its owner to
  // close. The player's last call, made once by its one owner; a send after it is the
  // caller's bug, and the device its owner has closed by then rejects it.
  readonly dispose: () => void;
}

type Speaking = { readonly kind: "speaking"; schedule: Schedule; readonly sources: Set<PcmSource> };
type Live = { readonly kind: "idle" } | { readonly kind: "paused"; readonly at: Sample } | Speaking;

const sameSample = (a: Sample, b: Sample): boolean => a.slot === b.slot && a.sample === b.sample;

interface MutableUnitAudio {
  readonly frames: Float32Array<ArrayBuffer>[];
  complete: boolean;
}

const IDLE: Live = { kind: "idle" };

// [LAW:parse-dont-validate] The layout, admitted once: every speech slot names a unit in
// order from zero — which is what lets a delivery's unit index find its slot — and every
// silence has a length a sample can fall in. `layoutOf` builds nothing else; a layout that
// is not its work is refused here rather than played wrongly [LAW:no-silent-failure].
const slotsOfUnits = (layout: ReadonlyArray<Slot>): ReadonlyArray<number> => {
  const slots: number[] = [];
  layout.forEach((slot, index) => {
    if (slot.kind === "silence") {
      if (!(slot.ms > 0)) throw new RangeError(`unit player: slot ${index} is a silence of ${slot.ms} ms`);
      return;
    }
    if (slot.span !== slots.length) throw new RangeError(`unit player: slot ${index} names unit ${slot.span}, expected ${slots.length}`);
    slots.push(index);
  });
  return slots;
};

export const createUnitPlayer = (config: UnitPlayerConfig): UnitPlayer => {
  const { layout, onState } = config;
  const { device, format } = config.device;
  const slotOfUnit = slotsOfUnits(layout);
  // [LAW:no-shared-mutable-globals] Owned here; both written only through `send`. The rate
  // outlives every schedule — a seek, a pause, a starvation and the units themselves all
  // open new schedules at whatever speed the reader last chose, which is what makes speed
  // persist across units without anyone re-sending it.
  const store = new Map<number, MutableUnitAudio>();
  let live: Live = IDLE;
  let rate: Speed = NORMAL;

  const toOffset = (at: Sample): SegmentOffset => ({ segment: at.slot, offsetMs: (at.sample / format.sampleRate) * 1000 });
  const flowOf = (speaking: Speaking): Flow => (speaking.sources.size > 0 ? "audio" : "waiting");

  const state = (): PlayerState => {
    switch (live.kind) {
      case "idle":
        return { kind: "idle" };
      case "paused":
        return { kind: "paused", at: toOffset(live.at) };
      case "speaking":
        return { kind: "speaking", at: toOffset(positionAt(live.schedule, device.currentTime, format)), flow: flowOf(live) };
    }
  };

  // ── effects ──

  const silence = (speaking: Speaking): void => {
    for (const source of speaking.sources) source.stop();
    // Cleared before their `ended` events arrive, which is what makes those events
    // recognisable as stale below.
    speaking.sources.clear();
  };

  // Finished and silent — the last slot scheduled to its end and every source ended — is
  // idle; the context is released until the next play.
  const settle = (speaking: Speaking): void => {
    if (speaking.sources.size === 0 && speaking.schedule.need.slot === layout.length) {
      live = IDLE;
      void device.suspend();
    }
  };

  const perform = (speaking: Speaking, cues: ReadonlyArray<Cue>): void => {
    for (const cue of cues) {
      const buffer = device.createBuffer(1, cue.pcm.length, format.sampleRate);
      buffer.copyToChannel(cue.pcm, 0);
      const source = device.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = speaking.schedule.rate;
      source.connect(device.destination);
      // A source silenced by pause, stop or seek is no longer in its set: its late `ended`
      // reports on audio the player already abandoned and changes nothing.
      source.onended = () =>
        transition(() => {
          if (speaking.sources.delete(source) && speaking.sources.size === 0) settle(speaking);
        });
      speaking.sources.add(source);
      source.start(cue.when, cue.skip / format.sampleRate);
    }
  };

  const fill = (speaking: Speaking): void => {
    const { schedule, cues } = extend(speaking.schedule, store, layout, format);
    speaking.schedule = schedule;
    perform(speaking, cues);
    settle(speaking);
  };

  // A fresh schedule from `from`, anchored just ahead of the clock.
  const begin = (from: Sample): void => {
    if (live.kind === "speaking") silence(live);
    const speaking: Speaking = {
      kind: "speaking",
      schedule: openSchedule(from, device.currentTime + SCHEDULE_LEAD_S, format, rate),
      sources: new Set(),
    };
    live = speaking;
    fill(speaking);
  };

  // Play from a position: the one path play, resume and seek share. `resume()` runs on the
  // caller's stack, which is the reader's gesture — the unlock iOS requires.
  const run = (from: Sample): void => {
    void device.resume();
    begin(from);
  };

  const hold = (at: Sample): void => {
    if (live.kind === "speaking") silence(live);
    live = { kind: "paused", at };
    void device.suspend();
  };

  // A delivery landed. A speaking schedule whose cursor the clock has passed has run dry:
  // it is re-anchored at the sample it needs, which is where the position already reads.
  const arrived = (): void => {
    if (live.kind !== "speaking") return;
    if (live.schedule.cursor < device.currentTime) begin(live.schedule.need);
    else fill(live);
  };

  // ── admission: the delivery contract, enforced at the door [LAW:parse-dont-validate] ──

  // [LAW:single-enforcer] What a unit index is, decided once for every delivery: an
  // integer within the script. `by` names the event for the error.
  const unitIndex = (index: number, by: string): number => {
    if (!Number.isInteger(index) || index < 0 || index >= slotOfUnit.length) {
      throw new RangeError(`unit player: ${by} names unit ${index} of ${slotOfUnit.length}`);
    }
    return index;
  };

  // The unit's entry, held or fresh; the caller stores it once the delivery is accepted,
  // so a refused delivery leaves nothing behind.
  const unitOf = (event: Extract<PlayerEvent, { unit: number }>): MutableUnitAudio =>
    store.get(unitIndex(event.unit, event.kind)) ?? { frames: [], complete: false };

  // A seek names a segment of the layout, speech or silence, and an offset into it.
  const toSample = (to: SegmentOffset): Sample => {
    if (!Number.isInteger(to.segment) || to.segment < 0 || to.segment >= layout.length) {
      throw new RangeError(`unit player: seek names segment ${to.segment} of ${layout.length}`);
    }
    if (!Number.isFinite(to.offsetMs) || to.offsetMs < 0) {
      throw new RangeError(`unit player: cannot seek to ${to.offsetMs} ms`);
    }
    return { slot: to.segment, sample: Math.round((to.offsetMs * format.sampleRate) / 1000) };
  };

  const apply = (event: PlayerEvent): void => {
    switch (event.kind) {
      case "play":
        // Already speaking is a true no-op; resuming keeps the held position, starting
        // from idle begins at the top.
        if (live.kind === "speaking") return;
        run(live.kind === "paused" ? live.at : { slot: 0, sample: 0 });
        return;
      case "pause":
        if (live.kind === "speaking") hold(positionAt(live.schedule, device.currentTime, format));
        return;
      case "stop":
        if (live.kind === "idle") return;
        if (live.kind === "speaking") silence(live);
        live = IDLE;
        void device.suspend();
        return;
      case "rate": {
        // The one fact that changes, then the same re-anchor a seek performs: the sample
        // under the clock is where the new speed starts, so the reader hears the words they
        // were hearing, faster. A rate that is already the rate changes nothing — the
        // schedule would be re-opened for no audible reason [LAW:dataflow-not-control-flow].
        if (event.to === rate) return;
        rate = event.to;
        if (live.kind === "speaking") begin(positionAt(live.schedule, device.currentTime, format));
        return;
      }
      case "seek": {
        // Seeking while paused moves the held position; the reader asked to move, not to
        // start. Otherwise it plays from there, from buffered samples when they exist and
        // otherwise waiting at that sample, which is the request the scheduler answers.
        const at = toSample(event.to);
        // The hold is the same hold when the sample is the same: nothing to report.
        if (live.kind === "paused") live = sameSample(live.at, at) ? live : { kind: "paused", at };
        else run(at);
        return;
      }
      case "frame": {
        const audio = unitOf(event);
        if (event.pcm.length !== format.frameSamples) {
          throw new RangeError(
            `unit player: frame ${event.frameIndex} of unit ${event.unit} has ${event.pcm.length} samples, not ${format.frameSamples}`,
          );
        }
        if (audio.complete) throw new RangeError(`unit player: unit ${event.unit} is complete; drop it before delivering again`);
        if (event.frameIndex !== audio.frames.length) {
          throw new RangeError(`unit player: frame ${event.frameIndex} of unit ${event.unit} arrived after ${audio.frames.length} frames`);
        }
        audio.frames.push(event.pcm);
        store.set(event.unit, audio);
        arrived();
        return;
      }
      case "complete": {
        const audio = unitOf(event);
        if (audio.complete) throw new RangeError(`unit player: unit ${event.unit} completed twice`);
        // A unit with no audio would be skipped in silence; the worker never ends one
        // without a frame, so a frameless complete is a broken delivery.
        if (audio.frames.length === 0) throw new RangeError(`unit player: unit ${event.unit} completed before any frame`);
        audio.complete = true;
        store.set(event.unit, audio);
        arrived();
        return;
      }
      case "drop":
        unitOf(event);
        if (live.kind === "speaking" && live.schedule.need.slot === slotOfUnit[event.unit]) {
          throw new RangeError(`unit player: unit ${event.unit} is being played and cannot be dropped`);
        }
        store.delete(event.unit);
        return;
    }
  };

  // [LAW:single-enforcer] Every change runs through here: the state is reported exactly
  // when the player moved to a different schedule, hold or idle, or its discrete reading —
  // the flow, the segment under the cursor — differs from the last report; never for a
  // redundant event, a delivery that merely extended the schedule, or a source ending
  // mid-segment. The reading is compared against the last REPORT rather than the moment
  // before the change because the source whose `ended` carries the player across a segment
  // boundary fires after the clock has already crossed it [LAW:one-source-of-truth].
  let reported: PlayerState = { kind: "idle" };
  const discrete = (s: PlayerState): string => (s.kind === "speaking" ? `${s.kind} ${s.flow} ${s.at.segment}` : s.kind);
  const transition = (change: () => void): void => {
    const before = live;
    change();
    const now = state();
    if (live !== before || discrete(now) !== discrete(reported)) {
      reported = now;
      onState(now);
    }
  };

  const send = (event: PlayerEvent): void => transition(() => apply(event));
  return {
    send,
    state,
    dispose: () => send({ kind: "stop" }),
  };
};
