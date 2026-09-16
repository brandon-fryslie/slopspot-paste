// [LAW:decomposition] The scheduler: it keeps the units just ahead of the playback position
// synthesized and delivered to the unit player, within a bounded window, and forgets what
// falls behind. One sentence, no "and" hiding a second job: this module decides WHICH unit
// the worker synthesizes next and WHAT audio the player holds. It does not run the model
// (the worker), does not play (unitPlayer.ts), does not cut text (speechScript.ts) and
// paints nothing. Every decision is the pure function `step` over a typed state, a message
// from the worker or a report from the player, and the player's current position; it
// returns the commands for the two seams and the driver `createScheduler` performs them,
// so scripts/scheduler-check.ts covers every transition with a stub port and drives the
// real player over a stub device [LAW:effects-at-boundaries] [LAW:verifiable-goals].
//
// WHAT THE PLAYER HOLDS IS WHAT THIS STATE SAYS. The scheduler is the only thing that
// delivers to the player, so the player's store is a mirror of `holdings`: a `held` unit
// has all its frames and `complete`; a `requested` unit has the frames streamed so far; a
// `failed` unit says where its void frames are; `absent` and `cancelling` hold nothing,
// because the frames are dropped at the moment of the decision, never later
// [LAW:one-source-of-truth]. The mirror is what lets the scheduler honour the player's one
// rule it cannot see from outside — the unit whose frames the schedule is cueing as they
// arrive cannot be dropped — by construction: that unit is the FRONTIER, the first unit at
// or after the cursor that is not held, and the frontier is never evicted or cancelled.
//
// THE PLAYER PLAYS SEGMENTS; THE HOLDINGS ARE UNITS. The player is built over the
// timeline's layout (timeline.ts) — speech slots naming units and the silence slots between
// speakers — and reports its position as a segment of that layout and an offset into it.
// Holdings stay unit-indexed, so two readings translate: the unit whose audio the cursor
// needs first (`needed`), which in a gap is the unit of the speech the gap precedes, since
// that is what must be held by the time the gap ends; and the speech unit the cursor is
// inside (`spoken`), none in a gap. Nothing here treats a gap as any unit's: a gap is
// planned around, never restarted, never skipped, never dropped [LAW:one-source-of-truth].
//
// TWO FACTS, TWO RECORDS. Audio held in the player and the measurement of a unit's audio
// (its duration, its word times) are different facts with different lives: PCM is dropped
// behind the cursor so a three-hour paste never accumulates a gigabyte of floats, while the
// manifest keeps every record it has ever admitted so the global timeline stays defined
// over the listened prefix. A re-synthesis of a dropped unit replaces its record — the
// model samples, so the second rendition may not be the first's length — and one that fails
// voids it, so the record is always of the audio the player holds whenever it holds any,
// and never of audio a failed unit no longer has.
//
// ONE REQUEST IN FLIGHT, ALWAYS THE MOST WANTED. The worker generates one unit at a time on
// one device, so queueing several buys nothing and costs the order: a seek would leave the
// queue in the old cursor's order. Instead the scheduler holds at most one `requested` unit
// and chooses it against the current cursor when the previous one ends; when a seek makes a
// different unit the most wanted, the in-flight one is cancelled and the wanted one
// requested in the same plan. Cost, stated once: one message round trip between units, and
// a seek may discard a partly generated unit.
//
// THE WINDOW. Behind the cursor KEEP_BEHIND units of audio stay for a short rewind. Ahead,
// the next LOOKAHEAD.units units are wanted (a failed one takes no place: it yields no
// audio), or fewer once LOOKAHEAD.ms of audio is held — the ticket's "3 units or 30 s",
// whichever comes first; a unit is at most MAX_UNIT_TOKENS so the unit bound is the one
// that binds today. The window is a distance from the cursor, so held audio beyond it that
// the cursor cannot reach without passing absent units is an island, not lookahead. Held audio contiguous from the cursor is
// never evicted even past the window (a rewind inside audio already made must not throw it
// away to remake it); islands left behind by seeks are. Memory is therefore bounded by one
// window plus one contiguous run, whatever the reader does [LAW:no-ambient-temporal-coupling].
//
// THE WINDOW IS STATE. How far ahead is a value the page sets, not a constant: while the
// page is in the background the reader can reach the page only through the lock screen, and
// a phone may suspend the worker at any moment, so the window widens to BACKGROUND_LOOKAHEAD
// and the worker makes as much of the listen as it is allowed to before that happens; back
// in view it narrows to LOOKAHEAD, and what the wider window made stays while it is
// contiguous from the cursor, by the rule above. Cost, stated once: minutes of PCM held
// while hidden — at 24 kHz, about 29 MB for five minutes.
//
// FAILURE IS A TYPED STATE, NOT A STALL. A unit whose synthesis ends in `failed`, or whose
// report the manifest rejects, becomes `failed{reason}` for the life of the scheduler: it is
// never retried (a frame-cap is the model looping on that text and would loop again), its
// void frames leave the player as soon as they are not the ones being cued, and when the
// cursor reaches its slot the player is seeked to the segment after it — the gap before the
// next speaker when it ends a turn, else the next unit — or stopped at the end, so playback
// never waits on audio that will never come and a failed unit does not cost the gap. The panel
// reads the reason off `holdings` [LAW:no-silent-failure]. A message that the protocol says
// cannot happen — `audio` for a unit never requested, `failed{duplicate-unit}`, `refused` for
// a synthesize or cancel — is a scheduler bug and throws.
//
// THE VOICES ARE STATE. Which model voice speaks each role is a value the reader can change
// mid-listen (voiceChoice.ts), so the scheduler holds the map it synthesizes with and takes
// a new one as an event. A rendition is of one text in one voice: a change voids every
// unit the changed voice spoke or was asked to speak — audio dropped, request withdrawn,
// record and failure forgotten — and the plan asks for them again in the new voice, the
// unit under the cursor first, from its start [LAW:one-source-of-truth].
//
// WHAT WAKES IT. Worker messages, the player's `onState` (every discontinuity and every
// unit boundary the clock crosses), the reader's voices, the page's window and nothing else:
// no timer, no polling. The driver owns
// the ordering — events are processed to completion one at a time, in arrival order, and a
// report the player raises while a command is being performed waits its turn — so the plan
// never runs on a state a command it just issued has already moved
// [LAW:no-ambient-temporal-coupling].
//
// WHAT IS WORTH MAKING AHEAD. Beyond the window, every unit this listen has no audio or
// measurement of is worth making ahead into the device's kept audio, from the unit past the
// window to the end and then wrapping to the top — an idle player's order starts at the top.
// That order is a projection of the state and the position (`aheadOf`), not state: the driver
// tells the port each new order and the port decides whether and when to spend the worker's
// idle time on it (keptSynthesis.ts). A unit made ahead lands in the device's kept audio,
// never in the player: when the cursor needs it, its own request is answered from there — or
// takes over the generation already making it — like any other [LAW:one-source-of-truth].
//
// Nothing here is persisted: what the scheduler holds is a disposable projection of the stored
// original's rendition, and the audio the device keeps is behind the port it is handed
// (keptSynthesis.ts), answered as any worker answer is [LAW:one-way-deps].

