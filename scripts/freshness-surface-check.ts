// Freshness-surface checks (slopspot-freshness-eck.4). Run: `tsx scripts/freshness-surface-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Drives the
// COMPARE-ONLY check orchestration (resolveFreshness) OFF-NETWORK against a
// Map-backed PasteKv stub and a counting stub fetch, end-to-end over the committed
// refetch-drift fixture pair. The contract under test: a matching upstream verdicts
// "unchanged" and a drifted one "changed" with ZERO paste-record writes either way;
// a repeat check within the cache window performs NO upstream fetch; the verdict
// cache is keyed by the stored bytes so it can never describe other content; and
// the display face (freshnessView) shows a fetch age for stamped records, none for
// legacy ones, with wording that claims only what bytes prove.

import { readFileSync } from "node:fs";
import { resolveFreshness, type FetchFreshFn } from "../src/freshnessService";
import {
  FRESHNESS_VERDICTS,
  VERDICT_WORDING,
  checkedAgo,
  fetchedAgeLabel,
  isFreshnessVerdict,
} from "../src/freshnessView";
import { deleteConversation, putConversation, type PasteKv } from "../src/storage";
import { deriveTitle } from "../src/parser";
import { parseClaudeShare } from "../src/parsers/claude-share";
import type { Conversation, ParseResult, UrlOrigin } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// The freshness-check stub KV (the freshness-check.ts shape): every write recorded,
// so "a public check writes nothing but its own verdict cache" is an observable
// fact, not an inference.
interface StubKv extends PasteKv {
  readonly store: Map<string, { value: string; expirationTtl?: number }>;
  writes: number;
}
const stubKv = (): StubKv => {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  const kv: StubKv = {
    store,
    writes: 0,
    get: (key) => Promise.resolve(store.get(key)?.value ?? null),
    put: (key, value, options) => {
      kv.writes += 1;
      store.set(key, { value, expirationTtl: options?.expirationTtl });
      return Promise.resolve();
    },
    delete: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
    list: ({ prefix }) =>
      Promise.resolve({
        keys: Array.from(store.keys())
          .filter((name) => name.startsWith(prefix))
          .sort()
          .map((name) => ({ name })),
        list_complete: true,
      }),
  };
  return kv;
};

// A counting stub fetch: the injected network boundary, returning a fixed result.
const stubFetch = (result: ParseResult): { fn: FetchFreshFn; calls: () => number } => {
  let calls = 0;
  return {
    fn: () => {
      calls += 1;
      return Promise.resolve(result);
    },
    calls: () => calls,
  };
};

// ── Fixtures: the real drift pair ─────────────────────────────────────────────
const OLD_BYTES = readFileSync("test/fixtures/claude-share-refetch-old.md", "utf8");
const NEW_BYTES = readFileSync("test/fixtures/claude-share-refetch-new.md", "utf8");
const oldTurns = parseClaudeShare(OLD_BYTES);
const newTurns = parseClaudeShare(NEW_BYTES);
assert("both fixture snapshots parse", oldTurns !== null && newTurns !== null);
if (oldTurns === null || newTurns === null) process.exit(1);

const URL = "https://claude.ai/share/f5b7b4ef-0201-4d3a-8231-3e997c8ed9f7";
const NOW = 1_754_700_000_000;
const FETCHED_AT = NOW - 42 * 86_400_000; // six weeks before the check
const origin: UrlOrigin = {
  kind: "url",
  url: URL,
  fetched: OLD_BYTES,
  provider: "claude-share",
  fetchedAt: FETCHED_AT,
};
const paste: Conversation = {
  slug: "freshcheck",
  createdAt: FETCHED_AT,
  lifetime: { kind: "expires", expiresAt: NOW + 30 * 86_400_000 },
  deletedAt: null,
  turns: oldTurns,
  title: deriveTitle(oldTurns),
  origin,
};

