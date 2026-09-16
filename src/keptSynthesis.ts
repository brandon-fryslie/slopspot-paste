// [LAW:decomposition] Kept synthesis: a synthesis port that answers a request from the
// device's kept audio when it can and from the worker when it cannot, and keeps what the
// worker makes. One sentence, no "and" hiding a second job: this module decides which of the
// two a request goes to, and when. What is kept and for how long is keptAudio.ts's, what to
// request and when is the panel's and the scheduler's, and the protocol it speaks is
// synthesisProtocol.ts's.
//
// THE SAME PORT [LAW:composability]. It is a SynthesisPort over a SynthesisPort, speaking the
// protocol's contract unchanged, so the scheduler, the panel and the voice preview are driven
// by it exactly as by the worker, and none of them knows an answer came from the device. A
// kept answer comes after the lookup settles — never inside the `send` that asked, as a
// worker's answer never is. Every other request and every other message passes straight
// through, and so does every request with an id below zero: a voice preview's phrase is not
// a unit of the paste, and nothing is kept of it.
//
// TWO REQUESTS ARE KEPT: a paste's script — the units the worker cuts from its utterances —
// and a unit's audio. Either is answered from the device when it holds it, and otherwise goes
// to the worker, whose answer is kept on its way past.
//
// THE MODEL'S OWN TIME [LAW:no-ambient-temporal-coupling]. The worker can cut a script or make
// a unit only once its model is ready, and refuses both before; the device can answer either
// at any moment. So a request the device cannot answer is held here until the worker says
// `ready`, then sent — in the order it was asked — and a listen whose script and units are
// kept never waits on the model at all. A held request is the worker's to answer from the
// moment it is sent, and a model that never becomes ready leaves it held: the panel says
// why, from the worker's own messages.
//
// ONE JOB PER UNIT [LAW:types-are-the-program]. A request is `finding` while its lookup runs,
// `waiting` while it is held for the model, and `making` once it has gone to the worker, whose
// frames are gathered until its terminal message. The protocol's contracts hold across all
// three: a cancel of a finding request is its `cancelled` when the lookup settles; of a
// waiting one, at once; of a making one it goes to the worker, which answers it. A second
// request for a unit in flight is `failed{duplicate-unit}`; a request after a cancel for the
// same unit waits for the cancelled one's terminal message. A unit the worker finishes is
// kept whether or not its request was cancelled meanwhile — its audio is whole — and a unit
// that failed or was cancelled is not.
//
// [LAW:no-silent-failure] A lookup that rejects breaks the cache's contract (it never rejects),
// so it is reported on the port's error channel, where the panel hears a worker's own crash.

import type { AudioCache } from "./keptAudio";
import type { Utterance } from "./speech";
import type { SynthesisPort } from "./synthesisClient";
import type { FromWorker, ToWorker } from "./synthesisProtocol";

type Synthesize = Extract<ToWorker, { kind: "synthesize" }>;
type Script = Extract<ToWorker, { kind: "script" }>;

type Job =
  | { readonly kind: "finding"; readonly request: Synthesize; readonly started: number; cancelled: boolean; next: Synthesize | null }
  | { readonly kind: "waiting"; readonly request: Synthesize; cancelled: boolean; next: Synthesize | null }
  | { readonly kind: "making"; readonly request: Synthesize; readonly frames: Float32Array<ArrayBuffer>[]; cancelled: boolean; next: Synthesize | null };

export interface KeptSynthesisConfig {
  readonly worker: SynthesisPort;
  readonly cache: Pick<AudioCache, "find" | "keep" | "recallScript" | "keepScript">;
  readonly now: () => number;
}

