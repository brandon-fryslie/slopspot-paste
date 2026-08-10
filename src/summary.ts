// [LAW:single-enforcer] This file is the ONE place the DeepSeek chat-completions
// wire format lives — the app's first LLM effect, quarantined here exactly as the
// Firecrawl scrape is quarantined in firecrawl.ts. The rest of the codebase asks
// for "a chat completion of these messages" (chatComplete — the TL;DR and the
// ask-this-conversation answer both route through it); if DeepSeek's request
// shape, base URL, or response envelope changes, only this file changes.
//
// [LAW:effects-at-boundaries] The module splits cleanly: buildSummaryPrompt /
// chatRequestBody / extractContent are PURE (no I/O, testable without mocking
// fetch); chatComplete is the single edge that touches the network. The pure core
// returns a DESCRIPTION of the request; the edge performs it.
//
// [LAW:types-are-the-program] ChatResult is a discriminated union — every
// failure mode is a representable value, no throws across the module boundary.
// A missing key is not a crash: it is ok:false with configured:false, so the
// endpoint can answer "not configured" cleanly instead of 500ing.

import type { Dialogue } from "./dialogue";
import { contentHash } from "./contentHash";
import { renderDialogueTranscript } from "./transcript";

// The completion edge's total outcome: model content, or a typed refusal.
export type ChatResult =
  | { readonly ok: true; readonly content: string }
  // [LAW:no-silent-failure] `configured` distinguishes "this deployment has no
  // DEEPSEEK_API_TOKEN" (a config truth the endpoint maps to 503, never a 500)
  // from a genuine provider/network failure (configured:true). The reason string
  // is human-readable; `configured` is what the boundary branches on.
  | { readonly ok: false; readonly configured: boolean; readonly reason: string };

// The summary flavour of ChatResult: same failure arm, content named for what it
// is at this call site. summarize maps one onto the other; no consumer re-parses.
export type SummaryResult =
  | { readonly ok: true; readonly summary: string }
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

// [LAW:single-enforcer] One timeout governs every DeepSeek fetch. An LLM call
// is slower than a scrape but must still fail fast with a typed reason rather than
// tie up the Worker to the platform ceiling.
const CHAT_TIMEOUT_MS = 30_000;

// [LAW:one-source-of-truth] The summary's output bound, stated once — the request
// body and the summarize wrapper both read it.
const SUMMARY_MAX_TOKENS = 300;

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

// [LAW:effects-at-boundaries] Pure: the plain transcript the model reads, built from the
// ONE dialogue->text projection (transcript.ts) and then bounded to the summary's token
// budget. The tail cap is THIS reader's policy — a summary needs the gist, so dropping the
// tail with an explicit marker is honest here [LAW:no-silent-failure]; the projection
// itself stays untruncated so a different reader (the continuation bundle) can keep the
// tail it depends on. Deterministic in its input, which is why the cache can key on a hash
// of the dialogue it derives from.
export const renderDialogueForPrompt = (dialogue: Dialogue): string => {
  const full = renderDialogueTranscript(dialogue);
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

// [LAW:types-are-the-program] The per-call knobs a caller of the chat edge owns:
// the messages, and the strict output bound. The abuse surface of a public LLM
// endpoint is bounded by VALUES — max_tokens caps what a single call can spend —
// never by trusting the prompt to keep the model short.
export interface ChatOptions {
  readonly maxTokens: number;
}

// [LAW:effects-at-boundaries] Pure request body — testable without mocking fetch,
// the twin of scrapeRequestBody. The ONE builder of the wire body: model, low
// temperature (the same input completes stably), and stream:false (the endpoint
// returns one JSON body) are the edge's own policy; messages and max_tokens are
// the caller's values [LAW:one-source-of-truth].
export const chatRequestBody = (
  messages: ReadonlyArray<ChatMessage>,
  options: ChatOptions,
) => ({
  model: DEEPSEEK_MODEL,
  messages,
  max_tokens: options.maxTokens,
  temperature: 0.3,
  stream: false,
});

// The summary call's request: its prompt, its output bound, through the one builder.
export const summaryRequestBody = (dialogue: Dialogue) =>
  chatRequestBody(buildSummaryPrompt(dialogue), { maxTokens: SUMMARY_MAX_TOKENS });

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
// captured fixture with no fetch. The ONE classifier of the completion envelope
// [LAW:single-enforcer]; extractSummary below is its summary-named projection.
export const extractContent = (body: CompletionResponse | null): ChatResult => {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    return { ok: false, configured: true, reason: "DeepSeek returned no completion content." };
  }
  return { ok: true, content: content.trim() };
};

export const extractSummary = (body: CompletionResponse | null): SummaryResult => {
  const result = extractContent(body);
  return result.ok ? { ok: true, summary: result.content } : result;
};

// [LAW:one-source-of-truth] The cache key's content component: a hash of the exact
// VIEWABLE dialogue the prompt reads — the overlay-applied projection every reader
// surface shows — never the raw turns. Hashing the prompt's own input means the key
// and the prompt cannot disagree: a content edit OR an overlay edit that changes what
// a reader sees mints a new key (so a summary generated from previously-visible
// content stops being served the moment the owner hides that content), while an edit
// that leaves the readable nodes untouched (a collapse fold) keeps the key — the
// prompt input is unchanged, so the cached summary still describes it. The model
// name/version is deliberately NOT part of this key — a summary is a disposable
// projection, regenerated on read, never stored authority coupled to its writer
// [LAW:no-ambient-temporal-coupling]. The hash construction itself lives in
// contentHash.ts — the one move shared with the vector-index key [LAW:single-enforcer].
export const dialogueContentHash = (dialogue: Dialogue): Promise<string> =>
  contentHash(dialogue);

// [LAW:effects-at-boundaries] The single edge. ALL network activity against
// DeepSeek lives here — the TL;DR and the ask answer are both this one call with
// different messages and bounds; the interior above is pure. Returns the typed
// union — no throw crosses this boundary, so every caller's ok:false path always
// runs predictably.
export const chatComplete = async (
  messages: ReadonlyArray<ChatMessage>,
  options: ChatOptions,
  env: SummaryEnv,
): Promise<ChatResult> => {
  const key = env.DEEPSEEK_API_TOKEN;
  if (!key) {
    return {
      ok: false,
      configured: false,
      reason:
        "The language model is not configured (DEEPSEEK_API_TOKEN missing). " +
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
    body: JSON.stringify(chatRequestBody(messages, options)),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  }).catch((e: unknown): unknown => e);

  if (!(response instanceof Response)) {
    const timedOut = response instanceof DOMException && response.name === "TimeoutError";
    return {
      ok: false,
      configured: true,
      reason: timedOut
        ? `DeepSeek request timed out after ${CHAT_TIMEOUT_MS / 1000}s.`
        : "DeepSeek request failed (network error).",
    };
  }
  if (!response.ok) {
    return { ok: false, configured: true, reason: `DeepSeek returned HTTP ${response.status}.` };
  }

  const body = (await response.json().catch(() => null)) as CompletionResponse | null;
  return extractContent(body);
};

// The summary flavour of the edge: its prompt, its output bound, its named result.
export const summarize = async (dialogue: Dialogue, env: SummaryEnv): Promise<SummaryResult> => {
  const result = await chatComplete(buildSummaryPrompt(dialogue), { maxTokens: SUMMARY_MAX_TOKENS }, env);
  return result.ok ? { ok: true, summary: result.content } : result;
};
