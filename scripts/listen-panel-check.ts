// The neural Listen panel, driven under jsdom with a stub worker port, the stub playback
// device and a hand-fired frame loop (slopspot-read-along-q35.9).
// Run: `tsx scripts/listen-panel-check.ts`.
//
// Two halves, as in scheduler-check.ts. First the pure `step` through its accept table:
// every state's answer to every event that may arrive in it, and the throw for every
// message the protocol says cannot. Then the real driver over the REAL scheduler and REAL
// unit player, on the stub device, with a stub port standing in for the worker — asserting
// only what a reader sees: the button labels, the status sentence, the progress bar, and
// where the read-along cursor is [LAW:behavior-not-structure] [LAW:verifiable-goals].

import { JSDOM } from "jsdom";
import {
  createListenPanel,
  DEFAULT_VOICES,
  DOWNLOAD_BYTES,
  passages,
  readout,
  SCRIPT_ID,
  step,
  type PanelEvent,
  type PanelState,
} from "../src/listenPanel";
import type { ReadAlongAt } from "../src/readAlong";
import type { SchedulerView } from "../src/scheduler";
import type { Utterance } from "../src/speech";
import { emptyManifest, type UnitReport } from "../src/speechManifest";
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
// their utterance BY REFERENCE, as the worker's structured clone preserves.
const one: Utterance = { index: 1, anchor: "t1", voice: "user", text: "First sentence here. Second sentence here." };
const two: Utterance = { index: 2, anchor: "t2", voice: "assistant", text: "A reply." };
const utterances = [one, two];
const unit = (utterance: Utterance, start: number, end: number): SynthesisUnit => ({ utterance, start, end, text: utterance.text.slice(start, end) });
const units: SynthesisUnit[] = [unit(one, 0, 20), unit(one, 21, 42), unit(two, 0, 8)];

const worker = (message: FromWorker): PanelEvent => ({ kind: "worker", message });
const tapPlay: PanelEvent = { kind: "tap", control: "play" };
const tapStop: PanelEvent = { kind: "tap", control: "stop" };
const progress = (loadedBytes: number, totalBytes: number): PanelEvent => worker({ kind: "progress", progress: { loadedBytes, totalBytes } });
const report = (durationMs: number): UnitReport => ({ durationMs, alignment: { kind: "unit" } });

const viewOf = (player: SchedulerView["player"]): SchedulerView => ({
  player,
  manifest: emptyManifest(units),
  holdings: units.map(() => ({ kind: "absent" })),
});

const effects = (s: ReturnType<typeof step>): string => s.effects.map((e) => (e.kind === "control" ? `control ${e.control}` : e.kind)).join();

// ── the pure machine ──────────────────────────────────────────────────────────────────

