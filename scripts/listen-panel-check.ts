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
import { PREFERENCE_KEY, readPreference, writePreference, type PreferenceStore } from "../src/listenConsent";
import {
  createListenPanel,
  DOWNLOAD_BYTES,
  initialState,
  markForm,
  readout,
  SCRIPT_ID,
  step,
  type MarkForm,
  type PanelEvent,
  type PanelState,
  type Visit,
} from "../src/listenPanel";
import type { ConnectionReading } from "../src/modelAssets";
import { utteranceTable, type NeuralView } from "../src/neuralPerformer";
import type { Keeping, Residency } from "../src/modelResidency";
import type { Mark } from "../src/performer";
import type { ReadAlongAt } from "../src/readAlong";
import type { Utterance } from "../src/speech";
import { emptyManifest, type UnitReport } from "../src/speechManifest";
import { DEFAULT_VOICES, type SynthesisUnit } from "../src/speechScript";
import type { SynthesisPort } from "../src/synthesisClient";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { SCHEDULE_LEAD_S } from "../src/unitPlayer";
import { FRAME_S, frame, StubDevice } from "./playbackStub";

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
const TOTAL = utterances.length;
const unit = (utterance: Utterance, start: number, end: number): SynthesisUnit => ({ utterance, start, end, text: utterance.text.slice(start, end) });
const units: SynthesisUnit[] = ((): SynthesisUnit[] => {
  const [a, b] = [{ ...one }, { ...two }];
  return [unit(a, 0, 20), unit(a, 21, 42), unit(b, 0, 8)];
})();
const table = utteranceTable(utterances, units);

const worker = (message: FromWorker): PanelEvent => ({ kind: "worker", message });
const tapPlay: PanelEvent = { kind: "tap", control: "play" };
const tapStop: PanelEvent = { kind: "tap", control: "stop" };
const progress = (loadedBytes: number, totalBytes: number): PanelEvent => worker({ kind: "progress", progress: { loadedBytes, totalBytes } });
const report = (durationMs: number): UnitReport => ({ durationMs, alignment: { kind: "unit" } });
const mark = (utterance: number, char = 0): Mark => ({ utterance, char });
const seekTo = (utterance: number, char = 0): PanelEvent => ({ kind: "seek", to: mark(utterance, char) });
const supported: PanelEvent = worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
const ready: PanelEvent = worker({ kind: "ready", backend: "webgpu", modelVersion: "v" });
const scriptBack: PanelEvent = worker({ kind: "script", id: SCRIPT_ID, units });

const viewOf = (player: NeuralView["player"]): NeuralView => ({
  player,
  manifest: emptyManifest(units),
  holdings: units.map(() => ({ kind: "absent" })),
  utteranceOf: table,
});

const effects = (s: ReturnType<typeof step>): string =>
  s.effects
    .map((e) =>
      e.kind === "perform"
        ? `perform ${e.event.kind}${e.event.kind === "seek" ? ` ${e.event.to.utterance}:${e.event.to.char}` : ""}`
        : e.kind === "release"
          ? `release ${e.worker}`
          : e.kind,
    )
    .join();
