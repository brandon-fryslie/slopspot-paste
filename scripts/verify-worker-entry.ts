// Asserts the built synthesis worker entry chunk is a bare door: it has no static imports,
// no exports, and no other chunk imports it. Run after `astro build` (package.json's
// `postbuild`): `tsx scripts/verify-worker-entry.ts [assets dir]` — the directory defaults
// to this build's dist/client/_astro; naming another lets a downloaded deploy be judged.
//
// Why this exists: WebKit evaluates a module worker's entry script twice when another
// module imports the entry by URL, and Rollup will hoist shared code into the entry chunk
// whenever the entry's static graph gives it something to hoist — see src/synthesisWorker.ts
// (slopspot-read-along-a35.d1y). The source keeps the entry's static graph empty; this is
// the check that the bundle came out that way, so a future bundler or source change that
// re-grows the entry fails the build here instead of in Safari, in production, silently
// [LAW:no-silent-failure] [LAW:verifiable-goals].
//
// [LAW:behavior-not-structure] The assertions are about the emitted chunk graph — what a
// browser will load and in what order — not about how Vite or Rollup arrived at it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const assetsDir = process.argv[2] ?? join(process.cwd(), "dist", "client", "_astro");
const chunks = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
const entries = chunks.filter((f) => /^synthesisWorker-[\w-]+\.js$/.test(f));
if (entries.length !== 1) {
  console.error(`verify-worker-entry: expected one synthesisWorker-*.js in ${assetsDir}, found ${entries.length}: ${entries.join(", ")}`);
  process.exit(1);
}
const [entry] = entries as [string];
const source = readFileSync(join(assetsDir, entry), "utf8");

const failures: string[] = [];
// A static import binds at the top of the chunk; a dynamic one is `import(`.
if (/(^|[;\s])import\s*(?!\()[\w{*"'\s]*?(from\s*)?["']/.test(source)) failures.push(`${entry} has a static import`);
if (/(^|[;\s])export\s*[{*\w]/.test(source)) failures.push(`${entry} has an export`);
// An import of the entry, static or dynamic, by another chunk. The page script names the
// entry too, inside `new Worker(new URL(...))`: a URL, not an import, and not a second
// evaluation.
const imported = new RegExp(String.raw`(?:from|import)\s*\(?\s*["'][^"']*${entry.replace(/[.-]/g, "\\$&")}["']`);
for (const chunk of chunks) {
  if (chunk !== entry && imported.test(readFileSync(join(assetsDir, chunk), "utf8"))) failures.push(`${chunk} imports ${entry}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error("verify-worker-entry: the worker entry chunk is not a bare door; Safari will evaluate it twice.");
  process.exit(1);
}
console.log(`  ✓ ${entry} (${source.length} bytes) imports nothing statically, exports nothing, and is imported by no chunk`);
