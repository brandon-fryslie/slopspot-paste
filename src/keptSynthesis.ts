// [LAW:decomposition] Kept synthesis: a synthesis port that answers a request from the
// device's kept audio when it can and from the worker when it cannot, and keeps what the
// worker makes. One sentence, no "and" hiding a second job: this module decides which of the
// two a request goes to. What is kept and for how long is keptAudio.ts's, what to request and
// when is the scheduler's, and the protocol it speaks is synthesisProtocol.ts's.
//
// THE SAME PORT [LAW:composability]. It is a SynthesisPort over a SynthesisPort, speaking the
// protocol's contract unchanged, so the scheduler, the panel and the voice preview are driven
// by it exactly as by the worker, and none of them knows a unit came from the device. A kept
// unit answers with its frames and `done`, in order, after the lookup settles — never inside
// the `send` that asked, as a worker's answer never is. Every other request and every other
// message passes straight through, and so does every request with an id below zero: a voice
// preview's phrase is not a unit of the paste, and nothing is kept of it.
//
// ONE JOB PER UNIT [LAW:types-are-the-program]. A request is `finding` while its lookup runs
// and `making` once it has gone to the worker, whose frames are gathered until its terminal
// message. The protocol's contracts hold across both: a cancel of a finding request is its
// `cancelled` when the lookup settles; a cancel of a making one goes to the worker, which
// answers it; a second request for a unit in flight is `failed{duplicate-unit}`; a request
// after a cancel for the same unit waits for the cancelled one's terminal message. A unit
// the worker finishes is kept whether or not its request was cancelled meanwhile — its audio
// is whole — and a unit that failed or was cancelled is not.
//
// [LAW:no-silent-failure] A lookup that rejects breaks the cache's contract (it never rejects),
// so it is reported on the port's error channel, where the panel hears a worker's own crash.

import type { AudioCache } from "./keptAudio";
import type { SynthesisPort } from "./synthesisClient";
import type { FromWorker, ToWorker } from "./synthesisProtocol";

type Synthesize = Extract<ToWorker, { kind: "synthesize" }>;

type Job =
  | { readonly kind: "finding"; readonly request: Synthesize; readonly started: number; cancelled: boolean; next: Synthesize | null }
  | { readonly kind: "making"; readonly request: Synthesize; readonly frames: Float32Array<ArrayBuffer>[]; cancelled: boolean; next: Synthesize | null };

export interface KeptSynthesisConfig {
  readonly worker: SynthesisPort;
  readonly cache: Pick<AudioCache, "find" | "keep">;
  readonly now: () => number;
}

export const withKeptAudio = ({ worker, cache, now }: KeptSynthesisConfig): SynthesisPort => {
  // [LAW:no-shared-mutable-globals] The units in flight and the listeners, owned here.
  const jobs = new Map<number, Job>();
  const listeners = new Set<(message: FromWorker) => void>();
  const errorListeners = new Set<(message: string) => void>();
  let ended = false;

  const emit = (message: FromWorker): void => {
    for (const listener of [...listeners]) listener(message);
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
          jobs.set(unitId, { kind: "making", request, frames: [], cancelled: false, next: job.next });
          worker.send(request);
          return;
        }
        kept.frames.forEach((pcm, frameIndex) => emit({ kind: "audio", unitId, frameIndex, pcm }));
        settle(unitId, job, { kind: "done", unitId, report: kept.report, elapsedMs: now() - job.started });
      },
      (error: unknown) => {
        for (const listener of [...errorListeners]) listener(`kept audio: the lookup for unit ${request.unitId} failed: ${String(error)}`);
      },
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
    if (job.kind === "making") worker.send(message);
  };

  const send = (message: ToWorker): void => {
    if (ended) return;
    if (message.kind === "synthesize" && message.unitId >= 0) return synthesize(message);
    if (message.kind === "cancel" && message.unitId >= 0) return cancel(message);
    worker.send(message);
  };

  // What the worker says about a unit it is making is gathered on the way past: frames kept
  // until the terminal message, and the unit kept when that message is `done`.
  worker.subscribe((message) => {
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
  worker.errors((message) => {
    for (const listener of [...errorListeners]) listener(message);
  });

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
      ended = true;
      jobs.clear();
      worker.dispose();
    },
    terminate: () => {
      ended = true;
      jobs.clear();
      worker.terminate();
    },
  };
};
