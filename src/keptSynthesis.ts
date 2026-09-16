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
// MADE AHEAD [LAW:single-enforcer]. This port is the one arbiter of the worker's time, so what
// is worth making ahead (the scheduler's order, told through `ahead`) is made here: one unit at
// a time, only while the model is ready, nothing the listen asked for is in flight, and the
// device allows it (presynthesis.ts). The order is the scheduler's view, which does not see
// what the device came to hold after it was built — a voice changed to one kept in an earlier
// listen, a unit another tab kept — so the device is asked first, and a unit it holds is
// never made again. A unit made ahead is `filling`: its frames are gathered and kept, and
// none of its messages reach a listener, which never asked for it. Whatever the listen asks
// the worker for comes first. A request for the very unit being filled, in the same voice and
// text, takes the generation over — the frames gathered so far are handed on after the send,
// before any later frame can arrive, and the rest pass through as the worker makes them; a
// request for anything else that goes to the worker, a voice preview included, cancels the
// fill and waits for nothing — and one the device answers leaves it running, which is how a
// listen walks through what was made ahead of it. A new order without the unit being filled,
// or the device withdrawing its allowance, cancels it too. A unit the device holds, or the
// worker finishes or fails through this port, is not made ahead again — a keep the store
// refuses must not become a loop — and a cancelled one is tried again when its turn comes
// back. A device whose store cannot be read keeps nothing, so nothing is made ahead for the
// rest of the listen: a store refused for the page stays refused, and a fill that made each
// unit only to lose it would spend the GPU on nothing. Cost, stated once: a pre-empted fill
// discards what it had made.
//
// RENDERED WHOLE [LAW:single-enforcer]. A render (the paste as one file, a35.8) wants every unit
// of a rendition, and this port is where every unit's audio passes, so each is heard by the
// render the moment it is whole, whichever way it came: answered from the device, made for the
// listen, or made ahead. What none of those brings, the render makes itself on the worker's free
// time, before anything is made ahead, as a fill does — asking the device first, yielding to
// whatever the listen sends the worker, tried again once the worker is free — with two
// differences, both because the reader asked for it: the device's allowance does not gate it,
// and a store that cannot be read does not stop it; a unit it makes is kept like any other, and
// a keep the store refuses costs the render nothing. Each unit is heard once, made or failed.
//
// [LAW:no-silent-failure] A lookup that rejects breaks the cache's contract (it never rejects),
// so it is reported on the port's error channel, where the panel hears a worker's own crash.

import type { AudioCache } from "./keptAudio";
import type { Utterance } from "./speech";
import type { Allowance } from "./presynthesis";
import type { ListenPort, RenderedUnit, SynthesisPort, SynthesizeRequest as Synthesize } from "./synthesisClient";
import type { FromWorker, ToWorker } from "./synthesisProtocol";

type Script = Extract<ToWorker, { kind: "script" }>;

type Job =
  | { readonly kind: "finding"; readonly request: Synthesize; readonly started: number; cancelled: boolean; next: Synthesize | null }
  | { readonly kind: "waiting"; readonly request: Synthesize; cancelled: boolean; next: Synthesize | null }
  | { readonly kind: "making"; readonly request: Synthesize; readonly frames: Float32Array<ArrayBuffer>[]; cancelled: boolean; next: Synthesize | null }
  | {
      readonly kind: "filling";
      readonly request: Synthesize;
      readonly frames: Float32Array<ArrayBuffer>[];
      readonly words: WordMessage[];
      cancelled: boolean;
      next: Synthesize | null;
    };

type WordMessage = Extract<FromWorker, { kind: "word" }>;

export interface KeptSynthesisConfig {
  readonly worker: SynthesisPort;
  readonly cache: Pick<AudioCache, "find" | "holds" | "keep" | "recallScript" | "keepScript">;
  readonly now: () => number;
  // Whether the device lets units be made ahead of need, now and as it changes.
  readonly allowance: Allowance;
}

