// [LAW:decomposition] The neural Listen panel: it takes the reader from a Play tap to
// audio in the neural voice and shows, at every moment, which of the states between the
// two they are in. One sentence, no "and": this module drives the synthesis pipeline from
// the panel's two buttons. It does not probe or download (the worker), cut text (the
// worker's script reply), decide what to synthesize (scheduler.ts), play (unitPlayer.ts)
// or paint the page (readAlong.ts, through the callback below). Every decision is the pure
// `step` over a typed state and an event; it returns effects, the driver `createListenPanel`
// performs them against a port, a device and a frame loop it is HANDED, so
// scripts/listen-panel-check.ts drives every state under jsdom with a stub of each
// [LAW:effects-at-boundaries] [LAW:verifiable-goals].
//
// EVERY STATE THE READER CAN BE IN, SHOWN HONESTLY. The union below is the panel's whole
// life, and `readout` maps each arm to the words on the status line and the shape of the
// two buttons — so a state with no honest sentence for it cannot be added without the
// compiler asking for one [LAW:types-are-the-program] [LAW:no-silent-failure]. The worker's
// own phases are a line (probing → unsupported | idle → loading → ready); the panel's
// states follow it one for one and add what the worker cannot see: `downloading` versus
// `warming` (the same `progress` message, before and after the last byte), `scripting`
// (utterances sent, units not yet back) and `listening`, where the view is the
// scheduler's and the player's flow says whether audio is playing or being synthesized.
//
// THE TAP THAT STARTS EVERYTHING. Nothing is spawned, probed or fetched until the reader
// taps Play: the worker bundle, the probe and the 239 MB download all follow one tap, and
// the tap IS the consent modelAssets.downloadNeedsTap asks for on a metered connection.
// Costs, stated once: an unsupported device learns it only after the worker bundle has
// loaded; a download in flight cannot be cancelled (the protocol has no message for it),
// so Stop is disabled until there is a player to stop.
//
// THE WORKER'S OWN DEATH. A bundle that fails to load, an exception outside the protocol:
// these arrive on the port's error channel, not as a message, and the panel answers with
// `crashed` — the worker and the scheduler are discarded, the status names the failure,
// and Play reads Retry, which spawns a fresh worker. A panel that hangs in "Checking this
// device…" forever is the silent failure the state union exists to make unrepresentable
// [LAW:no-silent-failure].
//
// WHAT THE PANEL MIRRORS. `listening` carries the scheduler's view — player position,
// manifest, holdings — as delivered by its onChange; the panel never computes a second
// opinion of any of them [LAW:one-source-of-truth]. The read-along cursor is derived from
// that view on every animation frame while speaking: the position from the player, the
// span from the manifest's record through `cursorAt`, or the unit's own span while the
// record does not exist yet (waiting on synthesis). A guess never looks like a measurement.
//
// [LAW:no-ambient-temporal-coupling] Events run to completion in arrival order, as in the
// scheduler: an effect's synchronous consequence (the scheduler's first onChange, raised
// inside `build`) is queued behind the event being handled, never handled inside it. The
// frame loop is armed and disarmed from the state after each event, so it runs exactly
// while the player is speaking.

import { MODEL_ASSETS, allModelAssets } from "./modelAssets";
import type { AssetProgress } from "./modelAssetLoader";
import { createScheduler, type FailureReason, type Scheduler, type SchedulerView } from "./scheduler";
import type { Utterance } from "./speech";
import { cursorAt, type WordSpan } from "./speechManifest";
import type { SynthesisUnit, VoiceMap } from "./speechScript";
import type { SynthesisPort } from "./synthesisClient";
import type { FromWorker, LoadFailure, UnsupportedReason } from "./synthesisProtocol";
import { createUnitPlayer, type DeviceFactory } from "./unitPlayer";
import type { ReadAlongAt } from "./readAlong";

// ── state ──────────────────────────────────────────────────────────────────────────────

export type PanelState =
  | { readonly kind: "idle" }
  | { readonly kind: "probing" }
  | { readonly kind: "unsupported"; readonly reason: UnsupportedReason }
  | { readonly kind: "preparing" }
  | { readonly kind: "downloading"; readonly progress: AssetProgress }
  | { readonly kind: "warming" }
  | { readonly kind: "load-failed"; readonly failure: LoadFailure }
  | { readonly kind: "scripting" }
  // `passages` is computed once on entry, from the script the view carries: the script is
  // fixed for the scheduler's life, and the cursor reads it on every animation frame.
  | { readonly kind: "listening"; readonly view: SchedulerView; readonly passages: ReadonlyArray<Utterance> }
  | { readonly kind: "crashed"; readonly message: string };

