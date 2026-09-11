// The attention read-out (slopspot-read-along-q35.v70): `readoutLogits` in the vendored
// model picks one layer's newest post-rope query row for one head and dots it with that
// layer's cached keys at the text positions, scaled by 1/sqrt(D). Run:
// `tsx scripts/readout-check.ts`.
//
// No GPU, no checkpoint: jax-js's Wasm device runs float32 in Node, and the tensors are
// small enough that every value is a distinct number, so a wrong layer, head, query row or
// text position changes the logits rather than passing with plausible ones. The expected
// values come from a plain-JS walk over the same flat arrays with the [position, head, dim]
// strides written out, and one case is stated as literal dot products [LAW:verifiable-goals].

import { defaultDevice, init, numpy as np, tree } from "@jax-js/jax";
import { readoutLogits, type KVCache, type Readout } from "../src/vendor/pocket-tts";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const LAYERS = 2;
const T = 2;
const HEADS = 3;
const DIM = 2;
const CACHE = 6;

// Every element its own number: query [t, h, d] of layer l is 100·l + its flat index + 1,
// key [p, h, d] of layer l is 1000·l + half its flat index.
const queryValue = (layer: number, t: number, h: number, d: number): number => 100 * layer + (t * HEADS + h) * DIM + d + 1;
const keyValue = (layer: number, p: number, h: number, d: number): number => 1000 * layer + ((p * HEADS + h) * DIM + d) / 2;

const layered = (count: number, value: (i: number) => number): Float32Array<ArrayBuffer> => {
  const xs = new Float32Array(new ArrayBuffer(count * 4));
  for (let i = 0; i < count; i++) xs[i] = value(i);
  return xs;
};
const queries = (): np.Array[] =>
  Array.from({ length: LAYERS }, (_, layer) =>
    np.array(layered(T * HEADS * DIM, (i) => queryValue(layer, Math.floor(i / (HEADS * DIM)), Math.floor(i / DIM) % HEADS, i % DIM)), { shape: [T, HEADS, DIM], dtype: np.float32 }),
  );
const caches = (): KVCache[] =>
  Array.from({ length: LAYERS }, (_, layer) => ({
    key: np.array(layered(CACHE * HEADS * DIM, (i) => keyValue(layer, Math.floor(i / (HEADS * DIM)), Math.floor(i / DIM) % HEADS, i % DIM)), { shape: [CACHE, HEADS, DIM], dtype: np.float32 }),
    value: np.zeros([CACHE, HEADS, DIM], { dtype: np.float32 }),
  }));

// The reference: the last query row (t = T - 1) of the named layer and head against each
// text position's key for that head, over sqrt(D).
const expected = ({ layer, head, textStart, textEnd }: Readout): number[] =>
  Array.from({ length: textEnd - textStart }, (_, i) => {
    const p = textStart + i;
    let dot = 0;
    for (let d = 0; d < DIM; d++) dot += keyValue(layer, p, head, d) * queryValue(layer, T - 1, head, d);
    return dot / Math.sqrt(DIM);
  });

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(b));

const devices = await init("cpu", "wasm");
assert("jax-js offers a Wasm device in Node", devices.includes("wasm"));
defaultDevice("wasm");

const check = async (label: string, readout: Readout): Promise<ReadonlyArray<number>> => {
  const kvCaches = caches();
  const logits = readoutLogits(queries(), kvCaches, readout);
  const raw = await logits.data();
  tree.dispose(kvCaches);
  const values = Array.from(raw);
  const want = expected(readout);
  assert(`${label}: one float32 logit per text position`, raw instanceof Float32Array && logits.shape.join() === String(textCount(readout)));
  assert(`${label}: q[T-1, head] · k[p, head] / sqrt(D) for p in [textStart, textEnd)`, values.length === want.length && want.every((w, i) => near(values[i] ?? NaN, w)));
  return values;
};
const textCount = ({ textStart, textEnd }: Readout): number => textEnd - textStart;

console.log("readout logits");
{
  // Layer 0, head 2, text at [2, 5): the last query row for head 2 is [11, 12] and the keys
  // at positions 2, 3, 4 are [8, 8.5], [11, 11.5], [14, 14.5], so the dot products are
  // 8·11 + 8.5·12 = 190, 11·11 + 11.5·12 = 259 and 14·11 + 14.5·12 = 328, each over sqrt(2).
  const values = await check("layer 0, head 2, [2, 5)", { layer: 0, head: 2, textStart: 2, textEnd: 5 });
  const dots = [190, 259, 328].map((dot) => dot / Math.sqrt(2));
  assert("the literal dot products, by hand", values.length === 3 && dots.every((dot, i) => near(values[i] ?? NaN, dot)));
  await check("layer 1, head 1, [1, 4)", { layer: 1, head: 1, textStart: 1, textEnd: 4 });
  await check("layer 1, head 0, the whole cache [0, 6)", { layer: 1, head: 0, textStart: 0, textEnd: 6 });
  await check("layer 0, head 1, one position [5, 6)", { layer: 0, head: 1, textStart: 5, textEnd: 6 });
}

if (process.exitCode === 1) {
  console.error("\nSome readout checks failed.");
} else {
  console.log("\nAll readout checks passed.");
}
