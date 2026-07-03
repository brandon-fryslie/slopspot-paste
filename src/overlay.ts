// [LAW:effects-at-boundaries] The PURE author-overlay transform: it takes the derived
// Dialogue and the authored Overlay and returns a new Dialogue with the directives
// applied. No IO, no storage — the stored original is untouched; this shapes only the
// disposable display projection (ARCHITECTURE.md, [LAW:one-source-of-truth]).
// [LAW:one-way-deps] display depends on the model (dialogue, types); neither depends on
// this module.
//
// [LAW:single-enforcer] deriveViewableDialogue is the ONE place a stored paste becomes
// its viewable spine. Every PUBLIC render path — the full page ([slug].astro) and the
// single-turn card (the /t<N> permalink, via renderTurnCard) — routes through it, so a
// redaction cannot leak through one path while another still shows the content. The
// editor preview renders the author's raw working turns directly (editor/store.ts): a
// different concern — the author is editing unredacted content — so it does NOT pass
// through here.

import type { Conversation, Overlay } from "./types";
import type { AssistantBlock, Dialogue, SpineNode, ViewableDialogue } from "./dialogue";
import { deriveDialogue, plainView } from "./dialogue";

// [LAW:no-silent-failure] The visible marker a redacted turn shows in place. A hidden
// turn is REPLACED here, never removed — so its t<N> anchor, and every following turn's
// anchor, stay put (renderDialogue numbers spine nodes positionally), and the reader
// sees that something was withheld rather than the content silently vanishing.
const REDACTED = "[redacted]";

// [LAW:types-are-the-program] Exhaustiveness witness: callable only with a value the
// type system has narrowed to `never`. Adding a directive kind (collapse, feature) or an
// OverlayTarget arm without handling it in the dispatch below stops compiling — the same
// completeness a mapped-type registry gives, without committing a uniform handler
// signature the non-uniform cases would not share.
const assertNever = (x: never): never => {
  throw new Error(`applyOverlay: unhandled case: ${String(x)}`);
};

// [LAW:one-source-of-truth] The span-addressable prose blocks — the ONE definition of
// "which assistant blocks a sub-turn span can reach". The free-prose arms (text, insight,
// thinking) each carry a reader-visible `content` string a leaked secret can sit in; the
// structured/meta arms carry none, so `"content" in block` is exactly the membership test,
// derived from the block type itself rather than a hand-kept kind list. Structured blocks
// (tool calls, subagent transcripts) are not span-addressable this slice — whole-turn
// `hide` is their superset. spanPieces (extract) and redactSpansInNode (rebuild) both key
// off this one predicate, so they cannot disagree about which blocks are pieces.
type ProseBlock = Extract<AssistantBlock, { readonly content: string }>;
const isProseBlock = (block: AssistantBlock): block is ProseBlock => "content" in block;

// The ordered prose strings a span can address in a node — the raw source a span's offsets
// index into, and whose length bounds a valid range. A spoken node is a single piece (its
// content); an assistant node is one piece per prose block, in block order.
const spanPieces = (node: SpineNode): ReadonlyArray<string> =>
  node.kind === "spoken" ? [node.content] : node.blocks.filter(isProseBlock).map((b) => b.content);

// A resolved span within one node: which prose piece, and the half-open [start,end) range.
type Span = { readonly piece: number; readonly start: number; readonly end: number };

// What redaction a node receives: replace the WHOLE node (whole-turn hide), or splice a set
// of sub-turn spans. Whole is the superset — a node with both gets whole.
type NodeRedaction =
  | { readonly kind: "whole" }
  | { readonly kind: "spans"; readonly spans: ReadonlyArray<Span> };

// [LAW:types-are-the-program] The three display facts an overlay decides, folded out of the
// flat directive list: which nodes have redacted CONTENT (hide), which are FOLDED (collapse),
// and — if any feature directive exists — which are FEATURED (the highlight-reel whitelist).
// `featured === null` is the honest "no feature directive ⇒ show every node" state, distinct
// from an empty set (feature directives present but none matched, ⇒ show nothing). Keeping it
// a value here means applyOverlay's filter is a data test, not a mode flag [LAW:dataflow-not-
// control-flow].
type DisplayPlan = {
  readonly redactions: ReadonlyMap<number, NodeRedaction>;
  readonly collapsed: ReadonlySet<number>;
  readonly featured: ReadonlySet<number> | null;
};

