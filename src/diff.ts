// [LAW:effects-at-boundaries] The PURE core of the side-by-side diff. It takes an
// ALREADY-FETCHED PasteLoad (the two KV reads live at the /diff route boundary) and
// returns a resolved column — the rendered viewable conversation, or the honest reason
// it can't be shown. No IO here, so the redaction invariant below is unit-testable with
// a hand-built Conversation and no worker runtime.
//
// [LAW:composability] The whole feature is values flowing through seams that already
// exist: loadViewablePaste (the one visibility gate, called twice at the edge),
// deriveViewableDialogue (the one viewable-spine derivation), and renderDialogueHtml
// (the one renderer, reused twice). This module adds no plumbing — it only pairs two
// projections of those seams into a page-level outcome.

import { deriveViewableDialogue } from "./overlay";
import { renderDialogueHtml } from "./renderDialogue";
import type { DisplayNode, ViewableDialogue } from "./dialogue";
import {
  DEFAULT_TITLE,
  PLATFORM_LABEL,
  platformOf,
  sourceOf,
  type Platform,
  type PasteLoad,
  type PasteLoadStatus,
} from "./types";

// [LAW:types-are-the-program] One diff column is EITHER a shown conversation or an
// honest absence — never a half-shown column with an empty body. The `ok:false` arm
// carries the SAME discriminated status loadViewablePaste minted (404 gone/never-was,
// 410 tombstoned, 503 store-down), so the reason a side is missing is preserved
// verbatim into the column, never flattened to a generic "unavailable".
//
// [LAW:one-source-of-truth] The shown arm carries the VIEWABLE DIALOGUE (the model),
// not a pre-rendered html blob. The whole-column html and the per-node cells of an
// aligned diff are both DERIVED from this one view (renderColumnHtml / renderDiffRow),
// so a column has exactly one representation and the redaction boundary is pinned at the
// model layer: view === deriveViewableDialogue(conversation), never raw turns.
export type OkColumn = {
  readonly ok: true;
  readonly slug: string;
  readonly title: string;
  readonly platform: Platform;
  readonly platformLabel: string | null;
  readonly turnCount: number;
  readonly view: ViewableDialogue;
};
export type MissingColumn = {
  readonly ok: false;
  readonly slug: string;
  readonly status: PasteLoadStatus;
  readonly message: string;
};
export type DiffColumn = OkColumn | MissingColumn;

// [LAW:single-enforcer] The redaction boundary. The shown column's HTML is derived
// from deriveViewableDialogue — the ONE viewable-spine derivation every reader surface
// routes through — never from raw conversation.turns. A turn redacted on /<slug> stays
// redacted in its diff column by construction; reading raw turns here would reopen the
// secret-leak hole the overlay + code-export epics closed. [LAW:one-source-of-truth]
// title and platform are the SAME projections /<slug> shows, not a second derivation.
export const deriveDiffColumn = (slug: string, load: PasteLoad): DiffColumn => {
  if (!load.ok) {
    return { ok: false, slug, status: load.status, message: load.message };
  }
  const c = load.conversation;
  const platform = c.platformOverride ?? platformOf(sourceOf(c.origin));
  return {
    ok: true,
    slug,
    title: c.title ?? DEFAULT_TITLE,
    platform,
    platformLabel: PLATFORM_LABEL[platform],
    turnCount: c.turns.length,
    view: deriveViewableDialogue(c),
  };
};

// [LAW:single-enforcer] The ONE fact every diff render shares: a column draws at
// topLevel:false — the SAME suppression the nested subagent render uses. Two columns (or
// two aligned cells) rendered at top level would each mint id="t0", id="t1", …, colliding
// across the document into duplicate ids (unrepresentable by the anchor's own contract).
// The diff page wires no minimap/permalink/clamp, so the tN anchors serve nothing here;
// data-index/topic/role still emit (only id must be document-unique), keeping each spine
// node identifiable per column. Both renderColumnHtml (one-sided whole column) and the
// per-node cells of an aligned diff route through this, so neither can drift into top-level.
const renderNode = (node: DisplayNode): string => renderDialogueHtml([node], false);
export const renderColumnHtml = (view: ViewableDialogue): string => renderDialogueHtml(view, false);

// ── Turn alignment (slopspot-diff-pcd.3) ──────────────────────────────────────────────
// [LAW:decomposition] Align two conversations on the HUMAN-MESSAGE SPINE — the one boundary
// deriveDialogue already splits on (user/system messages). This reuses the codebase's own
// notion of "a turn" rather than inventing a second. The assistant activity between two
// prompts is the unit compared: matching prompts pair, an unmatched prompt opens a gap.

