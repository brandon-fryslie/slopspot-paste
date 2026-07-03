// [LAW:single-enforcer] This file is the ONE place the DeepSeek chat-completions
// wire format lives — the app's first LLM effect, quarantined here exactly as the
// Firecrawl scrape is quarantined in firecrawl.ts. The rest of the codebase asks
// for "a TL;DR of this dialogue"; if DeepSeek's request shape, base URL, or
// response envelope changes, only this file changes.
//
// [LAW:effects-at-boundaries] The module splits cleanly: buildSummaryPrompt /
// summaryRequestBody / extractSummary are PURE (no I/O, testable without mocking
// fetch); summarize is the single edge that touches the network. The pure core
// returns a DESCRIPTION of the request; the edge performs it.
//
// [LAW:types-are-the-program] SummaryResult is a discriminated union — every
// failure mode is a representable value, no throws across the module boundary.
// A missing key is not a crash: it is ok:false with configured:false, so the
// endpoint can answer "not configured" cleanly instead of 500ing.

import type { Dialogue, SpineNode, AssistantBlock } from "./dialogue";
import { blockVisibility } from "./dialogue";
import type { Turn } from "./types";

export type SummaryResult =
  | { readonly ok: true; readonly summary: string }
  // [LAW:no-silent-failure] `configured` distinguishes "this deployment has no
  // DEEPSEEK_API_TOKEN" (a config truth the endpoint maps to 503, never a 500)
  // from a genuine provider/network failure (configured:true). The reason string
  // is human-readable; `configured` is what the boundary branches on.
  | { readonly ok: false; readonly configured: boolean; readonly reason: string };

export interface SummaryEnv {
  readonly DEEPSEEK_API_TOKEN?: string;
}

// [LAW:single-enforcer] DeepSeek is OpenAI-compatible; this is the one endpoint,
// model, and timeout the summary path uses. deepseek-chat is DeepSeek's routed
// general model (verified against the live API — the response echoes the resolved
// model in its `model` field; we request the stable alias).
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

// [LAW:single-enforcer] One timeout governs the summarization fetch. An LLM call
// is slower than a scrape but must still fail fast with a typed reason rather than
// tie up the Worker to the platform ceiling.
const SUMMARY_TIMEOUT_MS = 30_000;

// [LAW:dataflow-not-control-flow] A pure bound on prompt size, applied as a value
// (truncate + marker), never a branch that skips turns. Caps token cost for a very
// long transcript; the tail is dropped with an explicit marker so the model — and
// any reader debugging the prompt — knows the transcript was clipped, not that the
// conversation ended there [LAW:no-silent-failure].
const MAX_TRANSCRIPT_CHARS = 24_000;

// [LAW:one-source-of-truth] The instruction that shapes every TL;DR, stated once.
// A change here re-derives every future summary; nothing about it is stored per
// paste, so it is never coupled to the summaries already cached.
export const SUMMARY_SYSTEM_PROMPT =
  "You summarize AI-assistant transcripts for a reader deciding whether to read " +
  "the full conversation. Output ONE paragraph, 2-3 sentences, plain prose, no " +
  "preamble, no markdown headers, no bullet points. Describe what was asked and " +
  "what was concluded.";

// [LAW:types-are-the-program] The chat message shape DeepSeek accepts (the OpenAI
// contract). Narrowed to the two roles this path emits.
export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

// [LAW:effects-at-boundaries] Pure: the readable-text projection of one spine node
// the summary prompt shows the model. An assistant turn contributes only its
// spine-visible prose (text + insight) — the same blocks BLOCK_VISIBILITY marks as
// the reader-facing conversation, so the summary is built from what a human reads,
// not from collapsed thinking/tool noise. [LAW:one-source-of-truth] visibility is
// read from the single classifier, never re-decided here.
const spineVisibleProse = (blocks: ReadonlyArray<AssistantBlock>): string =>
  blocks
    .filter((b) => blockVisibility(b) === "spine")
    .map((b) => (b.kind === "text" || b.kind === "insight" ? b.content : ""))
    .filter((s) => s.length > 0)
    .join("\n\n");

const nodeTranscript = (node: SpineNode): string => {
  if (node.kind === "spoken") {
    const speaker = node.role === "user" ? "User" : "System";
    return `[${speaker}]: ${node.content}`;
  }
  const prose = spineVisibleProse(node.blocks);
  return prose.length > 0 ? `[Assistant]: ${prose}` : "";
};

