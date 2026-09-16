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
// 239 MB download away. Until it is on stage the panel is `provisioning`: where the model
// is on its way (`ModelPhase`), the script the voice will be built over (`Script`), and the
// place it will start from (`cue`) — the top when nobody has named one, or the word the
// reader tapped. The model's phase rides the stage too: a voice can take the stage before
// its model is warm (THE KEPT AUDIO), so where the model is and whether a voice is on stage
// are two facts, never one. A browser-voice stand-in spoke while the model loaded once
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
// ready — the mini-player's yes, or the device's remembered preference through listenConsent.ts),
// `play` (fetch, warm, and speak from `from` — a Play tap, or a tap on a word, which is Play
// with a place: a `seek` to a Place). A later word only raises it; a crash lowers `play` to
// `download` — the device the tap unlocked went with the worker, and a wake is never a yes
// to speak — and a dispose forgets it. The tap is also the reader's gesture, the one moment
// a browser lets audio start [LAW:no-ambient-temporal-coupling]: a gesture on an able device
// yields an `unlock` effect on its own stack, which opens the audio device if not yet open and
// resumes it there, so the context is running long before the model is warm and the first
// unit — scheduled from a worker message many seconds later — sounds. A voice that arrives
// on a standing consent is built on a device opened outside any gesture; the reader's first
// Play resumes it through the unit player, on the tap's stack. Costs, stated once: every
// reader with WebGPU spends the worker bundle on the probe; a download in flight cannot be
// cancelled (the protocol has no message for it).
//
// THE MARK. Beside the dock's launcher, one always-visible icon says where the voice is —
// on this device, a download away and how large, downloading and how far, warming,
// speaking, paused, unsupported and why, or in a store that cannot keep it — and the
// mini-player beside it asks "Download speech model?" with the size when that is what stands
// between the reader and a voice. The mark is a projection of the same state as the status
// line: its sentence IS the status line, and its form is `markForm`, total over every phase,
// so a state with no form cannot be added [LAW:one-source-of-truth] [LAW:types-are-the-program].
//
// THE WORKER'S OWN DEATH. A bundle that fails to load, an exception outside the protocol:
// these arrive on the port's error channel, not as a message, and the panel answers with
// `crashed` — the performer, the device and the worker are discarded, the status names the
// failure, and the place the voice stood is kept for the retry. A panel that hangs in
// "Checking this device…" forever is the silent failure the state union exists to make
// unrepresentable [LAW:no-silent-failure].
//
// THE CUE. A place named for the voice to start from, before it has started there: the word
// a tap named while the voice was on its way, the place a link opened on, the place a crash
// left. Both arms hold it — the voice on stage holds one only while it stands idle, and its
// Play starts there — and the read-along paints it, so a link opens with its word lit
// before any audio exists. Null is the one honest value for "nobody named a place": the top,
// with nothing painted [LAW:types-are-the-program].
//
// THE PLACE KEPT. Wherever the voice speaks, the place under it — the word the cursor paints —
// is written to the device's storage as it moves (keptPlace.ts, through `resume`), so a
// reader who closes the tab, or whose phone discards it without a pagehide, finds their word
// again. Every word, not every pause: a write on pause or unload is lost to exactly the
// kill that loses the tab. A listen heard to its end forgets it; the reader's Stop does not.
// On return, while nothing plays and nothing is cued, the mini-player offers the kept place
// by its opening words, and the offer's tap is a tap on that word. A link to a place the
// page no longer has says so there instead [LAW:no-silent-failure]. The share control hands
// the page the moment on screen — the voice's place, or the cue — to write as a link.
//
// THE KEPT AUDIO. The device keeps every script the worker cuts and every unit the voice makes
// (keptAudio.ts), and the port the panel is handed answers either from it, holding what it
// cannot answer until the model is ready (keptSynthesis.ts) — the panel never knows which
// answered. So the script is asked for the moment a worker is spawned, and a paste opened
// before arrives with its script long before its model. What the panel owns is the order.
// With the script in hand, the voice is sent toward the stage as soon as there is a reason:
// the model ready, for a yes to the download, or a Play, which needs no model for what the
// device keeps (`advance`). Then the device is asked what it keeps of those units in the
// reader's voices, and the performer is built over that answer, so every kept unit's
// measurement is on the clock before the cue is resolved on it and a resume lands on its word
// [LAW:no-ambient-temporal-coupling]. The ask is a phase of the script, `restoring`, so a
// crash, a dispose or a new pick while it is out has a state to meet it in: a new pick asks
// again, and an answer to any ask but the current one is stale. On stage before the model is
// warm, the voice plays what the device keeps; a unit it does not keep waits, and the line
// says it waits for the voice and where the model is — downloading, warming, or failed, which
// the reader's next tap tries again. A device found unable to run the model takes the voice
// off the stage, as a crash does [LAW:no-silent-failure].
//
// THE BACKGROUND. Whether the page is in view is the page's fact, told to the panel as an
// event and carried on both arms like the speed. Out of view a listen that is on is heard
// through the lock screen, and the scheduler is told to make audio further ahead
// (scheduler.ts), since a phone may suspend the worker at any moment; a listen the reader
// paused out of view is made no further ahead than one in view, since nobody is hearing it.
// The window is a function of the state, and `step` alone tells the scheduler when it changes
// [LAW:single-enforcer]. A voice that runs dry there — speaking with nothing left to sound — is
// paused rather than left playing silence behind a lock screen that says it plays: the panel
// pauses it, marks it `stalled`, and plays it again the moment the audio it needs is held, or
// the page is back in view, whichever comes first. The pause is the background's, not the
// reader's: to the reader the listen is still on, waiting for its audio as a voice in view
// waits, so the transport offers Pause and the lock screen shows it playing — and a Pause, the
// headset's included, is a real pause that nothing plays again but the reader
// [LAW:no-silent-failure].
//
// WHAT THE PANEL MIRRORS. The `neural` arm carries the scheduler's view — player position,
// manifest, holdings, and the conversation's timeline built over them — as delivered by
// its onChange, and the voice a preview is sounding as delivered by the previewer's; the
// panel never computes a second opinion of either [LAW:one-source-of-truth]. Position is
// the performer's state — the segment the voice is in and its time on that timeline — read
// live on every animation frame while speaking; the read-along cursor, the status line's
// passage and a crash's retry place read the segment, and the scrubber and the turn skips
// the time, so a time inside the gap between speakers paints nothing, shows on the
// scrubber, and names the passage about to begin, with no second shape of position
// anywhere. A Place — the word a tap named, the point kept for a voice on its way — is the
// durable NAME of a point in the text, resolved to a time on the timeline of the moment it
// is used.
//
// THE VOICES. Which voice speaks for the reader and which for Claude is the device's pick
// (voiceChoice.ts): read from storage at every render, like the download preference, and
// never copied into the state. The map the performer is built with is derived from it when
// the device is asked what it keeps, and carried with the answer to the build, and a change while the voice is on stage is one event that becomes one effect
// — the performer is told the new map, and the scheduler remakes the units of the changed
// voice, the one under the cursor first. A voice is chosen by ear: a preview is offered
// exactly while the voice is on stage with its model ready (the port able to synthesize) and
// withheld with the reason otherwise; a preview's tap pauses the reading, since a phrase over
// the passage would be noise, and is the gesture that opens the preview's own device.
//
// [LAW:no-ambient-temporal-coupling] Events run to completion in arrival order, as in the
// scheduler: an effect's synchronous consequence (the performer's first view) is queued
// behind the event being handled, never handled inside it. The frame loop is armed and
// disarmed from the state after each event, so it runs exactly while the voice is speaking.
// The stage is a fact of the state, never of the queue's order: the step that receives
// the performer's first view is the one that enters `neural` and sends it to `from`.

import { begin, estimate, record, remainingText, type Pace } from "./downloadPace";
import { standingConsent, type StandingConsent } from "./listenConsent";
import { downloadNeedsTap, type ConnectionReading, type VoiceId } from "./modelAssets";
import type { AssetProgress } from "./modelAssetLoader";
import type { Keeping, Residency } from "./modelResidency";
import { createNeuralPerformer, stateOf, type NeuralPerformer, type NeuralState, type NeuralView } from "./neuralPerformer";
import { NORMAL, stepSpeed, type Place, type PerformerEvent, type PerformerState, type Speed } from "./performer";
import { wordStart, type Linked } from "./keptPlace";
import { turnOf, type ReadAlongAt } from "./readAlong";
import { startDownload, type DownloadConfig, type DownloadPhase } from "./renditionDownload";
import { BACKGROUND_LOOKAHEAD, LOOKAHEAD, type FailureReason, type Lookahead } from "./scheduler";
import type { Utterance } from "./speech";
import { wordSpans, type UnitReport, type WordSpan } from "./speechManifest";
import type { SynthesisUnit, VoiceMap } from "./speechScript";
import type { ListenPort } from "./synthesisClient";
import type { FromWorker, LoadFailure, UnsupportedReason } from "./synthesisProtocol";
import { clockText, cursorIn, estimated, landmark, landmarks, placeIn, pointAt, startAt, startIn, timeAt, timeOfStart, timelineOfUtterances, type Cursor, type Point, type Start, type Timeline } from "./timeline";
import { MODEL_PCM, openDevice, type DeviceFactory, type OpenDevice } from "./unitPlayer";
import { DEFAULT_PICK, samePick, voiceMapOf, type PickedVoice, type VoicePick } from "./voiceChoice";
import { mountVoicePicker, type PreviewOffer, type VoicesReadout } from "./voicePicker";
import { createPreviewer, type Previewer } from "./voicePreview";

// ── state ──────────────────────────────────────────────────────────────────────────────

// Where the model is on its way. The worker's own phases are a line (probing → unsupported |
// idle → loading → ready); these follow it one for one and add what the worker cannot see:
// `idle` (no worker) against `supported` (the worker's idle: probed, able, the weights
// awaiting consent), `downloading` versus `warming` (the same `progress` message, before and
// after the last byte), and the two ways it ends without a model that a Play tap retries.
// `downloading` carries its pace, the estimate's one source; `load-failed` carries the
// download where it stopped, when one was under way, so the bar stays as the failure found it.
export type ModelPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "probing" }
  | { readonly kind: "supported" }
  | { readonly kind: "preparing" }
  | { readonly kind: "downloading"; readonly progress: AssetProgress; readonly pace: Pace }
  | { readonly kind: "warming" }
  | { readonly kind: "ready" }
  | { readonly kind: "unsupported"; readonly reason: UnsupportedReason }
  | { readonly kind: "load-failed"; readonly failure: LoadFailure; readonly progress: AssetProgress | null }
  | { readonly kind: "crashed"; readonly message: string };

// [LAW:types-are-the-program] The phases a voice can stand on the stage in: a worker is there
// to speak through. A device that cannot run the model, or a worker that died, takes the voice
// off the stage, so neither is a phase the stage can hold.
export type StageModel = Exclude<ModelPhase, { readonly kind: "idle" | "unsupported" | "crashed" }>;
const onStage = (model: ModelPhase): model is StageModel => model.kind !== "idle" && model.kind !== "unsupported" && model.kind !== "crashed";

// The script the voice is built over: not asked for, with no worker to ask; `asked` of the
// port, which answers from the device at once or from the worker once the model is ready;
// `held`; and `restoring`, held while the device is asked what it keeps of its units (see THE
// KEPT AUDIO). A script is a function of the page alone, so once held it is held through a
// crash and its retry, which need not wait on the device again; a dispose starts over.
export type Script =
  | { readonly kind: "none" }
  | { readonly kind: "asked" }
  | { readonly kind: "held"; readonly units: ReadonlyArray<SynthesisUnit> }
  | { readonly kind: "restoring"; readonly units: ReadonlyArray<SynthesisUnit> };
