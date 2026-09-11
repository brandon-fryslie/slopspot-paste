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
  // Ends the worker outright. Send `dispose` first when GPU memory should be released
  // gracefully; terminate alone is what a page teardown does.
  readonly terminate: () => void;
}

export const spawnSynthesisWorker = (): SynthesisPort => {
  const worker = new Worker(new URL("./synthesisWorker.ts", import.meta.url), { type: "module" });
  return {
    send: (message) => worker.postMessage(message),
    subscribe: (listener) => {
      const onMessage = (event: MessageEvent<FromWorker>): void => listener(event.data);
      worker.addEventListener("message", onMessage);
      return () => worker.removeEventListener("message", onMessage);
    },
    terminate: () => worker.terminate(),
  };
};
