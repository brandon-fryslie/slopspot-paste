// Side-by-side diff checks (slopspot-diff-pcd.2). Run: `tsx scripts/diff-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the PURE
// diff core (src/diff.ts) OFF-NETWORK: that a diff column renders THROUGH the one
// viewable-spine enforcer (so a redacted turn can never leak in a column — the
// security-critical property), that a column projects the same title/platform/turn-count
// the full page shows, and that the page outcome is viewable iff at least one side loaded
// — a one-missing diff renders the present side beside the absent side's honest status,
// and only both-missing fails, carrying BOTH reasons.

import { deriveDiffColumn, diffOutcome } from "../src/diff";
import { deriveViewableDialogue } from "../src/overlay";
import { renderDialogueHtml } from "../src/renderDialogue";
import type { Conversation, Overlay, PasteLoad, Turn } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// A minimal live Conversation: pinned, never-deleted, no origin (a "generic" platform,
// whose PLATFORM_LABEL is null). `turns` is required; title/overlay/origin default to
// the un-provenanced legacy shape, overridable per fixture.
const conv = (fields: Partial<Conversation> & { turns: ReadonlyArray<Turn> }): Conversation => ({
  slug: "abcdefghjk",
  createdAt: 0,
  lifetime: { kind: "pinned" },
  deletedAt: null,
  title: null,
  origin: null,
  ...fields,
});

const okLoad = (conversation: Conversation): PasteLoad => ({ ok: true, conversation });
const errLoad = (status: 404 | 410 | 503, message: string): PasteLoad => ({ ok: false, status, message });

const SECRET = "SECRET-TOKEN-abc123";
const turns: ReadonlyArray<Turn> = [
  { kind: "message", role: "user", content: "What is the config value?" },
  { kind: "message", role: "assistant", content: `The value is ${SECRET} — keep it safe.` },
];
const hide1: Overlay = [{ kind: "hide", target: { kind: "turn", index: 1 } }];

// ── THE REDACTION INVARIANT: a column renders through deriveViewableDialogue ──────────
// A conversation whose secret turn is redacted by an overlay: the column must show the
// marker and NEVER the secret. The byte-equality below is the load-bearing proof — the
// column HTML equals rendering the viewable dialogue directly, so the column is pinned to
// the ONE enforcer by construction; reading raw turns would break this even with no secret.
const redactedCol = deriveDiffColumn("abcdefghjk", okLoad(conv({ turns, overlay: hide1 })));
assert("a redacted column resolves ok (present, not dropped)", redactedCol.ok);
assert("a diff column renders the redaction marker", redactedCol.ok && redactedCol.html.includes("[redacted]"));
assert("a diff column NEVER leaks a redacted secret (sources the viewable dialogue, not raw turns)",
  redactedCol.ok && !redactedCol.html.includes(SECRET));
assert("column html IS renderDialogueHtml(deriveViewableDialogue(conversation), false) — pinned to the one enforcer",
  redactedCol.ok &&
    redactedCol.html === renderDialogueHtml(deriveViewableDialogue(conv({ turns, overlay: hide1 })), false));
// topLevel:false so two columns don't collide on duplicate id="tN" — a column mints no
// permalink anchor (nothing on the diff page consumes it), unlike the /<slug> full page.
assert("a diff column mints NO id=\"tN\" anchor (topLevel:false — no cross-column id collision)",
  redactedCol.ok && !redactedCol.html.includes('id="t'));

// ── A non-overlaid column shows the content, and projects the page's own facts ────────
const plainCol = deriveDiffColumn("abcdefghjk", okLoad(conv({ turns, title: "My chat" })));
assert("a non-overlaid column shows the un-redacted content", plainCol.ok && plainCol.html.includes(SECRET));
assert("a column projects the paste title", plainCol.ok && plainCol.title === "My chat");
assert("a null title falls back to 'Shared conversation'",
  (() => { const c = deriveDiffColumn("abcdefghjk", okLoad(conv({ turns }))); return c.ok && c.title === "Shared conversation"; })());
assert("a column projects turnCount from turns.length (the same '{n} turns' the full page shows)",
  plainCol.ok && plainCol.turnCount === turns.length);
assert("a generic (no-origin) paste has a null platform label — absence of provenance renders as absence",
  plainCol.ok && plainCol.platformLabel === null);

// The platform is a two-branch projection: a stored platformOverride WINS over the
// origin-derived platform (the same override /<slug> honours). Cover the override branch,
// not just the generic-derived one above — the column must reflect the author's chosen
// theme, and its label follows [LAW:behavior-not-structure].
const overrideCol = deriveDiffColumn("abcdefghjk", okLoad(conv({ turns, platformOverride: "claude-code" })));
assert("platformOverride wins over origin derivation (column.platform === the override)",
  overrideCol.ok && overrideCol.platform === "claude-code");
assert("the override's label projects too (claude-code → 'Claude Code')",
  overrideCol.ok && overrideCol.platformLabel === "Claude Code");

// ── A missing side is an honest absence carrying the gate's verbatim status ───────────
const goneCol = deriveDiffColumn("goneslug00", errLoad(410, "This paste has expired or been deleted."));
assert("a missing side is ok:false carrying the exact status", !goneCol.ok && goneCol.status === 410);
assert("a missing side preserves the gate's verbatim message (not a generic 'unavailable')",
  !goneCol.ok && goneCol.message.includes("expired or been deleted"));
assert("a missing side carries its own slug for the template to name", !goneCol.ok && goneCol.slug === "goneslug00");

// ── diffOutcome: viewable iff at least one side loaded ────────────────────────────────
const okA = deriveDiffColumn("aaaaaaaaaa", okLoad(conv({ turns, title: "A" })));
const okB = deriveDiffColumn("bbbbbbbbbb", okLoad(conv({ turns, title: "B" })));
const missA = deriveDiffColumn("aaaaaaaaaa", errLoad(503, "The paste store is temporarily unavailable. Please try again."));
const missB = deriveDiffColumn("bbbbbbbbbb", errLoad(404, "This paste has expired or never existed."));

assert("both present → render", diffOutcome(okA, okB).kind === "render");
assert("one missing (right) → STILL render, not a whole-page failure", diffOutcome(okA, missB).kind === "render");
assert("one missing (left) → STILL render", diffOutcome(missA, okB).kind === "render");

const rendered = diffOutcome(okA, missB);
assert("a render outcome preserves BOTH columns for the template (present + absent-with-status)",
  rendered.kind === "render" && rendered.left === okA && rendered.right === missB);

const bothGone = diffOutcome(missA, missB);
assert("both missing → fail (the only failure)", bothGone.kind === "fail");
// The page status is the MORE-SEVERE of the two (503 > 410 > 404), independent of side —
// so a transient 503 is never masked by a cacheable 404. Assert both orderings.
assert("both missing → fail carries the more-severe status (503 when left=503, right=404)",
  bothGone.kind === "fail" && bothGone.status === 503);
const bothGoneRev = diffOutcome(missB, missA); // left=404, right=503
assert("both missing → severity is position-independent (503 when left=404, right=503)",
  bothGoneRev.kind === "fail" && bothGoneRev.status === 503);
assert("both missing → fail names BOTH slugs and BOTH reasons (no silently-dropped side)",
  bothGone.kind === "fail" &&
    bothGone.message.includes("aaaaaaaaaa") && bothGone.message.includes("bbbbbbbbbb") &&
    bothGone.message.includes("temporarily unavailable") && bothGone.message.includes("never existed"));

console.log("diff-check complete");