// [LAW:types-are-the-program] One aligned row is EITHER a pairing or a one-sided gap — a
// row carrying NOTHING is unrepresentable. `paired` sits a left node beside its right
// counterpart; `left-only`/`right-only` is a node with no counterpart on the other side (a
// GAP), which the template draws as an empty cell opposite it. There is no fourth arm and
// no "both null" state for a caller to defend against [LAW:no-defensive-null-guards].
export type DiffRow =
  | { readonly kind: "paired"; readonly left: DisplayNode; readonly right: DisplayNode }
  | { readonly kind: "left-only"; readonly left: DisplayNode }
  | { readonly kind: "right-only"; readonly right: DisplayNode };

// A segment of the spine: the leading spoken (user/system) node — the prompt the alignment
// keys on — and the agent activity that follows it before the next prompt. `lead` is null
// only for a leading segment of assistant activity with no preceding prompt (a dialogue that
// opens mid-agent-turn); it pairs only with another lead-less segment. `rest` is provably at
// most one assistant node (deriveDialogue merges all agent activity between two prompts into
// one), but the pairing below zips it generally rather than assuming that count.
type Segment = { readonly lead: DisplayNode | null; readonly rest: ReadonlyArray<DisplayNode> };

// [LAW:dataflow-not-control-flow] One pass over the spine, cutting a new segment at each
// spoken node. Non-spoken (assistant) nodes accumulate into the open segment's `rest`;
// assistant nodes before the first prompt open a lead-less segment so nothing is dropped.
const segments = (view: ViewableDialogue): ReadonlyArray<Segment> => {
  const segs: Array<{ lead: DisplayNode | null; rest: DisplayNode[] }> = [];
  let open: { lead: DisplayNode | null; rest: DisplayNode[] } | null = null;
  for (const dn of view) {
    if (dn.node.kind === "spoken") {
      open = { lead: dn, rest: [] };
      segs.push(open);
    } else {
      if (open === null) {
        open = { lead: null, rest: [] };
        segs.push(open);
      }
      open.rest.push(dn);
    }
  }
  return segs;
};

// [LAW:one-source-of-truth] The prompt match key: role-qualified, whitespace-normalized
// content. Whitespace-collapse is the one safe normalization (platforms differ on trailing
// newlines / indentation); NO lowercasing or quote-folding — those over-normalize and would
// false-match genuinely distinct prompts. A lead-less segment keys to "" (a real prompt's
// key always carries a role prefix, so it can never collide with ""), so two lead-less
// segments pair and a lead-less segment on only one side opens a gap.
const NUL = "\u0000";
const segKey = (seg: Segment): string =>
  seg.lead !== null && seg.lead.node.kind === "spoken"
    ? `${seg.lead.node.role}${NUL}${seg.lead.node.content.replace(/\s+/g, " ").trim()}`
    : "";

// [LAW:composability] Classic LCS backtrack over two sequences by a string key, emitting an
// ordered edit script: a matched pair, a left-only, or a right-only step. This is where the
// "content, not position" decision lives — equal keys in order degrade to the identity
// pairing (row i <-> row i) for free, while an inserted/removed/changed key opens a gap at
// exactly its position instead of shifting every following pair (the silent shift the ticket
// forbids). Pure and total; the sequences are prompt-count short, so O(n·m) DP is ample.
const lcsAlign = <T>(
  a: ReadonlyArray<T>,
  b: ReadonlyArray<T>,
  key: (t: T) => string,
): ReadonlyArray<{ readonly l: T | null; readonly r: T | null }> => {
  const m = a.length;
  const n = b.length;
  // dp[(i,j)] = LCS length of the suffixes a[i:] and b[j:]. Stored in a Map keyed by a flat
  // index; a MISSING key is an out-of-range (empty) suffix, whose LCS is 0 — so `?? 0` is the
  // recurrence's base case made explicit, not a swallowed absence [LAW:no-silent-failure].
  const dp = new Map<number, number>();
  const idx = (i: number, j: number): number => i * (n + 1) + j;
  const len = (i: number, j: number): number => dp.get(idx(i, j)) ?? 0;
  for (let i = m - 1; i >= 0; i--) {
    const ai = a[i];
    for (let j = n - 1; j >= 0; j--) {
      const bj = b[j];
      const matched = ai !== undefined && bj !== undefined && key(ai) === key(bj);
      dp.set(idx(i, j), matched ? len(i + 1, j + 1) + 1 : Math.max(len(i + 1, j), len(i, j + 1)));
    }
  }
  const out: Array<{ l: T | null; r: T | null }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const ai = a[i];
    const bj = b[j];
    if (ai !== undefined && bj !== undefined && key(ai) === key(bj)) {
      out.push({ l: ai, r: bj });
      i++;
      j++;
    } else if (len(i + 1, j) >= len(i, j + 1)) {
      if (ai !== undefined) out.push({ l: ai, r: null });
      i++;
    } else {
      if (bj !== undefined) out.push({ l: null, r: bj });
      j++;
    }
  }
  for (; i < m; i++) {
    const ai = a[i];
    if (ai !== undefined) out.push({ l: ai, r: null });
  }
  for (; j < n; j++) {
    const bj = b[j];
    if (bj !== undefined) out.push({ l: null, r: bj });
  }
  return out;
};

