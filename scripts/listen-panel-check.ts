// The Listen panel, driven under jsdom with a stub worker port, the stub playback device
// and a hand-fired frame loop (slopspot-read-along-q35.9, slopspot-read-along-a35.bse,
// slopspot-read-along-a35.a4l). Run: `tsx scripts/listen-panel-check.ts`.
//
// Two halves, as in scheduler-check.ts. First the pure `step` through its accept table:
// every state's answer to every event that may arrive in it, the throw for every message
// the protocol says cannot, and the mark's form for every place the voice can be. Then
// the real driver over the REAL neural performer — the real scheduler and unit player on
// the stub device, with a stub port standing in for the worker and a Map for the device's
// storage — asserting only what a reader sees and hears: the button labels, the status
// sentence, the progress bar, the mark and its hover, where the read-along cursor is, and
// that no byte of the weights is asked for before a yes — the tap's, the hover's, or the
// remembered one — while the audio device is opened and resumed on the gesture, before
// any worker message [LAW:behavior-not-structure] [LAW:verifiable-goals].

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { PREFERENCE_KEY, readPreference, writePreference, type StandingConsent } from "../src/listenConsent";
import {
  createListenPanel,
  initialState,
  markForm,
  pageOf,
  readout,
  FIRST_SCRIPT_ID,
  reseatable,
  step as stepOn,
  type MarkForm,
  type PanelEvent,
  type PanelState,
  type ListenControls,
  type Transport,
  type Visit,
} from "../src/listenPanel";
import { VOICE_IDS, type ConnectionReading } from "../src/modelAssets";
import { createMediaSession, type ActionDetails, type MediaAction } from "../src/mediaSession";
import { utteranceTable, type NeuralView } from "../src/neuralPerformer";
import type { Keeping, Residency } from "../src/modelResidency";
import type { Place, Speed } from "../src/performer";
import type { ReadAlongAt } from "../src/readAlong";
import type { Utterance } from "../src/speech";
import { emptyManifest, type UnitReport, type WordStart } from "../src/speechManifest";
import { landmarks, speechSegments, timeAt, timelineOfScript, timelineOfUtterances } from "../src/timeline";
import { prepareText, type SynthesisUnit, type VoiceMap } from "../src/speechScript";
import type { ListenPort, RenderedUnit, SynthesizeRequest } from "../src/synthesisClient";
import { encodeFile } from "../src/renditionFile";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { SCHEDULE_LEAD_S, type SegmentOffset } from "../src/unitPlayer";
import { BACKGROUND_LOOKAHEAD, LOOKAHEAD } from "../src/scheduler";
import { DEFAULT_PICK, DEFAULT_VOICES, PICKED_VOICES, readPick, writePick } from "../src/voiceChoice";
import { mountVoicePicker } from "../src/voicePicker";
import { samplePath } from "../src/voiceSample";
import { FRAME_S, frame, StubAudio, StubDevice } from "./playbackStub";
import { memoryPreferences, refusedPreferences } from "./preferenceStub";
import { forgetResume, printsOf, readResume, RESUME_PREFIX, writeResume, type PrintedPage } from "../src/keptPlace";

// No unit is being made: the model has begun no word of any.
const nothingBegun = (): ReadonlyArray<WordStart> => [];

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const throws = (label: string, f: () => unknown): void => {
  let threw = false;
  try {
    f();
  } catch {
    threw = true;
  }
  assert(label, threw);
};

// ── fixtures ──────────────────────────────────────────────────────────────────────────

// Two passages on two turns; the first is long enough for two units. The units hold
// CLONES of the utterances, as the worker's structured clone hands them back.
const one: Utterance = { index: 1, anchor: "t1", origin: "page", voice: "user", text: "First sentence here. Second sentence here." };
const two: Utterance = { index: 2, anchor: "t2", origin: "page", voice: "assistant", text: "A reply." };
const utterances = [one, two];
const page = pageOf(utterances);
const unit = (utterance: Utterance, start: number, end: number): SynthesisUnit => ({ utterance, start, end, ...prepareText(utterance.text.slice(start, end)) });
const units: SynthesisUnit[] = ((): SynthesisUnit[] => {
  const [a, b] = [{ ...one }, { ...two }];
  return [unit(a, 0, 20), unit(a, 21, 42), unit(b, 0, 8)];
})();
const table = utteranceTable(utterances, units);
// The page as the server renders it, prints and all, and the paste it is.
const printed: PrintedPage = { utterances, prints: await printsOf(utterances) };
const SLUG = "abc123";
// The pure step over this page: every state's answer to every event.
const step = (state: PanelState, event: PanelEvent): ReturnType<typeof stepOn> => stepOn(state, event, page);

// Worker messages arrive at the check's own time: zero unless a case reads the pace.
const worker = (message: FromWorker, at = 0): PanelEvent => ({ kind: "worker", message, at });
const tapPlay: PanelEvent = { kind: "tap", control: "play" };
const tapStop: PanelEvent = { kind: "tap", control: "stop" };
const progress = (loadedBytes: number, totalBytes: number, at = 0): PanelEvent => worker({ kind: "progress", progress: { loadedBytes, totalBytes } }, at);
const report = (durationMs: number): UnitReport => ({ durationMs, alignment: { kind: "unit" } });
const mark = (utterance: number, char = 0): Place => ({ utterance, char });
const seekTo = (utterance: number, char = 0): PanelEvent => ({ kind: "seek", to: { kind: "place", place: mark(utterance, char) } });
// Where a mark falls on the voice's clock before anything is measured, as the effect prints it.
const atMs = (utterance: number, char = 0): string => `${Math.round(timeAt(timelineOfScript(emptyManifest(units), table, nothingBegun), mark(utterance, char)))}ms`;
const supported: PanelEvent = worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
const ready: PanelEvent = worker({ kind: "ready", backend: "webgpu", modelVersion: "v" });
const scriptBack: PanelEvent = worker({ kind: "script", id: FIRST_SCRIPT_ID, units });

const scriptLine = timelineOfScript(emptyManifest(units), table, nothingBegun);
const viewOf = (player: NeuralView["player"], settled = false): NeuralView => ({
  player,
  manifest: emptyManifest(units),
  holdings: units.map(() => ({ kind: "absent" })),
  settled,
  timeline: scriptLine,
  units: speechSegments(scriptLine),
});
// The player's position at a unit: the segment of the layout that unit's slot is — unit 2
// sits past the gap, at segment 3.
const inUnit = (unit: number, offsetMs = 0): SegmentOffset => ({
  segment: [0, 1, 3][unit] ?? -1,
  offsetMs,
});

const effects = (s: ReturnType<typeof step>): string =>
  s.effects
    .map((e) =>
      e.kind === "perform"
        ? `perform ${e.event.kind}${e.event.kind === "seek" ? ` ${Math.round(e.event.toMs)}ms` : ""}`
        : e.kind === "release"
          ? `release ${e.worker}`
          : e.kind === "lookahead"
            ? `lookahead ${e.to === LOOKAHEAD ? "near" : e.to === BACKGROUND_LOOKAHEAD ? "far" : "?"}`
            : e.kind,
    )
    .join();
// A visit that remembered nothing, on a connection nobody metered: what every reader is
// until the hover says otherwise.
const ASKING: Visit = { remembered: false, metered: false, pick: DEFAULT_PICK, resume: null, gone: false };
const shown = (state: PanelState, visit: Visit = ASKING): string => {
  const r = readout(state, page, visit);
  return `${r.play.label}${r.play.enabled ? "" : "(off)"} | stop${r.stop.enabled ? "" : "(off)"} | ${r.status}${r.progress === null ? "" : ` | bar ${r.progress.loadedBytes}/${r.progress.totalBytes}`}`;
};
// The turn-skip and speed controls, as `readout` shows them.
const around = (state: PanelState, visit: Visit = ASKING): string => {
  const r = readout(state, page, visit);
  return `back${r.skip.back ? "" : "(off)"} | forward${r.skip.forward ? "" : "(off)"} | ${r.speed.label}${r.speed.slower ? "" : " slower(off)"}${r.speed.faster ? "" : " faster(off)"}`;
};
// The cue a voice starts from, as "utterance:char" — "top" when nobody named one; a voice on
// stage and under way has none to show.
// The voice's time on its own clock, as its last view reported it; -1 with no place.
const performerAt = (state: PanelState): number => {
  if (state.kind !== "neural" || state.view.player.kind === "idle") return -1;
  const { segment, offsetMs } = state.view.player.at;
  return (state.view.timeline.segments[segment]?.startMs ?? Number.NaN) + offsetMs;
};
const held = (state: PanelState): string => {
  if (state.kind === "neural" && state.view.player.kind !== "idle") return "on stage";
  const { cue } = state;
  return cue === null ? "top" : cue.kind === "speech" ? `${cue.place.utterance}:${cue.place.char}` : `gap before ${cue.before.utterance}:${cue.before.char}+${cue.offsetMs}`;
};
// The whole model, as the store that keeps nothing reports it; the panel rounds it up to
// the megabyte.
const WHOLE_MODEL = 238_500_001;
const MB = "239 MB";
// The start, before the store has answered: the driver asks it on every entry.
const IDLE_LINE = "Listen | stop(off) | Looking for the voice on this device…";
// The mount: the worker spawned at once to probe, with no consent yet, so Play still reads.
const MOUNT_LINE = "Listen | stop(off) | Checking this device for the voice…";
const RESIDENT_LINE = "Listen | stop(off) | The voice is on this device";
const ABSENT_LINE = "Listen | stop(off) | The voice downloads 239 MB once, then runs on this device";
const ABSENT: Residency = { kind: "absent", bytesToDownload: 239_000_000 };
const wake = (consent: StandingConsent): PanelEvent => ({ kind: "wake", consent });
const yes: PanelEvent = { kind: "yes" };
const home = (residency: Residency): PanelEvent => ({ kind: "home", residency });
const kept = (keeping: Keeping): PanelEvent => ({ kind: "keeping", keeping });

// ── the pure machine ──────────────────────────────────────────────────────────────────