// [LAW:dataflow-not-control-flow] Fold the flat directive list into the plan the one render
// pass reads — variability captured as data, not a branch per node. Every switch is
// exhaustive: a new directive kind, or a new OverlayTarget arm, is compiler-forced to declare
// its effect here (the seam the epic wants). collapse/feature target whole turns (their
// TurnTarget carries only an index), so they need no inner target switch.
const displayPlan = (overlay: Overlay): DisplayPlan => {
  const redactions = new Map<number, NodeRedaction>();
  const collapsed = new Set<number>();
  const featured = new Set<number>();
  let hasFeature = false;
  for (const directive of overlay) {
    switch (directive.kind) {
      case "hide": {
        const { target } = directive;
        switch (target.kind) {
          case "turn":
            redactions.set(target.index, { kind: "whole" });
            break;
          case "span": {
            const existing = redactions.get(target.index);
            // A whole-turn hide already at this index is the superset; the span is moot.
            if (existing?.kind === "whole") break;
            const spans = existing?.kind === "spans" ? existing.spans : [];
            redactions.set(target.index, {
              kind: "spans",
              spans: [...spans, { piece: target.piece, start: target.start, end: target.end }],
            });
            break;
          }
          default:
            return assertNever(target);
        }
        break;
      }
      case "collapse":
        collapsed.add(directive.target.index);
        break;
      case "feature":
        hasFeature = true;
        featured.add(directive.target.index);
        break;
      default:
        return assertNever(directive);
    }
  }
  return { redactions, collapsed, featured: hasFeature ? featured : null };
};

