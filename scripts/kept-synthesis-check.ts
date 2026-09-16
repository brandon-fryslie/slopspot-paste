// Kept synthesis: the port that answers a unit or a script from the device when it can, and
// holds what it cannot until the model is ready, driven over a stub worker and a stub cache
// through every arm of the protocol it must keep; then a real scheduler over it, twice over one
// real cache, to show a listen replayed with no synthesis at all, and a paste made ahead while
// the listen idles (slopspot-read-along-a35.6.5zr, slopspot-read-along-a35.6.9wx,
// slopspot-read-along-a35.6.rub). Run: `tsx scripts/kept-synthesis-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what the worker is told, what the
// port's listeners hear, in what order, and what is kept — the contract the scheduler reads.
//
// ─── ACCEPT TABLE ────────────────────────────────────────────────────────────────
//   synthesize, kept                  -> nothing to the worker; after the lookup: its frames, then done
//   synthesize, not kept              -> to the worker after the lookup; its frames and done heard; kept on done
//   the worker fails or cancels it    -> heard; nothing kept
//   cancel while looking up           -> nothing to the worker; cancelled once the lookup settles
//   cancel while the worker makes it  -> the cancel to the worker; a done that raced it is heard and kept
//   synthesize again after a cancel   -> waits for the cancelled job's terminal, then looks up
//   cancel of that waiting request    -> cancelled at once; the first job's terminal still follows
//   synthesize a unit in flight       -> failed{duplicate-unit}
//   a miss before the model is ready  -> held; sent when the worker says ready, in the order asked
//   cancel of a held miss             -> cancelled at once, nothing ever sent
//   script, kept                      -> answered from the device, ready or not; nothing to the worker
//   script, not kept                  -> to the worker once ready; its reply heard and kept
//   ids below zero (a preview)        -> straight to the worker and back; nothing looked up or kept
//   every other request and message   -> straight through
//   a lookup that rejects             -> said on the error channel
//   dispose                           -> the worker disposed; a lookup settling after it says nothing
//   a scheduler over it, twice        -> the second listen of a paste plays with no synthesize reaching the worker
//   ahead, allowed, model ready, idle -> one unit at a time to the worker; nothing heard; each kept whole
//   ahead, not allowed or not ready   -> nothing to the worker until both hold; allowance withdrawn -> the fill cancelled
//   the listen asks for the fill's unit -> the generation handed over: gathered frames heard after the send, the rest as made
//   asks for it in another voice      -> the fill cancelled; the request waits for its terminal, then looks up
//   cancel of that waiting request    -> cancelled at once; nothing looked up when the fill ends
//   asks the worker for anything else, a preview too -> the fill cancelled; the request goes on at once; the fill resumes after
//   a new order without the fill      -> the fill cancelled; with it -> left to finish
//   a unit failed or finished ahead   -> not made again; a cancelled one is, when its turn comes back
//   a scheduler over it, idle         -> every unit of the paste kept, none in the player
//   a play and a seek during the fill -> served first; the fill finishes the paste after
//   ahead of a unit the device holds  -> not made; the next is
//   a store that cannot be read       -> nothing made ahead for the rest of the listen; a rejected lookup said too
//   the listen asks for a held unit   -> answered from the device; the fill left running
//   a play over units made ahead      -> served from the device; nothing cancelled, nothing made twice

import { createCodec } from "../src/audioCodec";
import { createAudioCache, type AudioCache, type KeptUnit, type UnitRequest } from "../src/keptAudio";
import { withKeptAudio } from "../src/keptSynthesis";
import type { Allowance } from "../src/presynthesis";
import { createScheduler } from "../src/scheduler";
import type { Utterance } from "../src/speech";
import type { UnitReport } from "../src/speechManifest";
import { prepareText, type SynthesisUnit, type VoiceMap } from "../src/speechScript";
import type { SynthesisPort, SynthesizeRequest } from "../src/synthesisClient";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { MODEL_PCM, SCHEDULE_LEAD_S, createUnitPlayer, openDevice } from "../src/unitPlayer";
import { FRAME_S, StubDevice, describe, frame } from "./playbackStub";
import { memoryStore } from "./keptStoreStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── fixtures ──────────────────────────────────────────────────────────────────────────

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const report = (durationMs: number): UnitReport => ({ durationMs, alignment: { kind: "unit" } });
const text = { ...prepareText("Hello there."), source: "Hello there." };
const synthesize = (unitId: number, voice: SynthesizeRequest["voice"] = "alba"): SynthesizeRequest => ({ kind: "synthesize", unitId, text, voice });
const READY: FromWorker = { kind: "ready", backend: "webgpu", modelVersion: "v" };
const said: ReadonlyArray<Utterance> = [{ index: 0, anchor: "t0", origin: "page", voice: "user", text: "Hello there." }];
const cutUnits: ReadonlyArray<SynthesisUnit> = [{ utterance: { index: 0, anchor: "t0", origin: "page", voice: "user", text: "Hello there." }, start: 0, end: 12, ...prepareText("Hello there.") }];

