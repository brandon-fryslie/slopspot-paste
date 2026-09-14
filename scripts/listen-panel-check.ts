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
import { readPreference, writePreference, type StandingConsent } from "../src/listenConsent";
import {
  createListenPanel,
  DOWNLOAD_BYTES,
  initialState,
  markForm,
  readout,
  SCRIPT_ID,
  step as stepOn,
  type MarkForm,
  type PanelEvent,
  type PanelState,
  type ListenControls,
  type Visit,
} from "../src/listenPanel";
import type { ConnectionReading } from "../src/modelAssets";
import { utteranceTable, type NeuralView } from "../src/neuralPerformer";
import type { Keeping, Residency } from "../src/modelResidency";
import type { Mark, Speed } from "../src/performer";
import type { ReadAlongAt } from "../src/readAlong";
import type { Utterance } from "../src/speech";
import { emptyManifest, type UnitReport } from "../src/speechManifest";
import { timeAt, timelineOfScript } from "../src/timeline";
import type { SynthesisUnit } from "../src/speechScript";
import type { SynthesisPort } from "../src/synthesisClient";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { SCHEDULE_LEAD_S } from "../src/unitPlayer";
import { DEFAULT_PICK, readPick, writePick } from "../src/voiceChoice";
import { FRAME_S, frame, StubDevice } from "./playbackStub";
import { memoryPreferences } from "./preferenceStub";

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
const one: Utterance = { index: 1, anchor: "t1", voice: "user", text: "First sentence here. Second sentence here." };
const two: Utterance = { index: 2, anchor: "t2", voice: "assistant", text: "A reply." };
const utterances = [one, two];
const unit = (utterance: Utterance, start: number, end: number): SynthesisUnit => ({ utterance, start, end, text: utterance.text.slice(start, end) });
const units: SynthesisUnit[] = ((): SynthesisUnit[] => {
  const [a, b] = [{ ...one }, { ...two }];
  return [unit(a, 0, 20), unit(a, 21, 42), unit(b, 0, 8)];
})();
const table = utteranceTable(utterances, units);
// The pure step over this page: every state's answer to every event.
const step = (state: PanelState, event: PanelEvent): ReturnType<typeof stepOn> => stepOn(state, event, utterances);

// Worker messages arrive at the check's own time: zero unless a case reads the pace.
const worker = (message: FromWorker, at = 0): PanelEvent => ({ kind: "worker", message, at });
const tapPlay: PanelEvent = { kind: "tap", control: "play" };
const tapStop: PanelEvent = { kind: "tap", control: "stop" };
const progress = (loadedBytes: number, totalBytes: number, at = 0): PanelEvent => worker({ kind: "progress", progress: { loadedBytes, totalBytes } }, at);
const report = (durationMs: number): UnitReport => ({ durationMs, alignment: { kind: "unit" } });
const mark = (utterance: number, char = 0): Mark => ({ utterance, char });
const seekTo = (utterance: number, char = 0): PanelEvent => ({ kind: "seek", to: { kind: "mark", mark: mark(utterance, char) } });
// Where a mark falls on the voice's clock before anything is measured, as the effect prints it.
const atMs = (utterance: number, char = 0): string => `${Math.round(timeAt(timelineOfScript(emptyManifest(units), table), mark(utterance, char)))}ms`;
const supported: PanelEvent = worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
const ready: PanelEvent = worker({ kind: "ready", backend: "webgpu", modelVersion: "v" });
const scriptBack: PanelEvent = worker({ kind: "script", id: SCRIPT_ID, units });

const viewOf = (player: NeuralView["player"]): NeuralView => ({
  player,
  manifest: emptyManifest(units),
  holdings: units.map(() => ({ kind: "absent" })),
  timeline: timelineOfScript(emptyManifest(units), table),
});

const effects = (s: ReturnType<typeof step>): string =>
  s.effects
    .map((e) =>
      e.kind === "perform"
        ? `perform ${e.event.kind}${e.event.kind === "seek" ? ` ${Math.round(e.event.toMs)}ms` : ""}`
        : e.kind === "release"
          ? `release ${e.worker}`
          : e.kind,
    )
    .join();