// A visit that remembered nothing, on a connection nobody metered: what every reader is
// until the hover says otherwise.
const ASKING: Visit = { remembered: false, metered: false };
const shown = (state: PanelState, visit: Visit = ASKING): string => {
  const r = readout(state, TOTAL, visit);
  return `${r.play.label}${r.play.enabled ? "" : "(off)"} | stop${r.stop.enabled ? "" : "(off)"} | ${r.status}${r.progress === null ? "" : ` | bar ${r.progress.loadedBytes}/${r.progress.totalBytes}`}`;
};
// The place a voice on its way starts from, as "utterance:char"; a voice on stage has none.
const held = (state: PanelState): string => (state.kind === "provisioning" ? `${state.from.utterance}:${state.from.char}` : "on stage");
const MB = `${Math.round(DOWNLOAD_BYTES / 1e6)} MB`;
// The start, before the store has answered: the driver asks it on every entry.
const IDLE_LINE = "Listen | stop(off) | Looking for the voice on this device…";
// The mount: the worker spawned at once to probe, with no consent yet, so Play still reads.
const MOUNT_LINE = "Listen | stop(off) | Checking this device for the voice…";
const RESIDENT_LINE = "Listen | stop(off) | The voice is on this device";
const ABSENT_LINE = "Listen | stop(off) | The voice downloads 239 MB once, then runs on this device";
const ABSENT: Residency = { kind: "absent", bytesToDownload: 239_000_000 };
const wake = (consent: "none" | "download"): PanelEvent => ({ kind: "wake", consent });
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
  assert("progress short of the total: downloading, with the bytes and the bar", shown(downloading.state) === "Listen(off) | stop(off) | Downloading the voice · 120 MB of 239 MB | bar 120000000/239000000");
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
  assert("the performer's first view puts the voice on stage and sends it to the top: the tap was the consent", listening.state.kind === "neural" && effects(listening) === "perform seek 0:0" && shown(listening.state) === "Listen | stop(off) | Ready");
  assert("a seek on stage seeks the voice", effects(step(listening.state, seekTo(1, 3))) === "perform seek 1:3");
  const playing = step(listening.state, { kind: "view", view: viewOf({ kind: "speaking", at: { unitIndex: 2, offsetMs: 0 }, flow: "audio" }) });
  assert("tap play while speaking pauses", effects(step(playing.state, tapPlay)) === "perform pause");
  assert("tap stop while speaking stops", effects(step(playing.state, tapStop)) === "perform stop");
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
  assert("the voice arriving after a tap is sent to the tapped place", effects(arrivedAtPlace) === "perform seek 0:21" && arrivedAtPlace.state.kind === "neural");

  const crashed = step(downloading.state, { kind: "worker-error", message: "the worker bundle failed to load" });
  assert("a worker error while downloading: crashed, everything released, Play reads Retry", effects(crashed) === "release terminate,home" && shown(crashed.state) === "Retry | stop(off) | The voice failed: the worker bundle failed to load");
  assert("an error with no message still names the failure", shown(step(warming.state, { kind: "worker-error", message: "" }).state).endsWith("The voice failed"));
  const crashedOnStage = step(listening.state, { kind: "worker-error", message: "boom" });
  assert("a crash on stage while idle: released, the place the top", effects(crashedOnStage) === "release terminate,home" && held(crashedOnStage.state) === "0:0");
  const fellPlaying = step(playing.state, { kind: "worker-error", message: "boom" });
  assert("a crash while playing keeps the reported place for the retry", held(fellPlaying.state) === "1:0" && shown(fellPlaying.state) === "Retry | stop(off) | The voice failed: boom");
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
  assert("a keep request that failed: its message, beside the download", shown(kept2.state) === "Listen(off) | stop(off) | Downloading the voice · 0 MB of 0 MB · this browser could not be asked to keep the voice: no StorageManager | bar 1/2");
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
  assert("a voice that arrives on a download alone takes the stage and stands ready: no seek, nothing spoken", standingReady.state.kind === "neural" && effects(standingReady) === "" && shown(standingReady.state) === "Listen | stop(off) | Ready");
  const arrivedSpeaking = [progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, raised.state);
  assert("a voice that arrives after the consent was raised is sent to its place", effects(step(arrivedSpeaking, { kind: "view", view: viewOf({ kind: "idle" }) })) === "perform seek 0:0");

  const yesFirst = step(idle, yes);
  assert("the hover's yes before the probe: the gesture spent and the worker spawned", effects(yesFirst) === "unlock,spawn" && shown(yesFirst.state) === MOUNT_LINE);
  assert("and the consent is held for the probe's answer: supported loads at once", effects(step(yesFirst.state, supported)) === "load");
  assert("a wake while probing after a yes changes nothing", effects(step(yesFirst.state, wake("none"))) === "" && effects(step(yesFirst.state, wake("download"))) === "");

  const unsupported = step(woken.state, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-adapter" } } }));
  assert("unsupported at mount: the reason, Play off, the worker released", effects(unsupported) === "release terminate" && shown(unsupported.state) === "Listen(off) | stop(off) | This device can't run the voice: no graphics adapter is available");
  assert("neither a yes nor a wake nor a tap does anything to an unsupported device: no gesture is even spent", [yes, wake("download"), tapPlay].every((event) => step(unsupported.state, event).state === unsupported.state && effects(step(unsupported.state, event)) === ""));
  assert("a word on an unsupported device keeps its place, as everywhere, and starts nothing", effects(step(unsupported.state, seekTo(1))) === "" && held(step(unsupported.state, seekTo(1)).state) === "1:0" && shown(step(unsupported.state, seekTo(1)).state) === shown(unsupported.state));

  // The consent outlives a crash — the retry is the same listen — and dies with a dispose.
  const crashedStanding = step(step(standing.state, progress(1, 2)).state, { kind: "worker-error", message: "x" });
  assert("a crash while a remembered download runs: Retry, the consent kept", shown(crashedStanding.state) === "Retry | stop(off) | The voice failed: x");
  const rewoken = step(crashedStanding.state, wake("none"));
  assert("a wake after the crash spawns again with nothing new", effects(rewoken) === "spawn");
  assert("and the kept consent loads on the probe's answer", effects(step(rewoken.state, supported)) === "load");
  const idleOnStage = step(standingReady.state, { kind: "worker-error", message: "x" });
  const idleRetried = [tapPlay, supported, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, idleOnStage.state);
  assert("a crash on stage while idle, then Retry: the tap is the consent, the voice arrives and speaks", effects(step(idleRetried, { kind: "view", view: viewOf({ kind: "idle" }) })) === "perform seek 0:0");
  const idleRewoken = [wake("download"), supported, progress(1, 1), ready, scriptBack].reduce((state, event) => step(state, event).state, idleOnStage.state);
  assert("a crash on stage while idle, then a wake: the voice comes back standing ready, not speaking", effects(step(idleRewoken, { kind: "view", view: viewOf({ kind: "idle" }) })) === "");
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

  const ask = (state: PanelState, visit: Visit = ASKING): string | null => readout(state, TOTAL, visit).ask;
  assert("download needed: the hover asks, with the size", ask(forms.download) === "Download speech model? · 239 MB");
  assert("a store that cannot keep the voice: the hover asks for the whole model", ask(forms.unavailable) === `Download speech model? · ${MB}`);
  assert("remembered on a metered connection: the hover says why it asks anyway", ask(forms.download, { remembered: true, metered: true }) === "Download speech model? · 239 MB · asking because this connection is metered");
  assert("remembered off a metered connection: no note", ask(forms.download, { remembered: true, metered: false }) === "Download speech model? · 239 MB");
  assert("not remembered on a metered connection: no note — nothing is being overridden", ask(forms.download, { remembered: false, metered: true }) === "Download speech model? · 239 MB");
  assert("nothing to ask when the voice is here, on its way, on stage, or impossible", [forms.ready, forms.checking, forms.downloading, forms.warming, forms.speaking, forms.paused, forms.unsupported, forms.failed].every((state) => ask(state) === null));
  assert("the preference's box reads the visit", readout(forms.download, TOTAL, { remembered: true, metered: false }).remembered && !readout(forms.download, TOTAL, ASKING).remembered);
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
  throws("refused, anywhere", () => step(idle, worker({ kind: "refused", request: { kind: "load" }, phase: "loading" })));
  throws("disposed, anywhere: the port ends the worker on it first", () => step(idle, worker({ kind: "disposed" })));
}

