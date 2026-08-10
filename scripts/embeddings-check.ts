// Workers AI embedding boundary checks (slopspot-ask-rag-a3k.2). Run: `tsx scripts/embeddings-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the
// embedding boundary (src/embeddings.ts) OFF-NETWORK: the pure request builder
// emits the wire's plain-embedding arm, and the classifier is exercised against
// the REAL captured response (test/fixtures/bge-m3-embedding.json — a live
// 2026-08-09 capture of the REST ai/run endpoint, whose `result` field is exactly
// the object the in-Worker binding returns), plus malformed variants that must
// each map to a typed refusal, never a throw [LAW:no-silent-failure]. The edge is
// driven with stubs proving the effect happens exactly when it should
// [LAW:effects-at-boundaries].

import { readFileSync } from "node:fs";
import {
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  embeddingsRequestBody,
  extractEmbeddings,
  embedTexts,
  type EmbeddingAi,
} from "../src/embeddings";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── the real wire capture ──
// [LAW:one-source-of-truth] The fixture is committed verbatim as captured (whole
// REST envelope); the binding-shaped object the classifier sees is its `result`.
const envelope = JSON.parse(
  readFileSync("test/fixtures/bge-m3-embedding.json", "utf8"),
) as { success: boolean; result: { data: number[][] } };
const real: unknown = envelope.result;
const realData = envelope.result.data;

console.log("Request builder:");
{
  const texts = ["alpha", "beta"];
  const body = embeddingsRequestBody(texts);
  assert("body is the plain-embedding arm: {text: [...]}", Array.isArray(body.text) && body.text.length === 2);
  assert(
    "body copies the input rather than aliasing the caller's array",
    body.text !== texts && body.text[0] === "alpha" && body.text[1] === "beta",
  );
  assert(
    "truncate_inputs is absent — chunk size is enforced upstream, over-length fails loudly",
    !("truncate_inputs" in body),
  );
}

console.log("\nClassifier against the real captured response:");
{
  const extracted = extractEmbeddings(real, 2);
  assert("the real capture classifies ok", extracted.ok);
  if (extracted.ok) {
    assert("two input texts yielded two vectors", extracted.vectors.length === 2);
    assert(
      `every vector has ${EMBEDDING_DIMS} finite dimensions`,
      extracted.vectors.every(
        (v) => v.length === EMBEDDING_DIMS && v.every(Number.isFinite),
      ),
    );
    assert(
      "vectors pass through bit-identical to the wire payload",
      extracted.vectors[0]![0] === realData[0]![0] &&
        extracted.vectors[1]![EMBEDDING_DIMS - 1] === realData[1]![EMBEDDING_DIMS - 1],
    );
  }
}

console.log("\nClassifier refuses malformed payloads with typed reasons (no throws):");
{
  const cases: ReadonlyArray<[string, unknown, number]> = [
    ["null body", null, 1],
    ["empty object (no data)", {}, 1],
    ["data is not an array", { data: "vectors" }, 1],
    ["count mismatch: fewer vectors than texts", real, 3],
    ["a vector with wrong dimensionality", { data: [[1, 2, 3]] }, 1],
    ["a vector holding non-numbers", { data: [Array(EMBEDDING_DIMS).fill("x")] }, 1],
    ["a vector holding a non-finite number", { data: [[...realData[0]!.slice(0, EMBEDDING_DIMS - 1), NaN]] }, 1],
  ];
  for (const [label, payload, expected] of cases) {
    const out = extractEmbeddings(payload, expected);
    assert(`${label} → ok:false with a reason`, !out.ok && out.reason.length > 0);
  }
  const mismatch = extractEmbeddings(real, 3);
  assert(
    "count-mismatch reason names both counts",
    !mismatch.ok && mismatch.reason.includes("2") && mismatch.reason.includes("3"),
  );
}

console.log("\nThe edge (stubbed binding):");
{
  // Success path: the stub resolves the real capture; the edge must pass the model
  // id and the built body through, and classify the result.
  let seenModel = "";
  let seenTexts: string[] = [];
  const okAi: EmbeddingAi = {
    run: (model, input) => {
      seenModel = model;
      seenTexts = input.text;
      return Promise.resolve(real);
    },
  };
  void (async () => {
    const out = await embedTexts(["alpha", "beta"], okAi);
    assert("edge resolves the classified vectors", out.ok && out.vectors.length === 2);
    assert("edge sends the one canonical model id", seenModel === EMBEDDING_MODEL);
    assert("edge sends exactly the caller's texts", seenTexts.join(",") === "alpha,beta");

    // Rejection path: a binding throw becomes a typed reason, never an escape.
    const failAi: EmbeddingAi = {
      run: () => Promise.reject(new Error("model overloaded")),
    };
    const failed = await embedTexts(["alpha"], failAi);
    assert(
      "a binding rejection maps to ok:false carrying the cause",
      !failed.ok && failed.reason.includes("model overloaded"),
    );

    // Garbage-resolution path: a non-Error, non-conforming resolution classifies.
    const junkAi: EmbeddingAi = { run: () => Promise.resolve({ unexpected: true }) };
    const junk = await embedTexts(["alpha"], junkAi);
    assert("a malformed resolution classifies as a typed refusal", !junk.ok);

    // [LAW:effects-at-boundaries] Zero texts is the identity — the binding must
    // never be invoked for it. The stub throws synchronously to prove it.
    const untouchable: EmbeddingAi = {
      run: () => {
        throw new Error("the binding must not be called for zero texts");
      },
    };
    const empty = await embedTexts([], untouchable);
    assert(
      "zero texts yields ok with zero vectors, without touching the binding",
      empty.ok && empty.vectors.length === 0,
    );

    console.log("\nembeddings-check complete.");
  })();
}