console.log("step: the way to audio");
{
  const idle = initialState();
  assert("idle: Play is the only enabled control, the store is being asked, and nobody has named a place", shown(idle) === IDLE_LINE && held(idle) === "top");
  assert("the store's word, resident: the voice is on this device, before any tap", shown(step(idle, home({ kind: "resident" })).state) === RESIDENT_LINE);
  assert("absent: the bytes still to download are named, not the whole model", shown(step(idle, home({ kind: "absent", bytesToDownload: 120_000_000 })).state) === "Listen | stop(off) | The voice downloads 120 MB once, then runs on this device");
  assert("unavailable: the store's reason, and that each listen downloads the whole model", shown(step(idle, home({ kind: "unavailable", message: "private browsing", bytesToDownload: WHOLE_MODEL })).state) === `Listen | stop(off) | This browser can't keep the voice (private browsing); each listen downloads ${MB}`);
  assert("the keep request's answer is not asked of an idle voice, but shown if it arrives: denied names the consequence", shown(step(idle, kept({ kind: "denied" })).state) === "Listen | stop(off) | Looking for the voice on this device… · this browser may drop the voice when space is short; the next listen would download it again");
  const unopened = step(idle, home({ kind: "unavailable", message: "Storage directory access is denied.", bytesToDownload: WHOLE_MODEL })).state;
  const answers: ReadonlyArray<Keeping> = [{ kind: "granted" }, { kind: "denied" }, { kind: "failed", message: "no StorageManager" }];
  assert(
    "a store that cannot be opened keeps nothing, whatever the browser answers: no answer beside the store's word",
    answers.every((answer) => shown(step(unopened, kept(answer)).state) === `Listen | stop(off) | This browser can't keep the voice (Storage directory access is denied.); each listen downloads ${MB}`),
  );
  const probing = step(idle, tapPlay);
  assert("tap play from idle spends the gesture on the device, spawns the worker to probe and asks it for the script; Play has nothing more to say", effects(probing) === "hush,unlock,spawn,script" && shown(probing.state) === "Listen(off) | stop(off) | Checking this device for the voice…");
  const again = step(probing.state, tapPlay);
  assert("a tap while probing spends its gesture and changes nothing else", effects(again) === "hush,unlock" && shown(again.state) === shown(probing.state) && held(again.state) === "top");
  assert("a stop tap before there is anything to stop changes nothing", step(probing.state, tapStop).state === probing.state);

  const unsupported = step(probing.state, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } }));
  assert("unsupported: the reason is shown, nothing to tap, the worker and the device the tap opened are released", effects(unsupported) === "release terminate" && shown(unsupported.state) === "Listen(off) | stop(off) | This device can't run the voice: this browser has no WebGPU");
  assert("a tap on an unsupported device changes nothing", step(unsupported.state, tapPlay).state === unsupported.state);

  const preparing = step(probing.state, supported);
  assert("supported with the tap held: load is sent", effects(preparing) === "load" && shown(preparing.state) === "Listen(off) | stop(off) | Preparing the voice…");
  const downloading = step(preparing.state, progress(120_000_000, 239_000_000));
  assert("progress short of the total: downloading, with the percentage, the bytes, the bar, and no estimate from one sample", shown(downloading.state) === "Listen(off) | stop(off) | Downloading the voice · 50% · 120 of 239 MB · estimating time left… | bar 120000000/239000000");
  // 120 MB at t=0, 130 MB at t=10 s: 1 MB/s, 109 MB to go, about 2 min; the estimate reads
  // from the pace the phase carries.
  const nearlyDone = step(downloading.state, progress(238_600_000, 239_000_000, 10_000));
  assert("the last half-megabyte: the percentage, the downloaded figure and the size all say short of done", shown(nearlyDone.state).startsWith("Listen(off) | stop(off) | Downloading the voice · 99% · 238 of 239 MB · "));
  const paced = step(downloading.state, progress(130_000_000, 239_000_000, 10_000));
  assert("a later progress: the pace speaks, the percentage and the bytes move with it", shown(paced.state) === "Listen(off) | stop(off) | Downloading the voice · 54% · 130 of 239 MB · about 2 min left | bar 130000000/239000000");
  const stopped = step(paced.state, worker({ kind: "load-failed", failure: { kind: "network", url: "u", message: "offline" } }));
  assert("a failure mid-download keeps the bar where it stopped, under the failure and Retry", shown(stopped.state) === "Retry | stop(off) | The voice could not load: network error fetching u: offline | bar 130000000/239000000");
  const stoppedEarly = step(preparing.state, worker({ kind: "load-failed", failure: { kind: "network", url: "u", message: "offline" } }));
  assert("a failure before any byte has no bar", shown(stoppedEarly.state) === "Retry | stop(off) | The voice could not load: network error fetching u: offline");
  const warming = step(downloading.state, progress(239_000_000, 239_000_000));
  assert("the last byte: warming, no bar", shown(warming.state) === "Listen(off) | stop(off) | Warming up the voice…");

  const failed = step(warming.state, worker({ kind: "load-failed", failure: { kind: "http", url: "/models/x.part0", status: 503 } }));
  assert("load-failed: the failure is shown and Play becomes Retry", shown(failed.state) === "Retry | stop(off) | The voice could not load: HTTP 503 fetching /models/x.part0");
  const retried = step(failed.state, tapPlay);
  assert("retry spends its gesture and sends load again on the same worker", effects(retried) === "hush,unlock,load" && shown(retried.state).startsWith("Listen(off)"));

  const scripting = step(warming.state, ready);
  assert("ready: nothing more to send — the script was asked for at the spawn — and the script is what the voice waits on", effects(scripting) === "" && shown(scripting.state) === "Listen(off) | stop(off) | Preparing the script…");
  const restoring = step(scripting.state, scriptBack);
  assert("the units back: the device is asked what it keeps of them, the status unchanged", restoring.state.kind === "provisioning" && restoring.state.script.kind === "restoring" && effects(restoring) === "restore" && shown(restoring.state) === "Listen(off) | stop(off) | Preparing the script…");
  // The id is no longer `step`'s to judge: a page re-seated with the narrator's digests asks
  // again while the first ask may still be out, so which ask is standing is a fact of the
  // DRIVER, which drops every other reply before it reaches here [LAW:single-enforcer]. The
  // pure step takes the reply it is handed — and the driver's own check, further down, is
  // what proves a superseded script never reaches it.
  assert("the pure step builds over whatever reply the driver passed it", step(scripting.state, worker({ kind: "script", id: 7, units })).state.kind === "provisioning");
  const keptReports = [report(640), undefined, undefined];
  const answer = (asked: ReadonlyArray<SynthesisUnit>): PanelEvent => ({ kind: "restored", units: asked, voices: DEFAULT_VOICES, kept: keptReports });
  const built = step(restoring.state, answer(units));
  const build = built.effects[0];
  assert("the device's answer: the performer is built over those units, in the voices the answer was read in, with what it keeps; the phase unchanged until its first view", built.state === restoring.state && effects(built) === "build" && build?.kind === "build" && build.units === units && build.voices === DEFAULT_VOICES && build.kept === keptReports);
  assert("an answer about other units — a script a retry replaced — is stale: nothing built", effects(step(restoring.state, answer([...units]))) === "" && step(restoring.state, answer([...units])).state === restoring.state);
  assert("an answer with nothing being restored is stale: nothing built", effects(step(scripting.state, answer(units))) === "" && effects(step(idle, answer(units))) === "");
  const repicked = step(restoring.state, { kind: "voices", voices: { ...DEFAULT_VOICES, user: "marius" } });
  assert("a new pick while the device is asked: asked again, the state unchanged", effects(repicked) === "restore" && repicked.state === restoring.state);
  const fellRestoring = step(restoring.state, { kind: "worker-error", message: "gone" });
  assert("a crash while the device is asked: released, and the answer that follows is stale", effects(step(fellRestoring.state, answer(units))) === "");

  const listening = step(built.state, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("the performer's first view puts the voice on stage and sends it to the top: the tap was the consent", listening.state.kind === "neural" && effects(listening) === "hush,perform rate,perform seek 0ms" && shown(listening.state) === "Listen | stop(off) | Ready");
  assert("a seek on stage hushes any preview, then seeks the voice to the mark's time: an unmeasured passage's start", effects(step(listening.state, seekTo(1, 3))) === `hush,perform seek ${atMs(1)}`);

  // Speed is the panel's own value, not a performer's: set before any performer exists,
  // obeyed by the one that arrives, and outliving a crash and a teardown.
  const speedTo = (by: -1 | 1): PanelEvent => ({ kind: "speed", by });
  const slowedBeforeAnyVoice = step(idle, speedTo(-1));
  assert("a step down while no performer exists yet changes the state alone, nothing to perform", effects(slowedBeforeAnyVoice) === "" && slowedBeforeAnyVoice.state.speed === 0.75);
  assert("a step off the bottom of the list returns the same speed", step(slowedBeforeAnyVoice.state, speedTo(-1)).state.speed === 0.75);
  const fasterOnStage = step(listening.state, speedTo(1));
  assert("a step while the voice is on stage is performed on it at once", fasterOnStage.state.speed === 1.25 && effects(fasterOnStage) === "perform rate");
  const top = [0, 1, 2, 3, 4, 5].reduce((s) => step(s, speedTo(1)).state, listening.state);
  assert("stepping past the top of the list stops at its last value", top.speed === 2.5 && step(top, speedTo(1)).state.speed === 2.5 && effects(step(top, speedTo(1))) === "");
  assert("the neural voice's first view carries the reader's speed, set before it existed", (() => {
    const raised = step(built.state, speedTo(1));
    return raised.state.kind === "provisioning" && step(raised.state, { kind: "view", view: viewOf({ kind: "idle" }) }).state.speed === 1.25;
  })());
  const crashedFast = step(fasterOnStage.state, { kind: "worker-error", message: "x" });
  assert("a crash keeps the reader's speed, not the panel's default", crashedFast.state.speed === 1.25);
  const disposedFast = step(fasterOnStage.state, { kind: "dispose" });
  assert("a teardown is not the reader changing their mind: the speed survives it", disposedFast.state.speed === 1.25);
  const playing = step(listening.state, { kind: "view", view: viewOf({ kind: "speaking", at: inUnit(2), flow: "audio" }) });
  assert("tap play while speaking hushes any preview, then pauses", effects(step(playing.state, tapPlay)) === "hush,perform pause");
  assert("tap stop while speaking hushes any preview, then stops", effects(step(playing.state, tapStop)) === "hush,perform stop");
  const failedHolding: NeuralView["holdings"][number] = { kind: "failed", reason: { kind: "frame-cap", frames: 500 }, frames: "none" };
  const holdings: NeuralView["holdings"] = units.map((_, i): NeuralView["holdings"][number] => (i === 1 ? failedHolding : { kind: "absent" }));
  const withFailure = { ...viewOf({ kind: "speaking", at: inUnit(2), flow: "audio" }), holdings };
  const overrun = viewOf({ kind: "speaking", at: inUnit(1, (speechSegments(scriptLine)[1]?.ms ?? 0) + 5000), flow: "audio" });
  assert("a unit streaming past its guessed length is still its own passage: the status reads the segment, not the clock", shown(step(playing.state, { kind: "view", view: overrun }).state) === "Pause | stop | Playing · passage 1 of 2");
  const inGap = viewOf({ kind: "speaking", at: { segment: 2, offsetMs: 100 }, flow: "audio" });
  assert("inside the gap between turns the status names the passage the gap leads into", shown(step(playing.state, { kind: "view", view: inGap }).state) === "Pause | stop | Playing · passage 2 of 2");
  assert("a failed unit is named by its passage and its reason, after the player's own line", shown(step(playing.state, { kind: "view", view: withFailure }).state) === "Pause | stop | Playing · passage 2 of 2 · passage 1 of 2 could not be synthesized: the model looped for 500 frames without finishing");

  // A tap on the page: the place is kept for the voice's arrival.
  const tapped = step(idle, seekTo(1, 3));
  assert("a seek from idle spawns the worker like Play, and holds the place", effects(tapped) === "hush,unlock,spawn,script" && held(tapped.state) === "1:3");
  const tappedTwice = step(tapped.state, seekTo(0, 21));
  assert("a later seek replaces the place, spends its gesture and spawns nothing more", effects(tappedTwice) === "hush,unlock" && held(tappedTwice.state) === "0:21");
  const arriving = [supported, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, tappedTwice.state);
  assert("the place is held through the whole way to audio", held(arriving) === "0:21");
  const arrivedAtPlace = step(arriving, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("the voice arriving after a tap is sent to the tapped place", effects(arrivedAtPlace) === `hush,perform rate,perform seek ${atMs(0, 21)}` && arrivedAtPlace.state.kind === "neural");

  const crashed = step(downloading.state, { kind: "worker-error", message: "the worker bundle failed to load" });
  assert("a worker error while downloading: crashed, everything released, Play reads Retry", effects(crashed) === "release terminate,home" && shown(crashed.state) === "Retry | stop(off) | The voice failed: the worker bundle failed to load");
  assert("an error with no message still names the failure", shown(step(warming.state, { kind: "worker-error", message: "" }).state).endsWith("The voice failed"));
  const crashedOnStage = step(listening.state, { kind: "worker-error", message: "boom" });
  assert("a crash on stage while idle, nothing cued: released, and still nobody has named a place", effects(crashedOnStage) === "release terminate,home" && held(crashedOnStage.state) === "top");
  const fellPlaying = step(playing.state, { kind: "worker-error", message: "boom" });
  assert("a crash while playing keeps the reported place for the retry", held(fellPlaying.state) === "1:0" && shown(fellPlaying.state) === "Retry | stop(off) | The voice failed: boom");
  const fellRewoken = [wake("none"), supported, progress(1, 1), ready].reduce((state, event) => step(state, event).state, fellPlaying.state);
  assert("a crash while playing, then a wake: the voice comes back standing at the place, not speaking — the tap's yes went with its device", held(fellRewoken) === "1:0" && effects(step(fellRewoken, { kind: "view", view: viewOf({ kind: "idle" }) })) === "perform rate");
  throws("a view after the crash is a violation: the released performer's last view never reaches step", () => step(crashed.state, { kind: "view", view: viewOf({ kind: "idle" }) }));
  const respawned = step(fellPlaying.state, tapPlay);
  assert("Retry after a crash spawns a fresh worker and probes, the place still held — and, the script still held, asks the device what it keeps, to play it before the model is warm", effects(respawned) === "hush,unlock,spawn,restore" && held(respawned.state) === "1:0" && shown(respawned.state).startsWith("Listen(off)"));
  const disposedMid = step(playing.state, { kind: "dispose" });
  assert("dispose, anywhere: back to the start, the live worker asked to dispose", shown(disposedMid.state) === IDLE_LINE && held(disposedMid.state) === "top" && effects(disposedMid) === "hush,release dispose,home");

  // The browser's answer to keeping the bytes rides the status line while the voice is on
  // its way; a late answer to a voice on stage changes nothing.
  const kept1 = step(preparing.state, kept({ kind: "granted" }));
  assert("keeping granted while preparing: said beside the phase", shown(kept1.state) === "Listen(off) | stop(off) | Preparing the voice… · this browser will keep the voice");
  const kept2 = step(step(kept1.state, progress(1, 2)).state, kept({ kind: "failed", message: "no StorageManager" }));
  assert("a keep request that failed: its message, beside the download", shown(kept2.state) === "Listen(off) | stop(off) | Downloading the voice · 50% · 0 of 1 MB · estimating time left… · this browser could not be asked to keep the voice: no StorageManager | bar 1/2");
  assert("an answer after the voice took the stage changes nothing", step(listening.state, kept({ kind: "denied" })).state === listening.state && step(listening.state, home({ kind: "resident" })).state === listening.state);
  assert("a crash returns to the start with the store asked again, the last answer dropped", (() => { const s = step(kept1.state, { kind: "worker-error", message: "x" }).state; return s.kind === "provisioning" && s.home.kind === "reading" && s.keeping === null; })());
}

console.log("step: a script in hand puts the voice on stage before the model is warm, and the model loads behind it");
{
  const idle = initialState();
  const offer = (state: PanelState): string => readout(state, page, ASKING).voices.audition.kind;
  const woken = step(idle, wake("none"));
  const scripted = step(woken.state, scriptBack);
  assert("the script answered before the probe — from the device — with no consent: held, nothing else done", effects(scripted) === "" && shown(scripted.state) === MOUNT_LINE);
  const played = step(scripted.state, tapPlay);
  assert("Play: the gesture spent, and the device asked what it keeps of the script's units at once — no model to wait for", effects(played) === "hush,unlock,restore" && shown(played.state) === "Listen(off) | stop(off) | Preparing the script…");
  const restoring = played.state;
  if (restoring.kind !== "provisioning" || restoring.script.kind !== "restoring") throw new Error("fixture: not restoring");
  const built = step(restoring, { kind: "restored", units: restoring.script.units, voices: DEFAULT_VOICES, kept: [report(640), report(640), report(320)] });
  assert("the device's answer builds the performer, with the model still probing", effects(built) === "build");
  const onStage = step(built.state, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("on stage while the model probes: sent to its place, the line saying where the model is, voices heard from their samples", onStage.state.kind === "neural" && effects(onStage) === "hush,perform rate,perform seek 0ms" && shown(onStage.state) === "Listen | stop(off) | Ready · checking this device for the voice…" && offer(onStage.state) === "sample");
  const loadingBehind = step(onStage.state, supported);
  assert("the probe answers behind the stage: the load goes on the Play's consent", effects(loadingBehind) === "load" && loadingBehind.state.kind === "neural");
  const kept = step(loadingBehind.state, { kind: "view", view: viewOf({ kind: "speaking", at: inUnit(0), flow: "audio" }) });
  assert("playing what the device keeps, the model preparing behind it", shown(kept.state) === "Pause | stop | Playing · passage 1 of 2 · preparing the voice…");
  const downloading = step(kept.state, progress(120_000_000, 239_000_000));
  assert("the download behind a playing voice: its line and its bar", shown(downloading.state) === "Pause | stop | Playing · passage 1 of 2 · downloading the voice · 50% · 120 of 239 MB · estimating time left… | bar 120000000/239000000");
  const waiting = step(downloading.state, { kind: "view", view: viewOf({ kind: "speaking", at: inUnit(1), flow: "waiting" }) });
  assert("a unit the device does not keep waits for the voice, and says so — not \"synthesizing\" with no model to synthesize", shown(waiting.state) === "Pause | stop | Waiting for the voice · passage 1 of 2 · downloading the voice · 50% · 120 of 239 MB · estimating time left… | bar 120000000/239000000");
  const warmed = [progress(1, 1), ready].reduce((state, event) => step(state, event).state, waiting.state);
  assert("the model ready behind it: the line is the voice's alone, synthesizing ahead, and voices are heard live", shown(warmed) === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && offer(warmed) === "live");
  const savable = (state: PanelState): boolean => {
    const face = readout(state, page, ASKING).mini;
    return face.kind === "controls" && face.save;
  };
  assert("a download is offered once the model is ready, and not while the voice plays what the device keeps ahead of it — nothing is rendered until then", !savable(kept.state) && !savable(waiting.state) && savable(warmed));
  assert("a voice heard before the model is ready: the reading paused, its sample played; once ready, the voice itself", effects(step(waiting.state, { kind: "preview", voice: "marius" })) === "perform pause,hush,sample" && effects(step(warmed, { kind: "preview", voice: "marius" })) === "perform pause,hush,preview");

  const failed = step(downloading.state, worker({ kind: "load-failed", failure: { kind: "network", url: "u", message: "offline" } }));
  assert("a load that fails behind a playing voice is on the line, where it stopped, and the voice plays on", failed.state.kind === "neural" && effects(failed) === "" && shown(failed.state) === "Pause | stop | Playing · passage 1 of 2 · the voice could not load: network error fetching u: offline | bar 120000000/239000000");
  assert("nor once its load has failed, where a download would wait on a model that is not coming", !savable(failed.state));
  assert("the reader's Pause asks nothing of the model", effects(step(failed.state, tapPlay)) === "hush,perform pause");
  const paused = step(failed.state, { kind: "view", view: viewOf({ kind: "paused", at: inUnit(0) }) }).state;
  const replayed = step(paused, tapPlay);
  assert("the reader's Play tries the load again", effects(replayed) === "hush,perform play,load" && shown(replayed.state).includes("preparing the voice…"));
  assert("and so does the yes, and a wake, the Play's consent still held", effects(step(failed.state, yes)) === "load" && effects(step(failed.state, wake("none"))) === "load");

  const unable = step(onStage.state, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } }));
  assert("a device found unable behind the stage: the voice leaves it, released, the reason on the line", unable.state.kind === "provisioning" && effects(unable) === "release terminate,home" && shown(unable.state) === "Listen(off) | stop(off) | This device can't run the voice: this browser has no WebGPU");
  const fell = step(kept.state, { kind: "worker-error", message: "boom" });
  const retried = step(fell.state, tapPlay);
  assert("a crash behind the stage keeps the script: Retry puts the voice back on stage without asking for it again", effects(retried) === "hush,unlock,spawn,restore" && held(retried.state) === "0:0");

  const standing = step(step(woken.state, wake("download")).state, supported);
  const standingScripted = step(standing.state, scriptBack);
  assert("a yes to the download alone, the script in hand: the voice waits for the model, as a voice standing ready always has", effects(standing) === "load" && effects(standingScripted) === "" && shown(standingScripted.state) === "Listen | stop(off) | Preparing the voice…");
  assert("and takes the stage when the model is ready", effects(step(step(standingScripted.state, progress(1, 1)).state, ready)) === "restore");
  assert("no consent at all, the script in hand, the worker able: nothing is built and nothing loads", effects(step(scripted.state, supported)) === "");
}

