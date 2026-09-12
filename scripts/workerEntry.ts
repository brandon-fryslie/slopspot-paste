// The judgment behind `postbuild`: is the built synthesis worker entry chunk a bare door —
// no static import, no export, imported by no other chunk? WebKit evaluates a module
// worker's entry twice when another module imports it by URL, and Rollup hoists shared
// code into the entry whenever the entry's static graph gives it something to hoist — see
// src/synthesisWorker.ts (slopspot-read-along-a35.d1y).
//
// Pure over chunk records, so the same judgment is proved on fixtures
// (worker-entry-check.ts) and applied to a real build (verify-worker-entry.ts)
// [LAW:effects-at-boundaries] [LAW:one-source-of-truth]. The module grammar comes from the
// ES module lexer, not a regex: an `import` inside a string is not an import, and a
// `new URL("./synthesisWorker-x.js", import.meta.url)` is a URL, not a second evaluation
// [LAW:parse-dont-validate].

import { init, parse } from "es-module-lexer";

export interface Chunk {
  readonly name: string;
  readonly source: string;
}

export const isWorkerEntry = (name: string): boolean => /^synthesisWorker-[\w-]+\.js$/.test(name);

// Failures are the value; an empty list is the bare door [LAW:dataflow-not-control-flow].
export const bareDoorFailures = async (entry: Chunk, others: ReadonlyArray<Chunk>): Promise<ReadonlyArray<string>> => {
  await init;
  const [imports, exports] = parse(entry.source, entry.name);
  // `d` is -1 for a static import, -2 for `import.meta`, and the call's offset for `import()`.
  const staticImports = imports.filter((i) => i.d === -1);
  const importers = others.filter(({ name, source }) => {
    const [chunkImports] = parse(source, name);
    return chunkImports.some((i) => i.n !== undefined && i.d !== -2 && i.n.endsWith(entry.name));
  });
  return [
    ...staticImports.map((i) => `${entry.name} has a static import of ${i.n ?? "<computed>"}`),
    ...exports.map((e) => `${entry.name} exports ${e.n}`),
    ...importers.map((c) => `${c.name} imports ${entry.name}`),
  ];
};
