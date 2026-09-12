// [LAW:effects-at-boundaries] The worker's program: the one file that binds the protocol
// handler to a real runtime and the real outbound port. It has no logic of its own — every
// decision is synthesisHandler's, every effect pocketTtsRuntime's — so there is nothing here
// for a check to drive; scripts/synthesis-worker-check.ts drives the handler with a stub
// runtime, and a real browser drives this file (see the ticket's acceptance).
//
// This is the program, not the entry: synthesisWorker.ts is the door that loads this module
// dynamically (the comment there says why WebKit forces the split) and owns the inbound
// listener, handing each message to `receive`.
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

export const receive: (message: ToWorker) => void = handler.receive;
