// [LAW:decomposition] The Listen panel: it takes the reader from a tap to audio and shows,
// at every moment, where the voice is and why it is not yet speaking. One sentence, no
// "and": this module drives one transport over the neural voice. It does not probe or
// download (the worker), cut text (the worker's script reply), decide what to synthesize
// (scheduler.ts), play (unitPlayer.ts, behind neuralPerformer.ts) or paint the page
// (readAlong.ts, through the callback below). Every decision is the pure `step` over a
// typed state and an event; it returns effects, and the driver `createListenPanel`
// performs them against a port, a device and a frame loop it is HANDED, so
// scripts/listen-panel-check.ts drives every state under jsdom with a stub of each
// [LAW:effects-at-boundaries] [LAW:verifiable-goals].
//
// ONE VOICE. The neural voice is the tool, and on a first listen it is a probe and a
// 239 MB download away. Until it is on stage the panel is `provisioning`: where the voice
// is on its way (`NeuralPhase`) and the place it will start from (`from`) — the top, or
// the word the reader tapped. A browser-voice stand-in spoke while the model loaded once
// (slopspot-read-along-a35.1); it went in slopspot-read-along-a35.bse: a different system
// voice per turn and a handover mid-sentence read as a defect, not a bridge.
//
// EVERY STATE THE READER CAN BE IN, SHOWN HONESTLY. `readout` maps every phase to the words
// on the status line and the shape of the two buttons, so a state with no honest sentence
// for it cannot be added without the compiler asking for one [LAW:types-are-the-program]
// [LAW:no-silent-failure]: the download and its progress, an unsupported device and its
// reason, a failed load and its failure, a crash and its message.
//
// THE TAP THAT STARTS EVERYTHING. Nothing is spawned, probed, fetched or opened until the
// reader taps Play — or taps a word on the page, which is Play with a place: a `seek` to a
// Mark. The worker bundle, the probe and the download all follow that one tap, and the tap
// IS the consent modelAssets.downloadNeedsTap asks for on a metered connection. The tap is
// also the reader's gesture, the one moment a browser lets audio start
// [LAW:no-ambient-temporal-coupling]: the `spawn` effect runs on the tap's own stack and
// opens the audio device there, so the context is unlocked long before the model is warm,
// and the first unit — scheduled from a worker message many seconds later — sounds. A Play
// tap or a seek starts the voice when idle and retries it after a failed load or a crash;
// while it is on its way, a seek only moves `from`. Costs, stated once: an unsupported
// device learns it only after the worker bundle has loaded; a download in flight cannot
// be cancelled (the protocol has no message for it).
//
// THE WORKER'S OWN DEATH. A bundle that fails to load, an exception outside the protocol:
// these arrive on the port's error channel, not as a message, and the panel answers with
// `crashed` — the performer, the device and the worker are discarded, the status names the
// failure, and the place the voice stood is kept for the retry. A panel that hangs in
// "Checking this device…" forever is the silent failure the state union exists to make
// unrepresentable [LAW:no-silent-failure].
//
// WHAT THE PANEL MIRRORS. The `neural` arm carries the scheduler's view — player position,
// manifest, holdings — as delivered by its onChange; the panel never computes a second
// opinion of it [LAW:one-source-of-truth]. The read-along cursor is derived from the
// performer's live `state()` on every animation frame while speaking: within an utterance
// the position moves with no event.
//
// [LAW:no-ambient-temporal-coupling] Events run to completion in arrival order, as in the
// scheduler: an effect's synchronous consequence (the performer's first view) is queued
// behind the event being handled, never handled inside it. The frame loop is armed and
// disarmed from the state after each event, so it runs exactly while the voice is speaking.
// The stage is a fact of the state, never of the queue's order: the step that receives
// the performer's first view is the one that enters `neural` and sends it to `from`.

import { MODEL_ASSETS, allModelAssets } from "./modelAssets";
import type { AssetProgress } from "./modelAssetLoader";
import { createNeuralPerformer, spotOf, type NeuralPerformer, type NeuralView } from "./neuralPerformer";
import { markOf, TOP, type Mark, type PerformerEvent, type PerformerState, type Spot } from "./performer";
import { turnOf, type ReadAlongAt } from "./readAlong";
import type { FailureReason } from "./scheduler";
import type { Utterance } from "./speech";
import type { WordSpan } from "./speechManifest";
import type { SynthesisUnit, VoiceMap } from "./speechScript";
import type { SynthesisPort } from "./synthesisClient";
import type { FromWorker, LoadFailure, UnsupportedReason } from "./synthesisProtocol";
import { openDevice, type DeviceFactory, type OpenDevice } from "./unitPlayer";

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