const NO_SCRIPT: Script = { kind: "none" };

// What is left of the script when the worker is released: what was held stays held, and an
// ask the released worker would have answered is no longer out.
const released = (script: Script): Script => {
  switch (script.kind) {
    case "none":
    case "asked":
      return NO_SCRIPT;
    case "held":
      return script;
    case "restoring":
      return { kind: "held", units: script.units };
  }
};

// What the store has said it holds of the model: asked on every entry to the start, so it is
// never a value carried across a load that changed it [LAW:one-source-of-truth].
export type Home = { readonly kind: "reading" } | Residency;

// What the reader has said about the weights so far, in the order a later word may raise
// it: nothing yet; download and warm the voice; download, warm and speak.
export type Consent = "none" | "download" | "play";
const CONSENT_ORDER: Readonly<Record<Consent, number>> = { none: 0, download: 1, play: 2 };
const raise = (held: Consent, given: Consent): Consent => (CONSENT_ORDER[given] > CONSENT_ORDER[held] ? given : held);

// Whether the page is in view; on stage, also `stalled`: out of view, and paused by the panel
// because the voice ran out of audio there.
export type Visibility = "shown" | "hidden";
export type StageVisibility = Visibility | "stalled";

// The consent held is two words: `given` by the reader's own hand this visit — a tap, the
// mini-player's yes — which only rises; and `standing`, what the visit grants without a tap,
// replaced by each wake's reading, so an unchecked box withdraws what it alone granted and
// the reader's own yes survives it [LAW:one-source-of-truth]. The voice acts on the higher.
export interface Consents {
  readonly given: Consent;
  readonly standing: StandingConsent;
}
const NO_CONSENT: Consents = { given: "none", standing: "none" };
const granted = ({ consent }: PanelState): Consent => raise(consent.given, consent.standing);

// [LAW:one-source-of-truth] `speed` is on both arms because it belongs to neither: it is
// the reader's, set before any performer exists, obeyed by the one that arrives, and kept
// across a crash and the whole download. A performer that held its own copy would lose it
// at every one of those moments. `model` is on both arms for the same reason: the model
// loads on its own line whether or not a voice is on stage over what the device keeps.
export type PanelState =
  // The voice on its way, and where it starts when it arrives: the top until the reader or a
  // link names somewhere else — a word, or a time that may fall in a gap. `keeping` is the
  // browser's answer to keeping the bytes, once asked.
  | {
      readonly kind: "provisioning";
      readonly model: ModelPhase;
      readonly script: Script;
      readonly cue: Start | null;
      readonly home: Home;
      readonly keeping: Keeping | null;
      readonly consent: Consents;
      readonly speed: Speed;
      readonly visibility: Visibility;
    }
  // The voice on stage over its script's units; the view is the scheduler's, the cue where its
  // next Play starts while it stands idle, the consent kept for a fall, `sounding` the voice a
  // preview is saying its phrase in, when one is, `speed` the panel's own pace, which outlives
  // any performer, and `model` where the model is behind it — ready, or still on its way while
  // the voice plays what the device keeps.
  | {
      readonly kind: "neural";
      readonly model: StageModel;
      readonly units: ReadonlyArray<SynthesisUnit>;
      readonly view: NeuralView;
      readonly cue: Start | null;
      readonly consent: Consents;
      readonly sounding: VoiceId | null;
      readonly speed: Speed;
      readonly visibility: StageVisibility;
    };

export type Tap = "play" | "stop";

// [LAW:types-are-the-program] The transport as the device's media controls read it
// (mediaSession.ts): whether a voice is on stage and playing as the reader holds it — a stall
// is playing, so the controls offer the pause that ends it — where it is on the
// conversation's clock and how long that clock is, the speed, and the passage under the voice.
export type Playback = "none" | "paused" | "playing";
export interface Transport {
  readonly playback: Playback;
  readonly atMs: number;
  readonly totalMs: number;
  readonly speed: Speed;
  readonly utterance: number | null;
}

// [LAW:dataflow-not-control-flow] Everything the reader can ask the transport for, as one
// closed set of values rather than a method each: the two buttons, a tap on a word, the
// scrubber, the ten-second nudges, the turn skips, the speed steps. A key press is one of
// these (shortcuts.ts) and so is a click, so nothing downstream can tell which door a
// gesture came through. The four that move are resolved to a `Target` by the driver,
// where the timeline is: a scrubber never names a unit index.
export type Gesture =
  | { readonly kind: "tap"; readonly control: Tap }
  | { readonly kind: "place"; readonly to: Place }
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
    case "place":
    case "scrub":
    case "nudge":
    case "turn":
      return true;
  }
};

// A place the reader asked for: by its durable name — the word a tap landed on, kept as
// it was named so it resolves to that word's own time on whatever timeline is current when
// it is used — or by a time on the timeline showing at the moment of the ask, which is
// what the scrubber, a nudge and a turn skip name, and the only way to name the start of a
// gap [LAW:types-are-the-program].
export type Target = { readonly kind: "place"; readonly place: Place } | { readonly kind: "time"; readonly ms: number };

export type PanelEvent =
  | { readonly kind: "tap"; readonly control: Tap }
  // The reader named a place — a tap on a word, the scrubber, a nudge, a turn skip.
  | { readonly kind: "seek"; readonly to: Target }
  // A link named a place, with no gesture: the voice starts there when the reader plays, and
  // a voice already under way moves there.
  | { readonly kind: "cue"; readonly to: Place }
  // One step along the speed list, in whichever direction.
  | { readonly kind: "speed"; readonly by: -1 | 1 }
  // The mini-player's yes: a gesture that consents to the download and no more.
  | { readonly kind: "yes" }
  // The page waking the panel with no gesture — at mount, on a restore from the back-forward
  // cache, when the preference changes: the worker is spawned to probe, and the visit's
  // standing consent, if any, is given.
  | { readonly kind: "wake"; readonly consent: StandingConsent }
  // A message from the worker, stamped with its arrival on the driver's clock: the one
  // reading of time the download's pace is built from.
  | { readonly kind: "worker"; readonly message: FromWorker; readonly at: number }
  | { readonly kind: "worker-error"; readonly message: string }
  // The store's answer to `home`, and the browser's to the keep request that `load` makes.
  | { readonly kind: "home"; readonly residency: Residency }
  | { readonly kind: "keeping"; readonly keeping: Keeping }
  // The device's answer to `restore`: for each of those units, its kept report in those voices.
  | {
      readonly kind: "restored";
      readonly units: ReadonlyArray<SynthesisUnit>;
      readonly voices: VoiceMap;
      readonly kept: ReadonlyArray<UnitReport | undefined>;
    }
  | { readonly kind: "view"; readonly view: NeuralView }
  // The reader tapped a voice's preview: it is heard out, over a paused reading.
  | { readonly kind: "preview"; readonly voice: VoiceId }
  // The page went out of view, or came back into it.
  | { readonly kind: "visibility"; readonly hidden: boolean }
  // The previewer's word on which voice is sounding, or that none is.
  | { readonly kind: "sounding"; readonly voice: VoiceId | null }
  // The device's pick changed: the map the voice on stage speaks with from now on. A voice
  // on its way reads the pick at its build, so it has nothing to do here.
  | { readonly kind: "voices"; readonly voices: VoiceMap }
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
  // Asks the port for the page's script; answered by a `script` message.
  | { readonly kind: "script" }
  // Asks the device what it keeps of these units in the reader's voices; answered by `restored`.
  | { readonly kind: "restore"; readonly units: ReadonlyArray<SynthesisUnit> }
  | { readonly kind: "build"; readonly units: ReadonlyArray<SynthesisUnit>; readonly voices: VoiceMap; readonly kept: ReadonlyArray<UnitReport | undefined> }
  | { readonly kind: "perform"; readonly event: PerformerEvent }
  // The previewer says its phrase in the voice; on the tap's stack, which opens its device.
  | { readonly kind: "preview"; readonly voice: VoiceId }
  // The previewer is silenced.
  | { readonly kind: "hush" }
  // The performer is told the reader's voices.
  | { readonly kind: "revoice"; readonly voices: VoiceMap }
  // The performer is told how far ahead to make audio.
  | { readonly kind: "lookahead"; readonly to: Lookahead }
  // Releases the performer, the previewer, the device and the worker; how the worker ends is the value: a
  // dead worker is terminated, since nothing can be sent to it, a live one is asked to
  // dispose so the model is released first.
  | { readonly kind: "release"; readonly worker: "terminate" | "dispose" };

export interface Step {
  readonly state: PanelState;
  readonly effects: ReadonlyArray<Effect>;
}

// The one script the panel ever asks for; a reply with another id is not ours.
export const SCRIPT_ID = 1;

const IDLE: NeuralState = { kind: "idle" };
const MODEL_IDLE: ModelPhase = { kind: "idle" };

// Every entry to the start: the model in the given phase, the script, the cue, the consent
// and the speed kept, and the store asked afresh what it holds.
const enter = (model: ModelPhase, script: Script, cue: Start | null, consent: Consents, speed: Speed, visibility: Visibility): Step => ({
  state: { kind: "provisioning", model, script, cue, home: { kind: "reading" }, keeping: null, consent, speed, visibility },
  effects: [{ kind: "home" }],
});

export const initialState = (): PanelState => enter(MODEL_IDLE, NO_SCRIPT, null, NO_CONSENT, NORMAL, "shown").state;
// The panel's first step: the state, and the read of the store that fills its `home`. The
// worker is not spawned here but by the `wake` that follows, so a dispose — which returns
// here — spawns nothing on a page that is going away.
export const start = (): Step => enter(MODEL_IDLE, NO_SCRIPT, null, NO_CONSENT, NORMAL, "shown");

// [LAW:single-enforcer] Where a cue falls on a timeline: the top when nobody named one.
const timeOfCue = (line: Timeline, cue: Start | null): number => (cue === null ? 0 : timeOfStart(line, cue));

const stay = (state: PanelState): Step => ({ state, effects: [] });
const violation = (state: PanelState, what: string): Error =>
  new Error(`listen panel: ${what} while ${state.kind === "neural" ? "the voice is on stage" : state.model.kind}`);
// The verbs a tap can send: neither a seek nor a rate is ever a tap's — those carry a value
// the two buttons do not name.
type Verb = Exclude<PerformerEvent, { kind: "seek" | "rate" }>["kind"];
const perform = (event: PerformerEvent): Effect => ({ kind: "perform", event });
// A phrase and the reading never sound together: a preview pauses the reading (`preview`),
// and a tap on the transport hushes the phrase — always, since a hush on a silent
// previewer is its own no-op [LAW:dataflow-not-control-flow].
const HUSH: Effect = { kind: "hush" };

// The phases in which a `progress`, `ready` or `load-failed` may arrive.
const loading = (model: ModelPhase): boolean => model.kind === "preparing" || model.kind === "downloading" || model.kind === "warming";

// [LAW:single-enforcer] Whether the consent held sends a load: to a worker that is able and
// waiting, or one whose load failed, with a yes held.
const loads = (model: ModelPhase, consent: Consent): boolean => (model.kind === "supported" || model.kind === "load-failed") && consent !== "none";

type ModelMessage = Extract<FromWorker, { kind: "capability" | "progress" | "ready" | "load-failed" }>;

