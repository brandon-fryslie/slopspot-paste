// The tokenizer the runtime hydrates, checked against the real model file and the fork's
// captures (slopspot-read-along-q35.v70). Run: `tsx scripts/tokenizer-check.ts`.
//
// `parseTokenizer` reads the SentencePiece model once and hands out two views of it: the
// jax-js tokenizer and the piece string of every id. This check is where those views are
// proven to be the same model — the vocabulary sizes agree, and for every fixture capture
// the ids match what Kyutai's own tokenizer produced for the same fed text and the pieces
// spell what its tokenizer spelled, so `pieceOf` is indexing the id space `encode` emits
// [LAW:verifiable-goals] [LAW:one-source-of-truth].
//
// The asset comes from the manifest's mirror, verified by SHA-256 or fetched — never a
// stand-in tokenizer, which would prove nothing about the bytes the reader downloads.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ASSETS, shardPlan } from "../src/modelAssets";
import { parseTokenizer, pieceOf } from "../src/pocketTtsRuntime";
import { tokenSpans } from "../src/wordAlignment";
import { mirror } from "./modelAssetMirror";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};
const throws = (label: string, fn: () => unknown): void => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(label, threw);
};

interface Capture {
  readonly fed: string;
  readonly tokens: ReadonlyArray<number>;
  readonly pieces: ReadonlyArray<string>;
}
interface Fixture {
  readonly captures: ReadonlyArray<Capture>;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");
const fixture = JSON.parse(readFileSync(join(root, "test", "fixtures", "word-alignment.json"), "utf8")) as Fixture;

const same = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const mirrored = await mirror(publicDir, fetch, MODEL_ASSETS.tokenizer);
console.log(`tokenizer asset ${mirrored.action}`);
const bytes = Buffer.concat(shardPlan(MODEL_ASSETS.tokenizer).map((s) => readFileSync(join(publicDir, s.url))));
const { tokenizer, pieces } = parseTokenizer(bytes);

console.log("one parse, two views");
assert("the tokenizer's vocabulary is the piece list", tokenizer.vocabSize === pieces.length);
assert("the model has the 4000 pieces the fork's tokenizer has", pieces.length === 4000);
throws("an id past the last piece throws", () => pieceOf(pieces, pieces.length));

console.log("against the fork's captures");
assert("the fixture holds captures", fixture.captures.length > 0);
for (const capture of fixture.captures) {
  const ids = tokenizer.encode(capture.fed);
  const label = JSON.stringify(capture.fed.slice(0, 24));
  assert(`${label}: encode gives the fork's ids`, same(ids, capture.tokens));
  assert(`${label}: pieceOf spells the fork's pieces`, same(ids.map((id) => pieceOf(pieces, id)), capture.pieces));
  assert(`${label}: every piece is found in the fed text`, tokenSpans(capture.fed, ids.map((id) => pieceOf(pieces, id))).length === ids.length);
}

if (process.exitCode === 1) {
  console.error("\nSome tokenizer checks failed.");
} else {
  console.log("\nAll tokenizer checks passed.");
}
