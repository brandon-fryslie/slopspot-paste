// [LAW:decomposition] The Listen panel: it takes the reader from a Play tap to audio and
// shows, at every moment, who is speaking and why. One sentence, no "and": this module
// drives one transport over two performers. It does not probe or download (the worker),
// cut text (the worker's script reply), decide what to synthesize (scheduler.ts), speak
// (speechPlayer.ts, neuralPerformer.ts) or paint the page (readAlong.ts, through the
// callback below). Every decision is the pure `step` over a typed state and an event; it
// returns effects, the driver `createListenPanel` performs them against a port, a device,
// a stand-in and a frame loop it is HANDED, so scripts/listen-panel-check.ts drives every
// state under jsdom with a stub of each [LAW:effects-at-boundaries] [LAW:verifiable-goals].
//
// ONE PLAYER, TWO PERFORMERS [LAW:one-type-per-behavior]. The reader sees one Play and one
// Stop, whatever engine is behind them. The neural voice is the point of the tool and is a
// probe and, on a first listen, a 239 MB download away; the browser's own synthesizer is
// there at once. So the tap that starts everything does both: the stand-in speaks from the
// top while the neural voice is provisioned, and when the neural voice is ready it takes
// the stage WITHOUT losing the place: one `handover` effect reads the leaving performer's
// LIVE state as the stage passes and sends the arriving one `carry` of it — the same
// place, the word under the voice — then the stand-in is silenced. The same effect, the other
// way round, hands the stage back when the neural voice crashes mid-listen. On a browser
// with no synthesizer there is no stand-in, and the transport waits for the neural voice
// as it did before there was one.
//
// EVERY STATE THE READER CAN BE IN, SHOWN HONESTLY. The state is two facts that can both be
// true at once — where the neural voice is on its way (`NeuralPhase`) and what the stand-in
// is doing (`StandIn`) — until the neural voice is on stage, when the stand-in is silent by
// construction and the view is the scheduler's. `readout` maps every combination to the
// words on the status line and the shape of the two buttons, so a state with no honest
// sentence for it cannot be added without the compiler asking for one
// [LAW:types-are-the-program] [LAW:no-silent-failure]. When the browser voice is standing
// in, the status SAYS so, and says why: the download and its progress, an unsupported
// device and its reason, a failed load and its failure.
//
// THE TAP THAT STARTS EVERYTHING. Nothing is spawned, probed or fetched until the reader
// taps Play — or taps a word on the page, which is Play with a place: a `seek` to a Mark.
// The worker bundle, the probe and the download all follow that one tap, and the tap IS
// the consent modelAssets.downloadNeedsTap asks for on a metered connection. A Play tap or
// a seek that starts or resumes the stand-in also starts the neural voice when it is idle,
// or retries it after a failed load or a crash; a Pause tap touches nothing but the
// stand-in. With no stand-in there is nobody to seek until the neural voice is on stage, so
// the place is held in the state (`StandIn.none.from`) and is where the neural voice is
// sent when it arrives — the same seek, whether the reader tapped Play (the top) or a word.
// Costs, stated once: an unsupported device learns it only after the worker bundle has
// loaded; a download in flight cannot be cancelled (the protocol has no message for it).
//
// THE WORKER'S OWN DEATH. A bundle that fails to load, an exception outside the protocol:
// these arrive on the port's error channel, not as a message, and the panel answers with
// `crashed` — the neural performer and the worker are discarded, the status names the
// failure, and the stand-in carries on (or takes the place back, if the neural voice was
// on stage). A panel that hangs in "Checking this device…" forever is the silent failure
// the state union exists to make unrepresentable [LAW:no-silent-failure].
//
// WHAT THE PANEL MIRRORS. The `neural` arm carries the scheduler's view — player position,
// manifest, holdings — as delivered by its onChange; the `provisioning` arm carries the
// stand-in's state as delivered by its onState; the panel never computes a second opinion
// of either [LAW:one-source-of-truth]. The read-along cursor is derived from the stage
// performer's live `state()` on every animation frame while speaking: within an utterance
// the position moves with no event.
//
// [LAW:no-ambient-temporal-coupling] Events run to completion in arrival order, as in the
// scheduler: an effect's synchronous consequence (the stand-in's report on being silenced,
// the neural performer's first view) is queued behind the event being handled, never
// handled inside it. The frame loop is armed and disarmed from the state after each event,
// so it runs exactly while the stage performer is speaking. The stage itself is a fact of
// the state, never of the queue's order: the step that receives the neural performer's
// first view is the one that enters `neural` and performs the handover, so no event in
// between reads a silenced stand-in as the stage.

import { MODEL_ASSETS, allModelAssets } from "./modelAssets";
import type { AssetProgress } from "./modelAssetLoader";
import { createNeuralPerformer, spotOf, type NeuralPerformer, type NeuralView } from "./neuralPerformer";
import {
  carry,
  markOf,
  NORMAL,
  stepSpeed,
  TOP,
  type Mark,
  type Performer,
  type PerformerEvent,
  type PerformerState,
  type Speed,
  type Spot,
} from "./performer";
import { turnOf, type ReadAlongAt } from "./readAlong";
import type { FailureReason } from "./scheduler";
import type { Utterance } from "./speech";
import type { WordSpan } from "./speechManifest";
import type { SynthesisUnit, VoiceMap } from "./speechScript";
import type { SynthesisPort } from "./synthesisClient";
import type { FromWorker, LoadFailure, UnsupportedReason } from "./synthesisProtocol";
import {
  clockText,
  estimated,
  markAt,
  timeAt,
  timelineOfScript,
  timelineOfUtterances,
  turnMark,
  turnStarts,
  type Timeline,
} from "./timeline";
import type { DeviceFactory } from "./unitPlayer";

// ── state ──────────────────────────────────────────────────────────────────────────────

