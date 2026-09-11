// The synthesis worker's protocol handler, driven through load, script, synthesize, cancel,
// dispose and every failure arm with a stub runtime and a recording post — no Worker, no
// GPU, no clock (slopspot-read-along-q35.q3l). Run: `tsx scripts/synthesis-worker-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what the page would observe on the
// port: which messages arrive, in what order, carrying what, and which never arrive. The
// runtime seam is stubbed at the type synthesisHandler declares, so a different handler
// implementation of the same protocol passes unchanged.
//
// ─── ACCEPT TABLE (message × phase) ──────────────────────────────────────────
//   fresh handler                     -> capability first, nothing loaded
//   load      in idle                 -> progress…, then ready | load-failed (back to idle)
//   load      elsewhere               -> refused{phase}
//   script    in ready                -> script{units} == deriveSpeechScript under the model's tokenizer
//   synthesize in ready               -> audio×n (frameIndex 0..n-1, pcm transferred), then ONE terminal
//   synthesize duplicate in flight    -> failed{duplicate-unit}; the first is untouched
//   cancel    queued                  -> cancelled at once, zero frames
//   cancel    running                 -> cancelled between frames, generator finalised
//   cancel    finished/unknown        -> nothing
//   dispose   in ready                -> queued cancelled, running cancelled, model disposed once, then disposed
//   dispose   while loading           -> the load's signal is aborted; a late model is disposed, no ready, then disposed
//   dispose   while probing           -> the late result is discarded; disposed at once
//   anything  after dispose           -> refused{disposed}; a second dispose is silent

import { readFileSync } from "node:fs";
import { deriveDialogue, plainView } from "../src/dialogue";
import type { AssetProgress } from "../src/modelAssetLoader";
import { FRAME_MS, MODEL_ASSETS, MODEL_VERSION, type VoiceId } from "../src/modelAssets";
import { parseChatgptShare } from "../src/parsers/chatgpt-share";
import { deriveUtterances, type Utterance } from "../src/speech";
import { deriveSpeechScript, type TokenCount } from "../src/speechScript";
import {
  createSynthesisHandler,
  type GenerationEnd,
  type LoadResult,
  type LoadedModel,
  type SynthesisRuntime,
} from "../src/synthesisHandler";
import type { FromWorker, Support, ToWorker } from "../src/synthesisProtocol";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── harness ───────────────────────────────────────────────────────────────────────────

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await tick();
};

// Everything the handler posts, in order, with what it asked to transfer.
interface Posted {
  readonly message: FromWorker;
  readonly transfer: ReadonlyArray<Transferable>;
}

const mailbox = () => {
  const posted: Posted[] = [];
  const waiters: Array<{ pred: (m: FromWorker) => boolean; resolve: (m: FromWorker) => void }> = [];
  const post = (message: FromWorker, transfer: ReadonlyArray<Transferable>): void => {
    posted.push({ message, transfer });
    for (const w of waiters.splice(0)) {
      if (w.pred(message)) w.resolve(message);
      else waiters.push(w);
    }
  };
  const waitFor = <K extends FromWorker["kind"]>(
    kind: K,
    pred: (m: Extract<FromWorker, { kind: K }>) => boolean = () => true,
  ): Promise<Extract<FromWorker, { kind: K }>> => {
    const matches = (m: FromWorker): boolean => m.kind === kind && pred(m as Extract<FromWorker, { kind: K }>);
    const already = posted.find((p) => matches(p.message));
    if (already !== undefined) return Promise.resolve(already.message as Extract<FromWorker, { kind: K }>);
    return new Promise((resolve) => waiters.push({ pred: matches, resolve: (m) => resolve(m as Extract<FromWorker, { kind: K }>) }));
  };
  const of = <K extends FromWorker["kind"]>(kind: K): Array<Extract<FromWorker, { kind: K }>> =>
    posted.map((p) => p.message).filter((m): m is Extract<FromWorker, { kind: K }> => m.kind === kind);
  return { posted, post, waitFor, of };
};