// [LAW:single-enforcer] The model's own line, the same whether or not a voice is on stage: the
// phase a message moves it to, or null for a message its phase cannot receive.
const heard = (model: ModelPhase, message: ModelMessage, at: number): ModelPhase | null => {
  switch (message.kind) {
    case "capability":
      if (model.kind !== "probing") return null;
      return message.support.kind === "supported" ? { kind: "supported" } : { kind: "unsupported", reason: message.support.reason };
    case "progress": {
      if (!loading(model)) return null;
      const { progress } = message;
      const sample = { at, bytes: progress.loadedBytes };
      return progress.loadedBytes < progress.totalBytes
        ? { kind: "downloading", progress, pace: model.kind === "downloading" ? record(model.pace, sample) : begin(sample) }
        : { kind: "warming" };
    }
    case "ready":
      return loading(model) ? { kind: "ready" } : null;
    case "load-failed":
      return loading(model) ? { kind: "load-failed", failure: message.failure, progress: model.kind === "downloading" ? model.progress : null } : null;
  }
};

type Provisioning = Extract<PanelState, { kind: "provisioning" }>;
type Stage = Extract<PanelState, { kind: "neural" }>;
interface ProvisioningStep {
  readonly state: Provisioning;
  readonly effects: ReadonlyArray<Effect>;
}

// Every load, first or retried: the browser is asked again to keep the bytes, so the
// answer shown is this load's, never a previous attempt's [LAW:one-source-of-truth].
const load = (state: Provisioning): ProvisioningStep => ({
  state: { ...state, model: { kind: "preparing" }, keeping: null },
  effects: [{ kind: "load" }],
});

// What a word from the reader does to the voice on its way, once the consent it carries is
// held in the state: spawns the worker when there is none — asking it for the script too,
// unless the script is already held — sends the load when the worker is able and a yes is
// held, retries a failed load, and otherwise only holds the word for the phase that will act
// on it — a `capability` reads the consent, a script in hand reads it again. A device that
// cannot run the voice is left as it is.
const kick = (state: Provisioning): ProvisioningStep => {
  switch (state.model.kind) {
    case "idle":
    case "crashed": {
      const asks = state.script.kind === "none" || state.script.kind === "asked";
      return {
        state: { ...state, model: { kind: "probing" }, script: asks ? { kind: "asked" } : state.script },
        effects: [{ kind: "spawn" }, ...(asks ? [{ kind: "script" } as const] : [])],
      };
    }
    case "supported":
    case "load-failed":
      return loads(state.model, granted(state)) ? load(state) : { state, effects: [] };
    case "unsupported":
    case "probing":
    case "preparing":
    case "downloading":
    case "warming":
    case "ready":
      return { state, effects: [] };
  }
};

// The model behind a voice on stage, kicked by a word from the reader: a load that failed is
// tried again on it, as a Retry would try it before the stage. Nothing else is the reader's
// to start there.
const reload = (state: Stage): Step =>
  loads(state.model, granted(state)) ? { state: { ...state, model: { kind: "preparing" } }, effects: [{ kind: "load" }] } : stay(state);

// A gesture is a kick with the reader's one moment of audio spent on it. There is nothing
// to unlock for a device that cannot run the voice.
const gesture = (state: Provisioning, given: Consent): ProvisioningStep => {
  if (state.model.kind === "unsupported") return { state, effects: [] };
  const kicked = kick({ ...state, consent: { ...state.consent, given: raise(state.consent.given, given) } });
  return { state: kicked.state, effects: [{ kind: "unlock" }, ...kicked.effects] };
};

// The page's visibility with the background's pause lifted: by the reader's Pause or Stop,
// which end the listen they were waiting on, or by the voice leaving the stage.
const seen = (visibility: StageVisibility): Visibility => (visibility === "stalled" ? "hidden" : visibility);

// [LAW:single-enforcer] Whether the listen is on as the reader holds it: the voice speaking, or
// stalled — paused by the background while its audio is made, never by the reader. A tap
// pauses it, and the transport's label and the media controls offer that pause.
const playing = (player: { readonly kind: PerformerState["kind"] }, visibility: StageVisibility): boolean =>
  player.kind === "speaking" || visibility === "stalled";

// On stage, every tap spends the cue: a Play from a cued idle voice is a seek to the cue,
// which starts it there; any other tap leaves the cue behind with the moment it named. A
// Play is also the reader's word to the model behind the stage: a load that failed is tried
// again. A Pause or a Stop asks nothing of the model, so it retries nothing — a failure that
// repeats would otherwise be fetched or warmed again on every pause.
const tap = (state: PanelState, control: Tap): Step => {
  switch (state.kind) {
    case "neural": {
      const { cue, view } = state;
      const verb: Verb = control === "stop" ? "stop" : playing(view.player, state.visibility) ? "pause" : "play";
      const act = cue !== null && verb === "play" ? perform({ kind: "seek", toMs: timeOfStart(view.timeline, cue) }) : perform({ kind: verb });
      const again = verb === "play" ? reload(state) : stay(state);
      return { state: { ...again.state, cue: null, visibility: seen(state.visibility) }, effects: [HUSH, act, ...again.effects] };
    }
    case "provisioning":
      // Stop is disabled by `readout` here; a tap that reaches it anyway changes nothing.
      return control === "stop" ? stay(state) : gesture(state, "play");
  }
};

// [LAW:single-enforcer] The one resolution of a target to a time, on the timeline given.
const timeOfTarget = (line: Timeline, to: Target): number => (to.kind === "place" ? timeAt(line, to.place) : to.ms);

// The page the panel reads: its utterances, and their timeline, a fact of the list built
// once with it — every segment a guess, since no voice has said any of it — and read wherever
// the state has no voice's timeline to read instead.
export interface Page {
  readonly utterances: ReadonlyArray<Utterance>;
  readonly timeline: Timeline;
}
export const pageOf = (utterances: ReadonlyArray<Utterance>): Page => ({ utterances, timeline: timelineOfUtterances(utterances) });

// The one place a target becomes a durable name: its place as given, or the start at its
// time on the timeline given — in a gap, the gap itself. Null on a conversation with
// nothing to say, which has nowhere to name.
const nameOfTarget = (line: Timeline, to: Target): Start | null => (to.kind === "place" ? { kind: "speech", place: to.place } : startAt(line, to.ms));

// A seek to a place: the voice on stage seeks to its time on the voice's own timeline,
// leaving any cue behind; the voice on its way is started as a Play tap starts it, and the
// place's name is kept as the cue for its arrival, when it resolves to a time on the
// timeline the voice brings.
const seek = (state: PanelState, to: Target, page: Page): Step => {
  switch (state.kind) {
    case "neural":
      // A seek moves the listen and leaves it as it was: a stalled voice is still on, and
      // plays from its new place once the audio there is held.
      return { state: { ...state, cue: null }, effects: [HUSH, perform({ kind: "seek", toMs: timeOfTarget(state.view.timeline, to) })] };
    case "provisioning": {
      // A conversation with nothing to say has nowhere to keep: the gesture names nothing.
      const cue = nameOfTarget(page.timeline, to);
      if (cue === null) return stay(state);
      const kicked = gesture(state, "play");
      return { state: { ...kicked.state, cue }, effects: kicked.effects };
    }
  }
};

// A place a link named: no gesture, so no audio is unlocked and no consent is given. It is
// kept as the cue wherever nothing is playing; a voice already under way moves there, as a
// seek would move it.
const cue = (state: PanelState, place: Place): Step => {
  const named: Start = { kind: "speech", place };
  if (state.kind === "provisioning" || state.view.player.kind === "idle") return stay({ ...state, cue: named });
  return { state, effects: [HUSH, perform({ kind: "seek", toMs: timeAt(state.view.timeline, place) })] };
};

// One step along the speed list, obeyed by whoever is on stage — and by nobody at all when
// no performer exists yet, in which case the state carries it to the one that arrives, the
// same way `from` carries the place. A step off either end of the list returns the same
// speed, which `readout` shows as a disabled control.
const speed = (state: PanelState, by: -1 | 1): Step => {
  const to = stepSpeed(state.speed, by);
  if (to === state.speed) return stay(state);
  return { state: { ...state, speed: to }, effects: state.kind === "neural" ? [perform({ kind: "rate", to })] : [] };
};

// The mini-player's yes, and the page's wake: the same kick, with and without a gesture. A voice
// on stage has nothing left to consent to, keeps the visit's standing word for a fall, and
// tries again a load that failed behind it.
const yes = (state: PanelState): Step => (state.kind === "provisioning" ? gesture(state, "download") : reload(state));
const wake = (state: PanelState, standing: StandingConsent): Step => {
  const told: PanelState = { ...state, consent: { ...state.consent, standing } };
  return told.kind === "provisioning" ? kick(told) : reload(told);
};

const provision = (state: Provisioning, message: FromWorker, at: number): Step => {
  switch (message.kind) {
    case "capability":
    case "progress":
    case "ready":
    case "load-failed": {
      const model = heard(state.model, message, at);
      if (model === null) throw violation(state, message.kind);
      // An able device loads on the consent held, or waits for one; the weights are never
      // fetched on the probe alone. One that cannot run the voice releases the worker, and
      // with it the ask for the script.
      if (model.kind === "unsupported") return { state: { ...state, model, script: released(state.script) }, effects: [{ kind: "release", worker: "terminate" }] };
      return model.kind === "supported" ? kick({ ...state, model }) : stay({ ...state, model });
    }
    case "script":
      if (state.script.kind !== "asked") throw violation(state, "script");
      if (message.id !== SCRIPT_ID) throw new Error(`listen panel: script reply ${message.id}, sent ${SCRIPT_ID}`);
      return stay({ ...state, script: { kind: "held", units: message.units } });
    case "refused":
      throw new Error(`listen panel: the worker refused ${message.request.kind} in phase ${message.phase}`);
    case "disposed":
      // Only `dispose` is answered so, and the port terminates the worker on it before the
      // panel could hear it.
      throw violation(state, "disposed");
    case "audio":
    case "word":
    case "done":
    case "cancelled":
    case "failed":
      // The scheduler's messages: nothing is synthesizing before the voice is on stage, and
      // a released worker is no longer heard.
      throw violation(state, message.kind);
  }
};

const fromWorker = (state: PanelState, message: FromWorker, at: number): Step => {
  if (state.kind === "provisioning") return provision(state, message, at);
  switch (message.kind) {
    case "audio":
    case "word":
    case "done":
    case "cancelled":
    case "failed":
    case "refused":
      // The performers' messages, on the port the panel also hears; the scheduler and the
      // previewer each judge a refusal of their own request. Not ours to act on.
      return stay(state);
    case "capability":
    case "progress":
    case "ready":
    case "load-failed": {
      // The model loading behind a voice that plays what the device keeps: its line moves on,
      // and the voice with it. A device that turns out unable to run the model takes the
      // voice off the stage, as a crash does — the worker it speaks through is released.
      const model = heard(state.model, message, at);
      if (model === null) throw violation(state, message.kind);
      if (!onStage(model)) return fallback(state, model);
      return model.kind === "supported" ? reload({ ...state, model }) : stay({ ...state, model });
    }
    case "script":
    case "disposed":
      throw violation(state, message.kind);
  }
};

// Where the voice on stage says it is, as the cue a retry resumes from. The last REPORT, not
// the live clock: the performer is about to be released, and a segment boundary is reported
// one hop after the clock crosses it. Cost, stated once: a crash retry resumes from the
// reported segment, at most one unit behind the ear. From inside a gap, that gap; from an
// idle voice, its cue.
const startOf = (state: Stage): Start | null => {
  const at = stateOf(state.view);
  return at.kind === "idle" ? state.cue : startIn(state.view.timeline, at.segment, at.atMs);
};

// What of the script outlives the stage or the way to it: on stage, its units, held.
const scriptOf = (state: PanelState): Script => (state.kind === "provisioning" ? released(state.script) : { kind: "held", units: state.units });