// A visit that remembered nothing, on a connection nobody metered: what every reader is
// until the hover says otherwise.
const ASKING: Visit = { remembered: false, metered: false, pick: DEFAULT_PICK };
const shown = (state: PanelState, visit: Visit = ASKING): string => {
  const r = readout(state, utterances, visit);
  return `${r.play.label}${r.play.enabled ? "" : "(off)"} | stop${r.stop.enabled ? "" : "(off)"} | ${r.status}${r.progress === null ? "" : ` | bar ${r.progress.loadedBytes}/${r.progress.totalBytes}`}`;
};
// The turn-skip and speed controls, as `readout` shows them.
const around = (state: PanelState, visit: Visit = ASKING): string => {
  const r = readout(state, utterances, visit);
  return `back${r.skip.back ? "" : "(off)"} | forward${r.skip.forward ? "" : "(off)"} | ${r.speed.label}${r.speed.slower ? "" : " slower(off)"}${r.speed.faster ? "" : " faster(off)"}`;
};
// The place a voice on its way starts from, as "utterance:char"; a voice on stage has none.
const held = (state: PanelState): string => (state.kind === "provisioning" ? `${state.from.utterance}:${state.from.char}` : "on stage");
// Sizes round up to the megabyte, as the panel says them.
const MB = `${Math.ceil(DOWNLOAD_BYTES / 1e6)} MB`;
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
  assert("idle: Play is the only enabled control, the store is being asked, and the place is the top", shown(idle) === IDLE_LINE && held(idle) === "0:0");
  assert("the store's word, resident: the voice is on this device, before any tap", shown(step(idle, home({ kind: "resident" })).state) === RESIDENT_LINE);
  assert("absent: the bytes still to download are named, not the whole model", shown(step(idle, home({ kind: "absent", bytesToDownload: 120_000_000 })).state) === "Listen | stop(off) | The voice downloads 120 MB once, then runs on this device");
  assert("unavailable: the store's reason, and that each listen downloads the whole model", shown(step(idle, home({ kind: "unavailable", message: "private browsing" })).state) === `Listen | stop(off) | This browser can't keep the voice (private browsing); each listen downloads ${MB}`);
  assert("the keep request's answer is not asked of an idle voice, but shown if it arrives: denied names the consequence", shown(step(idle, kept({ kind: "denied" })).state) === "Listen | stop(off) | Looking for the voice on this device… · this browser may drop the voice when space is short; the next listen would download it again");
  const probing = step(idle, tapPlay);
  assert("tap play from idle spends the gesture on the device and spawns the worker to probe; Play has nothing more to say", effects(probing) === "unlock,spawn" && shown(probing.state) === "Listen(off) | stop(off) | Checking this device for the voice…");
  const again = step(probing.state, tapPlay);
  assert("a tap while probing spends its gesture and changes nothing else", effects(again) === "unlock" && shown(again.state) === shown(probing.state) && held(again.state) === "0:0");
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
  assert("retry spends its gesture and sends load again on the same worker", effects(retried) === "unlock,load" && shown(retried.state).startsWith("Listen(off)"));

  const scripting = step(warming.state, ready);
  assert("ready: the script is sent", effects(scripting) === "script" && shown(scripting.state) === "Listen(off) | stop(off) | Preparing the script…");
  const built = step(scripting.state, scriptBack);
  assert("the units back: the performer is built, the phase unchanged until its first view", built.state === scripting.state && effects(built) === "build");
  throws("a script reply with another id is not ours", () => step(scripting.state, worker({ kind: "script", id: 7, units })));

  const listening = step(built.state, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("the performer's first view puts the voice on stage and sends it to the top: the tap was the consent", listening.state.kind === "neural" && effects(listening) === "perform rate,perform seek 0ms" && shown(listening.state) === "Listen | stop(off) | Ready");
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
  const playing = step(listening.state, { kind: "view", view: viewOf({ kind: "speaking", at: { unitIndex: 2, offsetMs: 0 }, flow: "audio" }) });
  assert("tap play while speaking hushes any preview, then pauses", effects(step(playing.state, tapPlay)) === "hush,perform pause");
  assert("tap stop while speaking hushes any preview, then stops", effects(step(playing.state, tapStop)) === "hush,perform stop");
  const failedHolding: NeuralView["holdings"][number] = { kind: "failed", reason: { kind: "frame-cap", frames: 500 }, frames: "none" };
  const holdings: NeuralView["holdings"] = units.map((_, i): NeuralView["holdings"][number] => (i === 1 ? failedHolding : { kind: "absent" }));
  const withFailure = { ...viewOf({ kind: "speaking", at: { unitIndex: 2, offsetMs: 0 }, flow: "audio" }), holdings };
  assert("a failed unit is named by its passage and its reason, after the player's own line", shown(step(playing.state, { kind: "view", view: withFailure }).state) === "Pause | stop | Playing · passage 2 of 2 · passage 1 of 2 could not be synthesized: the model looped for 500 frames without finishing");

  // A tap on the page: the place is kept for the voice's arrival.
  const tapped = step(idle, seekTo(1, 3));
  assert("a seek from idle spawns the worker like Play, and holds the place", effects(tapped) === "unlock,spawn" && held(tapped.state) === "1:3");
  const tappedTwice = step(tapped.state, seekTo(0, 21));
  assert("a later seek replaces the place, spends its gesture and spawns nothing more", effects(tappedTwice) === "unlock" && held(tappedTwice.state) === "0:21");
  const arriving = [supported, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, tappedTwice.state);
  assert("the place is held through the whole way to audio", held(arriving) === "0:21");
  const arrivedAtPlace = step(arriving, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("the voice arriving after a tap is sent to the tapped place", effects(arrivedAtPlace) === `perform rate,perform seek ${atMs(0, 21)}` && arrivedAtPlace.state.kind === "neural");

  const crashed = step(downloading.state, { kind: "worker-error", message: "the worker bundle failed to load" });
  assert("a worker error while downloading: crashed, everything released, Play reads Retry", effects(crashed) === "release terminate,home" && shown(crashed.state) === "Retry | stop(off) | The voice failed: the worker bundle failed to load");
  assert("an error with no message still names the failure", shown(step(warming.state, { kind: "worker-error", message: "" }).state).endsWith("The voice failed"));
  const crashedOnStage = step(listening.state, { kind: "worker-error", message: "boom" });
  assert("a crash on stage while idle: released, the place the top", effects(crashedOnStage) === "release terminate,home" && held(crashedOnStage.state) === "0:0");
  const fellPlaying = step(playing.state, { kind: "worker-error", message: "boom" });
  assert("a crash while playing keeps the reported place for the retry", held(fellPlaying.state) === "1:0" && shown(fellPlaying.state) === "Retry | stop(off) | The voice failed: boom");
  const fellRewoken = [wake("none"), supported, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, fellPlaying.state);
  assert("a crash while playing, then a wake: the voice comes back standing at the place, not speaking — the tap's yes went with its device", held(fellRewoken) === "1:0" && effects(step(fellRewoken, { kind: "view", view: viewOf({ kind: "idle" }) })) === "perform rate");
  throws("a view after the crash is a violation: the released performer's last view never reaches step", () => step(crashed.state, { kind: "view", view: viewOf({ kind: "idle" }) }));
  const respawned = step(fellPlaying.state, tapPlay);
  assert("Retry after a crash spawns a fresh worker and probes, the place still held", effects(respawned) === "unlock,spawn" && held(respawned.state) === "1:0" && shown(respawned.state).startsWith("Listen(off)"));
  const disposedMid = step(playing.state, { kind: "dispose" });
  assert("dispose, anywhere: back to the start, the live worker asked to dispose", shown(disposedMid.state) === IDLE_LINE && held(disposedMid.state) === "0:0" && effects(disposedMid) === "release dispose,home");

  // The browser's answer to keeping the bytes rides the status line while the voice is on
  // its way; a late answer to a voice on stage changes nothing.
  const kept1 = step(preparing.state, kept({ kind: "granted" }));
  assert("keeping granted while preparing: said beside the phase", shown(kept1.state) === "Listen(off) | stop(off) | Preparing the voice… · this browser will keep the voice");
  const kept2 = step(step(kept1.state, progress(1, 2)).state, kept({ kind: "failed", message: "no StorageManager" }));
  assert("a keep request that failed: its message, beside the download", shown(kept2.state) === "Listen(off) | stop(off) | Downloading the voice · 50% · 0 of 1 MB · estimating time left… · this browser could not be asked to keep the voice: no StorageManager | bar 1/2");
  assert("an answer after the voice took the stage changes nothing", step(listening.state, kept({ kind: "denied" })).state === listening.state && step(listening.state, home({ kind: "resident" })).state === listening.state);
  assert("a crash returns to the start with the store asked again, the last answer dropped", (() => { const s = step(kept1.state, { kind: "worker-error", message: "x" }).state; return s.kind === "provisioning" && s.home.kind === "reading" && s.keeping === null; })());
}

console.log("step: consent is the only door to the weights");
{
  const idle = initialState();
  const woken = step(idle, wake("none"));
  assert("the page's wake with nothing remembered: the worker is spawned to probe, no gesture spent, and Play still reads", effects(woken) === "spawn" && shown(woken.state) === MOUNT_LINE);
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
  assert("Play on an able voice: the gesture spent, then load, and Play has nothing more to say", effects(tappedAble) === "unlock,load" && shown(tappedAble.state) === "Listen(off) | stop(off) | Preparing the voice…");
  const raised = step(said.state, tapPlay);
  assert("Play while the download a yes started runs: the gesture spent, the consent raised to speak", effects(raised) === "unlock" && shown(raised.state) === "Listen(off) | stop(off) | Preparing the voice…");
  const arrivedReady = [progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, said.state);
  const standingReady = step(arrivedReady, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("a voice that arrives on a download alone takes the stage and stands ready: no seek, nothing spoken", standingReady.state.kind === "neural" && effects(standingReady) === "perform rate" && shown(standingReady.state) === "Listen | stop(off) | Ready");
  const arrivedSpeaking = [progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, raised.state);
  assert("a voice that arrives after the consent was raised is sent to its place", effects(step(arrivedSpeaking, { kind: "view", view: viewOf({ kind: "idle" }) })) === "perform rate,perform seek 0ms");

  const yesFirst = step(idle, yes);
  assert("the hover's yes before the probe: the gesture spent and the worker spawned", effects(yesFirst) === "unlock,spawn" && shown(yesFirst.state) === MOUNT_LINE);
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
  assert("a wake after the crash, the yes still standing, spawns again", effects(rewoken) === "spawn");
  assert("and the standing yes loads on the probe's answer", effects(step(rewoken.state, supported)) === "load");
  const withdrawn = step(step(crashedStanding.state, wake("none")).state, supported);
  assert("a wake with the yes withdrawn — the box unchecked, the connection metered — probes and waits", effects(withdrawn) === "" && shown(withdrawn.state) === IDLE_LINE);
  const idleOnStage = step(standingReady.state, { kind: "worker-error", message: "x" });
  const idleRetried = [tapPlay, supported, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, idleOnStage.state);
  assert("a crash on stage while idle, then Retry: the tap is the consent, the voice arrives and speaks", effects(step(idleRetried, { kind: "view", view: viewOf({ kind: "idle" }) })) === "perform rate,perform seek 0ms");
  const idleRewoken = [wake("download"), supported, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, idleOnStage.state);
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
    unavailable: step(able, home({ kind: "unavailable", message: "private browsing" })).state,
    downloading,
    warming,
    speaking: at({ kind: "speaking", at: { unitIndex: 0, offsetMs: 0 }, flow: "audio" }),
    paused: at({ kind: "paused", at: { unitIndex: 0, offsetMs: 0 } }),
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
    const { mini } = readout(state, utterances, visit);
    return mini.kind === "consent" ? mini.ask : null;
  };
  const promised = step(step(idle, wake("download")).state, home(ABSENT)).state;
  assert("a held consent through the probe: checking to the eye, as the sentence says, nothing to ask", markForm(promised).kind === "checking" && ask(promised) === null && shown(promised) === MOUNT_LINE);
  assert("download needed: the hover asks, with the size", ask(forms.download) === "Download speech model? · 239 MB");
  assert("a store that cannot keep the voice: the hover asks for the whole model", ask(forms.unavailable) === `Download speech model? · ${MB}`);
  assert("remembered on a metered connection: the hover says why it asks anyway", ask(forms.download, { ...ASKING, remembered: true, metered: true }) === "Download speech model? · 239 MB · asking because this connection is metered");
  assert("remembered off a metered connection: no note", ask(forms.download, { ...ASKING, remembered: true, metered: false }) === "Download speech model? · 239 MB");
  assert("not remembered on a metered connection: no note — nothing is being overridden", ask(forms.download, { ...ASKING, remembered: false, metered: true }) === "Download speech model? · 239 MB");
  assert("nothing to ask when the voice is here, on its way, on stage, or impossible", [forms.ready, forms.checking, forms.downloading, forms.warming, forms.speaking, forms.paused, forms.unsupported, forms.failed].every((state) => ask(state) === null));
  assert("the preference's box reads the visit", readout(forms.download, utterances, { ...ASKING, remembered: true, metered: false }).remembered && !readout(forms.download, utterances, ASKING).remembered);

  // The turn skips and the speed control read the conversation, not the voice: they are
  // there before any performer exists and unaffected by consent or download state.
  assert("before any voice, standing at the top: no turn before it, one after it", around(idle) === "back(off) | forward | 1×");
  assert("standing at the second turn: back to the first, nothing after it", around(step(idle, seekTo(1)).state) === "back | forward(off) | 1×");
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
  const speaking = step(onStage, { kind: "view", view: viewOf({ kind: "speaking", at: { unitIndex: 0, offsetMs: 0 }, flow: "audio" }) }).state;
  const unsupported = step(probing, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } })).state;
  const voices = (state: PanelState, visit: Visit = ASKING): string => {
    const v = readout(state, utterances, visit).voices;
    return `${v.picked.user}/${v.picked.assistant} | ${v.preview.kind === "offered" ? "offered" : `withheld: ${v.preview.why}`} | ${v.sounding ?? "silent"} | reset ${v.reset ? "on" : "off"}`;
  };
  const COLD = "alba/javert | withheld: Previews play once the voice is ready on this device. | silent | reset off";
  assert("cold: the defaults, previews withheld with the reason, nothing sounding, nothing to reset", voices(idle) === COLD && voices(probing) === COLD);
  assert("a device that cannot run the voice: withheld with the honest reason", voices(unsupported) === "alba/javert | withheld: This device can't run the voice, so there is nothing to hear. | silent | reset off");
  assert("on stage, idle or speaking: previews offered", voices(onStage) === "alba/javert | offered | silent | reset off" && voices(speaking) === "alba/javert | offered | silent | reset off");
  const chosen: Visit = { ...ASKING, pick: { user: "marius", assistant: "javert" } };
  assert("the picker reads the device's pick, and a pick off the defaults can be reset", voices(onStage, chosen) === "marius/javert | offered | silent | reset on");

  const tapped = step(speaking, { kind: "preview", voice: "azelma" });
  assert("a preview tapped on stage: the reading is paused, then the previewer speaks", effects(tapped) === "perform pause,preview" && tapped.state === speaking);
  const refusedPreview = step(speaking, worker({ kind: "refused", request: { kind: "synthesize", unitId: -1, text: { text: "x", source: "x" }, voice: "azelma" }, phase: "idle" }));
  assert("a refusal with the voice on stage: the performer that asked judges it, the panel stays", effects(refusedPreview) === "" && refusedPreview.state === speaking);
  assert("a preview tapped before the voice is on stage changes nothing", effects(step(probing, { kind: "preview", voice: "azelma" })) === "" && effects(step(idle, { kind: "preview", voice: "azelma" })) === "");
  const heard = step(speaking, { kind: "sounding", voice: "azelma" }).state;
  assert("the previewer's word: the voice sounding shows", voices(heard) === "alba/javert | offered | azelma | reset off");
  assert("and clears when it is over", voices(step(heard, { kind: "sounding", voice: null }).state) === "alba/javert | offered | silent | reset off");
  throws("the previewer's word before the voice is on stage is a bug", () => step(probing, { kind: "sounding", voice: "azelma" }));
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
  <div class="speech-voices" hidden></div>
  <div class="listen-mark" data-state="checking">
    <button class="listen-mark-button" type="button" aria-expanded="false" aria-label="Listen"><span class="listen-mark-glyph"></span></button>
    <div class="listen-mini" data-face="progress" hidden>
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
  readonly port: SynthesisPort;
  readonly sent: ToWorker[];
  readonly emit: (message: FromWorker) => void;
  readonly fail: (message: string) => void;
  readonly counts: { spawned: number; terminated: number; disposed: number; listeners: () => number; homeAsked: number; keepAsked: number };
  // The store's and the browser's answers, given by hand so their timing is the check's.
  readonly answer: { home: (residency: Residency) => void; keep: (keeping: Keeping) => void };
  readonly home: () => Promise<Residency>;
  readonly keep: () => Promise<Keeping>;
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
  readonly where: () => string;
  readonly line: () => string;
  readonly transport: () => string;
  // What the mark and the mini-player show: the form, whether the mini-player is out, its
  // face — the question, the fraction, the note, or what the play button does — and the box.
  readonly shownMark: () => string;
  // The reader's hand on the panel: the box checked or cleared, a key pressed on the page.
  readonly check: (on: boolean) => void;
  readonly press: (key: string) => void;
  // The devices opened since the rig was built, newest last: each gesture or build opens one.
  readonly devices: () => StubDevice[];
}

