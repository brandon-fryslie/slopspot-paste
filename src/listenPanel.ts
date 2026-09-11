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
// utterance, from its start — then the stand-in is silenced. The same effect, the other
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
// taps Play: the worker bundle, the probe and the download all follow one tap, and the tap
// IS the consent modelAssets.downloadNeedsTap asks for on a metered connection. A Play tap
// that starts or resumes the stand-in also starts the neural voice when it is idle, or
// retries it after a failed load or a crash; a Pause tap touches nothing but the stand-in.
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
import { createNeuralPerformer, type NeuralPerformer, type NeuralView } from "./neuralPerformer";
import { carry, type Performer, type PerformerEvent, type PerformerState, type Spot } from "./performer";
import type { ReadAlongAt } from "./readAlong";
import type { FailureReason } from "./scheduler";
import type { Utterance } from "./speech";
import type { SynthesisUnit, VoiceMap } from "./speechScript";
import type { SynthesisPort } from "./synthesisClient";
import type { FromWorker, LoadFailure, UnsupportedReason } from "./synthesisProtocol";
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

// The browser voice, or its absence on a browser with no synthesizer.
export type StandIn = { readonly kind: "none" } | { readonly kind: "synth"; readonly state: PerformerState };

export type PanelState =
  | { readonly kind: "provisioning"; readonly neural: NeuralPhase; readonly standIn: StandIn }
  // The neural voice on stage. The stand-in is silent by construction; only whether one
  // exists to hand the stage back to is carried.
  | { readonly kind: "neural"; readonly view: NeuralView; readonly standIn: StandIn["kind"] };

export type Tap = "play" | "stop";

export type PanelEvent =
  | { readonly kind: "tap"; readonly control: Tap }
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
  standIn: standIn === "none" ? { kind: "none" } : { kind: "synth", state: IDLE },
});

const stay = (state: PanelState): Step => ({ state, effects: [] });
const violation = (state: PanelState, what: string): Error =>
  new Error(`listen panel: ${what} while ${state.kind === "neural" ? "the neural voice is on stage" : state.neural.kind}`);
// The verbs a tap can send: a seek is never a tap's.
type Verb = Exclude<PerformerEvent, { kind: "seek" }>["kind"];
const perform = (on: Stage, event: PerformerEvent): Effect => ({ kind: "perform", on, event });
const handover = (from: Stage, to: Stage): Effect => ({ kind: "handover", from, to });

// The phases in which a `progress`, `ready` or `load-failed` may arrive.
const loading = (neural: NeuralPhase): boolean =>
  neural.kind === "preparing" || neural.kind === "downloading" || neural.kind === "warming";

type Provisioning = Extract<PanelState, { kind: "provisioning" }>;