console.log("step: the way to audio");
{
  const idle: PanelState = { kind: "idle" };
  assert("idle: Play is the only enabled control, and it names the download", readout(idle).play.enabled && !readout(idle).stop.enabled && readout(idle).status.includes(`${Math.round(DOWNLOAD_BYTES / 1e6)} MB`));
  const probing = step(idle, tapPlay);
  assert("tap play from idle spawns the worker and probes", probing.state.kind === "probing" && effects(probing) === "spawn");
  assert("probing: nothing to tap yet", !readout(probing.state).play.enabled && readout(probing.state).status === "Checking this device…");
  assert("a tap while probing changes nothing", step(probing.state, tapPlay).state === probing.state);

  const unsupported = step(probing.state, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-webgpu" } } }));
  assert("unsupported: the reason is shown, Play is off", unsupported.state.kind === "unsupported" && readout(unsupported.state).status === "This device can't run the neural voice: this browser has no WebGPU." && !readout(unsupported.state).play.enabled);

  const preparing = step(probing.state, worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } }));
  assert("supported: load is sent", preparing.state.kind === "preparing" && effects(preparing) === "load");
  const downloading = step(preparing.state, progress(120_000_000, 239_000_000));
  assert("progress short of the total: downloading, with the bytes", downloading.state.kind === "downloading" && readout(downloading.state).status === "Downloading the voice model · 120 MB of 239 MB" && readout(downloading.state).progress?.loadedBytes === 120_000_000);
  const warming = step(downloading.state, progress(239_000_000, 239_000_000));
  assert("the last byte: warming, no bar", warming.state.kind === "warming" && readout(warming.state).progress === null && readout(warming.state).status === "Warming up the model…");

  const failed = step(warming.state, worker({ kind: "load-failed", failure: { kind: "http", url: "/models/x.part0", status: 503 } }));
  assert("load-failed: the failure is shown and Play becomes Retry", failed.state.kind === "load-failed" && readout(failed.state).play.label === "Retry" && readout(failed.state).play.enabled && readout(failed.state).status.includes("HTTP 503"));
  const retried = step(failed.state, tapPlay);
  assert("retry sends load again", retried.state.kind === "preparing" && effects(retried) === "load");

  const scripting = step(warming.state, worker({ kind: "ready", backend: "webgpu", modelVersion: "v" }));
  assert("ready: the script is sent", scripting.state.kind === "scripting" && effects(scripting) === "script");
  const built = step(scripting.state, worker({ kind: "script", id: SCRIPT_ID, units }));
  assert("the units back: build the scheduler and play, in that order", built.state.kind === "scripting" && effects(built) === "build,control play");
  throws("a script reply with another id is not ours", () => step(scripting.state, worker({ kind: "script", id: 7, units })));

  const listening = step(built.state, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("the scheduler's first view enters listening, with the passages read once from the script", listening.state.kind === "listening" && listening.state.passages.length === 2 && readout(listening.state).status === "Ready" && readout(listening.state).play.label === "Listen");
  const again = step(listening.state, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("a later view keeps the passages already read", listening.state.kind === "listening" && again.state.kind === "listening" && again.state.passages === listening.state.passages);

  const crashed = step(downloading.state, { kind: "worker-error", message: "the worker bundle failed to load" });
  assert("a worker error: crashed, the worker discarded, the failure named, Play reads Retry", crashed.state.kind === "crashed" && effects(crashed) === "discard" && readout(crashed.state).play.label === "Retry" && readout(crashed.state).play.enabled && !readout(crashed.state).stop.enabled && readout(crashed.state).status === "The neural voice worker failed: the worker bundle failed to load");
  assert("an error with no message still names the failure", readout(step(listening.state, { kind: "worker-error", message: "" }).state).status === "The neural voice worker failed");
  assert("the discarded scheduler's last view is not ours: crashed stays", step(crashed.state, { kind: "view", view: viewOf({ kind: "idle" }) }).state === crashed.state);
  const respawned = step(crashed.state, tapPlay);
  assert("Retry spawns a fresh worker and probes", respawned.state.kind === "probing" && effects(respawned) === "spawn");
}

console.log("step: listening");
{
  const at = { unitIndex: 1, offsetMs: 0 };
  const listeningOf = (view: SchedulerView): PanelState => ({ kind: "listening", view, passages: passages(units) });
  const idle = listeningOf(viewOf({ kind: "idle" }));
  const waiting = listeningOf(viewOf({ kind: "speaking", at, flow: "waiting" }));
  const playing = listeningOf(viewOf({ kind: "speaking", at, flow: "audio" }));
  const paused = listeningOf(viewOf({ kind: "paused", at }));
  assert("idle: tap play plays; Stop disabled", effects(step(idle, tapPlay)) === "control play" && !readout(idle).stop.enabled);
  assert("speaking: tap play pauses; the label says so", effects(step(playing, tapPlay)) === "control pause" && readout(playing).play.label === "Pause" && readout(playing).stop.enabled);
  assert("paused: tap play resumes", effects(step(paused, tapPlay)) === "control play" && readout(paused).play.label === "Resume" && readout(paused).status === "Paused · passage 1 of 2");
  assert("tap stop stops", effects(step(playing, tapStop)) === "control stop");
  assert("a tap stop before there is a player changes nothing", step({ kind: "warming" }, tapStop).state.kind === "warming");
  assert("flow audio reads as playing, at the passage (unit 1 is still passage 1)", readout(playing).status === "Playing · passage 1 of 2");
  assert("flow waiting reads as synthesizing ahead, never as a stall", readout(waiting).status === "Synthesizing ahead… · passage 1 of 2");
  const failedView: SchedulerView = { ...viewOf({ kind: "idle" }), holdings: [{ kind: "absent" }, { kind: "absent" }, { kind: "failed", reason: { kind: "frame-cap", frames: 500 }, frames: "none" }] };
  assert("a failed unit is named with its reason", readout(listeningOf(failedView)).status === "Ready · passage 2 of 2 could not be synthesized: the model looped for 500 frames without finishing");
  assert("the scheduler's own messages change nothing here", step(playing, worker({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) })).state === playing);
  assert("passages are utterances, not units", passages(units).length === 2);
}

