// [LAW:decomposition] The semantic-search ORCHESTRATION, cut apart from the
// embedding boundary (embeddings.ts, which only knows the Workers AI wire) and the
// HTTP endpoint (which only decodes the request and shapes the response) — the
// exact seam summaryService.ts cut for the TL;DR. This part owns the one policy:
// resolve a viewable paste, key a disposable vector index by a hash of the chunk
// projection it embeds, serve the index from cache when it matches, else embed once
// and cache; then embed the query, score by cosine, and rank spine nodes.
//
// [LAW:effects-at-boundaries] The embedding effect enters as a VALUE — `embedFn`
// defaults to the real binding edge, but a caller (scripts/search-check.ts) passes
// a stub, so the whole gate/hash/cache/score policy is verifiable without a Worker.
// The KV effect is likewise the passed-in slice, not an ambient import. Scoring
// happens HERE, in the Worker — no vector database, and no vectors ever shipped to
// the browser: the reader page receives ranked turn indices only.
//
// [LAW:one-source-of-truth] The index is a disposable projection: keyed by
// slug + a hash of the exact chunk list deriveChunks returns — the same
// hash-what-you-read move as dialogueContentHash — regenerated on a miss, purged
// with the paste (storage.deleteConversation), never authoritative and never
// coupled to the model version that wrote it [LAW:no-ambient-temporal-coupling].

import { loadViewablePaste } from "./loadPaste";
import { deriveViewableDialogue } from "./overlay";
import { deriveChunks } from "./chunks";
import { deriveSpineOutline, type OutlineEntry } from "./spineOutline";
import { contentHash } from "./contentHash";
import {
  embedTexts as realEmbedTexts,
  extractEmbeddings,
  type EmbeddingAi,
  type EmbeddingsResult,
} from "./embeddings";
import { getCachedVectorIndex, putCachedVectorIndex, type PasteKv } from "./storage";

// [LAW:types-are-the-program] A hit IS an outline entry with a score: index, t<N>
// anchor, role, and label all come from deriveSpineOutline — the same derivations
// the topic outline and minimap already read — so a hit can never name a turn the
// renderer didn't emit or show a label the minimap can't [LAW:one-source-of-truth].
export interface SearchHit extends OutlineEntry {
  readonly score: number;
}

// [LAW:types-are-the-program] The orchestration's total outcome. The gate's
// 404/410/503 flow straight through; an embedding failure becomes a 502. There is
// no 503-not-configured arm of our own: the AI binding carries no API key, so a
// missing binding is a deploy error, not a runtime state (see embeddings.ts).
// `indexCached` mirrors the summary's `cached` — whether the chunk index was
// served from KV (the query itself is embedded on every call, never cached).
export type SearchOutcome =
  | { readonly ok: true; readonly hits: ReadonlyArray<SearchHit>; readonly indexCached: boolean }
  | { readonly ok: false; readonly status: 404 | 410 | 502 | 503; readonly error: string };

// The injectable shape of the embedding boundary — exactly embedTexts's signature,
// so the real function is assignable with no adapter.
export type EmbedFn = (
  texts: ReadonlyArray<string>,
  ai: EmbeddingAi,
) => Promise<EmbeddingsResult>;

// Quantize to 6 decimal places before caching and scoring: bge-m3 components are
// O(1e-2), so this keeps ~4 significant digits — far beyond ranking precision —
// while roughly halving the stored JSON (a float64 serializes at up to ~17
// significant digits). Applied on the miss path BEFORE scoring, so a cache hit and
// a fresh embed score identically [LAW:one-source-of-truth].
const quantize = (
  vectors: ReadonlyArray<ReadonlyArray<number>>,
): ReadonlyArray<ReadonlyArray<number>> =>
  vectors.map((v) => v.map((n) => Math.round(n * 1e6) / 1e6));

// [LAW:effects-at-boundaries] Pure cosine similarity, positional over `a`'s
// dimensions. Both sides are classifier-certified EMBEDDING_DIMS vectors
// (extractEmbeddings, on the wire AND on the cache read), so the `?? 0` arm is
// that certificate restated as zero-padding — the standard cosine treatment of a
// missing dimension — not a reachable case. A zero-magnitude vector has no
// direction; its similarity is defined as 0 rather than NaN, which would poison
// the sort [LAW:no-silent-failure].
const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  a.forEach((av, i) => {
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  });
  const denom = Math.sqrt(magA * magB);
  return denom === 0 ? 0 : dot / denom;
};

