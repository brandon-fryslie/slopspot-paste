// The Listen panel, driven under jsdom with a stub worker port, the stub playback device,
// a stub synthesizer under the REAL browser-voice performer, and a hand-fired frame loop
// (slopspot-read-along-q35.9, slopspot-read-along-a35.1, slopspot-read-along-a35.3).
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
  DOWNLOAD_BYTES,
  ENGAGED_CLASS,
  initialState,
  listening,
  PLAY_WORDS,
  readout,
  SCRIPT_ID,
  step,
  type ListenControls,
  type PanelEvent,
  type PanelState,
} from "../src/listenPanel";
import { utteranceTable, type NeuralView } from "../src/neuralPerformer";
import { carry, SPEEDS, type Mark, type PerformerState } from "../src/performer";
import type { ReadAlongAt } from "../src/readAlong";
import type { Utterance } from "../src/speech";
import { emptyManifest, type UnitReport } from "../src/speechManifest";
import { createPlayer, type SpeechWindow } from "../src/speechPlayer";
import { DEFAULT_VOICES, type SynthesisUnit } from "../src/speechScript";
import type { SynthesisPort } from "../src/synthesisClient";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { clockText, DEFAULT_MS_PER_CHAR } from "../src/timeline";
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
const speakingAt = (utterance: number): PerformerState => ({ kind: "speaking", at: { utterance, segment: { charStart: 0, charEnd: 5 }, word: null } });
const pausedAt = (utterance: number): PerformerState => ({ kind: "paused", at: { utterance, segment: { charStart: 0, charEnd: 5 }, word: null } });
const mark = (utterance: number, char = 0): Mark => ({ utterance, char });
const seekTo = (utterance: number, char = 0): PanelEvent => ({ kind: "seek", to: mark(utterance, char) });

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
        ? `${e.on} ${e.event.kind}${e.event.kind === "seek" ? ` ${e.event.to.utterance}:${e.event.to.char}` : e.event.kind === "rate" ? ` ${e.event.to}` : ""}`
        : e.kind === "release"
          ? `release ${e.worker}`
          : e.kind === "handover"
            ? `handover ${e.from}>${e.to}`
            : e.kind,
    )
    .join();