const wordish: TokenCount = (text) => (text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? []).length;

// A stub model: `n` frames per unit, each a fresh Float32Array of one frame's samples
// filled with frameIndex + 1; ends as configured; can throw at a frame. Every frame is
// preceded by a real await so a cancel sent while a unit runs lands between frames.
interface StubModelConfig {
  readonly frames: number;
  readonly end: GenerationEnd;
  readonly throwAt?: number;
}

const stubModel = (config: StubModelConfig) => {
  const log = { started: [] as string[], finalised: 0, disposed: 0 };
  const model: LoadedModel = {
    backend: "webgpu",
    countTokens: wordish,
    async *generate(text: string, voice: VoiceId) {
      log.started.push(`${voice}:${text}`);
      try {
        for (let i = 0; i < config.frames; i++) {
          await tick();
          if (config.throwAt === i) throw new Error(`stub runtime blew up at frame ${i}`);
          yield new Float32Array(new ArrayBuffer(MODEL_ASSETS.frameSamples * 4)).fill(i + 1);
        }
        return config.end;
      } finally {
        log.finalised++;
      }
    },
    dispose: () => {
      log.disposed++;
    },
  };
  return { model, log };
};

// A stub runtime: a scripted probe answer and a scripted sequence of load results, each
// emitting three progress steps first. `loads` counts calls so "nothing fetched" is checkable.
const stubRuntime = (support: Support | Error, results: Array<LoadResult | Error>) => {
  const log = { loads: 0, signals: [] as AbortSignal[] };
  const runtime: SynthesisRuntime = {
    probe: async () => {
      await tick();
      if (support instanceof Error) throw support;
      return support;
    },
    load: async (onProgress: (p: AssetProgress) => void, signal: AbortSignal) => {
      log.loads++;
      log.signals.push(signal);
      const result = results.shift();
      if (result === undefined) throw new Error("stub runtime: no scripted load result left");
      for (const loadedBytes of [0, 100, 300]) {
        await tick();
        onProgress({ loadedBytes, totalBytes: 300 });
      }
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { runtime, log };
};

const clock = () => {
  let t = 0;
  return () => (t += 10);
};

const SUPPORTED: Support = { kind: "supported", backend: "webgpu" };
const EOS: GenerationEnd = { kind: "eos", alignment: { kind: "unit" } };

// A handler already brought to `ready` over the given model.
const readyHandler = async (model: LoadedModel) => {
  const box = mailbox();
  const rt = stubRuntime(SUPPORTED, [{ ok: true, model }]);
  const handler = createSynthesisHandler({ runtime: rt.runtime, post: box.post, now: clock() });
  await box.waitFor("capability");
  handler.receive({ kind: "load" });
  await box.waitFor("ready");
  return { box, handler, rt };
};

// ── 1. probe ──────────────────────────────────────────────────────────────────────────
console.log("probe:");
{
  const box = mailbox();
  const rt = stubRuntime(SUPPORTED, []);
  const handler = createSynthesisHandler({ runtime: rt.runtime, post: box.post, now: clock() });
  assert("a fresh handler is probing", handler.phase() === "probing");
  const cap = await box.waitFor("capability");
  assert("the first message is capability{supported}", box.posted[0]?.message === cap && cap.support.kind === "supported");
  assert("a supported device leaves the handler idle", handler.phase() === "idle");
  assert("the probe fetched nothing", rt.log.loads === 0);
}
{
  const box = mailbox();
  const rt = stubRuntime({ kind: "unsupported", reason: { kind: "no-webgpu" } }, []);
  const handler = createSynthesisHandler({ runtime: rt.runtime, post: box.post, now: clock() });
  const cap = await box.waitFor("capability");
  assert("an unsupported device reports its reason", cap.support.kind === "unsupported" && cap.support.reason.kind === "no-webgpu");
  assert("and the handler is unsupported", handler.phase() === "unsupported");
  handler.receive({ kind: "load" });
  await settle();
  const refused = box.of("refused");
  assert("load on an unsupported device is refused naming the phase", refused.length === 1 && refused[0]?.request.kind === "load" && refused[0]?.phase === "unsupported");
  assert("and still nothing is fetched", rt.log.loads === 0);
}
{
  const box = mailbox();
  const rt = stubRuntime(new Error("adapter exploded"), []);
  createSynthesisHandler({ runtime: rt.runtime, post: box.post, now: clock() });
  const cap = await box.waitFor("capability");
  assert(
    "a probe that throws is unsupported{no-device} carrying the message",
    cap.support.kind === "unsupported" && cap.support.reason.kind === "no-device" && cap.support.reason.message === "adapter exploded",
  );
}

// ── 2. load ───────────────────────────────────────────────────────────────────────────
console.log("load:");
{
  const box = mailbox();
  const stub = stubModel({ frames: 2, end: EOS });
  const rt = stubRuntime(SUPPORTED, [{ ok: true, model: stub.model }]);
  const handler = createSynthesisHandler({ runtime: rt.runtime, post: box.post, now: clock() });
  await box.waitFor("capability");
  handler.receive({ kind: "synthesize", unitId: 1, text: "Too early.", voice: "alba" });
  handler.receive({ kind: "script", id: 1, utterances: [] });
  handler.receive({ kind: "cancel", unitId: 1 });
  await settle();
  assert(
    "synthesize, script and cancel before load are each refused with phase idle",
    box.of("refused").map((r) => `${r.request.kind}@${r.phase}`).join(",") === "synthesize@idle,script@idle,cancel@idle",
  );
  handler.receive({ kind: "load" });
  assert("load moves to loading synchronously", handler.phase() === "loading");
  handler.receive({ kind: "load" });
  const ready = await box.waitFor("ready");
  const progress = box.of("progress").map((p) => p.progress.loadedBytes);
  assert("progress arrives in order before ready", progress.join(",") === "0,100,300" && box.posted.findIndex((p) => p.message.kind === "ready") > box.posted.findIndex((p) => p.message.kind === "progress"));
  assert("ready names the backend and the manifest's MODEL_VERSION", ready.backend === "webgpu" && ready.modelVersion === MODEL_VERSION);
  assert("a second load while loading was refused", box.of("refused").some((r) => r.request.kind === "load" && r.phase === "loading"));
  assert("one load call reached the runtime", rt.log.loads === 1 && handler.phase() === "ready");
}
{
  const box = mailbox();
  const stub = stubModel({ frames: 1, end: EOS });
  const rt = stubRuntime(SUPPORTED, [
    { ok: false, failure: { kind: "http", url: "/models/weights-x.part3", status: 404 } },
    new Error("safetensors header is garbage"),
    { ok: true, model: stub.model },
  ]);
  const handler = createSynthesisHandler({ runtime: rt.runtime, post: box.post, now: clock() });
  await box.waitFor("capability");
  handler.receive({ kind: "load" });
  const failed = await box.waitFor("load-failed");
  assert("an asset failure is reported as the loader typed it", failed.failure.kind === "http" && failed.failure.url === "/models/weights-x.part3" && failed.failure.status === 404);
  assert("and the handler is idle again", handler.phase() === "idle");
  handler.receive({ kind: "load" });
  const thrown = await box.waitFor("load-failed", (f) => f.failure.kind === "runtime");
  assert("a runtime that throws while loading is load-failed{runtime} with its message", thrown.failure.kind === "runtime" && thrown.failure.message === "safetensors header is garbage");
  handler.receive({ kind: "load" });
  await box.waitFor("ready");
  assert("the third load succeeds: load is retry-safe", handler.phase() === "ready" && rt.log.loads === 3);
}

// ── 3. synthesize ─────────────────────────────────────────────────────────────────────
console.log("synthesize:");
{
  const stub = stubModel({ frames: 4, end: EOS });
  const { box, handler } = await readyHandler(stub.model);
  handler.receive({ kind: "synthesize", unitId: 7, text: "Hello there.", voice: "marius" });
  const done = await box.waitFor("done");
  const audio = box.of("audio");
  assert("four frames arrive for the unit, frameIndex 0..3", audio.length === 4 && audio.every((a, i) => a.unitId === 7 && a.frameIndex === i));
  assert("each frame is one FRAME of samples", audio.every((a) => a.pcm.length === MODEL_ASSETS.frameSamples && a.pcm[0] === a.frameIndex + 1));
  assert(
    "each frame's buffer is in the transfer list, and nothing else is transferred",
    box.posted.every((p) => (p.message.kind === "audio" ? p.transfer.length === 1 && p.transfer[0] === p.message.pcm.buffer : p.transfer.length === 0)),
  );
  assert("done reports durationMs = frames × FRAME_MS with the runtime's alignment", done.unitId === 7 && done.report.durationMs === 4 * FRAME_MS && done.report.alignment.kind === "unit");
  assert("done carries the elapsed time off the injected clock", done.elapsedMs === 10);
  assert("the model saw the text and voice", stub.log.started.join() === "marius:Hello there.");
  assert("all frames precede done", box.posted.findIndex((p) => p.message.kind === "done") > box.posted.map((p) => p.message.kind).lastIndexOf("audio"));
  assert("exactly one terminal message for the unit", box.posted.filter((p) => ["done", "cancelled", "failed"].includes(p.message.kind)).length === 1);
  assert("the generator was finalised once", stub.log.finalised === 1);

  // The same id may be reused once its terminal message is out.
  handler.receive({ kind: "synthesize", unitId: 7, text: "Again.", voice: "marius" });
  await box.waitFor("done", (d) => d.unitId === 7 && box.of("done").length === 2);
  assert("a finished id can be reused", box.of("done").length === 2 && box.of("failed").length === 0);
}
{
  const stub = stubModel({ frames: 3, end: EOS });
  const { box, handler } = await readyHandler(stub.model);
  handler.receive({ kind: "synthesize", unitId: 1, text: "First.", voice: "alba" });
  handler.receive({ kind: "synthesize", unitId: 2, text: "Second.", voice: "javert" });
  handler.receive({ kind: "synthesize", unitId: 1, text: "First again, too soon.", voice: "alba" });
  await box.waitFor("done", (d) => d.unitId === 2);
  const order = box.posted.map((p) => p.message).filter((m) => m.kind === "audio" || m.kind === "done").map((m) => (m.kind === "audio" ? `a${m.unitId}` : `d${m.unitId}`));
  assert("one at a time, FIFO: every frame of 1 and its done precede any frame of 2", order.join(",") === "a1,a1,a1,d1,a2,a2,a2,d2");
  const dup = box.of("failed");
  assert("a duplicate in-flight id is failed{duplicate-unit} and the first request is untouched", dup.length === 1 && dup[0]?.unitId === 1 && dup[0]?.reason.kind === "duplicate-unit" && stub.log.started.length === 2);
}
{
  const stub = stubModel({ frames: 5, end: { kind: "frame-cap" } });
  const { box, handler } = await readyHandler(stub.model);
  handler.receive({ kind: "synthesize", unitId: 3, text: "Looping forever.", voice: "fantine" });
  const failed = await box.waitFor("failed");
  assert("a generation that hits the frame cap is failed{frame-cap} naming the frames streamed", failed.reason.kind === "frame-cap" && failed.reason.frames === 5 && box.of("audio").length === 5);
  assert("no done for it", box.of("done").length === 0);
}
{
  const stub = stubModel({ frames: 6, end: EOS, throwAt: 2 });
  const { box, handler } = await readyHandler(stub.model);
  handler.receive({ kind: "synthesize", unitId: 4, text: "Boom.", voice: "eponine" });
  handler.receive({ kind: "synthesize", unitId: 5, text: "Still fine.", voice: "eponine" });
  const failed = await box.waitFor("failed");
  assert("a runtime that throws mid-unit is failed{runtime} with the message, after the frames it did produce", failed.unitId === 4 && failed.reason.kind === "runtime" && failed.reason.message.includes("frame 2") && box.of("audio").filter((a) => a.unitId === 4).length === 2);
  // The stub throws at frame 2 of every unit, so the next unit fails the same way — what is
  // asserted is that the pump reached it at all.
  await box.waitFor("failed", (f) => f.unitId === 5);
  assert("the queue keeps draining after a failure", stub.log.started.length === 2 && stub.log.finalised === 2);
}

// ── 4. cancel ─────────────────────────────────────────────────────────────────────────
console.log("cancel:");
{
  const stub = stubModel({ frames: 6, end: EOS });
  const { box, handler } = await readyHandler(stub.model);
  handler.receive({ kind: "synthesize", unitId: 10, text: "Running.", voice: "alba" });
  handler.receive({ kind: "synthesize", unitId: 11, text: "Waiting.", voice: "alba" });
  handler.receive({ kind: "cancel", unitId: 11 });
  const queuedCancel = box.of("cancelled");
  assert("cancelling a queued unit answers cancelled synchronously, before any of its frames", queuedCancel.length === 1 && queuedCancel[0]?.unitId === 11);
  await box.waitFor("audio", (a) => a.unitId === 10 && a.frameIndex === 1);
  handler.receive({ kind: "cancel", unitId: 10 });
  const runningCancel = await box.waitFor("cancelled", (c) => c.unitId === 10);
  await settle();
  const frames10 = box.of("audio").filter((a) => a.unitId === 10).length;
  assert("cancelling the running unit stops it between frames", runningCancel.unitId === 10 && frames10 >= 2 && frames10 < 6);
  assert("the cancelled generator was finalised (device memory released)", stub.log.finalised === 1);
  assert("the queued unit never started", stub.log.started.length === 1 && box.of("audio").every((a) => a.unitId === 10));
  assert("no done for either", box.of("done").length === 0);
  const before = box.posted.length;
  handler.receive({ kind: "cancel", unitId: 10 });
  handler.receive({ kind: "cancel", unitId: 99 });
  await settle();
  assert("cancel of a finished or unknown unit produces nothing", box.posted.length === before);
  handler.receive({ kind: "synthesize", unitId: 12, text: "After.", voice: "alba" });
  await box.waitFor("done", (d) => d.unitId === 12);
  assert("the worker keeps working after cancels", handler.phase() === "ready");
}

// ── 5. script ─────────────────────────────────────────────────────────────────────────
console.log("script:");
{
  const gpt = parseChatgptShare(readFileSync("test/fixtures/chatgpt-share.md", "utf8"));
  assert("chatgpt-share: fixture parses", gpt !== null);
  if (gpt !== null) {
    const utterances: ReadonlyArray<Utterance> = deriveUtterances(plainView(deriveDialogue(gpt)));
    const expected = deriveSpeechScript(utterances, wordish);
    const stub = stubModel({ frames: 1, end: EOS });
    const { box, handler } = await readyHandler(stub.model);
    handler.receive({ kind: "script", id: 42, utterances });
    const script = await box.waitFor("script");
    assert("script answers with the request's id", script.id === 42);
    assert(
      `script equals deriveSpeechScript under the model's tokenizer (${expected.length} units)`,
      script.units.length === expected.length &&
        script.units.every((u, i) => u.text === expected[i]?.text && u.start === expected[i]?.start && u.end === expected[i]?.end && u.utterance.index === expected[i]?.utterance.index),
    );
    assert("the units reference the utterances handed in", script.units.every((u) => utterances.includes(u.utterance)));
  }
}

// ── 6. dispose ────────────────────────────────────────────────────────────────────────
console.log("dispose:");
{
  const stub = stubModel({ frames: 6, end: EOS });
  const { box, handler } = await readyHandler(stub.model);
  handler.receive({ kind: "synthesize", unitId: 20, text: "Running.", voice: "alba" });
  handler.receive({ kind: "synthesize", unitId: 21, text: "Queued.", voice: "alba" });
  handler.receive({ kind: "synthesize", unitId: 22, text: "Queued too.", voice: "alba" });
  await box.waitFor("audio", (a) => a.frameIndex === 1);
  handler.receive({ kind: "dispose" });
  assert("dispose is immediate for the phase", handler.phase() === "disposed");
  const queued = box.of("cancelled").map((c) => c.unitId);
  assert("queued units are cancelled at once", queued.includes(21) && queued.includes(22));
  assert("the model is not disposed while a generation is running", stub.log.disposed === 0);
  await box.waitFor("cancelled", (c) => c.unitId === 20);
  await settle();
  assert("the running unit is cancelled between frames", box.of("audio").length < 6 && stub.log.finalised === 1);
  assert("then the model is disposed exactly once", stub.log.disposed === 1);
  assert(
    "and disposed is posted once, after the running unit's terminal",
    box.of("disposed").length === 1 && box.posted.findIndex((p) => p.message.kind === "disposed") > box.posted.findIndex((p) => p.message.kind === "cancelled" && p.message.unitId === 20),
  );
  handler.receive({ kind: "synthesize", unitId: 23, text: "Too late.", voice: "alba" });
  handler.receive({ kind: "load" });
  await settle();
  assert("after dispose, synthesize and load are refused with phase disposed", box.of("refused").map((r) => `${r.request.kind}@${r.phase}`).join(",") === "synthesize@disposed,load@disposed");
  const before = box.posted.length;
  handler.receive({ kind: "dispose" });
  await settle();
  assert("a second dispose is silent", box.posted.length === before && stub.log.disposed === 1);
}
{
  const stub = stubModel({ frames: 1, end: EOS });
  const { box, handler } = await readyHandler(stub.model);
  handler.receive({ kind: "dispose" });
  assert("dispose with nothing running disposes the model at once", stub.log.disposed === 1 && handler.phase() === "disposed");
  assert("and posts disposed alone", box.of("cancelled").length === 0 && box.posted.at(-1)?.message.kind === "disposed" && box.of("disposed").length === 1);
}
{
  const box = mailbox();
  const stub = stubModel({ frames: 1, end: EOS });
  const rt = stubRuntime(SUPPORTED, [{ ok: true, model: stub.model }]);
  const handler = createSynthesisHandler({ runtime: rt.runtime, post: box.post, now: clock() });
  await box.waitFor("capability");
  handler.receive({ kind: "load" });
  handler.receive({ kind: "dispose" });
  assert("dispose mid-load aborts the load's signal at once", rt.log.signals[0]?.aborted === true);
  await settle();
  assert("a model that finishes loading into a disposed worker is disposed and never announced", stub.log.disposed === 1 && box.of("ready").length === 0 && handler.phase() === "disposed");
  assert("disposed is posted once the late model is released, after the last progress", box.of("disposed").length === 1 && box.posted.at(-1)?.message.kind === "disposed");
}
{
  const box = mailbox();
  const rt = stubRuntime(SUPPORTED, []);
  const handler = createSynthesisHandler({ runtime: rt.runtime, post: box.post, now: clock() });
  handler.receive({ kind: "dispose" });
  await settle();
  assert("dispose during the probe: no capability is posted, disposed at once, phase disposed", box.posted.map((p) => p.message.kind).join() === "disposed" && handler.phase() === "disposed");
}

// The protocol's closed set, so a new message kind cannot land without a row here.
const toKinds: ReadonlyArray<ToWorker["kind"]> = ["load", "script", "synthesize", "cancel", "dispose"];
const fromKinds: ReadonlyArray<FromWorker["kind"]> = ["capability", "progress", "ready", "load-failed", "script", "audio", "done", "cancelled", "failed", "refused", "disposed"];
assert("every protocol message kind was exercised above", toKinds.length === 5 && fromKinds.length === 11);

console.log(process.exitCode ? "\nsynthesis-worker-check: FAILED" : "\nsynthesis-worker-check: all assertions passed");
