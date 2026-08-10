// Ask-this-conversation orchestration checks (slopspot-ask-rag-a3k.6). Run:
// `tsx scripts/ask-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure.
// [LAW:verifiable-goals] resolveAsk is driven end-to-end with an in-memory KV, a
// stubbed embedder, and a stubbed LLM — no network, every outcome asserted: an
// over-length question 4xxs BEFORE any KV read or model call, retrieval feeds
// the prompt bounded by the character budget in document order, the answer flows
// through the typed outcome, citations resolve only to excerpts the model was
// shown, and provider failures map to distinct statuses.
// [LAW:behavior-not-structure] The stubs record exactly what the boundaries
// RECEIVE — the embedded texts and the prompt messages — so assertions pin the
// wire-visible contract, not the service's internal shape.

import { EMBEDDING_DIMS } from "../src/embeddings";
import type { EmbeddingAi } from "../src/embeddings";
import type { EmbedFn } from "../src/searchService";
import { resolveAsk, type ChatFn } from "../src/askService";
import {
  ANSWER_MAX_TOKENS,
  ASK_SYSTEM_PROMPT,
  CONTEXT_CHAR_BUDGET,
  MAX_QUESTION_CHARS,
  extractCitedIndices,
} from "../src/ask";
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

// The Map-backed PasteKv slice, with a read counter so the over-length test can
// prove the 400 happens before ANY storage work.
const kvStore = new Map<string, string>();
let kvReads = 0;
const kv: Pick<PasteKv, "get" | "put"> = {
  get: async (key) => {
    kvReads += 1;
    return kvStore.get(key) ?? null;
  },
  put: async (key, value) => void kvStore.set(key, value),
};

// The same deterministic fake embedder as search-check: feature dimensions from
// keyword presence plus a shared base dimension, so the keyword-bearing chunk
// outranks filler by cosine with no model in sight.
const FEATURES = ["typescript"];
const fakeVector = (text: string): number[] => {
  const v: number[] = new Array<number>(EMBEDDING_DIMS).fill(0);
  FEATURES.forEach((word, i) => {
    v[i] = text.toLowerCase().includes(word) ? 1 : 0;
  });
  v[FEATURES.length] = 0.1;
  return v;
};

const embedCalls: string[][] = [];
const embedStub: EmbedFn = async (texts) => {
  embedCalls.push([...texts]);
  return { ok: true, vectors: texts.map(fakeVector) };
};

// The chat stub records the exact messages and options the boundary receives and
// returns a scripted answer — the same typed ChatResult the real edge produces.
type ChatCall = { messages: ReadonlyArray<{ role: string; content: string }>; maxTokens: number };
const chatCalls: ChatCall[] = [];
let scriptedAnswer = "";
const chatStub: ChatFn = async (messages, options) => {
  chatCalls.push({ messages, maxTokens: options.maxTokens });
  return { ok: true, content: scriptedAnswer };
};

const untouchableAi: EmbeddingAi = {
  run: () => Promise.reject(new Error("AI binding must not be reached — embedFn is stubbed")),
};

const slug = "abcdefghjk";

// 15 spine nodes, user/assistant alternating so turn index == spine index:
// index 5 carries the typescript keyword (the known-relevant turn); every other
// turn is ~1.9k chars of filler, so the corpus (~26.6k chars) EXCEEDS the 24k
// context budget and the lowest-ranked tail must be dropped by selection.
const filler = "lorem ipsum dolor sit amet consectetur ".repeat(48); // ~1.9k chars
const turns: Turn[] = Array.from({ length: 15 }, (_, i): Turn => ({
  kind: "message",
  role: i % 2 === 0 ? "user" : "assistant",
  content: i === 5 ? "How do I type a tuple in typescript?" : filler,
}));
assert("the corpus really exceeds the context budget",
  turns.reduce((n, t) => n + (t.kind === "message" ? t.content.length : 0), 0) > CONTEXT_CHAR_BUDGET);

kvStore.set(`paste:${slug}`, JSON.stringify({
  slug, createdAt: 1, lifetime: { kind: "pinned" }, deletedAt: null,
  turns, title: null, origin: null,
}));

console.log("An over-length question is a 400 with no KV read, no embed, no model call:");
{
  const long = "x".repeat(MAX_QUESTION_CHARS + 1);
  const r = await resolveAsk(kv, slug, long, 5, untouchableAi, {}, embedStub, chatStub);
  assert("over-length question is rejected as a 400",
    !r.ok && r.status === 400 && r.error.includes(String(MAX_QUESTION_CHARS)));
  assertEq("the 400 happened before any KV read", kvReads, 0);
  assertEq("no embedding call was made", embedCalls.length, 0);
  assertEq("no model call was made", chatCalls.length, 0);

  // Probe the boundary against an UNKNOWN slug: a 404 (not 400) proves the cap
  // admits an exactly-at-cap question without warming this paste's vector index,
  // which the fresh-index assertions below depend on staying cold.
  const exact = "x".repeat(MAX_QUESTION_CHARS);
  const ok = await resolveAsk(kv, "kjhgfedcba", exact, 5, untouchableAi, {}, embedStub, chatStub);
  assert("a question exactly at the cap is NOT rejected as over-length",
    !ok.ok && ok.status === 404);
}