// The worker: what it is told, and a hand to speak for it — or, given `answer`, a worker that
// answers each request itself.
const stubWorker = (answer: (message: ToWorker, emit: (message: FromWorker) => void) => void = () => undefined) => {
  const sent: ToWorker[] = [];
  const listeners = new Set<(message: FromWorker) => void>();
  const errorListeners = new Set<(message: string) => void>();
  const counts = { disposed: 0 };
  const port: SynthesisPort = {
    send: (message) => {
      sent.push(message);
      answer(message, emit);
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
    },
    terminate: () => undefined,
  };
  function emit(message: FromWorker): void {
    for (const listener of [...listeners]) listener(message);
  }
  const fail = (message: string): void => {
    for (const listener of [...errorListeners]) listener(message);
  };
  const said = (): string => sent.map((m) => ("unitId" in m ? `${m.kind} ${m.unitId}` : m.kind)).join();
  return { port, sent, emit, fail, said, counts };
};

// The cache: each lookup waits for the case to answer it; every keep is recorded; the device
// holds, for a fill's own question, the units the case puts in `holding` — or, told its store
// is `unreadable` or `broken`, cannot say or rejects.
const stubCache = () => {
  const lookups: { request: UnitRequest; answer: (kept: KeptUnit | null) => void; reject: (error: Error) => void }[] = [];
  const kept: { request: UnitRequest; frames: ReadonlyArray<Float32Array>; report: UnitReport }[] = [];
  const recalls: { utterances: ReadonlyArray<Utterance>; answer: (units: ReadonlyArray<SynthesisUnit> | null) => void }[] = [];
  const scripts: { utterances: ReadonlyArray<Utterance>; units: ReadonlyArray<SynthesisUnit> }[] = [];
  const holding = new Set<number>();
  const asked: number[] = [];
  const reads = { unreadable: false, broken: false };
  const cache: Pick<AudioCache, "find" | "holds" | "keep" | "recallScript" | "keepScript"> = {
    find: (request) => new Promise((resolve, reject) => lookups.push({ request, answer: resolve, reject })),
    holds: async (request) => {
      const { unitId } = request as SynthesizeRequest;
      asked.push(unitId);
      if (reads.broken) throw new Error("broken");
      return reads.unreadable ? "unreadable" : holding.has(unitId) ? "held" : "absent";
    },
    keep: async (request, frames, done) => {
      kept.push({ request, frames, report: done });
    },
    recallScript: (utterances) => new Promise((resolve) => recalls.push({ utterances, answer: resolve })),
    keepScript: async (utterances, units) => {
      scripts.push({ utterances, units });
    },
  };
  return { cache, lookups, kept, recalls, scripts, holding, asked, reads };
};

const heard = (port: SynthesisPort) => {
  const messages: FromWorker[] = [];
  const errors: string[] = [];
  port.subscribe((message) => messages.push(message));
  port.errors((message) => errors.push(message));
  const said = (): string =>
    messages
      .map((m) => (m.kind === "audio" ? `audio ${m.unitId}#${m.frameIndex}` : m.kind === "failed" ? `failed ${m.unitId} ${m.reason.kind}` : "unitId" in m ? `${m.kind} ${m.unitId}` : m.kind))
      .join();
  return { messages, errors, said };
};