// [LAW:types-are-the-program] The cached index is KV-stored JSON — a trust
// boundary. extractEmbeddings is the ONE classifier of "structurally valid
// vectors" [LAW:single-enforcer]; feeding it the parsed value re-certifies a
// cached index exactly as a fresh wire response is certified: one vector per
// current chunk, EMBEDDING_DIMS finite numbers each. Anything else — corruption,
// a hand-edited record, unparseable JSON (undefined data → the no-data arm) — is
// logged and treated as a miss, so a bad cache entry regenerates instead of
// silently mis-scoring [LAW:no-silent-failure].
const parseCachedIndex = (
  raw: string,
  expected: number,
  slug: string,
): ReadonlyArray<ReadonlyArray<number>> | null => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = undefined;
  }
  const result = extractEmbeddings({ data }, expected);
  if (!result.ok) {
    console.error(`resolveSearch: cached vector index invalid for slug ${slug}, regenerating: ${result.reason}`);
    return null;
  }
  return result.vectors;
};

export const resolveSearch = async (
  // [LAW:composability] The structural KV slice (storage.PasteKv): env.PASTES
  // assigns as-is, and the check script drives the whole flow with a Map-backed stub.
  kv: Pick<PasteKv, "get" | "put">,
  slug: string,
  query: string,
  now: number,
  ai: EmbeddingAi,
  embedFn: EmbedFn = realEmbedTexts,
): Promise<SearchOutcome> => {
  // [LAW:single-enforcer] The one viewable-paste gate — the same one /<slug> and
  // /api/summarize resolve through, so a hidden/expired paste that 404/410s there
  // cannot be searched here.
  const load = await loadViewablePaste(kv, slug, now);
  if (!load.ok) return { ok: false, status: load.status, error: load.message };

  // [LAW:one-source-of-truth] The corpus is the VIEWABLE projection — the same
  // chunks a reader can see (hidden turns already carry the redaction marker,
  // feature-omitted turns are already absent), derived by the one chunk authority.
  // Hash the exact chunk list the index embeds, so the key and the embedded
  // content cannot disagree: an overlay edit that changes readable content mints
  // a new key, while a fold-only edit (same readable nodes) keeps the hit.
  const view = deriveViewableDialogue(load.conversation);
  const chunks = deriveChunks(view);
  const hash = await contentHash(chunks);

  const cachedRaw = await getCachedVectorIndex(kv, slug, hash);
  const cached = cachedRaw === null ? null : parseCachedIndex(cachedRaw, chunks.length, slug);

  // [LAW:effects-at-boundaries] The chunk-embedding call happens exactly here,
  // only on a miss; a hit re-embeds nothing but the query below.
  let chunkVectors: ReadonlyArray<ReadonlyArray<number>>;
  if (cached === null) {
    const embedded = await embedFn(chunks.map((c) => c.text), ai);
    if (!embedded.ok) {
      return { ok: false, status: 502, error: `Indexing failed: ${embedded.reason}` };
    }
    chunkVectors = quantize(embedded.vectors);
    await putCachedVectorIndex(kv, slug, hash, JSON.stringify(chunkVectors));
  } else {
    chunkVectors = cached;
  }

  const embeddedQuery = await embedFn([query], ai);
  if (!embeddedQuery.ok) {
    return { ok: false, status: 502, error: `Query embedding failed: ${embeddedQuery.reason}` };
  }
  const [queryVector] = embeddedQuery.vectors;
  if (queryVector === undefined) {
    // Unreachable per the classifier (one vector per input text), but the truth of
    // "no query vector" must be a loud 502, never every-score-is-zero results.
    // [LAW:no-silent-failure]
    return { ok: false, status: 502, error: "Workers AI returned no query vector." };
  }

  // [LAW:one-source-of-truth] chunks and chunkVectors are positionally aligned —
  // extractEmbeddings certified exactly one vector per chunk on both the fresh and
  // the cached path. Several chunks can carry one spine index (a long node split
  // into windows); a reader jumps to turns, not windows, so hits dedupe to the
  // best-scoring chunk per index.
  const best = new Map<number, number>();
  chunks.forEach((chunk, i) => {
    const score = cosine(queryVector, chunkVectors[i] ?? []);
    if (score > (best.get(chunk.index) ?? -Infinity)) best.set(chunk.index, score);
  });

  // Every viewable node appears in the outline; a node with no readable prose has
  // no chunks and therefore no score — it is legitimately unsearchable and absent
  // from the hits, a value case, not a guard [LAW:dataflow-not-control-flow].
  // Array.prototype.sort is stable, so equal scores keep document order.
  const hits: ReadonlyArray<SearchHit> = deriveSpineOutline(view)
    .flatMap((entry) => {
      const score = best.get(entry.index);
      return score === undefined ? [] : [{ ...entry, score }];
    })
    .sort((a, b) => b.score - a.score);

  return { ok: true, hits, indexCached: cached !== null };
};