// Where the neural voice is on its way. The worker's own phases are a line (probing →
// unsupported | idle → loading → ready); these follow it one for one and add what the
// worker cannot see: `downloading` versus `warming` (the same `progress` message, before
// and after the last byte), `scripting` (utterances sent, units not yet back), and the
// two ways it ends without a voice that a Play tap retries.
export type NeuralPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "probing" }
  | { readonly kind: "preparing" }
  | { readonly kind: "downloading"; readonly progress: AssetProgress }
  | { readonly kind: "warming" }
  | { readonly kind: "scripting" }
  | { readonly kind: "unsupported"; readonly reason: UnsupportedReason }
  | { readonly kind: "load-failed"; readonly failure: LoadFailure }
  | { readonly kind: "crashed"; readonly message: string };

// The browser voice, or its absence on a browser with no synthesizer — in which case the
// place the neural voice is to start from, once it is on stage, is held here: the top
// until the reader taps a word.
export type StandIn = { readonly kind: "none"; readonly from: Mark } | { readonly kind: "synth"; readonly state: PerformerState };

// [LAW:one-source-of-truth] `speed` is on both arms because it belongs to neither: it is
// the reader's, and it outlives every stage — set while the model downloads, obeyed by the
// stand-in, handed to the neural voice when it arrives, kept when the neural voice crashes
// and the stand-in takes the stage back. A performer that held its own copy would lose it
// at each of those moments.
export type PanelState =
  | { readonly kind: "provisioning"; readonly neural: NeuralPhase; readonly standIn: StandIn; readonly speed: Speed }
  // The neural voice on stage. The stand-in is silent by construction; only whether one
  // exists to hand the stage back to is carried.
  | { readonly kind: "neural"; readonly view: NeuralView; readonly standIn: StandIn["kind"]; readonly speed: Speed };

export type Tap = "play" | "stop";

// [LAW:dataflow-not-control-flow] Everything the reader can ask the transport for, as one
// closed set of values rather than a method each: the two buttons, a tap on a word, the
// scrubber, the ten-second nudges, the turn skips, the speed steps. A key press is one of
// these (shortcuts.ts) and so is a click, so nothing downstream can tell which door a
// gesture came through. The three that name a place in TIME are resolved to a Mark by the
// driver, where the timeline is: a scrubber never names a unit index.
export type Gesture =
  | { readonly kind: "tap"; readonly control: Tap }
  | { readonly kind: "mark"; readonly to: Mark }
  | { readonly kind: "scrub"; readonly toMs: number }
  | { readonly kind: "nudge"; readonly bySeconds: number }
  | { readonly kind: "turn"; readonly by: -1 | 1 }
  | { readonly kind: "speed"; readonly by: -1 | 1 };

// Whether a gesture asks to be somewhere else — the one question whoever keeps the page in
// view needs answered, and exhaustive, so a gesture added later cannot quietly default to
// "the reader did not move".
const moves = (gesture: Gesture): boolean => {
  switch (gesture.kind) {
    case "tap":
    case "speed":
      return false;
    case "mark":
    case "scrub":
    case "nudge":
    case "turn":
      return true;
  }
};

export type PanelEvent =
  | { readonly kind: "tap"; readonly control: Tap }
  // The reader named a place — a tap on a word, the scrubber, a nudge, a turn skip — and
  // the driver resolved it to the one coordinate both performers stand in.
  | { readonly kind: "seek"; readonly to: Mark }
  // One step along the speed list, in whichever direction.
  | { readonly kind: "speed"; readonly by: -1 | 1 }
  | { readonly kind: "worker"; readonly message: FromWorker }
  | { readonly kind: "worker-error"; readonly message: string }
  | { readonly kind: "view"; readonly view: NeuralView }
  | { readonly kind: "synth"; readonly state: PerformerState }
  // The page is done with the panel: everything it built is released, the stand-in silenced.
  | { readonly kind: "dispose" };

export type Stage = "synth" | "neural";

export type Effect =
  | { readonly kind: "spawn" }
  | { readonly kind: "load" }
  | { readonly kind: "script" }
  | { readonly kind: "build"; readonly units: ReadonlyArray<SynthesisUnit> }
  | { readonly kind: "perform"; readonly on: Stage; readonly event: PerformerEvent }
  // The stage passes: the performer leaving it is read live, at the edge, and the one
  // arriving is sent `carry` of that state. Read live, not from the state's snapshot: the
  // snapshot is the last REPORT, and the unit player reports a unit crossing only when the
  // source's `ended` arrives, one hop after the clock crossed [LAW:one-source-of-truth].
  | { readonly kind: "handover"; readonly from: Stage; readonly to: Stage }
  // Releases the neural performer and the worker; how the worker ends is the value: a dead
  // worker is terminated, since nothing can be sent to it, a live one is asked to dispose
  // so the model is released first.
  | { readonly kind: "release"; readonly worker: "terminate" | "dispose" };

export interface Step {
  readonly state: PanelState;
  readonly effects: ReadonlyArray<Effect>;
}

// The one script the panel ever sends; a reply with another id is not ours.
export const SCRIPT_ID = 1;

const IDLE: PerformerState = { kind: "idle" };
const NEURAL_IDLE: NeuralPhase = { kind: "idle" };

export const initialState = (standIn: StandIn["kind"]): PanelState => ({
  kind: "provisioning",
  neural: NEURAL_IDLE,
  standIn: standIn === "none" ? { kind: "none", from: TOP } : { kind: "synth", state: IDLE },
  speed: NORMAL,
});

const stay = (state: PanelState): Step => ({ state, effects: [] });
const violation = (state: PanelState, what: string): Error =>
  new Error(`listen panel: ${what} while ${state.kind === "neural" ? "the neural voice is on stage" : state.neural.kind}`);
// The verbs a tap can send: neither a seek nor a rate is ever a tap's — those carry a
// value the two buttons do not name.
type Verb = Exclude<PerformerEvent, { kind: "seek" | "rate" }>["kind"];
const perform = (on: Stage, event: PerformerEvent): Effect => ({ kind: "perform", on, event });
const handover = (from: Stage, to: Stage): Effect => ({ kind: "handover", from, to });
// The reader's speed, handed to a performer taking the stage. Sent unconditionally and
// before the place, so a performer never speaks a syllable at a speed the reader left
// behind, and the browser voice re-speaks once rather than twice
// [LAW:dataflow-not-control-flow].
const atSpeed = (on: Stage, speed: Speed): Effect => perform(on, { kind: "rate", to: speed });

