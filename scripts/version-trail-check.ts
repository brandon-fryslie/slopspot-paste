// Version-trail checks (slopspot-freshness-eck.3). Run: `tsx scripts/version-trail-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Drives the pure
// version-trail core (src/versionTrail.ts) and the stamp/targeted-read storage seams
// OFF-NETWORK against a Map-backed PasteKv stub, end-to-end over the committed
// refetch-drift fixture pair (same conversation scraped weeks apart — see
// test/fixtures/README.md). The contract under test — the ticket's acceptance
// criterion: with a paste + one archived version, the version outcome renders aligned
// rows marking exactly the differing turns; a paste with no versions shows no trail
// affordance; a paste with a hide directive exposes NO version content publicly.

import { readFileSync } from "node:fs";
import { applyRefetchPlan, planRefetch } from "../src/freshness";
import {
  getPasteVersion,
  listPasteVersionStamps,
  listPasteVersions,
  putConversation,
  type PasteKv,
} from "../src/storage";
import { deriveTitle } from "../src/parser";
import { parseClaudeShare } from "../src/parsers/claude-share";
import { deriveDialogue } from "../src/dialogue";
import { deriveVersionTrail, versionDate, versionPageOutcome, versionPath } from "../src/versionTrail";
import type { Conversation, Overlay, PasteVersion } from "../src/types";
import { isUrlPaste } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const stubKv = (): PasteKv & { store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    store,
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, value) => {
      store.set(key, value);
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
};

// ── Fixtures: the real drift pair ─────────────────────────────────────────────
const OLD_BYTES = readFileSync("test/fixtures/claude-share-refetch-old.md", "utf8");
const NEW_BYTES = readFileSync("test/fixtures/claude-share-refetch-new.md", "utf8");
const oldTurns = parseClaudeShare(OLD_BYTES);
const newTurns = parseClaudeShare(NEW_BYTES);
assert("both fixture snapshots parse", oldTurns !== null && newTurns !== null);
if (oldTurns === null || newTurns === null) process.exit(1);

const URL = "https://claude.ai/share/f5b7b4ef-0201-4d3a-8231-3e997c8ed9f7";
const T0 = 1_750_000_000_000;
const NOW = 1_754_700_000_000;
const paste: Conversation = {
  slug: "trailcheck",
  createdAt: T0,
  lifetime: { kind: "expires", expiresAt: T0 + 30 * 86_400_000 },
  deletedAt: null,
  turns: oldTurns,
  title: deriveTitle(oldTurns),
  origin: { kind: "url", url: URL, fetched: OLD_BYTES, provider: "claude-share" },
};
assert("fixture paste is a UrlPaste", isUrlPaste(paste));
if (!isUrlPaste(paste)) process.exit(1);

// The changed refetch that produces the archived version + the updated current paste —
// the same transition the production /api/refetch performs.
const plan = planRefetch(
  paste,
  { turns: newTurns, origin: { kind: "url", url: URL, fetched: NEW_BYTES, provider: "claude-share" } },
  NOW,
);
assert("drift pair plans as changed", plan.kind === "changed");
if (plan.kind !== "changed") process.exit(1);
const current = plan.updated;
const withOverlay = (overlay: Overlay): Conversation => ({ ...current, overlay });

// ── Storage: the stamp index and the targeted read ────────────────────────────
{
  const kv = stubKv();
  await putConversation(kv, paste);
  await applyRefetchPlan(kv, plan);
  const stamps = await listPasteVersionStamps(kv, paste.slug);
  assert("stamp index lists the one archived instant", eq(stamps, [NOW]));
  const version = await getPasteVersion(kv, paste.slug, NOW);
  assert("targeted read round-trips the archived record", eq(version, plan.version));
  assert("targeted read of a never-archived instant is null", (await getPasteVersion(kv, paste.slug, NOW + 1)) === null);
  kv.store.set(`version:${paste.slug}:not-thirteen`, JSON.stringify(plan.version));
  const stamps2 = await listPasteVersionStamps(kv, paste.slug);
  assert("a malformed version key is dropped from the stamp index", eq(stamps2, [NOW]));
  const full = await listPasteVersions(kv, paste.slug);
  assert("full listing still routes through the same validated read", full.length === 1 && eq(full[0], plan.version));
}

