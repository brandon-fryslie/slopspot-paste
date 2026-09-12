// Asserts the built synthesis worker entry chunk is a bare door. Run after `astro build`
// (package.json's `postbuild`): `tsx scripts/verify-worker-entry.ts [assets dir]` — the
// directory defaults to this build's dist/client/_astro; naming another lets a downloaded
// deploy be judged. The judgment itself is scripts/workerEntry.ts; this is the edge that
// reads the build and fails it, so a bundler or source change that re-grows the entry fails
// here instead of in Safari, in production, silently [LAW:no-silent-failure]
// [LAW:verifiable-goals].

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bareDoorFailures, isWorkerEntry, type Chunk } from "./workerEntry";

const assetsDir = process.argv[2] ?? join(process.cwd(), "dist", "client", "_astro");
const chunks: ReadonlyArray<Chunk> = readdirSync(assetsDir)
  .filter((f) => f.endsWith(".js"))
  .map((name) => ({ name, source: readFileSync(join(assetsDir, name), "utf8") }));
const entries = chunks.filter((c) => isWorkerEntry(c.name));
if (entries.length !== 1) {
  console.error(`verify-worker-entry: expected one synthesisWorker-*.js in ${assetsDir}, found ${entries.length}: ${entries.map((c) => c.name).join(", ")}`);
  process.exit(1);
}
const [entry] = entries as [Chunk];

const failures = await bareDoorFailures(entry, chunks.filter((c) => c !== entry));
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error("verify-worker-entry: the worker entry chunk is not a bare door; Safari will evaluate it twice.");
  process.exit(1);
}
console.log(`  ✓ ${entry.name} (${entry.source.length} bytes) imports nothing statically, exports nothing, and is imported by no chunk`);