// The phases in which a `progress`, `ready` or `load-failed` may arrive.
const loading = (neural: NeuralPhase): boolean =>
  neural.kind === "preparing" || neural.kind === "downloading" || neural.kind === "warming";

type Provisioning = Extract<PanelState, { kind: "provisioning" }>;
interface ProvisioningStep {
  readonly state: Provisioning;
  readonly effects: ReadonlyArray<Effect>;
}

// What a Play tap (or a seek) does to the neural voice: starts it when idle, retries it
// after a failure, leaves it be otherwise.
const kick = (state: Provisioning): ProvisioningStep => {
  switch (state.neural.kind) {
    case "idle":
    case "crashed":
      return { state: { ...state, neural: { kind: "probing" } }, effects: [{ kind: "spawn" }] };
    case "load-failed":
      return { state: { ...state, neural: { kind: "preparing" } }, effects: [{ kind: "load" }] };
    default:
      return { state, effects: [] };
  }
};

const tap = (state: PanelState, control: Tap): Step => {
  switch (state.kind) {
    case "neural": {
      const verb: Verb = control === "stop" ? "stop" : state.view.player.kind === "speaking" ? "pause" : "play";
      return { state, effects: [perform("neural", { kind: verb })] };
    }
    case "provisioning": {
      const { standIn } = state;
      if (standIn.kind === "none") {
        // Stop is disabled by `readout` here; a tap that reaches it anyway changes nothing.
        return control === "stop" ? stay(state) : kick(state);
      }
      const verb: Verb = control === "stop" ? "stop" : standIn.state.kind === "speaking" ? "pause" : "play";
      const kicked = verb === "play" ? kick(state) : stay(state);
      return { state: kicked.state, effects: [perform("synth", { kind: verb }), ...kicked.effects] };
    }
  }
};

// A tap on a place: whoever is on stage seeks there, and the neural voice is started as a
// Play tap starts it. With no stand-in the place is kept for the neural voice's arrival.
const seek = (state: PanelState, to: Mark): Step => {
  switch (state.kind) {
    case "neural":
      return { state, effects: [perform("neural", { kind: "seek", to })] };
    case "provisioning": {
      const kicked = kick(state);
      if (state.standIn.kind === "none") return { state: { ...kicked.state, standIn: { kind: "none", from: to } }, effects: kicked.effects };
      return { state: kicked.state, effects: [perform("synth", { kind: "seek", to }), ...kicked.effects] };
    }
  }
};


// One step along the speed list, obeyed by whoever is on stage — and by nobody at all
// when no performer exists yet, in which case the state carries it to the one that
// arrives, exactly as `StandIn.none.from` carries the place. A step off either end of the
// list returns the same speed, which `readout` shows as a disabled control.
const speed = (state: PanelState, by: -1 | 1): Step => {
  const to = stepSpeed(state.speed, by);
  if (to === state.speed) return stay(state);
  const stage: Stage | null = state.kind === "neural" ? "neural" : state.standIn.kind === "synth" ? "synth" : null;
  return { state: { ...state, speed: to }, effects: stage === null ? [] : [atSpeed(stage, to)] };
};

const provision = (state: Provisioning, message: FromWorker): Step => {
  const { neural } = state;
  const phase = (next: NeuralPhase, effects: ReadonlyArray<Effect> = []): Step => ({ state: { ...state, neural: next }, effects });
  switch (message.kind) {
    case "capability":
      if (neural.kind !== "probing") throw violation(state, "capability");
      return message.support.kind === "supported"
        ? phase({ kind: "preparing" }, [{ kind: "load" }])
        : phase({ kind: "unsupported", reason: message.support.reason });
    case "progress":
      if (!loading(neural)) throw violation(state, "progress");
      return phase(
        message.progress.loadedBytes < message.progress.totalBytes
          ? { kind: "downloading", progress: message.progress }
          : { kind: "warming" },
      );
    case "ready":
      if (!loading(neural)) throw violation(state, "ready");
      return phase({ kind: "scripting" }, [{ kind: "script" }]);
    case "load-failed":
      if (!loading(neural)) throw violation(state, "load-failed");
      return phase({ kind: "load-failed", failure: message.failure });
    case "script": {
      if (neural.kind !== "scripting") throw violation(state, "script");
      if (message.id !== SCRIPT_ID) throw new Error(`listen panel: script reply ${message.id}, sent ${SCRIPT_ID}`);
      // The neural performer is built; its first view is the next event, and the step
      // that receives it takes the stage. The stand-in speaks on until then.
      return { state, effects: [{ kind: "build", units: message.units }] };
    }
    case "refused":
      throw new Error(`listen panel: the worker refused ${message.request.kind} in phase ${message.phase}`);
    case "disposed":
      // Only `dispose` is answered so, and the port terminates the worker on it before the
      // panel could hear it.
      throw violation(state, "disposed");
    case "audio":
    case "done":
    case "cancelled":
    case "failed":
      // The scheduler's messages: nothing is synthesizing before the neural voice is on
      // stage, and a released worker is no longer heard.
      throw violation(state, message.kind);
  }
};

const fromWorker = (state: PanelState, message: FromWorker): Step => {
  if (state.kind === "provisioning") return provision(state, message);
  switch (message.kind) {
    case "audio":
    case "done":
    case "cancelled":
    case "failed":
      // The scheduler's messages, on the port the panel also hears. Not ours to act on.
      return stay(state);
    default:
      throw violation(state, message.kind);
  }
};

// Where the neural voice's view says it is, as the mark a retry starts from. The last
// REPORT, not the live clock: the performer is about to be released, and a unit boundary
// is reported one hop after the clock crosses it. Cost, stated once: a crash retry with no
// stand-in resumes from the reported unit, at most one unit behind the ear.
const placeOf = (view: NeuralView): Mark => {
  const at = spotOf(view);
  return at.kind === "idle" ? TOP : markOf(at.at);
};

