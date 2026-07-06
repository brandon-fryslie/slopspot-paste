// Side-by-side diff checks (slopspot-diff-pcd.2, .3). Run: `tsx scripts/diff-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the PURE
// diff core (src/diff.ts) OFF-NETWORK:
//   .2  a diff column carries the VIEWABLE dialogue (so a redacted turn can never leak —
//       the security-critical property), projects the same title/platform/turn-count the
//       full page shows, and the page outcome is viewable iff at least one side loaded.
//   .3  alignDialogues pairs corresponding turns on the human-message spine, opens a
//       visible gap (never a silent shift) where a prompt is present on one side only, and
//       degrades to positional pairing when prompts match — all unit-tested on node
//       identities, independent of rendering [LAW:behavior-not-structure].

import {
  alignDialogues,
  deriveDiffColumn,
  diffOutcome,
  renderColumnHtml,
  renderDiffRow,
  type DiffRow,
} from "../src/diff";
import { deriveViewableDialogue } from "../src/overlay";
import { renderDialogueHtml } from "../src/renderDialogue";
import type { DisplayNode, ViewableDialogue } from "../src/dialogue";
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

// ── THE REDACTION INVARIANT: a column carries the viewable dialogue ────────────────────
// A conversation whose secret turn is redacted by an overlay: rendering the column's view
// must show the marker and NEVER the secret. The byte-equality below is the load-bearing
// proof — the column's view IS deriveViewableDialogue(conversation), so rendering it equals
// rendering the viewable dialogue directly, pinning the column to the ONE enforcer by
// construction; carrying raw turns would break this even with no secret.
const redactedCol = deriveDiffColumn("abcdefghjk", okLoad(conv({ turns, overlay: hide1 })));
const redactedHtml = redactedCol.ok ? renderColumnHtml(redactedCol.view) : "";
assert("a redacted column resolves ok (present, not dropped)", redactedCol.ok);
assert("a diff column renders the redaction marker", redactedHtml.includes("[redacted]"));
assert("a diff column NEVER leaks a redacted secret (carries the viewable dialogue, not raw turns)",
  !redactedHtml.includes(SECRET));
assert("renderColumnHtml(col.view) IS renderDialogueHtml(deriveViewableDialogue(conversation), false) — pinned to the one enforcer",
  redactedHtml === renderDialogueHtml(deriveViewableDialogue(conv({ turns, overlay: hide1 })), false));
// topLevel:false so two columns don't collide on duplicate id="tN" — a column mints no
// permalink anchor (nothing on the diff page consumes it), unlike the /<slug> full page.
assert("a diff column mints NO id=\"tN\" anchor (topLevel:false — no cross-column id collision)",
  !redactedHtml.includes('id="t'));

// ── A non-overlaid column shows the content, and projects the page's own facts ────────
const plainCol = deriveDiffColumn("abcdefghjk", okLoad(conv({ turns, title: "My chat" })));
const plainHtml = plainCol.ok ? renderColumnHtml(plainCol.view) : "";
assert("a non-overlaid column shows the un-redacted content", plainHtml.includes(SECRET));
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

// ── diffOutcome: the display mode is a value ──────────────────────────────────────────
const okA = deriveDiffColumn("aaaaaaaaaa", okLoad(conv({ turns, title: "A" })));
const okB = deriveDiffColumn("bbbbbbbbbb", okLoad(conv({ turns, title: "B" })));
const missA = deriveDiffColumn("aaaaaaaaaa", errLoad(503, "The paste store is temporarily unavailable. Please try again."));
const missB = deriveDiffColumn("bbbbbbbbbb", errLoad(404, "This paste has expired or never existed."));

assert("both present → aligned", diffOutcome(okA, okB).kind === "aligned");
assert("one missing (right) → one-sided, not a whole-page failure", diffOutcome(okA, missB).kind === "one-sided");
assert("one missing (left) → one-sided", diffOutcome(missA, okB).kind === "one-sided");

const aligned = diffOutcome(okA, okB);
assert("an aligned outcome carries both ok columns and the paired rows",
  aligned.kind === "aligned" && aligned.left === okA && aligned.right === okB && aligned.rows.length > 0);
const oneSided = diffOutcome(okA, missB);
assert("a one-sided outcome preserves BOTH columns positionally (present + absent-with-status)",
  oneSided.kind === "one-sided" && oneSided.left === okA && oneSided.right === missB);

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

// ── alignDialogues: the pure core (slopspot-diff-pcd.3) ───────────────────────────────
// Build a viewable dialogue straight from turns (no overlay) — the same view the column
// carries. Small readers name the spine node a row's cell holds, so assertions read as the
// turn text, not DOM.
const u = (content: string): Turn => ({ kind: "message", role: "user", content });
const a = (content: string): Turn => ({ kind: "message", role: "assistant", content });
const view = (...ts: Turn[]): ViewableDialogue => deriveViewableDialogue(conv({ turns: ts }));
const spoken = (dn: DisplayNode | null | undefined): string | null =>
  dn && dn.node.kind === "spoken" ? dn.node.content : null;
const assistantText = (dn: DisplayNode | null | undefined): string | null => {
  if (!dn || dn.node.kind !== "assistant") return null;
  const first = dn.node.blocks[0];
  return first && first.kind === "text" ? first.content : null;
};
// The left/right node a row carries, or null where that side is a gap.
const leftOf = (row: DiffRow | undefined): DisplayNode | null =>
  row && (row.kind === "paired" || row.kind === "left-only") ? row.left : null;
const rightOf = (row: DiffRow | undefined): DisplayNode | null =>
  row && (row.kind === "paired" || row.kind === "right-only") ? row.right : null;