console.log("\nRetrieval feeds the prompt: budgeted, tagged, in document order:");
{
  embedCalls.length = 0;
  chatCalls.length = 0;
  scriptedAnswer = "Use a tuple type [t5]. The rest is filler [t99] and [t14].";
  const r = await resolveAsk(kv, slug, "how do I type a tuple in typescript?", 5, untouchableAi, {}, embedStub, chatStub);
  assert("the ask succeeds on a fresh index", r.ok && !r.indexCached);
  assertEq("the retrieval embedded two batches: the chunks, then the question", embedCalls.length, 2);
  assertEq("the chunk batch carries one chunk per prose turn", embedCalls[0]?.length, 15);
  assertEq("one model call was made", chatCalls.length, 1);

  const call = chatCalls[0];
  const sys = call?.messages[0];
  const user = call?.messages[1];
  assertEq("the system message is the one ask instruction", sys?.content, ASK_SYSTEM_PROMPT);
  assertEq("max_tokens is the strict answer bound, as a value on the wire", call?.maxTokens, ANSWER_MAX_TOKENS);
  const content = user?.content ?? "";
  assert("the prompt carries the question", content.includes("how do I type a tuple in typescript?"));
  assert("the top-scoring excerpt is present, tagged with its renderer anchor",
    content.includes("[t5] How do I type a tuple in typescript?"));
  assert("the excerpt block stays within the character budget (plus tag/joiner overhead)",
    content.length < CONTEXT_CHAR_BUDGET + 2_000);
  assert("the budget dropped the lowest-ranked tail (its tag never reaches the prompt)",
    !content.includes("[t14]"));
  assert("excerpts read in DOCUMENT order, not relevance order",
    content.indexOf("[t4]") < content.indexOf("[t5]") && content.indexOf("[t5]") < content.indexOf("[t6]"));

  if (r.ok) {
    assertEq("the scripted answer flows through unchanged", r.answer, scriptedAnswer);
    assertEq("citations resolve ONLY to excerpts the model was shown ([t99] absent, [t14] never provided)",
      r.citations.map((c) => c.index), [5]);
    assertEq("a citation carries the renderer's t<N> anchor", r.citations[0]?.anchor, "t5");
    assert("a citation carries the outline label the minimap shows",
      (r.citations[0]?.label ?? "").length > 0);
  }
}

console.log("\nA second ask serves the cached vector index (only the question re-embeds):");
{
  embedCalls.length = 0;
  scriptedAnswer = "Still a tuple [t5].";
  const r = await resolveAsk(kv, slug, "tuples in typescript?", 5, untouchableAi, {}, embedStub, chatStub);
  assert("the second ask reports the cached index", r.ok && r.indexCached);
  assertEq("only the question was embedded", embedCalls.length, 1);
  assertEq("that batch is exactly the question", embedCalls[0], ["tuples in typescript?"]);
}

console.log("\nThe viewable-paste gate holds for ask:");
{
  const missing = await resolveAsk(kv, "kjhgfedcba", "anything?", 5, untouchableAi, {}, embedStub, chatStub);
  assert("an unknown slug is a 404, not an answer about nothing",
    !missing.ok && missing.status === 404);
}

console.log("\nProvider failures map to distinct statuses, never a silent empty answer:");
{
  const providerDown: ChatFn = async () => ({ ok: false, configured: true, reason: "model outage" });
  const down = await resolveAsk(kv, slug, "anything?", 5, untouchableAi, {}, embedStub, providerDown);
  assert("a provider failure is a 502 naming the answering step",
    !down.ok && down.status === 502 && down.error.includes("Answering failed: model outage"));

  const notConfigured: ChatFn = async () => ({ ok: false, configured: false, reason: "no token" });
  const unconf = await resolveAsk(kv, slug, "anything?", 5, untouchableAi, {}, embedStub, notConfigured);
  assert("a missing token is a 503 not-configured, distinct from 502",
    !unconf.ok && unconf.status === 503 && unconf.error === "no token");

  const embedDown: EmbedFn = async () => ({ ok: false, reason: "embed outage" });
  kvStore.delete([...kvStore.keys()].find((k) => k.startsWith("vectors:")) ?? "");
  const noIndex = await resolveAsk(kv, slug, "anything?", 5, untouchableAi, {}, embedDown, chatStub);
  assert("an embedding failure surfaces as the scoring core's 502",
    !noIndex.ok && noIndex.status === 502 && noIndex.error.includes("Indexing failed: embed outage"));
}

console.log("\nCitation extraction is a pure read of the tag grammar:");
{
  assertEq("duplicate tags cite once", [...extractCitedIndices("see [t2] and again [t2]")], [2]);
  assertEq("prose without tags cites nothing", [...extractCitedIndices("no citations here")], []);
  assertEq("a malformed tag is not a citation", [...extractCitedIndices("[tx] [t] [ t3 ]")], []);
}