// The stage handed back to the stand-in, or to nobody: what the state becomes and what
// the stand-in is told.
const fallback = (state: PanelState, neural: NeuralPhase): Step => {
  const release: Effect = { kind: "release", worker: "terminate" };
  if (state.kind === "provisioning") return { state: { ...state, neural }, effects: [release] };
  if (state.standIn === "none") {
    return { state: { kind: "provisioning", neural, standIn: { kind: "none", from: placeOf(state.view) }, speed: state.speed }, effects: [release] };
  }
  // The stand-in's own report of where it lands is the next event; until then it is idle.
  return {
    state: { kind: "provisioning", neural, standIn: { kind: "synth", state: IDLE }, speed: state.speed },
    effects: [atSpeed("synth", state.speed), handover("neural", "synth"), release],
  };
};

export const step = (state: PanelState, event: PanelEvent): Step => {
  switch (event.kind) {
    case "tap":
      return tap(state, event.control);
    case "seek":
      return seek(state, event.to);
    case "speed":
      return speed(state, event.by);
    case "worker":
      return fromWorker(state, event.message);
    case "worker-error":
      return fallback(state, { kind: "crashed", message: event.message });
    case "dispose": {
      const standIn = state.kind === "neural" ? state.standIn : state.standIn.kind;
      // Back to the start — but the speed is the reader's, not the panel's, and a teardown
      // is not the reader changing their mind [LAW:one-source-of-truth].
      return {
        state: { ...initialState(standIn), speed: state.speed },
        effects: [{ kind: "release", worker: "dispose" }, ...(standIn === "synth" ? [perform("synth", { kind: "stop" })] : [])],
      };
    }
    case "view": {
      if (state.kind === "neural") return stay({ ...state, view: event.view });
      if (state.neural.kind !== "scripting") throw violation(state, "a scheduler view");
      // The performer's first view: the neural voice takes the stage where the stand-in
      // stands, and the stand-in is silenced. With no stand-in, the tap that started the
      // download is the consent to play, from the place it named.
      const onto: ReadonlyArray<Effect> =
        state.standIn.kind === "synth"
          ? [handover("synth", "neural"), perform("synth", { kind: "stop" })]
          : [perform("neural", { kind: "seek", to: state.standIn.from })];
      return {
        state: { kind: "neural", view: event.view, standIn: state.standIn.kind, speed: state.speed },
        effects: [atSpeed("neural", state.speed), ...onto],
      };
    }
    case "synth":
      if (state.kind === "neural") {
        // The idle the stand-in reports on being silenced at the handover; a stand-in
        // speaking beside the neural voice is a violation.
        if (event.state.kind === "idle") return stay(state);
        throw violation(state, "a stand-in report");
      }
      if (state.standIn.kind === "none") throw violation(state, "a report from a stand-in that does not exist");
      return stay({ ...state, standIn: { kind: "synth", state: event.state } });
  }
};

// ── the readout ────────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] What a tap on the one big button would DO, rather than the
// word a text button used to wear: the transport's face is icons, and an icon cannot be a
// label. The view maps each action to its mark and its accessible name; nothing outside
// re-derives which icon from a word [LAW:one-source-of-truth].
export type PlayAction = "listen" | "pause" | "resume" | "retry";

// What the panel shows: every control's shape, the status sentence, and the download when
// there is one. A pure projection of the state, so the check reads it directly. A control
// that would do nothing is `enabled: false` rather than a button that answers a tap with
// silence — the ends of the speed list and of the conversation are shown, not discovered
// [LAW:no-silent-failure].
export interface Readout {
  readonly play: { readonly action: PlayAction; readonly enabled: boolean };
  // Whether the reader has engaged the voice at all. The transport is one control until
  // they do — a button that says Listen — and the whole strip afterwards, for as long as
  // the page lives: a reader who stops is still a listener, and having to find the button
  // again is the thing this replaces. Engagement is one-way because the state it reads is:
  // a phase past `idle` never returns to it except through the page's own teardown.
  readonly engaged: boolean;
  readonly stop: { readonly enabled: boolean };
  readonly skip: { readonly back: boolean; readonly forward: boolean };
  readonly speed: { readonly label: string; readonly slower: boolean; readonly faster: boolean };
  readonly status: string;
  readonly progress: AssetProgress | null;
}

// What the scrubber and the two times show. Separate from the Readout above because it has
// a different clock: everything up there changes only when the machine's state does, while
// this moves continuously as the voice speaks, so the driver paints it on every animation
// frame from the performer's LIVE position [LAW:one-source-of-truth]. In the conversation's
// own milliseconds throughout — media time, not wall-clock: at 1.5x the paste ends sooner
// than `remaining` says in seconds you can count, and the speed beside it is what says so.
// Scaling one of the two by the speed and not the other would put the thumb and the words
// on different clocks.
interface Clock {
  readonly atMs: number;
  readonly totalMs: number;
  readonly played: string;
  readonly remaining: string;
}

export const DOWNLOAD_BYTES = allModelAssets(MODEL_ASSETS).reduce((sum, asset) => sum + asset.bytes, 0);

