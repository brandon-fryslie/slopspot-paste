// Kept synthesis: the port that answers a unit from the device when it can, driven over a stub
// worker and a stub cache through every arm of the protocol it must keep; then a real scheduler
// over it, twice over one real cache, to show a listen replayed with no synthesis at all
// (slopspot-read-along-a35.6.5zr). Run: `tsx scripts/kept-synthesis-check.ts`.
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
//   ids below zero (a preview)        -> straight to the worker and back; nothing looked up or kept
//   every other request and message   -> straight through
//   a lookup that rejects             -> said on the error channel
//   dispose                           -> the worker disposed; a lookup settling after it says nothing
//   a scheduler over it, twice        -> the second listen of a paste plays with no synthesize reaching the worker

import { createCodec } from "../src/audioCodec";
import { createAudioCache, type AudioCache, type KeptUnit, type UnitRequest } from "../src/keptAudio";
import { withKeptAudio } from "../src/keptSynthesis";
import { createScheduler } from "../src/scheduler";
import type { UnitReport } from "../src/speechManifest";
import { prepareText, type SynthesisUnit, type VoiceMap } from "../src/speechScript";
import type { SynthesisPort } from "../src/synthesisClient";
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
const synthesize = (unitId: number): ToWorker => ({ kind: "synthesize", unitId, text, voice: "alba" });

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

// The cache: each lookup waits for the case to answer it; every keep is recorded.
const stubCache = () => {
  const lookups: { request: UnitRequest; answer: (kept: KeptUnit | null) => void; reject: (error: Error) => void }[] = [];
  const kept: { request: UnitRequest; frames: ReadonlyArray<Float32Array>; report: UnitReport }[] = [];
  const cache: Pick<AudioCache, "find" | "keep"> = {
    find: (request) => new Promise((resolve, reject) => lookups.push({ request, answer: resolve, reject })),
    keep: async (request, frames, done) => {
      kept.push({ request, frames, report: done });
    },
  };
  return { cache, lookups, kept };
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

const setup = () => {
  const worker = stubWorker();
  const store = stubCache();
  const port = withKeptAudio({ worker: worker.port, cache: store.cache, now: () => 0 });
  return { worker, store, port, ear: heard(port) };
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
    utterance: { index, anchor: "t0", voice: "assistant", text: said },
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
    const scheduler = createScheduler({
      port: withKeptAudio({ worker: worker.port, cache, now: () => 0 }),
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