// [LAW:effects-at-boundaries] Pure: flatten the derived Dialogue into the plain
// transcript the model reads. Deterministic in its input — the same dialogue
// yields the same text, which is why the cache can key on a hash of the turns it
// derives from.
export const renderDialogueForPrompt = (dialogue: Dialogue): string => {
  const full = dialogue
    .map(nodeTranscript)
    .filter((s) => s.length > 0)
    .join("\n\n");
  return full.length > MAX_TRANSCRIPT_CHARS
    ? full.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n[transcript truncated]"
    : full;
};

// [LAW:effects-at-boundaries] Pure: the messages array. Fully testable — a given
// dialogue maps to a fixed prompt with no fetch.
export const buildSummaryPrompt = (dialogue: Dialogue): ReadonlyArray<ChatMessage> => [
  { role: "system", content: SUMMARY_SYSTEM_PROMPT },
  { role: "user", content: `Summarize this conversation:\n\n${renderDialogueForPrompt(dialogue)}` },
];

// [LAW:effects-at-boundaries] Pure request body — testable without mocking fetch,
// the twin of scrapeRequestBody. temperature is low so the same transcript summarizes
// stably; stream:false because the endpoint returns one JSON body.
export const summaryRequestBody = (dialogue: Dialogue) => ({
  model: DEEPSEEK_MODEL,
  messages: buildSummaryPrompt(dialogue),
  max_tokens: 300,
  temperature: 0.3,
  stream: false,
});

// [LAW:types-are-the-program] The slice of the DeepSeek response envelope this
// path reads, captured from a real call (see the fixture in scripts/parser-check).
// Every field optional because KV/network is a trust boundary — extractSummary
// classifies, it does not assume.
interface CompletionResponse {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>;
}

// [LAW:no-defensive-null-guards] This IS a trust boundary — DeepSeek is an external
// service whose response shape we cannot prove. The guards classify the wire payload
// into the typed union and stop; downstream receives a structurally valid value.
// Pure: takes the already-parsed body, so it is exercised directly against the real
// captured fixture with no fetch.
export const extractSummary = (body: CompletionResponse | null): SummaryResult => {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    return { ok: false, configured: true, reason: "DeepSeek returned no summary content." };
  }
  return { ok: true, summary: content.trim() };
};

// [LAW:one-source-of-truth] The cache key's content component: a hash of the turns,
// which are themselves the derived authority the summary projects. Turns unchanged →
// hash unchanged → cache hit; any edit/refetch changes the turns and mints a new key,
// so a cached summary can never be served for content it does not describe. The model
// name/version is deliberately NOT part of this key — a summary is a disposable
// projection, regenerated on read, never stored authority coupled to its writer
// [LAW:no-ambient-temporal-coupling].
export const turnsContentHash = async (turns: ReadonlyArray<Turn>): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(turns));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// [LAW:effects-at-boundaries] The single edge. All network activity for summarization
// lives here; the interior above is pure. Returns the typed union — no throw crosses
// this boundary, so the endpoint's ok:false path always runs predictably.
export const summarize = async (dialogue: Dialogue, env: SummaryEnv): Promise<SummaryResult> => {
  const key = env.DEEPSEEK_API_TOKEN;
  if (!key) {
    return {
      ok: false,
      configured: false,
      reason:
        "Summarization is not configured (DEEPSEEK_API_TOKEN missing). " +
        "Set the secret via `wrangler secret put DEEPSEEK_API_TOKEN`.",
    };
  }

  // [LAW:types-are-the-program] The catch returns the rejection value, then
  // `instanceof Response` narrows success from failure — a timeout (DOMException
  // TimeoutError from AbortSignal.timeout) becomes a distinct typed reason.
  const response = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(summaryRequestBody(dialogue)),
    signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
  }).catch((e: unknown): unknown => e);

  if (!(response instanceof Response)) {
    const timedOut = response instanceof DOMException && response.name === "TimeoutError";
    return {
      ok: false,
      configured: true,
      reason: timedOut
        ? `DeepSeek request timed out after ${SUMMARY_TIMEOUT_MS / 1000}s.`
        : "DeepSeek request failed (network error).",
    };
  }
  if (!response.ok) {
    return { ok: false, configured: true, reason: `DeepSeek returned HTTP ${response.status}.` };
  }

  const body = (await response.json().catch(() => null)) as CompletionResponse | null;
  return extractSummary(body);
};
