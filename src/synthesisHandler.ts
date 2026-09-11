// [LAW:decomposition] The worker side of the synthesis protocol: it turns the page's
// requests into calls on a runtime and the runtime's results into messages back. One
// sentence, no "and" hiding a second job — it does not run the model (SynthesisRuntime
// does, behind the seam below), it does not touch a Worker global (synthesisWorker.ts
// binds it to one), it decides no text (speechScript) and it plays nothing. Every effect
// it needs — the runtime, the post, the clock — is a parameter, so scripts/synthesis-
// worker-check.ts drives every arm of the protocol with a stub runtime and no Worker at
// all [LAW:effects-at-boundaries] [LAW:verifiable-goals].
//
// WHY A PHASE UNION. The worker's life is a line: probing → unsupported | idle → loading →
// ready → disposed, with loading able to fall back to idle so a failed download can be
// retried. Each phase carries exactly the data that exists in it — the model and the
// synthesis queue exist only in `ready` — so "synthesize while there is no model" is not a
// state to guard against but a message the phase cannot accept, answered with `refused`
// [LAW:types-are-the-program] [LAW:no-silent-failure].
//
// WHY ONE GENERATION AT A TIME, QUEUED HERE. The GPU is one device and the model streams
// one unit's frames in order; interleaving two would serialize on the device anyway and
// scramble the frame order the unit player relies on. The queue lives beside the model in
// the phase that owns both, so a cancel can remove a waiting request or stop the running
// one BETWEEN frames — the loop below checks the flag before it asks the runtime for the
// next frame, never after the unit [LAW:no-ambient-temporal-coupling].
//
// WHY COMPLETIONS RE-READ THE PHASE. `probe`, `load` and a generation are awaited; a
// `dispose` may arrive while any of them is in flight. Each completion reads the phase it
// lands in rather than the one it left, so a model that finishes loading into a disposed
// worker is disposed at once and a generation cut short by dispose releases the model
// only after the device is quiet — the phase value is the one owner of that ordering.

import type { AssetProgress } from "./modelAssetLoader";
import { FRAME_MS, MODEL_VERSION, type VoiceId } from "./modelAssets";
import type { ReportedAlignment } from "./speechManifest";
import { deriveSpeechScript, type TokenCount } from "./speechScript";
import type {
  Backend,
  FromWorker,
  LoadFailure,
  Phase,
  Support,
  ToWorker,
  UnsupportedReason,
} from "./synthesisProtocol";

// ── the runtime seam ────────────────────────────────────────────────────────────────

// How one unit's generation ended. `eos` is the model's own end-of-speech signal and
// carries whatever alignment the runtime measured (`unit` until the attention read-out of
// q35.v70 lands); `frame-cap` is the loop's bound, reached without EOS.
export type GenerationEnd =
  | { readonly kind: "eos"; readonly alignment: ReportedAlignment }
  | { readonly kind: "frame-cap" }
  // Only ever the value the handler hands to `return()` when it stops a generation early;
  // a runtime never produces it.
  | { readonly kind: "cancelled" };

// A loaded model: the two things the protocol asks of it. `generate` yields one decoded
// frame of FRAME_MS PCM per step and returns how it ended; it must release device memory
// in a `finally`, because the handler ends it early through `return()` on cancel.
export interface LoadedModel {
  readonly backend: Backend;
  readonly countTokens: TokenCount;
  generate(text: string, voice: VoiceId): AsyncGenerator<Float32Array<ArrayBuffer>, GenerationEnd>;
  dispose(): void;
}

export type LoadResult =
  | { readonly ok: true; readonly model: LoadedModel }
  | { readonly ok: false; readonly failure: LoadFailure };

// [LAW:types-are-the-program] The exact surface of "the runtime the spike chose" that the
// protocol needs: whether this device can run it, decided without fetching a byte, and a
// load that reports progress and ends in a model or a typed failure. `signal` is the
// handler's dispose reaching the download: an aborted load ends in a failure, not a model.
export interface SynthesisRuntime {
  probe(): Promise<Support>;
  load(onProgress: (progress: AssetProgress) => void, signal: AbortSignal): Promise<LoadResult>;
}