// The action the main button would take, under the word the reader sees on it: the two
// are one map (PLAY_WORDS), so a check reading the word is reading the action.
const shown = (state: PanelState): string => {
  const r = readout(state, utterances);
  return `${PLAY_WORDS[r.play.action]}${r.play.enabled ? "" : "(off)"} | stop${r.stop.enabled ? "" : "(off)"} | ${r.status}${r.progress === null ? "" : ` | bar ${r.progress.loadedBytes}/${r.progress.totalBytes}`}`;
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
  assert("the units back, no stand-in: the performer is built, the phase unchanged until its first view", built.state === scripting.state && effects(built) === "build");
  throws("a script reply with another id is not ours", () => step(scripting.state, worker({ kind: "script", id: 7, units })));

  const listening = step(built.state, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("the performer's first view puts the neural voice on stage and plays it from the top: the tap was the consent", listening.state.kind === "neural" && effects(listening) === "neural rate 1,neural seek 0:0" && shown(listening.state) === "Listen | stop(off) | Ready");
  assert("a seek on stage seeks the neural voice", effects(step(listening.state, seekTo(1, 3))) === "neural seek 1:3");

  // A tap on the page with no stand-in: the place is kept for the neural voice's arrival.
  const tapped = step(idle, seekTo(1, 3));
  assert("a seek from idle spawns the worker like Play, and holds the place", effects(tapped) === "spawn" && tapped.state.kind === "provisioning" && tapped.state.standIn.kind === "none" && tapped.state.standIn.from.utterance === 1 && tapped.state.standIn.from.char === 3);
  const tappedTwice = step(tapped.state, seekTo(0, 21));
  assert("a later seek replaces the place and spawns nothing more", effects(tappedTwice) === "" && tappedTwice.state.kind === "provisioning" && tappedTwice.state.standIn.kind === "none" && tappedTwice.state.standIn.from.char === 21);
  // The way to audio, walked from the held place: the neural voice's first view goes there.
  const arrivingEvents: ReadonlyArray<PanelEvent> = [
    worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } }),
    progress(1, 1),
    worker({ kind: "ready", backend: "webgpu", modelVersion: "v" }),
    worker({ kind: "script", id: SCRIPT_ID, units }),
  ];
  const arriving = arrivingEvents.reduce((state, event) => step(state, event).state, tappedTwice.state);
  const arrivedAtPlace = step(arriving, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert("the neural voice arriving after a tap is told the speed, then sent to the tapped place", effects(arrivedAtPlace) === "neural rate 1,neural seek 0:21" && arrivedAtPlace.state.kind === "neural");
  const crashed = step(downloading.state, { kind: "worker-error", message: "the worker bundle failed to load" });
  assert("a worker error while downloading: crashed, the worker terminated, Play reads Retry", effects(crashed) === "release terminate" && shown(crashed.state) === "Retry | stop(off) | The neural voice failed: the worker bundle failed to load");
  assert("an error with no message still names the failure", shown(step(warming.state, { kind: "worker-error", message: "" }).state).endsWith("The neural voice failed"));
  const crashedOnStage = step(listening.state, { kind: "worker-error", message: "boom" });
  assert("a crash on stage with no stand-in: released, nobody to hand the stage to", effects(crashedOnStage) === "release terminate" && crashedOnStage.state.kind === "provisioning" && crashedOnStage.state.standIn.kind === "none");
  const playing = step(listening.state, { kind: "view", view: viewOf({ kind: "speaking", at: { unitIndex: 2, offsetMs: 0 }, flow: "audio" }) });
  const fellPlaying = step(playing.state, { kind: "worker-error", message: "boom" });
  assert("a crash while playing with no stand-in keeps the reported place for the retry", fellPlaying.state.kind === "provisioning" && fellPlaying.state.standIn.kind === "none" && fellPlaying.state.standIn.from.utterance === 1 && fellPlaying.state.standIn.from.char === 0);
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
  assert("idle: Play is on, and the line is the neural voice's cost — a silent stand-in claims nothing", shown(idle) === `Listen | stop(off) | The neural voice downloads a ${MB} model once, then runs on this device`);
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
  assert("a seek from idle seeks the stand-in AND spawns the worker, like Play", effects(step(idle, seekTo(1, 3))) === "synth seek 1:3,spawn");
  assert("a seek while the neural voice is on its way only seeks the stand-in", effects(step(paused.state, seekTo(0, 21))) === "synth seek 0:21");

  const downloading = step(step(speaking.state, worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } })).state, progress(50_000_000, 239_000_000));
  assert("downloading while the stand-in speaks: both facts on one line, and the bar", shown(downloading.state) === "Pause | stop | Browser voice standing in · passage 1 of 2 · downloading the neural voice · 50 MB of 239 MB | bar 50000000/239000000");
  const unsupported = step(speaking.state, worker({ kind: "capability", support: { kind: "unsupported", reason: { kind: "no-f16" } } }));
  assert("unsupported: the stand-in keeps the stage, and the reason is said", shown(unsupported.state) === "Pause | stop | Browser voice standing in · passage 1 of 2 · this device can't run the neural voice: the graphics adapter lacks 16-bit floats");
  assert("tap play on an unsupported device only drives the stand-in", effects(step(step(unsupported.state, synthAt({ kind: "idle" })).state, tapPlay)) === "synth play");

  const scripting = step(step(downloading.state, progress(239_000_000, 239_000_000)).state, worker({ kind: "ready", backend: "webgpu", modelVersion: "v" }));
  const spokenOn = step(scripting.state, synthAt(speakingAt(1))).state;
  const built = step(spokenOn, worker({ kind: "script", id: SCRIPT_ID, units }));
  assert("the units back while the stand-in speaks passage 2: the performer is built, the stand-in speaks on", effects(built) === "build" && built.state === spokenOn);

  const onStage = step(built.state, { kind: "view", view: viewOf({ kind: "speaking", at: { unitIndex: 2, offsetMs: 0 }, flow: "waiting" }) });
  assert(
    "the first view: the arriving voice is told the speed, the stage passes, then the stand-in is silenced",
    effects(onStage) === "neural rate 1,handover synth>neural,synth stop",
  );
  assert("on stage: the neural readout, passage 2", onStage.state.kind === "neural" && shown(onStage.state) === "Pause | stop | Synthesizing ahead… · passage 2 of 2");
  const failed: NeuralView["holdings"][number] = { kind: "failed", reason: { kind: "frame-cap", frames: 500 }, frames: "none" };
  const holdings: NeuralView["holdings"] = units.map((_, i): NeuralView["holdings"][number] => (i === 1 ? failed : { kind: "absent" }));
  const withFailure = { ...viewOf({ kind: "speaking", at: { unitIndex: 2, offsetMs: 0 }, flow: "audio" }), holdings };
  assert("a failed unit is named by its passage and its reason, after the player's own line", shown(step(onStage.state, { kind: "view", view: withFailure }).state) === "Pause | stop | Playing · passage 2 of 2 · passage 1 of 2 could not be synthesized: the model looped for 500 frames without finishing");
  assert("the stand-in's idle on being silenced is heard and changes nothing", step(onStage.state, synthAt({ kind: "idle" })).state === onStage.state);
  throws("a stand-in speaking while the neural voice is on stage is a violation", () => step(onStage.state, synthAt(speakingAt(0))));
  const fell = step(onStage.state, { kind: "worker-error", message: "boom" });
  assert("a crash on stage: the stage passes back to the stand-in, then the worker is released", effects(fell) === "synth rate 1,handover neural>synth,release terminate" && fell.state.kind === "provisioning" && fell.state.neural.kind === "crashed");
  const back = step(fell.state, synthAt(speakingAt(1)));
  assert("the stand-in's report after the fall: standing in again, the failure named", shown(back.state) === "Pause | stop | Browser voice standing in · passage 2 of 2 · the neural voice failed: boom");
  assert("tap play from paused after a crash retries: the stand-in resumes and a worker is spawned", effects(step(step(fell.state, synthAt(pausedAt(1))).state, tapPlay)) === "synth play,spawn");
  const disposed = step(onStage.state, { kind: "dispose" });
  assert("dispose on stage: the worker disposed, the stand-in silenced, back to the start", effects(disposed) === "release dispose,synth stop" && shown(disposed.state) === shown(idle));
}

