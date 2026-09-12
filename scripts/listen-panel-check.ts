// The Listen panel, driven under jsdom with a stub worker port, the stub playback device
// and a hand-fired frame loop (slopspot-read-along-q35.9, slopspot-read-along-a35.bse).
// Run: `tsx scripts/listen-panel-check.ts`.
//
// Two halves, as in scheduler-check.ts. First the pure `step` through its accept table:
// every state's answer to every event that may arrive in it, and the throw for every
// message the protocol says cannot. Then the real driver over the REAL neural performer —
// the real scheduler and unit player on the stub device, with a stub port standing in for
// the worker — asserting only what a reader sees and hears: the button labels, the status
// sentence, the progress bar, where the read-along cursor is, and that the audio device
// is opened and resumed on the tap, before any worker message [LAW:behavior-not-structure]
// [LAW:verifiable-goals].

import { JSDOM } from "jsdom";
import {
  createListenPanel,
  DOWNLOAD_BYTES,
  initialState,
  readout,
  SCRIPT_ID,
  step,
  type PanelEvent,
  type PanelState,
} from "../src/listenPanel";
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
const shown = (state: PanelState): string => {
  const r = readout(state, TOTAL);
  return `${r.play.label}${r.play.enabled ? "" : "(off)"} | stop${r.stop.enabled ? "" : "(off)"} | ${r.status}${r.progress === null ? "" : ` | bar ${r.progress.loadedBytes}/${r.progress.totalBytes}`}`;
};
// The place a voice on its way starts from, as "utterance:char"; a voice on stage has none.
const held = (state: PanelState): string => (state.kind === "provisioning" ? `${state.from.utterance}:${state.from.char}` : "on stage");
const MB = `${Math.round(DOWNLOAD_BYTES / 1e6)} MB`;
// The start, before the store has answered: the driver asks it on every entry.
const IDLE_LINE = "Listen | stop(off) | Looking for the voice on this device…";
const RESIDENT_LINE = "Listen | stop(off) | The voice is on this device";
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
  assert("tap play from idle spawns the worker (and with it the device) and probes", effects(probing) === "spawn" && shown(probing.state) === "Listen(off) | stop(off) | Checking this device for the voice…");
  assert("a tap while probing changes nothing", step(probing.state, tapPlay).state === probing.state);
  assert("a stop tap before there is anything to stop changes nothing", step(probing.state, tapStop).state === probing.state);

  const unsupported = step(probing.state, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } }));
  assert("unsupported: the reason is shown, nothing to tap, the worker and the device the tap opened are released", effects(unsupported) === "release terminate" && shown(unsupported.state) === "Listen(off) | stop(off) | This device can't run the voice: this browser has no WebGPU");
  assert("a tap on an unsupported device changes nothing", step(unsupported.state, tapPlay).state === unsupported.state);

  const preparing = step(probing.state, supported);
  assert("supported: load is sent", effects(preparing) === "load" && shown(preparing.state) === "Listen(off) | stop(off) | Preparing the voice…");
  const downloading = step(preparing.state, progress(120_000_000, 239_000_000));
  assert("progress short of the total: downloading, with the bytes and the bar", shown(downloading.state) === "Listen(off) | stop(off) | Downloading the voice · 120 MB of 239 MB | bar 120000000/239000000");
  const warming = step(downloading.state, progress(239_000_000, 239_000_000));
  assert("the last byte: warming, no bar", shown(warming.state) === "Listen(off) | stop(off) | Warming up the voice…");

  const failed = step(warming.state, worker({ kind: "load-failed", failure: { kind: "http", url: "/models/x.part0", status: 503 } }));
  assert("load-failed: the failure is shown and Play becomes Retry", shown(failed.state) === "Retry | stop(off) | The voice could not load: HTTP 503 fetching /models/x.part0");
  const retried = step(failed.state, tapPlay);
  assert("retry sends load again on the same worker", effects(retried) === "load" && shown(retried.state).startsWith("Listen(off)"));

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
  assert("a seek from idle spawns the worker like Play, and holds the place", effects(tapped) === "spawn" && held(tapped.state) === "1:3");
  const tappedTwice = step(tapped.state, seekTo(0, 21));
  assert("a later seek replaces the place and spawns nothing more", effects(tappedTwice) === "" && held(tappedTwice.state) === "0:21");
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
  assert("Retry after a crash spawns a fresh worker and probes, the place still held", effects(respawned) === "spawn" && held(respawned.state) === "1:0" && shown(respawned.state).startsWith("Listen(off)"));
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

const MARKUP = `<!DOCTYPE html><body>
  <div class="speech-controls">
    <button class="speech-play" type="button"></button>
    <button class="speech-stop" type="button" disabled></button>
    <progress class="speech-progress" hidden></progress>
    <p class="speech-now"></p>
  </div></body>`;

interface Rig {
  readonly play: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly bar: HTMLProgressElement;
  readonly port: SynthesisPort;
  readonly sent: ToWorker[];
  readonly emit: (message: FromWorker) => void;
  readonly fail: (message: string) => void;
  readonly counts: { spawned: number; terminated: number; disposed: number; listeners: () => number; homeAsked: number; keepAsked: number };
  // The store's and the browser's answers, given by hand so their timing is the check's.
  readonly answer: { home: (residency: Residency) => void; keep: (keeping: Keeping) => void };
  readonly home: () => Promise<Residency>;
  readonly keep: () => Promise<Keeping>;
  // The port's dispose throws while this is set: a teardown that fails.
  readonly refusing: { dispose: boolean };
  readonly said: () => string;
  readonly frames: { request: (callback: () => void) => number; cancel: () => void; pending: number; tick: () => void };
  readonly positions: (ReadAlongAt | null)[];
  readonly where: () => string;
  readonly line: () => string;
  // The devices opened since the rig was built, newest last: each Play or Retry opens one.
  readonly devices: () => StubDevice[];
}