const freshOld: ParseResult = {
  ok: true,
  turns: oldTurns,
  origin: { kind: "url", url: URL, fetched: OLD_BYTES, provider: "claude-share" },
};
const freshNew: ParseResult = {
  ok: true,
  turns: newTurns,
  origin: { kind: "url", url: URL, fetched: NEW_BYTES, provider: "claude-share" },
};

// Snapshot of every non-freshness key, for the zero-paste-writes assertions.
const nonCacheState = (kv: StubKv): string =>
  JSON.stringify(
    Array.from(kv.store.entries()).filter(([k]) => !k.startsWith("freshness:")),
  );

// ── Matching upstream: "unchanged", zero paste-record writes ─────────────────
{
  const kv = stubKv();
  await putConversation(kv, paste);
  const before = nonCacheState(kv);
  const fetch = stubFetch(freshOld);
  const outcome = await resolveFreshness(kv, paste.slug, NOW, fetch.fn);
  assert("matching upstream verdicts unchanged", outcome.ok && outcome.verdict === "unchanged");
  assert("first check fetched upstream once", fetch.calls() === 1);
  assert("verdict is stamped with the check instant", outcome.ok && outcome.checkedAt === NOW);
  assert("first check is not served from cache", outcome.ok && !outcome.cached);
  assert("check writes NOTHING outside the freshness cache", nonCacheState(kv) === before);
  const cacheKeys = Array.from(kv.store.keys()).filter((k) => k.startsWith("freshness:"));
  assert("exactly one verdict cache entry exists", cacheKeys.length === 1);
  assert(
    "verdict cache entry carries the cooldown TTL (1h)",
    cacheKeys[0] !== undefined && kv.store.get(cacheKeys[0])?.expirationTtl === 3600,
  );

  // ── The cache window: a repeat check performs NO upstream fetch ─────────────
  const later = NOW + 10 * 60_000;
  const again = await resolveFreshness(kv, paste.slug, later, fetch.fn);
  assert("repeat check within the window fetches nothing", fetch.calls() === 1);
  assert("repeat check serves the cached verdict", again.ok && again.cached && again.verdict === "unchanged");
  assert("cached verdict keeps its original check instant", again.ok && again.checkedAt === NOW);

  // ── The key is the stored bytes: changed content busts the cache ────────────
  await putConversation(kv, { ...paste, origin: { ...origin, fetched: NEW_BYTES }, turns: newTurns });
  const afterEdit = await resolveFreshness(kv, paste.slug, later, fetch.fn);
  assert("a check after the stored bytes change re-fetches", fetch.calls() === 2);
  assert(
    "new stored bytes get their own verdict (upstream still old → changed)",
    afterEdit.ok && afterEdit.verdict === "changed" && !afterEdit.cached,
  );

  // ── Hard delete sweeps the verdict cache ────────────────────────────────────
  await deleteConversation(kv, paste.slug);
  assert(
    "deleteConversation sweeps the freshness cache",
    Array.from(kv.store.keys()).every((k) => !k.startsWith("freshness:")),
  );
}

// ── Drifted upstream (the fixture pair): "changed", zero paste-record writes ──
{
  const kv = stubKv();
  await putConversation(kv, paste);
  const before = nonCacheState(kv);
  const fetch = stubFetch(freshNew);
  const outcome = await resolveFreshness(kv, paste.slug, NOW, fetch.fn);
  assert("drifted upstream verdicts changed", outcome.ok && outcome.verdict === "changed");
  assert("changed verdict still writes NOTHING outside the freshness cache", nonCacheState(kv) === before);
  assert(
    "no version record is archived by a public check",
    Array.from(kv.store.keys()).every((k) => !k.startsWith("version:")),
  );
}

