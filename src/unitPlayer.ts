// [LAW:decomposition] The unit player: it plays the synthesis worker's PCM frames through
// Web Audio, gapless across units, and answers where playback is. One sentence, no "and":
// this module turns delivered frames into scheduled audio on the context clock. It does not
// decide which units to synthesize or when (the scheduler, q35.wuv), it does not know the
// manifest or paint a cursor (the panel, q35.9), and it never touches the worker protocol —
// the scheduler translates `audio`/`done` messages into the deliveries below, so this
// module is driven in its check by a stub device and a hand-built frame stream
// [LAW:composability].
//
// WHY BUFFER SOURCES, NOT AN AUDIOWORKLET RING. The ticket's deciding question is whether a
// seek within a unit must be sample-accurate; both mechanisms can be, so the choice falls
// to what each costs. One AudioBufferSourceNode per 80 ms frame, each started at an exact
// context time, makes position a pure reading of `context.currentTime` against the times
// the units were scheduled to begin — no sample counter inside a worklet, no message port
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
// disagree [LAW:no-ambient-temporal-coupling]. A unit boundary is gapless because the next
// unit's first frame is scheduled at exactly the previous unit's last sample end, as soon
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
// closes the unit once; re-synthesizing a unit requires `drop` first; and the unit the
// schedule is about to play cannot be dropped. Every violation is a RangeError at the
// delivery, not a silent skip [LAW:no-silent-failure].
//
// Not here, deliberately: the word cursor (the panel samples `state().at` on its paint
// clock and asks the manifest — a boundary timer in this module would be a second clock),
// the lookahead window and memory bound (the scheduler decides what to `drop`), and a fade
// on seek and pause (a cut mid-sample can click; the UX epic owns the ramp).

import { MODEL_ASSETS } from "./modelAssets";
import type { Position } from "./speechManifest";

// ── the PCM the player speaks ──────────────────────────────────────────────────────────

export interface PcmFormat {
  readonly sampleRate: number;
  readonly frameSamples: number;
}

// [LAW:one-source-of-truth] The model's format, read from the asset manifest that every
// frame-time reading already derives from.
export const MODEL_PCM: PcmFormat = { sampleRate: MODEL_ASSETS.sampleRate, frameSamples: MODEL_ASSETS.frameSamples };

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
}

// `AudioContext` in the page. The player constructs the device itself, at the PCM's rate,
// so a frame seam is never resampled and the sample arithmetic below is exact on the
// context's clock: that invariant is held by construction, never checked.
export type DeviceFactory = new (options: { readonly sampleRate: number }) => PlaybackDevice;

// ── the store ──────────────────────────────────────────────────────────────────────────

export interface UnitAudio {
  readonly frames: ReadonlyArray<Float32Array<ArrayBuffer>>;
  readonly complete: boolean;
}

// What the planner reads: the frames delivered so far per unit index, and whether the
// unit is closed. A unit's audio is `frames.length * frameSamples` samples, exactly the
// `durationMs` the worker reports for it.
export type UnitStore = ReadonlyMap<number, UnitAudio>;

// ── the schedule: pure ─────────────────────────────────────────────────────────────────

// A position in samples: integers, so every comparison below is exact.
export interface Sample {
  readonly unit: number;
  readonly sample: number;
}

// The context time at which sample 0 of a unit plays under the current schedule.
export interface UnitStart {
  readonly unit: number;
  readonly time: number;
}

// Everything scheduled since the last anchor. `cursor` is the context time the next
// scheduled sample would play — the end of the audio the context holds. `need` is that
// sample: the next one to schedule, or `unit === unitCount`, one past the end, when the
// last unit has been scheduled to its last sample. `starts` always holds the anchored unit
// first, so a position lookup is total.
export interface Schedule {
  readonly anchor: number;
  readonly cursor: number;
  readonly starts: readonly [UnitStart, ...UnitStart[]];
  readonly need: Sample;
}

// One frame to hand the device: play `pcm` at `when`, skipping its first `skip` samples.
export interface Cue {
  readonly pcm: Float32Array<ArrayBuffer>;
  readonly when: number;
  readonly skip: number;
}

export const openSchedule = (from: Sample, anchor: number, format: PcmFormat): Schedule => ({
  anchor,
  cursor: anchor,
  need: from,
  starts: [{ unit: from.unit, time: anchor - from.sample / format.sampleRate }],
});