export type PanelState =
  // The voice on its way, and the place it starts from when it arrives: the top until the
  // reader taps a word.
  | { readonly kind: "provisioning"; readonly neural: NeuralPhase; readonly from: Mark }
  // The voice on stage; the view is the scheduler's.
  | { readonly kind: "neural"; readonly view: NeuralView };

export type Tap = "play" | "stop";

export type PanelEvent =
  | { readonly kind: "tap"; readonly control: Tap }
  // The reader tapped a place on the page: the voice seeks there, or starts from there.
  | { readonly kind: "seek"; readonly to: Mark }
  | { readonly kind: "worker"; readonly message: FromWorker }
  | { readonly kind: "worker-error"; readonly message: string }
  | { readonly kind: "view"; readonly view: NeuralView }
  // The page is done with the panel: everything it built is released.
  | { readonly kind: "dispose" };

export type Effect =
  // The worker and the audio device, both on the tap's stack: the gesture that unlocks audio.
  | { readonly kind: "spawn" }
  | { readonly kind: "load" }
  | { readonly kind: "script" }
  | { readonly kind: "build"; readonly units: ReadonlyArray<SynthesisUnit> }
  | { readonly kind: "perform"; readonly event: PerformerEvent }
  // Releases the performer, the device and the worker; how the worker ends is the value: a
  // dead worker is terminated, since nothing can be sent to it, a live one is asked to
  // dispose so the model is released first.
  | { readonly kind: "release"; readonly worker: "terminate" | "dispose" };

export interface Step {
  readonly state: PanelState;
  readonly effects: ReadonlyArray<Effect>;
}

// The one script the panel ever sends; a reply with another id is not ours.
export const SCRIPT_ID = 1;

const IDLE: PerformerState = { kind: "idle" };
const NEURAL_IDLE: NeuralPhase = { kind: "idle" };

export const initialState = (): PanelState => ({ kind: "provisioning", neural: NEURAL_IDLE, from: TOP });

const stay = (state: PanelState): Step => ({ state, effects: [] });
const violation = (state: PanelState, what: string): Error =>
  new Error(`listen panel: ${what} while ${state.kind === "neural" ? "the voice is on stage" : state.neural.kind}`);
// The verbs a tap can send: a seek is never a tap's.
type Verb = Exclude<PerformerEvent, { kind: "seek" }>["kind"];
const perform = (event: PerformerEvent): Effect => ({ kind: "perform", event });

// The phases in which a `progress`, `ready` or `load-failed` may arrive.
const loading = (neural: NeuralPhase): boolean =>
  neural.kind === "preparing" || neural.kind === "downloading" || neural.kind === "warming";

type Provisioning = Extract<PanelState, { kind: "provisioning" }>;
interface ProvisioningStep {
  readonly state: Provisioning;
  readonly effects: ReadonlyArray<Effect>;
}

// What a Play tap or a seek does to the voice on its way: starts it when idle, retries it
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
      return { state, effects: [perform({ kind: verb })] };
    }
    case "provisioning":
      // Stop is disabled by `readout` here; a tap that reaches it anyway changes nothing.
      return control === "stop" ? stay(state) : kick(state);
  }
};