// The device's word on making ahead, and a hand to change it.
const stubAllowance = (initial: boolean) => {
  let allowed = initial;
  const listeners = new Set<() => void>();
  const allowance: Allowance = {
    allowed: () => allowed,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const set = (to: boolean): void => {
    allowed = to;
    for (const listener of [...listeners]) listener();
  };
  return { allowance, set };
};

// A port over a worker whose model is ready, unless the case says it is still on its way; the
// device allows nothing made ahead unless the case says it does.
const setup = ({ ready = true, allowed = false }: { ready?: boolean; allowed?: boolean } = {}) => {
  const worker = stubWorker();
  const store = stubCache();
  const device = stubAllowance(allowed);
  const port = withKeptAudio({ worker: worker.port, cache: store.cache, now: () => 0, allowance: device.allowance });
  if (ready) worker.emit(READY);
  return { worker, store, port, device, ear: heard(port) };
};

const answer = (store: ReturnType<typeof stubCache>, index: number, kept: KeptUnit | null): void => {
  const lookup = store.lookups[index];
  if (lookup === undefined) throw new Error(`fixture: no lookup ${index}`);
  lookup.answer(kept);
};

// ── the port ──────────────────────────────────────────────────────────────────────────

console.log("a kept unit");
{
  const { worker, store, port, ear } = setup();
  port.send(synthesize(0));
  assert("asked: looked up, nothing to the worker, nothing heard yet", store.lookups.length === 1 && store.lookups[0]?.request.text === text && worker.sent.length === 0 && ear.messages.length === 0);
  answer(store, 0, { frames: [frame(0, 0), frame(0, 1)], report: report(160) });
  await flush();
  const done = ear.messages.at(-1);
  assert("kept: its frames in order, then done with its report, and still nothing to the worker", ear.said() === "audio 0#0,audio 0#1,done 0" && done?.kind === "done" && done.report.durationMs === 160 && worker.sent.length === 0);
  assert("nothing is kept again", store.kept.length === 0);
}

console.log("a unit not kept");
{
  const { worker, store, port, ear } = setup();
  port.send(synthesize(0));
  answer(store, 0, null);
  await flush();
  assert("a miss goes to the worker", worker.said() === "synthesize 0" && ear.messages.length === 0);
  const pcm = [frame(0, 0), frame(0, 1)];
  worker.emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: pcm[0] ?? frame(0, 0) });
  worker.emit({ kind: "audio", unitId: 0, frameIndex: 1, pcm: pcm[1] ?? frame(0, 1) });
  worker.emit({ kind: "done", unitId: 0, report: report(160), elapsedMs: 9 });
  assert("the worker's frames and done are heard as it says them", ear.said() === "audio 0#0,audio 0#1,done 0");
  assert("and the unit is kept: its request, the frames it made, its report", store.kept.length === 1 && store.kept[0]?.request.text === text && store.kept[0].frames[0] === pcm[0] && store.kept[0].frames[1] === pcm[1] && store.kept[0].report.durationMs === 160);

  port.send(synthesize(1));
  answer(store, 1, null);
  await flush();
  worker.emit({ kind: "audio", unitId: 1, frameIndex: 0, pcm: frame(1, 0) });
  worker.emit({ kind: "failed", unitId: 1, reason: { kind: "frame-cap", frames: 500 } });
  port.send(synthesize(2));
  answer(store, 2, null);
  await flush();
  worker.emit({ kind: "cancelled", unitId: 2 });
  assert("a failed or cancelled unit is heard and never kept", ear.said().endsWith("audio 1#0,failed 1 frame-cap,cancelled 2") && store.kept.length === 1);
}

console.log("cancels");
{
  const { worker, store, port, ear } = setup();
  port.send(synthesize(0));
  port.send({ kind: "cancel", unitId: 0 });
  assert("a cancel while looking up: nothing to the worker, nothing heard yet", worker.sent.length === 0 && ear.messages.length === 0);
  answer(store, 0, { frames: [frame(0, 0)], report: report(80) });
  await flush();
  assert("the lookup settles: cancelled, and no audio", ear.said() === "cancelled 0" && worker.sent.length === 0);

  port.send(synthesize(1));
  answer(store, 1, null);
  await flush();
  port.send({ kind: "cancel", unitId: 1 });
  assert("a cancel while the worker makes it goes to the worker", worker.said() === "synthesize 1,cancel 1");
  worker.emit({ kind: "audio", unitId: 1, frameIndex: 0, pcm: frame(1, 0) });
  worker.emit({ kind: "done", unitId: 1, report: report(80), elapsedMs: 3 });
  assert("a done that raced the cancel is heard, and kept: its audio is whole", ear.said().endsWith("audio 1#0,done 1") && store.kept.length === 1);

  port.send({ kind: "cancel", unitId: 7 });
  assert("a cancel for a unit with nothing in flight: nothing to anyone", worker.said() === "synthesize 1,cancel 1" && !ear.said().includes(" 7"));
}

console.log("again after a cancel, and twice at once");
{
  const { worker, store, port, ear } = setup();
  port.send(synthesize(0));
  port.send({ kind: "cancel", unitId: 0 });
  port.send(synthesize(0));
  assert("asked again while the cancelled lookup runs: it waits, not looked up yet", store.lookups.length === 1);
  answer(store, 0, null);
  await flush();
  assert("the cancelled job's terminal first, then the new request is looked up", ear.said() === "cancelled 0" && store.lookups.length === 2 && worker.sent.length === 0);
  answer(store, 1, null);
  await flush();
  assert("and goes its own way", worker.said() === "synthesize 0");

  port.send(synthesize(0));
  await flush();
  assert("a second request for a unit in flight is a duplicate", ear.said().endsWith("failed 0 duplicate-unit") && worker.said() === "synthesize 0");

  port.send(synthesize(3));
  port.send({ kind: "cancel", unitId: 3 });
  port.send(synthesize(3));
  port.send({ kind: "cancel", unitId: 3 });
  await flush();
  assert("a cancel of the request waiting behind a cancel: cancelled at once", ear.said().endsWith("cancelled 3") && store.lookups.length === 3);
  answer(store, 2, null);
  await flush();
  assert("and the first job's own terminal still follows, with nothing else looked up", ear.said().endsWith("cancelled 3,cancelled 3") && store.lookups.length === 3 && !worker.said().includes("3"));
}