import { beginWord, emptyManifest, recordUnit } from "./speechManifest";
import type { Manifest, ManifestUnit, RecordRejection, UnitReport, WordStart } from "./speechManifest";
import { unitText, type SynthesisUnit, type VoiceMap } from "./speechScript";
import type { ListenPort, SynthesizeRequest } from "./synthesisClient";
import type { FromWorker, ToWorker, UnitFailure } from "./synthesisProtocol";
import { layoutOf, type Slot } from "./timeline";
import type { PlayerEvent, PlayerState, SegmentOffset, UnitPlayer, UnitPlayerConfig } from "./unitPlayer";

// ── the window ─────────────────────────────────────────────────────────────────────────

export interface Lookahead {
  readonly units: number;
  readonly ms: number;
}

export const LOOKAHEAD: Lookahead = { units: 3, ms: 30_000 };
export const BACKGROUND_LOOKAHEAD: Lookahead = { units: 60, ms: 300_000 };
export const KEEP_BEHIND = 1;

// ── state ──────────────────────────────────────────────────────────────────────────────

// Where a failed unit's void frames are: still in the player's store, or dropped.
export type VoidFrames = "player" | "none";

// [LAW:types-are-the-program] Why a unit is failed: the worker's reasons less the one that
// is a scheduler bug and throws (`duplicate-unit`), the manifest's less the one the holding
// lookup already rules out (`unknown-unit`: holdings and script are the same length).
export type FailureReason = Exclude<UnitFailure, { kind: "duplicate-unit" }> | Exclude<RecordRejection, { kind: "unknown-unit" }>;