// Normalize a piece's spans into MAXIMAL DISJOINT ranges: sort by start, then fold each
// range into the previous when they overlap or merely touch (start <= prev.end). Overlapping
// spans express one intent — redact their union — so folding is the correct meaning, not an
// error; adjacent spans collapse to a single marker rather than two abutting ones. This makes
// the splice below total: after merging, no two ranges share coordinates.
const mergeRanges = (
  spans: ReadonlyArray<Span>,
): ReadonlyArray<{ readonly start: number; readonly end: number }> => {
  const merged: Array<{ start: number; end: number }> = [];
  for (const { start, end } of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  return merged;
};

// [LAW:dataflow-not-control-flow] Replace each range with the marker, applied from the
// RIGHTMOST range first (reduceRight over the ascending merged ranges) so every splice uses
// coordinates into the ORIGINAL string — with the ranges now disjoint, the marker's differing
// length never shifts a not-yet-applied range. Offsets are in-bounds by construction
// (outOfRangeTarget rejected any that weren't at the write edge).
const applySpansToString = (source: string, spans: ReadonlyArray<Span>): string =>
  mergeRanges(spans).reduceRight((s, { start, end }) => s.slice(0, start) + REDACTED + s.slice(end), source);

// Replace a spine node's readable content with the redaction marker, PRESERVING its kind
// and position. A spoken node keeps its role; an assistant turn collapses its interleaved
// blocks to a single redaction line. The node's array slot is unchanged, so its t<N>
// identity is stable [LAW:one-source-of-truth].
const redactWholeNode = (node: SpineNode): SpineNode =>
  node.kind === "spoken"
    ? { kind: "spoken", role: node.role, content: REDACTED }
    : { kind: "assistant", blocks: [{ kind: "text", content: REDACTED }] };

// Splice each span into its target prose piece, PRESERVING node kind, block order, and
// piece count — so t<N> anchors stay byte-stable exactly as whole-turn hide does. The piece
// counter advances in lockstep with spanPieces (both gate on isProseBlock), so a span keyed
// on piece p lands on the p-th prose block's content.
const redactSpansInNode = (node: SpineNode, spans: ReadonlyArray<Span>): SpineNode => {
  const forPiece = (piece: number): ReadonlyArray<Span> => spans.filter((s) => s.piece === piece);
  if (node.kind === "spoken") {
    const own = forPiece(0);
    return own.length === 0
      ? node
      : { kind: "spoken", role: node.role, content: applySpansToString(node.content, own) };
  }
  let piece = -1;
  const blocks = node.blocks.map((block) => {
    if (!isProseBlock(block)) return block;
    piece += 1;
    const own = forPiece(piece);
    return own.length === 0 ? block : { ...block, content: applySpansToString(block.content, own) };
  });
  return { kind: "assistant", blocks };
};

// Apply a node's content redaction (whole node, or its sub-turn spans). The node's kind and
// position are preserved either way, so its t<N> identity is unchanged [LAW:one-source-of-truth].
const applyRedaction = (node: SpineNode, redaction: NodeRedaction): SpineNode =>
  redaction.kind === "whole" ? redactWholeNode(node) : redactSpansInNode(node, redaction.spans);

// [LAW:dataflow-not-control-flow] One pass over the spine, in source order, producing the
// renderer's ViewableDialogue. Each node carries its ORIGINAL index as a value, so the
// feature FILTER can drop non-featured nodes without renumbering the survivors — t<N> stays
// stable by construction, never recomputed from array position. Content redaction and the
// collapse flag are read per index off the plan; a HIDDEN node is expressed as ABSENCE (the
// filter removes it), not a render-time skip. An empty overlay is the identity view — the
// same all-shown shape plainView produces for the non-overlaid paths.
export const applyOverlay = (dialogue: Dialogue, overlay: Overlay): ViewableDialogue => {
  if (overlay.length === 0) return plainView(dialogue);
  const { redactions, collapsed, featured } = displayPlan(overlay);
  return dialogue
    .map((node, index) => ({ node, index }))
    .filter(({ index }) => featured === null || featured.has(index))
    .map(({ node, index }) => {
      const redaction = redactions.get(index);
      return {
        index,
        node: redaction === undefined ? node : applyRedaction(node, redaction),
        collapsed: collapsed.has(index),
      };
    });
};

// [LAW:types-are-the-program] Why a target addresses nothing in a given paste — a directive
// that would redact NOTHING. The write boundary needs the REASON (not just "bad"), so a
// failed redaction is legible rather than a silent no-op that leaves a secret exposed while
// reporting success [LAW:no-silent-failure]. The three arms are the three coordinates a
// span layers on: the turn index, the prose piece, then the char range.
export type TargetFault =
  | { readonly kind: "turn-out-of-range"; readonly index: number; readonly spineLength: number }
  | {
      readonly kind: "piece-out-of-range";
      readonly index: number;
      readonly piece: number;
      readonly pieceCount: number;
    }
  | {
      readonly kind: "span-out-of-bounds";
      readonly index: number;
      readonly piece: number;
      readonly start: number;
      readonly end: number;
      readonly pieceLength: number;
    };

// [LAW:no-silent-failure] The first directive whose target addresses nothing in this paste,
// or null if every target is real. The lower bounds and start<end are already guaranteed by
// isOverlayTarget (the boundary validator), so this checks only the per-paste UPPER bounds:
// the index names a real spine node, the piece a real prose piece of it, and the range fits
// inside that piece. Deriving the spine here matches the exact t<N>/piece coordinates the
// renderer emits.
// [LAW:effects-at-boundaries] Pure: derives the spine from the turns and compares; the
// caller owns the KV read/write.
export const outOfRangeTarget = (
  turns: Conversation["turns"],
  overlay: Overlay,
): TargetFault | null => {
  const dialogue = deriveDialogue(turns);
  for (const { target } of overlay) {
    const node = dialogue[target.index];
    if (node === undefined) {
      return { kind: "turn-out-of-range", index: target.index, spineLength: dialogue.length };
    }
    if (target.kind === "turn") continue;
    const pieces = spanPieces(node);
    const piece = pieces[target.piece];
    if (piece === undefined) {
      return {
        kind: "piece-out-of-range",
        index: target.index,
        piece: target.piece,
        pieceCount: pieces.length,
      };
    }
    if (target.end > piece.length) {
      return {
        kind: "span-out-of-bounds",
        index: target.index,
        piece: target.piece,
        start: target.start,
        end: target.end,
        pieceLength: piece.length,
      };
    }
  }
  return null;
};

// [LAW:one-source-of-truth] The human sentence for each fault, co-located with the fault
// kinds so a new kind is compiler-forced to describe itself. The write boundary surfaces
// this verbatim, so the author sees WHY a redaction was rejected.
const plural = (n: number): string => (n === 1 ? "" : "s");
export const describeTargetFault = (fault: TargetFault): string => {
  switch (fault.kind) {
    case "turn-out-of-range":
      // A zero-turn paste (Conversation.turns is ReadonlyArray, so empty is representable)
      // has no t<N> range to name — the parenthetical would render a nonsensical "t0–t-1".
      return fault.spineLength === 0
        ? `Directive targets turn ${fault.index}, but this paste has no turns.`
        : `Directive targets turn ${fault.index}, but this paste has only ${fault.spineLength} turn${plural(fault.spineLength)} (t0–t${fault.spineLength - 1}).`;
    case "piece-out-of-range":
      return `Directive targets prose piece ${fault.piece} of turn ${fault.index}, but that turn has only ${fault.pieceCount} redactable piece${plural(fault.pieceCount)}.`;
    case "span-out-of-bounds":
      return `Directive redacts characters ${fault.start}–${fault.end} of turn ${fault.index} piece ${fault.piece}, but that piece is only ${fault.pieceLength} character${plural(fault.pieceLength)} long.`;
  }
};

// [LAW:single-enforcer] The one derivation of a paste's viewable spine: derive the
// dialogue from the stored turns, then apply the authored overlay. It asks only for the
// two fields it reads [LAW:composability], so any caller holding those can produce the
// same viewable dialogue every public render path shows.
export const deriveViewableDialogue = (
  conversation: Pick<Conversation, "turns" | "overlay">,
): ViewableDialogue => applyOverlay(deriveDialogue(conversation.turns), conversation.overlay ?? []);