// The worker's outbound edge. `transfer` names buffers to move rather than copy — every
// audio frame's — so the page receives PCM without a second 7.7 KB allocation per 80 ms.
export type Post = (message: FromWorker, transfer: ReadonlyArray<Transferable>) => void;

export interface HandlerConfig {
  readonly runtime: SynthesisRuntime;
  readonly post: Post;
  readonly now: () => number;
}

export interface SynthesisHandler {
  readonly receive: (message: ToWorker) => void;
  readonly phase: () => Phase;
}

// ── state ───────────────────────────────────────────────────────────────────────────

interface Job {
  readonly unitId: number;
  readonly text: string;
  readonly voice: VoiceId;
  cancelled: boolean;
}

interface Ready {
  readonly kind: "ready";
  readonly model: LoadedModel;
  readonly queue: Job[];
  running: Job | null;
}

type State =
  | { readonly kind: "probing" }
  | { readonly kind: "unsupported"; readonly reason: UnsupportedReason }
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly abort: AbortController }
  | Ready
  | { readonly kind: "disposed" };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── the handler ─────────────────────────────────────────────────────────────────────

// A fresh handler probes at once: its first message is `capability`, per the protocol's
// contract, and nothing is fetched until `load`.
export const createSynthesisHandler = ({ runtime, post, now }: HandlerConfig): SynthesisHandler => {
  let state: State = { kind: "probing" };

  const refuse = (request: ToWorker): void => post({ kind: "refused", request, phase: state.kind }, []);

  // ── probe ──
  const probe = async (): Promise<void> => {
    let support: Support;
    try {
      support = await runtime.probe();
    } catch (e) {
      support = { kind: "unsupported", reason: { kind: "no-device", message: message(e) } };
    }
    if (state.kind !== "probing") return;
    state = support.kind === "supported" ? { kind: "idle" } : { kind: "unsupported", reason: support.reason };
    post({ kind: "capability", support }, []);
  };

  // ── load ──
  const load = async (): Promise<void> => {
    const abort = new AbortController();
    state = { kind: "loading", abort };
    let result: LoadResult;
    try {
      result = await runtime.load((progress) => post({ kind: "progress", progress }, []), abort.signal);
    } catch (e) {
      result = { ok: false, failure: { kind: "runtime", message: message(e) } };
    }
    if (state.kind !== "loading") {
      // Disposed mid-download: the abort ends the download as a failure, and a model that
      // arrived anyway is released, not kept alive by a worker nobody is listening to.
      if (result.ok) result.model.dispose();
      return;
    }
    if (result.ok) {
      state = { kind: "ready", model: result.model, queue: [], running: null };
      post({ kind: "ready", backend: result.model.backend, modelVersion: MODEL_VERSION }, []);
    } else {
      state = { kind: "idle" };
      post({ kind: "load-failed", failure: result.failure }, []);
    }
  };

  // ── synthesis ──

  // One unit, frame by frame, to its terminal message. The cancel flag is read before each
  // request for a frame, so a cancel lands between frames; the frame already decoded when
  // it arrived is still posted, because it was already generated.
  const run = async (model: LoadedModel, job: Job): Promise<FromWorker> => {
    const { unitId } = job;
    const started = now();
    const generation = model.generate(job.text, job.voice);
    let frames = 0;
    try {
      for (;;) {
        if (job.cancelled) {
          await generation.return({ kind: "cancelled" });
          return { kind: "cancelled", unitId };
        }
        const step = await generation.next();
        if (step.done) {
          const end = step.value;
          switch (end.kind) {
            case "eos":
              return {
                kind: "done",
                unitId,
                report: { durationMs: frames * FRAME_MS, alignment: end.alignment },
                elapsedMs: now() - started,
              };
            case "frame-cap":
              return { kind: "failed", unitId, reason: { kind: "frame-cap", frames } };
            case "cancelled":
              return { kind: "cancelled", unitId };
          }
        }
        post({ kind: "audio", unitId, frameIndex: frames, pcm: step.value }, [step.value.buffer]);
        frames++;
      }
    } catch (e) {
      return { kind: "failed", unitId, reason: { kind: "runtime", message: message(e) } };
    }
  };

  // Drains the queue one job at a time. Started when a job is queued into an idle model
  // and by nothing else; it stops when the queue is empty or the worker was disposed, and
  // in the latter case it is the one that releases the model, because only it knows the
  // device has finished the last frame.
  const pump = async (ready: Ready): Promise<void> => {
    for (;;) {
      const job = ready.queue.shift();
      if (job === undefined) {
        ready.running = null;
        break;
      }
      ready.running = job;
      const terminal = await run(ready.model, job);
      post(terminal, []);
      if (state.kind === "disposed") break;
    }
    if (state.kind === "disposed") ready.model.dispose();
  };

  const synthesize = (ready: Ready, request: Extract<ToWorker, { kind: "synthesize" }>): void => {
    const inFlight = (job: Job): boolean => job.unitId === request.unitId && !job.cancelled;
    if ((ready.running !== null && inFlight(ready.running)) || ready.queue.some(inFlight)) {
      post({ kind: "failed", unitId: request.unitId, reason: { kind: "duplicate-unit" } }, []);
      return;
    }
    const job: Job = { unitId: request.unitId, text: request.text, voice: request.voice, cancelled: false };
    ready.queue.push(job);
    if (ready.running === null) {
      // Claimed synchronously so a second request in the same tick queues behind this one
      // rather than starting a second pump.
      ready.running = job;
      void pump(ready);
    }
  };

  const cancel = (ready: Ready, unitId: number): void => {
    const waiting = ready.queue.findIndex((job) => job.unitId === unitId);
    if (waiting !== -1) {
      ready.queue.splice(waiting, 1);
      post({ kind: "cancelled", unitId }, []);
      return;
    }
    if (ready.running !== null && ready.running.unitId === unitId) ready.running.cancelled = true;
    // Otherwise the unit already has its terminal message: nothing to do, by contract.
  };

  const dispose = (): void => {
    const before = state;
    state = { kind: "disposed" };
    switch (before.kind) {
      case "loading":
        before.abort.abort();
        return;
      case "ready":
        for (const job of before.queue.splice(0)) post({ kind: "cancelled", unitId: job.unitId }, []);
        if (before.running === null) {
          before.model.dispose();
        } else {
          // The pump releases the model once the running generation has stopped.
          before.running.cancelled = true;
        }
        return;
      case "probing":
      case "unsupported":
      case "idle":
      case "disposed":
        return;
    }
  };

  // [LAW:dataflow-not-control-flow] The accept table, one row per message kind: which phase
  // may receive it. Everything else is `refused` with the phase named.
  const receive = (request: ToWorker): void => {
    switch (request.kind) {
      case "load":
        if (state.kind !== "idle") return refuse(request);
        void load();
        return;
      case "script":
        if (state.kind !== "ready") return refuse(request);
        post({ kind: "script", id: request.id, units: deriveSpeechScript(request.utterances, state.model.countTokens) }, []);
        return;
      case "synthesize":
        if (state.kind !== "ready") return refuse(request);
        synthesize(state, request);
        return;
      case "cancel":
        if (state.kind !== "ready") return refuse(request);
        cancel(state, request.unitId);
        return;
      case "dispose":
        // Idempotent: a page's unconditional pagehide teardown may follow an explicit one.
        dispose();
        return;
    }
  };

  void probe();
  return { receive, phase: () => state.kind };
};

// Re-exported so a runtime implementation and the check share the one tokenizer type.
export type { TokenCount };