// [LAW:types-are-the-program] What the scheduler knows about one unit, and by the mirror
// above, what the player holds of it. A requested unit also holds the words the model has
// begun so far: the player may be sounding them before the unit is done, and they go with the
// request — replaced by the record when it is done, void when it is cancelled or fails.
export type Holding =
  | { readonly kind: "absent" }
  | { readonly kind: "requested"; readonly begun: ReadonlyArray<WordStart> }
  | { readonly kind: "cancelling" }
  | { readonly kind: "held"; readonly record: ManifestUnit }
  | { readonly kind: "failed"; readonly reason: FailureReason; readonly frames: VoidFrames };

export interface SchedulerState {
  // Which model voice each role is synthesized in: every request reads it here.
  readonly voices: VoiceMap;
  // How far ahead of the cursor audio is wanted: LOOKAHEAD in view, wider in the background.
  readonly lookahead: Lookahead;
  readonly holdings: ReadonlyArray<Holding>;
  readonly manifest: Manifest;
  // The sequence the player plays: the timeline's layout over this script, built once.
  readonly layout: ReadonlyArray<Slot>;
}

const ABSENT: Holding = { kind: "absent" };
const REQUESTED: Holding = { kind: "requested", begun: [] };
const CANCELLING: Holding = { kind: "cancelling" };

// `kept` is the device's report for each unit it already holds in these voices
// (keptAudio.ts): admitted as records at the start, so the clock is measured over every kept
// unit before a place is resolved on it — a resume lands on its word, not its unit's start —
// while nothing is held yet. A kept record is the one a request for its unit is answered
// with, so it is the audio's own measurement; should a kept unit be gone by the time it is
// asked for, the synthesis replaces its record like any re-synthesis after a drop. A kept
// report the manifest rejects is left unrecorded: the unit's own request then comes back
// with the same report, and the rejection is its `failed` holding, shown where every unit's
// failure is [LAW:no-silent-failure].
export const initialState = (
  script: ReadonlyArray<SynthesisUnit>,
  voices: VoiceMap,
  kept: ReadonlyArray<UnitReport | undefined>,
): SchedulerState => {
  const empty = emptyManifest(script);
  const units = script.map((_, index) => {
    const report = kept[index];
    const recorded = report === undefined ? null : recordUnit(script, index, report);
    return recorded?.kind === "record" ? recorded.record : undefined;
  });
  return {
    voices,
    lookahead: LOOKAHEAD,
    holdings: script.map(() => ABSENT),
    manifest: { ...empty, units },
    layout: layoutOf(script.map((unit) => unit.utterance.anchor)),
  };
};

// ── reading the player's position ──────────────────────────────────────────────────────

// A unit and how far into its audio: the shape the window is measured in.
interface UnitOffset {
  readonly unit: number;
  readonly offsetMs: number;
}

const slotAt = (layout: ReadonlyArray<Slot>, at: SegmentOffset): Slot => {
  const slot = layout[at.segment];
  if (slot === undefined) throw new RangeError(`scheduler: the player is at segment ${at.segment} of ${layout.length}`);
  return slot;
};

// The unit whose audio the cursor needs first: the unit of a speech segment at the
// offset; in silence, the unit of the speech the gap precedes, at its start — a gap is laid
// only before speech (timeline.ts), so the slot after it is the unit wanted by its end.
const needed = (layout: ReadonlyArray<Slot>, at: SegmentOffset): UnitOffset => {
  const slot = slotAt(layout, at);
  if (slot.kind === "speech") return { unit: slot.span, offsetMs: at.offsetMs };
  const next = slotAt(layout, { segment: at.segment + 1, offsetMs: 0 });
  if (next.kind !== "speech") throw new RangeError(`scheduler: segment ${at.segment} is a silence followed by silence`);
  return { unit: next.span, offsetMs: 0 };
};

// The unit the cursor is inside, or null in a gap: what a failure skips and a voice change
// restarts is a unit being spoken, never the silence between two.
const spoken = (layout: ReadonlyArray<Slot>, at: SegmentOffset): number | null => {
  const slot = slotAt(layout, at);
  return slot.kind === "speech" ? slot.span : null;
};