console.log("before the model is ready");
{
  const { worker, store, port, ear } = setup({ ready: false });
  port.send(synthesize(0));
  port.send(synthesize(1));
  answer(store, 0, null);
  answer(store, 1, null);
  await flush();
  assert("misses are held: nothing to the worker, which would refuse them, and nothing heard", worker.sent.length === 0 && ear.messages.length === 0);
  port.send({ kind: "cancel", unitId: 1 });
  await flush();
  assert("a held miss cancelled: cancelled at once, still nothing to the worker", ear.said() === "cancelled 1" && worker.sent.length === 0);
  port.send(synthesize(2));
  answer(store, 2, { frames: [frame(2, 0)], report: report(80) });
  await flush();
  assert("a kept unit is answered while the model is on its way", ear.said() === "cancelled 1,audio 2#0,done 2" && worker.sent.length === 0);
  port.send(synthesize(3));
  answer(store, 3, null);
  await flush();
  worker.emit(READY);
  assert("ready: heard, and what was held goes to the worker in the order it was asked", ear.said().endsWith("done 2,ready") && worker.said() === "synthesize 0,synthesize 3");
  worker.emit({ kind: "done", unitId: 0, report: report(80), elapsedMs: 4 });
  assert("and is answered and kept as any unit the worker makes", ear.said().endsWith("ready,done 0") && store.kept.length === 1);
  port.send(synthesize(4));
  answer(store, 4, null);
  await flush();
  assert("a miss once ready goes straight to the worker", worker.said() === "synthesize 0,synthesize 3,synthesize 4");
}

console.log("scripts");
{
  const { worker, store, port, ear } = setup({ ready: false });
  port.send({ kind: "script", id: 1, utterances: said });
  assert("asked: the device is asked first, nothing to the worker", store.recalls.length === 1 && store.recalls[0]?.utterances === said && worker.sent.length === 0);
  store.recalls[0]?.answer(cutUnits);
  await flush();
  const reply = ear.messages.at(-1);
  assert("kept: answered from the device under the request's id before the model is ready, nothing to the worker", reply?.kind === "script" && reply.id === 1 && reply.units === cutUnits && worker.sent.length === 0);

  port.send({ kind: "script", id: 2, utterances: said });
  store.recalls[1]?.answer(null);
  await flush();
  assert("not kept, the model on its way: held", worker.sent.length === 0);
  worker.emit(READY);
  assert("ready: the script goes to the worker", worker.said() === "script");
  worker.emit({ kind: "script", id: 2, units: cutUnits });
  assert("the worker's cut is heard, and kept under the utterances it was cut from", ear.said().endsWith("ready,script") && store.scripts.length === 1 && store.scripts[0]?.utterances === said && store.scripts[0].units === cutUnits);
  port.send({ kind: "script", id: 3, utterances: said });
  store.recalls[2]?.answer(null);
  await flush();
  assert("not kept, the model ready: to the worker at once", worker.said() === "script,script");
}