// [LAW:effects-at-boundaries] The PURE alignment core, over the two viewable dialogues the
// columns already produced — no rendering, no IO, so it is unit-tested on node identities
// alone [LAW:behavior-not-structure]. Segment both spines, LCS the segments by prompt key,
// then flatten each aligned step into node-level rows: a matched pair emits a paired prompt
// row (unless both leads are lead-less) then zips the assistant rest positionally; an
// unmatched segment emits its every node as a one-sided gap row.
export const alignDialogues = (
  left: ViewableDialogue,
  right: ViewableDialogue,
): ReadonlyArray<DiffRow> => {
  const rows: DiffRow[] = [];
  const push = (l: DisplayNode | null, r: DisplayNode | null): void => {
    if (l !== null && r !== null) rows.push({ kind: "paired", left: l, right: r });
    else if (l !== null) rows.push({ kind: "left-only", left: l });
    else if (r !== null) rows.push({ kind: "right-only", right: r });
  };
  for (const { l, r } of lcsAlign(segments(left), segments(right), segKey)) {
    push(l?.lead ?? null, r?.lead ?? null);
    const lrest = l?.rest ?? [];
    const rrest = r?.rest ?? [];
    for (let k = 0; k < Math.max(lrest.length, rrest.length); k++) {
      push(lrest[k] ?? null, rrest[k] ?? null);
    }
  }
  return rows;
};

// [LAW:types-are-the-program] A rendered row for the template: each cell is html, or null
// where this side has no counterpart (the gap). Derived from a DiffRow, whose type already
// forbids both-null, so the template draws one non-empty cell opposite each null without a
// defensive guard. Each cell routes through renderNode (topLevel:false), so a redacted node
// stays redacted in its cell exactly as in a whole column [LAW:single-enforcer].
export type RenderedDiffRow = { readonly left: string | null; readonly right: string | null };
export const renderDiffRow = (row: DiffRow): RenderedDiffRow => {
  switch (row.kind) {
    case "paired":
      return { left: renderNode(row.left), right: renderNode(row.right) };
    case "left-only":
      return { left: renderNode(row.left), right: null };
    case "right-only":
      return { left: null, right: renderNode(row.right) };
  }
};

// [LAW:types-are-the-program] The page outcome, one arm per display mode. BOTH sides loaded
// ⇒ an `aligned` diff carrying the paired rows. EXACTLY ONE side loaded ⇒ `one-sided`: the
// present column beside the absent side's honest status (there is nothing to align against,
// so this keeps the substrate's independent-column layout). NEITHER ⇒ `fail`, carrying BOTH
// reasons [LAW:no-silent-failure]. Alignment is only meaningful with two dialogues, so it
// lives in the aligned arm alone — the template never re-decides which mode to draw.
export type DiffOutcome =
  | {
      readonly kind: "aligned";
      readonly left: OkColumn;
      readonly right: OkColumn;
      readonly rows: ReadonlyArray<DiffRow>;
    }
  | { readonly kind: "one-sided"; readonly left: DiffColumn; readonly right: DiffColumn }
  | { readonly kind: "fail"; readonly status: PasteLoadStatus; readonly message: string };

// [LAW:no-silent-failure] The more-severe of two failure statuses, ordered by transience:
// 503 (store down — retryable) > 410 (tombstoned) > 404 (never existed). Returning the
// actual higher value (not Math.max, which widens to number) keeps the type PasteLoadStatus.
// The both-missing page uses this so a transient 503 on EITHER side yields a non-cacheable
// 503 response, rather than a cacheable 404/410 that a CDN could pin as permanently-gone
// after the store recovers.
const moreSevere = (a: PasteLoadStatus, b: PasteLoadStatus): PasteLoadStatus => (a >= b ? a : b);

export const diffOutcome = (left: DiffColumn, right: DiffColumn): DiffOutcome => {
  if (left.ok && right.ok) {
    return { kind: "aligned", left, right, rows: alignDialogues(left.view, right.view) };
  }
  if (left.ok || right.ok) {
    return { kind: "one-sided", left, right };
  }
  return {
    kind: "fail",
    status: moreSevere(left.status, right.status),
    message:
      `Neither paste could be shown. ` +
      `${left.slug}: ${left.message} · ${right.slug}: ${right.message}`,
  };
};