// The voice leaves the stage, or never reached it: the phase it fell to, the place kept for
// the retry, the consent it keeps, the script it holds, and the release of everything that
// had been built. The yes to the weights outlives the crash; the yes to speak does not, since
// the device that tap unlocked is released here — a Retry tap gives it again on its own stack,
// and a voice that fell mid-word then comes back speaking there, while a wake brings it back
// standing.
const outlives = (consent: Consents): Consents => ({ ...consent, given: consent.given === "none" ? "none" : "download" });
const fallback = (state: PanelState, model: ModelPhase): Step => {
  const entered = enter(model, scriptOf(state), state.kind === "provisioning" ? state.cue : startOf(state), outlives(state.consent), state.speed, seen(state.visibility));
  return { state: entered.state, effects: [{ kind: "release", worker: "terminate" }, ...entered.effects] };
};

// The two answers the driver feeds back. A late answer to a voice already on stage — the
// store answering after a whole load — has nothing to update.
const home = (state: PanelState, residency: Residency): Step =>
  state.kind === "provisioning" ? stay({ ...state, home: residency }) : stay(state);
const keeping = (state: PanelState, answer: Keeping): Step =>
  state.kind === "provisioning" ? stay({ ...state, keeping: answer }) : stay(state);

// A preview is offered only with the voice on stage and its model ready; the readout disables
// it otherwise, and a tap that reaches here anyway changes nothing. The reading is paused
// first — a pause on a paused or idle performer is the player's own no-op — so the phrase is
// heard alone.
const preview = (state: PanelState, voice: VoiceId): Step =>
  state.kind === "neural" && state.model.kind === "ready" ? { state, effects: [perform({ kind: "pause" }), { kind: "preview", voice }] } : stay(state);

// The previewer speaks only while the voice is on stage: it is built with the performer
// and released with it, so its word anywhere else is a bug.
const sounding = (state: PanelState, voice: VoiceId | null): Step => {
  if (state.kind !== "neural") throw violation(state, "a preview");
  return stay({ ...state, sounding: voice });
};

// [LAW:single-enforcer] How far ahead the voice is made: further while the page is out of view
// and the listen is on, the near window otherwise — which is also where every performer's
// scheduler starts, so a voice not yet on stage reads as near.
const windowOf = (state: PanelState): Lookahead =>
  state.kind === "neural" && state.visibility !== "shown" && playing(state.view.player, state.visibility) ? BACKGROUND_LOOKAHEAD : LOOKAHEAD;

// The background's pause, decided on every view of a voice out of view: a voice that is
// speaking with nothing to sound is paused and marked stalled; a stalled voice whose next unit
// is settled — held, or failed and so skipped once reached — is played, and stays stalled until it sounds — so the listen reads as on, and
// the window as wide, the whole way through — or until it leaves the stage, when there is
// nothing left to wait for. Anything else stands.
const background = (state: Stage): Step => {
  const { player, settled } = state.view;
  if (state.visibility === "shown") return stay(state);
  switch (player.kind) {
    case "idle":
      return stay({ ...state, visibility: "hidden" });
    case "speaking":
      if (player.flow === "audio") return stay({ ...state, visibility: "hidden" });
      return state.visibility === "stalled" ? stay(state) : { state: { ...state, visibility: "stalled" }, effects: [perform({ kind: "pause" })] };
    case "paused":
      return state.visibility === "stalled" && settled ? { state, effects: [perform({ kind: "play" })] } : stay(state);
  }
};

// The page out of view or back: on stage, the background's pause decided again — lifted
// outright on return, where the reader sees the honest "Synthesizing ahead…" instead.
const visibility = (state: PanelState, hidden: boolean): Step => {
  if (state.kind === "provisioning") return stay({ ...state, visibility: hidden ? "hidden" : "shown" });
  if (!hidden) {
    const resumed = state.visibility === "stalled" && state.view.player.kind === "paused" ? [perform({ kind: "play" })] : [];
    return { state: { ...state, visibility: "shown" }, effects: resumed };
  }
  return background({ ...state, visibility: state.visibility === "stalled" ? "stalled" : "hidden" });
};

// A voice on stage is told the new map. A voice being restored is asked again in it, since
// what the device keeps is kept per voice and the build takes the voices its answer was read
// in; the first answer, superseded, is never delivered.
const voices = (state: PanelState, map: VoiceMap): Step => {
  if (state.kind === "neural") return { state, effects: [{ kind: "revoice", voices: map }] };
  return state.script.kind === "restoring" ? { state, effects: [{ kind: "restore", units: state.script.units }] } : stay(state);
};

// The device's answer builds the performer over the units it was asked about, in the voices
// it was read in. An answer for any other ask — a restore a crash left behind — is stale and
// changes nothing.
const restored = (state: PanelState, event: Extract<PanelEvent, { kind: "restored" }>): Step =>
  state.kind === "provisioning" && state.script.kind === "restoring" && state.script.units === event.units
    ? { state, effects: [{ kind: "build", units: event.units, voices: event.voices, kept: event.kept }] }
    : stay(state);

// [LAW:single-enforcer] The one decision to put the voice on its way to the stage, read after
// every event: a script in hand, a worker to speak through, and a reason to be there — the
// model ready, which a yes to the download stands on, or a Play, which needs no model for
// what the device keeps. The device is then asked what it keeps of the script's units, and
// its answer builds the performer (`restored`). A voice on stage over kept units plays them
// while the model loads behind it, and a unit the device does not keep waits for the model.
const advance = (stepped: Step): Step => {
  const { state } = stepped;
  if (state.kind !== "provisioning" || state.script.kind !== "held" || !onStage(state.model)) return stepped;
  if (state.model.kind !== "ready" && granted(state) !== "play") return stepped;
  const { units } = state.script;
  return { state: { ...state, script: { kind: "restoring", units } }, effects: [...stepped.effects, { kind: "restore", units }] };
};

// The page's timeline is read when a place named by time before the voice arrives has to
// be kept by name. Whatever the event, a step that moves the window tells the scheduler so,
// after the step's own effects: a play, a pause, a stall, a return and a crash all change it
// through the one reading of the state [LAW:single-enforcer].
export const step = (state: PanelState, event: PanelEvent, page: Page): Step => {
  const stepped = advance(transition(state, event, page));
  const to = windowOf(stepped.state);
  return to === windowOf(state) || stepped.state.kind === "provisioning" ? stepped : { state: stepped.state, effects: [...stepped.effects, { kind: "lookahead", to }] };
};

const transition = (state: PanelState, event: PanelEvent, page: Page): Step => {
  switch (event.kind) {
    case "tap":
      return tap(state, event.control);
    case "seek":
      return seek(state, event.to, page);
    case "cue":
      return cue(state, event.to);
    case "speed":
      return speed(state, event.by);
    case "yes":
      return yes(state);
    case "wake":
      return wake(state, event.consent);
    case "worker":
      return fromWorker(state, event.message, event.at);
    case "worker-error":
      return fallback(state, { kind: "crashed", message: event.message });
    case "home":
      return home(state, event.residency);
    case "keeping":
      return keeping(state, event.keeping);
    case "restored":
      return restored(state, event);
    case "preview":
      return preview(state, event.voice);
    case "sounding":
      return sounding(state, event.voice);
    case "voices":
      return voices(state, event.voices);
    case "visibility":
      return visibility(state, event.hidden);
    case "dispose": {
      const started = start();
      // The speed is the reader's, not the panel's, and a teardown is not the reader
      // changing their mind [LAW:one-source-of-truth]. The script starts over with everything
      // else: a teardown may be a bug's, and the device answers the next ask for it at once.
      return { state: { ...started.state, speed: state.speed, visibility: seen(state.visibility) }, effects: [{ kind: "release", worker: "dispose" }, ...started.effects] };
    }
    case "view": {
      if (state.kind === "neural") return background({ ...state, view: event.view });
      const { script, model } = state;
      if (script.kind !== "restoring" || !onStage(model)) throw violation(state, "a scheduler view");
      // The performer's first view: the voice takes the stage at the reader's speed, sent
      // unconditionally so it never speaks a syllable at a speed it left behind, and to the
      // cue when a tap is what brought it — resolved now, on the timeline the voice brings.
      // A download alone leaves it standing ready, the cue kept for the reader's Play.
      const speaks = granted(state) === "play";
      return {
        state: { kind: "neural", model, units: script.units, view: event.view, cue: speaks ? null : state.cue, consent: state.consent, sounding: null, speed: state.speed, visibility: state.visibility },
        effects: [perform({ kind: "rate", to: state.speed }), ...(speaks ? [perform({ kind: "seek", toMs: timeOfCue(event.view.timeline, state.cue) })] : [])],
      };
    }
  }
};

// ── the readout ────────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] The mark's forms: one for every place the voice can be, as
// the reader sees them. `downloading` carries how far, for the ring, and the two forms that
// put a download to the reader carry its size, for the question; the reasons and positions
// each form would name ride the sentence beside it (`Readout.status`), so the form and the
// sentence are one state read twice, never two states kept in step.
export type MarkForm =
  | { readonly kind: "checking" }
  | { readonly kind: "ready" }
  | { readonly kind: "download"; readonly bytes: number }
  | { readonly kind: "unavailable"; readonly bytes: number }
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
  // The device's voice pick, read from storage at every render like `remembered`.
  readonly pick: VoicePick;
  // The place kept for this paste on this device, read from storage at every render, when
  // it still names this page's text (keptPlace.ts).
  readonly resume: Place | null;
  // Whether a link this visit opened named a place this page no longer has.
  readonly gone: boolean;
}

// [LAW:types-are-the-program] The mini-player's faces: one element beside the mark, showing
// exactly one of these. The question and its two answers while a download stands between
// the reader and the voice; how far while the voice is on its way; after a failure, the
// retry, when there is no voice to control; the three controls otherwise. The progress and
// note faces show the status sentence itself (`Readout.status`), so they carry no copy of
// it [LAW:one-source-of-truth]. `play` is what a tap does, so the one button's face follows
// the voice.
// `share` is whether there is a moment to link to: a voice under way, or a cue. `save` is
// whether there is a rendition to make a file of: a voice on stage over its script.
export type MiniFace =
  | { readonly kind: "consent"; readonly ask: string }
  | { readonly kind: "progress"; readonly fraction: number | null }
  | { readonly kind: "note"; readonly retry: boolean }
  | { readonly kind: "controls"; readonly play: "play" | "pause"; readonly back: boolean; readonly forward: boolean; readonly share: boolean; readonly save: boolean };

// [LAW:types-are-the-program] What the mini-player offers above its face while nothing plays
// and nothing is cued: the place kept on this device, by its opening words, which a tap
// starts from; or word that a link's place is gone from the page.
export type Offer = { readonly kind: "resume"; readonly place: Place; readonly words: string } | { readonly kind: "gone" };

// What the panel shows: the two buttons' shape, the status sentence, the download when
// there is one (under way, or where a failure stopped it), the mark's form, the
// preference's box, the voice picker and the mini-player's face. A pure projection of the
// state and the visit, so the check reads it directly.
export interface Readout {
  readonly play: { readonly label: string; readonly enabled: boolean };
  readonly stop: { readonly enabled: boolean };
  // Which turn skips are there to take, and which way the speed list still runs: a control
  // that would do nothing is `false` rather than a button that answers a tap with silence
  // [LAW:no-silent-failure].
  readonly skip: { readonly back: boolean; readonly forward: boolean };
  readonly speed: { readonly label: string; readonly slower: boolean; readonly faster: boolean };
  readonly status: string;
  readonly progress: AssetProgress | null;
  readonly mark: MarkForm;
  readonly remembered: boolean;
  readonly voices: VoicesReadout;
  readonly mini: MiniFace;
  readonly offer: Offer | null;
}