// ── A corrupt cached verdict is a loud miss, never a wrong answer ─────────────
{
  const kv = stubKv();
  await putConversation(kv, paste);
  const fetch = stubFetch(freshOld);
  await resolveFreshness(kv, paste.slug, NOW, fetch.fn);
  const key = Array.from(kv.store.keys()).find((k) => k.startsWith("freshness:"));
  assert("verdict cache key exists to corrupt", key !== undefined);
  if (key === undefined) process.exit(1);
  kv.store.set(key, { value: JSON.stringify({ verdict: "maybe", checkedAt: "soon" }) });
  const outcome = await resolveFreshness(kv, paste.slug, NOW + 60_000, fetch.fn);
  assert("corrupt cache entry re-fetches instead of trusting junk", fetch.calls() === 2);
  assert("recheck lands a fresh verdict", outcome.ok && outcome.verdict === "unchanged" && !outcome.cached);
}

// ── The failure arms ──────────────────────────────────────────────────────────
{
  const kv = stubKv();
  await putConversation(kv, paste);
  const missing = await resolveFreshness(kv, "nosuch", NOW, stubFetch(freshOld).fn);
  assert("a missing paste is a 404", !missing.ok && missing.status === 404);

  const textPaste: Conversation = {
    ...paste,
    slug: "textarmpad",
    origin: { kind: "raw", content: "hello" },
  };
  await putConversation(kv, textPaste);
  const text = await resolveFreshness(kv, "textarmpad", NOW, stubFetch(freshOld).fn);
  assert("a text-arm paste is a 409 (nothing to check)", !text.ok && text.status === 409);

  const failing = stubFetch({ ok: false, reason: "scrape blew up" });
  const failed = await resolveFreshness(kv, paste.slug, NOW, failing.fn);
  assert("a failed live fetch is a 422 carrying the reason", !failed.ok && failed.status === 422 && failed.error.includes("scrape blew up"));
  assert(
    "a failure is NOT cached as a verdict",
    Array.from(kv.store.keys()).every((k) => !k.startsWith("freshness:")),
  );
  const retry = await resolveFreshness(kv, paste.slug, NOW + 1, stubFetch(freshOld).fn);
  assert("the next check after a failure retries upstream", retry.ok && retry.verdict === "unchanged");
}

// ── The display face (freshnessView) ──────────────────────────────────────────
assert(
  "a stamped record shows its fetch age",
  fetchedAgeLabel(origin) === "Snapshot fetched 2025-06-28",
);
assert(
  "a legacy (pre-stamping) record shows NO age",
  fetchedAgeLabel({ kind: "url", url: URL, fetched: OLD_BYTES, provider: "claude-share" }) === null,
);
// The honesty constraint: the verdict claims only the bytes-level fact — the live
// page vs the stored snapshot — never "the conversation was updated".
assert(
  "unchanged wording claims only the snapshot match",
  VERDICT_WORDING.unchanged === "The live page matches the stored snapshot.",
);
assert(
  "changed wording claims only the snapshot difference",
  VERDICT_WORDING.changed === "The live page differs from the stored snapshot.",
);
assert("the verdict set is exactly the plan kinds", JSON.stringify(FRESHNESS_VERDICTS) === '["unchanged","changed"]');
assert("isFreshnessVerdict accepts both verdicts", FRESHNESS_VERDICTS.every(isFreshnessVerdict));
assert("isFreshnessVerdict rejects junk", !isFreshnessVerdict("maybe") && !isFreshnessVerdict(1));
assert("checkedAgo: fresh instants read as just now", checkedAgo(NOW, NOW) === "checked just now");
assert("checkedAgo: minutes are worded singular/plural", checkedAgo(NOW - 60_000, NOW) === "checked 1 minute ago" && checkedAgo(NOW - 10 * 60_000, NOW) === "checked 10 minutes ago");
assert("checkedAgo: past-the-window instants stay total (hours arm)", checkedAgo(NOW - 3 * 3_600_000, NOW) === "checked 3 hours ago");
assert("checkedAgo: clock skew never yields a negative count", checkedAgo(NOW + 60_000, NOW) === "checked just now");

if (process.exitCode !== 1) console.log("freshness-surface-check: all assertions passed.");