const megabytes = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`;

const unsupportedText = (reason: UnsupportedReason): string => {
  switch (reason.kind) {
    case "no-webgpu":
      return "this browser has no WebGPU";
    case "no-adapter":
      return "no graphics adapter is available";
    case "no-f16":
      return "the graphics adapter lacks 16-bit floats";
    case "no-device":
      return `a graphics device could not be opened: ${reason.message}`;
  }
};

const loadFailureText = (failure: LoadFailure): string => {
  switch (failure.kind) {
    case "http":
      return `HTTP ${failure.status} fetching ${failure.url}`;
    case "network":
      return `network error fetching ${failure.url}: ${failure.message}`;
    case "integrity":
      return `checksum mismatch for ${failure.key}`;
    case "runtime":
      return `the model could not start: ${failure.message}`;
  }
};

const unitFailureText = (reason: FailureReason): string => {
  switch (reason.kind) {
    case "frame-cap":
      return `the model looped for ${reason.frames} frames without finishing`;
    case "runtime":
      return reason.message;
    case "bad-duration":
    case "word-count":
    case "times-out-of-order":
      return `its report was rejected (${reason.kind})`;
  }
};

// The neural voice's own sentence, as a fragment the status line can lead with or follow
// the stand-in's with — one set of words for both [LAW:one-source-of-truth].
const neuralText = (neural: NeuralPhase): string => {
  switch (neural.kind) {
    case "idle":
      return `the neural voice downloads a ${megabytes(DOWNLOAD_BYTES)} model once, then runs on this device`;
    case "probing":
      return "checking this device for the neural voice…";
    case "preparing":
      return "preparing the neural voice…";
    case "downloading":
      return `downloading the neural voice · ${megabytes(neural.progress.loadedBytes)} of ${megabytes(neural.progress.totalBytes)}`;
    case "warming":
      return "warming up the neural voice…";
    case "scripting":
      return "preparing the script…";
    case "unsupported":
      return `this device can't run the neural voice: ${unsupportedText(neural.reason)}`;
    case "load-failed":
      return `the neural voice could not load: ${loadFailureText(neural.failure)}`;
    case "crashed":
      return `the neural voice failed${neural.message === "" ? "" : `: ${neural.message}`}`;
  }
};

const sentence = (fragment: string): string => fragment.charAt(0).toUpperCase() + fragment.slice(1);

const where = (utterance: number, total: number): string => `passage ${utterance + 1} of ${total}`;

// What the stand-in has to say for itself — nothing, while it is silent. A browser voice
// that is not speaking is not standing in for anything, and saying it is would describe the
// page's resting state as a substitution that has not happened [LAW:no-silent-failure].
const standInStatus = (state: PerformerState, total: number): string => {
  switch (state.kind) {
    case "idle":
      return "";
    case "speaking":
      return `Browser voice standing in · ${where(state.at.utterance, total)}`;
    case "paused":
      return `Browser voice standing in · paused at ${where(state.at.utterance, total)}`;
  }
};

// [LAW:dataflow-not-control-flow] The status line is its fragments, in order, minus the
// ones with nothing to say: the same expression serves a page whose stand-in is mid-passage
// and one that has never made a sound, so the two cannot word the same state differently.
const line = (...parts: ReadonlyArray<string>): string => sentence(parts.filter((part) => part !== "").join(" · "));

const neuralStatus = (view: NeuralView, total: number): string => {
  const at = (unitIndex: number): string => {
    const utterance = view.utteranceOf[unitIndex];
    if (utterance === undefined) throw new Error(`listen panel: unit ${unitIndex} of ${view.utteranceOf.length}`);
    return where(utterance, total);
  };
  const skipped = view.holdings.flatMap((holding, i) =>
    holding.kind === "failed" ? [`${at(i)} could not be synthesized: ${unitFailureText(holding.reason)}`] : [],
  );
  const { player } = view;
  const now =
    player.kind === "idle"
      ? "Ready"
      : player.kind === "paused"
        ? `Paused · ${at(player.at.unitIndex)}`
        : player.flow === "audio"
          ? `Playing · ${at(player.at.unitIndex)}`
          : `Synthesizing ahead… · ${at(player.at.unitIndex)}`;
  return [now, ...skipped].join(" · ");
};

// [LAW:one-source-of-truth] What the stage performer is doing, read from the state in ONE
// place: the Play button's label, whether there is anything to Stop, whether the frame loop
// runs, and whether the reader's keys belong to the transport all follow this one reading.
const stageKind = (state: PanelState): PerformerState["kind"] =>
  state.kind === "neural" ? state.view.player.kind : state.standIn.kind === "synth" ? state.standIn.state.kind : "idle";

// Whether the transport's keys are the reader's rather than the page's: exactly while there
// is a voice to pause. Before the first Listen and after a Stop, Space scrolls the page as
// it always did and the arrows are the browser's — a reading page that swallowed those keys
// for a tool nobody has opened would be worse than one with no shortcuts at all.
export const listening = (state: PanelState): boolean => stageKind(state) !== "idle";

// Where the transport stands, from the state alone: the performer's own place when it has
// one, the place held for a performer that does not exist yet, and the top before anyone has
// asked for one. This is the last REPORT — the driver reads the live clock for the cursor
// and the scrubber; a button's shape needs only the passage, which no report can be stale
// about, since every passage boundary is one.
const placeIn = (state: PanelState): Mark => {
  if (state.kind === "neural") return placeOf(state.view);
  if (state.standIn.kind === "none") return state.standIn.from;
  return state.standIn.state.kind === "idle" ? TOP : markOf(state.standIn.state.at);
};

// The timeline the state implies: the script's, measured as far as the worker has got,
// once the neural voice is on stage; the page's own passages, every leg an estimate, while
// the browser voice stands in or nothing plays yet [LAW:one-type-per-behavior].
const timelineOf = (state: PanelState, utterances: ReadonlyArray<Utterance>): Timeline =>
  state.kind === "neural" ? timelineOfScript(state.view.manifest, state.view.utteranceOf) : timelineOfUtterances(utterances);

// The scrubber and the times at a point on the clock. Takes the milliseconds rather than a
// mark because the reader dragging the scrubber is at a time that is not yet anybody's
// place, and the drag must read the same words the voice does.
const clockAt = (timeline: Timeline, ms: number): Clock => {
  const atMs = Math.min(Math.max(ms, 0), timeline.totalMs);
  const left = timeline.totalMs - atMs;
  return {
    atMs,
    totalMs: timeline.totalMs,
    played: clockText(atMs),
    // "about" over exactly the guesses: the tail the worker has not measured is shared out
    // by character count, and saying so is the difference between an estimate and a lie
    // [LAW:no-silent-failure].
    remaining: `${estimated(timeline, atMs) ? "about " : ""}${clockText(left)} left`,
  };
};