// ── events and commands ────────────────────────────────────────────────────────────────

export type Event =
  | { readonly kind: "worker"; readonly message: FromWorker }
  | { readonly kind: "player"; readonly state: PlayerState }
  // The reader's voices changed: the map every request reads from now on.
  | { readonly kind: "voices"; readonly voices: VoiceMap }
  // The page went into or out of the background: the window every plan reads from now on.
  | { readonly kind: "lookahead"; readonly to: Lookahead };

export type Command =
  | { readonly kind: "worker"; readonly message: ToWorker }
  | { readonly kind: "player"; readonly event: PlayerEvent };

export interface Plan {
  readonly state: SchedulerState;
  readonly commands: ReadonlyArray<Command>;
}

const toWorker = (message: ToWorker): Command => ({ kind: "worker", message });
const toPlayer = (event: PlayerEvent): Command => ({ kind: "player", event });

// ── the worker's messages ──────────────────────────────────────────────────────────────

const holdingOf = (state: SchedulerState, unit: number): Holding => {
  const holding = state.holdings[unit];
  if (holding === undefined) throw new RangeError(`scheduler: the worker named unit ${unit} of ${state.holdings.length}`);
  return holding;
};

const withHolding = (state: SchedulerState, unit: number, holding: Holding): SchedulerState => ({
  ...state,
  holdings: state.holdings.with(unit, holding),
});

// [LAW:one-source-of-truth] A failed unit has no audio, so it has no record: an earlier
// rendition's measurement is voided with the holding, never left for the timeline to count.
const failed = (state: SchedulerState, unit: number, reason: FailureReason, frames: VoidFrames): SchedulerState => ({
  ...state,
  holdings: state.holdings.with(unit, { kind: "failed", reason, frames }),
  manifest: { ...state.manifest, units: state.manifest.units.with(unit, undefined) },
});

const unexpected = (message: FromWorker, holding: Holding): Error =>
  new Error(`scheduler: ${message.kind} for a unit that is ${holding.kind}`);

// The page's other requests on the same port — a voice preview — take ids below zero
// (synthesisProtocol.ts): their messages are another conversation, not a unit of ours. A
// refusal carries the id on the request it answers.
const foreign = (message: FromWorker): boolean =>
  "unitId" in message ? message.unitId < 0 : message.kind === "refused" && "unitId" in message.request && message.request.unitId < 0;

// [LAW:dataflow-not-control-flow] One row per (message, holding) the protocol allows; every
// other pair is a violation and throws. `cancelling` accepts any terminal as "over" — the
// cancel raced a `done` or a `failed` already on the wire — and the unit is absent again.
const apply = (state: SchedulerState, message: FromWorker): Plan => {
  if (foreign(message)) return { state, commands: [] };
  switch (message.kind) {
    case "audio": {
      const holding = holdingOf(state, message.unitId);
      switch (holding.kind) {
        case "requested":
          return { state, commands: [toPlayer({ kind: "frame", unit: message.unitId, frameIndex: message.frameIndex, pcm: message.pcm })] };
        case "cancelling":
          return { state, commands: [] };
        default:
          throw unexpected(message, holding);
      }
    }
    case "word": {
      const holding = holdingOf(state, message.unitId);
      switch (holding.kind) {
        case "requested": {
          const begun = beginWord(state.manifest.script, message.unitId, holding.begun, message.word, message.startMs);
          return { state: withHolding(state, message.unitId, { kind: "requested", begun }), commands: [] };
        }
        case "cancelling":
          return { state, commands: [] };
        default:
          throw unexpected(message, holding);
      }
    }
    case "done": {
      const holding = holdingOf(state, message.unitId);
      switch (holding.kind) {
        case "requested": {
          const recorded = recordUnit(state.manifest.script, message.unitId, message.report);
          if (recorded.kind === "unknown-unit") throw new RangeError(`scheduler: holdings name unit ${message.unitId} the script lacks`);
          if (recorded.kind !== "record") return { state: failed(state, message.unitId, recorded, "player"), commands: [] };
          return {
            state: {
              ...state,
              holdings: state.holdings.with(message.unitId, { kind: "held", record: recorded.record }),
              manifest: { ...state.manifest, units: state.manifest.units.with(message.unitId, recorded.record) },
            },
            commands: [toPlayer({ kind: "complete", unit: message.unitId })],
          };
        }
        case "cancelling":
          return { state: withHolding(state, message.unitId, ABSENT), commands: [] };
        default:
          throw unexpected(message, holding);
      }
    }
    case "cancelled": {
      const holding = holdingOf(state, message.unitId);
      if (holding.kind !== "cancelling") throw unexpected(message, holding);
      return { state: withHolding(state, message.unitId, ABSENT), commands: [] };
    }
    case "failed": {
      if (message.reason.kind === "duplicate-unit") {
        throw new Error(`scheduler: unit ${message.unitId} was requested while in flight`);
      }
      const holding = holdingOf(state, message.unitId);
      switch (holding.kind) {
        case "requested":
          return { state: failed(state, message.unitId, message.reason, "player"), commands: [] };
        case "cancelling":
          return { state: withHolding(state, message.unitId, ABSENT), commands: [] };
        default:
          throw unexpected(message, holding);
      }
    }
    case "refused": {
      if (message.request.kind === "synthesize" || message.request.kind === "cancel") {
        throw new Error(`scheduler: ${message.request.kind} refused in phase ${message.phase}`);
      }
      return { state, commands: [] };
    }
    default:
      // capability, progress, ready, load-failed, script: the panel's conversation.
      return { state, commands: [] };
  }
};