type Store = ReturnType<typeof memoryPreferences>;
// The device's storage: a fresh one, remembering the download consent or not, or one
// carried over from an earlier rig — the storage surviving a reload, exactly as that rig
// left it.
type Storage = { readonly remembered: boolean } | { readonly store: Store };
const storeOf = (storage: Storage): Store => {
  if ("store" in storage) return storage.store;
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
  const counts = { spawned: 0, terminated: 0, disposed: 0, listeners: () => listeners.size + errorListeners.size, homeAsked: 0, keepAsked: 0 };
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
  const keeps = deferred<Keeping>();
  const refusing = { dispose: false };
  const port: SynthesisPort = {
    send: (message) => sent.push(message),
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
  };
  // The face as the DOM shows it, and what it says.
  const face = (): string => {
    switch (mini.root.dataset.face) {
      case "consent":
        return `ask ${mini.ask.textContent}`;
      case "progress":
        return `progress ${mini.bar.getAttribute("value") ?? "?"}`;
      case "note":
        return `note${mini.retry.hidden ? "" : " retry"}`;
      case "controls":
        return `${mini.play.dataset.does}`;
      default:
        throw new Error(`fixture: mini face ${mini.root.dataset.face}`);
    }
  };
  const opened = StubDevice.instances.length;
  let seekCount = 0;
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
    store,
    connection: { reading: setup.connection },
    refusing,
    said: () => sent.map((m) => (m.kind === "synthesize" ? `synthesize ${m.unitId}` : m.kind === "cancel" ? `cancel ${m.unitId}` : m.kind)).join(),
    frames,
    positions,
    where: () => {
      const at = positions.at(-1);
      return at === null || at === undefined
        ? "silent"
        : `${at.utterance.anchor} ${at.segment.charStart}-${at.segment.charEnd}${at.word === null ? "" : `/${at.word.charStart}-${at.word.charEnd}`} of ${at.turn.length}`;
    },
    line: () => `${play.textContent}${play.disabled ? "(off)" : ""} | stop${stop.disabled ? "(off)" : ""} | ${status.textContent}`,
    // The turn skips, the speed and the scrubber's own reading: what the DOM shows, not the
    // readout the pure machine computed — this is the driver's whole job to have written.
    transport: () =>
      `back${back.disabled ? "(off)" : ""} | forward${forward.disabled ? "(off)" : ""} | ` +
      `slower${slower.disabled ? "(off)" : ""} ${speed.textContent} faster${faster.disabled ? "(off)" : ""} | ` +
      `${played.textContent}/${scrub.value} of ${scrub.max} · ${remaining.textContent}`,
    shownMark: () => {
      const shownFaces = Object.entries(mini.faces).filter(([, el]) => !el.hidden).map(([kind]) => kind);
      if (shownFaces.length !== 1 || shownFaces[0] !== mini.root.dataset.face) throw new Error(`fixture: faces shown ${shownFaces.join()} under ${mini.root.dataset.face}`);
      return `${mark.root.dataset.state} | ${mini.root.hidden ? "folded" : "out"} | ${face()} | remember ${remember.checked ? "on" : "off"}`;
    },
    check: (on) => {
      remember.checked = on;
      remember.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    },
    press: (key) => {
      doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
    },
    devices: () => StubDevice.instances.slice(opened),
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
    preference: { read: () => readPreference(r.store), write: (remembered) => writePreference(r.store, remembered) },
    pick: { read: () => readPick(r.store), write: (pick) => writePick(r.store, pick) },
    connection: () => r.connection.reading,
    Device: StubDevice,
    frames: r.frames,
    clock: () => r.now,
    onPosition: (at) => r.positions.push(at),
    onSeek: r.onSeek,
  });

