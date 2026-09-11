// The Listen panel, driven under jsdom with a stub worker port, the stub playback device,
// a stub synthesizer under the REAL browser-voice performer, and a hand-fired frame loop
// (slopspot-read-along-q35.9, slopspot-read-along-a35.1).
// Run: `tsx scripts/listen-panel-check.ts`.
//
// Two halves, as in scheduler-check.ts. First the pure `step` through its accept table:
// every state's answer to every event that may arrive in it, with and without a stand-in,
// and the throw for every message the protocol says cannot. Then the real driver over the
// REAL performers — the synthesizer's over a stub speechSynthesis, the neural one over the
// real scheduler and unit player on the stub device, with a stub port standing in for the
// worker — asserting only what a reader sees: the button labels, the status sentence, the
// progress bar, and where the read-along cursor is [LAW:behavior-not-structure]
// [LAW:verifiable-goals].

import { JSDOM } from "jsdom";
import {
  createListenPanel,
  DEFAULT_VOICES,
  DOWNLOAD_BYTES,
  initialState,
  readout,
  SCRIPT_ID,
  step,
  type PanelEvent,
  type PanelState,
} from "../src/listenPanel";
import { utteranceTable, type NeuralView } from "../src/neuralPerformer";
import type { PerformerState } from "../src/performer";
import type { ReadAlongAt } from "../src/readAlong";
import type { Utterance } from "../src/speech";
import { emptyManifest, type UnitReport } from "../src/speechManifest";
import { createPlayer, type SpeechWindow } from "../src/speechPlayer";
import type { SynthesisUnit } from "../src/speechScript";
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
const synthAt = (state: PerformerState): PanelEvent => ({ kind: "synth", state });
const speakingAt = (utterance: number): PerformerState => ({ kind: "speaking", at: { utterance, span: { charStart: 0, charEnd: 5 } } });
const pausedAt = (utterance: number): PerformerState => ({ kind: "paused", at: { utterance, span: { charStart: 0, charEnd: 5 } } });

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
        ? `${e.on} ${e.event.kind}${e.event.kind === "seek" ? ` ${e.event.to}` : ""}`
        : e.kind === "release"
          ? `release ${e.worker}`
          : e.kind,
    )
    .join();
const shown = (state: PanelState): string => {
  const r = readout(state, TOTAL);
  return `${r.play.label}${r.play.enabled ? "" : "(off)"} | stop${r.stop.enabled ? "" : "(off)"} | ${r.status}${r.progress === null ? "" : ` | bar ${r.progress.loadedBytes}/${r.progress.totalBytes}`}`;
};
const MB = `${Math.round(DOWNLOAD_BYTES / 1e6)} MB`;

// ── the pure machine, no stand-in ─────────────────────────────────────────────────────