// The transport over whoever is on stage: the action follows what a tap would do. Only
// the kind is read, which the unit player's state and the performer's share.
const transport = (state: { readonly kind: PerformerState["kind"] }): Pick<Readout, "play" | "stop"> => ({
  play: { action: state.kind === "speaking" ? "pause" : state.kind === "paused" ? "resume" : "listen", enabled: true },
  stop: { enabled: state.kind !== "idle" },
});

// Whether the reader has asked for a voice at all: the neural voice on stage, or on its
// way, or having failed on the way — every phase but the one before the first tap.
const engaged = (state: PanelState): boolean => state.kind === "neural" || state.neural.kind !== "idle";

// The controls that read the conversation rather than the performer: which turn skips are
// there to take, and which way the speed list still runs.
const around = (state: PanelState, utterances: ReadonlyArray<Utterance>): Pick<Readout, "skip" | "speed"> => {
  const turns = turnStarts(utterances);
  const at = placeIn(state);
  return {
    skip: { back: turnMark(turns, at, -1) !== null, forward: turnMark(turns, at, 1) !== null },
    speed: {
      label: `${state.speed}×`,
      slower: stepSpeed(state.speed, -1) !== state.speed,
      faster: stepSpeed(state.speed, 1) !== state.speed,
    },
  };
};

export const readout = (state: PanelState, utterances: ReadonlyArray<Utterance>): Readout => {
  const total = utterances.length;
  const rest = { ...around(state, utterances), engaged: engaged(state) };
  if (state.kind === "neural") {
    return { ...transport(state.view.player), ...rest, status: neuralStatus(state.view, total), progress: null };
  }
  const { neural, standIn } = state;
  const progress = neural.kind === "downloading" ? neural.progress : null;
  const status = line(standIn.kind === "synth" ? standInStatus(standIn.state, total) : "", neuralText(neural));
  if (standIn.kind === "synth") {
    return { ...transport(standIn.state), ...rest, status, progress };
  }
  // No stand-in: the transport waits for the neural voice, and Play is the retry.
  const retry = neural.kind === "load-failed" || neural.kind === "crashed";
  return {
    play: { action: retry ? "retry" : "listen", enabled: retry || neural.kind === "idle" },
    stop: { enabled: false },
    ...rest,
    status,
    progress,
  };
};

// ── the cursor ─────────────────────────────────────────────────────────────────────────

// Where the read-along is, from a performer's spot: the utterance, every utterance of its
// turn, and the cursor to paint.
export const readAlongAt = (spot: Spot, utterances: ReadonlyArray<Utterance>): ReadAlongAt => {
  const utterance = utterances[spot.utterance];
  if (utterance === undefined) throw new Error(`listen panel: the performer is at utterance ${spot.utterance} of ${utterances.length}`);
  return { utterance, turn: turnOf(utterances, utterance.anchor), segment: spot.segment, word: spot.word };
};

// Whether the stage performer is speaking, from the state: exactly when the frame loop runs.
const speaking = (state: PanelState): boolean => stageKind(state) === "speaking";

// ── the driver ─────────────────────────────────────────────────────────────────────────

// What each action is called, for the button's accessible name and for the word the
// collapsed transport wears beside its mark. One map, so the name a screen reader hears is
// the name the page shows [LAW:one-source-of-truth].
export const PLAY_WORDS: { readonly [K in PlayAction]: string } = {
  listen: "Listen",
  pause: "Pause",
  resume: "Resume",
  retry: "Retry",
};

// The class the bar wears once the reader has engaged the voice: the one fact the whole
// presentation turns on, so the stylesheet decides what a collapsed transport shows and no
// script hides six elements one at a time [LAW:dataflow-not-control-flow].
export const ENGAGED_CLASS = "is-engaged";

// Every control the transport owns. One field per thing the reader can see or move, so
// `render` below is a total assignment from the readout and nothing on the page is written
// from anywhere else [LAW:single-enforcer].
export interface ListenControls {
  // The strip itself: it carries the engaged class, and the stylesheet does the rest.
  readonly bar: HTMLElement;
  readonly play: HTMLButtonElement;
  // The word beside the play mark. A separate element because the button's own text node
  // would have to share room with two inline marks, and writing textContent on the button
  // would take them out with it.
  readonly playWord: HTMLElement;
  readonly stop: HTMLButtonElement;
  readonly back: HTMLButtonElement;
  readonly forward: HTMLButtonElement;
  readonly slower: HTMLButtonElement;
  readonly faster: HTMLButtonElement;
  readonly speed: HTMLElement;
  readonly scrub: HTMLInputElement;
  readonly played: HTMLElement;
  readonly remaining: HTMLElement;
  readonly status: HTMLElement;
  readonly progress: HTMLProgressElement;
}

// The animation-frame seam, so the check fires frames by hand.
export interface FrameLoop {
  readonly request: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
}

export interface ListenPanelConfig {
  readonly controls: ListenControls;
  readonly utterances: ReadonlyArray<Utterance>;
  readonly voices: VoiceMap;
  readonly spawn: () => SynthesisPort;
  readonly Device: DeviceFactory;
  readonly frames: FrameLoop;
  // The browser voice that stands in while the neural voice is on its way, built over the
  // panel's report callback — or null on a browser with no synthesizer.
  readonly standIn: ((onState: (state: PerformerState) => void) => Performer) | null;
  // Called with where the read-along is whenever it moves, and with null when it stops.
  // This is the panel's one outward signal; the state itself is readable through `state()`.
  readonly onPosition: (at: ReadAlongAt | null) => void;
  // Called when the reader asked to BE somewhere — a tap on a word, the scrubber, a nudge,
  // a turn skip — so whoever keeps the page in view looks there. One place decides this for
  // every door a seek can come through [LAW:single-enforcer]: a key and a click cannot drift
  // apart on whether the page follows.
  readonly onSeek: () => void;
}

