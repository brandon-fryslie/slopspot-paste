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
import type { Dialogue, SpineNode } from "./dialogue";
import { deriveDialogue } from "./dialogue";

// [LAW:no-silent-failure] The visible marker a redacted turn shows in place. A hidden
// turn is REPLACED here, never removed — so its t<N> anchor, and every following turn's
// anchor, stay put (renderDialogue numbers spine nodes positionally), and the reader
// sees that something was withheld rather than the content silently vanishing.
const REDACTED = "[redacted]";

// [LAW:types-are-the-program] Exhaustiveness witness: callable only with a value the
// type system has narrowed to `never`. Adding a DirectiveKind (collapse, feature)
// without handling it in the dispatch below stops compiling — the same completeness a
// mapped-type registry gives, without committing a uniform handler signature the
// non-uniform kinds (per-node hide/collapse vs a global feature filter) would not share.
const assertNever = (kind: never): never => {
  throw new Error(`applyOverlay: unhandled directive kind: ${String(kind)}`);
};

// Replace a spine node's readable content with the redaction marker, PRESERVING its kind
// and position. A spoken node keeps its role; an assistant turn collapses its interleaved
// blocks to a single redaction line. The node's array slot is unchanged, so its t<N>
// identity is stable [LAW:one-source-of-truth].
const redactNode = (node: SpineNode): SpineNode =>
  node.kind === "spoken"
    ? { kind: "spoken", role: node.role, content: REDACTED }
    : { kind: "assistant", blocks: [{ kind: "text", content: REDACTED }] };

// [LAW:dataflow-not-control-flow] The set of top-level spine indices a directive hides —
// variability captured as data the one render pass reads, not a branch per node. The
// switch is exhaustive over the directive kind; the next kind added to the union is
// compiler-forced to declare its effect here.
const hiddenIndices = (overlay: Overlay): ReadonlySet<number> => {
  const hidden = new Set<number>();
  for (const directive of overlay) {
    switch (directive.kind) {
      case "hide":
        hidden.add(directive.target.index);
        break;
      default:
        return assertNever(directive.kind);
    }
  }
  return hidden;
};

// [LAW:dataflow-not-control-flow] One pass over the spine, in source order: each node is
// redacted when its index is targeted, else passed through — variability lives in the
// VALUE (is this index hidden?), never in whether the map runs. Length is preserved, so
// downstream anchors are byte-identical to the un-overlaid render.
export const applyOverlay = (dialogue: Dialogue, overlay: Overlay): Dialogue => {
  if (overlay.length === 0) return dialogue;
  const hidden = hiddenIndices(overlay);
  return dialogue.map((node, index) => (hidden.has(index) ? redactNode(node) : node));
};

// [LAW:no-silent-failure] A `hide` directive whose target index is past the end of the
// derived spine (or, defensively, below zero) would redact NOTHING — an authoring mistake
// that, in a redaction feature, silently protects nothing. Return the first such index so
// the write boundary can reject it loudly rather than store a no-op redaction and report
// success. null = every directive targets a real spine node.
// [LAW:effects-at-boundaries] Pure: it derives the spine from the turns and compares
// indices; the caller owns the KV read/write. The spine length is exactly what
// renderDialogue numbers positionally (t0…t<len-1>), so this bound matches the anchors.
export const outOfRangeTarget = (
  turns: Conversation["turns"],
  overlay: Overlay,
): number | null => {
  const spineLength = deriveDialogue(turns).length;
  for (const directive of overlay) {
    const { index } = directive.target;
    if (index < 0 || index >= spineLength) return index;
  }
  return null;
};

// [LAW:single-enforcer] The one derivation of a paste's viewable spine: derive the
// dialogue from the stored turns, then apply the authored overlay. It asks only for the
// two fields it reads [LAW:composability], so any caller holding those can produce the
// same viewable dialogue every public render path shows.
export const deriveViewableDialogue = (
  conversation: Pick<Conversation, "turns" | "overlay">,
): Dialogue => applyOverlay(deriveDialogue(conversation.turns), conversation.overlay ?? []);