console.log("step, no stand-in: the way to audio");
{
  const idle = initialState("none");
  assert("idle: Play is the only enabled control, and it names the download", shown(idle) === `Listen | stop(off) | The neural voice downloads a ${MB} model once, then runs on this device`);
  const probing = step(idle, tapPlay);
  assert("tap play from idle spawns the worker and probes", effects(probing) === "spawn" && shown(probing.state) === "Listen(off) | stop(off) | Checking this device for the neural voice…");
  assert("a tap while probing changes nothing", step(probing.state, tapPlay).state === probing.state);
  assert("a stop tap before there is anything to stop changes nothing", step(probing.state, tapStop).state === probing.state);

  const unsupported = step(probing.state, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } }));
  assert("unsupported: the reason is shown, nothing to tap", shown(unsupported.state) === "Listen(off) | stop(off) | This device can't run the neural voice: this browser has no WebGPU");

  const preparing = step(probing.state, worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } }));
  assert("supported: load is sent", effects(preparing) === "load" && shown(preparing.state) === "Listen(off) | stop(off) | Preparing the neural voice…");
  const downloading = step(preparing.state, progress(120_000_000, 239_000_000));
  assert("progress short of the total: downloading, with the bytes and the bar", shown(downloading.state) === "Listen(off) | stop(off) | Downloading the neural voice · 120 MB of 239 MB | bar 120000000/239000000");
  const warming = step(downloading.state, progress(239_000_000, 239_000_000));
  assert("the last byte: warming, no bar", shown(warming.state) === "Listen(off) | stop(off) | Warming up the neural voice…");

  const failed = step(warming.state, worker({ kind: "load-failed", failure: { kind: "http", url: "/models/x.part0", status: 503 } }));
  assert("load-failed: the failure is shown and Play becomes Retry", shown(failed.state) === "Retry | stop(off) | The neural voice could not load: HTTP 503 fetching /models/x.part0");
  const retried = step(failed.state, tapPlay);
  assert("retry sends load again", effects(retried) === "load" && shown(retried.state).startsWith("Listen(off)"));

  const scripting = step(warming.state, worker({ kind: "ready", backend: "webgpu", modelVersion: "v" }));
  assert("ready: the script is sent", effects(scripting) === "script" && shown(scripting.state) === "Listen(off) | stop(off) | Preparing the script…");
  const built = step(scripting.state, worker({ kind: "script", id: SCRIPT_ID, units }));
  assert("the units back, no stand-in: build and play, the tap was the consent", built.state === scripting.state && effects(built) === "build,neural play");
  throws("a script reply with another id is not ours", () => step(scripting.state, worker({ kind: "script", id: 7, units })));

  const listening = step(built.state, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("the performer's first view puts the neural voice on stage", listening.state.kind === "neural" && shown(listening.state) === "Listen | stop(off) | Ready");
  const crashed = step(downloading.state, { kind: "worker-error", message: "the worker bundle failed to load" });
  assert("a worker error while downloading: crashed, the worker terminated, Play reads Retry", effects(crashed) === "release terminate" && shown(crashed.state) === "Retry | stop(off) | The neural voice failed: the worker bundle failed to load");
  assert("an error with no message still names the failure", shown(step(warming.state, { kind: "worker-error", message: "" }).state).endsWith("The neural voice failed"));
  const crashedOnStage = step(listening.state, { kind: "worker-error", message: "boom" });
  assert("a crash on stage with no stand-in: released, nobody to hand the stage to", effects(crashedOnStage) === "release terminate" && crashedOnStage.state.kind === "provisioning" && crashedOnStage.state.standIn.kind === "none");
  throws("a view after the crash is a violation: the released performer's last view never reaches step", () => step(crashed.state, { kind: "view", view: viewOf({ kind: "idle" }) }));
  const disposedMid = step(listening.state, { kind: "dispose" });
  assert("dispose, anywhere: back to the start, the live worker asked to dispose", disposedMid.state.kind === "provisioning" && disposedMid.state.neural.kind === "idle" && effects(disposedMid) === "release dispose");
  const respawned = step(crashed.state, tapPlay);
  assert("Retry spawns a fresh worker and probes", effects(respawned) === "spawn" && respawned.state.kind === "provisioning" && respawned.state.neural.kind === "probing");
  throws("a stand-in report with no stand-in is a violation", () => step(idle, synthAt(speakingAt(0))));
}

// ── the pure machine, with the browser voice standing in ──────────────────────────────