// What the scrubber and the two times show. Separate from `Readout` because it has a
// different clock: everything above changes only when the machine's state does, while this
// moves continuously as the voice speaks, so the driver paints it on every animation frame
// from the performer's LIVE position [LAW:one-source-of-truth]. In the conversation's own
// milliseconds throughout — media time, not wall-clock: at 1.5x the paste ends sooner than
// `remaining` says in seconds you can count, and the speed beside it is what says so.
interface Clock {
  readonly atMs: number;
  readonly totalMs: number;
  readonly played: string;
  readonly remaining: string;
}


// One rounding rule: a size never understates (up to the megabyte) and progress never
// overstates (down), so while the bytes are short of the total the downloaded figure is
// under the size and the percentage under 100 — the fragments agree the download is short
// of done exactly while it is [LAW:one-source-of-truth].
const MEGABYTE = 1_000_000;
const megabytes = (bytes: number): string => `${Math.ceil(bytes / MEGABYTE)} MB`;
const megabytesDone = (bytes: number): number => Math.floor(bytes / MEGABYTE);

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
      return `this browser can't keep the voice (${home.message}); each listen downloads ${megabytes(home.bytesToDownload)}`;
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

// The answer as the line shows it: once asked, and only of a store that can keep anything.
// A store that cannot be opened keeps nothing whatever the browser answers, and the store's
// own word already says each listen downloads — a denial's "may drop the voice" beside it
// would promise a keeping there is none of [LAW:one-source-of-truth].
const keptText = (state: Provisioning): ReadonlyArray<string> =>
  state.keeping === null || state.home.kind === "unavailable" ? [] : [keepingText(state.keeping)];

// The model's own sentence, as a fragment: one set of words for every phase that has one of
// its own [LAW:one-source-of-truth]. An idle or able worker says the store's word, and a ready
// one what the voice is waiting on — each read where the rest of the state is (`wayText`,
// `behindText`).
const modelText = (model: Exclude<ModelPhase, { kind: "idle" | "supported" | "ready" }>): string => {
  switch (model.kind) {
    case "probing":
      return "checking this device for the voice…";
    case "preparing":
      return "preparing the voice…";
    case "downloading": {
      const { loadedBytes, totalBytes } = model.progress;
      return `downloading the voice · ${Math.floor((100 * loadedBytes) / totalBytes)}% · ${megabytesDone(loadedBytes)} of ${megabytes(totalBytes)} · ${remainingText(estimate(model.pace, totalBytes - loadedBytes))}`;
    }
    case "warming":
      return "warming up the voice…";
    case "unsupported":
      return `this device can't run the voice: ${unsupportedText(model.reason)}`;
    case "load-failed":
      return `the voice could not load: ${loadFailureText(model.failure)}`;
    case "crashed":
      return `the voice failed${model.message === "" ? "" : `: ${model.message}`}`;
  }
};

const SCRIPTING = "preparing the script…";

// The voice on its way, as a fragment: the store's word before the model is asked for, the
// script once the model is ready or the device is asked what it keeps, the model otherwise.
const wayText = (state: Provisioning): string => {
  const { model } = state;
  if (state.script.kind === "restoring") return SCRIPTING;
  switch (model.kind) {
    case "idle":
    case "supported":
      return homeText(state.home);
    case "ready":
      return SCRIPTING;
    default:
      return modelText(model);
  }
};

// The model behind a voice on stage, as a fragment after the voice's own line: where it is on
// its way, and nothing once it is ready.
const behindText = (model: StageModel): string | null => {
  switch (model.kind) {
    case "ready":
      return null;
    case "supported":
      return "the voice has not started loading";
    default:
      return modelText(model);
  }
};

// The download, when there is one: under way, or where a failure stopped it.
const progressOf = (model: ModelPhase): AssetProgress | null => (model.kind === "downloading" || model.kind === "load-failed" ? model.progress : null);

const sentence = (fragment: string): string => fragment.charAt(0).toUpperCase() + fragment.slice(1);

const where = (utterance: number, total: number): string => `passage ${utterance + 1} of ${total}`;

// The passage the voice's segment says — from inside a gap, the passage the gap leads into.
// A voice waiting on its audio is synthesizing ahead once the model is ready, and waiting for
// the model before; the model's own line follows while it is on its way.
const neuralStatus = (state: Stage, total: number): string => {
  const { view, visibility, model } = state;
  const unitAt = (unitIndex: number): string => {
    const segment = view.units[unitIndex];
    if (segment === undefined) throw new Error(`listen panel: unit ${unitIndex} of ${view.units.length}`);
    return where(segment.content.utterance, total);
  };
  const skipped = view.holdings.flatMap((holding, i) =>
    holding.kind === "failed" ? [`${unitAt(i)} could not be synthesized: ${unitFailureText(holding.reason)}`] : [],
  );
  const at = stateOf(view);
  const { player } = view;
  const now =
    at.kind === "idle"
      ? "Ready"
      : `${at.kind === "paused" ? (visibility === "stalled" ? "Paused in the background until the voice catches up" : "Paused") : player.kind === "speaking" && player.flow === "waiting" ? (model.kind === "ready" ? "Synthesizing ahead…" : "Waiting for the voice") : "Playing"} · ${where(placeIn(view.timeline, at.segment, at.atMs).utterance, total)}`;
  const behind = behindText(model);
  return [now, ...(behind === null ? [] : [behind]), ...skipped].join(" · ");
};

// The transport over the voice on stage: the label follows what a tap would do.
const transport = (state: { readonly kind: PerformerState["kind"] }, visibility: StageVisibility): Pick<Readout, "play" | "stop"> => ({
  play: { label: playing(state, visibility) ? "Pause" : state.kind === "paused" ? "Resume" : "Listen", enabled: true },
  stop: { enabled: state.kind !== "idle" },
});

// The timeline the state implies: the voice's own, measured as far as the worker has got,
// once it is on stage; the page's own passages, every segment an estimate, before that
// [LAW:one-type-per-behavior]. The one spelling of which clock is current
// [LAW:one-source-of-truth].
export const timelineOf = (state: PanelState, page: Page): Timeline => (state.kind === "neural" ? state.view.timeline : page.timeline);

// Where the transport stands, from the state alone: the performer's own point when it has
// one, the point of the cue for a voice that has not started. This is the last REPORT — the
// driver reads the live clock for the cursor and the scrubber; a button's shape needs only
// which side of a landmark the voice is on, and every landmark sits at a unit boundary,
// which the player reports on crossing.
const pointIn = (state: PanelState, line: Timeline): Point | undefined => {
  const at = state.kind === "neural" ? stateOf(state.view) : IDLE;
  return at.kind === "idle" ? pointAt(line, timeOfCue(line, state.cue)) : at;
};

// The scrubber and the times at a point on the clock. Takes the milliseconds rather than a
// place because the reader dragging the scrubber is at a time that is not yet anybody's
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

// The controls that read the conversation rather than the voice: which turn skips are there
// to take, and which way the speed list still runs.
const around = (state: PanelState, page: Page): Pick<Readout, "skip" | "speed"> => {
  const line = timelineOf(state, page);
  const marks = landmarks(line);
  const at = pointIn(state, line);
  return {
    skip: { back: at !== undefined && landmark(marks, at, -1) !== null, forward: at !== undefined && landmark(marks, at, 1) !== null },
    speed: {
      label: `${state.speed}×`,
      slower: stepSpeed(state.speed, -1) !== state.speed,
      faster: stepSpeed(state.speed, 1) !== state.speed,
    },
  };
};

// The store's word as a form: before the probe has answered, the store's word is the
// mark's, since only a `no` from the probe changes it.
const homeForm = (home: Home): MarkForm => {
  switch (home.kind) {
    case "reading":
      return { kind: "checking" };
    case "resident":
      return { kind: "ready" };
    case "absent":
      return { kind: "download", bytes: home.bytesToDownload };
    case "unavailable":
      return { kind: "unavailable", bytes: home.bytesToDownload };
  }
};

// [LAW:dataflow-not-control-flow] Total over every phase and every player state: the one
// derivation of the mark's form.
export const markForm = (state: PanelState): MarkForm => {
  if (state.kind === "neural") {
    const { player } = state.view;
    return player.kind === "idle" ? { kind: "ready" } : { kind: player.kind };
  }
  const { model } = state;
  if (state.script.kind === "restoring") return { kind: "warming" };
  switch (model.kind) {
    case "idle":
    case "supported":
      return homeForm(state.home);
    case "probing":
      // A held consent through the probe is the probe's own form, not the store's word: the
      // ask it would put up is already answered.
      return granted(state) === "none" ? homeForm(state.home) : { kind: "checking" };
    case "preparing":
    case "warming":
    case "ready":
      return { kind: "warming" };
    case "downloading":
      return { kind: "downloading", fraction: model.progress.loadedBytes / model.progress.totalBytes };
    case "unsupported":
      return { kind: "unsupported" };
    case "load-failed":
    case "crashed":
      return { kind: "failed" };
  }
};

// The question, when a download is what the reader is deciding: the size, and what the
// reader must know before answering — that a store which keeps nothing downloads it every
// listen, and that a remembered yes is being overridden because the connection is metered
// [LAW:no-silent-failure].
const askText = (form: Extract<MarkForm, { kind: "download" | "unavailable" }>, visit: Visit): string => {
  const why = [
    ...(form.kind === "unavailable" ? [" · every listen, since this browser can't keep it"] : []),
    ...(visit.remembered && visit.metered ? [" · asking because this connection is metered"] : []),
  ];
  return [`Download speech model? · ${megabytes(form.bytes)}`, ...why].join("");
};

// [LAW:dataflow-not-control-flow] Total over the mark's forms: the mini-player's face is
// the form read once more, with the size and the skips it needs — never a second reading
// of the state [LAW:one-source-of-truth].
const miniFace = (form: MarkForm, skip: Readout["skip"], share: boolean, save: boolean, visit: Visit): MiniFace => {
  const controls = (play: "play" | "pause"): MiniFace => ({ kind: "controls", play, ...skip, share, save });
  switch (form.kind) {
    case "download":
    case "unavailable":
      return { kind: "consent", ask: askText(form, visit) };
    case "checking":
    case "warming":
      return { kind: "progress", fraction: null };
    case "downloading":
      return { kind: "progress", fraction: form.fraction };
    case "unsupported":
      return { kind: "note", retry: false };
    case "failed":
      return { kind: "note", retry: true };
    case "ready":
    case "paused":
      return controls("play");
    case "speaking":
      return controls("pause");
  }
};

// [LAW:dataflow-not-control-flow] Total over every phase: a preview is offered exactly with
// the voice on stage and its model ready, and withheld otherwise with the reason — the one
// honest sentence for a device that can never run the voice, and one for every other way of
// not being there yet.
const WHEN_READY: PreviewOffer = { kind: "withheld", why: "Previews play once the voice is ready on this device." };
const previewOffer = (state: PanelState): PreviewOffer => {
  if (state.kind === "neural") return state.model.kind === "ready" ? { kind: "offered" } : WHEN_READY;
  switch (state.model.kind) {
    case "unsupported":
      return { kind: "withheld", why: "This device can't run the voice, so there is nothing to hear." };
    case "idle":
    case "probing":
    case "supported":
    case "preparing":
    case "downloading":
    case "warming":
    case "ready":
    case "load-failed":
    case "crashed":
      return WHEN_READY;
  }
};

const voicesReadout = (state: PanelState, pick: VoicePick): VoicesReadout => ({
  picked: pick,
  preview: previewOffer(state),
  sounding: state.kind === "neural" ? state.sounding : null,
  reset: !samePick(pick, DEFAULT_PICK),
});

