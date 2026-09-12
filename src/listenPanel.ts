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
// WHAT THE PAGE KNOWS BEFORE THE TAP. The store is asked, at mount and on every return to
// the start, what it holds of the model (modelResidency.ts): the idle status says "on this
// device" or names the bytes to download before the reader decides anything. The worker is
// spawned at mount too, so its probe — WebGPU, an adapter, 16-bit floats, a device — is
// answered before the reader hopes; a device that cannot run the voice says so on the mark
// without a tap. The load that follows a yes is also the moment the browser is asked to
// KEEP the bytes, and its answer — granted, or denied with the honest consequence — joins
// the status line [LAW:no-silent-failure]. All are facts the state carries and the readout
// projects; the driver performs the reads and feeds their answers back as events.
//
// CONSENT IS THE ONLY DOOR TO THE WEIGHTS. No byte of the model is fetched until the reader
// has said yes, and `consent` is that yes as one ordered value [LAW:types-are-the-program]:
// `none` (the worker waits in `supported`), `download` (fetch and warm the voice, then stand
// ready — the hover's yes, or the device's remembered preference through listenConsent.ts),
// `play` (fetch, warm, and speak from `from` — a Play tap, or a tap on a word, which is Play
// with a place: a `seek` to a Mark). A later word only raises it; a crash lowers `play` to
// `download` — the device the tap unlocked went with the worker, and a wake is never a yes
// to speak — and a dispose forgets it. The tap is also the reader's gesture, the one moment
// a browser lets audio start [LAW:no-ambient-temporal-coupling]: every gesture yields an
// `unlock` effect on its own stack, which opens the audio device if it is not yet open and
// resumes it there, so the context is running long before the model is warm and the first
// unit — scheduled from a worker message many seconds later — sounds. A voice that arrives
// on a standing consent is built on a device opened outside any gesture; the reader's first
// Play resumes it through the unit player, on the tap's stack. Costs, stated once: every
// reader with WebGPU spends the worker bundle on the probe; a download in flight cannot be
// cancelled (the protocol has no message for it).
//
// THE MARK. Beside the dock's launcher, one always-visible icon says where the voice is —
// on this device, a download away and how large, downloading and how far, warming,
// speaking, paused, unsupported and why, or in a store that cannot keep it — and its hover
// asks "Download speech model?" with the size when that is what stands between the reader
// and a voice. The mark is a projection of the same state as the status line: its sentence
// IS the status line, and its form is `markForm`, total over every phase, so a state with no
// form cannot be added [LAW:one-source-of-truth] [LAW:types-are-the-program].
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

import { standingConsent, type StandingConsent } from "./listenConsent";
import { MODEL_ASSETS, allModelAssets, downloadNeedsTap, type ConnectionReading } from "./modelAssets";
import type { AssetProgress } from "./modelAssetLoader";
import type { Keeping, Residency } from "./modelResidency";
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
// worker cannot see: `idle` (no worker) against `supported` (the worker's idle: probed,
// able, the weights awaiting consent), `downloading` versus `warming` (the same `progress`
// message, before and after the last byte), `scripting` (utterances sent, units not yet
// back), and the two ways it ends without a voice that a Play tap retries.
export type NeuralPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "probing" }
  | { readonly kind: "supported" }
  | { readonly kind: "preparing" }
  | { readonly kind: "downloading"; readonly progress: AssetProgress }
  | { readonly kind: "warming" }
  | { readonly kind: "scripting" }
  | { readonly kind: "unsupported"; readonly reason: UnsupportedReason }
  | { readonly kind: "load-failed"; readonly failure: LoadFailure }
  | { readonly kind: "crashed"; readonly message: string };

// What the store has said it holds of the model: asked on every entry to the start, so it is
// never a value carried across a load that changed it [LAW:one-source-of-truth].
export type Home = { readonly kind: "reading" } | Residency;