// [LAW:effects-at-boundaries] Schedule every frame the store can supply at the cursor, as
// data: the cues for the device and the schedule after them. The same three-way question
// is asked per step — the frame is here, or the unit is still open, or the unit is closed
// and the next begins at the cursor — so a seek past a unit's end resolves to the start of
// the following unit by the same rule that carries ordinary playback across a boundary
// [LAW:dataflow-not-control-flow].
export const extend = (
  schedule: Schedule,
  store: UnitStore,
  unitCount: number,
  format: PcmFormat,
): { readonly schedule: Schedule; readonly cues: ReadonlyArray<Cue> } => {
  const { sampleRate, frameSamples } = format;
  const cues: Cue[] = [];
  const starts: [UnitStart, ...UnitStart[]] = [...schedule.starts];
  let { cursor, need } = schedule;
  while (need.unit < unitCount) {
    const audio = store.get(need.unit);
    if (audio === undefined) break;
    const frame = Math.floor(need.sample / frameSamples);
    const pcm = audio.frames[frame];
    if (pcm !== undefined) {
      const skip = need.sample - frame * frameSamples;
      cues.push({ pcm, when: cursor, skip });
      cursor += (frameSamples - skip) / sampleRate;
      need = { unit: need.unit, sample: (frame + 1) * frameSamples };
      continue;
    }
    if (!audio.complete) break;
    need = { unit: need.unit + 1, sample: 0 };
    if (need.unit < unitCount) starts.push({ unit: need.unit, time: cursor });
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
  return { unit: start.unit, sample: Math.round((t - start.time) * format.sampleRate) };
};

// ── the player ─────────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] The same three kinds speechPlayer.ts exposes, so the panel
// drives either performer; `at` is a manifest Position, derived from the clock on every
// read while speaking. `flow` says whether the context holds audio or playback has caught
// up with delivery and is waiting for the sample at `at`.
export type Flow = "audio" | "waiting";

export type PlayerState =
  | { readonly kind: "idle" }
  | { readonly kind: "speaking"; readonly at: Position; readonly flow: Flow }
  | { readonly kind: "paused"; readonly at: Position };

// Everything that moves the player, as data, from its two speakers: the reader's controls
// and the scheduler's deliveries. One closed set, one `send`, one place effects happen
// [LAW:single-enforcer].
export type PlayerEvent =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "stop" }
  | { readonly kind: "seek"; readonly to: Position }
  | { readonly kind: "frame"; readonly unit: number; readonly frameIndex: number; readonly pcm: Float32Array<ArrayBuffer> }
  | { readonly kind: "complete"; readonly unit: number }
  | { readonly kind: "drop"; readonly unit: number };

export interface UnitPlayerConfig {
  readonly Device: DeviceFactory;
  readonly unitCount: number;
  // Called after every discontinuity: play, pause, stop, seek, starvation and its relief,
  // and the end of the last unit. Continuous motion is read with `state()`.
  readonly onState: (state: PlayerState) => void;
  readonly format?: PcmFormat;
}

export interface UnitPlayer {
  readonly send: (event: PlayerEvent) => void;
  readonly state: () => PlayerState;
}

type Speaking = { readonly kind: "speaking"; schedule: Schedule; readonly sources: Set<PcmSource> };
type Live = { readonly kind: "idle" } | { readonly kind: "paused"; readonly at: Sample } | Speaking;

interface MutableUnitAudio {
  readonly frames: Float32Array<ArrayBuffer>[];
  complete: boolean;
}

const IDLE: Live = { kind: "idle" };