// The same request: what a fill is handed over on and an order is matched against.
const same = (a: Synthesize, b: Synthesize): boolean =>
  a.unitId === b.unitId && a.voice === b.voice && a.text.text === b.text.text && a.text.source === b.text.source;

// What a unit made ahead is remembered by, so it is not made again.
const tried = (request: Synthesize): string => `${request.unitId}\u0000${request.voice}\u0000${request.text.source}`;

export const withKeptAudio = ({ worker, cache, now, allowance }: KeptSynthesisConfig): ListenPort => {
  // [LAW:no-shared-mutable-globals] The units in flight, the scripts the worker is cutting,
  // what is held for the model, whether it is ready, and the listeners — owned here.
  const jobs = new Map<number, Job>();
  const cutting = new Map<number, ReadonlyArray<Utterance>>();
  const held: Script[] = [];
  let ready = false;
  // What is worth making ahead, the units the device holds or the worker has finished or failed
  // through this port — never made ahead again — whether the device is being asked about the
  // next one, whether it can keep anything at all, and the voice previews in flight.
  let order: ReadonlyArray<Synthesize> = [];
  const made = new Set<string>();
  let asking = false;
  let keeping = true;
  const previews = new Set<number>();
  // The render under way, when there is one: its requests not yet heard, in its own order, and
  // who hears each.
  let rendition: { readonly pending: Synthesize[]; readonly onUnit: (unit: RenderedUnit) => void } | null = null;
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
  // else when it says so. [LAW:single-enforcer] What the listen sends the worker is the one
  // thing a fill yields to.
  const make = (request: Synthesize, next: Synthesize | null): void => {
    withdraw(() => false);
    jobs.set(request.unitId, { kind: "making", request, frames: [], cancelled: false, next });
    worker.send(request);
  };
  const cut = (request: Script): void => {
    cutting.set(request.id, request.utterances);
    worker.send(request);
  };

  // The unit's job is over: its terminal message goes out, then the request waiting behind it
  // starts, and with nothing asked the worker's time goes to what is worth making ahead.
  const settle = (unitId: number, job: Job, terminal: FromWorker): void => {
    jobs.delete(unitId);
    emit(terminal);
    if (job.next !== null) start(job.next);
    fill();
  };

  // The worker's time is free: for a render's unit, and, when the device allows, for a unit
  // worth making ahead that still is worth it.
  const free = (): boolean => !ended && ready && jobs.size === 0 && previews.size === 0 && cutting.size === 0;
  const idle = (): boolean => free() && allowance.allowed();
  const wanted = (request: Synthesize): boolean => !made.has(tried(request)) && order.some((ordered) => same(ordered, request));
  // Whether a fill in flight is still wanted by someone: the order ahead, or the render.
  const spared = (request: Synthesize): boolean =>
    order.some((ordered) => same(ordered, request)) || (rendition?.pending.some((pending) => same(pending, request)) ?? false);

  // A unit is whole or has failed, however it came: the render hears it once, if it wants it,
  // and a render with nothing left to hear is over.
  const rendered = (request: Synthesize, unit: RenderedUnit): void => {
    const current = rendition;
    const at = current === null ? -1 : current.pending.findIndex((pending) => same(pending, request));
    if (current === null || at === -1) return;
    current.pending.splice(at, 1);
    if (current.pending.length === 0) rendition = null;
    current.onUnit(unit);
  };
  const failedUnit = (request: Synthesize, reason: Extract<FromWorker, { kind: "failed" }>["reason"]): RenderedUnit | null =>
    reason.kind === "duplicate-unit" ? null : { kind: "failed", unitId: request.unitId, reason };

  // The render's next unit, on the worker's free time: the device is asked first. A lookup that
  // rejects breaks the cache's contract and is said as every such break is, on the error channel.
  const renderNext = (current: NonNullable<typeof rendition>): void => {
    const request = current.pending[0];
    if (request === undefined) return;
    asking = true;
    cache.find(request).then(
      (kept) => {
        asking = false;
        if (ended) return;
        if (kept !== null) {
          rendered(request, { kind: "made", unitId: request.unitId, frames: kept.frames });
        } else if (free() && rendition === current && current.pending.includes(request)) {
          jobs.set(request.unitId, { kind: "filling", request, frames: [], words: [], cancelled: false, next: null });
          worker.send(request);
          return;
        }
        fill();
      },
      (error: unknown) => {
        asking = false;
        fail(`kept audio: the lookup for rendering unit ${request.unitId} failed: ${String(error)}`);
      },
    );
  };

  // The next unit worth making ahead, when the worker has nothing the listen asked for: the
  // device is asked first, and the worker's time is read again once it answers.
  const fill = (): void => {
    if (asking || !free()) return;
    if (rendition !== null) return renderNext(rendition);
    if (!keeping || !allowance.allowed()) return;
    const request = order.find((ordered) => !made.has(tried(ordered)));
    if (request === undefined) return;
    asking = true;
    cache.holds(request).then(
      (holding) => {
        asking = false;
        switch (holding) {
          case "held":
            made.add(tried(request));
            break;
          case "absent":
            // A render begun while the device was asked comes before this unit.
            if (rendition !== null || !idle() || !wanted(request)) break;
            jobs.set(request.unitId, { kind: "filling", request, frames: [], words: [], cancelled: false, next: null });
            worker.send(request);
            break;
          case "unreadable":
            // The cache has reported why. Nothing more is made ahead, and a render waiting behind
            // the answer is not stopped by it.
            keeping = false;
            break;
        }
        fill();
      },
      (error: unknown) => {
        asking = false;
        keeping = false;
        fail(`kept audio: the lookup ahead for unit ${request.unitId} failed: ${String(error)}`);
      },
    );
  };

  // The fills in flight that `keep` does not spare are cancelled: the worker answers each.
  const withdraw = (keep: (request: Synthesize) => boolean): void => {
    for (const job of jobs.values()) {
      if (job.kind !== "filling" || job.cancelled || keep(job.request)) continue;
      job.cancelled = true;
      worker.send({ kind: "cancel", unitId: job.request.unitId });
    }
  };

  // A fill's own conversation, heard by nobody else: its frames and word starts gathered, its
  // unit kept when whole, and the worker's time handed on when it is over.
  const filled = (job: Extract<Job, { kind: "filling" }>, message: FromWorker & { unitId: number }): void => {
    switch (message.kind) {
      case "audio":
        job.frames.push(message.pcm);
        return;
      case "word":
        job.words.push(message);
        return;
      case "done":
        void cache.keep(job.request, job.frames, message.report);
        made.add(tried(job.request));
        rendered(job.request, { kind: "made", unitId: message.unitId, frames: job.frames });
        break;
      case "failed": {
        made.add(tried(job.request));
        const unit = failedUnit(job.request, message.reason);
        if (unit !== null) rendered(job.request, unit);
        break;
      }
      case "cancelled":
        break;
      default:
        return;
    }
    jobs.delete(message.unitId);
    if (job.next !== null) start(job.next);
    fill();
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
        rendered(request, { kind: "made", unitId, frames: kept.frames });
        settle(unitId, job, { kind: "done", unitId, report: kept.report, elapsedMs: now() - job.started });
      },
      (error: unknown) => fail(`kept audio: the lookup for unit ${request.unitId} failed: ${String(error)}`),
    );
  };

  const synthesize = (request: Synthesize): void => {
    const job = jobs.get(request.unitId);
    if (job?.kind === "filling" && !job.cancelled && same(job.request, request)) return takeOver(job);
    if (job?.kind === "filling" && job.next === null) {
      withdraw(() => false);
      job.next = request;
      return;
    }
    if (job === undefined) return start(request);
    if (!job.cancelled || job.next !== null) {
      queueMicrotask(() => emit({ kind: "failed", unitId: request.unitId, reason: { kind: "duplicate-unit" } }));
      return;
    }
    job.next = request;
  };

  // The listen asked for the unit being made ahead: the generation becomes its request's. The
  // word starts and frames gathered so far go out after the send that asked, and before the
  // worker's next message can arrive — the starts first, so every word is known before a
  // frame of it; a cancel in between is the making job's, and they reach a unit the listen is
  // already cancelling.
  const takeOver = (job: Extract<Job, { kind: "filling" }>): void => {
    const { request, frames, words } = job;
    jobs.set(request.unitId, { kind: "making", request, frames, cancelled: false, next: null });
    const gathered = [...frames];
    const begun = [...words];
    queueMicrotask(() => {
      if (ended) return;
      begun.forEach(emit);
      gathered.forEach((pcm, frameIndex) => emit({ kind: "audio", unitId: request.unitId, frameIndex, pcm }));
    });
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
      case "filling":
        // Nothing the listen asked for is this job's until a request waits behind it.
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
    if (message.kind === "synthesize") {
      previews.add(message.unitId);
      withdraw(() => false);
    }
    worker.send(message);
  };

  const ahead = (requests: ReadonlyArray<Synthesize>): void => {
    if (ended) return;
    order = requests;
    withdraw(spared);
    fill();
  };

  const render = (requests: ReadonlyArray<Synthesize>, onUnit: (unit: RenderedUnit) => void): (() => void) => {
    if (ended) return () => undefined;
    const current = { pending: [...requests], onUnit };
    rendition = current.pending.length === 0 ? null : current;
    withdraw(spared);
    fill();
    return () => {
      if (rendition !== current) return;
      rendition = null;
      withdraw(spared);
      fill();
    };
  };

  // The model is ready: what was held for it goes to the worker, scripts first, in the order
  // each was asked; a unit cancelled while it waited has its answer already on the way.
  const readied = (): void => {
    ready = true;
    for (const request of held.splice(0)) cut(request);
    for (const job of [...jobs.values()]) if (job.kind === "waiting" && !job.cancelled) make(job.request, job.next);
    fill();
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
      emit(message);
      return fill();
    }
    if ("unitId" in message && message.unitId < 0) {
      if (message.kind !== "audio" && message.kind !== "word") previews.delete(message.unitId);
      emit(message);
      return fill();
    }
    const job = "unitId" in message ? jobs.get(message.unitId) : undefined;
    if (job?.kind === "filling" && "unitId" in message) return filled(job, message);
    if (job?.kind !== "making") return emit(message);
    switch (message.kind) {
      case "audio":
        job.frames.push(message.pcm);
        return emit(message);
      case "done":
        void cache.keep(job.request, job.frames, message.report);
        made.add(tried(job.request));
        rendered(job.request, { kind: "made", unitId: message.unitId, frames: job.frames });
        return settle(message.unitId, job, message);
      case "cancelled":
        return settle(message.unitId, job, message);
      case "failed":
        // A duplicate is about a second request, which this port never forwards: the job it
        // names is still the worker's, and the scheduler judges the message.
        if (message.reason.kind === "duplicate-unit") return emit(message);
        made.add(tried(job.request));
        rendered(job.request, { kind: "failed", unitId: message.unitId, reason: message.reason });
        return settle(message.unitId, job, message);
      default:
        return emit(message);
    }
  });
  worker.errors(fail);
  // A withdrawn allowance cancels what is made ahead, never what the render makes.
  const unheard = allowance.subscribe(() => (allowance.allowed() ? fill() : withdraw((filling) => rendition?.pending.some((pending) => same(pending, filling)) ?? false)));

  const end = (): void => {
    ended = true;
    unheard();
    order = [];
    rendition = null;
    jobs.clear();
    cutting.clear();
    held.length = 0;
  };

  return {
    send,
    ahead,
    render,
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