// What the reader has said about the weights so far, in the order a later word may raise
// it: nothing yet; download and warm the voice; download, warm and speak.
export type Consent = "none" | "download" | "play";
const CONSENT_ORDER: Readonly<Record<Consent, number>> = { none: 0, download: 1, play: 2 };
const raise = (held: Consent, given: Consent): Consent => (CONSENT_ORDER[given] > CONSENT_ORDER[held] ? given : held);

// The consent held is two words: `given` by the reader's own hand this visit — a tap, the
// hover's yes — which only rises; and `standing`, what the visit grants without a tap,
// replaced by each wake's reading, so an unchecked box withdraws what it alone granted and
// the reader's own yes survives it [LAW:one-source-of-truth]. The voice acts on the higher.
export interface Consents {
  readonly given: Consent;
  readonly standing: StandingConsent;
}
const NO_CONSENT: Consents = { given: "none", standing: "none" };
const granted = ({ consent }: PanelState): Consent => raise(consent.given, consent.standing);

export type PanelState =
  // The voice on its way, and the place it starts from when it arrives: the top until the
  // reader taps a word. `keeping` is the browser's answer to keeping the bytes, once asked.
  | {
      readonly kind: "provisioning";
      readonly neural: NeuralPhase;
      readonly from: Mark;
      readonly home: Home;
      readonly keeping: Keeping | null;
      readonly consent: Consents;
    }
  // The voice on stage; the view is the scheduler's, the consent kept for a fall.
  | { readonly kind: "neural"; readonly view: NeuralView; readonly consent: Consents };

export type Tap = "play" | "stop";

export type PanelEvent =
  | { readonly kind: "tap"; readonly control: Tap }
  // The reader tapped a place on the page: the voice seeks there, or starts from there.
  | { readonly kind: "seek"; readonly to: Mark }
  // The hover's yes: a gesture that consents to the download and no more.
  | { readonly kind: "yes" }
  // The page waking the panel with no gesture — at mount, on a restore from the back-forward
  // cache, when the preference changes: the worker is spawned to probe, and the visit's
  // standing consent, if any, is given.
  | { readonly kind: "wake"; readonly consent: StandingConsent }
  | { readonly kind: "worker"; readonly message: FromWorker }
  | { readonly kind: "worker-error"; readonly message: string }
  // The store's answer to `home`, and the browser's to the keep request that `load` makes.
  | { readonly kind: "home"; readonly residency: Residency }
  | { readonly kind: "keeping"; readonly keeping: Keeping }
  | { readonly kind: "view"; readonly view: NeuralView }
  // The page is done with the panel: everything it built is released.
  | { readonly kind: "dispose" };

export type Effect =
  // Asks the store what it holds of the model; answered by a `home` event.
  | { readonly kind: "home" }
  // Spawns the worker, which probes on its own.
  | { readonly kind: "spawn" }
  // The reader's gesture, spent: the audio device is opened if it is not, and resumed.
  | { readonly kind: "unlock" }
  // Sends `load`, and asks the browser to keep the bytes; answered by a `keeping` event.
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

// Every entry to the start: the voice in the given phase, the place and the consent kept,
// and the store asked afresh what it holds.
const enter = (neural: NeuralPhase, from: Mark, consent: Consents): Step => ({
  state: { kind: "provisioning", neural, from, home: { kind: "reading" }, keeping: null, consent },
  effects: [{ kind: "home" }],
});

export const initialState = (): PanelState => enter(NEURAL_IDLE, TOP, NO_CONSENT).state;
// The panel's first step: the state, and the read of the store that fills its `home`. The
// worker is not spawned here but by the `wake` that follows, so a dispose — which returns
// here — spawns nothing on a page that is going away.
export const start = (): Step => enter(NEURAL_IDLE, TOP, NO_CONSENT);

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

// Every load, first or retried: the browser is asked again to keep the bytes, so the
// answer shown is this load's, never a previous attempt's [LAW:one-source-of-truth].
const load = (state: Provisioning): ProvisioningStep => ({
  state: { ...state, neural: { kind: "preparing" }, keeping: null },
  effects: [{ kind: "load" }],
});