// ── the plan ───────────────────────────────────────────────────────────────────────────

// What the cursor makes wanted and kept. `hi` bounds requests; `keepHi` bounds eviction
// ahead — the window or the held run contiguous from the cursor, whichever reaches
// further; `frontier` is the first unit at or after the cursor that is not held, or the
// unit count when every unit to the end is.
interface Reach {
  readonly lo: number;
  readonly hi: number;
  readonly keepHi: number;
  readonly frontier: number;
}

const EMPTY: Reach = { lo: 0, hi: -1, keepHi: -1, frontier: -1 };

const reach = (holdings: ReadonlyArray<Holding>, at: UnitOffset, lookahead: Lookahead): Reach => {
  const count = holdings.length;
  const cursor = holdings[at.unit];
  const lo = Math.max(0, at.unit - KEEP_BEHIND);
  let hi = at.unit;
  let unitsAhead = 0;
  let msAhead = cursor?.kind === "held" ? cursor.record.durationMs - at.offsetMs : 0;
  while (hi + 1 < count && unitsAhead < lookahead.units && msAhead < lookahead.ms) {
    hi++;
    const holding = holdings[hi];
    if (holding?.kind === "held") msAhead += holding.record.durationMs;
    if (holding?.kind !== "failed") unitsAhead++;
  }
  let frontier = at.unit;
  while (frontier < count && holdings[frontier]?.kind === "held") frontier++;
  return { lo, hi, keepHi: Math.max(hi, frontier), frontier };
};