console.log("made ahead");
{
  const { worker, store, port, ear } = setup({ allowed: true });
  port.ahead([synthesize(3), synthesize(4)]);
  assert("the device asked first, nothing to the worker inside the call", store.asked.join() === "3" && worker.said() === "");
  await flush();
  assert("not held: one unit at a time to the worker", worker.said() === "synthesize 3");
  worker.emit({ kind: "audio", unitId: 3, frameIndex: 0, pcm: frame(3, 0) });
  worker.emit({ kind: "done", unitId: 3, report: report(80), elapsedMs: 4 });
  assert("nothing of it heard: nobody asked", ear.messages.length === 0);
  await flush();
  assert("kept whole, and the next goes", store.kept.length === 1 && (store.kept[0]?.request as SynthesizeRequest | undefined)?.unitId === 3 && store.kept[0]?.frames.length === 1 && worker.said() === "synthesize 3,synthesize 4");
  worker.emit({ kind: "failed", unitId: 4, reason: { kind: "frame-cap", frames: 500 } });
  port.ahead([synthesize(3), synthesize(4)]);
  await flush();
  assert("a unit finished or failed ahead is not made again, and a failure is not heard", worker.said() === "synthesize 3,synthesize 4" && ear.messages.length === 0 && store.asked.join() === "3,4");
}
{
  const { worker, store, port } = setup({ allowed: true });
  store.holding.add(3);
  port.ahead([synthesize(3), synthesize(4)]);
  await flush();
  assert("a unit the device already holds — a voice kept in an earlier listen — is not made: the next is", store.asked.join() === "3,4" && worker.said() === "synthesize 4");
  worker.emit({ kind: "done", unitId: 4, report: report(80), elapsedMs: 4 });
  port.ahead([synthesize(3), synthesize(4)]);
  await flush();
  assert("and not asked about again", store.asked.join() === "3,4" && worker.said() === "synthesize 4");
}
{
  const { worker, store, port, ear } = setup({ allowed: true });
  store.reads.unreadable = true;
  port.ahead([synthesize(3), synthesize(4)]);
  await flush();
  store.reads.unreadable = false;
  port.ahead([synthesize(5)]);
  await flush();
  assert("a store that cannot be read: nothing made ahead, now or for the rest of the listen", store.asked.join() === "3" && worker.said() === "" && ear.errors.length === 0);
  port.send(synthesize(0));
  answer(store, 0, null);
  await flush();
  assert("the listen itself still goes to the worker", worker.said() === "synthesize 0");
}
{
  const { worker, store, port, ear } = setup({ allowed: true });
  store.reads.broken = true;
  port.ahead([synthesize(3)]);
  await flush();
  store.reads.broken = false;
  port.ahead([synthesize(5)]);
  await flush();
  assert("a lookup ahead that rejects: said on the error channel, and nothing more made ahead", ear.errors.length === 1 && ear.errors[0]?.includes("unit 3") === true && store.asked.join() === "3" && worker.said() === "");
}
{
  const { worker, store, port } = setup({ allowed: true });
  port.ahead([synthesize(3)]);
  port.ahead([synthesize(5)]);
  await flush();
  assert("the order changed while the device was asked: the unit no longer wanted is not made, the new order is", store.asked.join() === "3,5" && worker.said() === "synthesize 5");
}
{
  const { worker, store, port, ear } = setup({ allowed: true });
  port.ahead([synthesize(3)]);
  port.send(synthesize(0));
  await flush();
  assert("the listen asks while the device is asked about a fill: nothing made ahead", worker.said() === "" && store.lookups.length === 1);
  answer(store, 0, null);
  await flush();
  worker.emit({ kind: "done", unitId: 0, report: report(80), elapsedMs: 4 });
  await flush();
  assert("the listen's unit made first, the fill after it", ear.said() === "done 0" && worker.said() === "synthesize 0,synthesize 3");
}
{
  const { worker, port, device } = setup({ ready: false });
  port.ahead([synthesize(3)]);
  worker.emit(READY);
  await flush();
  assert("not allowed: nothing made ahead, even once the model is ready", worker.said() === "");
  device.set(true);
  await flush();
  assert("allowed: made ahead", worker.said() === "synthesize 3");
  device.set(false);
  assert("the allowance withdrawn: the fill cancelled", worker.said() === "synthesize 3,cancel 3");
  worker.emit({ kind: "cancelled", unitId: 3 });
  device.set(true);
  await flush();
  assert("allowed again: a cancelled unit is made again", worker.said() === "synthesize 3,cancel 3,synthesize 3");
}
{
  const { worker, port } = setup({ ready: false, allowed: true });
  port.ahead([synthesize(3)]);
  await flush();
  assert("allowed, the model not ready: nothing to the worker, which would refuse it", worker.said() === "");
  worker.emit(READY);
  await flush();
  assert("ready: made ahead", worker.said() === "synthesize 3");
}
{
  const { worker, port, device } = setup({ allowed: true });
  port.ahead([synthesize(3)]);
  device.set(false);
  await flush();
  assert("the allowance withdrawn while the device was asked: nothing made ahead", worker.said() === "");
}