// What a word from the reader does to the voice on its way, once the consent it carries is
// held in the state: spawns the worker when there is none, sends the load when the worker
// is able and a yes is held, retries a failed load, and otherwise only holds the word for
// the phase that will act on it — a `capability` reads the consent, a first view reads it
// again. A device that cannot run the voice is left as it is.
const kick = (state: Provisioning): ProvisioningStep => {
  switch (state.neural.kind) {
    case "idle":
    case "crashed":
      return { state: { ...state, neural: { kind: "probing" } }, effects: [{ kind: "spawn" }] };
    case "supported":
    case "load-failed":
      return granted(state) === "none" ? { state, effects: [] } : load(state);
    case "unsupported":
    case "probing":
    case "preparing":
    case "downloading":
    case "warming":
    case "scripting":
      return { state, effects: [] };
  }
};

// A gesture is a kick with the reader's one moment of audio spent on it. There is nothing
// to unlock for a device that cannot run the voice.
const gesture = (state: Provisioning, given: Consent): ProvisioningStep => {
  if (state.neural.kind === "unsupported") return { state, effects: [] };
  const kicked = kick({ ...state, consent: { ...state.consent, given: raise(state.consent.given, given) } });
  return { state: kicked.state, effects: [{ kind: "unlock" }, ...kicked.effects] };
};

const tap = (state: PanelState, control: Tap): Step => {
  switch (state.kind) {
    case "neural": {
      const verb: Verb = control === "stop" ? "stop" : state.view.player.kind === "speaking" ? "pause" : "play";
      return { state, effects: [perform({ kind: verb })] };
    }
    case "provisioning":
      // Stop is disabled by `readout` here; a tap that reaches it anyway changes nothing.
      return control === "stop" ? stay(state) : gesture(state, "play");
  }
};

// A tap on a place: the voice on stage seeks there; the voice on its way is started as a
// Play tap starts it, and the place is kept for its arrival.
const seek = (state: PanelState, to: Mark): Step => {
  switch (state.kind) {
    case "neural":
      return { state, effects: [perform({ kind: "seek", to })] };
    case "provisioning": {
      const kicked = gesture(state, "play");
      return { state: { ...kicked.state, from: to }, effects: kicked.effects };
    }
  }
};

// The hover's yes, and the page's wake: the same kick, with and without a gesture. A voice
// on stage has nothing left to consent to, and keeps the visit's standing word for a fall.
const yes = (state: PanelState): Step => (state.kind === "provisioning" ? gesture(state, "download") : stay(state));
const wake = (state: PanelState, standing: StandingConsent): Step => {
  const told: PanelState = { ...state, consent: { ...state.consent, standing } };
  return told.kind === "provisioning" ? kick(told) : stay(told);
};