// ── the driver ────────────────────────────────────────────────────────────────────────

// The page's markup for the panel and the mark, inert as the template renders it.
const MARKUP = `<!DOCTYPE html><body>
  <div class="speech-controls">
    <button class="speech-play" type="button"></button>
    <button class="speech-stop" type="button" disabled></button>
    <progress class="speech-progress" hidden></progress>
    <p class="speech-now"></p>
  </div>
  <div class="listen-mark" data-state="checking" data-open="false">
    <button class="listen-mark-button" type="button" aria-expanded="false" aria-label="Listen"><span class="listen-mark-glyph"></span></button>
    <div class="listen-mark-hover" role="group" aria-label="Listen">
      <p class="listen-mark-sentence"></p>
      <p class="listen-mark-ask" hidden></p>
      <button class="listen-mark-yes" type="button" hidden>Download</button>
      <label class="listen-mark-remember"><input type="checkbox" /><span>Always download it on this device</span></label>
    </div>
  </div></body>`;

interface MarkRig {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly sentence: HTMLElement;
  readonly ask: HTMLElement;
  readonly yes: HTMLButtonElement;
  readonly remember: HTMLInputElement;
}

interface Rig {
  readonly play: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly bar: HTMLProgressElement;
  readonly mark: MarkRig;
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
  readonly store: PreferenceStore & { readonly keys: () => string[] };
  readonly connection: { reading: ConnectionReading | undefined };
  // The port's dispose throws while this is set: a teardown that fails.
  readonly refusing: { dispose: boolean };
  readonly said: () => string;
  readonly frames: { request: (callback: () => void) => number; cancel: () => void; pending: number; tick: () => void };
  readonly positions: (ReadAlongAt | null)[];
  readonly where: () => string;
  readonly line: () => string;
  // What the mark shows: its form, pinned or not, then the hover's question, yes and box.
  readonly shownMark: () => string;
  // The reader's hand on the hover: the box checked or cleared, a key pressed on the page.
  readonly check: (on: boolean) => void;
  readonly press: (key: string) => void;
  // The devices opened since the rig was built, newest last: each gesture or build opens one.
  readonly devices: () => StubDevice[];
}