console.log("step, with a stand-in: the browser voice speaks while the neural voice is on its way");
{
  const idle = initialState("synth");
  assert("idle: Play is on, the stand-in is named, the download too", shown(idle) === `Listen | stop(off) | Browser voice standing in · the neural voice downloads a ${MB} model once, then runs on this device`);
  const started = step(idle, tapPlay);
  assert("tap play: the stand-in plays AND the worker is spawned", effects(started) === "synth play,spawn" && started.state.kind === "provisioning" && started.state.neural.kind === "probing");
  const speaking = step(started.state, synthAt(speakingAt(0)));
  assert("the stand-in's report: Pause and Stop, the passage, and the neural voice's phase", shown(speaking.state) === "Pause | stop | Browser voice standing in · passage 1 of 2 · checking this device for the neural voice…");
  const pausing = step(speaking.state, tapPlay);
  assert("tap play while speaking pauses the stand-in and kicks nothing", effects(pausing) === "synth pause");
  const paused = step(pausing.state, synthAt(pausedAt(0)));
  assert("paused: Resume, and the position held", shown(paused.state) === "Resume | stop | Browser voice standing in · paused at passage 1 of 2 · checking this device for the neural voice…");
  assert("tap play while paused resumes; the neural voice is already on its way, so nothing more", effects(step(paused.state, tapPlay)) === "synth play");
  assert("tap stop stops the stand-in", effects(step(speaking.state, tapStop)) === "synth stop");

  const downloading = step(step(speaking.state, worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } })).state, progress(50_000_000, 239_000_000));
  assert("downloading while the stand-in speaks: both facts on one line, and the bar", shown(downloading.state) === "Pause | stop | Browser voice standing in · passage 1 of 2 · downloading the neural voice · 50 MB of 239 MB | bar 50000000/239000000");
  const unsupported = step(speaking.state, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-f16" } } }));
  assert("unsupported: the stand-in keeps the stage, and the reason is said", shown(unsupported.state) === "Pause | stop | Browser voice standing in · passage 1 of 2 · this device can't run the neural voice: the graphics adapter lacks 16-bit floats");
  assert("tap play on an unsupported device only drives the stand-in", effects(step(step(unsupported.state, synthAt({ kind: "idle" })).state, tapPlay)) === "synth play");

  const scripting = step(step(downloading.state, progress(239_000_000, 239_000_000)).state, worker({ kind: "ready", backend: "webgpu", modelVersion: "v" }));
  const handover = step(step(scripting.state, synthAt(speakingAt(1))).state, worker({ kind: "script", id: SCRIPT_ID, units }));
  assert("the units back while the stand-in speaks passage 2: silence it, build, seek the neural voice to passage 2", effects(handover) === "synth stop,build,neural seek 1");
  const handoverPaused = step(step(scripting.state, synthAt(pausedAt(1))).state, worker({ kind: "script", id: SCRIPT_ID, units }));
  assert("paused at passage 2: the neural voice takes the place, paused", effects(handoverPaused) === "synth stop,build,neural seek 1,neural pause");
  const handoverIdle = step(step(scripting.state, synthAt({ kind: "idle" })).state, worker({ kind: "script", id: SCRIPT_ID, units }));
  assert("the reader had stopped the stand-in: the neural voice is built and stays silent", effects(handoverIdle) === "synth stop,build");

  const onStage = step(handover.state, { kind: "view", view: viewOf({ kind: "speaking", at: { unitIndex: 2, offsetMs: 0 }, flow: "waiting" }) });
  assert("on stage: the neural readout, passage 2", onStage.state.kind === "neural" && shown(onStage.state) === "Pause | stop | Synthesizing ahead… · passage 2 of 2");
  throws("a stand-in report while the neural voice is on stage is a violation", () => step(onStage.state, synthAt(speakingAt(0))));
  const fell = step(onStage.state, { kind: "worker-error", message: "boom" });
  assert("a crash on stage: released, and the stand-in is sent where the neural voice stood", effects(fell) === "release terminate,synth seek 1" && fell.state.kind === "provisioning" && fell.state.neural.kind === "crashed");
  const fellPaused = step(step(onStage.state, { kind: "view", view: viewOf({ kind: "paused", at: { unitIndex: 1, offsetMs: 0 } }) }).state, { kind: "worker-error", message: "boom" });
  assert("a crash while paused: the stand-in holds the same passage", effects(fellPaused) === "release terminate,synth seek 0,synth pause");
  const back = step(fell.state, synthAt(speakingAt(1)));
  assert("the stand-in's report after the fall: standing in again, the failure named", shown(back.state) === "Pause | stop | Browser voice standing in · passage 2 of 2 · the neural voice failed: boom");
  assert("tap play from paused after a crash retries: the stand-in resumes and a worker is spawned", effects(step(step(fell.state, synthAt(pausedAt(1))).state, tapPlay)) === "synth play,spawn");
  const disposed = step(onStage.state, { kind: "dispose" });
  assert("dispose on stage: the worker disposed, the stand-in silenced, back to the start", effects(disposed) === "release dispose,synth stop" && shown(disposed.state) === shown(idle));
}

console.log("step: violations throw");
{
  const idle = initialState("none");
  throws("capability outside probing", () => step(idle, worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } })));
  throws("progress outside loading", () => step(idle, progress(1, 2)));
  throws("ready outside loading", () => step(step(idle, tapPlay).state, worker({ kind: "ready", backend: "webgpu", modelVersion: "v" })));
  throws("script outside scripting", () => step(idle, worker({ kind: "script", id: SCRIPT_ID, units })));
  throws("a view before there is a performer", () => step(idle, { kind: "view", view: viewOf({ kind: "idle" }) }));
  throws("a synthesis message before the neural voice is on stage", () => step(idle, worker({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) })));
  throws("refused, anywhere", () => step(idle, worker({ kind: "refused", request: { kind: "load" }, phase: "loading" })));
  throws("disposed, anywhere: the port ends the worker on it first", () => step(idle, worker({ kind: "disposed" })));
}

// ── the driver ────────────────────────────────────────────────────────────────────────