console.log("carry: what one performer tells the next");
{
  const carried = (state: PerformerState): string => carry(state).map((e) => `${e.kind}${e.kind === "seek" ? ` ${e.to.utterance}:${e.to.char}` : ""}`).join();
  assert("idle carries nothing", carried({ kind: "idle" }) === "");
  assert("speaking with no word carries a seek to where its segment begins", carried(speakingAt(1)) === "seek 1:0");
  assert("paused carries the seek, then a pause", carried(pausedAt(1)) === "seek 1:0,pause");
  const onWord: PerformerState = { kind: "speaking", at: { utterance: 1, segment: { charStart: 0, charEnd: 40 }, word: { charStart: 21, charEnd: 29 } } };
  assert("speaking on a word carries a seek to that word", carried(onWord) === "seek 1:21");
}

console.log("step: the speed is the panel's own, and whoever is on stage obeys it");
{
  const withStandIn = initialState("synth");
  const faster = step(withStandIn, { kind: "speed", by: 1 });
  assert("a step up is held by the panel and sent to the stand-in", faster.state.speed === 1.25 && effects(faster) === "synth rate 1.25");
  const slower = step(faster.state, { kind: "speed", by: -1 });
  assert("and back down again", slower.state.speed === 1 && effects(slower) === "synth rate 1");
  const slowest = [1, 2, 3].reduce((at) => step(at.state, { kind: "speed", by: -1 }), step(withStandIn, { kind: "speed", by: -1 }));
  assert("the list has an end: the state stops there and nothing is sent", slowest.state.speed === 0.75 && effects(slowest) === "");
  assert("and the control that would have gone further says so", !readout(slowest.state, utterances).speed.slower && readout(slowest.state, utterances).speed.faster);
  const fastest = SPEEDS.reduce((at) => step(at.state, { kind: "speed", by: 1 }), step(withStandIn, { kind: "speed", by: 1 }));
  assert("the same at the top of the list", fastest.state.speed === 2.5 && !readout(fastest.state, utterances).speed.faster);
  assert("the label is the speed the reader chose", readout(faster.state, utterances).speed.label === "1.25×");

  // With no stand-in there is nobody to obey yet: the state carries the speed to whoever
  // arrives, exactly as it carries the place.
  const noStandIn = step(initialState("none"), { kind: "speed", by: 1 });
  assert("with no performer yet, the speed waits in the state", noStandIn.state.speed === 1.25 && effects(noStandIn) === "");
  const onStageFast = step(
    step(step(step(step(noStandIn.state, tapPlay).state, worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } })).state, worker({ kind: "ready", backend: "webgpu", modelVersion: "v" })).state, worker({ kind: "script", id: SCRIPT_ID, units })).state,
    { kind: "view", view: viewOf({ kind: "idle" }) },
  );
  assert("and is the first thing the arriving neural voice is told", effects(onStageFast) === "neural rate 1.25,neural seek 0:0");

  const kept = step(onStageFast.state, { kind: "dispose" });
  assert("a teardown is not the reader changing their mind: the speed survives dispose", kept.state.speed === 1.25);

  // The same journey WITH a stand-in, step for step: a speed chosen while the browser
  // voice reads and the model downloads must still be the speed the neural voice arrives
  // at. Every event of the path is here because a reverted speed was seen once in a
  // browser on this route and never reproduced; this is the route, in the machine.
  const spedUp = step(step(withStandIn, { kind: "speed", by: 1 }).state, { kind: "speed", by: 1 });
  const journey: ReadonlyArray<PanelEvent> = [
    tapPlay,
    synthAt(speakingAt(0)),
    worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } }),
    progress(120_000_000, 239_000_000),
    progress(239_000_000, 239_000_000),
    worker({ kind: "ready", backend: "webgpu", modelVersion: "v" }),
    synthAt(speakingAt(1)),
    worker({ kind: "script", id: SCRIPT_ID, units }),
  ];
  const arrived = journey.reduce((at, event) => step(at.state, event), spedUp);
  assert("the speed is untouched by every event on the way to the stage", arrived.state.speed === 1.5);
  const takesStage = step(arrived.state, { kind: "view", view: viewOf({ kind: "idle" }) });
  assert(
    "and the arriving neural voice is told it before it is told where to stand",
    takesStage.state.speed === 1.5 && effects(takesStage) === "neural rate 1.5,handover synth>neural,synth stop",
  );
  const crashedBack = step(takesStage.state, { kind: "worker-error", message: "boom" });
  assert("a crash hands the stage back at the reader's speed, not at the voice's own", crashedBack.state.speed === 1.5 && effects(crashedBack).startsWith("synth rate 1.5,"));
}

