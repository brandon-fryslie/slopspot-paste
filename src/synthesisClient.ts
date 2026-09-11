// [LAW:decomposition] The page side of the synthesis protocol: it spawns the worker and
// speaks to it in the protocol's types. One sentence, no "and": this module is the typed
// port. It decides nothing — what to synthesize and when is the scheduler's (q35.wuv), what
// to do with frames is the unit player's (q35.04v) — and it holds no state beyond the
// worker handle, so any consumer that has a SynthesisPort can be driven by a stub port in
// its own check without a Worker existing [LAW:composability].
//
// The worker is spawned only here, so the module URL Vite must bundle as a worker appears
// once in the codebase [LAW:single-enforcer]. A fresh worker probes on its own: the first
// message a subscriber sees is `capability`, and no model byte moves until `load` is sent.
//
// The one seam where the wire is trusted: `event.data` from our own module-typed worker is
// read as FromWorker without a runtime parse. Both ends import synthesisProtocol.ts, so the
// compiler checks what the worker may post; structured clone carries exactly that.

import type { FromWorker, ToWorker } from "./synthesisProtocol";

export interface SynthesisPort {
  readonly send: (message: ToWorker) => void;
  // Subscribes; returns the unsubscribe.
  readonly subscribe: (listener: (message: FromWorker) => void) => () => void;
  // The worker's own failures — a bundle that did not load, an exception outside the
  // protocol — arrive on no protocol message; this is their channel. Returns the unsubscribe.
  readonly errors: (listener: (message: string) => void) => () => void;
  // Releases the model and ends the worker: `dispose` is sent, and the worker is terminated
  // on its `disposed` reply, when nothing is left on the device.
  readonly dispose: () => void;
  // Ends the worker outright, releasing nothing: for a worker that has already failed.
  readonly terminate: () => void;
}

export const spawnSynthesisWorker = (): SynthesisPort => {
  const worker = new Worker(new URL("./synthesisWorker.ts", import.meta.url), { type: "module" });
  const send = (message: ToWorker): void => worker.postMessage(message);
  // `disposed` is only ever the answer to `dispose`, and the worker holds nothing once it
  // is posted: the worker ends on it, whichever call asked.
  worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
    if (event.data.kind === "disposed") worker.terminate();
  });
  return {
    send,
    subscribe: (listener) => {
      const onMessage = (event: MessageEvent<FromWorker>): void => listener(event.data);
      worker.addEventListener("message", onMessage);
      return () => worker.removeEventListener("message", onMessage);
    },
    errors: (listener) => {
      const onError = (event: ErrorEvent): void => listener(event.message);
      worker.addEventListener("error", onError);
      return () => worker.removeEventListener("error", onError);
    },
    dispose: () => send({ kind: "dispose" }),
    terminate: () => worker.terminate(),
  };
};
