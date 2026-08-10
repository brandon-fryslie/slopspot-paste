// [LAW:decomposition] The compare-only freshness check ORCHESTRATION (slopspot-
// freshness-eck.4) — the NON-MUTATING sibling of /api/refetch, shaped like
// resolveSummary: gate the paste, key a disposable verdict by the stored bytes'
// content hash, serve the cache when it matches, else fetch the live page once,
// decide, and cache the verdict. The HTTP endpoint is a thin wrapper.
//
// [LAW:single-enforcer] The compare decision is planRefetch — the ONE statement of
// what "unchanged" means (bytes-equality of the fetched markdown, freshness.ts) —
// so this check and the admin refetch can never disagree about whether the live
// page drifted. applyRefetchPlan is deliberately NEVER called here: the plan's
// kind is read as a verdict and the write half is discarded, so the paste record
// and its version archive see zero writes from a public check. Checking is public
// and read-only; adopting the new version remains the privileged /sloppy refetch.
//
// [LAW:effects-at-boundaries] The upstream fetch enters as a VALUE — `fetchFresh`
// is the injected network boundary (the endpoint passes the real ingestPaste arm;
// the check script passes a counting stub), so the whole gate/hash/cache/compare
// policy is verifiable off the network.

import { contentHash } from "./contentHash";
import { planRefetch } from "./freshness";
import { isFreshnessVerdict, type FreshnessVerdict } from "./freshnessView";
import { loadViewablePaste } from "./loadPaste";
import { getCachedFreshness, putCachedFreshness, type PasteKv } from "./storage";
import { isUrlPaste, type ParseResult } from "./types";

// [LAW:types-are-the-program] The orchestration's total outcome: a verdict (with
// when it was decided and whether it came from cache) or the exact HTTP
// status+message the endpoint must emit. The gate's 404/410/503 flow straight
// through; a non-url paste is a 409 and a failed live fetch a 422 — the same
// statuses /api/refetch speaks for the same truths — and 500 closes the
// ingest-shape enumeration gap loudly, mirroring the refetch route.
export type FreshnessOutcome =
  | {
      readonly ok: true;
      readonly verdict: FreshnessVerdict;
      readonly checkedAt: number;
      readonly cached: boolean;
    }
  | { readonly ok: false; readonly status: 404 | 409 | 410 | 422 | 500 | 503; readonly error: string };

// The injectable shape of the network boundary: fetch + parse one live page.
export type FetchFreshFn = (url: string) => Promise<ParseResult>;

// [LAW:types-are-the-program] KV is a trust boundary: the cached entry is unknown
// JSON until classified here, at the one read boundary of the value's owner (the
// storage layer stores strings — searchService's parseCachedIndex move). A corrupt
// entry is dropped LOUDLY and treated as a miss: the check simply re-fetches and
// overwrites, because a derived verdict is always regenerable
// [LAW:no-silent-failure].
const parseCachedVerdict = (
  raw: string,
  slug: string,
): { readonly verdict: FreshnessVerdict; readonly checkedAt: number } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as { verdict?: unknown; checkedAt?: unknown };
    if (
      isFreshnessVerdict(o.verdict) &&
      typeof o.checkedAt === "number" &&
      Number.isFinite(o.checkedAt) &&
      o.checkedAt >= 0
    ) {
      return { verdict: o.verdict, checkedAt: o.checkedAt };
    }
  }
  console.error(`freshness: cached verdict failed validation for ${slug}, rechecking:`, raw);
  return null;
};

export const resolveFreshness = async (
  // [LAW:composability] The structural KV slice: env.PASTES assigns as-is, and the
  // check script drives the whole flow with a Map-backed stub.
  kv: Pick<PasteKv, "get" | "put">,
  slug: string,
  now: number,
  fetchFresh: FetchFreshFn,
): Promise<FreshnessOutcome> => {
  // [LAW:single-enforcer] The one PUBLIC viewable-paste gate — deliberately not the
  // admin refetch's bare getConversation: this check is a reader affordance, so a
  // hidden/expired paste is exactly as unreachable here as on /<slug>.
  const load = await loadViewablePaste(kv, slug, now);
  if (!load.ok) return { ok: false, status: load.status, error: load.message };
  const conversation = load.conversation;

  // [LAW:types-are-the-program] Only url origins have a live page to compare
  // against; the isUrlPaste refinement is what lets planRefetch take the narrowed
  // type. The paste page hides the affordance for other origins, but a directly-
  // crafted request still fails loudly here rather than no-op'ing.
  if (!isUrlPaste(conversation)) {
    return { ok: false, status: 409, error: "This paste does not have a fetched-URL origin to check." };
  }

  // [LAW:one-source-of-truth] The cache key hashes the EXACT stored bytes the
  // verdict compares against, so a verdict can never be served for content it did
  // not describe: any refetch or edit that changes the stored bytes changes the
  // hash, and the stale entry simply never matches again (its short TTL reaps it).
  const hash = await contentHash(conversation.origin.fetched);
  const cachedRaw = await getCachedFreshness(kv, slug, hash);
  const cached = cachedRaw === null ? null : parseCachedVerdict(cachedRaw, slug);
  if (cached !== null) {
    return { ok: true, verdict: cached.verdict, checkedAt: cached.checkedAt, cached: true };
  }

  // [LAW:effects-at-boundaries] The upstream fetch happens exactly here, only on a
  // cache miss — the miss path IS the cooldown expiring. [LAW:no-silent-failure] A
  // failed fetch is a loud 422 and is NOT cached: a failure is not a verdict, and
  // caching it would hide the upstream's recovery for the whole window.
  const fresh = await fetchFresh(conversation.origin.url);
  if (!fresh.ok) {
    return { ok: false, status: 422, error: `Live-page fetch failed: ${fresh.reason}` };
  }
  // [LAW:types-are-the-program] The url arm of ingest always yields a url origin,
  // but ParseResult's signature is wider; close the enumeration gap loudly rather
  // than casting past it (the refetch route's move).
  if (fresh.origin.kind !== "url") {
    return { ok: false, status: 500, error: "Ingest returned a non-url origin for a url input." };
  }

  const plan = planRefetch(conversation, { turns: fresh.turns, origin: fresh.origin }, now);
  await putCachedFreshness(kv, slug, hash, JSON.stringify({ verdict: plan.kind, checkedAt: now }));
  return { ok: true, verdict: plan.kind, checkedAt: now, cached: false };
};