// A stub synthesizer under the real browser-voice performer: what it was asked to say,
// and `end` fired by hand.
class StubUtterance {
  text: string;
  voice: SpeechSynthesisVoice | null = null;
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onboundary: ((event: { name: string; charIndex: number }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}
interface Synth {
  readonly spoken: StubUtterance[];
  cancels: number;
}
const standIn = (w: SpeechWindow): Synth => {
  const synth: Synth = { spoken: [], cancels: 0 };
  Object.defineProperty(w, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => [],
      speak: (u: StubUtterance) => synth.spoken.push(u),
      cancel: () => {
        synth.cancels += 1;
      },
      pause: () => undefined,
      resume: () => undefined,
    },
  });
  Object.defineProperty(w, "SpeechSynthesisUtterance", { configurable: true, value: StubUtterance });
  return synth;
};

const MARKUP = `<!DOCTYPE html><body>
  <div class="speech-controls">
    <button class="speech-play" type="button"></button>
    <button class="speech-stop" type="button" disabled></button>
    <progress class="speech-progress" hidden></progress>
    <p class="speech-now"></p>
  </div></body>`;

interface Rig {
  readonly window: SpeechWindow;
  readonly play: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly bar: HTMLProgressElement;
  readonly port: SynthesisPort;
  readonly sent: ToWorker[];
  readonly emit: (message: FromWorker) => void;
  readonly fail: (message: string) => void;
  readonly counts: { spawned: number; terminated: number; disposed: number; listeners: () => number };
  readonly said: () => string;
  readonly frames: { request: (callback: () => void) => number; cancel: () => void; pending: number; tick: () => void };
  readonly positions: (ReadAlongAt | null)[];
  readonly where: () => string;
}

const rig = (): Rig => {
  const dom = new JSDOM(MARKUP);
  const window = dom.window as unknown as SpeechWindow;
  const doc = window.document;
  const el = <T extends Element>(selector: string): T => {
    const found = doc.querySelector<T>(selector);
    if (found === null) throw new Error(`fixture: no ${selector}`);
    return found;
  };
  const sent: ToWorker[] = [];
  const listeners = new Set<(message: FromWorker) => void>();
  const errorListeners = new Set<(message: string) => void>();
  const counts = { spawned: 0, terminated: 0, disposed: 0, listeners: () => listeners.size + errorListeners.size };
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
  return {
    window,
    play: el(".speech-play"),
    stop: el(".speech-stop"),
    status: el(".speech-now"),
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
    said: () => sent.map((m) => (m.kind === "synthesize" ? `synthesize ${m.unitId}` : m.kind === "cancel" ? `cancel ${m.unitId}` : m.kind)).join(),
    frames,
    positions,
    where: () => {
      const at = positions.at(-1);
      return at === null || at === undefined ? "silent" : `${at.utterance.anchor} ${at.span.charStart}-${at.span.charEnd} of ${at.turn.length}`;
    },
  };
};