// How many of a place's words the offer quotes: enough to recognise the sentence, few enough
// for the mini-player's width.
const OFFER_WORDS = 5;
const openingWords = (text: string, char: number): string => {
  const words = wordSpans(text, 0).filter((word) => word.charEnd > char);
  const quoted = words.slice(0, OFFER_WORDS);
  const last = quoted.at(-1);
  const first = quoted[0];
  return first === undefined || last === undefined ? "" : `${text.slice(first.charStart, last.charEnd)}${words.length > OFFER_WORDS ? "…" : ""}`;
};

// Whether the voice will start where nobody has yet said: nothing playing or paused, nothing
// cued, and no Play already given to a voice on its way.
const unnamed = (state: PanelState): boolean =>
  state.cue === null && (state.kind === "neural" ? state.view.player.kind === "idle" : granted(state) !== "play");

// [LAW:dataflow-not-control-flow] Total over the visit: a gone link first, since it is why
// the page opened at the top; then the kept place, on a device that can play it.
const offerOf = (state: PanelState, page: Page, mark: MarkForm, visit: Visit): Offer | null => {
  if (!unnamed(state) || mark.kind === "unsupported") return null;
  if (visit.gone) return { kind: "gone" };
  const { resume } = visit;
  const text = resume === null ? undefined : page.utterances[resume.utterance]?.text;
  return resume === null || text === undefined ? null : { kind: "resume", place: resume, words: openingWords(text, resume.char) };
};

// The page's utterances count is the "of N" every position reads, and `around` reads the
// page's timeline for the turn landmarks before a voice has measured any of it.
export const readout = (state: PanelState, page: Page, visit: Visit): Readout => {
  const total = page.utterances.length;
  const mark = markForm(state);
  const { remembered } = visit;
  const voices = voicesReadout(state, visit.pick);
  const rest = around(state, page);
  const mini = miniFace(mark, rest.skip, listening(state) || state.cue !== null, state.kind === "neural", visit);
  const offer = offerOf(state, page, mark, visit);
  if (state.kind === "neural") {
    return { ...transport(state.view.player, state.visibility), ...rest, status: neuralStatus(state, total), progress: progressOf(state.model), mark, remembered, voices, mini, offer };
  }
  const { model } = state;
  // On its way: Play is the retry after a failure, and otherwise the word that raises the
  // consent to `play` — so it has nothing to say once that word is held, and nothing on a
  // device that cannot run the voice.
  const retry = model.kind === "load-failed" || model.kind === "crashed";
  const fragments = [wayText(state), ...keptText(state)];
  return {
    play: { label: retry ? "Retry" : "Listen", enabled: retry || (model.kind !== "unsupported" && granted(state) !== "play") },
    stop: { enabled: false },
    ...rest,
    status: sentence(fragments.join(" · ")),
    progress: progressOf(model),
    mark,
    remembered,
    voices,
    mini,
    offer,
  };
};

// ── the cursor ─────────────────────────────────────────────────────────────────────────

// Where the read-along is, from the cursor under the voice's time: the utterance, every
// utterance of its turn, and the range and word to paint.
export const readAlongAt = (cursor: Cursor, utterances: ReadonlyArray<Utterance>): ReadAlongAt => {
  const utterance = utterances[cursor.utterance];
  if (utterance === undefined) throw new Error(`listen panel: the performer is at utterance ${cursor.utterance} of ${utterances.length}`);
  return { utterance, turn: turnOf(utterances, utterance.anchor), range: cursor.range, word: cursor.word };
};

// What the read-along paints at a cue: the word holding its character, or the first word
// after it, as both the range and the word — a place names one word, and no voice has cut
// the sentence around it yet. A cue in a gap paints nothing, as the gap does when spoken.
export const cursorOfCue = (cue: Start | null, utterances: ReadonlyArray<Utterance>): Cursor | null => {
  if (cue === null || cue.kind === "silence") return null;
  const { utterance, char } = cue.place;
  const text = utterances[utterance]?.text;
  if (text === undefined) throw new Error(`listen panel: a cue at utterance ${utterance} of ${utterances.length}`);
  const word = wordSpans(text, 0).find((span) => span.charEnd > char);
  return word === undefined ? null : { utterance, range: word, word };
};

// The place a cue names: its own, or for a gap, the place the gap leads into.
const placeOfCue = (cue: Start | null): Place | null => (cue === null ? null : cue.kind === "speech" ? cue.place : cue.before);

// Whether the voice is speaking, from the state: exactly when the frame loop runs.
const speaking = (state: PanelState): boolean => state.kind === "neural" && state.view.player.kind === "speaking";

// Whether the transport's keys are the reader's rather than the page's: exactly while there
// is a voice to pause. Before the first Listen and after a Stop, Space scrolls the page as
// it always did and the arrows are the browser's — a reading page that swallowed those keys
// for a tool nobody has opened would be worse than one with no shortcuts at all.
export const listening = (state: PanelState): boolean => state.kind === "neural" && state.view.player.kind !== "idle";

// ── the driver ─────────────────────────────────────────────────────────────────────────

// The mark's markup: the root carries the form (`data-state`) and the ring's fraction; the
// button is what the reader taps to show and hide the mini-player, and its label carries
// the sentence for assistive tech — the mini-player's face says the rest to the eye.
export interface MarkControls {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
}

// The mini-player's markup: one root beside the mark, its four faces, and the controls each
// face holds. Every face is in the markup always; `render` shows the one the readout names.
export interface MiniControls {
  readonly root: HTMLElement;
  readonly faces: { readonly [K in MiniFace["kind"]]: HTMLElement };
  readonly ask: HTMLElement;
  readonly download: HTMLButtonElement;
  readonly always: HTMLButtonElement;
  readonly progress: HTMLElement;
  readonly bar: HTMLProgressElement;
  readonly note: HTMLElement;
  readonly retry: HTMLButtonElement;
  readonly back: HTMLButtonElement;
  readonly play: HTMLButtonElement;
  readonly forward: HTMLButtonElement;
  // The link to the moment on screen, and the conversation as an audio file, in the controls face.
  readonly share: HTMLButtonElement;
  readonly save: HTMLButtonElement;
  // The row above the face, and its two offers: the kept place's button, the gone link's note.
  readonly offer: HTMLElement;
  readonly resume: HTMLButtonElement;
  readonly gone: HTMLElement;
}

// The voice picker's markup: the button in the transport that opens and closes it, and the
// empty block the rows are built into (voicePicker.ts).
export interface VoiceControls {
  readonly toggle: HTMLButtonElement;
  readonly picker: HTMLElement;
}

export interface ListenControls {
  readonly play: HTMLButtonElement;
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
  // The preference's box, in the panel: checked from storage at every render.
  readonly remember: HTMLInputElement;
  readonly mark: MarkControls;
  readonly voices: VoiceControls;
  readonly mini: MiniControls;
}

// The animation-frame seam, so the check fires frames by hand.
export interface FrameLoop {
  readonly request: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
}

export interface ListenPanelConfig {
  readonly controls: ListenControls;
  readonly utterances: ReadonlyArray<Utterance>;
  readonly spawn: () => ListenPort;
  // What the device keeps of a script's units in these voices: keptAudio's restore in the
  // page, a stub in the check.
  readonly restore: (units: ReadonlyArray<SynthesisUnit>, voices: VoiceMap) => Promise<ReadonlyArray<UnitReport | undefined>>;
  // The store's word on the model, and the browser's on keeping it: modelResidency's two
  // edges over the real store and navigator.storage.persist in the page, stubs in the check.
  readonly home: () => Promise<Residency>;
  readonly keep: () => Promise<Keeping>;
  // The device's remembered preference, read at every render and written by the panel's
  // box and the mini-player's "Always Download": listenConsent's two edges over the device's
  // storage in the page (preferenceStore.deviceStore, which reads a refused store as nothing
  // kept), over a Map in the check. And the connection reading the metered rule judges: navigator.connection, which
  // only Chromium exposes; absent is honestly "unknown".
  readonly preference: { readonly read: () => boolean; readonly write: (remembered: boolean) => void };
  // The device's voice pick, read at every render and at the build, written by the picker:
  // voiceChoice's two edges over the device's storage in the page, over a Map in the check.
  readonly pick: { readonly read: () => VoicePick; readonly write: (pick: VoicePick) => void };
  readonly connection: () => ConnectionReading | undefined;
  // What opens the audio device: `AudioContext` in the page. Opened by the panel on the
  // first gesture or the first build, whichever comes first; closed with the worker.
  readonly Device: DeviceFactory;
  readonly frames: FrameLoop;
  // The clock the download's pace is read by, in milliseconds; only differences are read.
  // performance.now in the page, a counter the check advances by hand.
  readonly clock: () => number;
  // Called with where the read-along is whenever it moves, and with null when it stops.
  // This is the panel's one outward signal; the state itself is readable through `state()`.
  readonly onPosition: (at: ReadAlongAt | null) => void;
  // The place kept for this paste on this device: keptPlace's edges over the device's
  // storage in the page, keyed by the paste and checked against its prints; over
  // a Map in the check. Read at every render; written wherever the voice speaks; forgotten
  // when a listen runs to its end.
  readonly resume: { readonly read: () => Place | null; readonly write: (place: Place) => void; readonly forget: () => void };
  // Writes a link to a place where the reader can paste it: the clipboard, in the page. A
  // rejection is the reader's to see, on the control.
  readonly share: (place: Place) => Promise<void>;
  // The conversation as one audio file (renditionDownload.ts): the file's name without its
  // extension, the form this browser encodes, the encoder, and the save that hands the file to
  // the reader — a link's download in the page, a record in the check.
  readonly download: Pick<DownloadConfig, "name" | "form" | "encode" | "save">;
  // Called with the transport after every event: what the device's media controls show.
  readonly onTransport: (transport: Transport) => void;
  // Called on the reader's gesture, on its stack, whenever the panel spends it unlocking audio.
  readonly onUnlock: () => void;
  // Called when the reader asked to BE somewhere — a tap on a word, the scrubber, a nudge, a
  // turn skip — so whoever keeps the page in view looks there. One place decides this for
  // every door a seek can come through [LAW:single-enforcer]: a key and a click cannot drift
  // apart on whether the page follows.
  readonly onSeek: () => void;
}

export interface ListenPanel {
  // The reader's one door: every gesture, from every control and every key, arrives here.
  readonly send: (gesture: Gesture) => void;
  // A link's word on the listen: its place is cued, painted and followed; a place the page no
  // longer has is said on the mini-player; no link does nothing.
  readonly open: (link: Linked) => void;
  // The page is back: a restore from the back-forward cache after the pagehide that
  // disposed. The worker is spawned to probe again and the standing consent given again,
  // as at mount.
  readonly wake: () => void;
  // The page went out of view, or came back into it.
  readonly visibility: (hidden: boolean) => void;
  readonly state: () => PanelState;
  // Ends the listen, the device and the worker (gracefully: the model is released before
  // the worker ends); the page is left as the renderer made it, the controls show the
  // idle readout.
  readonly dispose: () => void;
}

// Focus never rides a hidden or disabled element out to the body: the control that held
// focus before the render — `held`, read before the render can move it — and was hidden
// by it (its face swapped away, or the whole mini-player folded) or disabled by it (a skip
// that reached the last turn) hands the focus to the mark's button, the one control that
// outlives every render [LAW:single-enforcer].
const handOff = (mark: MarkControls, mini: MiniControls, held: Element | null): void => {
  if (held === null || !mini.root.contains(held)) return;
  if (held.closest("[hidden]") !== null || held.matches(":disabled")) mark.button.focus();
};