console.log("step: consent is the only door to the weights");
{
  const idle = initialState();
  const woken = step(idle, wake("none"));
  assert("the page's wake with nothing remembered: the worker is spawned to probe and asked for the script, no gesture spent, and Play still reads", effects(woken) === "spawn,script" && shown(woken.state) === MOUNT_LINE);
  assert("a second wake while probing changes nothing", effects(step(woken.state, wake("none"))) === "" && shown(step(woken.state, wake("none")).state) === MOUNT_LINE);
  const able = step(woken.state, supported);
  assert("supported with no consent: nothing is sent; the line is the store's word", effects(able) === "" && shown(able.state) === IDLE_LINE);
  const absent = step(able.state, home(ABSENT));
  assert("the store's word, absent: the download named, Play offered, nothing fetched", shown(absent.state) === ABSENT_LINE && markForm(absent.state).kind === "download");
  const standing = step(absent.state, wake("download"));
  assert("a remembered yes given to an able voice: load, no gesture, and Play still reads — a tap would make it speak on arrival", effects(standing) === "load" && shown(standing.state) === "Listen | stop(off) | Preparing the voice…");
  const said = step(absent.state, yes);
  assert("the hover's yes to an able voice: the gesture spent, then load", effects(said) === "unlock,load" && shown(said.state) === "Listen | stop(off) | Preparing the voice…");
  const tappedAble = step(absent.state, tapPlay);
  assert("Play on an able voice: the gesture spent, then load, and Play has nothing more to say", effects(tappedAble) === "hush,unlock,load" && shown(tappedAble.state) === "Listen(off) | stop(off) | Preparing the voice…");
  const raised = step(said.state, tapPlay);
  assert("Play while the download a yes started runs: the gesture spent, the consent raised to speak", effects(raised) === "hush,unlock" && shown(raised.state) === "Listen(off) | stop(off) | Preparing the voice…");
  const arrivedReady = [progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, said.state);
  const standingReady = step(arrivedReady, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("a voice that arrives on a download alone takes the stage and stands ready: no seek, nothing spoken", standingReady.state.kind === "neural" && effects(standingReady) === "perform rate" && shown(standingReady.state) === "Listen | stop(off) | Ready");
  const arrivedSpeaking = [progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, raised.state);
  assert("a voice that arrives after the consent was raised is sent to its place", effects(step(arrivedSpeaking, { kind: "view", view: viewOf({ kind: "idle" }) })) === "hush,perform rate,perform seek 0ms");

  const yesFirst = step(idle, yes);
  assert("the hover's yes before the probe: the gesture spent and the worker spawned", effects(yesFirst) === "unlock,spawn,script" && shown(yesFirst.state) === MOUNT_LINE);
  assert("and the consent is held for the probe's answer: supported loads at once", effects(step(yesFirst.state, supported)) === "load");
  assert("a wake while probing after a yes changes nothing", effects(step(yesFirst.state, wake("none"))) === "" && effects(step(yesFirst.state, wake("download"))) === "");

  const unsupported = step(woken.state, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-adapter" } } }));
  assert("unsupported at mount: the reason, Play off, the worker released", effects(unsupported) === "release terminate" && shown(unsupported.state) === "Listen(off) | stop(off) | This device can't run the voice: no graphics adapter is available");
  assert("neither a yes nor a wake nor a tap does anything to an unsupported device: no gesture is even spent", [yes, wake("download"), tapPlay].every((event) => shown(step(unsupported.state, event).state) === shown(unsupported.state) && effects(step(unsupported.state, event)) === ""));
  assert("a word on an unsupported device keeps its place, as everywhere, and starts nothing", effects(step(unsupported.state, seekTo(1))) === "" && held(step(unsupported.state, seekTo(1)).state) === "1:0" && shown(step(unsupported.state, seekTo(1)).state) === shown(unsupported.state));

  // The consent outlives a crash — the retry is the same listen — and dies with a dispose.
  const crashedStanding = step(step(standing.state, progress(1, 2)).state, { kind: "worker-error", message: "x" });
  assert("a crash while a remembered download runs: Retry, the consent kept", shown(crashedStanding.state) === "Retry | stop(off) | The voice failed: x");
  const rewoken = step(crashedStanding.state, wake("download"));
  assert("a wake after the crash, the yes still standing, spawns again, and asks again for the script the fallen worker never answered", effects(rewoken) === "spawn,script");
  assert("and the standing yes loads on the probe's answer", effects(step(rewoken.state, supported)) === "load");
  const withdrawn = step(step(crashedStanding.state, wake("none")).state, supported);
  assert("a wake with the yes withdrawn — the box unchecked, the connection metered — probes and waits", effects(withdrawn) === "" && shown(withdrawn.state) === IDLE_LINE);
  const idleOnStage = step(standingReady.state, { kind: "worker-error", message: "x" });
  const idleRetried = [tapPlay, supported, progress(1, 1), ready].reduce((state, event) => step(state, event).state, idleOnStage.state);
  assert("a crash on stage while idle, then Retry: the tap is the consent, the voice arrives and speaks", effects(step(idleRetried, { kind: "view", view: viewOf({ kind: "idle" }) })) === "hush,perform rate,perform seek 0ms");
  const idleRewoken = [wake("download"), supported, progress(1, 1), ready].reduce((state, event) => step(state, event).state, idleOnStage.state);
  assert("a crash on stage while idle, then a wake: the voice comes back standing ready, not speaking", effects(step(idleRewoken, { kind: "view", view: viewOf({ kind: "idle" }) })) === "perform rate");
  // A failed load is retried on the consent still held: the standing yes while it stands, the
  // reader's own yes whatever the box says.
  const loadFailed = worker({ kind: "load-failed", failure: { kind: "network", url: "u", message: "offline" } });
  const failedStanding = step(standing.state, loadFailed);
  assert("a remembered download fails, then the box is unchecked: the wake withdraws the yes, nothing is sent again", effects(step(failedStanding.state, wake("none"))) === "" && shown(step(failedStanding.state, wake("none")).state) === shown(failedStanding.state));
  assert("a wake with the yes still standing retries the failed load", effects(step(failedStanding.state, wake("download"))) === "load");
  assert("the reader's own yes is not the box's to withdraw: a wake with nothing standing retries the load the hover's yes started", effects(step(step(said.state, loadFailed).state, wake("none"))) === "load");
  const disposed = step(standing.state, { kind: "dispose" });
  const disposedWoken = step(step(disposed.state, wake("none")).state, supported);
  assert("a dispose forgets the consent: the next wake probes and waits", effects(disposedWoken) === "" && shown(disposedWoken.state) === IDLE_LINE);
}

console.log("step: out of view the voice is made further ahead, pauses when it runs dry, and plays again when its audio is held or the page is back");
{
  const hide: PanelEvent = { kind: "visibility", hidden: true };
  const show: PanelEvent = { kind: "visibility", hidden: false };
  const view = (player: NeuralView["player"], settled = false): PanelEvent => ({ kind: "view", view: viewOf(player, settled) });
  const speakingAt = (flow: "audio" | "waiting"): NeuralView["player"] => ({ kind: "speaking", at: { segment: 0, offsetMs: 100 }, flow });
  const pausedAt: NeuralView["player"] = { kind: "paused", at: { segment: 0, offsetMs: 100 } };
  const onStage = [wake("download"), supported, progress(1, 1), ready, scriptBack, { kind: "view", view: viewOf({ kind: "idle" }) } as PanelEvent, tapPlay, view(speakingAt("audio"))].reduce((state, event) => step(state, event).state, initialState());
  const visibilityOf = (state: PanelState): string => state.visibility;

  const hidden = step(onStage, hide);
  assert("the page out of view mid-listen: the audio is made further ahead, nothing else", effects(hidden) === "lookahead far" && visibilityOf(hidden.state) === "hidden");
  assert("in view, a voice waiting on its audio is left to wait, as it always was", effects(step(onStage, view(speakingAt("waiting")))) === "" && visibilityOf(step(onStage, view(speakingAt("waiting"))).state) === "shown");
  const dry = step(hidden.state, view(speakingAt("waiting")));
  assert("out of view, the voice runs dry: paused, and marked stalled; the listen is still on, so the window stays wide", effects(dry) === "perform pause" && visibilityOf(dry.state) === "stalled");
  assert("a view before the pause lands asks for no second pause", effects(step(dry.state, view(speakingAt("waiting")))) === "" && visibilityOf(step(dry.state, view(speakingAt("waiting"))).state) === "stalled");
  const held = step(dry.state, view(pausedAt));
  assert("the pause lands with nothing held yet: it stands, the line says why, and the transport offers Pause — to the reader the listen is on", effects(held) === "" && visibilityOf(held.state) === "stalled" && shown(held.state) === "Pause | stop | Paused in the background until the voice catches up · passage 1 of 2");
  assert("hidden again while stalled changes nothing", effects(step(held.state, hide)) === "" && visibilityOf(step(held.state, hide).state) === "stalled");
  const caught = step(held.state, view(pausedAt, true));
  assert("the audio it needs is held: it plays again, still stalled until it sounds, the window wide throughout", effects(caught) === "perform play" && visibilityOf(caught.state) === "stalled");
  const sounding = step(caught.state, view(speakingAt("audio")));
  assert("it sounds: the stall is over, out of view, nothing more to do", effects(sounding) === "" && visibilityOf(sounding.state) === "hidden");
  const back = step(held.state, show);
  assert("or the page is back first: it plays again, to wait in view, and the window narrows", effects(back) === "perform play,lookahead near" && visibilityOf(back.state) === "shown");
  const taken = step(held.state, tapPlay);
  assert("the reader's tap — the lock screen's pause, a headset's — is a real pause of a stalled voice: the window narrows", effects(taken) === "hush,perform pause,lookahead near" && visibilityOf(taken.state) === "hidden" && shown(taken.state).startsWith("Resume | stop | Paused ·"));
  assert("and audio held after it plays nothing: the pause is the reader's", effects(step(taken.state, view(pausedAt, true))) === "");
  const readerPausing = step(hidden.state, tapPlay);
  assert("a pause the reader makes out of view is sent, the window wide until it lands", effects(readerPausing) === "hush,perform pause");
  const readerPaused = step(readerPausing.state, view(pausedAt, true));
  assert("it lands: nobody is hearing the listen, so the window narrows, and audio held plays nothing", effects(readerPaused) === "lookahead near" && visibilityOf(readerPaused.state) === "hidden");
  assert("the reader plays it again out of view: once it speaks, the window widens", effects(step(step(readerPaused.state, tapPlay).state, view(speakingAt("audio")))) === "lookahead far");
  const skipped = step(held.state, { kind: "seek", to: { kind: "time", ms: 0 } });
  assert("a skip or scrub while stalled moves the voice and leaves the listen on: still stalled, the window wide", effects(skipped) === "hush,perform seek 0ms" && visibilityOf(skipped.state) === "stalled");
  assert("and its audio held at the new place plays it", effects(step(skipped.state, view(pausedAt, true))) === "perform play");
  const gone = step(held.state, view({ kind: "idle" }));
  assert("a stalled voice that leaves the stage — its last unit failed and skipped — is no longer stalled: the window narrows, and the transport offers Listen", effects(gone) === "lookahead near" && visibilityOf(gone.state) === "hidden" && shown(gone.state).startsWith("Listen | "));
  const crashed = step(held.state, { kind: "worker-error", message: "x" });
  assert("a crash while stalled keeps that the page is out of view, and nothing of the background's pause", visibilityOf(crashed.state) === "hidden");

  const early = step(initialState(), hide);
  assert("out of view before any voice: remembered, nothing to tell", effects(early) === "" && visibilityOf(early.state) === "hidden");
  const arrivedHidden = [wake("download"), supported, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, early.state);
  const standing = step(arrivedHidden, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("a voice that takes the stage out of view and stands ready is made no further ahead than in view", effects(standing) === "perform rate");
  assert("played out of view: once it speaks, it is made far ahead", effects(step(step(standing.state, tapPlay).state, view(speakingAt("audio")))) === "lookahead far");
}

console.log("step: a link's cue is where the voice starts, and the offer to resume stands while nobody has named a place");
{
  const idle = initialState();
  const cueAt = (utterance: number, char: number): PanelEvent => ({ kind: "cue", to: mark(utterance, char) });
  const cued = step(idle, cueAt(1, 2));
  assert("a link's cue before any voice is held, and nothing else: no gesture spent, no worker, no consent", effects(cued) === "" && held(cued.state) === "1:2" && cued.state.consent.given === "none" && cued.state.consent.standing === "none");
  const standing = [wake("download"), supported, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, cued.state);
  const stood = step(standing, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("a voice that arrives on a download alone stands ready at the cue, saying nothing", stood.state.kind === "neural" && effects(stood) === "perform rate" && held(stood.state) === "1:2");
  const played = step(stood.state, tapPlay);
  assert("Play on a cued voice standing ready is a seek to the cue, which starts it there; the cue is spent", effects(played) === `hush,perform seek ${atMs(1, 2)}` && held(played.state) === "top");
  assert("Stop, or a seek, on a cued voice leaves the cue behind with the moment it named", effects(step(stood.state, tapStop)) === "hush,perform stop" && held(step(stood.state, tapStop).state) === "top" && held(step(stood.state, seekTo(0, 21)).state) === "top");
  const underWay = step(played.state, { kind: "view", view: viewOf({ kind: "speaking", at: inUnit(0), flow: "audio" }) }).state;
  assert("a link's cue while the voice is under way moves the voice there, as a seek would", effects(step(underWay, cueAt(1, 2))) === `hush,perform seek ${atMs(1, 2)}` && held(step(underWay, cueAt(1, 2)).state) === "on stage");
  const arrived = [tapPlay, supported, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, cued.state);
  assert("a Play tap after a link's cue: the voice arrives and is sent to the cue", effects(step(arrived, { kind: "view", view: viewOf({ kind: "idle" }) })) === `hush,perform rate,perform seek ${atMs(1, 2)}`);
  assert("a crash while standing cued keeps the cue for the retry", held(step(stood.state, { kind: "worker-error", message: "x" }).state) === "1:2");

  const offered = (state: PanelState, visit: Visit): string => {
    const offer = readout(state, page, visit).offer;
    return offer === null ? "none" : offer.kind === "gone" ? "gone" : `resume ${offer.place.utterance}:${offer.place.char} “${offer.words}”`;
  };
  const RETURNING: Visit = { ...ASKING, resume: mark(0, 0) };
  assert("nothing kept: no offer", offered(idle, ASKING) === "none");
  assert("a place kept: the offer quotes its opening words, and says there is more", offered(idle, RETURNING) === "resume 0:0 “First sentence here. Second sentence…”");
  assert("fewer than five words to the end: the offer quotes them all, with nothing trailing", offered(idle, { ...ASKING, resume: mark(1, 2) }) === "resume 1:2 “reply.”");
  assert("the offer stands on a voice standing ready with nothing cued", offered(played.state, RETURNING) === "resume 0:0 “First sentence here. Second sentence…”");
  const unsupported = step(step(idle, wake("none")).state, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } })).state;
  assert(
    "no offer once a place is named — a cue, a tap on a word, a voice under way, a Play given to a voice on its way — nor on a device that cannot play it",
    [cued.state, stood.state, step(idle, seekTo(1)).state, underWay, step(idle, tapPlay).state, unsupported].every((state) => offered(state, RETURNING) === "none"),
  );
  assert("a link whose moment is gone is said before the kept place, and only while nobody has named one", offered(idle, { ...RETURNING, gone: true }) === "gone" && offered(underWay, { ...RETURNING, gone: true }) === "none");
  const share = (state: PanelState): boolean => {
    const face = readout(state, page, ASKING).mini;
    return face.kind === "controls" && face.share;
  };
  assert("the share control has a moment to link exactly when there is a cue or a voice under way", share(stood.state) && share(underWay) && !share(played.state));
}

console.log("readout: every form the mark can take, and the question its hover asks");
{
  const idle = initialState();
  const probing = step(idle, wake("none")).state;
  const able = step(probing, supported).state;
  const preparing = step(able, yes).state;
  const downloading = step(preparing, progress(60_000_000, 240_000_000)).state;
  const warming = step(downloading, progress(1, 1)).state;
  const scripting = step(warming, ready).state;
  const onStage = step(step(scripting, scriptBack).state, { kind: "view", view: viewOf({ kind: "idle" }) }).state;
  const at = (player: NeuralView["player"]): PanelState => step(onStage, { kind: "view", view: viewOf(player) }).state;
  // [LAW:types-are-the-program] One state per form: a form added to the union without a
  // row here does not compile, and a row whose state does not project to its form fails.
  const forms: Record<MarkForm["kind"], PanelState> = {
    checking: probing,
    ready: step(able, home({ kind: "resident" })).state,
    download: step(able, home(ABSENT)).state,
    unavailable: step(able, home({ kind: "unavailable", message: "private browsing", bytesToDownload: WHOLE_MODEL })).state,
    downloading,
    warming,
    speaking: at({ kind: "speaking", at: inUnit(0), flow: "audio" }),
    paused: at({ kind: "paused", at: inUnit(0) }),
    unsupported: step(probing, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } })).state,
    failed: step(warming, worker({ kind: "load-failed", failure: { kind: "integrity", key: "k", expected: "a", actual: "b" } })).state,
  };
  // The page draws the form by `data-state`: a form the stylesheet does not draw is a
  // state the reader cannot see.
  const css = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");
  for (const [kind, state] of Object.entries(forms)) {
    assert(`${kind}: the state projects to its form, and the stylesheet draws it`, markForm(state).kind === kind && css.includes(`.listen-mark[data-state="${kind}"]`));
  }
  assert("the store's word shows through the probe and the wait alike", markForm(step(probing, home({ kind: "resident" })).state).kind === "ready" && markForm(step(able, home({ kind: "resident" })).state).kind === "ready");
  assert("downloading carries how far, for the ring", (() => { const f = markForm(downloading); return f.kind === "downloading" && f.fraction === 0.25; })());
  assert("preparing and scripting are warming to the eye", markForm(preparing).kind === "warming" && markForm(scripting).kind === "warming");
  assert("a crash is a failure", markForm(step(downloading, { kind: "worker-error", message: "x" }).state).kind === "failed");
  assert("the voice on stage and idle is ready", markForm(onStage).kind === "ready");

  const ask = (state: PanelState, visit: Visit = ASKING): string | null => {
    const { mini } = readout(state, page, visit);
    return mini.kind === "consent" ? mini.ask : null;
  };
  const promised = step(step(idle, wake("download")).state, home(ABSENT)).state;
  assert("a held consent through the probe: checking to the eye, as the sentence says, nothing to ask", markForm(promised).kind === "checking" && ask(promised) === null && shown(promised) === MOUNT_LINE);
  assert("download needed: the mini-player asks, with the size", ask(forms.download) === "Download speech model? · 239 MB");
  assert("a store that cannot keep the voice: the mini-player asks for the whole model, and says it will every listen", ask(forms.unavailable) === `Download speech model? · ${MB} · every listen, since this browser can't keep it`);
  assert("remembered on a metered connection: the hover says why it asks anyway", ask(forms.download, { ...ASKING, remembered: true, metered: true }) === "Download speech model? · 239 MB · asking because this connection is metered");
  assert("remembered off a metered connection: no note", ask(forms.download, { ...ASKING, remembered: true, metered: false }) === "Download speech model? · 239 MB");
  assert("not remembered on a metered connection: no note — nothing is being overridden", ask(forms.download, { ...ASKING, remembered: false, metered: true }) === "Download speech model? · 239 MB");
  assert("nothing to ask when the voice is here, on its way, on stage, or impossible", [forms.ready, forms.checking, forms.downloading, forms.warming, forms.speaking, forms.paused, forms.unsupported, forms.failed].every((state) => ask(state) === null));
  assert("the preference's box reads the visit", readout(forms.download, page, { ...ASKING, remembered: true, metered: false }).remembered && !readout(forms.download, page, ASKING).remembered);

  // The turn skips and the speed control read the conversation, not the voice: they are
  // there before any performer exists and unaffected by consent or download state.
  assert("before any voice, standing at the top: no turn before it, one after it", around(idle) === "back(off) | forward | 1×");
  assert("standing at the second turn: back to the first, nothing after it", around(step(idle, seekTo(1)).state) === "back | forward(off) | 1×");
  assert("a place partway into the second turn, before any voice: back to the gap before it, nothing after it", around(step(idle, seekTo(1, 5)).state) === "back | forward(off) | 1×");
  assert("a place partway into the first passage, before any voice: the voice would begin it at the top, so no turn before it", around(step(idle, seekTo(0, 5)).state) === "back(off) | forward | 1×");
  assert("the same landmarks hold once the voice is on stage", around(onStage) === "back(off) | forward | 1×");
  assert("the speed label follows the state's own speed, and both ends disable their step", (() => {
    const slowest = step(onStage, { kind: "speed", by: -1 }).state;
    const fastest = [0, 1, 2, 3, 4, 5].reduce((s) => step(s, { kind: "speed", by: 1 }).state, onStage);
    return around(slowest) === "back(off) | forward | 0.75× slower(off)" && around(fastest) === "back(off) | forward | 2.5× faster(off)";
  })());
}

console.log("step: violations throw");
{
  const idle = initialState();
  throws("capability outside probing", () => step(idle, supported));
  throws("progress outside loading", () => step(idle, progress(1, 2)));
  throws("ready outside loading", () => step(step(idle, tapPlay).state, ready));
  throws("script outside scripting", () => step(idle, scriptBack));
  throws("a view before there is a performer", () => step(idle, { kind: "view", view: viewOf({ kind: "idle" }) }));
  throws("a synthesis message before the voice is on stage", () => step(idle, worker({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) })));
  throws("refused while the voice is on its way", () => step(idle, worker({ kind: "refused", request: { kind: "load" }, phase: "loading" })));
  throws("disposed, anywhere: the port ends the worker on it first", () => step(idle, worker({ kind: "disposed" })));
}

console.log("readout: the voice picker, cold, warm and mid-listen");
{
  const idle = initialState();
  const probing = step(idle, wake("none")).state;
  const onStage = step(step(step(step(step(step(probing, supported).state, yes).state, progress(1, 1)).state, ready).state, scriptBack).state, { kind: "view", view: viewOf({ kind: "idle" }) }).state;
  const speaking = step(onStage, { kind: "view", view: viewOf({ kind: "speaking", at: inUnit(0), flow: "audio" }) }).state;
  const unsupported = step(probing, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } })).state;
  const voices = (state: PanelState, visit: Visit = ASKING): string => {
    const v = readout(state, page, visit).voices;
    return `${v.picked.user}/${v.picked.assistant} | ${v.audition.kind === "live" ? "live" : `samples: ${v.audition.note}`} | ${v.sounding ?? "silent"} | reset ${v.reset ? "on" : "off"}`;
  };
  const COLD = "alba/javert | samples: Samples · the voice itself plays once it is ready on this device. | silent | reset off";
  assert("cold: the defaults, voices heard from their samples with the note saying so, nothing sounding, nothing to reset", voices(idle) === COLD && voices(probing) === COLD);
  assert("a device that cannot run the voice: samples still, with the honest note", voices(unsupported) === "alba/javert | samples: Samples · this device can't run the voice itself. | silent | reset off");
  assert("on stage, idle or speaking: voices heard live", voices(onStage) === "alba/javert | live | silent | reset off" && voices(speaking) === "alba/javert | live | silent | reset off");
  const chosen: Visit = { ...ASKING, pick: { user: "marius", assistant: "javert" } };
  assert("the picker reads the device's pick, and a pick off the defaults can be reset", voices(onStage, chosen) === "marius/javert | live | silent | reset on");

  const tapped = step(speaking, { kind: "preview", voice: "azelma" });
  assert("a preview tapped on stage: the reading is paused and the phrase sounding hushed, then the previewer speaks", effects(tapped) === "perform pause,hush,preview" && tapped.state === speaking);
  const refusedPreview = step(speaking, worker({ kind: "refused", request: { kind: "synthesize", unitId: -1, text: { ...prepareText("x"), source: "x" }, voice: "azelma" }, phase: "idle" }));
  assert("a refusal with the voice on stage: the performer that asked judges it, the panel stays", effects(refusedPreview) === "" && refusedPreview.state === speaking);
  assert("a voice tapped before the voice is on stage: its sample over whatever sounded, nothing to pause", effects(step(probing, { kind: "preview", voice: "azelma" })) === "hush,sample" && effects(step(idle, { kind: "preview", voice: "azelma" })) === "hush,sample");
  const heard = step(speaking, { kind: "sounding", voice: "azelma" }).state;
  assert("the previewer's word: the voice sounding shows", voices(heard) === "alba/javert | live | azelma | reset off");
  assert("and clears when it is over", voices(step(heard, { kind: "sounding", voice: null }).state) === "alba/javert | live | silent | reset off");
  const sampled = step(probing, { kind: "sounding", voice: "azelma" }).state;
  assert("the sample player's word before the voice is on stage: the voice sounding shows there too", voices(sampled) === "alba/javert | samples: Samples · the voice itself plays once it is ready on this device. | azelma | reset off");
  const staged = step(step(step(step(step(step(sampled, supported).state, yes).state, progress(1, 1)).state, ready).state, scriptBack).state, { kind: "view", view: viewOf({ kind: "idle" }) }).state;
  assert("a sample sounding as the voice comes on stage for a download: still shown sounding there, and playing on", voices(staged) === "alba/javert | live | azelma | reset off");
  assert("a Play while a sample sounds hushes it before anything else", effects(step(step(sampled, supported).state, tapPlay)).startsWith("hush,unlock"));
  assert("a Download leaves a sample sounding", !effects(step(step(sampled, supported).state, yes)).startsWith("hush"));
  const spoken = [supported, tapPlay, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, sampled);
  assert("the voice a Play brought comes on stage: its entry hushes the sample sounding before it speaks", effects(step(spoken, { kind: "view", view: viewOf({ kind: "idle" }) })) === "hush,perform rate,perform seek 0ms");
  const map = { user: "marius", assistant: "javert", system: "eponine", narrator: "javert" } as const;
  assert("the pick changes on stage: the performer is told", effects(step(speaking, { kind: "voices", voices: map })) === "revoice");
  assert("the pick changes before the voice is on stage: nothing to tell, the build reads the pick", effects(step(probing, { kind: "voices", voices: map })) === "" && effects(step(idle, { kind: "voices", voices: map })) === "");
}