console.log("step: the turn skips the conversation itself allows");
{
  const idle = initialState("synth");
  const at = (state: PanelState): string => `${readout(state, utterances).skip.back ? "back" : "-"}/${readout(state, utterances).skip.forward ? "fwd" : "-"}`;
  assert("at the top of a two-turn paste: nothing behind, the second turn ahead", at(idle) === "-/fwd");
  const onSecond = step(idle, synthAt(speakingAt(1)));
  assert("on the last turn: the turn itself is behind, nothing ahead", at(onSecond.state) === "back/-");
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
  pauses: number;
}
const standIn = (w: SpeechWindow): Synth => {
  const synth: Synth = { spoken: [], cancels: 0, pauses: 0 };
  Object.defineProperty(w, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => [],
      speak: (u: StubUtterance) => synth.spoken.push(u),
      cancel: () => {
        synth.cancels += 1;
      },
      pause: () => {
        synth.pauses += 1;
      },
      resume: () => undefined,
    },
  });
  Object.defineProperty(w, "SpeechSynthesisUtterance", { configurable: true, value: StubUtterance });
  return synth;
};

const MARKUP = `<!DOCTYPE html><body>
  <div class="speech-bar">
  <div class="speech-controls">
    <button class="speech-main speech-play" type="button" data-action="listen"><span class="speech-play-word"></span></button>
    <button class="speech-stop" type="button" disabled></button>
    <button class="speech-back" type="button" disabled></button>
    <button class="speech-forward" type="button" disabled></button>
    <button class="speech-slower" type="button" disabled></button>
    <span class="speech-speed"></span>
    <button class="speech-faster" type="button" disabled></button>
    <progress class="speech-progress" hidden></progress>
    <div class="speech-scrubber">
      <span class="speech-played"></span>
      <input class="speech-scrub" type="range" min="0" max="1" value="0" step="1" />
      <span class="speech-left"></span>
    </div>
    <p class="speech-now"></p>
  </div></div></body>`;

interface Rig {
  readonly window: SpeechWindow;
  readonly play: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly bar: HTMLProgressElement;
  // The transport, as one value: what the panel is handed, plus the elements a check reads
  // back. Built here so all four panels below share one set [LAW:one-source-of-truth].
  readonly controls: ListenControls;
  readonly seeks: () => number;
  readonly countSeek: () => void;
  readonly face: () => string;
  readonly clock: () => string;
  readonly thumb: (toMs: number) => void;
  readonly release: () => void;
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
  const controls: ListenControls = {
    bar: el(".speech-bar"),
    playWord: el(".speech-play-word"),
    play: el(".speech-play"),
    stop: el(".speech-stop"),
    back: el(".speech-back"),
    forward: el(".speech-forward"),
    slower: el(".speech-slower"),
    faster: el(".speech-faster"),
    speed: el(".speech-speed"),
    scrub: el(".speech-scrub"),
    played: el(".speech-played"),
    remaining: el(".speech-left"),
    status: el(".speech-now"),
    progress: el(".speech-progress"),
  };
  let seeks = 0;
  return {
    window,
    play: controls.play,
    stop: controls.stop,
    status: controls.status,
    bar: controls.progress,
    controls,
    seeks: () => seeks,
    countSeek: () => {
      seeks += 1;
    },
    // The scrubber as a reader moves it, in the two events a real one fires: the thumb
    // dragging, then the thumb landing.
    thumb: (toMs: number) => {
      controls.scrub.value = String(toMs);
      controls.scrub.dispatchEvent(new window.Event("input"));
    },
    release: () => {
      controls.scrub.dispatchEvent(new window.Event("change"));
    },
    face: () =>
      `${controls.play.dataset["action"]}/${controls.playWord.textContent}` +
      `${controls.play.getAttribute("aria-label") === controls.playWord.textContent ? "" : " (name differs)"}` +
      `${controls.bar.classList.contains(ENGAGED_CLASS) ? " engaged" : " collapsed"}`,
    clock: () =>
      `${controls.played.textContent} | ${controls.remaining.textContent} | ${controls.speed.textContent} | ${controls.scrub.value}/${controls.scrub.max}` +
      `${controls.back.disabled ? " -" : " back"}${controls.forward.disabled ? "-" : "fwd"}`,
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
      return at === null || at === undefined
        ? "silent"
        : `${at.utterance.anchor} ${at.segment.charStart}-${at.segment.charEnd}${at.word === null ? "" : `/${at.word.charStart}-${at.word.charEnd}`} of ${at.turn.length}`;
    },
  };
};