// Writing text the element already has replaces its text node for nothing, and the clock
// below is painted sixty times a second; this is the one place that decides not to.
const setText = (el: Element, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};

// The mini-player: the face the readout names is shown and the other three hidden, and each
// face's controls are written whether or not it is showing, so no face can carry a stale
// word into its next showing. The progress and note faces show the status sentence; a bar
// with no fraction is the indeterminate one.
const renderMini = (mini: MiniControls, face: MiniFace, offer: Offer | null, status: string): void => {
  for (const [kind, el] of Object.entries(mini.faces)) el.hidden = kind !== face.kind;
  mini.offer.hidden = offer === null;
  mini.resume.hidden = offer?.kind !== "resume";
  setText(mini.resume, offer?.kind === "resume" ? `Resume “${offer.words}”` : "");
  mini.gone.hidden = offer?.kind !== "gone";
  setText(mini.gone, offer?.kind === "gone" ? "The linked moment is gone: this conversation has changed since the link was made." : "");
  setText(mini.ask, face.kind === "consent" ? face.ask : "");
  setText(mini.progress, face.kind === "progress" ? status : "");
  if (face.kind === "progress" && face.fraction !== null) mini.bar.value = face.fraction;
  else mini.bar.removeAttribute("value");
  setText(mini.note, face.kind === "note" ? status : "");
  mini.retry.hidden = !(face.kind === "note" && face.retry);
  const controls = face.kind === "controls" ? face : { play: "play" as const, back: false, forward: false, share: false, save: false };
  mini.back.disabled = !controls.back;
  mini.forward.disabled = !controls.forward;
  mini.share.disabled = !controls.share;
  mini.save.disabled = !controls.save;
  mini.play.dataset.does = controls.play;
  mini.play.setAttribute("aria-label", controls.play === "pause" ? "Pause" : "Play");
};