console.log("createListenPanel: the browser voice stands in, the neural voice takes over where it stood");
{
  const r = rig();
  const synth = standIn(r.window);
  const panel = createListenPanel({
    controls: { play: r.play, stop: r.stop, status: r.status, progress: r.bar },
    utterances,
    voices: DEFAULT_VOICES,
    spawn: () => {
      r.counts.spawned += 1;
      return r.port;
    },
    Device: StubDevice,
    frames: r.frames,
    standIn: (onState) => {
      const player = createPlayer({ window: r.window, utterances, onState });
      if (player === null) throw new Error("fixture: the stub synthesizer did not yield a player");
      return player;
    },
    onPosition: (at) => r.positions.push(at),
  });
  const line = (): string => `${r.play.textContent}${r.play.disabled ? "(off)" : ""} | stop${r.stop.disabled ? "(off)" : ""} | ${r.status.textContent}`;

  assert("mounted: the stand-in is named, nothing spawned, Play on", line() === `Listen | stop(off) | Browser voice standing in · the neural voice downloads a ${MB} model once, then runs on this device` && r.counts.spawned === 0);

  r.play.click();
  assert("click Play: the browser voice speaks passage 1 at once, and the worker is spawned", synth.spoken[0]?.text === one.text && r.counts.spawned === 1 && line() === "Pause | stop | Browser voice standing in · passage 1 of 2 · checking this device for the neural voice…");
  assert("the cursor is on the whole first utterance, its turn of one", r.where() === "t1 0-42 of 1" && r.frames.pending === 1);
  synth.spoken[0]?.onboundary?.({ name: "word", charIndex: 6 });
  r.frames.tick();
  assert("a word boundary moves the cursor on the next frame", r.where() === "t1 6-14 of 1");

  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 50_000_000, totalBytes: 200_000_000 } });
  assert("downloading: the bar shows beside the stand-in's line", !r.bar.hidden && r.bar.value === 50_000_000 && line() === "Pause | stop | Browser voice standing in · passage 1 of 2 · downloading the neural voice · 50 MB of 200 MB");
  synth.spoken[0]?.onend?.();
  assert("the stand-in moves on to passage 2 while the download runs", synth.spoken[1]?.text === two.text && line().includes("passage 2 of 2") && r.where() === "t2 0-8 of 1");
  r.emit({ kind: "progress", progress: { loadedBytes: 200_000_000, totalBytes: 200_000_000 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  assert("ready: the script goes to the worker, the stand-in still speaking", r.sent.at(-1)?.kind === "script" && line() === "Pause | stop | Browser voice standing in · passage 2 of 2 · preparing the script…");

  const cancelsBefore = synth.cancels;
  r.emit({ kind: "script", id: SCRIPT_ID, units });
  const device = StubDevice.instances.at(-1);
  if (device === undefined) throw new Error("the panel did not build a player");
  assert("units back: the stand-in is silenced and the neural voice takes up passage 2, from its start", synth.cancels === cancelsBefore + 1 && panel.state().kind === "neural" && r.said().endsWith("synthesize 2") && line() === "Pause | stop | Synthesizing ahead… · passage 2 of 2");
  assert("the cursor stays on passage 2 across the handover", r.where() === "t2 0-8 of 1" && r.frames.pending === 1);

  r.emit({ kind: "audio", unitId: 2, frameIndex: 0, pcm: frame(2, 0) });
  r.emit({ kind: "done", unitId: 2, report: report(FRAME_S * 1000), elapsedMs: 5 });
  assert("audio arrives: playing", line() === "Pause | stop | Playing · passage 2 of 2");
  device.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("the last unit ends: Ready, the cursor cleared, the loop off", line() === "Listen | stop(off) | Ready" && r.positions.at(-1) === null && r.frames.pending === 0);

  r.play.click();
  assert("Play again plays the neural voice from the top, no new download, no stand-in", r.said().endsWith("synthesize 0") && synth.spoken.length === 2 && line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.where() === "t1 0-20 of 1");

  r.fail("boom");
  assert("the worker dies on stage: the device closed, the worker terminated, the stand-in takes passage 1 back", device.calls.at(-1) === "close" && r.counts.terminated === 1 && synth.spoken.at(-1)?.text === one.text && line() === "Pause | stop | Browser voice standing in · passage 1 of 2 · the neural voice failed: boom");
  assert("the cursor is the stand-in's now", r.where() === "t1 0-42 of 1" && r.counts.listeners() === 0);
  r.play.click();
  assert("Pause pauses the stand-in and spawns nothing", line() === "Resume | stop | Browser voice standing in · paused at passage 1 of 2 · the neural voice failed: boom" && r.counts.spawned === 1 && r.frames.pending === 0);
  r.play.click();
  assert("Resume resumes the stand-in and retries the neural voice", r.counts.spawned === 2 && line() === "Pause | stop | Browser voice standing in · passage 1 of 2 · checking this device for the neural voice…");
  r.stop.click();
  assert("Stop silences the stand-in; the neural voice stays on its way", line() === "Listen | stop(off) | Browser voice standing in · checking this device for the neural voice…" && r.positions.at(-1) === null);

  panel.dispose();
  assert("dispose: the port is disposed (not terminated outright), no longer heard, the panel at the start", r.counts.disposed === 1 && r.counts.terminated === 1 && r.counts.listeners() === 0 && panel.state().kind === "provisioning" && line() === `Listen | stop(off) | Browser voice standing in · the neural voice downloads a ${MB} model once, then runs on this device`);
}

console.log("createListenPanel: no stand-in, the transport waits for the neural voice");
{
  const r = rig();
  const panel = createListenPanel({
    controls: { play: r.play, stop: r.stop, status: r.status, progress: r.bar },
    utterances,
    voices: DEFAULT_VOICES,
    spawn: () => {
      r.counts.spawned += 1;
      return r.port;
    },
    Device: StubDevice,
    frames: r.frames,
    standIn: null,
    onPosition: (at) => r.positions.push(at),
  });
  const line = (): string => `${r.play.textContent}${r.play.disabled ? "(off)" : ""} | stop${r.stop.disabled ? "(off)" : ""} | ${r.status.textContent}`;

  assert("mounted idle: the readout is written, nothing spawned", line() === `Listen | stop(off) | The neural voice downloads a ${MB} model once, then runs on this device` && r.counts.spawned === 0);
  r.play.click();
  assert("click Play: the worker is spawned and heard, the button disables", r.counts.spawned === 1 && line() === "Listen(off) | stop(off) | Checking this device for the neural voice…");
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 50_000_000, totalBytes: 200_000_000 } });
  assert("downloading: the bar shows and carries the bytes", !r.bar.hidden && r.bar.value === 50_000_000 && r.bar.max === 200_000_000 && line() === "Listen(off) | stop(off) | Downloading the neural voice · 50 MB of 200 MB");
  r.emit({ kind: "progress", progress: { loadedBytes: 200_000_000, totalBytes: 200_000_000 } });
  assert("warming: the bar goes", r.bar.hidden && line() === "Listen(off) | stop(off) | Warming up the neural voice…");
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  const script = r.sent.at(-1);
  assert("ready: the page's utterances go to the worker under the panel's script id", script?.kind === "script" && script.id === SCRIPT_ID && script.utterances === utterances);

  r.emit({ kind: "script", id: SCRIPT_ID, units });
  const device = StubDevice.instances.at(-1);
  if (device === undefined) throw new Error("the panel did not build a player");
  assert("units back: the neural voice plays at once and asks for unit 0", panel.state().kind === "neural" && r.said().endsWith("synthesize 0") && line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  assert("the cursor is on unit 0's whole span while it has no record", r.where() === "t1 0-20 of 1" && r.frames.pending === 1);

  r.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  r.emit({ kind: "audio", unitId: 0, frameIndex: 1, pcm: frame(0, 1) });
  assert("audio arrives: playing", line() === "Pause | stop | Playing · passage 1 of 2");
  r.emit({ kind: "done", unitId: 0, report: report(2 * FRAME_S * 1000), elapsedMs: 5 });
  r.emit({ kind: "audio", unitId: 1, frameIndex: 0, pcm: frame(1, 0) });
  r.emit({ kind: "done", unitId: 1, report: report(FRAME_S * 1000), elapsedMs: 5 });
  r.emit({ kind: "audio", unitId: 2, frameIndex: 0, pcm: frame(2, 0) });
  r.emit({ kind: "done", unitId: 2, report: report(FRAME_S * 1000), elapsedMs: 5 });

  device.advance(SCHEDULE_LEAD_S + 2 * FRAME_S + 0.01);
  assert("crossing into unit 1: still passage 1, the cursor on unit 1's span", line() === "Pause | stop | Playing · passage 1 of 2" && r.where() === "t1 21-42 of 1");
  device.advance(FRAME_S);
  assert("crossing into unit 2: passage 2, another turn, its own span", line() === "Pause | stop | Playing · passage 2 of 2" && r.where() === "t2 0-8 of 1");
  const before = r.positions.length;
  r.frames.tick();
  assert("a frame with the cursor unmoved reports nothing new", r.positions.length === before && r.frames.pending === 1);

  r.play.click();
  assert("Pause: paused, the loop is off, the label says Resume", line() === "Resume | stop | Paused · passage 2 of 2" && r.frames.pending === 0);
  r.play.click();
  assert("Resume: speaking again, the loop is back", r.play.textContent === "Pause" && r.frames.pending === 1);
  r.stop.click();
  assert("Stop: idle, the cursor cleared, Stop disabled, Play says Listen", line() === "Listen | stop(off) | Ready" && r.positions.at(-1) === null && r.frames.pending === 0);

  r.fail("the worker bundle failed to load");
  assert("the worker dies: the device closed, the worker terminated, nobody to hand the stage to", device.calls.at(-1) === "close" && r.counts.terminated === 1 && line() === "Retry | stop(off) | The neural voice failed: the worker bundle failed to load" && r.counts.listeners() === 0);
  r.play.click();
  assert("Retry: a fresh worker is spawned and probed", r.counts.spawned === 2 && line() === "Listen(off) | stop(off) | Checking this device for the neural voice…");
  panel.dispose();
  assert("dispose: disposed, unheard, at the start", r.counts.disposed === 1 && r.counts.listeners() === 0 && line() === `Listen | stop(off) | The neural voice downloads a ${MB} model once, then runs on this device`);
}

console.log(process.exitCode === 1 ? "listen-panel-check: FAILED" : "listen-panel-check: ok");
