// The Web Worker entry, and nothing but a door: synthesisWorkerMain.ts is the program.
//
// Vite bundles this module as a worker when the page constructs it via
// `new Worker(new URL("./synthesisWorker.ts", import.meta.url), { type: "module" })` —
// synthesisClient.ts is the one place that does so [LAW:single-enforcer].
//
// [LAW:no-ambient-temporal-coupling] WebKit does not put a module worker's entry script in
// the module map, so any chunk that imports the entry by URL makes WebKit evaluate the entry
// a SECOND time. Rollup hoists code shared between the entry's static graph and the lazily
// imported jax-js backend chunks into the entry chunk, and those chunks import it back — so
// in Safari a program written at this top level ran twice: two handlers, two probes, two
// `capability` messages on one port (slopspot-read-along-a35.d1y). The dynamic import is the
// mechanism, not a style: it forces a chunk boundary, so this entry's static graph is empty,
// nothing can be hoisted into it, and nothing imports it. A second evaluation of this file
// resolves the same already-evaluated module and creates nothing. A static `import` would
// merge the program back into this chunk. scripts/verify-worker-entry.ts asserts the shape
// of the built entry after every build.
//
// [LAW:no-silent-failure] A rejection inside a worker never reaches the page's Worker
// `error` event on its own; `reportError` raises it as one, so a main module that fails to
// load is a crashed worker to the panel, not a probe that never answers.
import("./synthesisWorkerMain").catch((error: unknown) => self.reportError(error));