// The whole way to audio after a tap, as the worker would answer it.
const arrive = (r: Rig): void => {
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  r.emit({ kind: "script", id: SCRIPT_ID, units });
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

  assert("mounted: the worker is spawned to probe, the store asked, nothing sent, no device, the mark checking", r.line() === MOUNT_LINE && r.counts.homeAsked === 1 && r.counts.keepAsked === 0 && r.counts.spawned === 1 && r.sent.length === 0 && r.devices().length === 0 && r.shownMark() === MOUNT_MARK);
  assert("the mark is named for assistive tech by the status line", r.mark.button.getAttribute("aria-label") === "Listen: Checking this device for the voice…");
  r.play.click();
  const device = r.devices()[0];
  if (device === undefined) throw new Error("the tap did not open a device");
  assert("click Play while the probe runs: no second worker, the button disables — the tap is the consent", r.counts.spawned === 1 && r.line() === "Listen(off) | stop(off) | Checking this device for the voice…");
  assert("the audio device is opened AND resumed on the tap, before any worker message", r.devices().length === 1 && device.calls.join() === "resume" && r.sent.length === 0);
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("supported with the tap held: load is sent", r.said() === "load" && r.shownMark() === "warming | folded | progress ? | remember off");
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
  const script = r.sent.at(-1);
  assert("ready: the page's utterances go to the worker under the panel's script id", script?.kind === "script" && script.id === SCRIPT_ID && script.utterances === utterances);

  r.emit({ kind: "script", id: SCRIPT_ID, units });
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
  assert("unit 1 ends into the gap before the second turn: on the next frame nothing is painted", r.where() === "silent" && r.frames.pending === 1);
  device.advance(0.5);
  r.frames.tick();
  assert("crossing into unit 2 past the gap: another turn, its own span", r.where() === "t2 0-8 of 1");
  const before = r.positions.length;
  r.frames.tick();
  assert("a frame with the cursor unmoved reports nothing new", r.positions.length === before && r.frames.pending === 1);

  r.play.click();
  assert("Pause: paused, the loop is off, the label says Resume, the mark paused", r.line() === "Resume | stop | Paused · passage 2 of 2" && r.frames.pending === 0 && r.mark.root.dataset.state === "paused");
  r.play.click();
  assert("Resume: speaking again, the loop is back", r.play.textContent === "Pause" && r.frames.pending === 1);
  panel.send({ kind: "mark", to: mark(0, 25) });
  assert("a tap on the first passage's second sentence: the voice seeks there and the cursor follows", r.where() === "t1 21-42 of 1" && r.line() === "Pause | stop | Playing · passage 1 of 2");
  r.stop.click();
  assert("Stop: idle, the cursor cleared, Stop disabled, Play says Listen, the mark ready", r.line() === "Listen | stop(off) | Ready" && r.positions.at(-1) === null && r.frames.pending === 0 && r.shownMark() === "ready | folded | play | remember off");
  r.play.click();
  assert("Play again starts from the top on the same worker and device: Stop let the audio go, so unit 0 is asked for again", r.counts.spawned === 1 && r.devices().length === 1 && r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.where() === "t1 0-20 of 1");

  r.fail("the worker bundle failed to load");
  assert("the worker dies while playing: the device closed, the worker terminated, no longer heard, Play reads Retry, the mark failed", device.calls.at(-1) === "close" && r.counts.terminated === 1 && r.counts.listeners() === 0 && r.line() === "Retry | stop(off) | The voice failed: the worker bundle failed to load" && r.mark.root.dataset.state === "failed");
  assert("the cursor is cleared with the voice, and the place it stood is kept", r.positions.at(-1) === null && r.frames.pending === 0 && held(panel.state()) === "0:0");
  r.play.click();
  const second = r.devices()[1];
  assert("Retry: a fresh worker is spawned and probed, and a fresh device opened and resumed on the tap", r.counts.spawned === 2 && second !== undefined && second !== device && second.calls.join() === "resume" && r.line() === "Listen(off) | stop(off) | Checking this device for the voice…");
  panel.dispose();
  assert("dispose: the worker disposed (not terminated outright), unheard, the device closed, at the start", r.counts.disposed === 1 && r.counts.terminated === 1 && r.counts.listeners() === 0 && second?.calls.at(-1) === "close" && r.line() === IDLE_LINE);
}