// ── the driver ────────────────────────────────────────────────────────────────────────

// The page's markup for the panel and the mark, inert as the template renders it.
const MARKUP = `<!DOCTYPE html><body>
  <div class="speech-controls">
    <button class="speech-play" type="button"></button>
    <button class="speech-stop" type="button" disabled></button>
    <button class="speech-back" type="button" disabled></button>
    <button class="speech-forward" type="button" disabled></button>
    <button class="speech-slower" type="button" disabled></button>
    <span class="speech-speed"></span>
    <button class="speech-faster" type="button" disabled></button>
    <input class="speech-scrub" type="range" min="0" max="1" value="0" />
    <span class="speech-played"></span>
    <span class="speech-left"></span>
    <progress class="speech-progress" hidden></progress>
    <p class="speech-now"></p>
    <button class="speech-voices-toggle" type="button" aria-expanded="false">Voices</button>
    <label class="speech-remember"><input type="checkbox" /><span>Always download the voice on this device</span></label>
  </div>
  <div class="speech-voices" id="speech-voices" hidden></div>
  <div class="listen-mark" data-state="checking">
    <button class="listen-mark-button" type="button" aria-expanded="false" aria-label="Listen"><span class="listen-mark-glyph"></span></button>
    <div class="listen-mini" data-face="progress" hidden>
      <div class="listen-mini-offer" hidden>
        <button class="listen-mini-resume" type="button" hidden></button>
        <p class="listen-mini-gone" hidden></p>
      </div>
      <div class="listen-mini-face" data-face="consent" hidden>
        <p class="listen-mini-ask"></p>
        <button class="listen-mini-download" type="button">Download</button>
        <button class="listen-mini-always" type="button">Always Download</button>
      </div>
      <div class="listen-mini-face" data-face="progress" hidden>
        <p class="listen-mini-progress"></p>
        <progress class="listen-mini-bar" max="1"></progress>
      </div>
      <div class="listen-mini-face" data-face="note" hidden>
        <p class="listen-mini-note"></p>
        <button class="listen-mini-retry" type="button" hidden>Retry</button>
      </div>
      <div class="listen-mini-face" data-face="controls" hidden>
        <button class="listen-mini-back" type="button" disabled></button>
        <button class="listen-mini-play" type="button" data-does="play"></button>
        <button class="listen-mini-forward" type="button" disabled></button>
        <button class="listen-mini-share" type="button" disabled></button>
        <button class="listen-mini-save" type="button" disabled></button>
      </div>
    </div>
  </div></body>`;

interface MarkRig {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
}

type MiniRig = ListenControls["mini"];

interface Rig {
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
  // The panel's `onSeek`, wired in `mount`: call it and read how many times it fired.
  // Exactly once per gesture that names a place, never for a tap or a speed step.
  readonly onSeek: () => void;
  readonly seeks: () => number;
  readonly status: HTMLElement;
  readonly bar: HTMLProgressElement;
  // The preference's box, in the panel.
  readonly remember: HTMLInputElement;
  readonly mark: MarkRig;
  readonly mini: MiniRig;
  // The voice picker's markup: the toggle in the transport and the block the rows are built into.
  readonly voices: { readonly toggle: HTMLButtonElement; readonly picker: HTMLElement };
  readonly doc: Document;
  readonly port: ListenPort;
  readonly sent: ToWorker[];
  readonly emit: (message: FromWorker) => void;
  readonly fail: (message: string) => void;
  readonly counts: { spawned: number; terminated: number; disposed: number; listeners: () => number; homeAsked: number; keepAsked: number; unlocked: number };
  // The store's and the browser's answers, given by hand so their timing is the check's.
  readonly answer: { home: (residency: Residency) => void; keep: (keeping: Keeping) => void };
  readonly home: () => Promise<Residency>;
  readonly keep: () => Promise<Keeping>;
  // The device's kept audio: every ask, in the voices it was made in, answered at once with
  // `kept` — nothing kept unless a case says otherwise.
  readonly restore: (units: ReadonlyArray<SynthesisUnit>, voices: VoiceMap) => Promise<ReadonlyArray<UnitReport | undefined>>;
  readonly restores: VoiceMap[];
  readonly kept: { reports: ReadonlyArray<UnitReport | undefined> };
  // The device's storage, and the connection the metered rule reads: the page's
  // localStorage and navigator.connection, a Map and a field here.
  readonly store: ReturnType<typeof memoryPreferences>;
  readonly connection: { reading: ConnectionReading | undefined };
  // The port's dispose throws while this is set: a teardown that fails.
  readonly refusing: { dispose: boolean };
  readonly said: () => string;
  readonly frames: { request: (callback: () => void) => number; cancel: () => void; pending: number; tick: () => void };
  // The clock the driver stamps worker messages with, in ms; the check sets it by hand.
  now: number;
  readonly positions: (ReadAlongAt | null)[];
  // Every transport the panel reported, oldest first: what the media controls were shown.
  readonly transports: Transport[];
  readonly where: () => string;
  readonly line: () => string;
  readonly transport: () => string;
  // What the mark and the mini-player show: the form, whether the mini-player is out, its
  // face — the question, the fraction, the note, or what the play button does — and the box.
  readonly shownMark: () => string;
  // The reader's hand on the panel: the box checked or cleared.
  readonly check: (on: boolean) => void;
  // The devices opened since the rig was built, newest last: each gesture or build opens one.
  readonly devices: () => StubDevice[];
  // The page's audio element, as the panel built it at the mount.
  readonly audio: () => StubAudio;
  // The page's clipboard: every link the share control asked for, and how the next ask is
  // answered — copied, refused, or thrown before any promise, as a page with no clipboard
  // at all does.
  readonly share: (place: Place) => Promise<void>;
  readonly links: Place[];
  readonly clipboard: { answer: "copies" | "refuses" | "throws" };
  readonly renders: { requests: ReadonlyArray<SynthesizeRequest>; onUnit: (unit: RenderedUnit) => void; withdrawn: boolean }[];
  readonly saves: { name: string; bytes: number }[];
}

type Store = ReturnType<typeof memoryPreferences>;
// The device's storage: a fresh one, remembering the download consent or not, one carried
// over from an earlier rig — the storage surviving a reload, exactly as that rig left it —
// or one the browser refuses, as a browser that blocks site data does, which holds nothing.
type Storage = { readonly remembered: boolean } | { readonly store: Store } | { readonly refused: true };
const storeOf = (storage: Storage): Store => {
  if ("store" in storage) return storage.store;
  if ("refused" in storage) return { ...refusedPreferences(), keys: () => [] };
  const store = memoryPreferences();
  writePreference(store, storage.remembered);
  return store;
};

// A visit: what the device's storage held before the page loaded, and what the browser
// says of the connection.
interface VisitSetup {
  readonly storage?: Storage;
  readonly connection?: ConnectionReading;
}