// [LAW:effects-at-boundaries] The whole decision, as data: given what is held and where
// the cursor is, what to cancel, drop and request. Idempotent — a second plan over its own
// result issues nothing — and it returns the very same state object when nothing changed,
// which is how the driver knows whether to notify.
const plan = (state: SchedulerState, player: PlayerState): Plan => {
  const commands: Command[] = [];
  let holdings: Holding[] | null = null;
  const set = (unit: number, holding: Holding): void => {
    (holdings ??= [...state.holdings])[unit] = holding;
  };
  const current = (unit: number): Holding => (holdings ?? state.holdings)[unit] ?? ABSENT;
  const finish = (): Plan => ({ state: holdings === null ? state : { ...state, holdings }, commands });

  // Forget a unit: its audio leaves the player and any request for it is withdrawn.
  const evict = (unit: number): void => {
    const holding = current(unit);
    switch (holding.kind) {
      case "held":
        commands.push(toPlayer({ kind: "drop", unit }));
        set(unit, ABSENT);
        return;
      case "requested":
        commands.push(toWorker({ kind: "cancel", unitId: unit }), toPlayer({ kind: "drop", unit }));
        set(unit, CANCELLING);
        return;
      case "failed":
        if (holding.frames === "player") {
          commands.push(toPlayer({ kind: "drop", unit }));
          set(unit, { ...holding, frames: "none" });
        }
        return;
      case "absent":
      case "cancelling":
        return;
    }
  };

  const count = state.holdings.length;

  // A failed unit under the cursor is skipped: the player moves to the segment after it —
  // the gap it leads into, or the next unit — or ends at the script's end, and the
  // follow-up report plans from there. Its frames, now no longer the frontier's, are
  // dropped in the same breath. A cursor in the gap before a failed unit is not yet on it:
  // the gap sounds, and the skip is planned when the clock reaches the unit's own slot.
  if (player.kind !== "idle") {
    const unit = spoken(state.layout, player.at);
    if (unit !== null && holdingOf(state, unit).kind === "failed") {
      const next = player.at.segment + 1;
      commands.push(toPlayer(next < state.layout.length ? { kind: "seek", to: { segment: next, offsetMs: 0 } } : { kind: "stop" }));
      evict(unit);
      return finish();
    }
  }

  // Outside the window everything goes; inside it a failed unit's void frames go too. The
  // frontier alone is untouchable: the player is cueing its frames as they arrive.
  const at = player.kind === "idle" ? null : needed(state.layout, player.at);
  const window = at === null ? EMPTY : reach(state.holdings, at, state.lookahead);
  for (let unit = 0; unit < count; unit++) {
    if (unit === window.frontier) continue;
    if (unit < window.lo || unit > window.keepHi || current(unit).kind === "failed") evict(unit);
  }

  if (at === null) return finish();

  // The most wanted unit: the first in the request window that is neither held nor
  // failed. Requested or cancelling, it is already on its way and the plan waits; absent,
  // it is requested now, displacing whatever else was in flight.
  let next = at.unit;
  while (next <= window.hi && (current(next).kind === "held" || current(next).kind === "failed")) next++;
  if (next > window.hi || current(next).kind !== "absent") return finish();

  const inFlight = (holdings ?? state.holdings).findIndex((holding) => holding.kind === "requested");
  if (inFlight !== -1) evict(inFlight);
  commands.push(toWorker(requestFor(state, next)));
  set(next, REQUESTED);
  return finish();
};

// [LAW:single-enforcer] The one request for a unit, whether the cursor needs it, it is made
// ahead or a render wants it: the port matches them field for field to hand a generation from
// one to another, and to hear a unit once for a render whichever of them made it.
export const unitRequest = (script: ReadonlyArray<SynthesisUnit>, voices: VoiceMap, unitId: number): SynthesizeRequest => {
  const unit = script[unitId];
  if (unit === undefined) throw new RangeError(`scheduler: no script unit ${unitId}`);
  return { kind: "synthesize", unitId, text: unitText(unit), voice: voices[unit.utterance.voice] };
};
const requestFor = (state: SchedulerState, unitId: number): SynthesizeRequest => unitRequest(state.manifest.script, state.voices, unitId);

// The units worth making ahead, in order (see the header): those with neither a holding nor a
// measurement, from the unit past the window around to the one before it.
export const aheadOf = (state: SchedulerState, player: PlayerState): ReadonlyArray<number> => {
  const count = state.holdings.length;
  const from = player.kind === "idle" ? 0 : reach(state.holdings, needed(state.layout, player.at), state.lookahead).hi + 1;
  const order: number[] = [];
  for (let i = 0; i < count; i++) {
    const unit = (from + i) % count;
    if (state.holdings[unit]?.kind === "absent" && state.manifest.units[unit] === undefined) order.push(unit);
  }
  return order;
};

// ── the reader's voices ────────────────────────────────────────────────────────────────

// How the player is carried through the drops, by its own state. A speaking player has
// cued ahead as far as its audio runs — through a gap, into the speech after it — so any
// unit it is dropping at or after the one the cursor needs may be the unit it is cueing,
// which it refuses to drop, or audio already handed to the device in the old voice. So a
// speaking player is held before the drops and set going after them: from the start of
// the unit under the cursor when that unit's voice changed, else from the very sample it
// was held at — in a gap, the gap sounds on and the unit after it waits for its new
// rendition. A paused player has cued nothing, so only its held place moves, to the start
// of a changed unit under it; an idle one has no cursor. `changed` says whether a unit's
// voice is among the changed; `dropped` lists the units whose audio leaves the player.
const restart = (
  layout: ReadonlyArray<Slot>,
  player: PlayerState,
  changed: (unit: number) => boolean,
  dropped: ReadonlyArray<number>,
): { before: Command[]; after: Command[] } => {
  const none = { before: [], after: [] };
  if (player.kind === "idle") return none;
  const unit = spoken(layout, player.at);
  const seek = unit !== null && changed(unit) ? [toPlayer({ kind: "seek", to: { segment: player.at.segment, offsetMs: 0 } })] : [];
  switch (player.kind) {
    case "paused":
      return { before: [], after: seek };
    case "speaking": {
      const from = needed(layout, player.at).unit;
      if (seek.length === 0 && !dropped.some((gone) => gone >= from)) return none;
      return { before: [toPlayer({ kind: "pause" })], after: [...seek, toPlayer({ kind: "play" })] };
    }
  }
};