const rig = (): Rig => {
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
  const positions: (ReadAlongAt | null)[] = [];
  const play = el<HTMLButtonElement>(".speech-play");
  const stop = el<HTMLButtonElement>(".speech-stop");
  const status = el<HTMLElement>(".speech-now");
  const opened = StubDevice.instances.length;
  return {
    play,
    stop,
    status,
    bar: el(".speech-progress"),
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
    devices: () => StubDevice.instances.slice(opened),
  };
};

const mount = (r: Rig): ReturnType<typeof createListenPanel> =>
  createListenPanel({
    controls: { play: r.play, stop: r.stop, status: r.status, progress: r.bar },
    utterances,
    voices: DEFAULT_VOICES,
    spawn: () => {
      r.counts.spawned += 1;
      return r.port;
    },
    home: r.home,
    keep: r.keep,
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

console.log("createListenPanel: the tap opens the device, the voice arrives and plays");
{
  const r = rig();
  const panel = mount(r);

  assert("mounted idle: the readout is written, the store asked, nothing spawned, no device", r.line() === IDLE_LINE && r.counts.homeAsked === 1 && r.counts.keepAsked === 0 && r.counts.spawned === 0 && r.devices().length === 0);
  r.play.click();
  const device = r.devices()[0];
  if (device === undefined) throw new Error("the tap did not open a device");
  assert("click Play: the worker is spawned and heard, the button disables", r.counts.spawned === 1 && r.line() === "Listen(off) | stop(off) | Checking this device for the voice…");
  assert("the audio device is opened AND resumed on the tap, before any worker message", r.devices().length === 1 && device.calls.join() === "resume" && r.sent.length === 0);
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 50_000_000, totalBytes: 200_000_000 } });
  assert("downloading: the bar shows and carries the bytes", !r.bar.hidden && r.bar.value === 50_000_000 && r.bar.max === 200_000_000 && r.line() === "Listen(off) | stop(off) | Downloading the voice · 50 MB of 200 MB");
  r.emit({ kind: "progress", progress: { loadedBytes: 200_000_000, totalBytes: 200_000_000 } });
  assert("warming: the bar goes", r.bar.hidden && r.line() === "Listen(off) | stop(off) | Warming up the voice…");
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  const script = r.sent.at(-1);
  assert("ready: the page's utterances go to the worker under the panel's script id", script?.kind === "script" && script.id === SCRIPT_ID && script.utterances === utterances);

  r.emit({ kind: "script", id: SCRIPT_ID, units });
  assert("units back: the voice plays at once from the top on the device the tap opened, and asks for unit 0", panel.state().kind === "neural" && r.devices().length === 1 && r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
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
  assert("Pause: paused, the loop is off, the label says Resume", r.line() === "Resume | stop | Paused · passage 2 of 2" && r.frames.pending === 0);
  r.play.click();
  assert("Resume: speaking again, the loop is back", r.play.textContent === "Pause" && r.frames.pending === 1);
  panel.seek(mark(0, 25));
  assert("a tap on the first passage's second sentence: the voice seeks there and the cursor follows", r.where() === "t1 21-42 of 1" && r.line() === "Pause | stop | Playing · passage 1 of 2");
  r.stop.click();
  assert("Stop: idle, the cursor cleared, Stop disabled, Play says Listen", r.line() === "Listen | stop(off) | Ready" && r.positions.at(-1) === null && r.frames.pending === 0);
  r.play.click();
  assert("Play again starts from the top on the same worker and device: Stop let the audio go, so unit 0 is asked for again", r.counts.spawned === 1 && r.devices().length === 1 && r.said().endsWith("synthesize 0") && r.line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.where() === "t1 0-20 of 1");

  r.fail("the worker bundle failed to load");
  assert("the worker dies while playing: the device closed, the worker terminated, no longer heard, Play reads Retry", device.calls.at(-1) === "close" && r.counts.terminated === 1 && r.counts.listeners() === 0 && r.line() === "Retry | stop(off) | The voice failed: the worker bundle failed to load");
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
  assert("a tap on a word from idle spawns the worker and opens the device, like Play", r.counts.spawned === 1 && device?.calls.join() === "resume" && r.line() === "Listen(off) | stop(off) | Checking this device for the voice…" && held(panel.state()) === "0:21");
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
  r.answer.home({ kind: "resident" });
  await Promise.resolve();
  assert("the store answers: the line says the voice is on this device, before any tap", r.line() === RESIDENT_LINE && r.counts.spawned === 0);
  r.play.click();
  assert("the tap does not ask the browser to keep anything yet: the load does", r.counts.keepAsked === 0);
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("supported: load is sent and the browser is asked to keep the bytes, in that order", r.sent.map((m) => m.kind).join() === "load" && r.counts.keepAsked === 1);
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
  r.answer.home({ kind: "absent", bytesToDownload: 239_000_000 });
  await Promise.resolve();
  assert("a store that lost the bytes says so on the next start", r.line() === "Listen | stop(off) | The voice downloads 239 MB once, then runs on this device");
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
  r.answer.home({ kind: "absent", bytesToDownload: 239_000_000 });
  await Promise.resolve();
  assert("the dispose's own answer is shown", r.line() === "Listen | stop(off) | The voice downloads 239 MB once, then runs on this device");
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
