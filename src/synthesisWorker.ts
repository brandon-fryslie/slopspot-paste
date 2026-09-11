// [LAW:effects-at-boundaries] The Web Worker entry: the one file that binds the protocol
// handler to a real runtime and a real message port. It has no logic of its own — every
// decision is synthesisHandler's, every effect pocketTtsRuntime's — so there is nothing here
// for a check to drive; scripts/synthesis-worker-check.ts drives the handler with a stub
// runtime, and a real browser drives this file (see the ticket's acceptance).
//
// Vite bundles this module as a worker when the page constructs it via
// `new Worker(new URL("./synthesisWorker.ts", import.meta.url), { type: "module" })` —
// synthesisClient.ts is the one place that does so [LAW:single-enforcer].
//
// `postMessage` uses the options form so the same call type-checks against the DOM lib the
// rest of `src` compiles under and runs on the worker global at runtime.

import { browserAssetIo } from "./modelAssetLoader";
import { pocketTtsRuntime } from "./pocketTtsRuntime";
import { createSynthesisHandler } from "./synthesisHandler";
import type { ToWorker } from "./synthesisProtocol";

const handler = createSynthesisHandler({
  runtime: pocketTtsRuntime(browserAssetIo()),
  post: (message, transfer) => self.postMessage(message, { transfer: [...transfer] }),
  now: () => performance.now(),
});

self.onmessage = (event: MessageEvent<ToWorker>): void => handler.receive(event.data);
