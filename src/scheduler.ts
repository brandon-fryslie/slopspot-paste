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
// FAILURE IS A TYPED STATE, NOT A STALL. A unit whose synthesis ends in `failed`, or whose
// report the manifest rejects, becomes `failed{reason}` for the life of the scheduler: it is
// never retried (a frame-cap is the model looping on that text and would loop again), its
// void frames leave the player as soon as they are not the ones being cued, and when the
// cursor reaches it the player is seeked past it — or stopped at the end — so playback
// never waits on audio that will never come. The panel
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
// unit boundary the clock crosses), the reader's voices and nothing else: no timer, no polling. The driver owns
// the ordering — events are processed to completion one at a time, in arrival order, and a
// report the player raises while a command is being performed waits its turn — so the plan
// never runs on a state a command it just issued has already moved
// [LAW:no-ambient-temporal-coupling].
//
// Nothing here is persisted and no audio is ever stored: what the scheduler holds is a
// disposable projection of the stored original's rendition [LAW:one-way-deps].

import { emptyManifest, recordUnit } from "./speechManifest";
import type { Manifest, ManifestUnit, Position, RecordRejection } from "./speechManifest";
import { unitText, type SynthesisUnit, type VoiceMap } from "./speechScript";
import type { SynthesisPort } from "./synthesisClient";
import type { FromWorker, ToWorker, UnitFailure } from "./synthesisProtocol";
import type { PlayerEvent, PlayerState, UnitPlayer, UnitPlayerConfig } from "./unitPlayer";

// ── the window ─────────────────────────────────────────────────────────────────────────

export interface Lookahead {
  readonly units: number;
  readonly ms: number;
}

export const LOOKAHEAD: Lookahead = { units: 3, ms: 30_000 };
export const KEEP_BEHIND = 1;

// ── state ──────────────────────────────────────────────────────────────────────────────

// Where a failed unit's void frames are: still in the player's store, or dropped.
export type VoidFrames = "player" | "none";

// [LAW:types-are-the-program] Why a unit is failed: the worker's reasons less the one that
// is a scheduler bug and throws (`duplicate-unit`), the manifest's less the one the holding
// lookup already rules out (`unknown-unit`: holdings and script are the same length).
export type FailureReason = Exclude<UnitFailure, { kind: "duplicate-unit" }> | Exclude<RecordRejection, { kind: "unknown-unit" }>;

// [LAW:types-are-the-program] What the scheduler knows about one unit, and by the mirror
// above, what the player holds of it.
export type Holding =
  | { readonly kind: "absent" }
  | { readonly kind: "requested" }
  | { readonly kind: "cancelling" }
  | { readonly kind: "held"; readonly record: ManifestUnit }
  | { readonly kind: "failed"; readonly reason: FailureReason; readonly frames: VoidFrames };

export interface SchedulerState {
  // Which model voice each role is synthesized in: every request reads it here.
  readonly voices: VoiceMap;
  readonly holdings: ReadonlyArray<Holding>;
  readonly manifest: Manifest;
}

const ABSENT: Holding = { kind: "absent" };
const REQUESTED: Holding = { kind: "requested" };
const CANCELLING: Holding = { kind: "cancelling" };

export const initialState = (script: ReadonlyArray<SynthesisUnit>, voices: VoiceMap): SchedulerState => ({
  voices,
  holdings: script.map(() => ABSENT),
  manifest: emptyManifest(script),
});

// ── events and commands ────────────────────────────────────────────────────────────────

export type Event =
  | { readonly kind: "worker"; readonly message: FromWorker }
  | { readonly kind: "player"; readonly state: PlayerState }
  // The reader's voices changed: the map every request reads from now on.
  | { readonly kind: "voices"; readonly voices: VoiceMap };

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
// (synthesisProtocol.ts): their messages are another conversation, not a unit of ours.
const foreign = (message: FromWorker): boolean => "unitId" in message && message.unitId < 0;

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

const reach = (holdings: ReadonlyArray<Holding>, at: Position): Reach => {
  const count = holdings.length;
  const cursor = holdings[at.unitIndex];
  const lo = Math.max(0, at.unitIndex - KEEP_BEHIND);
  let hi = at.unitIndex;
  let unitsAhead = 0;
  let msAhead = cursor?.kind === "held" ? cursor.record.durationMs - at.offsetMs : 0;
  while (hi + 1 < count && unitsAhead < LOOKAHEAD.units && msAhead < LOOKAHEAD.ms) {
    hi++;
    const holding = holdings[hi];
    if (holding?.kind === "held") msAhead += holding.record.durationMs;
    if (holding?.kind !== "failed") unitsAhead++;
  }
  let frontier = at.unitIndex;
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

  // A failed unit under the cursor is skipped: the player moves to the next unit, or ends
  // at the script's end, and the follow-up report plans from there. Its frames, now no
  // longer the frontier's, are dropped in the same breath.
  if (player.kind !== "idle") {
    const cursor = holdingOf(state, player.at.unitIndex);
    if (cursor.kind === "failed") {
      const next = player.at.unitIndex + 1;
      commands.push(toPlayer(next < count ? { kind: "seek", to: { unitIndex: next, offsetMs: 0 } } : { kind: "stop" }));
      evict(player.at.unitIndex);
      return finish();
    }
  }

  // Outside the window everything goes; inside it a failed unit's void frames go too. The
  // frontier alone is untouchable: the player is cueing its frames as they arrive.
  const window = player.kind === "idle" ? EMPTY : reach(state.holdings, player.at);
  for (let unit = 0; unit < count; unit++) {
    if (unit === window.frontier) continue;
    if (unit < window.lo || unit > window.keepHi || current(unit).kind === "failed") evict(unit);
  }

  if (player.kind === "idle") return finish();

  // The most wanted unit: the first in the request window that is neither held nor
  // failed. Requested or cancelling, it is already on its way and the plan waits; absent,
  // it is requested now, displacing whatever else was in flight.
  let next = player.at.unitIndex;
  while (next <= window.hi && (current(next).kind === "held" || current(next).kind === "failed")) next++;
  if (next > window.hi || current(next).kind !== "absent") return finish();

  const inFlight = (holdings ?? state.holdings).findIndex((holding) => holding.kind === "requested");
  if (inFlight !== -1) evict(inFlight);
  const unit = state.manifest.script[next];
  if (unit === undefined) throw new RangeError(`scheduler: no script unit ${next}`);
  commands.push(toWorker({ kind: "synthesize", unitId: next, text: unitText(unit), voice: state.voices[unit.utterance.voice] }));
  set(next, REQUESTED);
  return finish();
};