// A visit: what the device remembered before the page loaded, and what the browser says
// of the connection.
interface VisitSetup {
  readonly remembered?: boolean;
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
  const held = new Map<string, string>();
  const store = {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
    keys: () => [...held.keys()],
  };
  writePreference(store, setup.remembered === true);
  const positions: (ReadAlongAt | null)[] = [];
  const play = el<HTMLButtonElement>(".speech-play");
  const stop = el<HTMLButtonElement>(".speech-stop");
  const status = el<HTMLElement>(".speech-now");
  const mark: MarkRig = {
    root: el(".listen-mark"),
    button: el(".listen-mark-button"),
    sentence: el(".listen-mark-sentence"),
    ask: el(".listen-mark-ask"),
    yes: el(".listen-mark-yes"),
    remember: el(".listen-mark-remember input"),
  };
  const opened = StubDevice.instances.length;
  return {
    play,
    stop,
    status,
    bar: el(".speech-progress"),
    mark,
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
    shownMark: () =>
      `${mark.root.dataset.state}${mark.root.dataset.open === "true" ? "(pinned)" : ""} | ${mark.ask.hidden ? "no ask" : mark.ask.textContent} | yes ${mark.yes.hidden ? "hidden" : "shown"} | remember ${mark.remember.checked ? "on" : "off"}`,
    check: (on) => {
      mark.remember.checked = on;
      mark.remember.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    },
    press: (key) => {
      doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
    },
    devices: () => StubDevice.instances.slice(opened),
  };
};