export type Tap = "play" | "stop";

export type PanelEvent =
  | { readonly kind: "tap"; readonly control: Tap }
  | { readonly kind: "worker"; readonly message: FromWorker }
  | { readonly kind: "worker-error"; readonly message: string }
  | { readonly kind: "view"; readonly view: SchedulerView }
  // The page is done with the panel: everything it built is released.
  | { readonly kind: "dispose" };

export type Effect =
  | { readonly kind: "spawn" }
  | { readonly kind: "load" }
  | { readonly kind: "script" }
  | { readonly kind: "build"; readonly units: ReadonlyArray<SynthesisUnit> }
  | { readonly kind: "control"; readonly control: "play" | "pause" | "stop" }
  // Releases the scheduler and the worker; how the worker ends is the value: a dead worker
  // is terminated, since nothing can be sent to it, a live one is asked to dispose so the
  // model is released first. The device is closed through the scheduler's own dispose.
  | { readonly kind: "release"; readonly worker: "terminate" | "dispose" };

export interface Step {
  readonly state: PanelState;
  readonly effects: ReadonlyArray<Effect>;
}

// The one script the panel ever sends; a reply with another id is not ours.
export const SCRIPT_ID = 1;

const IDLE: PanelState = { kind: "idle" };
const stay = (state: PanelState): Step => ({ state, effects: [] });
const violation = (state: PanelState, what: string): Error => new Error(`listen panel: ${what} while ${state.kind}`);

// The states in which a `progress`, `ready` or `load-failed` may arrive.
const loading = (state: PanelState): boolean =>
  state.kind === "preparing" || state.kind === "downloading" || state.kind === "warming";

const tap = (state: PanelState, control: Tap): Step => {
  if (control === "stop") return state.kind === "listening" ? { state, effects: [{ kind: "control", control: "stop" }] } : stay(state);
  switch (state.kind) {
    case "idle":
    case "crashed":
      return { state: { kind: "probing" }, effects: [{ kind: "spawn" }] };
    case "load-failed":
      return { state: { kind: "preparing" }, effects: [{ kind: "load" }] };
    case "listening":
      return { state, effects: [{ kind: "control", control: state.view.player.kind === "speaking" ? "pause" : "play" }] };
    default:
      // Play is disabled by `readout` in every other state; a tap that reaches here anyway
      // changes nothing, and the same reference says so.
      return stay(state);
  }
};

const fromWorker = (state: PanelState, message: FromWorker): Step => {
  switch (message.kind) {
    case "capability":
      if (state.kind !== "probing") throw violation(state, "capability");
      return message.support.kind === "supported"
        ? { state: { kind: "preparing" }, effects: [{ kind: "load" }] }
        : stay({ kind: "unsupported", reason: message.support.reason });
    case "progress":
      if (!loading(state)) throw violation(state, "progress");
      return stay(
        message.progress.loadedBytes < message.progress.totalBytes
          ? { kind: "downloading", progress: message.progress }
          : { kind: "warming" },
      );
    case "ready":
      if (!loading(state)) throw violation(state, "ready");
      return { state: { kind: "scripting" }, effects: [{ kind: "script" }] };
    case "load-failed":
      if (!loading(state)) throw violation(state, "load-failed");
      return stay({ kind: "load-failed", failure: message.failure });
    case "script":
      if (state.kind !== "scripting") throw violation(state, "script");
      if (message.id !== SCRIPT_ID) throw new Error(`listen panel: script reply ${message.id}, sent ${SCRIPT_ID}`);
      // The reader tapped Play to hear it: the scheduler is built and told to play in one
      // plan. Its first view arrives as the next event and is what enters `listening`.
      return { state, effects: [{ kind: "build", units: message.units }, { kind: "control", control: "play" }] };
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
      // The scheduler's messages, on the port the panel also hears. Not ours to act on.
      return stay(state);
  }
};