export const createUnitPlayer = (config: UnitPlayerConfig): UnitPlayer => {
  const { unitCount, onState, format = MODEL_PCM } = config;
  const device = new config.Device({ sampleRate: format.sampleRate });
  // [LAW:no-shared-mutable-globals] Owned here; written only through `send`.
  const store = new Map<number, MutableUnitAudio>();
  let live: Live = IDLE;

  const toPosition = (at: Sample): Position => ({ unitIndex: at.unit, offsetMs: (at.sample / format.sampleRate) * 1000 });
  const flowOf = (speaking: Speaking): Flow => (speaking.sources.size > 0 ? "audio" : "waiting");

  const state = (): PlayerState => {
    switch (live.kind) {
      case "idle":
        return { kind: "idle" };
      case "paused":
        return { kind: "paused", at: toPosition(live.at) };
      case "speaking":
        return { kind: "speaking", at: toPosition(positionAt(live.schedule, device.currentTime, format)), flow: flowOf(live) };
    }
  };

  // ── effects ──

  const silence = (speaking: Speaking): void => {
    for (const source of speaking.sources) source.stop();
    // Cleared before their `ended` events arrive, which is what makes those events
    // recognisable as stale below.
    speaking.sources.clear();
  };

  // Finished and silent — the last unit scheduled to its end and every source ended — is
  // idle; the context is released until the next play.
  const settle = (speaking: Speaking): void => {
    if (speaking.sources.size === 0 && speaking.schedule.need.unit === unitCount) {
      live = IDLE;
      void device.suspend();
    }
  };

  const perform = (speaking: Speaking, cues: ReadonlyArray<Cue>): void => {
    for (const cue of cues) {
      const buffer = device.createBuffer(1, format.frameSamples, format.sampleRate);
      buffer.copyToChannel(cue.pcm, 0);
      const source = device.createBufferSource();
      source.buffer = buffer;
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
    const { schedule, cues } = extend(speaking.schedule, store, unitCount, format);
    speaking.schedule = schedule;
    perform(speaking, cues);
    settle(speaking);
  };

  // A fresh schedule from `from`, anchored just ahead of the clock.
  const begin = (from: Sample): void => {
    if (live.kind === "speaking") silence(live);
    const speaking: Speaking = {
      kind: "speaking",
      schedule: openSchedule(from, device.currentTime + SCHEDULE_LEAD_S, format),
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

  const unitOf = (event: Extract<PlayerEvent, { unit: number }>): MutableUnitAudio => {
    if (!Number.isInteger(event.unit) || event.unit < 0 || event.unit >= unitCount) {
      throw new RangeError(`unit player: ${event.kind} names unit ${event.unit} of ${unitCount}`);
    }
    const audio = store.get(event.unit) ?? { frames: [], complete: false };
    store.set(event.unit, audio);
    return audio;
  };

  const toSample = (to: Position): Sample => {
    if (!Number.isInteger(to.unitIndex) || to.unitIndex < 0 || to.unitIndex >= unitCount) {
      throw new RangeError(`unit player: cannot seek to unit ${to.unitIndex} of ${unitCount}`);
    }
    if (!Number.isFinite(to.offsetMs) || to.offsetMs < 0) {
      throw new RangeError(`unit player: cannot seek to ${to.offsetMs} ms`);
    }
    return { unit: to.unitIndex, sample: Math.round((to.offsetMs * format.sampleRate) / 1000) };
  };

  const apply = (event: PlayerEvent): void => {
    switch (event.kind) {
      case "play":
        // Already speaking is a true no-op; resuming keeps the held position, starting
        // from idle begins at the top.
        if (live.kind === "speaking") return;
        run(live.kind === "paused" ? live.at : { unit: 0, sample: 0 });
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
      case "seek": {
        // Seeking while paused moves the held position; the reader asked to move, not to
        // start. Otherwise it plays from there, from buffered samples when they exist and
        // otherwise waiting at that sample, which is the request the scheduler answers.
        const at = toSample(event.to);
        if (live.kind === "paused") live = { kind: "paused", at };
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
        arrived();
        return;
      }
      case "complete": {
        const audio = unitOf(event);
        if (audio.complete) throw new RangeError(`unit player: unit ${event.unit} completed twice`);
        audio.complete = true;
        arrived();
        return;
      }
      case "drop":
        unitOf(event);
        if (live.kind === "speaking" && live.schedule.need.unit === event.unit) {
          throw new RangeError(`unit player: unit ${event.unit} is being played and cannot be dropped`);
        }
        store.delete(event.unit);
        return;
    }
  };

  // [LAW:single-enforcer] Every change runs through here: the state is reported exactly
  // when the player moved to a different schedule, hold or idle, or its flow changed — the
  // discontinuities — and never for a redundant event or a delivery that merely extended
  // the schedule.
  const transition = (change: () => void): void => {
    const before = live;
    const flowBefore = live.kind === "speaking" ? flowOf(live) : null;
    change();
    const flowAfter = live.kind === "speaking" ? flowOf(live) : null;
    if (live !== before || flowAfter !== flowBefore) onState(state());
  };

  return { send: (event) => transition(() => apply(event)), state };
};