console.log("createListenPanel: the browser voice stands in, the neural voice takes over where it stood");
{
  const r = rig();
  const synth = standIn(r.window);
  const panel = createListenPanel({
    controls: r.controls,
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
    onSeek: () => r.countSeek(),
  });
  const line = (): string => `${r.play.textContent}${r.play.disabled ? "(off)" : ""} | stop${r.stop.disabled ? "(off)" : ""} | ${r.status.textContent}`;

  assert("mounted: the download is named, nothing spawned, Play on", line() === `Listen | stop(off) | The neural voice downloads a ${MB} model once, then runs on this device` && r.counts.spawned === 0);

  r.play.click();
  assert("click Play: the browser voice speaks passage 1 at once, and the worker is spawned", synth.spoken[0]?.text === one.text && r.counts.spawned === 1 && line() === "Pause | stop | Browser voice standing in · passage 1 of 2 · checking this device for the neural voice…");
  assert("the cursor is on the whole first utterance, its turn of one", r.where() === "t1 0-42 of 1" && r.frames.pending === 1);
  synth.spoken[0]?.onboundary?.({ name: "word", charIndex: 6 });
  r.frames.tick();
  assert("a word boundary moves the cursor on the next frame: the word inside the whole segment", r.where() === "t1 0-42/6-14 of 1");
  panel.send({ kind: "mark", to: mark(0, 21) });
  assert("a tap on the second sentence: the stand-in speaks from there, the cursor follows", synth.spoken.at(-1)?.text === "Second sentence here." && r.where() === "t1 21-42 of 1" && r.counts.spawned === 1);
  synth.spoken.at(-1)?.onboundary?.({ name: "word", charIndex: 7 });
  r.frames.tick();
  assert("a boundary in the suffix lands on the utterance's own word", r.where() === "t1 21-42/28-36 of 1");

  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 50_000_000, totalBytes: 200_000_000 } });
  assert("downloading: the bar shows beside the stand-in's line", !r.bar.hidden && r.bar.value === 50_000_000 && line() === "Pause | stop | Browser voice standing in · passage 1 of 2 · downloading the neural voice · 50 MB of 200 MB");
  synth.spoken.at(-1)?.onend?.();
  assert("the stand-in moves on to passage 2 while the download runs", synth.spoken.at(-1)?.text === two.text && line().includes("passage 2 of 2") && r.where() === "t2 0-8 of 1");
  r.play.click();
  assert("Pause mid-download pauses the stand-in; the download goes on, the loop is off", line() === "Resume | stop | Browser voice standing in · paused at passage 2 of 2 · downloading the neural voice · 50 MB of 200 MB" && r.frames.pending === 0);
  r.emit({ kind: "progress", progress: { loadedBytes: 200_000_000, totalBytes: 200_000_000 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  assert("ready: the script goes to the worker, the stand-in still paused", r.sent.at(-1)?.kind === "script" && line() === "Resume | stop | Browser voice standing in · paused at passage 2 of 2 · preparing the script…");

  const cancelsBefore = synth.cancels;
  const emittedBefore = r.positions.length;
  r.emit({ kind: "script", id: SCRIPT_ID, units });
  const device = StubDevice.instances.at(-1);
  if (device === undefined) throw new Error("the panel did not build a player");
  assert("units back: the stand-in is silenced and the neural voice takes its place PAUSED at passage 2", synth.cancels === cancelsBefore + 1 && panel.state().kind === "neural" && line() === "Resume | stop | Paused · passage 2 of 2" && r.frames.pending === 0);
  assert("the cursor stays on passage 2 across the handover: not one position emitted, none lost", r.positions.length === emittedBefore && r.where() === "t2 0-8 of 1");
  r.play.click();
  assert("Resume plays the neural voice from passage 2 and asks for its unit", r.said().endsWith("synthesize 2") && line() === "Pause | stop | Synthesizing ahead… · passage 2 of 2" && r.frames.pending === 1);
  panel.send({ kind: "mark", to: mark(0, 25) });
  assert("a tap on the first passage's second sentence: the unit in flight is cancelled, the neural voice seeks to the tapped unit and asks for it", r.said().endsWith("cancel 2,synthesize 1") && r.where() === "t1 21-42 of 1" && line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2");
  panel.send({ kind: "mark", to: mark(1) });
  assert("and back to passage 2 before the worker has let go of it: the cursor moves, the unit waits for the worker's word", r.said().endsWith("cancel 2,synthesize 1") && r.where() === "t2 0-8 of 1");
  r.emit({ kind: "cancelled", unitId: 2 });
  assert("the worker lets go: the unit is asked for again, the other cancelled", r.said().endsWith("cancel 1,synthesize 2"));
  r.emit({ kind: "cancelled", unitId: 1 });

  r.emit({ kind: "audio", unitId: 2, frameIndex: 0, pcm: frame(2, 0) });
  r.emit({ kind: "done", unitId: 2, report: report(FRAME_S * 1000), elapsedMs: 5 });
  assert("audio arrives: playing", line() === "Pause | stop | Playing · passage 2 of 2");
  device.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("the last unit ends: Ready, the cursor cleared, the loop off", line() === "Listen | stop(off) | Ready" && r.positions.at(-1) === null && r.frames.pending === 0);

  r.play.click();
  assert("Play again plays the neural voice from the top, no new download, no stand-in", r.said().endsWith("synthesize 0") && synth.spoken.length === 3 && line() === "Pause | stop | Synthesizing ahead… · passage 1 of 2" && r.where() === "t1 0-20 of 1");

  r.play.click();
  assert("Pause pauses the neural voice on stage, the loop off", line() === "Resume | stop | Paused · passage 1 of 2" && r.frames.pending === 0);
  const beforeCrash = r.positions.length;
  const spokenBefore = synth.spoken.length;
  const pausesBefore = synth.pauses;
  r.fail("boom");
  assert("the worker dies while paused: the device closed, the worker terminated, the stand-in takes passage 1 back PAUSED — one speak, then the pause", device.calls.at(-1) === "close" && r.counts.terminated === 1 && synth.spoken.length === spokenBefore + 1 && synth.spoken.at(-1)?.text === one.text && synth.pauses === pausesBefore + 1 && line() === "Resume | stop | Browser voice standing in · paused at passage 1 of 2 · the neural voice failed: boom" && r.frames.pending === 0);
  assert("the cursor is the stand-in's now, never cleared on the way", r.where() === "t1 0-42 of 1" && !r.positions.slice(beforeCrash).includes(null) && r.counts.listeners() === 0);
  r.play.click();
  assert("Resume resumes the stand-in and retries the neural voice", r.counts.spawned === 2 && line() === "Pause | stop | Browser voice standing in · passage 1 of 2 · checking this device for the neural voice…" && r.frames.pending === 1);
  r.play.click();
  assert("Pause pauses the stand-in and spawns nothing", line() === "Resume | stop | Browser voice standing in · paused at passage 1 of 2 · checking this device for the neural voice…" && r.counts.spawned === 2 && r.frames.pending === 0);
  r.play.click();
  assert("Resume again: the stand-in speaks on, the neural voice already on its way", line() === "Pause | stop | Browser voice standing in · passage 1 of 2 · checking this device for the neural voice…" && r.counts.spawned === 2);
  r.stop.click();
  assert("Stop silences the stand-in; the neural voice stays on its way", line() === "Listen | stop(off) | Checking this device for the neural voice…" && r.positions.at(-1) === null);

  panel.dispose();
  assert("dispose: the port is disposed (not terminated outright), no longer heard, the panel at the start", r.counts.disposed === 1 && r.counts.terminated === 1 && r.counts.listeners() === 0 && panel.state().kind === "provisioning" && line() === `Listen | stop(off) | The neural voice downloads a ${MB} model once, then runs on this device`);
}

console.log("createListenPanel: a bug in the machine tears the panel down, loudly");
{
  const r = rig();
  const synth = standIn(r.window);
  const panel = createListenPanel({
    controls: r.controls,
    utterances,
    voices: DEFAULT_VOICES,
    spawn: () => r.port,
    Device: StubDevice,
    frames: r.frames,
    standIn: (onState) => {
      const player = createPlayer({ window: r.window, utterances, onState });
      if (player === null) throw new Error("fixture: the stub synthesizer did not yield a player");
      return player;
    },
    onPosition: (at) => r.positions.push(at),
    onSeek: () => r.countSeek(),
  });
  const line = (): string => `${r.play.textContent}${r.play.disabled ? "(off)" : ""} | stop${r.stop.disabled ? "(off)" : ""} | ${r.status.textContent}`;
  r.play.click();
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  const cancelsBefore = synth.cancels;
  const foreign = [unit({ ...one, text: "Another page entirely." }, 0, 22), unit({ ...two }, 0, 8)];
  throws("a script that is not this page's is refused out of the dispatch", () => r.emit({ kind: "script", id: SCRIPT_ID, units: foreign }));
  const after = panel.state();
  assert("after the throw: the worker released, the stand-in silenced, the cursor cleared, the panel at its start", r.counts.disposed === 1 && r.counts.listeners() === 0 && synth.cancels === cancelsBefore + 1 && r.positions.at(-1) === null && r.frames.pending === 0 && after.kind === "provisioning" && after.neural.kind === "idle" && line() === `Listen | stop(off) | The neural voice downloads a ${MB} model once, then runs on this device`);
  r.play.click();
  assert("Play after the teardown starts over: the stand-in speaks and a worker is spawned", synth.spoken.at(-1)?.text === one.text && line() === "Pause | stop | Browser voice standing in · passage 1 of 2 · checking this device for the neural voice…");
}

console.log("createListenPanel: a teardown that fails too goes out with the bug it followed");
{
  const r = rig();
  standIn(r.window);
  let refusing = false;
  const panel = createListenPanel({
    controls: r.controls,
    utterances,
    voices: DEFAULT_VOICES,
    spawn: () => r.port,
    Device: StubDevice,
    frames: r.frames,
    standIn: (onState) => {
      const player = createPlayer({ window: r.window, utterances, onState });
      if (player === null) throw new Error("fixture: the stub synthesizer did not yield a player");
      return {
        ...player,
        send: (event) => {
          if (refusing && event.kind === "stop") throw new Error("the stand-in would not stop");
          player.send(event);
        },
      };
    },
    onPosition: (at) => r.positions.push(at),
    onSeek: () => r.countSeek(),
  });
  const line = (): string => `${r.play.textContent}${r.play.disabled ? "(off)" : ""} | stop${r.stop.disabled ? "(off)" : ""} | ${r.status.textContent}`;
  r.play.click();
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  refusing = true;
  const foreign = [unit({ ...one, text: "Another page entirely." }, 0, 22), unit({ ...two }, 0, 8)];
  let caught: unknown = null;
  try {
    r.emit({ kind: "script", id: SCRIPT_ID, units: foreign });
  } catch (error) {
    caught = error;
  }
  const errors = caught instanceof AggregateError ? caught.errors.map((e) => (e instanceof Error ? e.message : String(e))) : [];
  assert("both failures go out as one AggregateError: the bug first, the teardown second", errors.length === 2 && errors[0]?.includes("passage 0 of the script") === true && errors[1] === "the stand-in would not stop" && r.counts.disposed === 1);
  refusing = false;
  panel.dispose();
  assert("the panel is not left draining: the next event is handled and lands at the start", panel.state().kind === "provisioning" && r.counts.disposed === 1 && line() === `Listen | stop(off) | The neural voice downloads a ${MB} model once, then runs on this device`);
}

console.log("createListenPanel: no stand-in, the transport waits for the neural voice");
{
  const r = rig();
  const panel = createListenPanel({
    controls: r.controls,
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
    onSeek: () => r.countSeek(),
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
  assert("the strip stays out and the one control offers the retry", r.face() === "retry/Retry engaged");
  r.play.click();
  assert("Retry: a fresh worker is spawned and probed", r.counts.spawned === 2 && line() === "Listen(off) | stop(off) | Checking this device for the neural voice…");
  panel.dispose();
  assert("dispose: disposed, unheard, at the start", r.counts.disposed === 1 && r.counts.listeners() === 0 && line() === `Listen | stop(off) | The neural voice downloads a ${MB} model once, then runs on this device`);
}

console.log("createListenPanel: the transport — the clock, the scrubber, the skips, the speed");
{
  const r = rig();
  const synth = standIn(r.window);
  const panel = createListenPanel({
    controls: r.controls,
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
    onSeek: () => r.countSeek(),
  });

  // Nothing is measured before a unit is: the clock is every character of both passages at
  // the default rate, which is the whole paste and not a prefix of it.
  const chars = utterances.reduce((sum, u) => sum + u.text.length, 0);
  const estimatedTotal = chars * DEFAULT_MS_PER_CHAR;
  assert(
    "mounted: the scrubber spans the whole conversation, estimated, at the top, with nowhere behind to skip",
    r.clock() === `0:00 | about ${clockText(estimatedTotal)} left | 1× | 0/${estimatedTotal} -fwd`,
  );
  assert("mounted: the strip is one control that says Listen, and its name is that word", r.face() === "listen/Listen collapsed");

  r.controls.faster.click();
  r.controls.faster.click();
  assert("two steps up: the label says so and nothing has been spoken yet", r.clock().includes("| 1.5× |") && synth.spoken.length === 0);
  r.play.click();
  assert("Play speaks at the reader's speed, not at the voice's own", synth.spoken.at(-1)?.rate === 1.5);
  assert("one tap engages the voice and the whole transport comes out, the mark now a pause", r.face() === "pause/Pause engaged");

  const seeksBefore = r.seeks();
  r.controls.forward.click();
  assert(
    "Next turn seeks to the second turn: the stand-in speaks it, the page is told to follow, the thumb is at that passage's place on the clock",
    synth.spoken.at(-1)?.text === two.text && r.seeks() === seeksBefore + 1 && r.clock() === `0:03 | about 0:01 left | 1.5× | ${one.text.length * DEFAULT_MS_PER_CHAR}/${estimatedTotal} back-`,
  );
  r.controls.back.click();
  assert("Prev turn from a turn's own start goes back a turn: the first passage, from its beginning", synth.spoken.at(-1)?.text === one.text && r.clock().startsWith("0:00 |"));

  panel.send({ kind: "nudge", bySeconds: 1 });
  assert("a nudge lands inside the first passage, a second in", synth.spoken.at(-1)?.text !== one.text && r.clock().startsWith("0:01 |") && r.seeks() === seeksBefore + 3);
  panel.send({ kind: "nudge", bySeconds: 60 });
  assert("a nudge past the end clamps to the last character rather than seeking off the clock", r.clock().startsWith(`${clockText(estimatedTotal)} |`) && synth.spoken.at(-1)?.text === two.text.slice(-1));

  // The drag: the times follow the thumb, the seek waits for it to land.
  const spokenBeforeDrag = synth.spoken.length;
  const seeksBeforeDrag = r.seeks();
  r.thumb(0);
  assert("while dragging, the clock reads the thumb and nothing is seeked yet", r.clock().startsWith("0:00 |") && synth.spoken.length === spokenBeforeDrag && r.seeks() === seeksBeforeDrag);
  r.release();
  assert("letting go seeks there: the first passage from its start, and the page follows", synth.spoken.at(-1)?.text === one.text && r.seeks() === seeksBeforeDrag + 1);

  // The neural voice takes over mid-listen: the speed goes with it, and the clock sharpens
  // from a guess to a measurement as units are reported.
  r.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  r.emit({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 1 } });
  r.emit({ kind: "ready", backend: "webgpu", modelVersion: "v" });
  r.emit({ kind: "script", id: SCRIPT_ID, units });
  const device = StubDevice.instances.at(-1);
  if (device === undefined) throw new Error("the panel did not build a player");
  assert("the neural voice takes the stage where the stand-in stood, speaking", panel.state().kind === "neural" && r.play.textContent === "Pause");

  // One frame of audio per unit, reported as exactly that much: the delivery contract the
  // unit player enforces, so the clock the transport shows is the audio the player holds.
  const dur = FRAME_S * 1000;
  for (const unitId of [0, 1, 2]) {
    r.emit({ kind: "audio", unitId, frameIndex: 0, pcm: frame(unitId, 0) });
    r.emit({ kind: "done", unitId, report: report(dur), elapsedMs: 5 });
  }
  assert("every source is started at the reader's speed: it crossed the handover", device.sources.length > 0 && device.sources.every((source) => source.playbackRate.value === 1.5));
  assert(
    "with all three units measured the clock is the measured total, and says 'about' no longer",
    r.clock() === `0:00 | ${clockText(3 * dur)} left | 1.5× | 0/${Math.round(3 * dur)} -fwd`,
  );

  device.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  r.frames.tick();
  assert(
    "as the voice crosses into the second unit the thumb follows it there, on the measured clock",
    Number(r.controls.scrub.value) >= dur && Number(r.controls.scrub.value) < 2 * dur,
  );

  r.controls.slower.click();
  assert("a speed change mid-listen re-anchors at the same place: the new sources carry the new rate, the thumb does not jump", device.live().every((source) => source.playbackRate.value === 1.25) && Number(r.controls.scrub.value) >= dur);

  assert("the reader's keys are the transport's while a voice is playing", listening(panel.state()));
  r.play.click();
  assert("paused: the mark offers to resume", r.face() === "resume/Resume engaged");
  r.stop.click();
  assert("and the page's own keys again once there is nothing to pause", !listening(panel.state()) && r.clock().startsWith("0:00 |"));
  assert(
    "a reader who stops is still a listener: the transport stays out, the mark back to a play mark",
    r.face() === "listen/Listen engaged",
  );
  panel.dispose();
}

console.log(process.exitCode === 1 ? "listen-panel-check: FAILED" : "listen-panel-check: ok");