export const step = (state: PanelState, event: PanelEvent): Step => {
  switch (event.kind) {
    case "tap":
      return tap(state, event.control);
    case "worker":
      return fromWorker(state, event.message);
    case "worker-error":
      return { state: { kind: "crashed", message: event.message }, effects: [{ kind: "release", worker: "terminate" }] };
    case "dispose":
      return { state: IDLE, effects: [{ kind: "release", worker: "dispose" }] };
    case "view":
      switch (state.kind) {
        case "scripting":
          return stay({ kind: "listening", view: event.view, passages: passages(event.view.manifest.script) });
        case "listening":
          return stay({ kind: "listening", view: event.view, passages: state.passages });
        default:
          throw violation(state, "a scheduler view");
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

// Passages are utterances: the script holds each utterance by reference across its
// units, so a passage boundary is where the reference changes.
export const passages = (script: ReadonlyArray<SynthesisUnit>): ReadonlyArray<Utterance> =>
  script.flatMap((unit, i) => (unit.utterance === script[i - 1]?.utterance ? [] : [unit.utterance]));

const unitAt = (view: SchedulerView, unitIndex: number): SynthesisUnit => {
  const unit = view.manifest.script[unitIndex];
  if (unit === undefined) throw new Error(`listen panel: the player is at unit ${unitIndex} of ${view.manifest.script.length}`);
  return unit;
};

const listeningStatus = (view: SchedulerView, all: ReadonlyArray<Utterance>): string => {
  const where = (unitIndex: number): string => `passage ${all.indexOf(unitAt(view, unitIndex).utterance) + 1} of ${all.length}`;
  const skipped = view.holdings.flatMap((holding, i) =>
    holding.kind === "failed" ? [`${where(i)} could not be synthesized: ${unitFailureText(holding.reason)}`] : [],
  );
  const { player } = view;
  const now =
    player.kind === "idle"
      ? "Ready"
      : player.kind === "paused"
        ? `Paused · ${where(player.at.unitIndex)}`
        : player.flow === "audio"
          ? `Playing · ${where(player.at.unitIndex)}`
          : `Synthesizing ahead… · ${where(player.at.unitIndex)}`;
  return [now, ...skipped].join(" · ");
};

export const readout = (state: PanelState): Readout => {
  const off = { enabled: false };
  switch (state.kind) {
    case "idle":
      return {
        play: { label: "Listen", enabled: true },
        stop: off,
        status: `Neural voice · downloads a ${megabytes(DOWNLOAD_BYTES)} model once, then runs on this device`,
        progress: null,
      };
    case "probing":
      return { play: { label: "Listen", enabled: false }, stop: off, status: "Checking this device…", progress: null };
    case "unsupported":
      return {
        play: { label: "Listen", enabled: false },
        stop: off,
        status: `This device can't run the neural voice: ${unsupportedText(state.reason)}.`,
        progress: null,
      };
    case "preparing":
      return { play: { label: "Listen", enabled: false }, stop: off, status: "Preparing the voice model…", progress: null };
    case "downloading":
      return {
        play: { label: "Listen", enabled: false },
        stop: off,
        status: `Downloading the voice model · ${megabytes(state.progress.loadedBytes)} of ${megabytes(state.progress.totalBytes)}`,
        progress: state.progress,
      };
    case "warming":
      return { play: { label: "Listen", enabled: false }, stop: off, status: "Warming up the model…", progress: null };
    case "load-failed":
      return {
        play: { label: "Retry", enabled: true },
        stop: off,
        status: `The voice model could not load: ${loadFailureText(state.failure)}`,
        progress: null,
      };
    case "scripting":
      return { play: { label: "Listen", enabled: false }, stop: off, status: "Preparing the script…", progress: null };
    case "listening": {
      const { player } = state.view;
      return {
        play: { label: player.kind === "speaking" ? "Pause" : player.kind === "paused" ? "Resume" : "Listen", enabled: true },
        stop: { enabled: player.kind !== "idle" },
        status: listeningStatus(state.view, state.passages),
        progress: null,
      };
    }
    case "crashed":
      return {
        play: { label: "Retry", enabled: true },
        stop: off,
        status: `The neural voice worker failed${state.message === "" ? "" : `: ${state.message}`}`,
        progress: null,
      };
  }
};

// ── the cursor ─────────────────────────────────────────────────────────────────────────

// Where the read-along is, from a view: nothing while idle; otherwise the unit under the
// player and the span to paint — the manifest's cursor when the unit has a record, the
// unit's whole span while it is still being synthesized.
export const readAlongAt = (view: SchedulerView, passages: ReadonlyArray<Utterance>): ReadAlongAt | null => {
  const { player } = view;
  if (player.kind === "idle") return null;
  const unit = unitAt(view, player.at.unitIndex);
  const record = view.manifest.units[player.at.unitIndex];
  const span: WordSpan = record === undefined ? { charStart: unit.start, charEnd: unit.end } : cursorAt(record, player.at.offsetMs);
  const turn = passages.filter((utterance) => utterance.anchor === unit.utterance.anchor);
  return { utterance: unit.utterance, turn, span };
};

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
  // Called with where the read-along is whenever it moves, and with null when it stops.
  // This is the panel's one outward signal; the state itself is readable through `state()`.
  readonly onPosition: (at: ReadAlongAt | null) => void;
}

export interface ListenPanel {
  readonly send: (control: Tap) => void;
  readonly state: () => PanelState;
  // Ends the listen and the worker (gracefully: the model is released before the worker
  // ends); the page is left as the renderer made it, the controls show the idle readout.
  readonly dispose: () => void;
}

// Which role the six hosted voices speak. A VALUE, per the epic: the reader's pick by ear
// replaces it without touching an asset. Until that pick, the spike's word-accuracy
// ranking chooses — the voices Whisper transcribed with zero errors take the roles that
// say the most.
export const DEFAULT_VOICES: VoiceMap = { user: "alba", assistant: "javert", system: "eponine", narrator: "azelma" };

const render = (controls: ListenControls, state: PanelState): void => {
  const shown = readout(state);
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
  const { controls, frames } = config;
  // [LAW:no-shared-mutable-globals] Owned here; written only by `dispatch`, from `step`.
  let state: PanelState = IDLE;
  const queue: PanelEvent[] = [];
  let draining = false;
  // The two handles effects create; an effect that needs one before it exists is a bug in
  // `step`, and says so.
  const unheard = (): void => undefined;
  let port: SynthesisPort | null = null;
  let unsubscribe: () => void = unheard;
  let unsubscribeErrors: () => void = unheard;
  let scheduler: Scheduler | null = null;
  const portOf = (): SynthesisPort => {
    if (port === null) throw new Error("listen panel: no worker to send to");
    return port;
  };
  const schedulerOf = (): Scheduler => {
    if (scheduler === null) throw new Error("listen panel: no scheduler to control");
    return scheduler;
  };

  let frame: number | null = null;
  let shown: ReadAlongAt | null = null;
  // Read from the scheduler, not the `listening` snapshot: within a unit the clock moves
  // with no event, and `view()` derives the position from the clock on every call.
  const emitPosition = (): void => {
    const at = state.kind === "listening" ? readAlongAt(schedulerOf().view(), state.passages) : null;
    if (samePlace(at, shown)) return;
    shown = at;
    config.onPosition(at);
  };
  // The loop runs exactly while the player is speaking: within a unit the clock moves
  // without any event, so the cursor is re-read each frame.
  const syncFrames = (): void => {
    const speaking = state.kind === "listening" && state.view.player.kind === "speaking";
    if (speaking && frame === null) {
      frame = frames.request(() => {
        frame = null;
        emitPosition();
        syncFrames();
      });
    }
    if (!speaking && frame !== null) {
      frames.cancel(frame);
      frame = null;
    }
  };

  const perform = (effect: Effect): void => {
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
        portOf().send({ kind: "script", id: SCRIPT_ID, utterances: config.utterances });
        return;
      case "build": {
        // [LAW:no-ambient-temporal-coupling] A view is the live scheduler's or nobody's: the
        // last view a released scheduler raises from its own dispose never reaches `step`.
        const built = createScheduler({
          port: portOf(),
          script: effect.units,
          voices: config.voices,
          player: (playerConfig) => createUnitPlayer({ ...playerConfig, Device: config.Device }),
          onChange: (view) => {
            if (scheduler === built) dispatch({ kind: "view", view });
          },
        });
        scheduler = built;
        dispatch({ kind: "view", view: built.view() });
        return;
      }
      case "control":
        schedulerOf().send({ kind: effect.control });
        return;
      case "release": {
        // A worker can die before the scheduler exists (the bundle failed to load) or after;
        // either way what exists is released. The scheduler is unhooked before it is disposed.
        const releasing = scheduler;
        scheduler = null;
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

  const dispatch = (event: PanelEvent): void => {
    queue.push(event);
    if (draining) return;
    draining = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const planned = step(state, next);
        state = planned.state;
        for (const effect of planned.effects) perform(effect);
        render(controls, state);
        syncFrames();
        emitPosition();
      }
    } finally {
      draining = false;
    }
  };

  render(controls, state);
  controls.play.addEventListener("click", () => dispatch({ kind: "tap", control: "play" }));
  controls.stop.addEventListener("click", () => dispatch({ kind: "tap", control: "stop" }));

  return {
    send: (control) => dispatch({ kind: "tap", control }),
    state: () => state,
    // One more event through the same machine: idle disarms the frame loop, clears the
    // position, and the controls say what the state says, so a page back from the
    // back-forward cache finds them right.
    dispose: () => dispatch({ kind: "dispose" }),
  };
};