console.log("the listen comes first");
{
  const { worker, store, port, ear } = setup({ allowed: true });
  port.ahead([synthesize(3), synthesize(4)]);
  await flush();
  worker.emit({ kind: "audio", unitId: 3, frameIndex: 0, pcm: frame(3, 0) });
  port.send(synthesize(3));
  assert("the fill's own unit asked for: nothing more to the worker, and nothing heard inside the send", worker.said() === "synthesize 3" && ear.messages.length === 0 && store.lookups.length === 0);
  await Promise.resolve();
  assert("the frames it had made are heard after the send", ear.said() === "audio 3#0");
  worker.emit({ kind: "audio", unitId: 3, frameIndex: 1, pcm: frame(3, 1) });
  worker.emit({ kind: "done", unitId: 3, report: report(160), elapsedMs: 4 });
  await flush();
  assert("the rest as the worker makes them; kept once, and the fill goes on", ear.said() === "audio 3#0,audio 3#1,done 3" && store.kept.length === 1 && store.kept[0]?.frames.length === 2 && worker.said() === "synthesize 3,synthesize 4");

  port.send(synthesize(1));
  assert("anything else asked for: looked up, the fill left running meanwhile", worker.said() === "synthesize 3,synthesize 4" && store.lookups.length === 1);
  answer(store, 0, { frames: [frame(1, 0)], report: report(80) });
  await flush();
  assert("the device holds it: answered, and the fill never cancelled — a listen walking through what was made ahead", ear.said().endsWith("done 3,audio 1#0,done 1") && worker.said() === "synthesize 3,synthesize 4");

  port.send(synthesize(0));
  answer(store, 1, null);
  await flush();
  assert("the device does not: the fill cancelled, the request to the worker behind the cancel", worker.said() === "synthesize 3,synthesize 4,cancel 4,synthesize 0");
  worker.emit({ kind: "cancelled", unitId: 4 });
  assert("the fill's cancel heard by nobody", ear.said().endsWith("done 1"));
  worker.emit({ kind: "done", unitId: 0, report: report(80), elapsedMs: 4 });
  await flush();
  assert("the request answered, then the cancelled fill made again", ear.said().endsWith("done 1,done 0") && worker.said().endsWith("synthesize 0,synthesize 4"));
}
{
  const { worker, store, port, ear } = setup({ allowed: true });
  port.ahead([synthesize(3)]);
  await flush();
  port.send(synthesize(3, "marius"));
  assert("the fill's unit asked for in another voice: the fill cancelled, nothing looked up yet", worker.said() === "synthesize 3,cancel 3" && store.lookups.length === 0);
  worker.emit({ kind: "audio", unitId: 3, frameIndex: 0, pcm: frame(3, 0) });
  worker.emit({ kind: "cancelled", unitId: 3 });
  assert("its terminal heard by nobody; then the request is looked up", ear.messages.length === 0 && store.lookups.length === 1 && store.lookups[0]?.request.voice === "marius");
  answer(store, 0, null);
  await flush();
  assert("and goes to the worker", worker.said() === "synthesize 3,cancel 3,synthesize 3");
}
{
  const { worker, store, port, ear } = setup({ allowed: true });
  port.ahead([synthesize(3)]);
  await flush();
  port.send(synthesize(3, "marius"));
  port.send({ kind: "cancel", unitId: 3 });
  await flush();
  assert("the request waiting behind the fill cancelled: cancelled at once", ear.said() === "cancelled 3");
  worker.emit({ kind: "cancelled", unitId: 3 });
  await flush();
  assert("the fill's own terminal heard by nobody, and nothing looked up for the cancelled request", ear.said() === "cancelled 3" && store.lookups.length === 0);
}
{
  const { worker, port, ear } = setup({ allowed: true });
  port.ahead([synthesize(3)]);
  await flush();
  port.send({ kind: "synthesize", unitId: -1, text, voice: "marius" });
  assert("a voice preview: the fill cancelled, the preview straight through", worker.said() === "synthesize 3,cancel 3,synthesize -1");
  worker.emit({ kind: "cancelled", unitId: 3 });
  assert("nothing made ahead while the preview speaks", worker.said() === "synthesize 3,cancel 3,synthesize -1");
  worker.emit({ kind: "done", unitId: -1, report: report(80), elapsedMs: 4 });
  await flush();
  assert("the preview heard; the fill resumes after it", ear.said() === "done -1" && worker.said().endsWith("synthesize -1,synthesize 3"));
}
{
  const { worker, port } = setup({ allowed: true });
  port.ahead([synthesize(3), synthesize(4)]);
  await flush();
  port.ahead([synthesize(3)]);
  await flush();
  assert("a new order with the fill in it: left to finish", worker.said() === "synthesize 3");
  port.ahead([synthesize(3, "marius")]);
  assert("a new order without it — its voice changed: cancelled", worker.said() === "synthesize 3,cancel 3");
  worker.emit({ kind: "cancelled", unitId: 3 });
  await flush();
  assert("and the new order made", worker.said() === "synthesize 3,cancel 3,synthesize 3");
  port.dispose();
  port.ahead([synthesize(5)]);
  await flush();
  assert("disposed: nothing more made", worker.said() === "synthesize 3,cancel 3,synthesize 3");
}

console.log("everything else passes through");
{
  const { worker, store, port, ear } = setup();
  port.send({ kind: "load" });
  port.send(synthesize(-1));
  port.send({ kind: "cancel", unitId: -1 });
  assert("requests pass to the worker, a preview's id included, with nothing looked up", worker.said() === "load,synthesize -1,cancel -1" && store.lookups.length === 0);
  worker.emit({ kind: "capability", support: { kind: "supported", backend: "webgpu" } });
  worker.emit({ kind: "audio", unitId: -1, frameIndex: 0, pcm: frame(0, 0) });
  worker.emit({ kind: "done", unitId: -1, report: report(80), elapsedMs: 1 });
  assert("messages pass to the listeners, a preview's phrase included, and nothing is kept", ear.said() === "capability,audio -1#0,done -1" && store.kept.length === 0);
  worker.fail("the bundle failed");
  assert("the worker's own failures pass to the error channel", ear.errors.join() === "the bundle failed");
}

