// Bare-door judgment checks (slopspot-read-along-a35.d1y). Run: `tsx scripts/worker-entry-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Proves scripts/workerEntry.ts
// on fixture chunks, without a build: the judgment `postbuild` applies to the real bundle is
// the one proved here [LAW:one-source-of-truth]. A false negative would let Safari's double
// evaluation back in silently; a false positive would block every deploy
// [LAW:verifiable-goals].

import { bareDoorFailures, isWorkerEntry, type Chunk } from "./workerEntry";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const ENTRY = "synthesisWorker-Ab3dE_f9.js";
const entry = (source: string): Chunk => ({ name: ENTRY, source });
const chunk = (name: string, source: string): Chunk => ({ name, source });

assert("recognises the hashed entry name", isWorkerEntry(ENTRY));
assert("rejects the page chunk name", !isWorkerEntry("index-Ab3dE_f9.js"));
assert("rejects a chunk that merely shares the prefix in its middle", !isWorkerEntry("x-synthesisWorker-Ab3dE_f9.js"));

const passes = async (label: string, e: Chunk, others: ReadonlyArray<Chunk> = []): Promise<void> => {
  const failures = await bareDoorFailures(e, others);
  assert(`${label}: bare door`, failures.length === 0);
};
const fails = async (label: string, e: Chunk, others: ReadonlyArray<Chunk>, expected: ReadonlyArray<string>): Promise<void> => {
  const failures = await bareDoorFailures(e, others);
  assert(`${label}: ${JSON.stringify(expected)}`, JSON.stringify(failures) === JSON.stringify(expected));
};

// The shape the real build emits: a worker entry that only ever `import()`s.
const BARE = `self.onmessage=async e=>{const{run}=await import("./synthesisHandler-C1.js");run(e.data)};`;
await passes("dynamic import only", entry(BARE));
await passes("import.meta is not an import", entry(`const u=new URL("./x.js",import.meta.url);${BARE}`));
await passes("the word import inside a string literal", entry(`const s="import x from 'y'";const t='export {a}';${BARE}`));
await passes("the page referencing the entry as a Worker URL", entry(BARE), [
  chunk("index-Q9.js", `new Worker(new URL("./${ENTRY}",import.meta.url),{type:"module"})`),
]);
await passes("another chunk importing something else", entry(BARE), [chunk("a-B2.js", `import{x}from"./b-C3.js";import("./d-E4.js")`)]);

await fails("a side-effect import", entry(`import"./shared-C1.js";${BARE}`), [], [`${ENTRY} has a static import of ./shared-C1.js`]);
await fails("a named import", entry(`import{a}from"./shared-C1.js";${BARE}`), [], [`${ENTRY} has a static import of ./shared-C1.js`]);
await fails("a namespace import", entry(`import*as s from"./shared-C1.js";${BARE}`), [], [`${ENTRY} has a static import of ./shared-C1.js`]);
await fails("a default import", entry(`import s from"./shared-C1.js";${BARE}`), [], [`${ENTRY} has a static import of ./shared-C1.js`]);
await fails("a named export", entry(`const a=1;export{a};${BARE}`), [], [`${ENTRY} exports a`]);
await fails("a star export", entry(`export*from"./shared-C1.js";${BARE}`), [], [`${ENTRY} has a static import of ./shared-C1.js`]);
await fails("a default export", entry(`export default 1;${BARE}`), [], [`${ENTRY} exports default`]);
await fails("another chunk importing the entry statically", entry(BARE), [chunk("webgpu-D5.js", `import{a}from"./${ENTRY}";`)], [`webgpu-D5.js imports ${ENTRY}`]);
await fails("another chunk importing the entry dynamically", entry(BARE), [chunk("webgl-F6.js", `const m=await import("./${ENTRY}");`)], [`webgl-F6.js imports ${ENTRY}`]);
await fails("every failure reported, in order", entry(`import{a}from"./s-C1.js";export{a};${BARE}`), [chunk("w-D5.js", `import"./${ENTRY}"`)], [
  `${ENTRY} has a static import of ./s-C1.js`,
  `${ENTRY} exports a`,
  `w-D5.js imports ${ENTRY}`,
]);