// [LAW:dataflow-not-control-flow] Every attribute written on every render, only the values
// vary: no path leaves a stale form, a stale sentence or a stale ring behind. Whether the
// mini-player is `out` is the one input the readout does not carry: the driver's word,
// from the reader's toggle and the voice's place.
const render = (controls: ListenControls, picker: { readonly render: (shown: VoicesReadout) => void }, shown: Readout, out: boolean): void => {
  picker.render(shown.voices);
  controls.play.textContent = shown.play.label;
  controls.play.disabled = !shown.play.enabled;
  controls.stop.disabled = !shown.stop.enabled;
  controls.back.disabled = !shown.skip.back;
  controls.forward.disabled = !shown.skip.forward;
  controls.slower.disabled = !shown.speed.slower;
  controls.faster.disabled = !shown.speed.faster;
  setText(controls.speed, shown.speed.label);
  controls.status.textContent = shown.status;
  controls.progress.hidden = shown.progress === null;
  controls.progress.max = shown.progress?.totalBytes ?? 1;
  controls.progress.value = shown.progress?.loadedBytes ?? 0;
  controls.remember.checked = shown.remembered;
  const { mark, mini } = controls;
  mark.root.dataset.state = shown.mark.kind;
  mark.root.style.setProperty("--fraction", String(shown.mark.kind === "downloading" ? shown.mark.fraction : 0));
  // The sentence names the mark for assistive tech.
  mark.button.setAttribute("aria-label", `Listen: ${shown.status}`);
  const held = mini.root.ownerDocument.activeElement;
  renderMini(mini, shown.mini, shown.offer, shown.status);
  mini.root.hidden = !out;
  mark.button.setAttribute("aria-expanded", String(out));
  handOff(mark, mini, held);
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
  a === b || (a !== null && b !== null && a.utterance === b.utterance && sameSpan(a.range, b.range) && sameSpan(a.word, b.word));

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
  let port: ListenPort | null = null;
  let audio: OpenDevice | null = null;
  let unsubscribe: () => void = unheard;
  let unsubscribeErrors: () => void = unheard;
  let neural: NeuralPerformer | null = null;
  let previewer: Previewer | null = null;
  const portOf = (): ListenPort => {
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
  const previewerOf = (): Previewer => {
    if (previewer === null) throw new Error("listen panel: no previewer to drive");
    return previewer;
  };
  // [LAW:no-ambient-temporal-coupling] One ask of each kind in flight, owned here: a new ask
  // supersedes the old, and only the current ask's answer is dispatched. The order two
  // promises settle in cannot put a stale store or browser answer over a fresh entry.
  const askHome = latest<Residency>((residency) => dispatch({ kind: "home", residency }));
  const askKeep = latest<Keeping>((keeping) => dispatch({ kind: "keeping", keeping }));
  const askKept = latest<Extract<PanelEvent, { kind: "restored" }>>((answer) => dispatch(answer));

  let frame: number | null = null;
  let shown: ReadAlongAt | null = null;
  // [LAW:no-shared-mutable-globals] The reader's thumb on the scrubber, owned here and
  // written only by its two listeners. It is not a second position: it is the one fact
  // nobody else holds — that the reader is asking for a place they have not committed to.
  let held = false;
  // The page, its timeline built once for the panel's whole life; the voice's timeline
  // travels with its view, built once per view.
  const page = pageOf(utterances);
  const timeline = (): Timeline => timelineOf(state, page);

  // Read live from the performer, not from the state's snapshot: the clock moves with no
  // event.
  const stageState = (): NeuralState => (state.kind === "neural" ? performer().state() : IDLE);
  // Where the voice is now, as the one number every transport reading is in: the live
  // time while there is one, else the time of the place the state holds.
  const pointNow = (): Point | undefined => {
    const now = stageState();
    return now.kind === "idle" ? pointIn(state, timeline()) : now;
  };
  const timeNow = (): number => pointNow()?.atMs ?? 0;
  // What the scrubber and the times show right now: the reader's drag while they are
  // dragging, the voice's own place otherwise.
  const clockNow = (): Clock => clockAt(timeline(), held ? Number(controls.scrub.value) : timeNow());
  const paintClock = (): void => renderClock(controls, clockNow(), held);

  // The place the transport names right now, at its word's start: under the voice while it
  // has a place, else the cue's. Null while nothing is playing and nothing is cued.
  const placeNow = (): Place | null => {
    const now = stageState();
    const place = now.kind === "idle" ? placeOfCue(state.cue) : placeIn(timeline(), now.segment, now.atMs);
    return place === null ? null : wordStart(utterances, place);
  };
  // The transport as the media controls read it: the live clock, not the last report, since
  // this is read at the moment an event lands.
  const transportNow = (): Transport => {
    const now = stageState();
    return {
      playback: now.kind === "idle" ? "none" : state.kind === "neural" && playing(now, state.visibility) ? "playing" : "paused",
      atMs: now.kind === "idle" ? 0 : now.atMs,
      totalMs: timeline().totalMs,
      speed: state.speed,
      utterance: now.kind === "idle" ? null : placeIn(timeline(), now.segment, now.atMs).utterance,
    };
  };
  // [LAW:no-shared-mutable-globals] The last place written to the device, owned here, so a
  // look on the same word writes nothing; and whether the voice was under way at the last
  // look, so its going idle is seen once.
  let kept: Place | null = null;
  let underWay = false;
  // The device keeps the place under the voice at every look — each frame, each event. A
  // voice that goes idle without the reader's Stop ran out — the last unit settled, or a
  // failed last unit was skipped past the end — and a listen heard to its end has nothing
  // to resume, so the kept place is forgotten; the reader's Stop keeps it, for the offer.
  // `by` is the event this look follows, null for a frame. Looked before the render, so
  // the offer the render draws reads the storage this look left.
  const keep = (by: PanelEvent | null): void => {
    const now = stageState();
    const stopped = by?.kind === "tap" && by.control === "stop";
    if (now.kind !== "idle") {
      const place = placeNow();
      if (place !== null && (kept === null || kept.utterance !== place.utterance || kept.char !== place.char)) config.resume.write(place);
      kept = place;
    } else if (underWay && !stopped && state.kind === "neural") {
      kept = null;
      config.resume.forget();
    }
    underWay = now.kind !== "idle";
  };

  // What is painted: the voice's cursor while it has a place, else the cue's word, else
  // nothing.
  const emitPosition = (): void => {
    const now = stageState();
    const cursor = now.kind === "idle" ? cursorOfCue(state.cue, utterances) : cursorIn(now.segment, now.atMs);
    const at = cursor === null ? null : readAlongAt(cursor, utterances);
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
        keep(null);
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
      case "home":
        askHome.ask(config.home());
        return;
      case "spawn":
        port = config.spawn();
        unsubscribe = port.subscribe((message) => dispatch({ kind: "worker", message, at: config.clock() }));
        unsubscribeErrors = port.errors((message) => dispatch({ kind: "worker-error", message }));
        return;
      case "unlock":
        // On the gesture's stack: opened AND resumed inside it, which is the unlock every
        // browser honours; the player's own resume, on a worker message later, is then a
        // no-op on a running context. The page is told on the same stack, so whatever else it
        // plays for the listen is unlocked by the same gesture.
        void device().device.resume();
        config.onUnlock();
        return;
      case "load":
        portOf().send({ kind: "load" });
        askKeep.ask(config.keep());
        return;
      case "script":
        portOf().send({ kind: "script", id: SCRIPT_ID, utterances });
        return;
      case "restore": {
        // The pick as the device holds it now, carried with the answer so the build speaks in
        // the voices the kept reports were read in.
        const { units } = effect;
        const voices = voiceMapOf(config.pick.read());
        askKept.ask(config.restore(units, voices).then((kept) => ({ kind: "restored", units, voices, kept })));
        return;
      }
      case "build": {
        const built = createNeuralPerformer({
          port: portOf(),
          device: device(),
          script: effect.units,
          utterances,
          voices: effect.voices,
          kept: effect.kept,
          onChange: (view) => dispatch({ kind: "view", view }),
        });
        neural = built;
        previewer = createPreviewer({ port: portOf(), Device: config.Device, onChange: (voice) => dispatch({ kind: "sounding", voice }) });
        dispatch({ kind: "view", view: built.view() });
        return;
      }
      case "perform":
        performer().send(effect.event);
        return;
      case "preview":
        previewerOf().say(effect.voice);
        return;
      case "hush":
        previewerOf().hush();
        return;
      case "revoice":
        performer().voices(effect.voices);
        return;
      case "lookahead":
        performer().lookahead(effect.to);
        return;
      case "release": {
        // A worker can die before the performer exists (the bundle failed to load) or
        // after; either way what exists is released: the previewer and the performer, then
        // the worker, then the device the performer borrowed.
        stopDownload("the voice stopped before the file was made");
        const releasing = neural;
        const hushing = previewer;
        neural = null;
        previewer = null;
        hushing?.dispose();
        releasing?.dispose();
        unsubscribe();
        unsubscribeErrors();
        unsubscribe = unheard;
        unsubscribeErrors = unheard;
        port?.[effect.worker]();
        port = null;
        void audio?.device.close();
        audio = null;
        // The keep request belonged to the load the released worker was doing, and the restore
        // to the units it cut.
        askKeep.drop();
        askKept.drop();
        return;
      }
    }
  };

  // The picker's rows, built once into the page's empty block; a pick is written to the
  // device and the map derived from what the device then holds — the same read the
  // readout makes — so the voice on stage and the rows can never disagree
  // [LAW:one-source-of-truth].
  const repick = (pick: VoicePick): void => {
    config.pick.write(pick);
    dispatch({ kind: "voices", voices: voiceMapOf(config.pick.read()) });
  };
  const picker = mountVoicePicker(controls.voices.picker, {
    pick: (role: PickedVoice, voice: VoiceId) => repick({ ...config.pick.read(), [role]: voice }),
    preview: (voice) => dispatch({ kind: "preview", voice }),
    reset: () => repick(DEFAULT_PICK),
  });

  // [LAW:no-shared-mutable-globals] Whether a link this visit opened named a place the page
  // no longer has: owned here, set by `open`, and spent by the reader's next gesture, which
  // is their answer to it.
  let gone = false;
  // The visit as it is now: the preferences and the kept place from storage, the connection
  // from the browser.
  const visit = (): Visit => ({
    remembered: config.preference.read(),
    metered: downloadNeedsTap(config.connection()),
    pick: config.pick.read(),
    resume: config.resume.read(),
    gone,
  });
  // Whether the reader has the mini-player out: a fact of the markup alone, owned here and
  // flipped by the mark's tap; the machine has no state for it, as it has none for the
  // picker's fold [LAW:one-source-of-truth]. A voice with a place keeps the player out
  // whatever the toggle says — a listen never hides its controls — so a tap while the voice
  // is on stage changes nothing the reader can see, and its word is kept for when the
  // listen ends. It starts out when the device keeps a place for this paste, so the offer to
  // resume is seen, and a link brings it out, so its Play is; the mark's tap folds either.
  let opened = config.resume.read() !== null;
  const out = (): boolean => opened || listening(state);
  const show = (): void => render(controls, picker, readout(state, page, visit()), out());

  const run = (event: PanelEvent): void => {
    const planned = step(state, event, page);
    state = planned.state;
    for (const effect of planned.effects) performEffect(effect);
    keep(event);
    show();
    syncFrames();
    emitPosition();
    paintClock();
    config.onTransport(transportNow());
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

  // [LAW:dataflow-not-control-flow] Every gesture becomes the one event the machine already
  // had — a tap, a seek to a target, a speed step — so nothing below the panel knows a
  // scrubber exists. The three gestures that name a TIME are resolved here, where the
  // timeline of the moment is; a tap on a word keeps the word's name.
  //
  // Null is the honest answer to a gesture that names nowhere: no landmark before the top,
  // none after the last gap. The control that would send it is disabled by `readout`, so
  // only a key can reach this, and the reader hears what they already hear.
  const resolve = (g: Gesture): PanelEvent | null => {
    const at = (ms: number | null): PanelEvent | null => (ms === null ? null : { kind: "seek", to: { kind: "time", ms } });
    switch (g.kind) {
      case "tap":
        return { kind: "tap", control: g.control };
      case "speed":
        return { kind: "speed", by: g.by };
      case "place":
        return { kind: "seek", to: { kind: "place", place: g.to } };
      case "scrub":
        return at(g.toMs);
      case "nudge":
        return at(timeNow() + g.bySeconds * 1000);
      case "turn": {
        const from = pointNow();
        return at(from === undefined ? null : landmark(landmarks(timeline()), from, g.by));
      }
    }
  };

  const send = (g: Gesture): void => {
    gone = false;
    unshare();
    const event = resolve(g);
    if (event === null) {
      show();
      return;
    }
    dispatch(event);
    if (moves(g)) config.onSeek();
  };

  // A link's word: its place cued — painted, and followed as a seek is — or the word that it
  // is gone. Either brings the mini-player out, where its Play or its note is.
  const openLink = (link: Linked): void => {
    if (link.kind === "none") return;
    opened = true;
    gone = link.kind === "gone";
    if (link.kind === "gone") {
      show();
      return;
    }
    dispatch({ kind: "cue", to: link.place });
    config.onSeek();
  };

  // The share control's word on its last tap, shown on the control until the reader's next
  // gesture or its losing focus: the link copied, or the reason it was not
  // [LAW:no-silent-failure].
  const { share: shareButton } = controls.mini;
  const SHARE_LABEL = "Copy a link to this moment";
  // [LAW:no-ambient-temporal-coupling] The share's answer belongs to the tap that asked for
  // it: every tap and every reset counts here, and an answer lands only while no later one
  // has — a clipboard slow behind its permission prompt never relabels a control the reader
  // has since moved past.
  let asks = 0;
  const unshare = (): void => {
    asks += 1;
    delete shareButton.dataset.shared;
    shareButton.setAttribute("aria-label", SHARE_LABEL);
    shareButton.title = SHARE_LABEL;
  };
  const shared = (ask: number, outcome: "copied" | "failed", label: string): void => {
    if (ask !== asks) return;
    shareButton.dataset.shared = outcome;
    shareButton.setAttribute("aria-label", label);
    shareButton.title = label;
  };

  // The download control: a tap on it makes the conversation's audio file, and its word on the
  // download is shown on the control — the percentage made while it runs, then the name saved or
  // why not, until the reader's next gesture or its losing focus [LAW:no-silent-failure]. A tap
  // while a download runs withdraws it. A download needs the voice on stage, and ends with it.
  const { save: saveButton } = controls.mini;
  const SAVE_LABEL = "Download this conversation as audio";
  // [LAW:no-shared-mutable-globals] The download under way, by its withdrawal; owned here. A
  // phase lands only while its own download is the one under way.
  let downloading: { withdraw: () => void } | null = null;
  const percent = (fraction: number): string => `${Math.floor(fraction * 100)}%`;
  const saveLabel = (phase: DownloadPhase | null): string => {
    if (phase === null) return SAVE_LABEL;
    switch (phase.kind) {
      case "rendering":
        return `Making the audio file: ${percent(phase.total === 0 ? 1 : phase.made / phase.total)} of the voice · tap to stop`;
      case "encoding":
        return `Encoding the audio file: ${percent(phase.fraction)} · tap to stop`;
      case "saved":
        return phase.missing.length === 0 ? `Saved ${phase.name}` : `Saved ${phase.name}, without ${phase.missing.length === 1 ? "a passage" : `${phase.missing.length} passages`} the voice could not say`;
      case "failed":
        return `Could not make the audio file: ${phase.message}`;
    }
  };
  const showDownload = (phase: DownloadPhase | null): void => {
    const label = saveLabel(phase);
    if (phase === null) delete saveButton.dataset.phase;
    else saveButton.dataset.phase = phase.kind;
    const fraction = phase?.kind === "rendering" ? (phase.total === 0 ? 1 : phase.made / phase.total) : phase?.kind === "encoding" ? phase.fraction : 0;
    saveButton.style.setProperty("--fraction", String(fraction));
    saveButton.setAttribute("aria-label", label);
    saveButton.title = label;
  };
  function stopDownload(why: string | null): void {
    if (downloading === null) return;
    const { withdraw } = downloading;
    downloading = null;
    withdraw();
    showDownload(why === null ? null : { kind: "failed", message: why });
  }

  // The first step, performed like every other: the state shown, the store asked.
  for (const effect of start().effects) performEffect(effect);
  show();
  paintClock();
  // Every tap on the panel and on the mini-player is a gesture the machine already had; the
  // mini-player's Retry and play are the panel's Play by another glyph.
  const taps: ReadonlyArray<readonly [HTMLElement, Gesture]> = [
    [controls.play, { kind: "tap", control: "play" }],
    [controls.stop, { kind: "tap", control: "stop" }],
    [controls.back, { kind: "turn", by: -1 }],
    [controls.forward, { kind: "turn", by: 1 }],
    [controls.slower, { kind: "speed", by: -1 }],
    [controls.faster, { kind: "speed", by: 1 }],
    [controls.mini.play, { kind: "tap", control: "play" }],
    [controls.mini.back, { kind: "turn", by: -1 }],
    [controls.mini.forward, { kind: "turn", by: 1 }],
  ];
  for (const [button, g] of taps) button.addEventListener("click", () => send(g));
  // The offer's tap is a tap on the kept word: read from the device at the tap, the same read
  // the offer was drawn from.
  controls.mini.resume.addEventListener("click", () => {
    const place = config.resume.read();
    if (place !== null) send({ kind: "place", to: place });
  });
  // The share control names the moment at the tap — the live one while the voice speaks.
  unshare();
  shareButton.addEventListener("click", () => {
    const place = placeNow();
    if (place === null) return;
    // Whatever the page's share does — a clipboard that is not there throws before any
    // promise exists — reaches the reader on the control [LAW:no-silent-failure].
    const ask = (asks += 1);
    Promise.resolve()
      .then(() => config.share(place))
      .then(
        () => shared(ask, "copied", "Link copied"),
        (error: unknown) => shared(ask, "failed", `Could not copy the link: ${error instanceof Error ? error.message : String(error)}`),
      );
  });
  shareButton.addEventListener("blur", unshare);
  showDownload(null);
  saveButton.addEventListener("click", () => {
    if (downloading !== null) return stopDownload(null);
    if (state.kind !== "neural") return;
    // Under way before it starts: its first phase is said inside the start.
    const run = { withdraw: (): void => undefined };
    downloading = run;
    run.withdraw = startDownload({
      ...config.download,
      port: portOf(),
      script: state.units,
      voices: voiceMapOf(config.pick.read()),
      format: MODEL_PCM,
      onPhase: (phase) => {
        if (downloading !== run) return;
        if (phase.kind === "saved" || phase.kind === "failed") downloading = null;
        showDownload(phase);
      },
    });
  });
  // A finished download's word stays until the reader moves on; one under way stays on show.
  saveButton.addEventListener("blur", () => {
    if (downloading === null) showDownload(null);
  });
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

  // Whether the picker is open is a fact of the markup alone, owned here, as the
  // mini-player's fold is: the machine has no state for it [LAW:one-source-of-truth].
  const { voices: voiceControls } = controls;
  const open = (shown: boolean): void => {
    voiceControls.picker.hidden = !shown;
    voiceControls.toggle.setAttribute("aria-expanded", String(shown));
  };
  open(false);
  voiceControls.toggle.addEventListener("click", () => open(voiceControls.picker.hidden));

  // The mark's tap is the mini-player's toggle over what the reader SEES: a tap on a
  // player that is out asks to fold it, whether the reader's toggle or the voice's place
  // put it out. So a tap while the voice is on stage is always the word "fold", and a
  // second tap the same word — never a hidden flip the reader cannot see.
  const { mark, mini } = controls;
  mark.button.addEventListener("click", () => {
    opened = !out();
    show();
  });
  // The two answers to the question are the same yes on the tap's own stack — a metered
  // connection withholds only a STANDING yes, never the reader's own hand — and "always"
  // keeps it on the device first, so the box in the panel reads checked on the render this
  // yes causes.
  mini.download.addEventListener("click", () => dispatch({ kind: "yes" }));
  mini.always.addEventListener("click", () => {
    config.preference.write(true);
    dispatch({ kind: "yes" });
  });
  // Retry is the yes again, not a Play: a reader who only ever answered the download
  // question must not hear the voice start when the retried download lands. The consent
  // only rises, so a Play that a failed load left standing is kept; after a crash, which
  // lowered it, the retried voice stands ready and waits for the reader's Play.
  mini.retry.addEventListener("click", () => dispatch({ kind: "yes" }));
  // Checking the box is the yes for this visit too, subject to the same rule as any
  // standing consent; unchecking only stops asking on the reader's behalf.
  controls.remember.addEventListener("change", () => {
    config.preference.write(controls.remember.checked);
    wakeUp();
  });
  wakeUp();

  return {
    send,
    open: openLink,
    // The page's door back in: the wake, as at mount.
    wake: wakeUp,
    visibility: (hidden) => dispatch({ kind: "visibility", hidden }),
    state: () => state,
    // One more event through the same machine: the idle state disarms the frame loop,
    // clears the position, and the controls say what the state says, so a page back from
    // the back-forward cache finds them right.
    dispose: () => dispatch({ kind: "dispose" }),
  };
};