// [LAW:one-source-of-truth] A rendition is of one text in one voice, so every unit whose
// voice changed is forgotten as if never made: its audio leaves the player, its request is
// withdrawn, its record is voided and its failure with it — a failure was that voice's,
// and the new voice gets its own try. Units of unchanged voices are untouched. The plan
// that follows asks for the forgotten units again, the one under the cursor first.
const revoice = (state: SchedulerState, voices: VoiceMap, player: PlayerState): Plan => {
  const changed = (unit: number): boolean => {
    const said = state.manifest.script[unit];
    if (said === undefined) throw new RangeError(`scheduler: no script unit ${unit}`);
    return state.voices[said.utterance.voice] !== voices[said.utterance.voice];
  };
  // The very same state object when no unit's voice changed: nothing changed, and it says so.
  if (!state.holdings.some((_, unit) => changed(unit))) return { state, commands: [] };
  const commands: Command[] = [];
  const holdings = state.holdings.map((holding, unit): Holding => {
    if (!changed(unit)) return holding;
    switch (holding.kind) {
      case "held":
        commands.push(toPlayer({ kind: "drop", unit }));
        return ABSENT;
      case "requested":
        commands.push(toWorker({ kind: "cancel", unitId: unit }), toPlayer({ kind: "drop", unit }));
        return CANCELLING;
      case "failed":
        if (holding.frames === "player") commands.push(toPlayer({ kind: "drop", unit }));
        return ABSENT;
      case "absent":
      case "cancelling":
        return holding;
    }
  });
  const units = state.manifest.units.map((record, unit) => (changed(unit) ? undefined : record));
  const dropped = commands.flatMap((command) => (command.kind === "player" && command.event.kind === "drop" ? [command.event.unit] : []));
  const { before, after } = restart(state.layout, player, changed, dropped);
  return {
    state: { ...state, voices, holdings, manifest: { ...state.manifest, units } },
    commands: [...before, ...commands, ...after],
  };
};

// [LAW:single-enforcer] The one function that changes the scheduler's state: what the
// worker said, or the reader's new voices, is applied, then the plan is redrawn against
// where the player is now.
// The very same state object when the window is the window already: nothing changed.
const widen = (state: SchedulerState, to: Lookahead): Plan => ({
  state: state.lookahead.units === to.units && state.lookahead.ms === to.ms ? state : { ...state, lookahead: to },
  commands: [],
});

// [LAW:dataflow-not-control-flow] One application per event kind; the plan after it is the same for all.
const applyEvent = (state: SchedulerState, event: Event, player: PlayerState): Plan => {
  switch (event.kind) {
    case "worker":
      return apply(state, event.message);
    case "voices":
      return revoice(state, event.voices, player);
    case "lookahead":
      return widen(state, event.to);
    case "player":
      return { state, commands: [] };
  }
};

export const step = (state: SchedulerState, event: Event, player: PlayerState): Plan => {
  const applied = applyEvent(state, event, player);
  const planned = plan(applied.state, player);
  return { state: planned.state, commands: [...applied.commands, ...planned.commands] };
};

// ── the driver ─────────────────────────────────────────────────────────────────────────

// The reader's controls, forwarded to the player unchanged: the scheduler is the panel's
// performer, answering the five verbs performer.ts names [LAW:one-type-per-behavior].
// Speed is forwarded and not planned around: the window below is a length of AUDIO, so at
// 2.5x the reader crosses it in two fifths of the wall-clock time and may reach the frontier
// sooner. That shows as the honest "Synthesizing ahead…" the player already reports, and
// making the window itself speed-aware belongs with pre-synthesis (a35.6), not here.
export type Control = Extract<PlayerEvent, { kind: "play" | "pause" | "stop" | "seek" | "rate" }>;

