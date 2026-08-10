// Refetch freshness checks (slopspot-freshness-eck.2). Run: `tsx scripts/freshness-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Drives the pure
// planRefetch decision and the applyRefetchPlan/storage contract OFF-NETWORK against a
// Map-backed PasteKv stub, including end-to-end over the committed refetch-drift
// fixture pair (the same conversation scraped weeks apart — see test/fixtures/README.md).
// The contract under test: an unchanged refetch writes NOTHING; a changed refetch
// archives the prior snapshot VERBATIM before overwriting; deleting a paste deletes
// its version archive.

import { readFileSync } from "node:fs";
import { planRefetch, applyRefetchPlan } from "../src/freshness";
import {
  deleteConversation,
  getConversation,
  listPasteVersions,
  putConversation,
  putPasteVersion,
  type PasteKv,
} from "../src/storage";
import { deriveTitle } from "../src/parser";
import { parseClaudeShare } from "../src/parsers/claude-share";
import { isPasteVersion, isUrlPaste, type Conversation, type UrlPaste } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// A stub KV that records every write, so "an unchanged refetch performs zero writes"
// is an observable fact, not an inference from the plan's shape.
interface StubKv extends PasteKv {
  readonly store: Map<string, { value: string; expirationTtl?: number }>;
  writes: number;
  deletes: number;
}
const stubKv = (): StubKv => {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  const kv: StubKv = {
    store,
    writes: 0,
    deletes: 0,
    get: (key) => Promise.resolve(store.get(key)?.value ?? null),
    put: (key, value, options) => {
      kv.writes += 1;
      store.set(key, { value, expirationTtl: options?.expirationTtl });
      return Promise.resolve();
    },
    delete: (key) => {
      kv.deletes += 1;
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

// ── Fixtures: the real drift pair ─────────────────────────────────────────────
const OLD_BYTES = readFileSync("test/fixtures/claude-share-refetch-old.md", "utf8");
const NEW_BYTES = readFileSync("test/fixtures/claude-share-refetch-new.md", "utf8");
const oldTurns = parseClaudeShare(OLD_BYTES);
const newTurns = parseClaudeShare(NEW_BYTES);
assert("both fixture snapshots parse", oldTurns !== null && newTurns !== null);
if (oldTurns === null || newTurns === null) process.exit(1);
assert("the pair actually drifted (bytes differ)", OLD_BYTES !== NEW_BYTES);

const URL = "https://claude.ai/share/f5b7b4ef-0201-4d3a-8231-3e997c8ed9f7";
const T0 = 1_750_000_000_000;
const NOW = 1_754_700_000_000;
const paste: Conversation = {
  slug: "checkfix",
  createdAt: T0,
  lifetime: { kind: "expires", expiresAt: T0 + 30 * 86_400_000 },
  deletedAt: null,
  turns: oldTurns,
  title: deriveTitle(oldTurns),
  origin: { kind: "url", url: URL, fetched: OLD_BYTES, provider: "claude-share" },
  overlay: [{ kind: "hide", target: { kind: "turn", index: 0 } }],
};
assert("fixture paste is a UrlPaste", isUrlPaste(paste));
if (!isUrlPaste(paste)) process.exit(1);

// ── planRefetch: unchanged ────────────────────────────────────────────────────
const same = planRefetch(paste, { turns: oldTurns, origin: { kind: "url", url: URL, fetched: OLD_BYTES, provider: "claude-share" } }, NOW);
assert("identical fresh bytes plan as unchanged", same.kind === "unchanged");

// ── planRefetch: changed (the drift pair, end-to-end) ─────────────────────────
const changed = planRefetch(paste, { turns: newTurns, origin: { kind: "url", url: URL, fetched: NEW_BYTES, provider: "claude-share" } }, NOW);
assert("drifted fresh bytes plan as changed", changed.kind === "changed");
if (changed.kind !== "changed") process.exit(1);
assert("version archives the PRIOR origin verbatim", eq(changed.version.origin, paste.origin));
assert("version bytes are byte-identical to the old snapshot", changed.version.origin.fetched === OLD_BYTES);
assert("version is stamped with the refetch instant", changed.version.supersededAt === NOW);
assert("updated record carries the new bytes", changed.updated.origin?.kind === "url" && changed.updated.origin.fetched === NEW_BYTES);
assert(
  "updated origin is stamped fetchedAt = now",
  changed.updated.origin?.kind === "url" && changed.updated.origin.fetchedAt === NOW,
);
assert("updated turns are the fresh projection", eq(changed.updated.turns, newTurns));
assert("updated title re-derives from the fresh turns", changed.updated.title === deriveTitle(newTurns));
assert("slug/createdAt/lifetime/deletedAt are preserved",
  changed.updated.slug === paste.slug &&
  changed.updated.createdAt === paste.createdAt &&
  eq(changed.updated.lifetime, paste.lifetime) &&
  changed.updated.deletedAt === null);
assert("authored overlay rides the update (never dropped)", eq(changed.updated.overlay, paste.overlay));

// ── applyRefetchPlan: unchanged writes nothing ────────────────────────────────
{
  const kv = stubKv();
  await putConversation(kv, paste);
  const writesBefore = kv.writes;
  const stored = JSON.stringify(Array.from(kv.store.entries()));
  await applyRefetchPlan(kv, { kind: "unchanged" });
  assert("unchanged plan performs zero KV writes", kv.writes === writesBefore);
  assert("unchanged plan leaves the store byte-identical", JSON.stringify(Array.from(kv.store.entries())) === stored);
}

// ── applyRefetchPlan: changed archives then updates ───────────────────────────
{
  const kv = stubKv();
  await putConversation(kv, paste);
  await applyRefetchPlan(kv, changed);
  const versions = await listPasteVersions(kv, paste.slug);
  assert("one version record exists after the changed refetch", versions.length === 1);
  assert("the archived record round-trips verbatim", eq(versions[0], changed.version));
  const reread = await getConversation(kv, paste.slug);
  assert("the paste record now carries the new bytes", reread?.origin?.kind === "url" && reread.origin.fetched === NEW_BYTES);
  assert("fetchedAt survives the KV read boundary", reread?.origin?.kind === "url" && reread.origin.fetchedAt === NOW);

  // A second drift archives a second version, ordered oldest→newest.
  const paste2 = reread;
  assert("re-read paste is a UrlPaste", paste2 !== null && isUrlPaste(paste2));
  if (paste2 === null || !isUrlPaste(paste2)) process.exit(1);
  const changed2 = planRefetch(paste2, { turns: oldTurns, origin: { kind: "url", url: URL, fetched: OLD_BYTES, provider: "claude-share" } }, NOW + 60_000);
  assert("re-drift plans as changed", changed2.kind === "changed");
  if (changed2.kind !== "changed") process.exit(1);
  await applyRefetchPlan(kv, changed2);
  const trail = await listPasteVersions(kv, paste.slug);
  assert("two versions after two changed refetches", trail.length === 2);
  assert("trail is chronological (oldest first)", trail[0]?.supersededAt === NOW && trail[1]?.supersededAt === NOW + 60_000);

  // Hard delete sweeps the archive with the paste.
  await deleteConversation(kv, paste.slug);
  assert("deleteConversation removes the paste record", (await getConversation(kv, paste.slug)) === null);
  assert("deleteConversation removes the version archive", (await listPasteVersions(kv, paste.slug)).length === 0);
}

// ── Version TTL follows the paste's lifetime ──────────────────────────────────
{
  const kv = stubKv();
  const version = { origin: paste.origin, supersededAt: NOW };
  await putPasteVersion(kv, "expiring", version, { kind: "expires", expiresAt: NOW });
  await putPasteVersion(kv, "pinned", version, { kind: "pinned" });
  const expiringKey = Array.from(kv.store.keys()).find((k) => k.startsWith("version:expiring:"));
  const pinnedKey = Array.from(kv.store.keys()).find((k) => k.startsWith("version:pinned:"));
  assert("expiring paste's version carries the paste backstop TTL",
    expiringKey !== undefined && kv.store.get(expiringKey)?.expirationTtl === (30 + 30 + 7) * 86_400);
  assert("pinned paste's version carries no TTL",
    pinnedKey !== undefined && kv.store.get(pinnedKey)?.expirationTtl === undefined);
}

// ── The KV trust boundary rejects junk version records ────────────────────────
assert("isPasteVersion accepts the real shape", isPasteVersion({ origin: paste.origin, supersededAt: NOW }));
assert("isPasteVersion rejects a text-arm origin", !isPasteVersion({ origin: { kind: "raw", content: "x" }, supersededAt: NOW }));
assert("isPasteVersion rejects a missing origin", !isPasteVersion({ supersededAt: NOW }));
assert("isPasteVersion rejects a negative instant", !isPasteVersion({ origin: paste.origin, supersededAt: -1 }));
assert("isPasteVersion rejects null", !isPasteVersion(null));
{
  const kv = stubKv();
  kv.store.set("version:junky:0000000000001", { value: "not json" });
  kv.store.set("version:junky:0000000000002", { value: JSON.stringify({ nope: true }) });
  kv.store.set("version:junky:0000000000003", { value: JSON.stringify({ origin: paste.origin, supersededAt: 3 }) });
  const survivors = await listPasteVersions(kv, "junky");
  assert("corrupt version records are dropped, valid ones survive", survivors.length === 1 && survivors[0]?.supersededAt === 3);
}

// ── The drift evidence itself (guards the fixtures' claim) ────────────────────
{
  const key = (t: { kind: string }) => JSON.stringify(t);
  const prompts = (turns: ReadonlyArray<{ kind: string }>) =>
    turns.filter((t) => t.kind === "message" && (t as { role?: string }).role === "user").map(key);
  assert("drift pair: user prompts are byte-stable", eq(prompts(oldTurns), prompts(newTurns)));
  assert("drift pair: same turn count, differing content", oldTurns.length === newTurns.length && !eq(oldTurns, newTurns));
}

if (process.exitCode !== 1) console.log("freshness-check: all assertions passed.");