export interface ListenPanel {
  // The reader's one door: every gesture, from every control and every key, arrives here.
  readonly send: (gesture: Gesture) => void;
  readonly state: () => PanelState;
  // Ends the listen, the stand-in and the worker (gracefully: the model is released before
  // the worker ends); the page is left as the renderer made it, the controls show the
  // idle readout.
  readonly dispose: () => void;
}

// Writing text the element already has replaces its text node for nothing, and the clock
// below is painted sixty times a second; this is the one place that decides not to.
const setText = (el: Element, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};

const render = (controls: ListenControls, shown: Readout): void => {
  // Three writes from one action: which mark the stylesheet shows, what the button is
  // called, and the word the collapsed strip wears.
  controls.play.dataset["action"] = shown.play.action;
  const word = PLAY_WORDS[shown.play.action];
  controls.play.setAttribute("aria-label", word);
  setText(controls.playWord, word);
  controls.bar.classList.toggle(ENGAGED_CLASS, shown.engaged);
  controls.play.disabled = !shown.play.enabled;
  controls.stop.disabled = !shown.stop.enabled;
  controls.back.disabled = !shown.skip.back;
  controls.forward.disabled = !shown.skip.forward;
  controls.slower.disabled = !shown.speed.slower;
  controls.faster.disabled = !shown.speed.faster;
  setText(controls.speed, shown.speed.label);
  setText(controls.status, shown.status);
  // The strip clips its status to one line so the row cannot grow under the reader's
  // thumb; the whole sentence stays reachable here.
  controls.status.title = shown.status;
  controls.progress.hidden = shown.progress === null;
  controls.progress.max = shown.progress?.totalBytes ?? 1;
  controls.progress.value = shown.progress?.loadedBytes ?? 0;
};

// The scrubber and the times. `held` is the reader's thumb: while they drag, the input's
// value is their intent and must not be pulled back under the pointer, though the times
// still follow it so the drag can be aimed [LAW:one-source-of-truth] — the voice's place is
// authoritative for where playback IS, the drag for where the reader is asking to go.
const renderClock = (controls: ListenControls, clock: Clock, held: boolean): void => {
  if (!held) {
    controls.scrub.max = String(Math.round(clock.totalMs));
    controls.scrub.value = String(Math.round(clock.atMs));
  }
  controls.scrub.setAttribute("aria-valuetext", clock.played);
  setText(controls.played, clock.played);
  setText(controls.remaining, clock.remaining);
};

const sameSpan = (a: WordSpan | null, b: WordSpan | null): boolean =>
  a === b || (a !== null && b !== null && a.charStart === b.charStart && a.charEnd === b.charEnd);
const samePlace = (a: ReadAlongAt | null, b: ReadAlongAt | null): boolean =>
  a === b || (a !== null && b !== null && a.utterance === b.utterance && sameSpan(a.segment, b.segment) && sameSpan(a.word, b.word));