export interface SchedulerView {
  readonly player: PlayerState;
  readonly manifest: Manifest;
  readonly holdings: ReadonlyArray<Holding>;
  // Whether the unit the cursor needs next is settled — nothing more will come of waiting for
  // it: what a listen paused for want of audio waits on before it goes on.
  readonly settled: boolean;
}

// The unit the cursor needs — under it, or after the gap it is in — is held in full, or has
// failed. A failed unit never will be held, and playing on is what reaches it: the gap
// sounds, and the cursor entering the unit's slot is the skip past it (plan). Waiting on it
// instead would hold a paused listen there for good. Nothing is settled for an idle player,
// which has no cursor.
export const settledAt = (state: SchedulerState, player: PlayerState): boolean => {
  if (player.kind === "idle") return false;
  const holding = state.holdings[needed(state.layout, player.at).unit];
  return holding?.kind === "held" || holding?.kind === "failed";
};

export interface SchedulerConfig {
  readonly port: ListenPort;
  readonly script: ReadonlyArray<SynthesisUnit>;
  readonly voices: VoiceMap;
  // The device's kept report for each unit in these voices, or undefined (initialState).
  readonly kept: ReadonlyArray<UnitReport | undefined>;
  // Builds the player over the device the caller chooses; the scheduler supplies the
  // layout and the report callback, so the two can never disagree about the script.
  readonly player: (config: Pick<UnitPlayerConfig, "layout" | "onState">) => UnitPlayer;
  // Called after every event that changed what is held or where the player is.
  readonly onChange: (view: SchedulerView) => void;
}

export interface Scheduler {
  readonly send: (control: Control) => void;
  // The reader's voices from now on: the units of a changed voice are made again in it.
  readonly voices: (voices: VoiceMap) => void;
  // The window from now on: how far ahead the worker is asked to make audio.
  readonly lookahead: (to: Lookahead) => void;
  readonly view: () => SchedulerView;
  // Ends the listen: stops the player, withdraws the request in flight, stops listening to
  // the worker. Call it before the worker is disposed, so the worker's cancellations land
  // on a scheduler that expects them.
  readonly dispose: () => void;
}

export const createScheduler = (config: SchedulerConfig): Scheduler => {
  // [LAW:no-shared-mutable-globals] Owned here; written only by `dispatch`.
  let state = initialState(config.script, config.voices, config.kept);
  const queue: Event[] = [];
  let draining = false;

  const player = config.player({ layout: state.layout, onState: (reported) => dispatch({ kind: "player", state: reported }) });

  const view = (): SchedulerView => {
    const now = player.state();
    return { player: now, manifest: state.manifest, holdings: state.holdings, settled: settledAt(state, now) };
  };

  const perform = (command: Command): void =>
    command.kind === "worker" ? config.port.send(command.message) : player.send(command.event);

  // The order last told to the port, and the voices it was told in: a new order is told once,
  // and none once the listen is ending.
  let told: { readonly order: ReadonlyArray<number>; readonly voices: VoiceMap } | null = null;
  let ending = false;
  const tell = (): void => {
    if (ending) return;
    const order = aheadOf(state, player.state());
    if (told !== null && told.voices === state.voices && told.order.length === order.length && told.order.every((unit, i) => unit === order[i])) return;
    told = { order, voices: state.voices };
    config.port.ahead(order.map((unit) => requestFor(state, unit)));
  };

  // Run to completion, in arrival order. A report the player raises while a command is
  // performed is queued behind the current event, never handled inside it.
  const dispatch = (event: Event): void => {
    queue.push(event);
    if (draining) return;
    draining = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const before = state;
        const planned = step(state, next, player.state());
        state = planned.state;
        for (const command of planned.commands) perform(command);
        if (state !== before || next.kind === "player") config.onChange(view());
      }
      tell();
    } finally {
      draining = false;
    }
  };

  const unsubscribe = config.port.subscribe((message) => dispatch({ kind: "worker", message }));
  tell();

  return {
    send: (control) => player.send(control),
    voices: (voices) => dispatch({ kind: "voices", voices }),
    lookahead: (to) => dispatch({ kind: "lookahead", to }),
    view,
    dispose: () => {
      // Stopping empties the window, which is what cancels and drops everything; a listen that
      // is over wants nothing made ahead.
      ending = true;
      player.send({ kind: "stop" });
      unsubscribe();
      config.port.ahead([]);
      player.dispose();
    },
  };
};