// ── The trail derivation: affordance iff versions exist ───────────────────────
assert("no versions ⇒ no trail affordance (null)", deriveVersionTrail(current, []) === null);
{
  const trail = deriveVersionTrail(current, [NOW]);
  assert("versions + no overlay ⇒ diffable trail", trail?.kind === "diffable" && eq(trail.stamps, [NOW]));
  assert("fresh overlay-free paste has no stale fault", trail?.staleFault === null);
}
{
  const trail = deriveVersionTrail(withOverlay([{ kind: "collapse", target: { kind: "turn", index: 0 } }]), [NOW]);
  assert("collapse-only overlay stays diffable (folded content is still public)", trail?.kind === "diffable");
}
assert(
  "hide overlay ⇒ trail withheld",
  deriveVersionTrail(withOverlay([{ kind: "hide", target: { kind: "turn", index: 0 } }]), [NOW])?.kind === "withheld",
);
assert(
  "feature overlay ⇒ trail withheld (non-featured turns are non-public)",
  deriveVersionTrail(withOverlay([{ kind: "feature", target: { kind: "turn", index: 0 } }]), [NOW])?.kind === "withheld",
);
{
  // Staleness is DERIVED at read (outOfRangeTarget over stored directives + current
  // turns), never stored — the PR #109 review finding folded into this slice.
  const trail = deriveVersionTrail(withOverlay([{ kind: "collapse", target: { kind: "turn", index: 99 } }]), [NOW]);
  assert("an out-of-range directive surfaces as a stale fault", trail?.staleFault?.kind === "turn-out-of-range");
  const fresh = deriveVersionTrail(withOverlay([{ kind: "collapse", target: { kind: "turn", index: 0 } }]), [NOW]);
  assert("an in-range directive surfaces no stale fault", fresh?.staleFault === null);
}

// ── The privacy gate: a hide directive exposes NO version content ─────────────
{
  const redacted = withOverlay([{ kind: "hide", target: { kind: "turn", index: 0 } }]);
  const outcome = versionPageOutcome(redacted, plan.version);
  assert("redacted paste ⇒ version outcome withheld", outcome.kind === "withheld");
  assert(
    "the withheld outcome carries NO content at all (structural leak-proof)",
    JSON.stringify(outcome) === '{"kind":"withheld"}',
  );
  assert(
    "withheld is identical whether or not the stamp exists (no existence probe)",
    eq(versionPageOutcome(redacted, null), outcome),
  );
}

// ── The honest absences ───────────────────────────────────────────────────────
assert("no version at that instant ⇒ not-found", versionPageOutcome(current, null).kind === "not-found");
{
  const junk: PasteVersion = {
    origin: { kind: "url", url: URL, fetched: "not a share page", provider: "claude-share" },
    supersededAt: NOW,
  };
  const outcome = versionPageOutcome(current, junk);
  assert(
    "archived bytes that no longer parse ⇒ unparseable, naming the instant",
    outcome.kind === "unparseable" && outcome.supersededAt === NOW,
  );
}

// ── The diff itself, over the real drift pair ─────────────────────────────────
{
  const outcome = versionPageOutcome(current, plan.version);
  assert("snapshot vs current ⇒ diff", outcome.kind === "diff");
  if (outcome.kind !== "diff") process.exit(1);

  // The snapshot side re-derives from the ARCHIVED bytes (store the original, derive
  // the display): its title/turnCount are projections of the old snapshot, not copies
  // of anything stored beside it.
  assert("snapshot title derives from the archived bytes", outcome.snapshot.title === deriveTitle(oldTurns));
  assert("snapshot turn count is the old projection's", outcome.snapshot.turnCount === oldTurns.length);
  assert("snapshot carries its superseded instant", outcome.snapshot.supersededAt === NOW);
  assert("current column is the live paste's projection", outcome.current.turnCount === newTurns.length && outcome.current.slug === paste.slug);

  // Alignment survives render drift (the fixture evidence): prompts are byte-stable, so
  // every row pairs — no gap rows, no silent shift.
  assert("every aligned row pairs (no gaps across pure render drift)", outcome.rows.every((r) => r.row.kind === "paired"));

  // The changed flags mark EXACTLY the differing turns: compare the two spines
  // independently, node by node (same length, positional — the check's own oracle).
  const oldSpine = deriveDialogue(oldTurns);
  const newSpine = deriveDialogue(newTurns);
  assert("both spines have equal length (oracle precondition)", oldSpine.length === newSpine.length);
  const expectChanged = oldSpine.map((node, i) => !eq(node, newSpine[i]));
  const gotChanged = outcome.rows.map((r) => r.changed);
  assert("changed flags mark exactly the differing turns", eq(gotChanged, expectChanged));
  assert("the drift is visible (at least one changed row)", gotChanged.some(Boolean));
  assert("byte-stable user prompts are never marked changed", outcome.rows.every((r) => {
    if (r.row.kind !== "paired") return false;
    const spoken = r.row.left.node.kind === "spoken";
    return spoken ? !r.changed : true;
  }));
}

// ── Link/date projections the templates share ─────────────────────────────────
assert("versionPath mints the route the version page serves", versionPath("abc123", 5) === "/abc123/versions/5");
assert("versionDate is the UTC calendar date", versionDate(0) === "1970-01-01");

if (process.exitCode !== 1) console.log("version-trail-check: all assertions passed.");