// What a Play tap does to the neural voice: starts it when idle, retries it after a
// failure, leaves it be otherwise.
const kick = (state: Provisioning): Step => {
  switch (state.neural.kind) {
    case "idle":
    case "crashed":
      return { state: { ...state, neural: { kind: "probing" } }, effects: [{ kind: "spawn" }] };
    case "load-failed":
      return { state: { ...state, neural: { kind: "preparing" } }, effects: [{ kind: "load" }] };
    default:
      return stay(state);
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

// The stage handed back to the stand-in, or to nobody: what the state becomes and what
// the stand-in is told.
const fallback = (state: PanelState, neural: NeuralPhase): Step => {
  const release: Effect = { kind: "release", worker: "terminate" };
  if (state.kind === "provisioning") return { state: { ...state, neural }, effects: [release] };
  if (state.standIn === "none") return { state: { kind: "provisioning", neural, standIn: { kind: "none" } }, effects: [release] };
  // The stand-in's own report of where it lands is the next event; until then it is idle.
  return {
    state: { kind: "provisioning", neural, standIn: { kind: "synth", state: IDLE } },
    effects: [handover("neural", "synth"), release],
  };
};

export const step = (state: PanelState, event: PanelEvent): Step => {
  switch (event.kind) {
    case "tap":
      return tap(state, event.control);
    case "worker":
      return fromWorker(state, event.message);
    case "worker-error":
      return fallback(state, { kind: "crashed", message: event.message });
    case "dispose": {
      const standIn = state.kind === "neural" ? state.standIn : state.standIn.kind;
      return {
        state: initialState(standIn),
        effects: [{ kind: "release", worker: "dispose" }, ...(standIn === "synth" ? [perform("synth", { kind: "stop" })] : [])],
      };
    }
    case "view": {
      if (state.kind === "neural") return stay({ ...state, view: event.view });
      if (state.neural.kind !== "scripting") throw violation(state, "a scheduler view");
      // The performer's first view: the neural voice takes the stage where the stand-in
      // stands, and the stand-in is silenced. With no stand-in, the tap that started the
      // download is the consent to play.
      const onto: ReadonlyArray<Effect> =
        state.standIn.kind === "synth" ? [handover("synth", "neural"), perform("synth", { kind: "stop" })] : [perform("neural", { kind: "play" })];
      return { state: { kind: "neural", view: event.view, standIn: state.standIn.kind }, effects: onto };
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

// What the panel shows: the two buttons' shape, the status sentence, and the download
// when there is one. A pure projection of the state, so the check reads it directly.
export interface Readout {
  readonly play: { readonly label: string; readonly enabled: boolean };
  readonly stop: { readonly enabled: boolean };
  readonly status: string;
  readonly progress: AssetProgress | null;
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

const standInStatus = (state: PerformerState, total: number): string => {
  switch (state.kind) {
    case "idle":
      return "Browser voice standing in";
    case "speaking":
      return `Browser voice standing in · ${where(state.at.utterance, total)}`;
    case "paused":
      return `Browser voice standing in · paused at ${where(state.at.utterance, total)}`;
  }
};

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

// The transport over whoever is on stage: the label follows what a tap would do. Only
// the kind is read, which the unit player's state and the performer's share.
const transport = (state: { readonly kind: PerformerState["kind"] }): Pick<Readout, "play" | "stop"> => ({
  play: { label: state.kind === "speaking" ? "Pause" : state.kind === "paused" ? "Resume" : "Listen", enabled: true },
  stop: { enabled: state.kind !== "idle" },
});

// `total` is the page's utterance count: the "of N" every position reads.
export const readout = (state: PanelState, total: number): Readout => {
  if (state.kind === "neural") {
    return { ...transport(state.view.player), status: neuralStatus(state.view, total), progress: null };
  }
  const { neural, standIn } = state;
  const progress = neural.kind === "downloading" ? neural.progress : null;
  if (standIn.kind === "synth") {
    return { ...transport(standIn.state), status: `${standInStatus(standIn.state, total)} · ${neuralText(neural)}`, progress };
  }
  // No stand-in: the transport waits for the neural voice, and Play is the retry.
  const retry = neural.kind === "load-failed" || neural.kind === "crashed";
  return {
    play: { label: retry ? "Retry" : "Listen", enabled: retry || neural.kind === "idle" },
    stop: { enabled: false },
    status: sentence(neuralText(neural)),
    progress,
  };
};

// ── the cursor ─────────────────────────────────────────────────────────────────────────

// Where the read-along is, from a performer's spot: the utterance, every utterance of its
// turn, and the span to paint.
export const readAlongAt = (spot: Spot, utterances: ReadonlyArray<Utterance>): ReadAlongAt => {
  const utterance = utterances[spot.utterance];
  if (utterance === undefined) throw new Error(`listen panel: the performer is at utterance ${spot.utterance} of ${utterances.length}`);
  return { utterance, turn: utterances.filter((u) => u.anchor === utterance.anchor), span: spot.span };
};

// Whether the stage performer is speaking, from the state: exactly when the frame loop runs.
const speaking = (state: PanelState): boolean =>
  state.kind === "neural" ? state.view.player.kind === "speaking" : state.standIn.kind === "synth" && state.standIn.state.kind === "speaking";

// ── the driver ─────────────────────────────────────────────────────────────────────────

export interface ListenControls {
  readonly play: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
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
}

export interface ListenPanel {
  readonly send: (control: Tap) => void;
  readonly state: () => PanelState;
  // Ends the listen, the stand-in and the worker (gracefully: the model is released before
  // the worker ends); the page is left as the renderer made it, the controls show the
  // idle readout.
  readonly dispose: () => void;
}

// Which role the six hosted voices speak. A VALUE, per the epic: the reader's pick by ear
// replaces it without touching an asset. Until that pick, the spike's word-accuracy
// ranking chooses — the voices Whisper transcribed with zero errors take the roles that
// say the most.
export const DEFAULT_VOICES: VoiceMap = { user: "alba", assistant: "javert", system: "eponine", narrator: "azelma" };

const render = (controls: ListenControls, shown: Readout): void => {
  controls.play.textContent = shown.play.label;
  controls.play.disabled = !shown.play.enabled;
  controls.stop.disabled = !shown.stop.enabled;
  controls.status.textContent = shown.status;
  controls.progress.hidden = shown.progress === null;
  controls.progress.max = shown.progress?.totalBytes ?? 1;
  controls.progress.value = shown.progress?.loadedBytes ?? 0;
};

const samePlace = (a: ReadAlongAt | null, b: ReadAlongAt | null): boolean =>
  a === b || (a !== null && b !== null && a.utterance === b.utterance && a.span.charStart === b.span.charStart && a.span.charEnd === b.span.charEnd);

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
  // Read live from the stage performer, not from the state's snapshot: within an
  // utterance the span moves with no event.
  const stageState = (): PerformerState =>
    state.kind === "neural" ? performerOn("neural").state() : state.standIn.kind === "synth" ? performerOn("synth").state() : IDLE;
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
    render(controls, readout(state, utterances.length));
    syncFrames();
    emitPosition();
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
      // error goes out as it is.
      queue.length = 0;
      run({ kind: "dispose" });
      queue.length = 0;
      throw error;
    } finally {
      draining = false;
    }
  };

  render(controls, readout(state, utterances.length));
  controls.play.addEventListener("click", () => dispatch({ kind: "tap", control: "play" }));
  controls.stop.addEventListener("click", () => dispatch({ kind: "tap", control: "stop" }));

  return {
    send: (control) => dispatch({ kind: "tap", control }),
    state: () => state,
    // One more event through the same machine: the idle state disarms the frame loop,
    // clears the position, and the controls say what the state says, so a page back from
    // the back-forward cache finds them right.
    dispose: () => dispatch({ kind: "dispose" }),
  };
};