export const withKeptAudio = ({ worker, cache, now }: KeptSynthesisConfig): SynthesisPort => {
  // [LAW:no-shared-mutable-globals] The units in flight, the scripts the worker is cutting,
  // what is held for the model, whether it is ready, and the listeners — owned here.
  const jobs = new Map<number, Job>();
  const cutting = new Map<number, ReadonlyArray<Utterance>>();
  const held: Script[] = [];
  let ready = false;
  const listeners = new Set<(message: FromWorker) => void>();
  const errorListeners = new Set<(message: string) => void>();
  let ended = false;

  const emit = (message: FromWorker): void => {
    for (const listener of [...listeners]) listener(message);
  };
  const fail = (message: string): void => {
    for (const listener of [...errorListeners]) listener(message);
  };

  // A request the device could not answer goes to the worker: now, when its model is ready,
  // else when it says so.
  const make = (request: Synthesize, next: Synthesize | null): void => {
    jobs.set(request.unitId, { kind: "making", request, frames: [], cancelled: false, next });
    worker.send(request);
  };
  const cut = (request: Script): void => {
    cutting.set(request.id, request.utterances);
    worker.send(request);
  };

  // The unit's job is over: its terminal message goes out, then the request waiting behind it
  // starts.
  const settle = (unitId: number, job: Job, terminal: FromWorker): void => {
    jobs.delete(unitId);
    emit(terminal);
    if (job.next !== null) start(job.next);
  };

  const start = (request: Synthesize): void => {
    const job: Job = { kind: "finding", request, started: now(), cancelled: false, next: null };
    jobs.set(request.unitId, job);
    cache.find(request).then(
      (kept) => {
        if (ended || jobs.get(request.unitId) !== job) return;
        const { unitId } = request;
        if (job.cancelled) return settle(unitId, job, { kind: "cancelled", unitId });
        if (kept === null) {
          if (ready) return make(request, job.next);
          jobs.set(unitId, { kind: "waiting", request, cancelled: false, next: job.next });
          return;
        }
        kept.frames.forEach((pcm, frameIndex) => emit({ kind: "audio", unitId, frameIndex, pcm }));
        settle(unitId, job, { kind: "done", unitId, report: kept.report, elapsedMs: now() - job.started });
      },
      (error: unknown) => fail(`kept audio: the lookup for unit ${request.unitId} failed: ${String(error)}`),
    );
  };

  const synthesize = (request: Synthesize): void => {
    const job = jobs.get(request.unitId);
    if (job === undefined) return start(request);
    if (!job.cancelled || job.next !== null) {
      queueMicrotask(() => emit({ kind: "failed", unitId: request.unitId, reason: { kind: "duplicate-unit" } }));
      return;
    }
    job.next = request;
  };

  const cancel = (message: Extract<ToWorker, { kind: "cancel" }>): void => {
    const job = jobs.get(message.unitId);
    if (job === undefined) return;
    if (job.next !== null) {
      job.next = null;
      queueMicrotask(() => emit({ kind: "cancelled", unitId: message.unitId }));
      return;
    }
    job.cancelled = true;
    switch (job.kind) {
      case "finding":
        return;
      case "waiting":
        // Nothing was sent: the cancel is answered here, after the send that asked.
        queueMicrotask(() => {
          if (!ended && jobs.get(message.unitId) === job) settle(message.unitId, job, { kind: "cancelled", unitId: message.unitId });
        });
        return;
      case "making":
        worker.send(message);
        return;
    }
  };

  const script = (request: Script): void => {
    cache.recallScript(request.utterances).then(
      (units) => {
        if (ended) return;
        if (units !== null) return emit({ kind: "script", id: request.id, units });
        if (ready) return cut(request);
        held.push(request);
      },
      (error: unknown) => fail(`kept audio: the lookup for script ${request.id} failed: ${String(error)}`),
    );
  };

  const send = (message: ToWorker): void => {
    if (ended) return;
    if (message.kind === "synthesize" && message.unitId >= 0) return synthesize(message);
    if (message.kind === "cancel" && message.unitId >= 0) return cancel(message);
    if (message.kind === "script") return script(message);
    worker.send(message);
  };

  // The model is ready: what was held for it goes to the worker, scripts first, in the order
  // each was asked; a unit cancelled while it waited has its answer already on the way.
  const readied = (): void => {
    ready = true;
    for (const request of held.splice(0)) cut(request);
    for (const job of [...jobs.values()]) if (job.kind === "waiting" && !job.cancelled) make(job.request, job.next);
  };

  // What the worker says about a unit it is making is gathered on the way past: frames kept
  // until the terminal message, and the unit kept when that message is `done`. A script it cut
  // is kept the same way.
  worker.subscribe((message) => {
    if (message.kind === "ready") {
      emit(message);
      return readied();
    }
    if (message.kind === "script") {
      const utterances = cutting.get(message.id);
      cutting.delete(message.id);
      if (utterances !== undefined) void cache.keepScript(utterances, message.units);
      return emit(message);
    }
    const job = "unitId" in message && message.unitId >= 0 ? jobs.get(message.unitId) : undefined;
    if (job?.kind !== "making") return emit(message);
    switch (message.kind) {
      case "audio":
        job.frames.push(message.pcm);
        return emit(message);
      case "done":
        void cache.keep(job.request, job.frames, message.report);
        return settle(message.unitId, job, message);
      case "cancelled":
        return settle(message.unitId, job, message);
      case "failed":
        // A duplicate is about a second request, which this port never forwards: the job it
        // names is still the worker's, and the scheduler judges the message.
        return message.reason.kind === "duplicate-unit" ? emit(message) : settle(message.unitId, job, message);
      default:
        return emit(message);
    }
  });
  worker.errors(fail);

  const end = (): void => {
    ended = true;
    jobs.clear();
    cutting.clear();
    held.length = 0;
  };

  return {
    send,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    errors: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    dispose: () => {
      end();
      worker.dispose();
    },
    terminate: () => {
      end();
      worker.terminate();
    },
  };
};