// Cross-model / identical prompts in order → every row pairs, degrading to positional
// (row i <-> row i). This is the ticket's "equal-length identical-prompt spines degrade to
// positional for free" — proven, not assumed.
const cm = alignDialogues(
  view(u("Summarize this"), a("claude answer 1"), u("Now translate"), a("claude answer 2")),
  view(u("Summarize this"), a("gpt answer 1"), u("Now translate"), a("gpt answer 2")),
);
assert("cross-model: all rows pair (identical prompts degrade to positional)",
  cm.length === 4 && cm.every((r) => r.kind === "paired"));
assert("cross-model: prompts pair on the same row",
  spoken(leftOf(cm[0])) === "Summarize this" && spoken(rightOf(cm[0])) === "Summarize this" &&
  spoken(leftOf(cm[2])) === "Now translate" && spoken(rightOf(cm[2])) === "Now translate");
assert("cross-model: the two models' answers sit side by side (each side's own text)",
  assistantText(leftOf(cm[1])) === "claude answer 1" && assistantText(rightOf(cm[1])) === "gpt answer 1");

// Insertion: the right side gained a prompt in the MIDDLE. The inserted prompt opens a gap
// on the left, and — critically — the prompts AFTER it stay paired (no silent shift, the
// property positional pairing cannot deliver).
const ins = alignDialogues(
  view(u("P1"), a("x"), u("P2"), a("y")),
  view(u("P1"), a("x2"), u("INSERTED"), a("ins-ans"), u("P2"), a("y2")),
);
const insertedRow = ins.find((r) => spoken(rightOf(r)) === "INSERTED");
assert("insertion: the inserted prompt is a right-only gap (no counterpart on the left)",
  insertedRow !== undefined && insertedRow.kind === "right-only");
const p2Row = ins.find((r) => spoken(leftOf(r)) === "P2");
assert("insertion: the prompt AFTER the insertion STAYS PAIRED — no silent shift",
  p2Row !== undefined && p2Row.kind === "paired" && spoken(rightOf(p2Row)) === "P2");

// Changed prompt (before/after a tweak): the changed prompt fails to pair, showing exactly
// where the two runs diverge — the old on the left, the new on the right, each with a gap.
const chg = alignDialogues(
  view(u("Keep this"), a("x"), u("original wording"), a("y")),
  view(u("Keep this"), a("x2"), u("edited wording"), a("y2")),
);
assert("changed prompt: the old wording is a left-only gap",
  chg.some((r) => r.kind === "left-only" && spoken(r.left) === "original wording"));
assert("changed prompt: the new wording is a right-only gap",
  chg.some((r) => r.kind === "right-only" && spoken(r.right) === "edited wording"));
assert("changed prompt: the unchanged prompt before it still pairs",
  chg[0]?.kind === "paired" && spoken(leftOf(chg[0])) === "Keep this");

// Whitespace-only difference in a prompt must STILL pair (normalization is whitespace-
// collapse + trim), so trailing-newline / indentation differences between platforms don't
// spuriously open a gap.
const ws = alignDialogues(view(u("Same prompt")), view(u("  Same   prompt\n")));
assert("whitespace-only prompt difference still pairs (normalized match)",
  ws.length === 1 && ws[0]?.kind === "paired");

// A leading assistant segment (dialogue opens mid-agent-turn, no preceding prompt) pairs
// with the other side's leading assistant segment, then the prompts pair.
const lead = alignDialogues(view(a("lead L"), u("P1")), view(a("lead R"), u("P1")));
assert("leading assistant nodes (no preceding prompt) pair as the first row",
  lead[0]?.kind === "paired" && assistantText(leftOf(lead[0])) === "lead L" && assistantText(rightOf(lead[0])) === "lead R");
assert("after the leading pair, the prompts pair too",
  lead[1]?.kind === "paired" && spoken(leftOf(lead[1])) === "P1");

// Within a matched segment, an assistant node present on only one side is a one-sided gap
// (one model answered, the other didn't) — not a dropped node.
const uneven = alignDialogues(view(u("P1"), a("only-left-answered")), view(u("P1")));
assert("uneven segment: the lone assistant answer is a left-only gap under a paired prompt",
  uneven.length === 2 && uneven[0]?.kind === "paired" &&
    uneven[1]?.kind === "left-only" && assistantText(leftOf(uneven[1])) === "only-left-answered");

// A DiffRow always carries at least one node — 'both null' is unrepresentable by the type,
// and the aligner never emits an empty row.
assert("every aligned row carries at least one node (no empty rows)",
  [...cm, ...ins, ...chg, ...lead, ...uneven].every((r) => leftOf(r) !== null || rightOf(r) !== null));

// ── renderDiffRow: a cell routes through the one enforcer, so redaction holds per-cell ──
const redactedView = deriveViewableDialogue(conv({ turns, overlay: hide1 }));
const redactedRows = alignDialogues(redactedView, redactedView).map(renderDiffRow);
const allCells = redactedRows.flatMap((r) => [r.left, r.right]).filter((c): c is string => c !== null);
assert("a rendered row NEVER leaks a redacted secret (cells route through renderDialogueHtml topLevel:false)",
  allCells.every((c) => !c.includes(SECRET)));
assert("a rendered row shows the redaction marker where a secret turn was hidden",
  allCells.some((c) => c.includes("[redacted]")));
assert("a rendered gap cell is null (the template draws an empty slot, not a blank that reads as 'same')",
  (() => {
    const node = redactedView[0];
    if (node === undefined) return false;
    const r = renderDiffRow({ kind: "left-only", left: node });
    return r.right === null && r.left !== null;
  })());

console.log("diff-check complete");
