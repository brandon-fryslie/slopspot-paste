// [LAW:single-enforcer] This file is the ONE place the Workers AI embedding wire
// lives — the twin of summary.ts (the DeepSeek chat wire) and firecrawl.ts (the
// scrape wire). The rest of the codebase asks for "vectors for these texts"; it
// never learns the model name, the request shape, or the response envelope. If
// Cloudflare's embedding interface changes, only this file changes.
//
// [LAW:effects-at-boundaries] Split exactly as summary.ts: embeddingsRequestBody /
// extractEmbeddings are PURE (no I/O — exercised against the real captured wire
// fixture in scripts/embeddings-check.ts with no binding in sight); embedTexts is
// the single edge that touches the AI binding.
//
// [LAW:types-are-the-program] EmbeddingsResult is a discriminated union — every
// failure mode is a representable value; no throw crosses this module's boundary.
// Unlike SummaryResult there is no `configured` arm: the AI binding carries no API
// key, and once wrangler.toml declares it the generated Env makes its absence
// unrepresentable — a config gap here is a deploy error, not a runtime state.

// [LAW:one-source-of-truth] The one model this app embeds with, and the dimension
// its vectors have. bge-m3: 1024-dim, multilingual, long-context — verified live
// (test/fixtures/bge-m3-embedding.json, captured 2026-08-09 from the REST ai/run
// endpoint, which serves the same model the binding does). A single call was
// verified to embed 501 texts — above any chunk count a stored paste projects —
// so this boundary carries no batching; an overrun surfaces as a loud provider
// error, never a silently split request. Consumers (the index cache, cosine
// scoring) read EMBEDDING_DIMS from here, never a literal 1024 of their own.
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMS = 1024;

export type EmbeddingsResult =
  | { readonly ok: true; readonly vectors: ReadonlyArray<ReadonlyArray<number>> }
  | { readonly ok: false; readonly reason: string };

// [LAW:composability] The injectable shape of the binding edge — exactly the slice
// of the Workers `Ai` interface this module uses, so `env.AI` is assignable as-is
// while a test stubs one method instead of the platform's whole model catalog.
export interface EmbeddingAi {
  run(model: typeof EMBEDDING_MODEL, input: { text: string[] }): Promise<unknown>;
}

// [LAW:effects-at-boundaries] Pure request body — the binding input for the plain
// embedding arm ({text}), never the model's query+contexts arm (that mode re-embeds
// every context on every call; the cached index this feeds makes a query ~four
// orders of magnitude cheaper). truncate_inputs is deliberately ABSENT: the chunk
// projection is the single enforcer of chunk size [LAW:single-enforcer], so an
// over-long input reaching this wire is an upstream bug that must fail LOUDLY as a
// provider error — never be silently clipped into a vector that under-represents
// its chunk [LAW:no-silent-failure].
export const embeddingsRequestBody = (
  texts: ReadonlyArray<string>,
): { text: string[] } => ({ text: [...texts] });

// [LAW:types-are-the-program] The slice of the binding output this path reads,
// captured from a real call. The REST envelope wraps it in {success, errors,
// result}; the in-Worker binding returns the inner object directly — the fixture's
// `result` field IS the binding's shape: {data, shape, pooling, ...}. Fields are
// unknown because the AI binding is a trust boundary — extractEmbeddings
// classifies, it does not assume.
interface EmbeddingOutput {
  readonly data?: unknown;
}

const isVector = (v: unknown): v is ReadonlyArray<number> =>
  Array.isArray(v) &&
  v.length === EMBEDDING_DIMS &&
  v.every((n) => typeof n === "number" && Number.isFinite(n));

// [LAW:no-defensive-null-guards] This IS the trust boundary — these guards classify
// the wire payload into the typed union and stop. Downstream receives structurally
// valid vectors (one per input text, EMBEDDING_DIMS finite numbers each) or a typed
// refusal naming exactly what was wrong — count drift and dimension drift are
// distinct truths a caller may want to log distinctly [LAW:no-silent-failure].
// Pure: takes the already-resolved output, so the check script drives it straight
// from the captured fixture with no binding.
export const extractEmbeddings = (
  output: unknown,
  expected: number,
): EmbeddingsResult => {
  const data = (output as EmbeddingOutput | null)?.data;
  // [LAW:no-silent-failure] Absence and wrong shape are distinct truths: "no data
  // field" points an operator at the binding/response envelope, "present but not
  // an array" points at a wire-shape change. One shared reason would misdirect
  // the debugging of whichever one actually happened.
  if (data === undefined) {
    return { ok: false, reason: "Workers AI returned no embedding data." };
  }
  if (!Array.isArray(data)) {
    return { ok: false, reason: "Workers AI returned embedding data that is not an array." };
  }
  if (data.length !== expected) {
    return {
      ok: false,
      reason: `Workers AI returned ${data.length} vectors for ${expected} texts.`,
    };
  }
  if (!data.every(isVector)) {
    return {
      ok: false,
      reason: `Workers AI returned a malformed vector (expected ${EMBEDDING_DIMS} finite dimensions).`,
    };
  }
  return { ok: true, vectors: data };
};

// [LAW:effects-at-boundaries] The single edge. All binding activity for embeddings
// lives here; the interior above is pure. Returns the typed union — no throw
// crosses this boundary. Zero texts is the identity, answered without invoking the
// binding: the empty request has a statically known result, and the model would
// reject it as an error the caller did nothing to earn.
export const embedTexts = async (
  texts: ReadonlyArray<string>,
  ai: EmbeddingAi,
): Promise<EmbeddingsResult> => {
  if (texts.length === 0) return { ok: true, vectors: [] };

  // [LAW:types-are-the-program] The catch returns the rejection value; `instanceof
  // Error` then narrows failure from output (the summary.ts `instanceof Response`
  // move) — a binding rejection becomes a typed reason, and a non-Error rejection
  // falls through to the classifier, whose no-data arm reports it.
  const outcome = await ai
    .run(EMBEDDING_MODEL, embeddingsRequestBody(texts))
    .catch((e: unknown): unknown => e);
  if (outcome instanceof Error) {
    return { ok: false, reason: `Workers AI embedding call failed: ${outcome.message}` };
  }
  return extractEmbeddings(outcome, texts.length);
};
