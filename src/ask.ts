// [LAW:decomposition] The pure core of ask-this-conversation: question bounds,
// context selection under a character budget, the prompt, and citation
// extraction. No I/O anywhere in this file — the effects (embedding, the DeepSeek
// call, KV) live behind their own boundaries and are orchestrated by
// askService.ts, so everything here is testable bare [LAW:effects-at-boundaries].
//
// [LAW:one-way-deps] Depends on the chat message shape (summary.ts owns the wire)
// and the scored-chunk shape (searchService owns retrieval); nothing depends back
// on this module except its orchestration and the HTTP edge.

import type { ChatMessage } from "./summary";
import type { ScoredChunk } from "./searchService";
import { turnAnchorId } from "./dialogue";

// [LAW:no-mode-explosion] The public-endpoint abuse surface, bounded as VALUES —
// no rate-limit modes, no per-caller tiers. A question longer than this is a 400
// before any KV read or model call; the answer can never spend more than
// ANSWER_MAX_TOKENS. MAX_QUESTION_CHARS is also stamped into the reader page's
// input maxlength, derived from this one constant [LAW:one-source-of-truth].
export const MAX_QUESTION_CHARS = 500;
export const ANSWER_MAX_TOKENS = 400;

// [LAW:dataflow-not-control-flow] The fixed character budget the selected
// excerpts must fit under — the same order of bound as the summary transcript's
// 24k cap. ONE selection path for every paste: a small paste's chunks all fit, a
// 450k-token transcript contributes only its top-scoring chunks. There is no
// if-small-else-retrieve branch anywhere; size is just a value the budget absorbs.
export const CONTEXT_CHAR_BUDGET = 24_000;

// [LAW:one-source-of-truth] The instruction that shapes every answer, stated
// once. The [t<N>] tag grammar here is the SAME anchor grammar the renderer
// emits (turnAnchorId) — the model cites the anchors the page can already
// navigate to, so a citation is a jump target by construction.
export const ASK_SYSTEM_PROMPT =
  "You answer questions about an AI-assistant conversation using ONLY the " +
  "provided excerpts. Each excerpt is tagged with its turn anchor, like [t4]. " +
  "Cite the excerpts that support each claim by including their tags inline, " +
  "e.g. \"The fix was to reorder the middleware [t12].\" If the excerpts do not " +
  "contain the answer, say so plainly. Answer in ONE short paragraph of plain " +
  "prose — no markdown headers, no bullet points, no preamble.";

// [LAW:dataflow-not-control-flow] Select the excerpts the prompt carries: walk
// the chunks best-score-first (stable sort — equal scores keep document order)
// and take each one while the running total still fits the budget, stopping at
// the first overflow; then restore DOCUMENT order so the model reads the
// conversation in sequence, not in relevance order. One deterministic pass for
// every corpus size. Chunk texts are ≤ CHUNK_MAX_CHARS (chunks.ts enforces), so
// the budget always admits at least the top hit.
export const selectContext = (
  scored: ReadonlyArray<ScoredChunk>,
): ReadonlyArray<ScoredChunk> => {
  const byScore = [...scored].sort((a, b) => b.score - a.score);
  const taken: ScoredChunk[] = [];
  let used = 0;
  for (const chunk of byScore) {
    if (used + chunk.text.length > CONTEXT_CHAR_BUDGET) break;
    used += chunk.text.length;
    taken.push(chunk);
  }
  return taken.sort((a, b) => a.index - b.index);
};

// [LAW:effects-at-boundaries] Pure: the messages the answer call sends. Each
// excerpt is prefixed with the renderer's own anchor id — the one tag grammar the
// system prompt teaches and extractCitedIndices reads back.
export const buildAskPrompt = (
  excerpts: ReadonlyArray<ScoredChunk>,
  question: string,
): ReadonlyArray<ChatMessage> => [
  { role: "system", content: ASK_SYSTEM_PROMPT },
  {
    role: "user",
    content:
      "Conversation excerpts:\n\n" +
      excerpts.map((c) => `[${turnAnchorId(c.index)}] ${c.text}`).join("\n\n") +
      `\n\nQuestion: ${question}`,
  },
];

// [LAW:no-defensive-null-guards] The model's answer is a trust boundary — it may
// cite well, cite turns it was never shown, or mangle the grammar. This reads
// every [t<N>] occurrence; the CALLER intersects them with the indices it
// actually provided, so a hallucinated tag can never become a citation. Pure and
// order-preserving is irrelevant here: a Set, because citing twice cites once.
export const extractCitedIndices = (answer: string): ReadonlySet<number> =>
  new Set([...answer.matchAll(/\[t(\d+)\]/g)].map((m) => Number(m[1])));