const mount = (r: Rig): ReturnType<typeof createListenPanel> =>
  createListenPanel({
    controls: { play: r.play, stop: r.stop, status: r.status, progress: r.bar, mark: r.mark },
    utterances,
    voices: DEFAULT_VOICES,
    spawn: () => {
      r.counts.spawned += 1;
      return r.port;
    },
    home: r.home,
    keep: r.keep,
    preference: { read: () => readPreference(r.store), write: (remembered) => writePreference(r.store, remembered) },
    connection: () => r.connection.reading,
    Device: StubDevice,
    frames: r.frames,
    onPosition: (at) => r.positions.push(at),
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

const MOUNT_MARK = "checking | no ask | yes hidden | remember off";
const ASK_MARK = "download | Download speech model? · 239 MB | yes shown | remember off";
const PREPARING_LINE = "Listen | stop(off) | Preparing the voice…";

console.log("createListenPanel: the tap opens the device, the voice arrives and plays");
{
  const r = rig();
  const panel = mount(r);

  assert("mounted: the worker is spawned to probe, the store asked, nothing sent, no device, the mark checking", r.line() === MOUNT_LINE && r.counts.homeAsked === 1 && r.counts.keepAsked === 0 && r.counts.spawned === 1 && r.sent.length === 0 && r.devices().length === 0 && r.shownMark() === MOUNT_MARK);
  assert("the mark is named for assistive tech by the status line", r.mark.button.getAttribute("aria-label") === "Listen: Checking this device for the voice…" && r.mark.sentence.textContent === "Checking this device for the voice…");
  r.play.click();
  const device = r.devices()[0];
  if (device === undefined) throw new Error("the tap did not open a device");
  assert("click Play while the probe runs: no second worker, the button disables — the tap is the consent", r.counts.spawned === 1 && r.line() === "Listen(off) | stop(off) | Checking this device for the voice…");
  assert("the audio device is opened AND resumed on the tap, before any worker message", r.devices().length === 1 && device.calls.join() === "resume" && r.sent.length === 0);
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("supported with the tap held: load is sent", r.said() === "load" && r.shownMark() === "warming | no ask | yes hidden | remember off");
  r.emit({ kind: "progress", progress: { loadedBytes: 50_000_000, totalBytes: 200_000_000 } });
  assert("downloading: the bar shows and carries the bytes, the mark's ring the fraction", !r.bar.hidden && r.bar.value === 50_000_000 && r.bar.max === 200_000_000 && r.line() === "Listen(off) | stop(off) | Downloading the voice · 50 MB of 200 MB" && r.mark.root.dataset.state === "downloading" && r.mark.root.style.getPropertyValue("--fraction") === "0.25");
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
  assert("crossing into unit 2: passage 2, another turn, its own span", r.line() === "Pause | stop | Playing · passage 2 of 2" && r.where() === "t2 0-8 of 1");
  const before = r.positions.length;
  r.frames.tick();
  assert("a frame with the cursor unmoved reports nothing new", r.positions.length === before && r.frames.pending === 1);

  r.play.click();
  assert("Pause: paused, the loop is off, the label says Resume, the mark paused", r.line() === "Resume | stop | Paused · passage 2 of 2" && r.frames.pending === 0 && r.mark.root.dataset.state === "paused");
  r.play.click();
  assert("Resume: speaking again, the loop is back", r.play.textContent === "Pause" && r.frames.pending === 1);
  panel.seek(mark(0, 25));
  assert("a tap on the first passage's second sentence: the voice seeks there and the cursor follows", r.where() === "t1 21-42 of 1" && r.line() === "Pause | stop | Playing · passage 1 of 2");
  r.stop.click();
  assert("Stop: idle, the cursor cleared, Stop disabled, Play says Listen, the mark ready", r.line() === "Listen | stop(off) | Ready" && r.positions.at(-1) === null && r.frames.pending === 0 && r.shownMark() === "ready | no ask | yes hidden | remember off");
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
  panel.seek(mark(0, 21));
  const device = r.devices()[0];
  assert("a tap on a word while the probe runs opens the device, like Play, and holds the place", r.counts.spawned === 1 && device?.calls.join() === "resume" && r.line() === "Listen(off) | stop(off) | Checking this device for the voice…" && held(panel.state()) === "0:21");
  panel.seek(mark(1));
  assert("a second tap while the voice is on its way moves the place, nothing else", r.counts.spawned === 1 && r.devices().length === 1 && held(panel.state()) === "1:0");
  arrive(r);
  assert("the voice arrives at the tapped place: it asks for that unit and the cursor is there", r.said().endsWith("synthesize 2") && r.where() === "t2 0-8 of 1" && r.line() === "Pause | stop | Synthesizing ahead… · passage 2 of 2");
  r.emit({ kind: "audio", unitId: 2, frameIndex: 0, pcm: frame(2, 0) });
  r.emit({ kind: "done", unitId: 2, report: report(FRAME_S * 1000), elapsedMs: 5 });
  device?.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("the last unit ends: Ready, the cursor cleared, the loop off", r.line() === "Listen | stop(off) | Ready" && r.positions.at(-1) === null && r.frames.pending === 0);
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
  assert("the store answers: the line says the voice is on this device, the mark ready, no download offered, still nothing sent", r.line() === RESIDENT_LINE && r.shownMark() === "ready | no ask | yes hidden | remember off" && r.sent.length === 0);
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
  r.mark.yes.click();
  const device = r.devices()[0];
  assert("yes: the device is opened and resumed on the click, load sent, the browser asked to keep; Play still reads, since a yes is not a Play", device?.calls.join() === "resume" && r.said() === "load" && r.counts.keepAsked === 1 && r.line() === PREPARING_LINE && r.shownMark() === "warming | no ask | yes hidden | remember off");
  r.emit({ kind: "progress", progress: { loadedBytes: 60_000_000, totalBytes: 240_000_000 } });
  assert("downloading: the ring fills, the question is gone", r.mark.root.dataset.state === "downloading" && r.mark.root.style.getPropertyValue("--fraction") === "0.25" && r.mark.ask.hidden && r.mark.yes.hidden);
  r.emit({ kind: "progress", progress: { loadedBytes: 240_000_000, totalBytes: 240_000_000 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  r.emit({ kind: "script", id: SCRIPT_ID, units });
  assert("the voice arrives on the yes alone: on stage, Ready, nothing synthesized, no cursor, the mark ready", panel.state().kind === "neural" && r.said() === "load,script" && r.line() === "Listen | stop(off) | Ready" && r.shownMark() === "ready | no ask | yes hidden | remember off" && r.positions.every((at) => at === null) && r.frames.pending === 0);
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
  assert("checking the box writes the preference, and the voice loads with no tap and no device", r.store.getItem(PREFERENCE_KEY) === "always" && r.said() === "load" && r.devices().length === 0 && r.line() === PREPARING_LINE && r.shownMark() === "warming | no ask | yes hidden | remember on");
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  r.emit({ kind: "script", id: SCRIPT_ID, units });
  const device = r.devices()[0];
  assert("a voice built on a standing consent opens its device outside any gesture, unresumed, and stands ready", r.devices().length === 1 && device?.calls.join() === "" && r.line() === "Listen | stop(off) | Ready" && r.said() === "load,script");
  r.play.click();
  assert("the first Play resumes that device on the tap and speaks", device?.calls.includes("resume") === true && r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  r.check(false);
  assert("clearing the box removes the preference; the voice on stage is untouched", r.store.keys().length === 0 && r.shownMark() === "speaking | no ask | yes hidden | remember off" && r.counts.spawned === 1 && panel.state().kind === "neural");
  panel.dispose();

  const next = rig({ remembered: true });
  const nextPanel = mount(next);
  assert("a later visit with the preference: the probe first, the box checked, nothing sent before the worker is able", next.line() === MOUNT_LINE && next.shownMark() === "checking | no ask | yes hidden | remember on" && next.sent.length === 0);
  next.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("supported: load is sent with no tap, the browser asked to keep, no device opened", next.said() === "load" && next.counts.keepAsked === 1 && next.devices().length === 0 && next.line() === PREPARING_LINE);
  next.answer.home(ABSENT);
  await Promise.resolve();
  assert("the store's late word does not put a question over a download in flight", next.shownMark() === "warming | no ask | yes hidden | remember on");
  nextPanel.dispose();
}

console.log("createListenPanel: on a metered connection the remembered yes still asks");
{
  const r = rig({ remembered: true, connection: { type: "cellular" } });
  const panel = mount(r);
  await ableAbsent(r);
  assert("nothing loads; the hover asks and says why, the box still checked", r.sent.length === 0 && r.shownMark() === "download | Download speech model? · 239 MB · asking because this connection is metered | yes shown | remember on" && r.line() === ABSENT_LINE);
  r.connection.reading = { type: "wifi" };
  panel.wake();
  assert("off the metered connection, the page's next wake gives the standing yes: load, no gesture", r.said() === "load" && r.devices().length === 0 && r.line() === PREPARING_LINE);
  panel.dispose();

  const tapped = rig({ remembered: true, connection: { saveData: true } });
  const tappedPanel = mount(tapped);
  await ableAbsent(tapped);
  tapped.mark.yes.click();
  assert("with save-data on, the hover's yes is the reader's own: load on the click", tapped.said() === "load" && tapped.devices()[0]?.calls.join() === "resume");
  tappedPanel.dispose();
}

console.log("createListenPanel: a device that cannot run the voice says so at mount");
{
  const r = rig();
  const panel = mount(r);
  r.emit({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } });
  assert("unsupported: the mark, the reason on its sentence, Play off, the worker released", r.shownMark() === "unsupported | no ask | yes hidden | remember off" && r.line() === "Listen(off) | stop(off) | This device can't run the voice: this browser has no WebGPU" && r.counts.terminated === 1 && r.counts.listeners() === 0);
  r.play.click();
  r.mark.yes.click();
  r.check(true);
  panel.seek(mark(1));
  assert("no tap, yes, box or word spawns anything or opens a device on it", r.counts.spawned === 1 && r.devices().length === 0 && r.sent.length === 0 && r.line().startsWith("Listen(off)"));
  panel.dispose();
}

console.log("createListenPanel: the hover pins on a tap, and lets go on a tap outside or Escape");
{
  const r = rig();
  const panel = mount(r);
  const pinned = (): boolean => r.mark.root.dataset.open === "true" && r.mark.button.getAttribute("aria-expanded") === "true";
  const unpinned = (): boolean => r.mark.root.dataset.open === "false" && r.mark.button.getAttribute("aria-expanded") === "false";
  assert("closed at mount", unpinned());
  r.mark.button.click();
  assert("a tap on the mark pins the hover open, for the touch reader", pinned() && r.shownMark().startsWith("checking(pinned)"));
  r.mark.button.click();
  assert("a second tap lets go", unpinned());
  r.mark.button.click();
  r.mark.sentence.click();
  assert("a tap inside the hover leaves it pinned", pinned());
  r.doc.body.click();
  assert("a tap outside lets go", unpinned());
  r.mark.button.click();
  r.press("Escape");
  assert("Escape lets go", unpinned());
  r.press("Enter");
  assert("other keys do nothing", unpinned());
  panel.dispose();
}

console.log("createListenPanel: a page back from the cache wakes the panel it disposed");
{
  const r = rig();
  const panel = mount(r);
  panel.dispose();
  assert("disposed: the worker released, at the start", r.counts.disposed === 1 && r.counts.listeners() === 0 && r.line() === IDLE_LINE);
  panel.wake();
  assert("wake: a worker is spawned to probe again, the store asked again", r.counts.spawned === 2 && r.counts.listeners() === 2 && r.line() === MOUNT_LINE && r.counts.homeAsked === 2);
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
  assert("the crash keeps the reported place: passage 1's second unit", r.devices()[0]?.calls.at(-1) === "close" && held(panel.state()) === "0:21" && r.line() === "Retry | stop(off) | The voice failed: boom");
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

console.log(process.exitCode === 1 ? "listen-panel-check: FAILED" : "listen-panel-check: ok");