// A tap on a place: the voice on stage seeks there; the voice on its way is started as a
// Play tap starts it, and the place is kept for its arrival.
const seek = (state: PanelState, to: Mark): Step => {
  switch (state.kind) {
    case "neural":
      return { state, effects: [perform({ kind: "seek", to })] };
    case "provisioning": {
      const kicked = kick(state);
      return { state: { ...kicked.state, from: to }, effects: kicked.effects };
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
      // The performer is built; its first view is the next event, and the step that
      // receives it takes the stage.
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
      // The scheduler's messages: nothing is synthesizing before the voice is on stage, and
      // a released worker is no longer heard.
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

// Where the voice's view says it is, as the mark a retry starts from. The last REPORT, not
// the live clock: the performer is about to be released, and a unit boundary is reported
// one hop after the clock crosses it. Cost, stated once: a crash retry resumes from the
// reported unit, at most one unit behind the ear.
const placeOf = (view: NeuralView): Mark => {
  const at = spotOf(view);
  return at.kind === "idle" ? TOP : markOf(at.at);
};

// The voice leaves the stage, or never reached it: the phase it fell to, the place kept
// for the retry, and the release of everything the tap had built.
const fallback = (state: PanelState, neural: NeuralPhase): Step => ({
  state: { kind: "provisioning", neural, from: state.kind === "provisioning" ? state.from : placeOf(state.view) },
  effects: [{ kind: "release", worker: "terminate" }],
});

export const step = (state: PanelState, event: PanelEvent): Step => {
  switch (event.kind) {
    case "tap":
      return tap(state, event.control);
    case "seek":
      return seek(state, event.to);
    case "worker":
      return fromWorker(state, event.message);
    case "worker-error":
      return fallback(state, { kind: "crashed", message: event.message });
    case "dispose":
      return { state: initialState(), effects: [{ kind: "release", worker: "dispose" }] };
    case "view": {
      if (state.kind === "neural") return stay({ ...state, view: event.view });
      if (state.neural.kind !== "scripting") throw violation(state, "a scheduler view");
      // The performer's first view: the voice takes the stage and is sent to the place the
      // tap named. The tap that started the download is the consent to play.
      return { state: { kind: "neural", view: event.view }, effects: [perform({ kind: "seek", to: state.from })] };
    }
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

// The voice's own sentence, as a fragment: one set of words for every phase
// [LAW:one-source-of-truth].
const neuralText = (neural: NeuralPhase): string => {
  switch (neural.kind) {
    case "idle":
      return `the voice downloads a ${megabytes(DOWNLOAD_BYTES)} model once, then runs on this device`;
    case "probing":
      return "checking this device for the voice…";
    case "preparing":
      return "preparing the voice…";
    case "downloading":
      return `downloading the voice · ${megabytes(neural.progress.loadedBytes)} of ${megabytes(neural.progress.totalBytes)}`;
    case "warming":
      return "warming up the voice…";
    case "scripting":
      return "preparing the script…";
    case "unsupported":
      return `this device can't run the voice: ${unsupportedText(neural.reason)}`;
    case "load-failed":
      return `the voice could not load: ${loadFailureText(neural.failure)}`;
    case "crashed":
      return `the voice failed${neural.message === "" ? "" : `: ${neural.message}`}`;
  }
};

const sentence = (fragment: string): string => fragment.charAt(0).toUpperCase() + fragment.slice(1);

const where = (utterance: number, total: number): string => `passage ${utterance + 1} of ${total}`;

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

// The transport over the voice on stage: the label follows what a tap would do.
const transport = (state: { readonly kind: PerformerState["kind"] }): Pick<Readout, "play" | "stop"> => ({
  play: { label: state.kind === "speaking" ? "Pause" : state.kind === "paused" ? "Resume" : "Listen", enabled: true },
  stop: { enabled: state.kind !== "idle" },
});

// `total` is the page's utterance count: the "of N" every position reads.
export const readout = (state: PanelState, total: number): Readout => {
  if (state.kind === "neural") {
    return { ...transport(state.view.player), status: neuralStatus(state.view, total), progress: null };
  }
  const { neural } = state;
  // On its way: the transport waits for the voice, and Play is the retry.
  const retry = neural.kind === "load-failed" || neural.kind === "crashed";
  return {
    play: { label: retry ? "Retry" : "Listen", enabled: retry || neural.kind === "idle" },
    stop: { enabled: false },
    status: sentence(neuralText(neural)),
    progress: neural.kind === "downloading" ? neural.progress : null,
  };
};

// ── the cursor ─────────────────────────────────────────────────────────────────────────

// Where the read-along is, from the performer's spot: the utterance, every utterance of
// its turn, and the cursor to paint.
export const readAlongAt = (spot: Spot, utterances: ReadonlyArray<Utterance>): ReadAlongAt => {
  const utterance = utterances[spot.utterance];
  if (utterance === undefined) throw new Error(`listen panel: the performer is at utterance ${spot.utterance} of ${utterances.length}`);
  return { utterance, turn: turnOf(utterances, utterance.anchor), segment: spot.segment, word: spot.word };
};

// Whether the voice is speaking, from the state: exactly when the frame loop runs.
const speaking = (state: PanelState): boolean => state.kind === "neural" && state.view.player.kind === "speaking";

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
  // What opens the audio device: `AudioContext` in the page. Opened by the panel on the
  // tap, closed by the panel with the worker.
  readonly Device: DeviceFactory;
  readonly frames: FrameLoop;
  // Called with where the read-along is whenever it moves, and with null when it stops.
  // This is the panel's one outward signal; the state itself is readable through `state()`.
  readonly onPosition: (at: ReadAlongAt | null) => void;
}

export interface ListenPanel {
  readonly send: (control: Tap) => void;
  // The reader tapped a place on the page.
  readonly seek: (to: Mark) => void;
  readonly state: () => PanelState;
  // Ends the listen, the device and the worker (gracefully: the model is released before
  // the worker ends); the page is left as the renderer made it, the controls show the
  // idle readout.
  readonly dispose: () => void;
}

const render = (controls: ListenControls, shown: Readout): void => {
  controls.play.textContent = shown.play.label;
  controls.play.disabled = !shown.play.enabled;
  controls.stop.disabled = !shown.stop.enabled;
  controls.status.textContent = shown.status;
  controls.progress.hidden = shown.progress === null;
  controls.progress.max = shown.progress?.totalBytes ?? 1;
  controls.progress.value = shown.progress?.loadedBytes ?? 0;
};

const sameSpan = (a: WordSpan | null, b: WordSpan | null): boolean =>
  a === b || (a !== null && b !== null && a.charStart === b.charStart && a.charEnd === b.charEnd);
const samePlace = (a: ReadAlongAt | null, b: ReadAlongAt | null): boolean =>
  a === b || (a !== null && b !== null && a.utterance === b.utterance && sameSpan(a.segment, b.segment) && sameSpan(a.word, b.word));

export const createListenPanel = (config: ListenPanelConfig): ListenPanel => {
  const { controls, frames, utterances } = config;
  // [LAW:no-shared-mutable-globals] Owned here; written only by `dispatch`, from `step`.
  let state: PanelState = initialState();
  const queue: PanelEvent[] = [];
  let draining = false;
  // The handles effects create; an effect that needs one before it exists is a bug in
  // `step`, and says so.
  const unheard = (): void => undefined;
  let port: SynthesisPort | null = null;
  let audio: OpenDevice | null = null;
  let unsubscribe: () => void = unheard;
  let unsubscribeErrors: () => void = unheard;
  let neural: NeuralPerformer | null = null;
  const portOf = (): SynthesisPort => {
    if (port === null) throw new Error("listen panel: no worker to send to");
    return port;
  };
  const audioOf = (): OpenDevice => {
    if (audio === null) throw new Error("listen panel: no audio device open");
    return audio;
  };
  const performer = (): NeuralPerformer => {
    if (neural === null) throw new Error("listen panel: no performer to drive");
    return neural;
  };

  let frame: number | null = null;
  let shown: ReadAlongAt | null = null;
  // Read live from the performer, not from the state's snapshot: within an utterance the
  // span moves with no event.
  const stageState = (): PerformerState => (state.kind === "neural" ? performer().state() : IDLE);
  const emitPosition = (): void => {
    const now = stageState();
    const at = now.kind === "idle" ? null : readAlongAt(now.at, utterances);
    if (samePlace(at, shown)) return;
    shown = at;
    config.onPosition(at);
  };
  // The loop runs exactly while the voice is speaking.
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
      case "spawn": {
        port = config.spawn();
        unsubscribe = port.subscribe((message) => dispatch({ kind: "worker", message }));
        unsubscribeErrors = port.errors((message) => dispatch({ kind: "worker-error", message }));
        // On the tap's stack: opened AND resumed inside the gesture, which is the unlock
        // every browser honours; the player's own resume, on a worker message later, is
        // then a no-op on a running context.
        const opened = openDevice(config.Device);
        void opened.device.resume();
        audio = opened;
        return;
      }
      case "load":
        portOf().send({ kind: "load" });
        return;
      case "script":
        portOf().send({ kind: "script", id: SCRIPT_ID, utterances });
        return;
      case "build": {
        const built = createNeuralPerformer({
          port: portOf(),
          device: audioOf(),
          script: effect.units,
          utterances,
          voices: config.voices,
          onChange: (view) => dispatch({ kind: "view", view }),
        });
        neural = built;
        dispatch({ kind: "view", view: built.view() });
        return;
      }
      case "perform":
        performer().send(effect.event);
        return;
      case "release": {
        // A worker can die before the performer exists (the bundle failed to load) or
        // after; either way what exists is released: the performer, then the worker, then
        // the device the performer borrowed.
        const releasing = neural;
        neural = null;
        releasing?.dispose();
        unsubscribe();
        unsubscribeErrors();
        unsubscribe = unheard;
        unsubscribeErrors = unheard;
        port?.[effect.worker]();
        port = null;
        void audio?.device.close();
        audio = null;
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
      // panel is torn down to its start — worker released, device closed — and the error
      // goes out as it is. A teardown that fails too goes out WITH it: neither failure
      // hides the other.
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

  render(controls, readout(state, utterances.length));
  controls.play.addEventListener("click", () => dispatch({ kind: "tap", control: "play" }));
  controls.stop.addEventListener("click", () => dispatch({ kind: "tap", control: "stop" }));

  return {
    send: (control) => dispatch({ kind: "tap", control }),
    seek: (to) => dispatch({ kind: "seek", to }),
    state: () => state,
    // One more event through the same machine: the idle state disarms the frame loop,
    // clears the position, and the controls say what the state says, so a page back from
    // the back-forward cache finds them right.
    dispose: () => dispatch({ kind: "dispose" }),
  };
};
