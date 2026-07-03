// [LAW:decomposition] The summarization ORCHESTRATION, cut apart from both the LLM
// boundary (summary.ts, which only knows DeepSeek's wire format) and the HTTP
// endpoint (which only decodes the request and shapes the response). This part owns
// the one policy: resolve a viewable paste, key a disposable summary by its turns'
// content hash, serve the cache when it matches, else generate once and cache. The
// endpoint is a thin wrapper; slice .3's regenerate affordance reuses THIS, not a
// second copy of the flow.
//
// [LAW:effects-at-boundaries] The LLM effect enters as a VALUE — `summarizeFn`
// defaults to the real network boundary, but a caller (a test) can pass a stub, so
// the whole gate/hash/cache policy is verifiable without touching the network. The
// KV effect is likewise the passed-in namespace, not an ambient import.
//
// [LAW:one-source-of-truth] The TL;DR is a disposable projection: keyed by
// slug + turnsContentHash, regenerated on a miss, never stored on the conversation
// and never coupled to the model version that wrote it [LAW:no-ambient-temporal-coupling].

import { loadViewablePaste } from "./loadPaste";
import { deriveDialogue } from "./dialogue";
import { summarize as realSummarize, turnsContentHash, type SummaryEnv, type SummaryResult } from "./summary";
import { getCachedSummary, putCachedSummary } from "./storage";
import type { Dialogue } from "./dialogue";

// [LAW:types-are-the-program] The orchestration's total outcome: a summary (with
// whether it came from cache) or the exact HTTP status+message the endpoint must
// emit. The gate's 404/410/503 flow straight through; a provider failure becomes a
// 502, a missing key a 503 — three distinct truths the endpoint never re-derives.
// [LAW:types-are-the-program] The status arm lists exactly what resolveSummary
// produces: 404/410 from the gate, and 502 (provider failed) / 503 (not configured)
// from the summarize path. 400 (missing slug) is NOT here — that is the HTTP handler's
// concern, produced before this function is called, so the type never advertises a
// status this function cannot return.
export type SummaryOutcome =
  | { readonly ok: true; readonly summary: string; readonly cached: boolean }
  | { readonly ok: false; readonly status: 404 | 410 | 502 | 503; readonly error: string };

// The injectable shape of the LLM boundary — exactly summarize's signature, so the
// real function is assignable with no adapter.
export type SummarizeFn = (dialogue: Dialogue, env: SummaryEnv) => Promise<SummaryResult>;

export const resolveSummary = async (
  kv: KVNamespace,
  slug: string,
  now: number,
  env: SummaryEnv,
  // [LAW:dataflow-not-control-flow] Regenerate is not a second flow — it is this
  // same resolve with the cache READ bypassed. `force` is a value, not a mode: it
  // collapses `cached` to null below, feeding the one existing miss path
  // (generate → overwrite). A forced call is exactly a call that treats every read
  // as a miss. Defaults false so the endpoint's normal path serves the cache.
  force: boolean = false,
  summarizeFn: SummarizeFn = realSummarize,
): Promise<SummaryOutcome> => {
  // [LAW:single-enforcer] The one viewable-paste gate. Its rejection carries the
  // status the reader surface must emit; map it straight through so this surface
  // agrees with /<slug> by construction.
  const load = await loadViewablePaste(kv, slug, now);
  if (!load.ok) return { ok: false, status: load.status, error: load.message };

  const { turns } = load.conversation;
  // [LAW:one-source-of-truth] Hash the turns (the derived authority the summary
  // projects); the Dialogue the prompt reads derives from the same turns.
  const hash = await turnsContentHash(turns);

  // [LAW:one-source-of-truth] `force` bypasses the cache READ, never the WRITE. A
  // regenerate re-derives from the authoritative turns and overwrites the SAME
  // disposable key (same turns → same hash → same key) below, replacing the stale
  // projection in place rather than minting a second entry. This is the sanctioned
  // regenerate path precisely because the cache is disposable by design — the model
  // improves with no content change to bust the key, so a reader forces a fresh one.
  const cached = force ? null : await getCachedSummary(kv, slug, hash);
  if (cached !== null) return { ok: true, summary: cached, cached: true };

  // [LAW:effects-at-boundaries] The LLM call happens exactly here, only on a miss.
  const result = await summarizeFn(deriveDialogue(turns), env);
  if (!result.ok) {
    // [LAW:no-silent-failure] A missing key is a config truth (503 not-configured),
    // distinct from a genuine provider failure (502). Neither is a 500 crash.
    return result.configured
      ? { ok: false, status: 502, error: `Summarization failed: ${result.reason}` }
      : { ok: false, status: 503, error: result.reason };
  }

  await putCachedSummary(kv, slug, hash, result.summary);
  return { ok: true, summary: result.summary, cached: false };
};
