// Semantic-search orchestration checks (slopspot-ask-rag-a3k.4). Run:
// `tsx scripts/search-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure.
// [LAW:verifiable-goals] resolveSearch is driven end-to-end with an in-memory KV
// and a stubbed embedder — no network, every outcome asserted: a miss builds and
// caches the index, a hit re-embeds only the query, a content-changing overlay
// edit mints a new cache key while a fold-only edit keeps the hit, ranking puts
// the known-relevant turn first, and windowed chunks dedupe to one hit per spine
// index. [LAW:behavior-not-structure] The stub records the exact texts the
// embedding boundary RECEIVES, so assertions pin what gets embedded (and what
// must never be — hidden content), not the service's internal shape.

import { EMBEDDING_DIMS } from "../src/embeddings";
import type { EmbeddingAi } from "../src/embeddings";
import { CHUNK_MAX_CHARS } from "../src/chunks";
import { resolveSearch, type EmbedFn } from "../src/searchService";
import type { PasteKv } from "../src/storage";
import type { Turn } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const assertEq = <T,>(label: string, actual: T, expected: T): void => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    expected: ${e}`);
    console.error(`    actual:   ${a}`);
    process.exitCode = 1;
  }
};

// The Map-backed PasteKv slice — no cast: the stub implements exactly the two
// methods resolveSearch's signature asks for.
const kvStore = new Map<string, string>();
const kv: Pick<PasteKv, "get" | "put"> = {
  get: async (key) => kvStore.get(key) ?? null,
  put: async (key, value) => void kvStore.set(key, value),
};

const vectorKeys = (): string[] =>
  [...kvStore.keys()].filter((k) => k.startsWith("vectors:"));

// A deterministic fake embedder: each vector is EMBEDDING_DIMS long (so a cached
// index round-trips through the service's shape classifier), with feature
// dimensions set from keyword presence plus a shared base dimension so no vector
// is zero. Cosine then ranks a chunk containing the query's keyword first — a
// known-relevant ordering with no model in sight.
const FEATURES = ["banana", "weather", "typescript"];
const fakeVector = (text: string): number[] => {
  const v: number[] = new Array<number>(EMBEDDING_DIMS).fill(0);
  FEATURES.forEach((word, i) => {
    v[i] = text.toLowerCase().includes(word) ? 1 : 0;
  });
  v[FEATURES.length] = 0.1;
  return v;
};

// Records every batch of texts the boundary is asked to embed, in order.
const calls: string[][] = [];
const embedStub: EmbedFn = async (texts) => {
  calls.push([...texts]);
  return { ok: true, vectors: texts.map(fakeVector) };
};

// resolveSearch defaults to the real binding edge; every call here passes the
// stub, so the binding must never be reached.
const untouchableAi: EmbeddingAi = {
  run: () => Promise.reject(new Error("AI binding must not be reached — embedFn is stubbed")),
};

const slug = "abcdefghjk";

// Four spine nodes (assistant never adjacent to assistant, so turn index ==
// spine index): 0 banana question, 1 weather answer, 2 a long typescript
// question that splits into two >CHUNK_MAX_CHARS windows (the dedupe case),
// 3 a prose-less node (no chunks → legitimately unsearchable).
const filler = "lorem ipsum dolor sit amet consectetur ".repeat(48); // ~1.9k chars, no feature words
const turns: Turn[] = [
  { kind: "message", role: "user", content: "Where can I buy a good banana in Oslo?" },
  { kind: "message", role: "assistant", content: "The weather tomorrow will be rainy with strong wind." },
  { kind: "message", role: "user", content: `How do I type a tuple in typescript? ${filler}\n\n${filler}` },
  { kind: "message", role: "user", content: "" },
];

// Store the paste as its real KV record so the flow exercises the same read
// boundary (getConversation normalization, overlay validation) production hits.
const storeRecord = (overlay?: ReadonlyArray<unknown>): void =>
  void kvStore.set(`paste:${slug}`, JSON.stringify({
    slug, createdAt: 1, lifetime: { kind: "pinned" }, deletedAt: null,
    turns, title: null, origin: null,
    ...(overlay === undefined ? {} : { overlay }),
  }));

console.log("A miss builds and caches the index; ranking orders the relevant turn first:");
{
  assert("the long node really needs two windows",
    turns[2] !== undefined && turns[2].kind === "message" && turns[2].content.length > CHUNK_MAX_CHARS);

  storeRecord();
  const r = await resolveSearch(kv, slug, "banana", 5, untouchableAi, embedStub);
  assert("first resolve succeeds and is not served from cache", r.ok && !r.indexCached);
  assertEq("miss embeds two batches: the chunks, then the query", calls.length, 2);
  assertEq("the chunk batch carries all four chunks (two windows for the long node)", calls[0]?.length, 4);
  assertEq("the query batch is exactly the query", calls[1], ["banana"]);
  assertEq("the index is cached under the vectors: prefix", vectorKeys().length, 1);

  if (r.ok) {
    assertEq("the banana turn ranks first", r.hits[0]?.index, 0);
    assertEq("the top hit resolves to the renderer's t<N> anchor", r.hits[0]?.anchor, "t0");
    assert("the top hit carries the node's outline label",
      (r.hits[0]?.label ?? "").includes("banana"));
    assert("scores are ranked non-increasing",
      r.hits.every((h, i, hs) => i === 0 || (hs[i - 1]?.score ?? 0) >= h.score));
    assertEq("windowed chunks dedupe to ONE hit for the long node", r.hits.filter((h) => h.index === 2).length, 1);
    assert("a prose-less node yields no hit", r.hits.every((h) => h.index !== 3));
  }
}

console.log("\nA hit re-embeds only the query:");
{
  const r = await resolveSearch(kv, slug, "weather", 5, untouchableAi, embedStub);
  assert("second resolve serves the cached index", r.ok && r.indexCached);
  assertEq("only the query was embedded", calls.length, 3);
  assertEq("that batch is exactly the query", calls[2], ["weather"]);
  if (r.ok) assertEq("the weather turn ranks first for a weather query", r.hits[0]?.index, 1);

  const t = await resolveSearch(kv, slug, "typescript", 5, untouchableAi, embedStub);
  if (t.ok) {
    assertEq("the long typescript node ranks first for its query", t.hits[0]?.index, 2);
    assert("its single hit carries the BEST window's score (the keyword window, ~1.0)",
      (t.hits[0]?.score ?? 0) > 0.9);
  }
}

console.log("\nA corrupt cached index regenerates instead of mis-scoring:");
{
  const key = vectorKeys()[0];
  assert("the cached index key exists to corrupt", key !== undefined);
  if (key !== undefined) kvStore.set(key, "not json at all");
  const r = await resolveSearch(kv, slug, "banana", 5, untouchableAi, embedStub);
  assert("resolve still succeeds, treating corruption as a miss", r.ok && !r.indexCached);
  assertEq("the chunks were re-embedded (chunk batch + query batch)", calls.length, 6);
  assertEq("the fresh index replaced the corrupt entry under the same key", vectorKeys().length, 1);
}

console.log("\nA fold-only overlay edit keeps the cached index (no readable change):");
{
  storeRecord([{ kind: "collapse", target: { kind: "turn", index: 2 } }]);
  const r = await resolveSearch(kv, slug, "banana", 5, untouchableAi, embedStub);
  assert("collapse-only overlay still hits the cache", r.ok && r.indexCached);
  assertEq("no chunk re-embed for a fold-only edit", calls.length, 7);
}

console.log("\nHiding a turn mints a new cache key and never embeds hidden content:");
{
  storeRecord([{ kind: "hide", target: { kind: "turn", index: 1 } }]);
  const r = await resolveSearch(kv, slug, "weather", 5, untouchableAi, embedStub);
  assert("content-changing overlay misses the cache", r.ok && !r.indexCached);
  assertEq("the chunks were re-embedded under the new key", calls.length, 9);
  assertEq("both content hashes now have cached indexes", vectorKeys().length, 2);
  const rechunked = calls[7] ?? [];
  assert("hidden content never reaches the embedder",
    rechunked.every((text) => !text.includes("weather tomorrow")));
  assert("the hidden turn contributes its redaction marker chunk in place",
    rechunked.some((text) => text.includes("[redacted]")));
}

console.log("\nA feature overlay omits non-featured turns from the corpus entirely:");
{
  storeRecord([{ kind: "feature", target: { kind: "turn", index: 0 } }]);
  const r = await resolveSearch(kv, slug, "banana", 5, untouchableAi, embedStub);
  assert("feature overlay misses the cache (viewable content changed)", r.ok && !r.indexCached);
  assertEq("only the featured turn's chunk is embedded", calls[9], ["Where can I buy a good banana in Oslo?"]);
  if (r.ok) {
    assertEq("hits name only the featured turn", r.hits.map((h) => h.index), [0]);
    assert("the survivor keeps its ORIGINAL spine anchor", r.hits[0]?.anchor === "t0");
  }
}

console.log("\nThe viewable-paste gate holds for search:");
{
  const missing = await resolveSearch(kv, "kjhgfedcba", "banana", 5, untouchableAi, embedStub);
  assert("an unknown slug is a 404, not a search over nothing",
    !missing.ok && missing.status === 404);
}

console.log("\nEmbedding failures surface as distinct 502s, never a silent empty result:");
{
  // A second paste so failure runs hit their own cache states without disturbing
  // the counts above. The failing embedder returns the boundary's typed refusal —
  // the same value shape a real Workers AI outage produces.
  const slug2 = "abcdefghjm";
  kvStore.set(`paste:${slug2}`, JSON.stringify({
    slug: slug2, createdAt: 1, lifetime: { kind: "pinned" }, deletedAt: null,
    turns, title: null, origin: null,
  }));
  const failStub: EmbedFn = async () => ({ ok: false, reason: "model outage" });

  // Cold cache: the CHUNK-INDEX embed is the first call to fail.
  const indexFail = await resolveSearch(kv, slug2, "banana", 5, untouchableAi, failStub);
  assert("a chunk-index embed failure is a 502 naming the indexing step",
    !indexFail.ok && indexFail.status === 502 && indexFail.error.includes("Indexing failed: model outage"));
  assertEq("a failed index is not cached (still only the first paste's three keys)", vectorKeys().length, 3);

  // Warm the cache with the good stub, then fail: only the QUERY embed remains.
  const warm = await resolveSearch(kv, slug2, "banana", 5, untouchableAi, embedStub);
  assert("the warm-up resolve builds the second paste's index", warm.ok && !warm.indexCached);
  const queryFail = await resolveSearch(kv, slug2, "banana", 5, untouchableAi, failStub);
  assert("a query embed failure on a cached index is a 502 naming the query step",
    !queryFail.ok && queryFail.status === 502 && queryFail.error.includes("Query embedding failed: model outage"));

  // A soft-deleted paste is gone from every reader surface, search included.
  kvStore.set(`paste:${slug2}`, JSON.stringify({
    slug: slug2, createdAt: 1, lifetime: { kind: "pinned" }, deletedAt: 3,
    turns, title: null, origin: null,
  }));
  const deleted = await resolveSearch(kv, slug2, "banana", 5, untouchableAi, embedStub);
  assert("a soft-deleted paste is a 410, same as /<slug>",
    !deleted.ok && deleted.status === 410);
}