console.log("a lookup that rejects, and dispose");
{
  const { worker, store, port, ear } = setup();
  port.send(synthesize(0));
  store.lookups[0]?.reject(new Error("broken"));
  await flush();
  assert("a rejected lookup is said on the error channel", ear.errors.length === 1 && ear.errors[0]?.includes("unit 0") === true);

  port.send(synthesize(1));
  port.dispose();
  answer(store, 1, { frames: [frame(1, 0)], report: report(80) });
  await flush();
  port.send(synthesize(2));
  assert("dispose: the worker disposed; the lookup that settles after says nothing; later requests go nowhere", worker.counts.disposed === 1 && ear.messages.length === 0 && store.lookups.length === 2 && worker.sent.length === 0);
}

// ── a listen, twice ───────────────────────────────────────────────────────────────────

console.log("a scheduler over it, twice over one cache: the second listen needs no synthesis");
{
  const VOICES: VoiceMap = { user: "alba", assistant: "marius", system: "javert", narrator: "fantine" };
  const unitOf = (index: number, said: string): SynthesisUnit => ({
    utterance: { index, anchor: "t0", origin: "page", voice: "assistant", text: said },
    start: 0,
    end: said.length,
    ...prepareText(said),
  });
  const script = [unitOf(0, "One."), unitOf(1, "Two."), unitOf(2, "Three.")];
  const { store } = memoryStore();
  const cache = createAudioCache({ store: Promise.resolve(store), codec: Promise.resolve(createCodec("pcm-s16", MODEL_PCM)), now: () => 0, cap: Number.MAX_SAFE_INTEGER, onFailure: () => undefined });

  const listen = async (answering: boolean) => {
    // A worker that makes each unit it is asked for, two frames long, on the next turn.
    const worker = stubWorker((message, emit) => {
      if (!answering || message.kind !== "synthesize") return;
      setImmediate(() => {
        emit({ kind: "audio", unitId: message.unitId, frameIndex: 0, pcm: frame(message.unitId, 0) });
        emit({ kind: "audio", unitId: message.unitId, frameIndex: 1, pcm: frame(message.unitId, 1) });
        emit({ kind: "done", unitId: message.unitId, report: report(2 * FRAME_S * 1000), elapsedMs: 5 });
      });
    });
    const port = withKeptAudio({ worker: worker.port, cache, now: () => 0, allowance: stubAllowance(false).allowance });
    worker.emit(READY);
    const scheduler = createScheduler({
      port,
      script,
      voices: VOICES,
      kept: await cache.restore(script, VOICES),
      player: (config) => createUnitPlayer({ ...config, device: openDevice(StubDevice) }),
      onChange: () => undefined,
    });
    scheduler.send({ kind: "play" });
    for (let i = 0; i < 20; i++) await flush();
    return { worker, scheduler };
  };

  const first = await listen(true);
  assert("the first listen synthesizes every unit", first.worker.said() === "synthesize 0,synthesize 1,synthesize 2" && first.scheduler.view().holdings.every((h) => h.kind === "held"));
  first.scheduler.dispose();
  for (let i = 0; i < 5; i++) await flush();

  const second = await listen(false);
  const view = second.scheduler.view();
  assert("the second listen is measured before it plays: every unit's record restored", view.manifest.units.every((u) => u?.durationMs === 2 * FRAME_S * 1000));
  assert("and every unit is held with no synthesize reaching the worker", second.worker.sent.length === 0 && view.holdings.every((h) => h.kind === "held"));
  const device = StubDevice.instances.at(-1);
  device?.advance(SCHEDULE_LEAD_S + 0.01);
  assert("it plays", describe(second.scheduler.view().player).startsWith("speaking/audio@0:"));
  second.scheduler.dispose();
}