const rig = (setup: VisitSetup = {}): Rig => {
  const dom = new JSDOM(MARKUP);
  const doc = dom.window.document;
  const el = <T extends Element>(selector: string): T => {
    const found = doc.querySelector<T>(selector);
    if (found === null) throw new Error(`fixture: no ${selector}`);
    return found;
  };
  const sent: ToWorker[] = [];
  const listeners = new Set<(message: FromWorker) => void>();
  const errorListeners = new Set<(message: string) => void>();
  const counts = { spawned: 0, terminated: 0, disposed: 0, listeners: () => listeners.size + errorListeners.size, homeAsked: 0, keepAsked: 0, unlocked: 0 };
  // Answers land on the oldest unanswered ask first, so two asks in flight settle in the
  // order they were made: the earlier one can be answered after a later one was issued.
  const deferred = <T,>() => {
    const waiting: ((value: T) => void)[] = [];
    return {
      ask: () => new Promise<T>((resolve) => waiting.push(resolve)),
      answer: (value: T) => {
        const oldest = waiting.shift();
        if (oldest === undefined) throw new Error("fixture: an answer with nothing asked");
        oldest(value);
      },
    };
  };
  const homes = deferred<Residency>();
  const restores: VoiceMap[] = [];
  const kept: { reports: ReadonlyArray<UnitReport | undefined> } = { reports: [] };
  const keeps = deferred<Keeping>();
  const refusing = { dispose: false };
  // Every render the panel asks of the port: what it wants, who hears it, whether it was withdrawn.
  const renders: { requests: ReadonlyArray<SynthesizeRequest>; onUnit: (unit: RenderedUnit) => void; withdrawn: boolean }[] = [];
  const port: ListenPort = {
    send: (message) => sent.push(message),
    ahead: () => undefined,
    render: (requests, onUnit) => {
      const render = { requests, onUnit, withdrawn: false };
      renders.push(render);
      return () => {
        render.withdrawn = true;
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    errors: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    dispose: () => {
      counts.disposed += 1;
      if (refusing.dispose) throw new Error("the worker would not dispose");
    },
    terminate: () => {
      counts.terminated += 1;
    },
  };
  const pending: (() => void)[] = [];
  const frames = {
    request: (callback: () => void): number => pending.push(callback),
    cancel: (): void => {
      pending.length = 0;
    },
    get pending() {
      return pending.length;
    },
    tick: (): void => {
      for (const callback of pending.splice(0)) callback();
    },
  };
  const store = storeOf(setup.storage ?? { remembered: false });
  const positions: (ReadAlongAt | null)[] = [];
  const transports: Transport[] = [];
  const play = el<HTMLButtonElement>(".speech-play");
  const stop = el<HTMLButtonElement>(".speech-stop");
  const back = el<HTMLButtonElement>(".speech-back");
  const forward = el<HTMLButtonElement>(".speech-forward");
  const slower = el<HTMLButtonElement>(".speech-slower");
  const faster = el<HTMLButtonElement>(".speech-faster");
  const speed = el<HTMLElement>(".speech-speed");
  const scrub = el<HTMLInputElement>(".speech-scrub");
  const played = el<HTMLElement>(".speech-played");
  const remaining = el<HTMLElement>(".speech-left");
  const status = el<HTMLElement>(".speech-now");
  const mark: MarkRig = {
    root: el(".listen-mark"),
    button: el(".listen-mark-button"),
  };
  const remember = el<HTMLInputElement>(".speech-remember input");
  const mini: MiniRig = {
    root: el(".listen-mini"),
    faces: {
      consent: el('.listen-mini-face[data-face="consent"]'),
      progress: el('.listen-mini-face[data-face="progress"]'),
      note: el('.listen-mini-face[data-face="note"]'),
      controls: el('.listen-mini-face[data-face="controls"]'),
    },
    ask: el(".listen-mini-ask"),
    download: el(".listen-mini-download"),
    always: el(".listen-mini-always"),
    progress: el(".listen-mini-progress"),
    bar: el(".listen-mini-bar"),
    note: el(".listen-mini-note"),
    retry: el(".listen-mini-retry"),
    back: el(".listen-mini-back"),
    play: el(".listen-mini-play"),
    forward: el(".listen-mini-forward"),
    share: el(".listen-mini-share"),
    save: el(".listen-mini-save"),
    offer: el(".listen-mini-offer"),
    resume: el(".listen-mini-resume"),
    gone: el(".listen-mini-gone"),
  };
  // The face as the DOM shows it — the one face not hidden — and what it says.
  const shownFace = (): string => {
    const [only, ...more] = Object.entries(mini.faces).filter(([, el]) => !el.hidden).map(([kind]) => kind);
    if (only === undefined || more.length > 0) throw new Error(`fixture: faces shown ${[only, ...more].join()}`);
    return only;
  };
  const face = (): string => {
    switch (shownFace()) {
      case "consent":
        return `ask ${mini.ask.textContent}`;
      case "progress":
        return `progress ${mini.bar.getAttribute("value") ?? "?"}`;
      case "note":
        return `note${mini.retry.hidden ? "" : " retry"}`;
      case "controls":
        return `${mini.play.dataset.does}`;
      default:
        throw new Error(`fixture: mini face ${shownFace()}`);
    }
  };
  const opened = StubDevice.instances.length;
  const heard = StubAudio.instances.length;
  let seekCount = 0;
  const links: Place[] = [];
  const clipboard: { answer: "copies" | "refuses" | "throws" } = { answer: "copies" };
  return {
    play,
    stop,
    back,
    forward,
    slower,
    faster,
    speed,
    scrub,
    played,
    remaining,
    onSeek: () => {
      seekCount += 1;
    },
    seeks: () => seekCount,
    status,
    bar: el(".speech-progress"),
    remember,
    mark,
    mini,
    voices: { toggle: el(".speech-voices-toggle"), picker: el(".speech-voices") },
    now: 0,
    doc,
    port,
    sent,
    emit: (message) => {
      for (const listener of listeners) listener(message);
    },
    fail: (message) => {
      for (const listener of errorListeners) listener(message);
    },
    counts,
    answer: { home: homes.answer, keep: keeps.answer },
    home: () => {
      counts.homeAsked += 1;
      return homes.ask();
    },
    keep: () => {
      counts.keepAsked += 1;
      return keeps.ask();
    },
    restore: (asked, voices) => {
      restores.push(voices);
      return Promise.resolve(asked.map((_, i) => kept.reports[i]));
    },
    restores,
    kept,
    store,
    connection: { reading: setup.connection },
    refusing,
    said: () => sent.map((m) => (m.kind === "synthesize" ? `synthesize ${m.unitId}` : m.kind === "cancel" ? `cancel ${m.unitId}` : m.kind)).join(),
    frames,
    positions,
    transports,
    where: () => {
      const at = positions.at(-1);
      return at === null || at === undefined
        ? "silent"
        : `${at.utterance.anchor} ${at.range.charStart}-${at.range.charEnd}${at.word === null ? "" : `/${at.word.charStart}-${at.word.charEnd}`} of ${at.turn.length}`;
    },
    line: () => `${play.textContent}${play.disabled ? "(off)" : ""} | stop${stop.disabled ? "(off)" : ""} | ${status.textContent}`,
    // The turn skips, the speed and the scrubber's own reading: what the DOM shows, not the
    // readout the pure machine computed — this is the driver's whole job to have written.
    transport: () =>
      `back${back.disabled ? "(off)" : ""} | forward${forward.disabled ? "(off)" : ""} | ` +
      `slower${slower.disabled ? "(off)" : ""} ${speed.textContent} faster${faster.disabled ? "(off)" : ""} | ` +
      `${played.textContent}/${scrub.value} of ${scrub.max} · ${remaining.textContent}`,
    shownMark: () =>
      `${mark.root.dataset.state} | ${mini.root.hidden ? "folded" : "out"} | ${face()} | remember ${remember.checked ? "on" : "off"}`,
    check: (on) => {
      remember.checked = on;
      remember.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    },
    devices: () => StubDevice.instances.slice(opened),
    audio: () => {
      const built = StubAudio.instances[heard];
      if (built === undefined) throw new Error("fixture: the panel built no audio element");
      return built;
    },
    share: (place) => {
      links.push(place);
      if (clipboard.answer === "throws") throw new TypeError("no clipboard");
      return clipboard.answer === "refuses" ? Promise.reject(new Error("clipboard refused")) : Promise.resolve();
    },
    links,
    clipboard,
    renders,
    // The page's side of a download: the WAV form, the real encoder, and a record of each save.
    saves: [] as { name: string; bytes: number }[],
  };
};

const mount = (r: Rig): ReturnType<typeof createListenPanel> =>
  createListenPanel({
    controls: {
      play: r.play,
      stop: r.stop,
      back: r.back,
      forward: r.forward,
      slower: r.slower,
      faster: r.faster,
      speed: r.speed,
      scrub: r.scrub,
      played: r.played,
      remaining: r.remaining,
      status: r.status,
      progress: r.bar,
      remember: r.remember,
      mark: r.mark,
      voices: r.voices,
      mini: r.mini,
    },
    utterances,
    spawn: () => {
      r.counts.spawned += 1;
      return r.port;
    },
    home: r.home,
    keep: r.keep,
    restore: r.restore,
    preference: { read: () => readPreference(r.store), write: (remembered) => writePreference(r.store, remembered) },
    pick: { read: () => readPick(r.store), write: (pick) => writePick(r.store, pick) },
    connection: () => r.connection.reading,
    Device: StubDevice,
    Audio: () => new StubAudio(),
    frames: r.frames,
    clock: () => r.now,
    onPosition: (at) => r.positions.push(at),
    onTransport: (transport) => r.transports.push(transport),
    onUnlock: () => {
      r.counts.unlocked += 1;
    },
    resume: { read: () => readResume(r.store, SLUG, printed), write: (place) => writeResume(r.store, SLUG, printed, place), forget: () => forgetResume(r.store, SLUG) },
    share: r.share,
    download: {
      name: "a-paste",
      form: async () => ({ container: "wav" }),
      encode: encodeFile,
      save: (file, name) => r.saves.push({ name, bytes: file.bytes.byteLength }),
    },
    onSeek: r.onSeek,
  });

// Every promise the page's answers ride on, settled: a macrotask runs after all of them.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// What escaped the page's promise chains while `run` settled: an error the panel's dispatch
// threw inside the delivery of an answer, which the page's console reports as unhandled.
const escaped = async (run: () => Promise<void>): Promise<unknown> => {
  let caught: unknown = null;
  const catcher = (error: unknown): void => {
    caught = error;
  };
  process.on("unhandledRejection", catcher);
  await run();
  await flush();
  process.off("unhandledRejection", catcher);
  return caught;
};

// The units back from the worker, and the device's answer on what it keeps of them.
const scripted = async (r: Rig, script: ReadonlyArray<SynthesisUnit> = units): Promise<void> => {
  r.emit({ kind: "script", id: FIRST_SCRIPT_ID, units: script });
  await flush();
};

// The whole way to audio after a tap, as the worker would answer it.
const arrive = async (r: Rig): Promise<void> => {
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  await scripted(r);
};

// The rest of the way after the probe has already answered: the load, the warm-up, the script.
const warm = async (r: Rig): Promise<void> => {
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  await scripted(r);
};

// An able device whose store has none of the model: the download-needed visit.
const ableAbsent = async (r: Rig): Promise<void> => {
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.answer.home(ABSENT);
  await Promise.resolve();
};

const MOUNT_MARK = "checking | folded | progress ? | remember off";
const ASK_MARK = "download | folded | ask Download speech model? · 239 MB | remember off";
const PREPARING_LINE = "Listen | stop(off) | Preparing the voice…";

console.log("createListenPanel: the tap opens the device, the voice arrives and plays");
{
  const r = rig();
  const panel = mount(r);

  assert("mounted: the worker is spawned to probe and asked for the script, the store asked, nothing else sent, no device, the mark checking", r.line() === MOUNT_LINE && r.counts.homeAsked === 1 && r.counts.keepAsked === 0 && r.counts.spawned === 1 && r.said() === "script" && r.devices().length === 0 && r.shownMark() === MOUNT_MARK);
  assert("the mark is named for assistive tech by the status line", r.mark.button.getAttribute("aria-label") === "Listen: Checking this device for the voice…");
  r.play.click();
  const device = r.devices()[0];
  if (device === undefined) throw new Error("the tap did not open a device");
  assert("click Play while the probe runs: no second worker, the button disables — the tap is the consent", r.counts.spawned === 1 && r.line() === "Listen(off) | stop(off) | Checking this device for the voice…");
  assert("the audio device is opened AND resumed on the tap, before any worker message, and the page told of the unlock on the same stack", r.devices().length === 1 && device.calls.join() === "resume" && r.counts.unlocked === 1 && r.said() === "script");
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("supported with the tap held: load is sent", r.said() === "script,load" && r.shownMark() === "warming | folded | progress ? | remember off");
  r.emit({ kind: "progress", progress: { loadedBytes: 50_000_000, totalBytes: 200_000_000 } });
  assert("downloading: the bar shows and carries the bytes, the mark's ring the fraction", !r.bar.hidden && r.bar.value === 50_000_000 && r.bar.max === 200_000_000 && r.line() === "Listen(off) | stop(off) | Downloading the voice · 25% · 50 of 200 MB · estimating time left…" && r.mark.root.dataset.state === "downloading" && r.mark.root.style.getPropertyValue("--fraction") === "0.25");
  // The driver stamps each message with the clock's reading: 50 MB more in 5 s is 10 MB/s,
  // 100 MB to go, about 10 s.
  r.now = 5_000;
  r.emit({ kind: "progress", progress: { loadedBytes: 100_000_000, totalBytes: 200_000_000 } });
  assert("the pace reads the driver's clock: the estimate speaks", r.line() === "Listen(off) | stop(off) | Downloading the voice · 50% · 100 of 200 MB · about 10 s left" && r.mark.root.style.getPropertyValue("--fraction") === "0.5");
  r.emit({ kind: "progress", progress: { loadedBytes: 200_000_000, totalBytes: 200_000_000 } });
  assert("warming: the bar goes, the ring is empty", r.bar.hidden && r.line() === "Listen(off) | stop(off) | Warming up the voice…" && r.mark.root.dataset.state === "warming" && r.mark.root.style.getPropertyValue("--fraction") === "0");
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  const script = r.sent[0];
  assert("the script the voice waits on was asked for at the spawn: the page's utterances under the panel's script id", script?.kind === "script" && script.id === FIRST_SCRIPT_ID && script.utterances === utterances && r.line() === "Listen(off) | stop(off) | Preparing the script…");

  await scripted(r);
  assert("units back: the voice plays at once from the top on the device the tap opened, and asks for unit 0", panel.state().kind === "neural" && r.devices().length === 1 && r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.mark.root.dataset.state === "speaking");
  assert("the cursor is on unit 0's whole span while it has no record", r.where() === "t1 0-20 of 1" && r.frames.pending === 1);

  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  r.emit({ kind: "audio", unitId: 0, frameIndex: 1, pcm: frame(0, 1) });
  assert("audio arrives: playing", r.line() === "Pause | stop | Playing · passage 1 of 2");
  r.emit({ kind: "done", unitId: 0, report: report(2 * FRAME_S * 1000), elapsedMs: 5 });
  r.emit({ kind: "audio", unitId: 1, frameIndex: 0, pcm: frame(1, 0) });
  r.emit({ kind: "done", unitId: 1, report: report(FRAME_S * 1000), elapsedMs: 5 });
  r.emit({ kind: "audio", unitId: 2, frameIndex: 0, pcm: frame(2, 0) });
  r.emit({ kind: "done", unitId: 2, report: report(FRAME_S * 1000), elapsedMs: 5 });

  device.advance(SCHEDULE_LEAD_S + 2 * FRAME_S + 0.01);
  assert("crossing into unit 1: still passage 1, the cursor on unit 1's span", r.line() === "Pause | stop | Playing · passage 1 of 2" && r.where() === "t1 21-42 of 1");
  device.advance(FRAME_S);
  r.frames.tick();
  assert("crossing into the gap before the second turn: the player sounds it — nothing painted, the status names the turn the gap leads into, the loop still running", r.where() === "silent" && r.line() === "Pause | stop | Playing · passage 2 of 2" && r.frames.pending === 1);
  device.advance(0.5);
  r.frames.tick();
  assert("the gap's end: unit 2 begins, another turn, its own span", r.where() === "t2 0-8 of 1" && r.frames.pending === 1);
  const before = r.positions.length;
  r.frames.tick();
  assert("a frame with the cursor unmoved reports nothing new", r.positions.length === before && r.frames.pending === 1);

  r.play.click();
  assert("Pause: paused, the loop is off, the label says Resume, the mark paused", r.line() === "Resume | stop | Paused · passage 2 of 2" && r.frames.pending === 0 && r.mark.root.dataset.state === "paused");
  r.play.click();
  assert("Resume: speaking again, the loop is back", r.play.textContent === "Pause" && r.frames.pending === 1);
  panel.send({ kind: "place", to: mark(0, 25) });
  assert("a tap on the first passage's second sentence: the voice seeks there and the cursor follows", r.where() === "t1 21-42 of 1" && r.line() === "Pause | stop | Playing · passage 1 of 2");
  r.stop.click();
  assert("Stop: idle, the cursor cleared, Stop disabled, Play says Listen, the mark ready", r.line() === "Listen | stop(off) | Ready" && r.positions.at(-1) === null && r.frames.pending === 0 && r.shownMark() === "ready | folded | play | remember off");
  r.play.click();
  assert("Play again starts from the top on the same worker and device: Stop let the audio go, so unit 0 is asked for again", r.counts.spawned === 1 && r.devices().length === 1 && r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.where() === "t1 0-20 of 1");

  r.fail("the worker bundle failed to load");
  assert("the worker dies while playing: the device closed, the worker terminated, no longer heard, Play reads Retry, the mark failed", device.calls.at(-1) === "close" && r.counts.terminated === 1 && r.counts.listeners() === 0 && r.line() === "Retry | stop(off) | The voice failed: the worker bundle failed to load" && r.mark.root.dataset.state === "failed");
  assert("the place the voice stood is kept as the cue, and the cursor rests on its word, the loop off", r.where() === "t1 0-5/0-5 of 1" && r.frames.pending === 0 && held(panel.state()) === "0:0");
  r.play.click();
  const second = r.devices()[1];
  assert("Retry: a fresh worker is spawned and probed, a fresh device opened and resumed on the tap, and the script the panel still holds is not asked for again", r.counts.spawned === 2 && second !== undefined && second !== device && second.calls.join() === "resume" && r.line() === "Listen(off) | stop(off) | Preparing the script…" && r.sent.filter((m) => m.kind === "script").length === 1);
  panel.dispose();
  assert("dispose: the worker disposed (not terminated outright), unheard, the device closed, at the start", r.counts.disposed === 1 && r.counts.terminated === 1 && r.counts.listeners() === 0 && second?.calls.at(-1) === "close" && r.line() === IDLE_LINE);
}

console.log("createListenPanel: turn skips before the voice arrives step gap by gap, and the voice starts in the gap");
{
  const r = rig();
  const panel = mount(r);
  panel.send({ kind: "place", to: mark(1, 5) });
  r.back.click();
  assert("partway into the second turn, back lands on the gap before that turn, kept as the gap itself", held(panel.state()) === "gap before 1:0+0" && !r.back.disabled && r.forward.disabled);
  r.back.click();
  assert("back again from that gap reaches the top, and there is nothing before it", held(panel.state()) === "0:0" && r.back.disabled);
  r.forward.click();
  assert("forward from the top is that gap again, the last turn's gap, with nothing after it", held(panel.state()) === "gap before 1:0+0" && r.forward.disabled && !r.back.disabled);
  await arrive(r);
  assert("the voice arrives in the gap, not at the turn after it: the gap sounds, nothing painted, the turn after it asked for", r.where() === "silent" && r.line() === "Pause | stop | Playing · passage 2 of 2" && r.said().endsWith("synthesize 2"));
  panel.dispose();
}

console.log("createListenPanel: a scrub let go in a gap before the voice arrives keeps its place in the gap (slopspot-read-along-a35.4gj)");
{
  const r = rig();
  const panel = mount(r);
  const window = r.doc.defaultView as unknown as typeof globalThis.window;
  const pageGap = timelineOfUtterances(utterances).segments.find((segment) => segment.content.kind === "silence");
  if (pageGap === undefined) throw new Error("fixture: the page has no gap between its turns");
  const dropMs = Math.ceil(pageGap.startMs) + 200;
  const into = dropMs - pageGap.startMs;
  r.scrub.value = String(dropMs);
  r.scrub.dispatchEvent(new window.Event("input", { bubbles: true }));
  r.scrub.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert("let go in the gap: kept as the gap itself, as far in as it was dropped, not as the turn after it", held(panel.state()) === `gap before 1:0+${into}`);
  assert("the thumb stays where it was let go, and does not hop to the turn's start", Number(r.scrub.value) === dropMs);
  await arrive(r);
  const voiceGap = (panel.state() as Extract<PanelState, { kind: "neural" }>).view.timeline.segments.find((segment) => segment.content.kind === "silence");
  assert("the voice arrives that far into the gap on its own clock: the rest of the gap sounds before the turn", r.where() === "silent" && r.line() === "Pause | stop | Playing · passage 2 of 2" && r.said().endsWith("synthesize 2") && voiceGap !== undefined && Math.abs(performerAt(panel.state()) - (voiceGap.startMs + into)) < 1e-6);
  panel.dispose();
}

console.log("createListenPanel: a tap on a word before the voice is warm is where it starts");
{
  const r = rig();
  const panel = mount(r);
  panel.send({ kind: "place", to: mark(0, 21) });
  const device = r.devices()[0];
  assert("a tap on a word while the probe runs opens the device, like Play, and holds the place", r.counts.spawned === 1 && device?.calls.join() === "resume" && r.line() === "Listen(off) | stop(off) | Checking this device for the voice…" && held(panel.state()) === "0:21");
  panel.send({ kind: "place", to: mark(1) });
  assert("a second tap while the voice is on its way moves the place, nothing else", r.counts.spawned === 1 && r.devices().length === 1 && held(panel.state()) === "1:0");
  await arrive(r);
  assert("the voice arrives at the tapped place: it asks for that unit and the cursor is there", r.said().endsWith("synthesize 2") && r.where() === "t2 0-8 of 1" && r.line() === "Pause | stop | Synthesizing ahead… · passage 2 of 2");
  r.emit({ kind: "audio", unitId: 2, frameIndex: 0, pcm: frame(2, 0) });
  r.emit({ kind: "done", unitId: 2, report: report(FRAME_S * 1000), elapsedMs: 5 });
  device?.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("the last unit ends: Ready, the cursor cleared, the loop off", r.line() === "Listen | stop(off) | Ready" && r.positions.at(-1) === null && r.frames.pending === 0);
  panel.dispose();
}

console.log("createListenPanel: the transport skips turns and steps the speed, and follows every gesture that moves");
{
  const r = rig();
  const panel = mount(r);
  r.play.click();
  await arrive(r);
  assert("on stage at the top: no turn behind, the next turn ahead, speed at 1x and neither end disabled", r.where() === "t1 0-20 of 1" && r.back.disabled && !r.forward.disabled && r.speed.textContent === "1×" && !r.slower.disabled && !r.faster.disabled);
  assert("mounting and arriving named no place: nothing has asked to follow yet", r.seeks() === 0);

  r.forward.click();
  assert("forward lands in the gap before the second turn: the gap sounds, nothing is painted, the status names the turn the gap leads into, and the page is told to follow", r.where() === "silent" && r.line() === "Pause | stop | Playing · passage 2 of 2" && r.seeks() === 1);
  assert("standing at the last gap: forward has nothing left, back does", r.forward.disabled && !r.back.disabled);

  r.back.click();
  assert("back returns to the first turn, and follows again", r.where() === "t1 0-20 of 1" && r.seeks() === 2);

  r.faster.click();
  assert("faster steps the speed and is not a seek — the reader did not move", r.speed.textContent === "1.25×" && r.seeks() === 2);
  r.slower.click();
  r.slower.click();
  assert("slower steps back down, to its own floor and no further", r.speed.textContent === "0.75×" && r.slower.disabled);

  r.scrub.value = r.scrub.max;
  r.scrub.dispatchEvent(new (r.doc.defaultView as unknown as typeof window).Event("input", { bubbles: true }));
  assert("dragging the scrubber moves the times shown but not the voice, and is not yet a seek", r.where() === "t1 0-20 of 1" && r.seeks() === 2 && r.played.textContent !== "");
  r.scrub.dispatchEvent(new (r.doc.defaultView as unknown as typeof window).Event("change", { bubbles: true }));
  assert("letting go seeks to where the thumb landed, at the end of the conversation, and follows", r.where().startsWith("t2") && r.seeks() === 3);
  panel.dispose();
}

console.log("createListenPanel: the store's word before the tap, the browser's answer on the load");
{
  const r = rig();
  const panel = mount(r);
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("supported with nothing said: the worker waits, nothing sent, the store's answer awaited", r.said() === "script" && r.line() === IDLE_LINE && r.shownMark() === MOUNT_MARK);
  r.answer.home({ kind: "resident" });
  await Promise.resolve();
  assert("the store answers: the line says the voice is on this device, the mark ready, no download offered, still nothing sent", r.line() === RESIDENT_LINE && r.shownMark() === "ready | folded | play | remember off" && r.said() === "script");
  r.play.click();
  assert("the tap on an able voice: load is sent and the browser is asked to keep the bytes, in that order", r.sent.map((m) => m.kind).join() === "script,load" && r.counts.keepAsked === 1 && r.line() === "Listen(off) | stop(off) | Preparing the voice…");
  r.answer.keep({ kind: "denied" });
  await Promise.resolve();
  assert("denied: the consequence is on the line beside the phase", r.line() === "Listen(off) | stop(off) | Preparing the voice… · this browser may drop the voice when space is short; the next listen would download it again");
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  assert("and stays there through warming", r.line() === "Listen(off) | stop(off) | Warming up the voice… · this browser may drop the voice when space is short; the next listen would download it again");
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  await scripted(r);
  assert("on stage: the scheduler's line, the answer no longer shown", r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  panel.dispose();
  assert("dispose asks the store again, and shows the asking", r.counts.homeAsked === 2 && r.line() === IDLE_LINE);
  r.answer.home(ABSENT);
  await Promise.resolve();
  assert("a store that lost the bytes says so on the next start, and the hover asks", r.line() === ABSENT_LINE && r.shownMark() === ASK_MARK);
}

console.log("createListenPanel: the hover's yes downloads the voice and leaves it standing ready");
{
  const r = rig();
  const panel = mount(r);
  await ableAbsent(r);
  assert("download needed: the mark says so, the hover asks with the size and offers the yes and the box; nothing sent, no device", r.shownMark() === ASK_MARK && r.line() === ABSENT_LINE && r.said() === "script" && r.devices().length === 0 && r.mark.button.getAttribute("aria-label") === "Listen: The voice downloads 239 MB once, then runs on this device");
  r.mini.download.click();
  const device = r.devices()[0];
  assert("yes: the device is opened and resumed on the click, load sent, the browser asked to keep; Play still reads, since a yes is not a Play", device?.calls.join() === "resume" && r.said() === "script,load" && r.counts.keepAsked === 1 && r.line() === PREPARING_LINE && r.shownMark() === "warming | folded | progress ? | remember off");
  r.emit({ kind: "progress", progress: { loadedBytes: 60_000_000, totalBytes: 240_000_000 } });
  assert("downloading: the ring fills, the question is gone", r.mark.root.dataset.state === "downloading" && r.mark.root.style.getPropertyValue("--fraction") === "0.25" && r.shownMark() === "downloading | folded | progress 0.25 | remember off");
  r.emit({ kind: "progress", progress: { loadedBytes: 240_000_000, totalBytes: 240_000_000 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  await scripted(r);
  assert("the voice arrives on the yes alone: on stage, Ready, nothing synthesized, no cursor, the mark ready", panel.state().kind === "neural" && r.said() === "script,load" && r.line() === "Listen | stop(off) | Ready" && r.shownMark() === "ready | folded | play | remember off" && r.positions.every((at) => at === null) && r.frames.pending === 0);
  r.play.click();
  assert("Play on the ready voice speaks from the top on the device the yes opened", r.devices().length === 1 && r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.where() === "t1 0-20 of 1");
  panel.dispose();
}

console.log("createListenPanel: a browser that refuses site storage still listens (slopspot-read-along-a35.2wu)");
{
  const r = rig({ storage: { refused: true } });
  const panel = mount(r);
  await ableAbsent(r);
  assert("mounted over a refused store: nothing remembered, so the hover asks; nothing sent", r.shownMark() === ASK_MARK && r.line() === ABSENT_LINE && r.said() === "script");
  r.check(true);
  assert("the box on a refused store keeps nothing, so it grants no standing yes and reads unchecked", !readPreference(r.store) && r.said() === "script" && r.shownMark() === ASK_MARK);
  r.mini.download.click();
  assert("the tap's yes is this visit's own: load sent", r.said() === "script,load" && r.line() === PREPARING_LINE);
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  await scripted(r);
  r.play.click();
  assert("Play speaks from the top, with no pick, no place and no preference to read", r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  r.check(false);
  assert("clearing the box on a refused store does not throw; the voice on stage is untouched", panel.state().kind === "neural" && r.counts.spawned === 1);
  panel.dispose();
}

console.log("createListenPanel: the box is the yes for this visit and every next one");
{
  const r = rig();
  const panel = mount(r);
  await ableAbsent(r);
  r.check(true);
  assert("checking the box writes the preference, and the voice loads with no tap and no device", readPreference(r.store) && r.said() === "script,load" && r.devices().length === 0 && r.line() === PREPARING_LINE && r.shownMark() === "warming | folded | progress ? | remember on");
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  await scripted(r);
  const device = r.devices()[0];
  assert("a voice built on a standing consent opens its device outside any gesture, unresumed, and stands ready", r.devices().length === 1 && device?.calls.join() === "" && r.counts.unlocked === 0 && r.line() === "Listen | stop(off) | Ready" && r.said() === "script,load");
  r.play.click();
  assert("the first Play resumes that device on the tap and speaks", device?.calls.includes("resume") === true && r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  r.check(false);
  assert("clearing the box removes the preference; the voice on stage is untouched", !r.store.keys().includes(PREFERENCE_KEY) && r.shownMark() === "speaking | out | pause | remember off" && r.counts.spawned === 1 && panel.state().kind === "neural");
  panel.dispose();

  const next = rig({ storage: { remembered: true } });
  const nextPanel = mount(next);
  assert("a later visit with the preference: the probe first, the mark checking with nothing to ask, the box checked, nothing sent before the worker is able", next.line() === MOUNT_LINE && next.shownMark() === "checking | folded | progress ? | remember on" && next.said() === "script");
  next.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("supported: load is sent with no tap, the browser asked to keep, no device opened", next.said() === "script,load" && next.counts.keepAsked === 1 && next.devices().length === 0 && next.line() === PREPARING_LINE);
  next.answer.home(ABSENT);
  await Promise.resolve();
  assert("the store's late word does not put a question over a download in flight", next.shownMark() === "warming | folded | progress ? | remember on");
  next.emit({ kind: "load-failed", failure: { kind: "network", url: "u", message: "offline" } });
  next.check(false);
  assert("the download fails and the reader unchecks the box: the preference is gone, nothing is sent again, the failure stays on the line", next.store.keys().length === 0 && next.said() === "script,load" && next.line() === "Retry | stop(off) | The voice could not load: network error fetching u: offline" && next.shownMark() === "failed | folded | note retry | remember off");
  nextPanel.dispose();
}

console.log("createListenPanel: on a metered connection the remembered yes still asks");
{
  const r = rig({ storage: { remembered: true }, connection: { type: "cellular" } });
  const panel = mount(r);
  await ableAbsent(r);
  assert("nothing loads; the hover asks and says why, the box still checked", r.said() === "script" && r.shownMark() === "download | folded | ask Download speech model? · 239 MB · asking because this connection is metered | remember on" && r.line() === ABSENT_LINE);
  r.connection.reading = { type: "wifi" };
  panel.wake();
  assert("off the metered connection, the page's next wake gives the standing yes: load, no gesture", r.said() === "script,load" && r.devices().length === 0 && r.line() === PREPARING_LINE);
  panel.dispose();

  const tapped = rig({ storage: { remembered: true }, connection: { saveData: true } });
  const tappedPanel = mount(tapped);
  await ableAbsent(tapped);
  tapped.mini.download.click();
  assert("with save-data on, the hover's yes is the reader's own: load on the click", tapped.said() === "script,load" && tapped.devices()[0]?.calls.join() === "resume");
  tappedPanel.dispose();
}

console.log("createListenPanel: a device that cannot run the voice says so at mount");
{
  const r = rig();
  const panel = mount(r);
  r.emit({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } });
  assert("unsupported: the mark, the reason on its sentence, Play off, the worker released", r.shownMark() === "unsupported | folded | note | remember off" && r.line() === "Listen(off) | stop(off) | This device can't run the voice: this browser has no WebGPU" && r.counts.terminated === 1 && r.counts.listeners() === 0);
  r.play.click();
  r.mini.download.click();
  r.check(true);
  panel.send({ kind: "place", to: mark(1) });
  assert("no tap, yes, box or word spawns anything or opens a device on it", r.counts.spawned === 1 && r.devices().length === 0 && r.said() === "script" && r.line().startsWith("Listen(off)"));
  panel.dispose();
}

console.log("createListenPanel: the mini-player folds on the mark's tap, and stays out while the voice has a place");
{
  const r = rig();
  const panel = mount(r);
  const out = (): boolean => !r.mini.root.hidden && r.mark.button.getAttribute("aria-expanded") === "true";
  const folded = (): boolean => r.mini.root.hidden && r.mark.button.getAttribute("aria-expanded") === "false";
  assert("folded at mount", folded() && r.shownMark() === MOUNT_MARK);
  r.mark.button.click();
  assert("a tap on the mark brings the mini-player out, showing the voice on its way", out() && r.shownMark() === "checking | out | progress ? | remember off");
  r.mark.button.click();
  assert("a second tap folds it", folded());
  await ableAbsent(r);
  r.mark.button.click();
  assert("download needed: the question and its two answers, no controls", r.shownMark() === "download | out | ask Download speech model? · 239 MB | remember off" && r.mini.faces.controls.hidden && r.said() === "script");
  r.mini.always.click();
  assert("Always Download: the preference kept, the box in the panel checked, the load sent on the tap's device, the voice on its way", readPreference(r.store) && r.remember.checked && r.said() === "script,load" && r.devices().length === 1 && r.shownMark() === "warming | out | progress ? | remember on");
  r.emit({ kind: "progress", progress: { loadedBytes: 50_000_000, totalBytes: 200_000_000 } });
  assert("downloading: the fraction on the bar, the panel's sentence on the line", r.shownMark() === "downloading | out | progress 0.25 | remember on" && r.mini.progress.textContent === "Downloading the voice · 25% · 50 of 200 MB · estimating time left…");
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  await scripted(r);
  assert("the voice arrives on the yes alone: the controls, play, still out on the reader's word; a turn ahead, none behind", r.shownMark() === "ready | out | play | remember on" && r.mini.back.disabled && !r.mini.forward.disabled && r.mini.faces.consent.hidden);
  r.mini.play.click();
  assert("play from the mini-player: the voice speaks from the top, the face pause", r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.shownMark() === "speaking | out | pause | remember on");
  r.mark.button.click();
  assert("a tap on the mark while the voice speaks changes nothing the reader can see", out() && r.shownMark() === "speaking | out | pause | remember on");
  r.mark.button.click();
  assert("and a second tap is the same word, fold, not a flip back to out", out() && r.shownMark() === "speaking | out | pause | remember on");
  r.mini.play.click();
  assert("pause from the mini-player: the position kept, the face play, the mini-player out", r.line() === "Resume | stop | Paused · passage 1 of 2" && r.shownMark() === "paused | out | play | remember on");
  r.stop.click();
  assert("Stop: the voice has no place, and the reader's last word was to fold — so it folds", folded() && r.shownMark() === "ready | folded | play | remember on");
  r.mark.button.click();
  r.play.click();
  r.stop.click();
  assert("Stop with the reader's word 'out': it stays out", out() && r.shownMark() === "ready | out | play | remember on");
  panel.dispose();
}

console.log("createListenPanel: the mini-player's Download keeps nothing, and its skips move by turn");
{
  const r = rig();
  const panel = mount(r);
  await ableAbsent(r);
  r.mini.download.click();
  assert("Download: the load sent on the tap, no preference kept, the box clear", r.said() === "script,load" && !readPreference(r.store) && !r.remember.checked && r.devices().length === 1);
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  await scripted(r);
  assert("on stage and idle, folded: a download is not a listen", panel.state().kind === "neural" && r.shownMark() === "ready | folded | play | remember off");
  r.mini.forward.focus();
  r.mini.forward.click();
  assert("next turn from the top: the voice sounds the gap before the second turn, the page told to follow, the mini-player out, nothing ahead", r.seeks() === 1 && r.line() === "Pause | stop | Playing · passage 2 of 2" && r.shownMark() === "speaking | out | pause | remember off" && r.mini.forward.disabled && !r.mini.back.disabled);
  assert("the skip that reached the end was disabled under the keyboard's focus: focus is on the mark's button, not the body", r.doc.activeElement === r.mark.button);
  r.mini.back.click();
  assert("previous turn from a turn's start: the turn before it", r.seeks() === 2 && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.mini.back.disabled && !r.mini.forward.disabled);
  panel.dispose();
}

console.log("createListenPanel: Retry after a download-only yes is the yes again, never a Play");
{
  const r = rig();
  const panel = mount(r);
  await ableAbsent(r);
  r.mark.button.click();
  r.mini.download.click();
  r.fail("the worker bundle failed to load");
  assert("the download the reader said yes to fails: the note and its retry", r.shownMark() === "failed | out | note retry | remember off");
  r.mini.retry.click();
  const retried = panel.state();
  assert("Retry spawns again and the word stays download: the voice will not speak unasked when it lands", r.counts.spawned === 2 && retried.kind === "provisioning" && retried.consent.given === "download");
  panel.dispose();
}

console.log("createListenPanel: focus never rides a hidden face out to the body");
{
  const r = rig();
  const panel = mount(r);
  await ableAbsent(r);
  r.mark.button.click();
  r.mini.download.focus();
  assert("the answer reached by keyboard holds focus", r.doc.activeElement === r.mini.download);
  r.mini.download.click();
  assert("the answer taken: its face hides, the load is sent, focus is on the mark's button", r.said() === "script,load" && r.mini.faces.consent.hidden && r.doc.activeElement === r.mark.button);
  r.mark.button.click();
  assert("folded from the button: focus stays on it", r.mini.root.hidden && r.doc.activeElement === r.mark.button);
  panel.dispose();
}

console.log("createListenPanel: a failed voice offers its retry on the mini-player, and an unsupported one nothing");
{
  const r = rig();
  const panel = mount(r);
  r.mark.button.click();
  r.play.click();
  r.fail("the worker bundle failed to load");
  assert("crashed: the note and its retry", r.shownMark() === "failed | out | note retry | remember off" && r.mini.note.textContent === "The voice failed: the worker bundle failed to load");
  r.mini.retry.click();
  assert("Retry from the mini-player: a worker is spawned again, the voice on its way", r.counts.spawned === 2 && r.shownMark() === "checking | out | progress ? | remember off");
  const retriedState = panel.state();
  assert("the crash lowered the reader's Play to download, and Retry keeps it there: a fresh voice, no unasked speech", retriedState.kind === "provisioning" && retriedState.consent.given === "download");
  r.emit({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } });
  assert("unsupported: the note alone, no retry to offer", r.shownMark() === "unsupported | out | note | remember off" && r.mini.note.textContent === "This device can't run the voice: this browser has no WebGPU");
  panel.dispose();
}

console.log("createListenPanel: whatever is sounding is hushed as the voice leaves the stage or the panel is torn down");
{
  const hearing = (r: Rig, voice: string): HTMLButtonElement => {
    const found = r.voices.picker.querySelector<HTMLButtonElement>(`.voice-row[data-role="user"] .voice-option[data-voice="${voice}"] .voice-preview`);
    if (found === null) throw new Error(`fixture: no play for ${voice}`);
    return found;
  };
  const lit = (r: Rig): number => r.voices.picker.querySelectorAll('.voice-preview[data-sounding="true"]').length;
  {
    const r = rig();
    const panel = mount(r);
    r.play.click();
    await arrive(r);
    r.voices.toggle.click();
    hearing(r, "azelma").click();
    assert("a live phrase sounding on stage", r.said().endsWith("synthesize -1") && lit(r) === 2);
    r.fail("boom");
    assert("the worker dies under it: the previewer went with the worker, and the picker shows nothing sounding", lit(r) === 0 && r.line().startsWith("Retry"));
    panel.dispose();
  }
  {
    const r = rig();
    const panel = mount(r);
    r.voices.toggle.click();
    hearing(r, "azelma").click();
    const audio = r.audio();
    assert("a sample sounding: whatever sounded hushed, then its play, lit in both rows", audio.paused === 2 && audio.plays.join() === samplePath("azelma") && lit(r) === 2);
    r.fail("boom");
    assert("the probing worker dies while the sample sounds: the sample plays on — it needs no worker — still lit", audio.paused === 2 && lit(r) === 2 && r.line().startsWith("Retry"));
    panel.dispose();
    assert("dispose hushes it, once, in the same turn as the rest of the teardown", audio.paused === 3 && lit(r) === 0);
    const transports = r.transports.length;
    audio.end();
    assert("its later end reaches a machine that already knows", r.transports.length === transports);
  }
  {
    const r = rig();
    mount(r);
    r.voices.toggle.click();
    hearing(r, "azelma").click();
    const audio = r.audio();
    throws("a bug in the machine — a worker word out of its phase — tears the panel down", () => r.emit({ kind: "disposed" }));
    assert("and the teardown hushed the sample with everything else", audio.paused === 3 && lit(r) === 0);
  }
}

console.log("createListenPanel: a page back from the cache wakes the panel it disposed");
{
  const r = rig();
  const panel = mount(r);
  panel.dispose();
  assert("disposed: the worker released, at the start", r.counts.disposed === 1 && r.counts.listeners() === 0 && r.line() === IDLE_LINE);
  r.mark.button.click();
  panel.wake();
  assert("wake: a worker is spawned to probe again, the store asked again, the mini-player as the reader left it", r.counts.spawned === 2 && r.counts.listeners() === 2 && r.line() === MOUNT_LINE && r.counts.homeAsked === 2 && !r.mini.root.hidden);
  panel.dispose();
}

console.log("createListenPanel: a stale answer never lands on a fresher entry");
{
  const r = rig();
  const panel = mount(r);
  panel.dispose();
  assert("mount and dispose each asked the store; neither has answered", r.counts.homeAsked === 2 && r.line() === IDLE_LINE);
  r.answer.home({ kind: "resident" });
  await Promise.resolve();
  assert("the mount's answer, arriving after the dispose asked again, is dropped", r.line() === IDLE_LINE);
  r.answer.home(ABSENT);
  await Promise.resolve();
  assert("the dispose's own answer is shown", r.line() === ABSENT_LINE);
  r.play.click();
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "load-failed", failure: { kind: "network", url: "u", message: "offline" } });
  r.play.click();
  assert("a failed load and its retry each asked the browser to keep the bytes", r.counts.keepAsked === 2 && r.line() === "Listen(off) | stop(off) | Preparing the voice…");
  r.answer.keep({ kind: "granted" });
  await Promise.resolve();
  assert("the failed load's answer, arriving after the retry asked again, is dropped", r.line() === "Listen(off) | stop(off) | Preparing the voice…");
  r.answer.keep({ kind: "denied" });
  await Promise.resolve();
  assert("the retry's own answer is shown", r.line() === "Listen(off) | stop(off) | Preparing the voice… · this browser may drop the voice when space is short; the next listen would download it again");
  r.fail("boom");
  r.play.click();
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.fail("boom again");
  assert("a crash drops the answer to the load it ended", r.counts.keepAsked === 3 && r.line() === "Retry | stop(off) | The voice failed: boom again");
  r.answer.keep({ kind: "granted" });
  await Promise.resolve();
  assert("the crashed load's answer is not shown beside the failure", r.line() === "Retry | stop(off) | The voice failed: boom again");
  panel.dispose();
}

console.log("createListenPanel: a crash mid-passage keeps the place, and Retry resumes there");
{
  const r = rig();
  const panel = mount(r);
  r.play.click();
  await arrive(r);
  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  r.emit({ kind: "done", unitId: 0, report: report(FRAME_S * 1000), elapsedMs: 5 });
  r.emit({ kind: "audio", unitId: 1, frameIndex: 0, pcm: frame(1, 0) });
  r.emit({ kind: "done", unitId: 1, report: report(FRAME_S * 1000), elapsedMs: 5 });
  r.devices()[0]?.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("playing the second unit of passage 1", r.where() === "t1 21-42 of 1");
  r.fail("boom");
  assert("the crash keeps the reported place by name: the character under the clock in passage 1's second unit", r.devices()[0]?.calls.at(-1) === "close" && held(panel.state()) === "0:23" && r.line() === "Retry | stop(off) | The voice failed: boom");
  r.play.click();
  await flush();
  assert("Retry: the script still held, the voice is back on stage where it fell before the new worker has even probed, asking for that unit, on a fresh device", panel.state().kind === "neural" && r.devices().length === 2 && r.said().endsWith("synthesize 1") && r.where() === "t1 21-42 of 1");
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("and the model loads behind it on the tap's consent", r.said().endsWith("synthesize 1,load"));
  panel.dispose();
}

console.log("createListenPanel: a bug in the machine tears the panel down, loudly");
{
  const r = rig();
  const panel = mount(r);
  r.play.click();
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  const foreign = [unit({ ...one, text: "Another page entirely." }, 0, 22), unit({ ...two }, 0, 8)];
  const thrown = await escaped(() => scripted(r, foreign));
  assert("a script that is not this page's is refused out of the dispatch that builds over it", thrown instanceof Error && thrown.message.includes("passage 0 of the script"));
  const after = panel.state();
  assert("after the throw: the worker released, the device closed, no cursor ever painted, the panel at its start", r.counts.disposed === 1 && r.counts.listeners() === 0 && r.devices()[0]?.calls.at(-1) === "close" && r.positions.every((at) => at === null) && r.frames.pending === 0 && after.kind === "provisioning" && after.model.kind === "idle" && r.line() === IDLE_LINE);
  r.play.click();
  assert("Play after the teardown starts over: a worker is spawned and a device opened", r.counts.spawned === 2 && r.devices().length === 2 && r.line() === "Listen(off) | stop(off) | Checking this device for the voice…");
  panel.dispose();
}

console.log("createListenPanel: a teardown that fails too goes out with the bug it followed");
{
  const r = rig();
  const panel = mount(r);
  r.play.click();
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  r.refusing.dispose = true;
  const foreign = [unit({ ...one, text: "Another page entirely." }, 0, 22), unit({ ...two }, 0, 8)];
  const caught = await escaped(() => scripted(r, foreign));
  const errors = caught instanceof AggregateError ? caught.errors.map((e) => (e instanceof Error ? e.message : String(e))) : [];
  assert("both failures go out as one AggregateError: the bug first, the teardown second", errors.length === 2 && errors[0]?.includes("passage 0 of the script") === true && errors[1] === "the worker would not dispose" && r.counts.disposed === 1);
  r.refusing.dispose = false;
  panel.dispose();
  assert("the panel is not left draining: the next event is handled, the worker disposed, the device closed, at the start", panel.state().kind === "provisioning" && r.counts.disposed === 2 && r.devices()[0]?.calls.at(-1) === "close" && r.line() === IDLE_LINE);
}

console.log("createListenPanel: the page re-seated — the narrator gains each turn's digest, and the script it was cut from goes with it (slopspot-turn-digest-8xc.p1n)");
{
  const r = rig();
  const panel = mount(r);
  // The page as it is once the digests land: a narrator announcement in front of turn 1,
  // exactly what speech.ts withDigests composes. Every index after it has moved by one.
  const digest: Utterance = { index: 1, anchor: "t1", origin: "announcement", voice: "narrator", text: "They ask about the build." };
  const digestTwo: Utterance = { index: 2, anchor: "t2", origin: "announcement", voice: "narrator", text: "The reply is short." };
  const withDigest = [digest, one, digestTwo, two];

  assert("mounted: the first ask is out, over the page the server sent", r.said() === "script" && r.sent[0]?.kind === "script" && r.sent[0].id === FIRST_SCRIPT_ID && r.sent[0].utterances === utterances);
  assert("nothing is on stage and nobody has named a place, so the page may be re-seated", reseatable(panel.state()));

  panel.reseat(withDigest);
  const second = r.sent[1];
  if (second?.kind !== "script") throw new Error("the re-seat did not ask for a script");
  assert("re-seating asks again, over the new page, under a NEW id", r.said() === "script,script" && second.utterances === withDigest && second.id !== FIRST_SCRIPT_ID);
  assert("and the panel is waiting again rather than holding the script it had", panel.state().kind === "provisioning" && panel.state().kind === "provisioning" && (panel.state() as Extract<PanelState, { kind: "provisioning" }>).script.kind === "asked");

  // The first ask's answer arrives LATE, as it does on a real first visit: a worker holds a
  // script request until its model is ready, which is the whole download away.
  r.emit({ kind: "script", id: FIRST_SCRIPT_ID, units });
  await flush();
  assert("the superseded script is dropped, not built over: the panel still waits", (panel.state() as Extract<PanelState, { kind: "provisioning" }>).script.kind === "asked");

  const digestUnits = [unit({ ...digest }, 0, digest.text.length), ...units];
  r.emit({ kind: "script", id: second.id, units: digestUnits });
  await flush();
  assert("the standing ask's answer is taken", (panel.state() as Extract<PanelState, { kind: "provisioning" }>).script.kind === "held");

  // A turn skip lands on a gap, and a gap is laid before every run of a new ANCHOR
  // (timeline.ts). The digest carries its TURN's anchor, not one of its own, so it joins the
  // head of that run: the skip lands on the gap in front of the digest, and the digest runs
  // straight into the turn it is about with no pause between them — which is the whole of
  // "skipping to a turn lands on its digest", falling out of the anchor rather than out of a
  // rule the skip would have to learn [LAW:one-source-of-truth].
  const digestLine = timelineOfUtterances(withDigest);
  assert(
    "the gap stays at the TURN boundary: the digest and the turn it is about run together, with no pause laid between them",
    digestLine.segments.map((segment) => segment.content.kind).join() === "speech,speech,silence,speech,speech",
  );
  assert(
    "so the digests add no landmark of their own: a skip still counts turns, not sentences",
    landmarks(digestLine).length === landmarks(timelineOfUtterances(utterances)).length,
  );
  // What a forward skip lands on is the gap; what is SAID next is whatever begins after it.
  const afterTheGap = digestLine.segments[3]?.content;
  assert(
    "and what the voice says after that gap is turn 2's digest, before a word of turn 2",
    afterTheGap?.kind === "speech" && withDigest[afterTheGap.utterance] === digestTwo,
  );

  // A cue is a Place, which is an INDEX into the list it was named in, so a page carrying the
  // narrator's digests would point it at a different utterance.
  // A tap on a word, which is how a reader names a place before any voice exists.
  panel.send({ kind: "place", to: mark(1, 0) });
  assert("a named place closes the door: the page is not re-seatable while one is cued", !reseatable(panel.state()));
  throws("and re-seating anyway is said, never absorbed", () => panel.reseat(utterances));

  panel.dispose();
}

{
  const r = rig();
  const panel = mount(r);
  // The tap is the consent the load waits on; then the whole way to a voice on stage.
  r.play.click();
  await arrive(r);
  assert("a voice on stage is performing units cut from the old text, so the door is closed there too", panel.state().kind === "neural" && !reseatable(panel.state()));
  throws("re-seating under a speaking voice is said", () => panel.reseat(utterances));
  panel.dispose();
}

console.log("createListenPanel: the voice picker — a pick made cold arrives with the voice, one mid-listen restarts the unit, and both survive a reload");
{
  const r = rig();
  const panel = mount(r);
  const { picker, toggle } = r.voices;
  const option = (role: string, voice: string): HTMLElement => {
    const found = picker.querySelector<HTMLElement>(`.voice-row[data-role="${role}"] .voice-option[data-voice="${voice}"]`);
    if (found === null) throw new Error(`fixture: no option ${role}/${voice}`);
    return found;
  };
  const part = <T extends Element>(root: ParentNode, selector: string): T => {
    const found = root.querySelector<T>(selector);
    if (found === null) throw new Error(`fixture: no ${selector}`);
    return found;
  };
  const radio = (role: string, voice: string): HTMLInputElement => part(option(role, voice), "input");
  const hear = (voice: string): HTMLButtonElement => part(option("user", voice), ".voice-preview");
  const note = part<HTMLElement>(picker, ".voice-note");
  const reset = part<HTMLButtonElement>(picker, ".voice-reset");
  const checked = (): string => ["user", "assistant"].map((role) => picker.querySelector<HTMLInputElement>(`.voice-row[data-role="${role}"] input:checked`)?.value ?? "none").join("/");
  const previews = (): HTMLButtonElement[] => [...picker.querySelectorAll<HTMLButtonElement>(".voice-preview")];
  const soundingNow = (): string => previews().filter((b) => b.dataset.sounding === "true").map((b) => b.getAttribute("aria-label")).join();

  assert("mounted: the picker is closed, and the toggle says so", picker.hidden && toggle.getAttribute("aria-expanded") === "false");
  toggle.click();
  assert("the toggle opens it", !picker.hidden && toggle.getAttribute("aria-expanded") === "true");
  assert("two rows, six voices each, the defaults checked", picker.querySelectorAll(".voice-row").length === 2 && picker.querySelectorAll(".voice-option").length === 12 && checked() === "alba/javert");
  assert("the rows are named You and Claude", [...picker.querySelectorAll(".voice-role")].map((l) => l.textContent).join() === "You,Claude");
  assert("each name carries its attribution and licence for the hover", part<HTMLElement>(option("assistant", "javert"), ".voice-label").title === "voice-donations/Butter via Kyutai tts-voices · CC0-1.0");
  // The name labels the radio rather than wrapping it, so that the description below can
  // start in the name's column; a tap on the name must still pick the voice.
  part<HTMLLabelElement>(option("user", "eponine"), ".voice-label").click();
  assert("tapping a name picks its voice, as tapping the radio does", checked() === "eponine/javert");
  radio("user", "alba").click();
  // The name says nothing, and Kyutai's say something false: Alba is a man's voice.
  const about = (role: string, voice: string): HTMLElement => part<HTMLElement>(option(role, voice), ".voice-about");
  assert("each voice says what it is like beside its name, in both rows", about("user", "alba").textContent === "Low and lively · American · masculine" && about("assistant", "alba").textContent === about("user", "alba").textContent);
  assert("every option carries one, and no two rows share an id", picker.querySelectorAll(".voice-about").length === 12 && new Set([...picker.querySelectorAll(".voice-about")].map((el) => el.id)).size === 12);
  // A document resolves a name's `for` to the first id that matches, so two pickers sharing
  // a namespace would leave the second one driving the first. The root lends its own.
  assert("every id and every radio group a picker makes is scoped by its root's name", [...picker.querySelectorAll(".voice-about, .voice-radio")].every((el) => el.id.startsWith(`${picker.id}-`)) && [...picker.querySelectorAll<HTMLInputElement>(".voice-radio")].every((el) => el.name.startsWith(`${picker.id}-`)));
  // The whole point of the namespace, as behaviour: radios group by name across a document,
  // so a second picker sharing one would uncheck this picker's row without a word to it.
  // A root with no id of its own is mounted all the same — it takes a name the document
  // does not yet hold, so nothing is asked of whoever mounts it.
  assert("a second picker drives its own radios, and picking in it leaves the first one's pick alone", ((): boolean => {
    const doc = picker.ownerDocument;
    const bare = doc.createElement("div");
    doc.body.appendChild(bare);
    const theirPicks: string[] = [];
    mountVoicePicker(bare, { pick: (role, voice) => theirPicks.push(`${role}/${voice}`), preview: () => {}, reset: () => {} });
    bare.querySelector<HTMLInputElement>('.voice-row[data-role="user"] .voice-option[data-voice="marius"] input')?.click();
    const ok =
      bare.id !== "" && bare.id !== picker.id &&
      theirPicks.join() === "user/marius" &&
      checked() === "alba/javert";
    bare.remove();
    return ok;
  })());
  assert("the description is the radio's, so the option announces as its name and then what it sounds like", VOICE_IDS.every((voice) => PICKED_VOICES.every((role) => radio(role, voice).getAttribute("aria-describedby") === about(role, voice).id)));
  assert("cold: every voice can be heard, the note says they are samples; nothing to reset", previews().every((b) => !b.disabled) && !note.hidden && note.textContent === "Samples · the voice itself plays once it is ready on this device." && reset.disabled);
  assert("plays are named for assistive tech", hear("azelma").getAttribute("aria-label") === "Hear Azelma");
  hear("azelma").click();
  const audio = r.audio();
  assert("a voice heard cold: its sample played from the page's audio element, and lit in both rows", audio.plays.join() === samplePath("azelma") && soundingNow() === "Hear Azelma,Hear Azelma" && r.devices().length === 0);
  audio.end();
  assert("the sample ends: unlit", soundingNow() === "");
  hear("azelma").click();
  hear("marius").click();
  assert("a second sample over the first: the first paused, the second lit", audio.paused === 6 && audio.plays.length === 3 && soundingNow() === "Hear Marius,Hear Marius");
  audio.end();

  radio("assistant", "marius").click();
  assert("Claude's voice picked while cold: kept on the device, shown checked, reset offered, nothing sent to a worker", readPick(r.store).assistant === "marius" && checked() === "alba/marius" && !reset.disabled && r.said() === "script");
  toggle.click();
  assert("the toggle closes it again; the pick stands", picker.hidden && checked() === "alba/marius");

  r.play.click();
  await arrive(r);
  const [stage] = r.devices();
  assert("the voice arrives with the pick made cold: unit 0, the reader's, in Alba", r.said().endsWith("synthesize 0") && r.sent.at(-1)?.kind === "synthesize" && (r.sent.at(-1) as { voice: string }).voice === "alba" && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  assert("on stage: voices heard live, the note gone", note.hidden);

  hear("azelma").click();
  const heard = r.devices()[1];
  assert("a preview tapped mid-listen: the reading pauses, the phrase is asked under an id below zero in that voice, on a device of its own opened by the tap", r.line() === "Resume | stop | Paused · passage 1 of 2" && r.said().endsWith("synthesize -1") && (r.sent.at(-1) as { voice: string }).voice === "azelma" && r.devices().length === 2 && heard?.calls.join() === "resume");
  assert("the picker lights the voice sounding, in both rows: it is the voice that sounds, not the row", soundingNow() === "Hear Azelma,Hear Azelma");
  r.emit({ kind: "audio", unitId: -1, frameIndex: 0, pcm: frame(0, 0) });
  r.emit({ kind: "done", unitId: -1, report: report(FRAME_S * 1000), elapsedMs: 1 });
  assert("the phrase plays on the preview's device, not the reading's", heard?.sources.length === 1 && stage?.sources.length === 0 && r.line() === "Resume | stop | Paused · passage 1 of 2");
  heard?.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("the phrase ends: nothing lit, the preview's device suspended", soundingNow() === "" && heard?.calls.join() === "resume,suspend");

  hear("marius").click();
  assert("a second preview: the next id down, its device resumed", r.said().endsWith("synthesize -2") && soundingNow() === "Hear Marius,Hear Marius" && heard?.calls.join() === "resume,suspend,resume");
  r.play.click();
  assert("Play while the phrase sounds: the preview is withdrawn, unlit and its device suspended before the reading resumes, so the two never sound together", r.said().endsWith("cancel -2") && soundingNow() === "" && heard?.calls.join() === "resume,suspend,resume,suspend" && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  r.emit({ kind: "cancelled", unitId: -2 });
  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  r.emit({ kind: "done", unitId: 0, report: report(FRAME_S * 1000), elapsedMs: 5 });
  r.emit({ kind: "audio", unitId: 1, frameIndex: 0, pcm: frame(1, 0) });
  r.emit({ kind: "done", unitId: 1, report: report(FRAME_S * 1000), elapsedMs: 5 });
  assert("resumed: the reader's units arrive and Claude's is asked in the voice picked cold", r.line() === "Pause | stop | Playing · passage 1 of 2" && r.said().endsWith("synthesize 2") && (r.sent.at(-1) as { voice: string }).voice === "marius");

  radio("user", "fantine").click();
  assert("the reader's voice picked mid-listen: the unit under the cursor restarts in it — Claude's request gives way, unit 0 is asked again in Fantine — and the pick is kept", r.said().endsWith("cancel 2,synthesize 0") && (r.sent.at(-1) as { voice: string }).voice === "fantine" && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && readPick(r.store).user === "fantine" && checked() === "fantine/marius");
  r.emit({ kind: "cancelled", unitId: 2 });
  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  assert("the new rendition plays from the unit's start", r.line() === "Pause | stop | Playing · passage 1 of 2" && r.where() === "t1 0-20 of 1");
  panel.dispose();
  assert("dispose closes the preview's device with the reading's", heard?.calls.at(-1) === "close" && stage?.calls.at(-1) === "close");

  // The reload: a fresh page over the same device storage.
  const again = rig({ storage: { store: r.store } });
  const reloaded = mount(again);
  const checkedAgain = (): string => ["user", "assistant"].map((role) => again.voices.picker.querySelector<HTMLInputElement>(`.voice-row[data-role="${role}"] input:checked`)?.value ?? "none").join("/");
  assert("after a reload the pick is still chosen", checkedAgain() === "fantine/marius" && !part<HTMLButtonElement>(again.voices.picker, ".voice-reset").disabled);
  again.play.click();
  await arrive(again);
  assert("and the voice arrives with it", (again.sent.at(-1) as { voice: string }).voice === "fantine");
  part<HTMLButtonElement>(again.voices.picker, ".voice-reset").click();
  assert("reset: the defaults again, nothing left on the device, the request under the cursor withdrawn", checkedAgain() === "alba/javert" && again.store.keys().includes("listen.voices") === false && again.said().endsWith("cancel 0"));
  again.emit({ kind: "cancelled", unitId: 0 });
  assert("the cancel lands: the unit under the cursor is asked again in Alba", again.said().endsWith("cancel 0,synthesize 0") && (again.sent.at(-1) as { voice: string }).voice === "alba");
  again.stop.click();
  part<HTMLButtonElement>(again.voices.picker, '.voice-row[data-role="user"] .voice-option[data-voice="alba"] .voice-preview').click();
  assert("a preview with the voice on stage but idle: nothing to pause, the phrase asked", again.line() === "Listen | stop(off) | Ready" && again.said().endsWith("synthesize -1"));
  reloaded.dispose();
}

console.log("createListenPanel: the media controls are told the transport at every event");
{
  const r = rig();
  const panel = mount(r);
  const last = (): string => {
    const t = r.transports.at(-1);
    return t === undefined ? "nothing" : `${t.playback} ${Math.round(t.atMs)}/${Math.round(t.totalMs)} x${t.speed} u${t.utterance}`;
  };
  assert("before any voice: none, at the top", last().startsWith("none 0/") && last().endsWith("x1 unull"));
  r.play.click();
  await arrive(r);
  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  assert("the voice under way: playing, in the first passage", last().startsWith("playing ") && last().endsWith("x1 u0"));
  panel.send({ kind: "speed", by: 1 });
  assert("a speed step: the rate the platform runs the progress bar at", last().endsWith("x1.25 u0"));
  panel.send({ kind: "place", to: mark(1, 2) });
  assert("a seek into the reply: its passage", last().endsWith("u1"));
  r.play.click();
  assert("paused: paused", last().startsWith("paused "));
  r.stop.click();
  assert("stopped: none", last().startsWith("none 0/"));
  panel.dispose();
}

console.log("createListenPanel: out of view, a voice that runs dry pauses its device, and plays when its audio arrives");
{
  const r = rig();
  const panel = mount(r);
  panel.visibility(true);
  r.play.click();
  await arrive(r);
  const device = r.devices()[0];
  if (device === undefined) throw new Error("fixture: no device opened");
  assert("the voice arrives out of view with nothing made: paused at once, the device suspended, the line says why", device.calls.at(-1) === "suspend" && r.line() === "Pause | stop | Paused in the background until the voice catches up · passage 1 of 2" && r.said().endsWith("synthesize 0"));
  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  assert("part of the unit made: still paused", device.calls.at(-1) === "suspend" && r.line().startsWith("Pause | stop | Paused in the background"));
  r.emit({ kind: "done", unitId: 0, report: report(FRAME_S * 1000), elapsedMs: 5 });
  assert("the whole unit held: the voice plays again, the device resumed", device.calls.at(-1) === "resume" && r.line() === "Pause | stop | Playing · passage 1 of 2");
  panel.visibility(false);
  assert("back in view while playing: nothing to lift", r.line() === "Pause | stop | Playing · passage 1 of 2");
  panel.dispose();
}

// The media controls as the page wires them — shown every transport, pressing into the panel —
// over a stub session and a carrier that only records whether it plays.
const controlsOf = (r: Rig, panel: ReturnType<typeof createListenPanel>) => {
  const handlers = new Map<MediaAction, (details: ActionDetails) => void>();
  const carrier = { paused: true, play: () => ((carrier.paused = false), Promise.resolve()), pause: () => void (carrier.paused = true), addEventListener: () => {} };
  const media = createMediaSession({
    session: { playbackState: "none", metadata: null, setActionHandler: (action, handler) => void handlers.set(action, handler), setPositionState: () => {} },
    metadata: (shown) => shown,
    title: "t",
    speakerOf: () => "",
    send: (gesture) => panel.send(gesture),
    element: () => carrier,
    refused: () => {},
  });
  const sync = (): void => {
    const shown = r.transports.at(-1);
    if (shown !== undefined) media.show(shown);
  };
  const press = (action: MediaAction): void => {
    sync();
    handlers.get(action)?.({});
    sync();
  };
  return { carrier, sync, press };
};

const stalledOutOfView = async (r: Rig, panel: ReturnType<typeof createListenPanel>): Promise<StubDevice> => {
  panel.visibility(true);
  r.play.click();
  await arrive(r);
  const device = r.devices()[0];
  if (device === undefined) throw new Error("fixture: no device opened");
  return device;
};

console.log("createListenPanel: the lock screen over a voice stalled out of view — the listen is on, its carrier plays, and a skip leaves it on");
{
  const r = rig();
  const panel = mount(r);
  const { carrier, sync, press } = controlsOf(r, panel);
  const device = await stalledOutOfView(r, panel);
  sync();
  assert("stalled: the controls are told it plays, so they offer Pause, and the carrier plays on — the page stays the phone's media while its audio is made", r.transports.at(-1)?.playback === "playing" && device.calls.at(-1) === "suspend" && !carrier.paused);
  press("play");
  assert("their Play over it is nothing: the voice is already on its way back", device.calls.at(-1) === "suspend" && r.line().startsWith("Pause | stop | Paused in the background"));
  press("seekbackward");
  assert("their skip moves it and leaves it on: still stalled, still told it plays", r.line().startsWith("Pause | stop | Paused in the background") && r.transports.at(-1)?.playback === "playing" && !carrier.paused);
  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  r.emit({ kind: "done", unitId: 0, report: report(FRAME_S * 1000), elapsedMs: 5 });
  assert("the audio at its new place arrives: it plays", device.calls.at(-1) === "resume" && r.line() === "Pause | stop | Playing · passage 1 of 2");
  panel.dispose();
  sync();
  assert("disposed: the controls are told none, and the carrier is paused", r.transports.at(-1)?.playback === "none" && carrier.paused);
}

console.log("createListenPanel: the lock screen's pause over a stalled voice is a real pause, which audio arriving does not undo");
{
  const r = rig();
  const panel = mount(r);
  const { carrier, press } = controlsOf(r, panel);
  const device = await stalledOutOfView(r, panel);
  press("pause");
  assert("their Pause: paused by the reader now, the controls say so, and the carrier stops", r.transports.at(-1)?.playback === "paused" && r.line().startsWith("Resume | stop | Paused ·") && carrier.paused);
  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  r.emit({ kind: "done", unitId: 0, report: report(FRAME_S * 1000), elapsedMs: 5 });
  assert("the whole unit arrives: nothing plays, the device stays suspended", device.calls.at(-1) === "suspend" && r.line().startsWith("Resume | stop | Paused ·"));
  press("play");
  assert("their Play: the reader's listen again, the carrier with it", device.calls.at(-1) === "resume" && r.transports.at(-1)?.playback === "playing" && !carrier.paused);
  panel.dispose();
}

console.log("createListenPanel: a link opens on its word before any audio exists, and Play starts there");
{
  const r = rig();
  const panel = mount(r);
  panel.open({ kind: "place", place: mark(0, 21) });
  assert("the link's word is painted at once, the page asked to follow it, the mini-player out — no gesture spent, nothing fetched", r.where() === "t1 21-27/21-27 of 1" && r.seeks() === 1 && !r.mini.root.hidden && r.devices().length === 0 && r.said() === "script");
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.answer.home({ kind: "resident" });
  await Promise.resolve();
  assert("the voice on this device: the controls, the share control live for the linked moment, no offer over the link", r.shownMark() === "ready | out | play | remember off" && !r.mini.share.disabled && r.mini.offer.hidden);
  r.mini.play.click();
  await warm(r);
  assert("Play: the voice arrives at the link's place, asking for the unit that holds it, the cursor moving on from the link's word", r.said().endsWith("synthesize 1") && r.where() === "t1 21-42 of 1" && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  panel.dispose();
}

console.log("createListenPanel: over units the device keeps, a link starts on its own word, not its unit's start");
{
  const r = rig();
  const panel = mount(r);
  // Unit 0 kept with no word times; unit 1 ("Second sentence here.") kept with its words
  // measured, "sentence" starting 240 ms in.
  const measured: UnitReport = {
    durationMs: 640,
    alignment: { kind: "words", times: [{ startMs: 0, endMs: 200 }, { startMs: 240, endMs: 480 }, { startMs: 480, endMs: 640 }] },
  };
  r.kept.reports = [report(160), measured, undefined];
  panel.open({ kind: "place", place: mark(0, 28) });
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.answer.home({ kind: "resident" });
  await Promise.resolve();
  r.mini.play.click();
  await warm(r);
  const now = panel.state();
  assert("the device was asked in the reader's voices, once", r.restores.length === 1 && r.restores[0]?.user === DEFAULT_VOICES.user);
  assert("Play: the voice stands on the linked word inside the kept unit — the clock measured before the link resolved — and asks for that unit", now.kind === "neural" && r.said().endsWith("synthesize 1") && r.where() === "t1 21-42/28-36 of 1" && performerAt(now) === 400);
  panel.dispose();
}

console.log("createListenPanel: a paste whose script and audio the device keeps plays on Play, before the model has answered anything");
{
  const r = rig();
  const panel = mount(r);
  r.kept.reports = [report(2 * FRAME_S * 1000), report(FRAME_S * 1000), report(FRAME_S * 1000)];
  // The port answers the script from the device at once: before the probe, before any load.
  await scripted(r);
  assert("the script back before the probe, no consent: nothing built, nothing loaded, Listen offered", panel.state().kind === "provisioning" && r.said() === "script" && r.line() === MOUNT_LINE);
  r.play.click();
  await flush();
  const device = r.devices()[0];
  if (device === undefined) throw new Error("the tap did not open a device");
  assert("Play: on stage at once on the tap's device, asking for unit 0, the model not even probed", panel.state().kind === "neural" && r.said() === "script,synthesize 0" && r.line() === "Pause | stop | Waiting for the voice · passage 1 of 2 · checking this device for the voice…");
  // The port answers unit 0 from the device.
  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  r.emit({ kind: "audio", unitId: 0, frameIndex: 1, pcm: frame(0, 1) });
  r.emit({ kind: "done", unitId: 0, report: report(2 * FRAME_S * 1000), elapsedMs: 3 });
  device.advance(SCHEDULE_LEAD_S + 0.01);
  assert("the kept unit plays while the line says where the model is", r.line() === "Pause | stop | Playing · passage 1 of 2 · checking this device for the voice…" && r.where() === "t1 0-20 of 1");
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("the probe answers behind it: the load goes, on the Play's consent, and the browser is asked to keep the bytes", r.said().endsWith(",load") && r.counts.keepAsked === 1 && r.line().startsWith("Pause | stop | Playing · passage 1 of 2 · preparing the voice…"));
  r.emit({ kind: "load-failed", failure: { kind: "network", url: "u", message: "offline" } });
  assert("the load fails behind it: said on the line, and the kept audio plays on", panel.state().kind === "neural" && r.line() === "Pause | stop | Playing · passage 1 of 2 · the voice could not load: network error fetching u: offline");
  const loadsSaid = (): number => r.said().split(",").filter((kind) => kind === "load").length;
  r.play.click();
  assert("a Pause retries nothing", loadsSaid() === 1 && r.counts.keepAsked === 1);
  r.play.click();
  assert("the Play after it tries the load again", loadsSaid() === 2 && r.counts.keepAsked === 2);
  panel.dispose();
}

console.log("createListenPanel: the word under the voice is kept as it moves; a return offers it, and the offer's tap starts there");
{
  const r = rig();
  const panel = mount(r);
  r.play.click();
  await arrive(r);
  // Unit 0, "First sentence here.", measured with a time per word.
  const unitMs = 3 * FRAME_S * 1000;
  const third = unitMs / 3;
  for (const index of [0, 1, 2]) r.emit({ kind: "audio", unitId: 0, frameIndex: index, pcm: frame(0, index) });
  r.emit({
    kind: "done",
    unitId: 0,
    report: { durationMs: unitMs, alignment: { kind: "words", times: [{ startMs: 0, endMs: third }, { startMs: third, endMs: 2 * third }, { startMs: 2 * third, endMs: unitMs }] } },
    elapsedMs: 5,
  });
  const device = r.devices()[0];
  if (device === undefined) throw new Error("fixture: no device opened");
  device.advance(SCHEDULE_LEAD_S + (1.5 * third) / 1000);
  r.frames.tick();
  assert("mid-word: the cursor on 'sentence', and that word's first character is what the device keeps", r.where() === "t1 0-20/6-14 of 1" && readResume(r.store, SLUG, printed)?.char === 6 && r.store.keys().join() === `listen.resume.${SLUG}`);
  device.advance(third / 1000);
  r.frames.tick();
  assert("the next word: kept as the voice reaches it", readResume(r.store, SLUG, printed)?.char === 15);
  r.play.click();
  assert("paused: the kept word is the word the voice stopped on, and no offer is made over a paused voice", readResume(r.store, SLUG, printed)?.char === 15 && r.mini.offer.hidden);
  panel.dispose();

  // The tab closes; the reader comes back to the same paste on the same device.
  const back = rig({ storage: { store: r.store } });
  const returned = mount(back);
  assert("on return, before any tap: the mini-player is out with the offer, quoting the kept word onwards; nothing painted, nothing fetched", !back.mini.root.hidden && !back.mini.offer.hidden && back.mini.resume.textContent === "Resume “here. Second sentence here.”" && back.mini.gone.hidden && back.positions.length === 0 && back.devices().length === 0);
  back.mini.resume.click();
  assert("the offer's tap is a tap on the kept word: the device opened on it, the worker spawned, the word painted, the offer gone", back.devices().length === 1 && back.counts.spawned === 1 && back.where() === "t1 15-20/15-20 of 1" && back.mini.offer.hidden && held(returned.state()) === "0:15" && back.seeks() === 1);
  await arrive(back);
  assert("the voice arrives and starts from the unit holding the word — its audio not yet measured on this visit, so its start", back.said().endsWith("synthesize 0") && back.where() === "t1 0-20 of 1");
  returned.dispose();

  // The passage the word was in has been re-derived since.
  const store = memoryPreferences();
  const earlier = [{ ...one, text: "First sentence here. A different second sentence." }, two];
  writeResume(store, SLUG, { utterances: earlier, prints: await printsOf(earlier) }, mark(0, 21));
  const changed = rig({ storage: { store } });
  const unchanged = mount(changed);
  assert("a place kept against a print this page no longer has: no offer, and the mini-player stays folded", changed.mini.offer.hidden && changed.mini.root.hidden && readResume(store, SLUG, printed) === null);
  unchanged.dispose();
}

console.log("createListenPanel: with only an estimate of the words' times, the device is still written once a word");
{
  // A store that counts what is written to the kept place's key.
  const inner = memoryPreferences();
  const written: string[] = [];
  const store = { ...inner, setItem: (key: string, value: string) => (key.startsWith(RESUME_PREFIX) && written.push(value), inner.setItem(key, value)) };
  const r = rig({ storage: { store } });
  const panel = mount(r);
  r.play.click();
  await arrive(r);
  const unitMs = 3 * FRAME_S * 1000;
  for (const index of [0, 1, 2]) r.emit({ kind: "audio", unitId: 0, frameIndex: index, pcm: frame(0, index) });
  // Unit 0, "First sentence here.", with its word times estimated, not measured.
  const third = unitMs / 3;
  r.emit({
    kind: "done",
    unitId: 0,
    report: { durationMs: unitMs, alignment: { kind: "estimated", times: [{ startMs: 0, endMs: third }, { startMs: third, endMs: 2 * third }, { startMs: 2 * third, endMs: unitMs }] } },
    elapsedMs: 5,
  });
  const device = r.devices()[0];
  if (device === undefined) throw new Error("fixture: no device opened");
  device.advance(SCHEDULE_LEAD_S);
  // Sixty looks across the unit: a character moves under the voice every few of them.
  for (let i = 0; i < 60; i++) {
    device.advance(unitMs / 60 / 1000);
    r.frames.tick();
  }
  const chars = written.map((value) => Number(value.split(".")[1]));
  assert("one write per word the voice crossed, each at its word's first character — the last the next unit's first, as the voice reaches it", chars.join() === "0,6,15,21");
  panel.dispose();
}

console.log("createListenPanel: a listen heard to its end forgets its place; the reader's Stop keeps it");
{
  const r = rig();
  const panel = mount(r);
  panel.send({ kind: "place", to: mark(1, 2) });
  await arrive(r);
  r.emit({ kind: "audio", unitId: 2, frameIndex: 0, pcm: frame(2, 0) });
  r.emit({ kind: "audio", unitId: 2, frameIndex: 1, pcm: frame(2, 1) });
  r.emit({ kind: "done", unitId: 2, report: report(2 * FRAME_S * 1000), elapsedMs: 5 });
  const device = r.devices()[0];
  device?.advance(SCHEDULE_LEAD_S + FRAME_S / 2);
  r.frames.tick();
  assert("under way in the last passage: its word is kept", readResume(r.store, SLUG, printed)?.char === 2);
  device?.advance(FRAME_S * 2);
  assert("the last unit ends, no frame between: the kept place is forgotten, and nothing is offered", r.line() === "Listen | stop(off) | Ready" && readResume(r.store, SLUG, printed) === null && !r.store.keys().some((key) => key.startsWith(RESUME_PREFIX)) && r.mini.offer.hidden);
  panel.dispose();

  const s = rig();
  const stopped = mount(s);
  stopped.send({ kind: "place", to: mark(1, 2) });
  await arrive(s);
  s.emit({ kind: "audio", unitId: 2, frameIndex: 0, pcm: frame(2, 0) });
  s.emit({ kind: "audio", unitId: 2, frameIndex: 1, pcm: frame(2, 1) });
  s.emit({ kind: "done", unitId: 2, report: report(2 * FRAME_S * 1000), elapsedMs: 5 });
  s.devices()[0]?.advance(SCHEDULE_LEAD_S + FRAME_S / 2);
  s.frames.tick();
  s.stop.click();
  assert("the reader's Stop: the voice idle, its word still kept and offered", s.line() === "Listen | stop(off) | Ready" && readResume(s.store, SLUG, printed)?.char === 2 && !s.mini.offer.hidden && s.mini.resume.textContent === "Resume “reply.”");
  stopped.dispose();
}

console.log("createListenPanel: a link to a moment the page no longer has says so, until the reader's next gesture");
{
  const r = rig({ storage: { store: (() => { const store = memoryPreferences(); writeResume(store, SLUG, printed, mark(1, 2)); return store; })() } });
  const panel = mount(r);
  panel.open({ kind: "gone" });
  assert("the note shows in place of the offer, the mini-player out, nothing painted, nothing followed", !r.mini.root.hidden && !r.mini.gone.hidden && r.mini.resume.hidden && r.mini.gone.textContent?.startsWith("The linked moment is gone") === true && r.positions.length === 0 && r.seeks() === 0);
  panel.send({ kind: "speed", by: 1 });
  assert("the reader's next gesture is their answer: the note goes, and the kept place is offered", r.mini.gone.hidden && !r.mini.resume.hidden && r.mini.resume.textContent === "Resume “reply.”");
  panel.open({ kind: "none" });
  assert("no link at all changes nothing", r.mini.gone.hidden && r.positions.length === 0);
  panel.dispose();
}

console.log("createListenPanel: the download control makes the conversation's audio file, and says how far it has got");
{
  const r = rig();
  const panel = mount(r);
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.answer.home({ kind: "resident" });
  await Promise.resolve();
  r.mark.button.click();
  assert("no voice on stage: nothing to make a file of, and the control is off", r.mini.save.disabled && r.mini.save.getAttribute("aria-label") === "Download this conversation as audio");
  r.mini.save.click();
  assert("and a tap on it starts nothing", r.renders.length === 0);
  r.mini.play.click();
  await warm(r);
  assert("the voice on stage and ready: the control is on", !r.mini.save.disabled);
  r.mini.save.click();
  const render = r.renders[0];
  assert("a tap renders every unit of the script, in the reader's voices", r.renders.length === 1 && render !== undefined && render.requests.length === units.length && render.requests.every((request, unitId) => request.unitId === unitId && request.voice === DEFAULT_VOICES[units[unitId]!.utterance.voice]));
  assert("and says it has begun", r.mini.save.dataset.phase === "rendering" && r.mini.save.getAttribute("aria-label") === "Making the audio file: 0% of the voice · tap to stop");
  render?.onUnit({ kind: "made", unitId: 0, frames: [frame(0, 0)] });
  render?.onUnit({ kind: "made", unitId: 2, frames: [frame(2, 0)] });
  assert("each unit heard moves it on", r.mini.save.getAttribute("aria-label") === "Making the audio file: 66% of the voice · tap to stop" && r.mini.save.style.getPropertyValue("--fraction") === String(2 / 3));
  r.mini.save.dispatchEvent(new r.doc.defaultView!.FocusEvent("blur"));
  assert("losing focus while it runs leaves it on show", r.mini.save.dataset.phase === "rendering");
  render?.onUnit({ kind: "failed", unitId: 1, reason: { kind: "frame-cap", frames: 500 } });
  // [LAW:no-ambient-temporal-coupling] Until the file is saved or failed, not a count of turns:
  // how long the real encoder takes is the runtime's (Node 22 first imports mediabunny in hundreds).
  for (let turn = 0; turn < 100_000 && r.mini.save.dataset.phase !== "saved" && r.mini.save.dataset.phase !== "failed"; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert("the last unit heard: the file saved under its name, and a passage the voice could not say is named", r.saves.length === 1 && r.saves[0]?.name === "a-paste.wav" && r.mini.save.dataset.phase === "saved" && r.mini.save.getAttribute("aria-label") === "Saved a-paste.wav, without a passage the voice could not say");
  r.mini.save.dispatchEvent(new r.doc.defaultView!.FocusEvent("blur"));
  assert("losing focus puts a finished download's word away", r.mini.save.dataset.phase === undefined && r.mini.save.getAttribute("aria-label") === "Download this conversation as audio");
  r.mini.save.click();
  r.mini.save.click();
  assert("a tap while one runs withdraws it, and the control is back to its question", r.renders.length === 2 && r.renders[1]?.withdrawn === true && r.mini.save.dataset.phase === undefined);
  r.mini.save.click();
  panel.dispose();
  assert("a download the voice's end cuts short is withdrawn, and says why", r.renders[2]?.withdrawn === true && r.mini.save.dataset.phase === "failed" && r.mini.save.getAttribute("aria-label") === "Could not make the audio file: the voice stopped before the file was made");
}

console.log("createListenPanel: the share control hands over the moment on screen, and says whether it was copied");
{
  const r = rig();
  const panel = mount(r);
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.answer.home({ kind: "resident" });
  await Promise.resolve();
  r.mark.button.click();
  assert("nothing playing, nothing cued: there is no moment to link, and the control says so by being off", r.shownMark() === "ready | out | play | remember off" && r.mini.share.disabled);
  r.mini.play.click();
  await warm(r);
  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  r.emit({ kind: "done", unitId: 0, report: report(FRAME_S * 1000), elapsedMs: 5 });
  r.emit({ kind: "audio", unitId: 1, frameIndex: 0, pcm: frame(1, 0) });
  r.devices()[0]?.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  r.frames.tick();
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };
  r.mini.share.click();
  await settle();
  const link = r.links.at(-1);
  assert("under way: the link is to the place under the voice — the place the device keeps — and the control says it was copied", r.links.length === 1 && link !== undefined && link.utterance === 0 && link.char >= 21 && link.char === readResume(r.store, SLUG, printed)?.char && r.mini.share.dataset.shared === "copied" && r.mini.share.getAttribute("aria-label") === "Link copied");
  r.mini.share.dispatchEvent(new r.doc.defaultView!.FocusEvent("blur"));
  assert("losing focus puts the control back to its question", r.mini.share.dataset.shared === undefined && r.mini.share.getAttribute("aria-label") === "Copy a link to this moment");
  r.clipboard.answer = "refuses";
  r.mini.share.click();
  await settle();
  assert("a refused clipboard is said on the control, with the reason", r.mini.share.dataset.shared === "failed" && r.mini.share.getAttribute("aria-label") === "Could not copy the link: clipboard refused");
  r.mini.share.dispatchEvent(new r.doc.defaultView!.FocusEvent("blur"));
  r.clipboard.answer = "throws";
  r.mini.share.click();
  await settle();
  assert("a page with no clipboard at all, whose share throws before any promise: said on the control the same way", r.mini.share.dataset.shared === "failed" && r.mini.share.getAttribute("aria-label") === "Could not copy the link: no clipboard");
  r.mini.play.click();
  assert("the reader's next gesture clears it too", r.mini.share.dataset.shared === undefined);
  r.mini.play.click();
  r.clipboard.answer = "copies";
  r.mini.share.click();
  r.mini.play.click();
  await settle();
  assert("an answer that lands after the reader moved on relabels nothing", r.mini.share.dataset.shared === undefined && r.mini.share.getAttribute("aria-label") === "Copy a link to this moment");
  panel.dispose();
}

console.log(process.exitCode === 1 ? "listen-panel-check: FAILED" : "listen-panel-check: ok");