console.log("createListenPanel: a tap on a word before the voice is warm is where it starts");
{
  const r = rig();
  const panel = mount(r);
  panel.send({ kind: "mark", to: mark(0, 21) });
  const device = r.devices()[0];
  assert("a tap on a word while the probe runs opens the device, like Play, and holds the place", r.counts.spawned === 1 && device?.calls.join() === "resume" && r.line() === "Listen(off) | stop(off) | Checking this device for the voice…" && held(panel.state()) === "0:21");
  panel.send({ kind: "mark", to: mark(1) });
  assert("a second tap while the voice is on its way moves the place, nothing else", r.counts.spawned === 1 && r.devices().length === 1 && held(panel.state()) === "1:0");
  arrive(r);
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
  arrive(r);
  assert("on stage at the top: no turn behind, the next turn ahead, speed at 1x and neither end disabled", r.where() === "t1 0-20 of 1" && r.back.disabled && !r.forward.disabled && r.speed.textContent === "1×" && !r.slower.disabled && !r.faster.disabled);
  assert("mounting and arriving named no place: nothing has asked to follow yet", r.seeks() === 0);

  r.forward.click();
  assert("forward lands at the start of the gap before the second turn — silence, nothing painted — and the page is told to follow", r.where() === "silent" && r.line() === "Pause | stop | Synthesizing ahead… · passage 2 of 2" && r.seeks() === 1);
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
  assert("supported with nothing said: the worker waits, nothing sent, the store's answer awaited", r.sent.length === 0 && r.line() === IDLE_LINE && r.shownMark() === MOUNT_MARK);
  r.answer.home({ kind: "resident" });
  await Promise.resolve();
  assert("the store answers: the line says the voice is on this device, the mark ready, no download offered, still nothing sent", r.line() === RESIDENT_LINE && r.shownMark() === "ready | folded | play | remember off" && r.sent.length === 0);
  r.play.click();
  assert("the tap on an able voice: load is sent and the browser is asked to keep the bytes, in that order", r.sent.map((m) => m.kind).join() === "load" && r.counts.keepAsked === 1 && r.line() === "Listen(off) | stop(off) | Preparing the voice…");
  r.answer.keep({ kind: "denied" });
  await Promise.resolve();
  assert("denied: the consequence is on the line beside the phase", r.line() === "Listen(off) | stop(off) | Preparing the voice… · this browser may drop the voice when space is short; the next listen would download it again");
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  assert("and stays there through warming", r.line() === "Listen(off) | stop(off) | Warming up the voice… · this browser may drop the voice when space is short; the next listen would download it again");
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  r.emit({ kind: "script", id: SCRIPT_ID, units });
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
  assert("download needed: the mark says so, the hover asks with the size and offers the yes and the box; nothing sent, no device", r.shownMark() === ASK_MARK && r.line() === ABSENT_LINE && r.sent.length === 0 && r.devices().length === 0 && r.mark.button.getAttribute("aria-label") === "Listen: The voice downloads 239 MB once, then runs on this device");
  r.mini.download.click();
  const device = r.devices()[0];
  assert("yes: the device is opened and resumed on the click, load sent, the browser asked to keep; Play still reads, since a yes is not a Play", device?.calls.join() === "resume" && r.said() === "load" && r.counts.keepAsked === 1 && r.line() === PREPARING_LINE && r.shownMark() === "warming | folded | progress ? | remember off");
  r.emit({ kind: "progress", progress: { loadedBytes: 60_000_000, totalBytes: 240_000_000 } });
  assert("downloading: the ring fills, the question is gone", r.mark.root.dataset.state === "downloading" && r.mark.root.style.getPropertyValue("--fraction") === "0.25" && r.shownMark() === "downloading | folded | progress 0.25 | remember off");
  r.emit({ kind: "progress", progress: { loadedBytes: 240_000_000, totalBytes: 240_000_000 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  r.emit({ kind: "script", id: SCRIPT_ID, units });
  assert("the voice arrives on the yes alone: on stage, Ready, nothing synthesized, no cursor, the mark ready", panel.state().kind === "neural" && r.said() === "load,script" && r.line() === "Listen | stop(off) | Ready" && r.shownMark() === "ready | folded | play | remember off" && r.positions.every((at) => at === null) && r.frames.pending === 0);
  r.play.click();
  assert("Play on the ready voice speaks from the top on the device the yes opened", r.devices().length === 1 && r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.where() === "t1 0-20 of 1");
  panel.dispose();
}

console.log("createListenPanel: the box is the yes for this visit and every next one");
{
  const r = rig();
  const panel = mount(r);
  await ableAbsent(r);
  r.check(true);
  assert("checking the box writes the preference, and the voice loads with no tap and no device", readPreference(r.store) && r.said() === "load" && r.devices().length === 0 && r.line() === PREPARING_LINE && r.shownMark() === "warming | folded | progress ? | remember on");
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  r.emit({ kind: "script", id: SCRIPT_ID, units });
  const device = r.devices()[0];
  assert("a voice built on a standing consent opens its device outside any gesture, unresumed, and stands ready", r.devices().length === 1 && device?.calls.join() === "" && r.line() === "Listen | stop(off) | Ready" && r.said() === "load,script");
  r.play.click();
  assert("the first Play resumes that device on the tap and speaks", device?.calls.includes("resume") === true && r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  r.check(false);
  assert("clearing the box removes the preference; the voice on stage is untouched", r.store.keys().length === 0 && r.shownMark() === "speaking | out | pause | remember off" && r.counts.spawned === 1 && panel.state().kind === "neural");
  panel.dispose();

  const next = rig({ storage: { remembered: true } });
  const nextPanel = mount(next);
  assert("a later visit with the preference: the probe first, the mark checking with nothing to ask, the box checked, nothing sent before the worker is able", next.line() === MOUNT_LINE && next.shownMark() === "checking | folded | progress ? | remember on" && next.sent.length === 0);
  next.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("supported: load is sent with no tap, the browser asked to keep, no device opened", next.said() === "load" && next.counts.keepAsked === 1 && next.devices().length === 0 && next.line() === PREPARING_LINE);
  next.answer.home(ABSENT);
  await Promise.resolve();
  assert("the store's late word does not put a question over a download in flight", next.shownMark() === "warming | folded | progress ? | remember on");
  next.emit({ kind: "load-failed", failure: { kind: "network", url: "u", message: "offline" } });
  next.check(false);
  assert("the download fails and the reader unchecks the box: the preference is gone, nothing is sent again, the failure stays on the line", next.store.keys().length === 0 && next.said() === "load" && next.line() === "Retry | stop(off) | The voice could not load: network error fetching u: offline" && next.shownMark() === "failed | folded | note retry | remember off");
  nextPanel.dispose();
}

console.log("createListenPanel: on a metered connection the remembered yes still asks");
{
  const r = rig({ storage: { remembered: true }, connection: { type: "cellular" } });
  const panel = mount(r);
  await ableAbsent(r);
  assert("nothing loads; the hover asks and says why, the box still checked", r.sent.length === 0 && r.shownMark() === "download | folded | ask Download speech model? · 239 MB · asking because this connection is metered | remember on" && r.line() === ABSENT_LINE);
  r.connection.reading = { type: "wifi" };
  panel.wake();
  assert("off the metered connection, the page's next wake gives the standing yes: load, no gesture", r.said() === "load" && r.devices().length === 0 && r.line() === PREPARING_LINE);
  panel.dispose();

  const tapped = rig({ storage: { remembered: true }, connection: { saveData: true } });
  const tappedPanel = mount(tapped);
  await ableAbsent(tapped);
  tapped.mini.download.click();
  assert("with save-data on, the hover's yes is the reader's own: load on the click", tapped.said() === "load" && tapped.devices()[0]?.calls.join() === "resume");
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
  panel.send({ kind: "mark", to: mark(1) });
  assert("no tap, yes, box or word spawns anything or opens a device on it", r.counts.spawned === 1 && r.devices().length === 0 && r.sent.length === 0 && r.line().startsWith("Listen(off)"));
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
  assert("download needed: the question and its two answers, no controls", r.shownMark() === "download | out | ask Download speech model? · 239 MB | remember off" && r.mini.faces.controls.hidden && r.sent.length === 0);
  r.mini.always.click();
  assert("Always Download: the preference kept, the box in the panel checked, the load sent on the tap's device, the voice on its way", readPreference(r.store) && r.remember.checked && r.said() === "load" && r.devices().length === 1 && r.shownMark() === "warming | out | progress ? | remember on");
  r.emit({ kind: "progress", progress: { loadedBytes: 50_000_000, totalBytes: 200_000_000 } });
  assert("downloading: the fraction on the bar, the panel's sentence on the line", r.shownMark() === "downloading | out | progress 0.25 | remember on" && r.mini.progress.textContent === "Downloading the voice · 25% · 50 of 200 MB · estimating time left…");
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  r.emit({ kind: "script", id: SCRIPT_ID, units });
  assert("the voice arrives on the yes alone: the controls, play, still out on the reader's word; a turn ahead, none behind", r.shownMark() === "ready | out | play | remember on" && r.mini.back.disabled && !r.mini.forward.disabled && r.mini.faces.consent.hidden);
  r.mini.play.click();
  assert("play from the mini-player: the voice speaks from the top, the face pause", r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.shownMark() === "speaking | out | pause | remember on");
  r.mark.button.click();
  assert("a tap on the mark while the voice speaks changes nothing the reader can see", out() && r.shownMark() === "speaking | out | pause | remember on");
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
  assert("Download: the load sent on the tap, no preference kept, the box clear", r.said() === "load" && !readPreference(r.store) && !r.remember.checked && r.devices().length === 1);
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  r.emit({ kind: "script", id: SCRIPT_ID, units });
  assert("on stage and idle, folded: a download is not a listen", panel.state().kind === "neural" && r.shownMark() === "ready | folded | play | remember off");
  r.mini.forward.click();
  assert("next turn from the top: the voice speaks from the second turn, the page told to follow, the mini-player out, nothing ahead", r.seeks() === 1 && r.line() === "Pause | stop | Synthesizing ahead… · passage 2 of 2" && r.shownMark() === "speaking | out | pause | remember off" && r.mini.forward.disabled && !r.mini.back.disabled);
  r.mini.back.click();
  assert("previous turn from a turn's start: the turn before it", r.seeks() === 2 && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.mini.back.disabled && !r.mini.forward.disabled);
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
  assert("the answer taken: its face hides, the load is sent, focus is on the mark's button", r.said() === "load" && r.mini.faces.consent.hidden && r.doc.activeElement === r.mark.button);
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
  r.emit({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } });
  assert("unsupported: the note alone, no retry to offer", r.shownMark() === "unsupported | out | note | remember off" && r.mini.note.textContent === "This device can't run the voice: this browser has no WebGPU");
  panel.dispose();
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
  arrive(r);
  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  r.emit({ kind: "done", unitId: 0, report: report(FRAME_S * 1000), elapsedMs: 5 });
  r.emit({ kind: "audio", unitId: 1, frameIndex: 0, pcm: frame(1, 0) });
  r.emit({ kind: "done", unitId: 1, report: report(FRAME_S * 1000), elapsedMs: 5 });
  r.devices()[0]?.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("playing the second unit of passage 1", r.where() === "t1 21-42 of 1");
  r.fail("boom");
  assert("the crash keeps the reported place by name: the character under the clock in passage 1's second unit", r.devices()[0]?.calls.at(-1) === "close" && held(panel.state()) === "0:23" && r.line() === "Retry | stop(off) | The voice failed: boom");
  r.play.click();
  arrive(r);
  assert("Retry: the voice arrives back where it fell, on a fresh device", r.devices().length === 2 && r.said().endsWith("synthesize 1") && r.where() === "t1 21-42 of 1");
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
  throws("a script that is not this page's is refused out of the dispatch", () => r.emit({ kind: "script", id: SCRIPT_ID, units: foreign }));
  const after = panel.state();
  assert("after the throw: the worker released, the device closed, no cursor ever painted, the panel at its start", r.counts.disposed === 1 && r.counts.listeners() === 0 && r.devices()[0]?.calls.at(-1) === "close" && r.positions.every((at) => at === null) && r.frames.pending === 0 && after.kind === "provisioning" && after.neural.kind === "idle" && r.line() === IDLE_LINE);
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
  let caught: unknown = null;
  try {
    r.emit({ kind: "script", id: SCRIPT_ID, units: foreign });
  } catch (error) {
    caught = error;
  }
  const errors = caught instanceof AggregateError ? caught.errors.map((e) => (e instanceof Error ? e.message : String(e))) : [];
  assert("both failures go out as one AggregateError: the bug first, the teardown second", errors.length === 2 && errors[0]?.includes("passage 0 of the script") === true && errors[1] === "the worker would not dispose" && r.counts.disposed === 1);
  r.refusing.dispose = false;
  panel.dispose();
  assert("the panel is not left draining: the next event is handled, the worker disposed, the device closed, at the start", panel.state().kind === "provisioning" && r.counts.disposed === 2 && r.devices()[0]?.calls.at(-1) === "close" && r.line() === IDLE_LINE);
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
  assert("cold: every preview withheld and the note says why; nothing to reset", previews().every((b) => b.disabled) && !note.hidden && note.textContent === "Previews play once the voice is ready on this device." && reset.disabled);
  assert("previews are named for assistive tech", hear("azelma").getAttribute("aria-label") === "Hear Azelma");

  radio("assistant", "marius").click();
  assert("Claude's voice picked while cold: kept on the device, shown checked, reset offered, nothing sent to a worker", readPick(r.store).assistant === "marius" && checked() === "alba/marius" && !reset.disabled && r.sent.length === 0);
  toggle.click();
  assert("the toggle closes it again; the pick stands", picker.hidden && checked() === "alba/marius");

  r.play.click();
  arrive(r);
  const [stage] = r.devices();
  assert("the voice arrives with the pick made cold: unit 0, the reader's, in Alba", r.said().endsWith("synthesize 0") && r.sent.at(-1)?.kind === "synthesize" && (r.sent.at(-1) as { voice: string }).voice === "alba" && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  assert("on stage: previews offered, the note gone", previews().every((b) => !b.disabled) && note.hidden);

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
  arrive(again);
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

console.log(process.exitCode === 1 ? "listen-panel-check: FAILED" : "listen-panel-check: ok");