console.log("a scheduler over it, made ahead: an idle listen fills the paste, and the listen is served first");
{
  const VOICES: VoiceMap = { user: "alba", assistant: "marius", system: "javert", narrator: "fantine" };
  // One turn of eight sentences, a unit each: one speech segment per unit, no gaps.
  const words = ["One.", "Two.", "Three.", "Four.", "Five.", "Six.", "Seven.", "Eight."];
  const passage = words.join(" ");
  const utterance: Utterance = { index: 0, anchor: "t0", origin: "page", voice: "assistant", text: passage };
  const script: ReadonlyArray<SynthesisUnit> = words.map((word) => {
    const start = passage.indexOf(word);
    return { utterance, start, end: start + word.length, ...prepareText(word) };
  });
  const cacheOver = () => {
    const { store } = memoryStore();
    return createAudioCache({ store: Promise.resolve(store), codec: Promise.resolve(createCodec("pcm-s16", MODEL_PCM)), now: () => 0, cap: Number.MAX_SAFE_INTEGER, onFailure: () => undefined });
  };
  // A worker as the real one queues: one generation at a time, in the order asked, a cancel
  // removing a queued or running unit; `step` makes the head of the queue, two frames long.
  const queueWorker = () => {
    const queue: number[] = [];
    const cancelled = new Set<number>();
    const stub = stubWorker((message) => {
      if (message.kind === "synthesize") queue.push(message.unitId);
      if (message.kind === "cancel" && queue.includes(message.unitId)) cancelled.add(message.unitId);
    });
    const step = (): boolean => {
      const unitId = queue.shift();
      if (unitId === undefined) return false;
      if (cancelled.delete(unitId)) {
        stub.emit({ kind: "cancelled", unitId });
        return true;
      }
      stub.emit({ kind: "audio", unitId, frameIndex: 0, pcm: frame(unitId, 0) });
      stub.emit({ kind: "audio", unitId, frameIndex: 1, pcm: frame(unitId, 1) });
      stub.emit({ kind: "done", unitId, report: report(2 * FRAME_S * 1000), elapsedMs: 5 });
      return true;
    };
    return { ...stub, step };
  };
  const settleAll = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await flush();
  };
  const listenOver = (cache: AudioCache) => {
    const worker = queueWorker();
    const port = withKeptAudio({ worker: worker.port, cache, now: () => 0, allowance: stubAllowance(true).allowance });
    worker.emit(READY);
    const scheduler = createScheduler({
      port,
      script,
      voices: VOICES,
      kept: script.map(() => undefined),
      player: (config) => createUnitPlayer({ ...config, device: openDevice(StubDevice) }),
      onChange: () => undefined,
    });
    return { worker, scheduler };
  };
  const keptCount = async (cache: AudioCache): Promise<number> => (await cache.restore(script, VOICES)).filter((kept) => kept !== undefined).length;

  {
    const cache = cacheOver();
    const { worker, scheduler } = listenOver(cache);
    await settleAll();
    while (worker.step()) await settleAll();
    await settleAll();
    assert("idle: every unit made ahead, from the top, one at a time", worker.said() === script.map((_, i) => `synthesize ${i}`).join());
    assert("every unit of the paste kept on the device", (await keptCount(cache)) === script.length);
    assert("and none of it in the player", scheduler.view().holdings.every((holding) => holding.kind === "absent"));
    scheduler.dispose();
  }
  {
    const cache = cacheOver();
    const { worker, scheduler } = listenOver(cache);
    await settleAll();
    assert("idle: the fill starts at the top", worker.said() === "synthesize 0");
    scheduler.send({ kind: "play" });
    await settleAll();
    assert("Play asks for the unit being filled: the generation is handed over, nothing more asked", worker.said() === "synthesize 0");
    for (let i = 0; i < 4; i++) {
      worker.step();
      await settleAll();
    }
    const beforeSeek = worker.said();
    assert("the window made for the listen, then the fill goes on past it", beforeSeek === "synthesize 0,synthesize 1,synthesize 2,synthesize 3,synthesize 4" && scheduler.view().holdings.slice(0, 4).every((holding) => holding.kind === "held"));
    scheduler.send({ kind: "seek", to: { segment: 6, offsetMs: 0 } });
    await settleAll();
    assert("a seek during the fill: the fill cancelled, the seek's unit asked for behind it", worker.said() === `${beforeSeek},cancel 4,synthesize 6`);
    worker.step();
    await settleAll();
    worker.step();
    await settleAll();
    assert("the seek's unit made before anything ahead", scheduler.view().holdings[6]?.kind === "held" && (await keptCount(cache)) === 5);
    while (worker.step()) await settleAll();
    await settleAll();
    assert("and the fill finishes the paste after", (await keptCount(cache)) === script.length);
    scheduler.dispose();
  }
  {
    const cache = cacheOver();
    const { worker, scheduler } = listenOver(cache);
    await settleAll();
    for (let i = 0; i < 5; i++) {
      worker.step();
      await settleAll();
    }
    const made = script.slice(0, 6).map((_, i) => `synthesize ${i}`).join();
    assert("idle: five units made ahead, the sixth in flight", worker.said() === made);
    scheduler.send({ kind: "play" });
    await settleAll();
    assert("Play over what was made ahead: the window served from the device, the fill in flight left running", worker.said() === made && scheduler.view().holdings.slice(0, 4).every((holding) => holding.kind === "held"));
    while (worker.step()) await settleAll();
    await settleAll();
    assert("and the paste finished with nothing cancelled and nothing made twice", worker.said() === script.map((_, i) => `synthesize ${i}`).join() && (await keptCount(cache)) === script.length);
    scheduler.dispose();
  }
}
