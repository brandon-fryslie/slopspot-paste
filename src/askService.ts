// [LAW:decomposition] The ask-this-conversation ORCHESTRATION, cut at the exact
// seams summaryService and searchService cut: the embedding wire lives in
// embeddings.ts, the DeepSeek wire in summary.ts, retrieval in searchService's
// scoreChunksForQuery, the pure prompt/selection/citation logic in ask.ts, and
// the HTTP endpoint only decodes the request and shapes the response. This part
// owns the one policy: bound the question, gate the paste, retrieve through the
// shared scoring core, pack the budgeted excerpts into the prompt, answer through
// the shared chat edge, and keep only the citations the excerpts can support.
//
// [LAW:effects-at-boundaries] Both effects enter as VALUES — embedFn and chatFn
// default to the real boundaries, and the check script (scripts/ask-check.ts)
// passes stubs, so the whole policy is verifiable with no Worker and no network.
//
// [LAW:one-source-of-truth] Nothing here is stored: the answer is the most
// disposable projection of all — derived per question, never cached (the question
// space is unbounded, so a cache would be a growing second copy of nothing
// authoritative). Only the vector index is cached, and that belongs to the
// scoring core.

import { loadViewablePaste } from "./loadPaste";
import { deriveViewableDialogue } from "./overlay";
import { deriveSpineOutline, type OutlineEntry } from "./spineOutline";
import { scoreChunksForQuery, type EmbedFn } from "./searchService";
import { embedTexts as realEmbedTexts, type EmbeddingAi } from "./embeddings";
import {
  chatComplete as realChatComplete,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type SummaryEnv,
} from "./summary";
import {
  ANSWER_MAX_TOKENS,
  MAX_QUESTION_CHARS,
  buildAskPrompt,
  extractCitedIndices,
  selectContext,
} from "./ask";
import type { PasteKv } from "./storage";

// [LAW:types-are-the-program] The orchestration's total outcome. Citations are
// OutlineEntry values — the SAME index/anchor/role/label the outline, minimap,
// and search hits carry — so a citation can never name a turn the renderer
// didn't emit [LAW:one-source-of-truth]. 400 is here (unlike summaryService's
// outcome) because the question-length cap is THIS policy's bound, enforced once
// where the stubbed test can prove no model call follows it [LAW:single-enforcer];
// the handler's own 400 covers only a malformed body.
export type AskOutcome =
  | {
      readonly ok: true;
      readonly answer: string;
      readonly citations: ReadonlyArray<OutlineEntry>;
      readonly indexCached: boolean;
    }
  | { readonly ok: false; readonly status: 400 | 404 | 410 | 502 | 503; readonly error: string };

// The injectable shape of the chat boundary — exactly chatComplete's signature,
// so the real function is assignable with no adapter.
export type ChatFn = (
  messages: ReadonlyArray<ChatMessage>,
  options: ChatOptions,
  env: SummaryEnv,
) => Promise<ChatResult>;

export const resolveAsk = async (
  // [LAW:composability] The structural KV slice (storage.PasteKv): env.PASTES
  // assigns as-is, and the check script drives the whole flow with a Map-backed stub.
  kv: Pick<PasteKv, "get" | "put">,
  slug: string,
  question: string,
  now: number,
  ai: EmbeddingAi,
  env: SummaryEnv,
  embedFn: EmbedFn = realEmbedTexts,
  chatFn: ChatFn = realChatComplete,
): Promise<AskOutcome> => {
  // [LAW:no-silent-failure] The length bound rejects BEFORE any KV read or model
  // call — an over-length question costs nothing and says exactly why.
  if (question.length > MAX_QUESTION_CHARS) {
    return {
      ok: false,
      status: 400,
      error: `Question too long (max ${MAX_QUESTION_CHARS} characters).`,
    };
  }

  // [LAW:single-enforcer] The one viewable-paste gate — the same one /<slug>,
  // /api/summarize, and /api/search resolve through.
  const load = await loadViewablePaste(kv, slug, now);
  if (!load.ok) return { ok: false, status: load.status, error: load.message };

  // [LAW:single-enforcer] Retrieval IS the search path: same viewable projection,
  // same chunk authority, same cached vector index, same cosine — never a second
  // retrieval implementation for RAG.
  const view = deriveViewableDialogue(load.conversation);
  const outcome = await scoreChunksForQuery(kv, slug, view, question, ai, embedFn);
  if (!outcome.ok) return outcome;

  const excerpts = selectContext(outcome.scored);
  const result = await chatFn(buildAskPrompt(excerpts, question), { maxTokens: ANSWER_MAX_TOKENS }, env);
  if (!result.ok) {
    // [LAW:no-silent-failure] A missing key is a config truth (503 not-configured),
    // distinct from a genuine provider failure (502) — the summaryService mapping.
    return result.configured
      ? { ok: false, status: 502, error: `Answering failed: ${result.reason}` }
      : { ok: false, status: 503, error: result.reason };
  }

  // [LAW:types-are-the-program] A citation is only real if the model was SHOWN
  // that excerpt: intersect the tags it emitted with the indices the prompt
  // carried, then materialize them as outline entries in document order. A
  // hallucinated [t99] — or a real turn the excerpts never included — is thereby
  // unrepresentable as a citation, so the UI can linkify blindly.
  const cited = extractCitedIndices(result.content);
  const provided = new Set(excerpts.map((c) => c.index));
  const citations = deriveSpineOutline(view).filter(
    (entry) => cited.has(entry.index) && provided.has(entry.index),
  );

  return { ok: true, answer: result.content, citations, indexCached: outcome.indexCached };
};