// ── the reader's voices ────────────────────────────────────────────────────────────────

// How the unit under the cursor is restarted, by the player's own state: the player will
// not drop the unit it is cueing, so a speaking player is held before the drops and set
// going again after the seek; a paused one has its held place moved; an idle one has no
// cursor. `changed` says whether that unit's voice is among the changed.
const restart = (player: PlayerState, changed: (unit: number) => boolean): { before: Command[]; after: Command[] } => {
  const none = { before: [], after: [] };
  if (player.kind === "idle" || !changed(player.at.unitIndex)) return none;
  const seek = toPlayer({ kind: "seek", to: { unitIndex: player.at.unitIndex, offsetMs: 0 } });
  switch (player.kind) {
    case "paused":
      return { before: [], after: [seek] };
    case "speaking":
      return { before: [toPlayer({ kind: "pause" })], after: [seek, toPlayer({ kind: "play" })] };
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
  const { before, after } = restart(player, changed);
  return {
    state: { voices, holdings, manifest: { ...state.manifest, units } },
    commands: [...before, ...commands, ...after],
  };
};

// [LAW:single-enforcer] The one function that changes the scheduler's state: what the
// worker said, or the reader's new voices, is applied, then the plan is redrawn against
// where the player is now.
export const step = (state: SchedulerState, event: Event, player: PlayerState): Plan => {
  const applied =
    event.kind === "worker" ? apply(state, event.message) : event.kind === "voices" ? revoice(state, event.voices, player) : { state, commands: [] };
  const planned = plan(applied.state, player);
  return { state: planned.state, commands: [...applied.commands, ...planned.commands] };
};

// ── the driver ─────────────────────────────────────────────────────────────────────────

// The reader's controls, forwarded to the player unchanged: the scheduler is the panel's
// performer, answering the four verbs performer.ts names [LAW:one-type-per-behavior].
export type Control = Extract<PlayerEvent, { kind: "play" | "pause" | "stop" | "seek" }>;

export interface SchedulerView {
  readonly player: PlayerState;
  readonly manifest: Manifest;
  readonly holdings: ReadonlyArray<Holding>;
}

export interface SchedulerConfig {
  readonly port: SynthesisPort;
  readonly script: ReadonlyArray<SynthesisUnit>;
  readonly voices: VoiceMap;
  // Builds the player over the device the caller chooses; the scheduler supplies the unit
  // count and the report callback, so the two can never disagree about the script.
  readonly player: (config: Pick<UnitPlayerConfig, "unitCount" | "onState">) => UnitPlayer;
  // Called after every event that changed what is held or where the player is.
  readonly onChange: (view: SchedulerView) => void;
}

export interface Scheduler {
  readonly send: (control: Control) => void;
  // The reader's voices from now on: the units of a changed voice are made again in it.
  readonly voices: (voices: VoiceMap) => void;
  readonly view: () => SchedulerView;
  // Ends the listen: stops the player, withdraws the request in flight, stops listening to
  // the worker. Call it before the worker is disposed, so the worker's cancellations land
  // on a scheduler that expects them.
  readonly dispose: () => void;
}

export const createScheduler = (config: SchedulerConfig): Scheduler => {
  // [LAW:no-shared-mutable-globals] Owned here; written only by `dispatch`.
  let state = initialState(config.script, config.voices);
  const queue: Event[] = [];
  let draining = false;

  const player = config.player({ unitCount: config.script.length, onState: (reported) => dispatch({ kind: "player", state: reported }) });

  const view = (): SchedulerView => ({ player: player.state(), manifest: state.manifest, holdings: state.holdings });

  const perform = (command: Command): void =>
    command.kind === "worker" ? config.port.send(command.message) : player.send(command.event);

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
    } finally {
      draining = false;
    }
  };

  const unsubscribe = config.port.subscribe((message) => dispatch({ kind: "worker", message }));

  return {
    send: (control) => player.send(control),
    voices: (voices) => dispatch({ kind: "voices", voices }),
    view,
    dispose: () => {
      // Stopping empties the window, which is what cancels and drops everything.
      player.send({ kind: "stop" });
      unsubscribe();
      player.dispose();
    },
  };
};