console.log("step: violations throw");
{
  throws("capability outside probing", () => step({ kind: "idle" }, worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } })));
  throws("progress outside loading", () => step({ kind: "idle" }, progress(1, 2)));
  throws("ready outside loading", () => step({ kind: "probing" }, worker({ kind: "ready", backend: "webgpu", modelVersion: "v" })));
  throws("script outside scripting", () => step({ kind: "idle" }, worker({ kind: "script", id: SCRIPT_ID, units })));
  throws("a view before there is a scheduler", () => step({ kind: "idle" }, { kind: "view", view: viewOf({ kind: "idle" }) }));
  throws("refused, anywhere", () => step({ kind: "warming" }, worker({ kind: "refused", request: { kind: "load" }, phase: "loading" })));
  throws("disposed, anywhere: the port ends the worker on it first", () => step({ kind: "warming" }, worker({ kind: "disposed" })));
}

// ── the driver ────────────────────────────────────────────────────────────────────────

console.log("createListenPanel: the driver over the real scheduler and player");
{
  const dom = new JSDOM(`<!DOCTYPE html><body>
    <div class="speech-neural">
      <button class="neural-play" type="button"></button>
      <button class="neural-stop" type="button" disabled></button>
      <progress class="neural-progress" hidden></progress>
      <p class="neural-now"></p>
    </div></body>`);
  const doc = dom.window.document;
  const el = <T extends Element>(selector: string): T => {
    const found = doc.querySelector<T>(selector);
    if (found === null) throw new Error(`fixture: no ${selector}`);
    return found;
  };
  const play = el<HTMLButtonElement>(".neural-play");
  const stop = el<HTMLButtonElement>(".neural-stop");
  const status = el<HTMLElement>(".neural-now");
  const bar = el<HTMLProgressElement>(".neural-progress");

  const sent: ToWorker[] = [];
  const listeners = new Set<(message: FromWorker) => void>();
  const errorListeners = new Set<(message: string) => void>();
  let spawned = 0;
  let terminated = 0;
  let disposed = 0;
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
      disposed += 1;
    },
    terminate: () => {
      terminated += 1;
    },
  };
  const emit = (message: FromWorker): void => {
    for (const listener of listeners) listener(message);
  };
  const fail = (message: string): void => {
    for (const listener of errorListeners) listener(message);
  };
  const said = (): string => sent.map((m) => (m.kind === "synthesize" ? `synthesize ${m.unitId}` : m.kind === "cancel" ? `cancel ${m.unitId}` : m.kind)).join();

  const pending: (() => void)[] = [];
  let cancelled = 0;
  const frames = {
    request: (callback: () => void): number => pending.push(callback),
    cancel: (): void => {
      cancelled += 1;
      pending.length = 0;
    },
  };
  const tick = (): void => {
    const due = pending.splice(0);
    for (const callback of due) callback();
  };

  const positions: (ReadAlongAt | null)[] = [];
  const where = (at: ReadAlongAt | null | undefined): string =>
    at === null || at === undefined ? "silent" : `${at.utterance.anchor} ${at.span.charStart}-${at.span.charEnd} of ${at.turn.length}`;

  const panel = createListenPanel({
    controls: { play, stop, status, progress: bar },
    utterances,
    voices: DEFAULT_VOICES,
    spawn: () => {
      spawned += 1;
      return port;
    },
    Device: StubDevice,
    frames,
    onPosition: (at) => positions.push(at),
  });

  assert("mounted idle: the readout is written, nothing spawned", play.textContent === "Listen" && !play.disabled && stop.disabled && status.textContent === readout({ kind: "idle" }).status && spawned === 0);

  play.click();
  assert("click Play: the worker is spawned and heard, the button disables", spawned === 1 && listeners.size === 1 && play.disabled && status.textContent === "Checking this device…");
  emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  assert("supported: load sent", said() === "load" && status.textContent === "Preparing the voice model…");
  emit({ kind: "progress", progress: { loadedBytes: 50_000_000, totalBytes: 200_000_000 } });
  assert("downloading: the bar shows and carries the bytes", !bar.hidden && bar.value === 50_000_000 && bar.max === 200_000_000 && status.textContent === "Downloading the voice model · 50 MB of 200 MB");
  emit({ kind: "progress", progress: { loadedBytes: 200_000_000, totalBytes: 200_000_000 } });
  assert("warming: the bar goes", bar.hidden && status.textContent === "Warming up the model…");
  emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  const script = sent.at(-1);
  assert("ready: the page's utterances go to the worker under the panel's script id", script?.kind === "script" && script.id === SCRIPT_ID && script.utterances === utterances && status.textContent === "Preparing the script…");

  emit({ kind: "script", id: SCRIPT_ID, units });
  const device = StubDevice.instances.at(-1);
  if (device === undefined) throw new Error("the panel did not build a player");
  assert("units back: the scheduler plays at once and asks for unit 0", panel.state().kind === "listening" && said().endsWith("synthesize 0"));
  assert("waiting on synthesis is said, not stalled through", status.textContent === "Synthesizing ahead… · passage 1 of 2" && play.textContent === "Pause" && !stop.disabled);
  assert("the cursor is on unit 0's whole span while it has no record", where(positions.at(-1)) === "t1 0-20 of 1");
  assert("the frame loop is armed while speaking", pending.length === 1);

  emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  emit({ kind: "audio", unitId: 0, frameIndex: 1, pcm: frame(0, 1) });
  assert("audio arrives: playing", status.textContent === "Playing · passage 1 of 2");
  emit({ kind: "done", unitId: 0, report: report(2 * FRAME_S * 1000), elapsedMs: 5 });
  emit({ kind: "audio", unitId: 1, frameIndex: 0, pcm: frame(1, 0) });
  emit({ kind: "done", unitId: 1, report: report(FRAME_S * 1000), elapsedMs: 5 });
  emit({ kind: "audio", unitId: 2, frameIndex: 0, pcm: frame(2, 0) });
  emit({ kind: "done", unitId: 2, report: report(FRAME_S * 1000), elapsedMs: 5 });

  device.advance(SCHEDULE_LEAD_S + 2 * FRAME_S + 0.01);
  assert("crossing into unit 1: still passage 1, the cursor on unit 1's span", status.textContent === "Playing · passage 1 of 2" && where(positions.at(-1)) === "t1 21-42 of 1");
  device.advance(FRAME_S);
  assert("crossing into unit 2: passage 2, another turn, its own span", status.textContent === "Playing · passage 2 of 2" && where(positions.at(-1)) === "t2 0-8 of 1");
  const before = positions.length;
  tick();
  assert("a frame with the cursor unmoved reports nothing new", positions.length === before && pending.length === 1);

  play.click();
  assert("Pause: paused, the loop is off, the label says Resume", play.textContent === "Resume" && status.textContent === "Paused · passage 2 of 2" && pending.length === 0 && cancelled >= 1);
  play.click();
  assert("Resume: speaking again, the loop is back", play.textContent === "Pause" && pending.length === 1);

  stop.click();
  assert("Stop: idle, the cursor cleared, Stop disabled, Play says Listen", status.textContent === "Ready" && positions.at(-1) === null && stop.disabled && play.textContent === "Listen" && pending.length === 0);
  const stopped = panel.state();
  assert("Stop: the state is listening with an idle player, read straight from the panel", stopped.kind === "listening" && stopped.view.player.kind === "idle");

  play.click();
  assert("Play again does not re-download: it plays the scheduler already built", spawned === 1 && sent.filter((m) => m.kind === "load").length === 1 && panel.state().kind === "listening" && play.textContent === "Pause");

  fail("the worker bundle failed to load");
  assert("the worker dies mid-listen: crashed, the device closed, the dead worker terminated, the cursor cleared", panel.state().kind === "crashed" && device.calls.at(-1) === "close" && terminated === 1 && positions.at(-1) === null && pending.length === 0);
  assert("the failure is on the status line and Play reads Retry", play.textContent === "Retry" && !play.disabled && stop.disabled && status.textContent === "The neural voice worker failed: the worker bundle failed to load");
  assert("the dead worker is no longer heard", listeners.size === 0 && errorListeners.size === 0);
  play.click();
  assert("Retry: a fresh worker is spawned and probed", spawned === 2 && panel.state().kind === "probing" && status.textContent === "Checking this device…");

  panel.dispose();
  assert("dispose: the port is disposed (not terminated outright), no longer heard, the panel idle", disposed === 1 && terminated === 1 && listeners.size === 0 && errorListeners.size === 0 && panel.state().kind === "idle");
  assert("dispose: the controls show the idle readout, not the last live state", play.textContent === "Listen" && !play.disabled && stop.disabled && bar.hidden && status.textContent === readout({ kind: "idle" }).status);
}

console.log(process.exitCode === 1 ? "listen-panel-check: FAILED" : "listen-panel-check: ok");