const provision = (state: Provisioning, message: FromWorker): Step => {
  const { neural } = state;
  const phase = (next: NeuralPhase, effects: ReadonlyArray<Effect> = []): Step => ({ state: { ...state, neural: next }, effects });
  switch (message.kind) {
    case "capability":
      if (neural.kind !== "probing") throw violation(state, "capability");
      // An able device loads on the consent held, or waits for one; the weights are never
      // fetched on the probe alone.
      return message.support.kind !== "supported"
        ? phase({ kind: "unsupported", reason: message.support.reason }, [{ kind: "release", worker: "terminate" }])
        : granted(state) === "none"
          ? phase({ kind: "supported" })
          : load(state);
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

// The voice leaves the stage, or never reached it: the phase it fell to, the place kept for
// the retry, the consent it keeps, and the release of everything that had been built. The
// yes to the weights outlives the crash; the yes to speak does not, since the device that
// tap unlocked is released here — a Retry tap gives it again on its own stack, and a voice
// that fell mid-word then comes back speaking there, while a wake brings it back standing.
const outlives = (consent: Consents): Consents => ({ ...consent, given: consent.given === "none" ? "none" : "download" });
const fallback = (state: PanelState, neural: NeuralPhase): Step => {
  const entered = enter(neural, state.kind === "provisioning" ? state.from : placeOf(state.view), outlives(state.consent));
  return { state: entered.state, effects: [{ kind: "release", worker: "terminate" }, ...entered.effects] };
};

// The two answers the driver feeds back. A late answer to a voice already on stage — the
// store answering after a whole load — has nothing to update.
const home = (state: PanelState, residency: Residency): Step =>
  state.kind === "provisioning" ? stay({ ...state, home: residency }) : stay(state);
const keeping = (state: PanelState, answer: Keeping): Step =>
  state.kind === "provisioning" ? stay({ ...state, keeping: answer }) : stay(state);

export const step = (state: PanelState, event: PanelEvent): Step => {
  switch (event.kind) {
    case "tap":
      return tap(state, event.control);
    case "seek":
      return seek(state, event.to);
    case "yes":
      return yes(state);
    case "wake":
      return wake(state, event.consent);
    case "worker":
      return fromWorker(state, event.message);
    case "worker-error":
      return fallback(state, { kind: "crashed", message: event.message });
    case "home":
      return home(state, event.residency);
    case "keeping":
      return keeping(state, event.keeping);
    case "dispose": {
      const started = start();
      return { state: started.state, effects: [{ kind: "release", worker: "dispose" }, ...started.effects] };
    }
    case "view": {
      if (state.kind === "neural") return stay({ ...state, view: event.view });
      if (state.neural.kind !== "scripting") throw violation(state, "a scheduler view");
      // The performer's first view: the voice takes the stage, and is sent to the place the
      // tap named when a tap is what brought it — a download alone leaves it standing ready.
      return {
        state: { kind: "neural", view: event.view, consent: state.consent },
        effects: granted(state) === "play" ? [perform({ kind: "seek", to: state.from })] : [],
      };
    }
  }
};

// ── the readout ────────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] The mark's forms: one for every place the voice can be, as
// the reader sees them. `downloading` carries how far, for the ring; the sizes, reasons and
// positions each form would name ride the sentence beside it (`Readout.status`), so the
// form and the sentence are one state read twice, never two states kept in step.
export type MarkForm =
  | { readonly kind: "checking" }
  | { readonly kind: "ready" }
  | { readonly kind: "download" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "downloading"; readonly fraction: number }
  | { readonly kind: "warming" }
  | { readonly kind: "speaking" }
  | { readonly kind: "paused" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed" };

// What the visit knows that the machine does not decide on: the device's remembered
// preference (read from storage at every render, never copied) and whether the connection
// is one the standing consent must not act on.
export interface Visit {
  readonly remembered: boolean;
  readonly metered: boolean;
}

// What the panel shows: the two buttons' shape, the status sentence, the download when
// there is one, and the mark — its form, the question its hover asks when a download
// stands between the reader and the voice, and the preference's box. A pure projection of
// the state and the visit, so the check reads it directly.
export interface Readout {
  readonly play: { readonly label: string; readonly enabled: boolean };
  readonly stop: { readonly enabled: boolean };
  readonly status: string;
  readonly progress: AssetProgress | null;
  readonly mark: MarkForm;
  readonly ask: string | null;
  readonly remembered: boolean;
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

// Where the voice is before the tap, from the store's word. `absent` names the bytes still
// to download — the whole model, or the part an eviction or an interrupted listen left out.
const homeText = (home: Home): string => {
  switch (home.kind) {
    case "reading":
      return "looking for the voice on this device…";
    case "resident":
      return "the voice is on this device";
    case "absent":
      return `the voice downloads ${megabytes(home.bytesToDownload)} once, then runs on this device`;
    case "unavailable":
      return `this browser can't keep the voice (${home.message}); each listen downloads ${megabytes(DOWNLOAD_BYTES)}`;
  }
};

// The browser's answer to keeping the bytes, with the consequence of a denial spelled out.
const keepingText = (keeping: Keeping): string => {
  switch (keeping.kind) {
    case "granted":
      return "this browser will keep the voice";
    case "denied":
      return "this browser may drop the voice when space is short; the next listen would download it again";
    case "failed":
      return `this browser could not be asked to keep the voice: ${keeping.message}`;
  }
};

// The voice's own sentence, as a fragment: one set of words for every phase
// [LAW:one-source-of-truth].
const neuralText = (neural: NeuralPhase, home: Home): string => {
  switch (neural.kind) {
    case "idle":
    case "supported":
      return homeText(home);
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

// The store's word as a form: before the probe has answered, the store's word is the
// mark's, since only a `no` from the probe changes it.
const homeForm = (home: Home): MarkForm => {
  switch (home.kind) {
    case "reading":
      return { kind: "checking" };
    case "resident":
      return { kind: "ready" };
    case "absent":
      return { kind: "download" };
    case "unavailable":
      return { kind: "unavailable" };
  }
};

// [LAW:dataflow-not-control-flow] Total over every phase and every player state: the one
// derivation of the mark's form.
export const markForm = (state: PanelState): MarkForm => {
  if (state.kind === "neural") {
    const { player } = state.view;
    return player.kind === "idle" ? { kind: "ready" } : { kind: player.kind };
  }
  const { neural } = state;
  switch (neural.kind) {
    case "idle":
    case "probing":
    case "supported":
      // A held consent through the probe is a voice on its way: the ask would be answered.
      return granted(state) === "none" ? homeForm(state.home) : { kind: "warming" };
    case "preparing":
    case "warming":
    case "scripting":
      return { kind: "warming" };
    case "downloading":
      return { kind: "downloading", fraction: neural.progress.loadedBytes / neural.progress.totalBytes };
    case "unsupported":
      return { kind: "unsupported" };
    case "load-failed":
    case "crashed":
      return { kind: "failed" };
  }
};

// The hover's question, when a download is what the reader is deciding: the size, and —
// when the remembered yes is being overridden — why it asks anyway. The store that cannot
// keep the voice asks for the whole model every time.
const askText = (state: PanelState, form: MarkForm, visit: Visit): string | null => {
  const bytes =
    form.kind === "download" && state.kind === "provisioning" && state.home.kind === "absent"
      ? state.home.bytesToDownload
      : form.kind === "unavailable"
        ? DOWNLOAD_BYTES
        : null;
  if (bytes === null) return null;
  const why = visit.remembered && visit.metered ? [" · asking because this connection is metered"] : [];
  return [`Download speech model? · ${megabytes(bytes)}`, ...why].join("");
};

// `total` is the page's utterance count: the "of N" every position reads.
export const readout = (state: PanelState, total: number, visit: Visit): Readout => {
  const mark = markForm(state);
  const ask = askText(state, mark, visit);
  const { remembered } = visit;
  if (state.kind === "neural") {
    return { ...transport(state.view.player), status: neuralStatus(state.view, total), progress: null, mark, ask, remembered };
  }
  const { neural } = state;
  // On its way: Play is the retry after a failure, and otherwise the word that raises the
  // consent to `play` — so it has nothing to say once that word is held, and nothing on a
  // device that cannot run the voice.
  const retry = neural.kind === "load-failed" || neural.kind === "crashed";
  const fragments = [neuralText(neural, state.home), ...(state.keeping === null ? [] : [keepingText(state.keeping)])];
  return {
    play: { label: retry ? "Retry" : "Listen", enabled: retry || (neural.kind !== "unsupported" && granted(state) !== "play") },
    stop: { enabled: false },
    status: sentence(fragments.join(" · ")),
    progress: neural.kind === "downloading" ? neural.progress : null,
    mark,
    ask,
    remembered,
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

// The mark's markup: the root carries the form (`data-state`), the ring's fraction and
// whether the hover is pinned open; the button is what the reader hovers, focuses or taps;
// the hover holds the sentence, the question, the yes and the preference's box.
export interface MarkControls {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly sentence: HTMLElement;
  readonly ask: HTMLElement;
  readonly yes: HTMLButtonElement;
  readonly remember: HTMLInputElement;
}

export interface ListenControls {
  readonly play: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly progress: HTMLProgressElement;
  readonly mark: MarkControls;
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
  // The store's word on the model, and the browser's on keeping it: modelResidency's two
  // edges over the real store and navigator.storage.persist in the page, stubs in the check.
  readonly home: () => Promise<Residency>;
  readonly keep: () => Promise<Keeping>;
  // The device's remembered preference, read at every render and written by the hover's
  // box: listenConsent's two edges over window.localStorage in the page, over a Map in the
  // check. And the connection reading the metered rule judges: navigator.connection, which
  // only Chromium exposes; absent is honestly "unknown".
  readonly preference: { readonly read: () => boolean; readonly write: (remembered: boolean) => void };
  readonly connection: () => ConnectionReading | undefined;
  // What opens the audio device: `AudioContext` in the page. Opened by the panel on the
  // first gesture or the first build, whichever comes first; closed with the worker.
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
  // The page is back: a restore from the back-forward cache after the pagehide that
  // disposed. The worker is spawned to probe again and the standing consent given again,
  // as at mount.
  readonly wake: () => void;
  readonly state: () => PanelState;
  // Ends the listen, the device and the worker (gracefully: the model is released before
  // the worker ends); the page is left as the renderer made it, the controls show the
  // idle readout.
  readonly dispose: () => void;
}

// [LAW:dataflow-not-control-flow] Every attribute written on every render, only the values
// vary: no path leaves a stale form, a stale sentence or a stale ring behind.
const render = (controls: ListenControls, shown: Readout): void => {
  controls.play.textContent = shown.play.label;
  controls.play.disabled = !shown.play.enabled;
  controls.stop.disabled = !shown.stop.enabled;
  controls.status.textContent = shown.status;
  controls.progress.hidden = shown.progress === null;
  controls.progress.max = shown.progress?.totalBytes ?? 1;
  controls.progress.value = shown.progress?.loadedBytes ?? 0;
  const { mark } = controls;
  mark.root.dataset.state = shown.mark.kind;
  mark.root.style.setProperty("--fraction", String(shown.mark.kind === "downloading" ? shown.mark.fraction : 0));
  // The sentence names the mark for assistive tech, and is the hover's first line.
  mark.button.setAttribute("aria-label", `Listen: ${shown.status}`);
  mark.sentence.textContent = shown.status;
  mark.ask.textContent = shown.ask ?? "";
  mark.ask.hidden = shown.ask === null;
  mark.yes.hidden = shown.ask === null;
  mark.remember.checked = shown.remembered;
};

const sameSpan = (a: WordSpan | null, b: WordSpan | null): boolean =>
  a === b || (a !== null && b !== null && a.charStart === b.charStart && a.charEnd === b.charEnd);
const samePlace = (a: ReadAlongAt | null, b: ReadAlongAt | null): boolean =>
  a === b || (a !== null && b !== null && a.utterance === b.utterance && sameSpan(a.segment, b.segment) && sameSpan(a.word, b.word));

// The answer to the latest ask only: an ask superseded or dropped before it settles is not
// delivered.
const latest = <T,>(deliver: (value: T) => void): { ask: (pending: Promise<T>) => void; drop: () => void } => {
  let live: Promise<T> | null = null;
  return {
    ask: (pending) => {
      live = pending;
      void pending.then((value) => {
        if (live === pending) deliver(value);
      });
    },
    drop: () => {
      live = null;
    },
  };
};

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
  // The device, opened on first use: by a gesture's `unlock`, on the tap's stack, or by a
  // `build` that a standing consent brought about with no tap — in which case it opens
  // suspended, and the reader's first Play resumes it through the unit player.
  const device = (): OpenDevice => (audio ??= openDevice(config.Device));
  const performer = (): NeuralPerformer => {
    if (neural === null) throw new Error("listen panel: no performer to drive");
    return neural;
  };
  // [LAW:no-ambient-temporal-coupling] One ask of each kind in flight, owned here: a new ask
  // supersedes the old, and only the current ask's answer is dispatched. The order two
  // promises settle in cannot put a stale store or browser answer over a fresh entry.
  const askHome = latest<Residency>((residency) => dispatch({ kind: "home", residency }));
  const askKeep = latest<Keeping>((keeping) => dispatch({ kind: "keeping", keeping }));

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
      case "home":
        askHome.ask(config.home());
        return;
      case "spawn":
        port = config.spawn();
        unsubscribe = port.subscribe((message) => dispatch({ kind: "worker", message }));
        unsubscribeErrors = port.errors((message) => dispatch({ kind: "worker-error", message }));
        return;
      case "unlock":
        // On the gesture's stack: opened AND resumed inside it, which is the unlock every
        // browser honours; the player's own resume, on a worker message later, is then a
        // no-op on a running context.
        void device().device.resume();
        return;
      case "load":
        portOf().send({ kind: "load" });
        askKeep.ask(config.keep());
        return;
      case "script":
        portOf().send({ kind: "script", id: SCRIPT_ID, utterances });
        return;
      case "build": {
        const built = createNeuralPerformer({
          port: portOf(),
          device: device(),
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
        // The keep request belonged to the load the released worker was doing.
        askKeep.drop();
        return;
      }
    }
  };

  // The visit as it is now: the preference from storage, the connection from the browser.
  const visit = (): Visit => ({ remembered: config.preference.read(), metered: downloadNeedsTap(config.connection()) });
  const show = (): void => render(controls, readout(state, utterances.length, visit()));

  const run = (event: PanelEvent): void => {
    const planned = step(state, event);
    state = planned.state;
    for (const effect of planned.effects) performEffect(effect);
    show();
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

  // [LAW:single-enforcer] The one reading of what the visit grants without a tap, given
  // to the machine at mount, on a restore, and when the preference changes.
  const wakeUp = (): void => dispatch({ kind: "wake", consent: standingConsent(config.preference.read(), config.connection()) });

  // The first step, performed like every other: the state shown, the store asked.
  for (const effect of start().effects) performEffect(effect);
  show();
  controls.play.addEventListener("click", () => dispatch({ kind: "tap", control: "play" }));
  controls.stop.addEventListener("click", () => dispatch({ kind: "tap", control: "stop" }));

  // The hover: shown by hover in CSS, the sighted reader's affordance, and pinned here —
  // for the touch reader's tap and the keyboard reader's focus, and told to assistive
  // tech as one fact — until a tap outside, focus leaving, or Escape. A tap pins rather
  // than toggles: most browsers focus the button before the click, so a toggle would close
  // what the focus just opened. Whether it is pinned is a fact of the markup alone, owned
  // here: the machine has no state for it [LAW:one-source-of-truth].
  const { mark } = controls;
  const pin = (open: boolean): void => {
    mark.root.dataset.open = String(open);
    mark.button.setAttribute("aria-expanded", String(open));
  };
  pin(false);
  mark.button.addEventListener("click", () => pin(true));
  mark.yes.addEventListener("click", () => dispatch({ kind: "yes" }));
  // Checking the box is the yes for this visit too, subject to the same rule as any
  // standing consent; unchecking only stops asking on the reader's behalf.
  mark.remember.addEventListener("change", () => {
    config.preference.write(mark.remember.checked);
    wakeUp();
  });
  const doc = mark.root.ownerDocument;
  doc.addEventListener("click", (event) => {
    if (event.composedPath().includes(mark.root)) return;
    pin(false);
  });
  // Every focus on the page sets the pin: inside the mark it is open, anywhere else it is
  // not [LAW:dataflow-not-control-flow].
  doc.addEventListener("focusin", (event) => pin(event.composedPath().includes(mark.root)));
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape") pin(false);
  });
  wakeUp();

  return {
    send: (control) => dispatch({ kind: "tap", control }),
    seek: (to) => dispatch({ kind: "seek", to }),
    // The page's door back in: the hover closed as at mount, then the wake.
    wake: () => {
      pin(false);
      wakeUp();
    },
    state: () => state,
    // One more event through the same machine: the idle state disarms the frame loop,
    // clears the position, and the controls say what the state says, so a page back from
    // the back-forward cache finds them right.
    dispose: () => dispatch({ kind: "dispose" }),
  };
};