export const createListenPanel = (config: ListenPanelConfig): ListenPanel => {
  const { controls, frames, utterances } = config;
  // [LAW:no-shared-mutable-globals] Owned here; written only by `dispatch`, from `step`.
  const synth = config.standIn === null ? null : config.standIn((reported) => dispatch({ kind: "synth", state: reported }));
  let state: PanelState = initialState(synth === null ? "none" : "synth");
  const queue: PanelEvent[] = [];
  let draining = false;
  // The handles effects create; an effect that needs one before it exists is a bug in
  // `step`, and says so.
  const unheard = (): void => undefined;
  let port: SynthesisPort | null = null;
  let unsubscribe: () => void = unheard;
  let unsubscribeErrors: () => void = unheard;
  let neural: NeuralPerformer | null = null;
  const portOf = (): SynthesisPort => {
    if (port === null) throw new Error("listen panel: no worker to send to");
    return port;
  };
  const performerOn = (stage: Stage): Performer => {
    const performer = stage === "neural" ? neural : synth;
    if (performer === null) throw new Error(`listen panel: no ${stage} performer to drive`);
    return performer;
  };

  let frame: number | null = null;
  let shown: ReadAlongAt | null = null;
  // [LAW:no-shared-mutable-globals] The reader's thumb on the scrubber, owned here and
  // written only by its two listeners. It is not a second position: it is the one fact
  // nobody else holds — that the reader is asking for a place they have not committed to.
  let held = false;
  // The timeline the current state implies, rebuilt when the state changes rather than on
  // every frame: a long paste is thousands of legs, and re-deriving the whole clock sixty
  // times a second would cost more than the thumb it moves. A cache with one owner and one
  // key — the state object it was built from, which every change replaces, so the two can
  // never disagree about which clock this is [LAW:one-source-of-truth].
  let clockFor: PanelState = state;
  let clockLine: Timeline = timelineOf(state, utterances);
  const timeline = (): Timeline => {
    if (clockFor !== state) {
      clockLine = timelineOf(state, utterances);
      clockFor = state;
    }
    return clockLine;
  };
  // The turn landmarks: a fact of the page's utterance list, so they are read once for the
  // panel's whole life rather than with each skip.
  const turns = turnStarts(utterances);

  // Read live from the stage performer, not from the state's snapshot: within an
  // utterance the span moves with no event.
  const stageState = (): PerformerState =>
    state.kind === "neural" ? performerOn("neural").state() : state.standIn.kind === "synth" ? performerOn("synth").state() : IDLE;
  // Where the voice is now, as the one coordinate every transport reading is in: the live
  // spot while there is one, else the place the state holds.
  const placeNow = (): Mark => {
    const now = stageState();
    return now.kind === "idle" ? placeIn(state) : markOf(now.at);
  };
  // What the scrubber and the times show right now: the reader's drag while they are
  // dragging, the voice's own place otherwise.
  const clockNow = (): Clock => {
    const line = timeline();
    return clockAt(line, held ? Number(controls.scrub.value) : timeAt(line, placeNow()));
  };
  const paintClock = (): void => renderClock(controls, clockNow(), held);

  const emitPosition = (): void => {
    const now = stageState();
    const at = now.kind === "idle" ? null : readAlongAt(now.at, utterances);
    if (samePlace(at, shown)) return;
    shown = at;
    config.onPosition(at);
  };
  // The loop runs exactly while the stage performer is speaking.
  const syncFrames = (): void => {
    const running = speaking(state);
    if (running && frame === null) {
      frame = frames.request(() => {
        frame = null;
        emitPosition();
        paintClock();
        syncFrames();
      });
    }
    if (!running && frame !== null) {
      frames.cancel(frame);
      frame = null;
    }
  };

  const performEffect = (effect: Effect): void => {
    switch (effect.kind) {
      case "spawn":
        port = config.spawn();
        unsubscribe = port.subscribe((message) => dispatch({ kind: "worker", message }));
        unsubscribeErrors = port.errors((message) => dispatch({ kind: "worker-error", message }));
        return;
      case "load":
        portOf().send({ kind: "load" });
        return;
      case "script":
        portOf().send({ kind: "script", id: SCRIPT_ID, utterances });
        return;
      case "build": {
        const built = createNeuralPerformer({
          port: portOf(),
          script: effect.units,
          utterances,
          voices: config.voices,
          Device: config.Device,
          onChange: (view) => dispatch({ kind: "view", view }),
        });
        neural = built;
        dispatch({ kind: "view", view: built.view() });
        return;
      }
      case "perform":
        performerOn(effect.on).send(effect.event);
        return;
      case "handover": {
        const arriving = performerOn(effect.to);
        for (const event of carry(performerOn(effect.from).state())) arriving.send(event);
        return;
      }
      case "release": {
        // A worker can die before the neural performer exists (the bundle failed to load)
        // or after; either way what exists is released, the performer before the worker.
        const releasing = neural;
        neural = null;
        releasing?.dispose();
        unsubscribe();
        unsubscribeErrors();
        unsubscribe = unheard;
        unsubscribeErrors = unheard;
        port?.[effect.worker]();
        port = null;
        return;
      }
    }
  };

  const run = (event: PanelEvent): void => {
    const planned = step(state, event);
    state = planned.state;
    for (const effect of planned.effects) performEffect(effect);
    render(controls, readout(state, utterances));
    syncFrames();
    emitPosition();
    paintClock();
  };
  const dispatch = (event: PanelEvent): void => {
    queue.push(event);
    if (draining) return;
    draining = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) run(next);
    } catch (error) {
      // [LAW:no-silent-failure] A step or effect that throws is a bug in the machine. The
      // events queued behind it would drain against a state the performed effects have
      // left behind, and the readout would keep describing a stage nobody is on; so the
      // panel is torn down to its start — worker released, stand-in silenced — and the
      // error goes out as it is. A teardown that fails too goes out WITH it: neither
      // failure hides the other.
      queue.length = 0;
      try {
        run({ kind: "dispose" });
      } catch (teardown) {
        throw new AggregateError([error, teardown], "listen panel: a bug in the machine, and its teardown failed");
      } finally {
        queue.length = 0;
      }
      throw error;
    } finally {
      draining = false;
    }
  };

  // [LAW:dataflow-not-control-flow] Every gesture becomes the one event the machine
  // already had — a tap, a seek to a mark, a speed step — so nothing below the panel knows
  // a scrubber exists. The three gestures that name a TIME are resolved here, where the
  // timeline is: a scrubber position becomes a Mark, never a unit index, and the performer
  // on stage refines that mark its own way — the neural voice to the word's own measured
  // time, the browser voice to the sentence from that character.
  //
  // Null is the honest answer to a gesture that names nowhere: no turn before the first,
  // none after the last, no mark at all in a conversation with nothing to say. The control
  // that would send it is disabled by `readout`, so only a key can reach this, and the
  // reader hears what they already hear.
  const resolve = (gesture: Gesture): PanelEvent | null => {
    const to = (mark: Mark | null): PanelEvent | null => (mark === null ? null : { kind: "seek", to: mark });
    switch (gesture.kind) {
      case "tap":
        return { kind: "tap", control: gesture.control };
      case "speed":
        return { kind: "speed", by: gesture.by };
      case "mark":
        return { kind: "seek", to: gesture.to };
      case "scrub":
        return to(markAt(timeline(), gesture.toMs));
      case "nudge":
        return to(markAt(timeline(), timeAt(timeline(), placeNow()) + gesture.bySeconds * 1000));
      case "turn":
        return to(turnMark(turns, placeNow(), gesture.by));
    }
  };

  const send = (gesture: Gesture): void => {
    const event = resolve(gesture);
    if (event === null) return;
    dispatch(event);
    if (moves(gesture)) config.onSeek();
  };

  render(controls, readout(state, utterances));
  paintClock();
  const taps: ReadonlyArray<readonly [HTMLElement, Gesture]> = [
    [controls.play, { kind: "tap", control: "play" }],
    [controls.stop, { kind: "tap", control: "stop" }],
    [controls.back, { kind: "turn", by: -1 }],
    [controls.forward, { kind: "turn", by: 1 }],
    [controls.slower, { kind: "speed", by: -1 }],
    [controls.faster, { kind: "speed", by: 1 }],
  ];
  for (const [button, gesture] of taps) button.addEventListener("click", () => send(gesture));
  // A drag is two facts, and the input reports them separately: `input` is the thumb
  // moving, which only the times follow, and `change` is the reader letting go, which is
  // the seek. Seeking on every `input` would restart the audio schedule and re-aim the
  // worker dozens of times across one drag, so the seek waits for the thumb to land
  // [LAW:no-ambient-temporal-coupling]. Cost, stated once: no audio scrub preview.
  controls.scrub.addEventListener("input", () => {
    held = true;
    paintClock();
  });
  controls.scrub.addEventListener("change", () => {
    held = false;
    send({ kind: "scrub", toMs: Number(controls.scrub.value) });
  });

  return {
    send,
    state: () => state,
    // One more event through the same machine: the idle state disarms the frame loop,
    // clears the position, and the controls say what the state says, so a page back from
    // the back-forward cache finds them right.
    dispose: () => dispatch({ kind: "dispose" }),
  };
};
