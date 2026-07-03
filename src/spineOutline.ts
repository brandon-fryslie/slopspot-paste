// [LAW:decomposition] The topic spine outline: a clickable, no-JS navigation derived
// PURELY from the Dialogue. One entry per top-level spine node, each anchored to that
// node's existing t<N> id and labeled from its own text — a projection of the stored
// original computed at render time, so it re-derives for every existing paste for free
// with zero migration [LAW:no-ambient-temporal-coupling]. [LAW:one-way-deps] it depends
// on the model (dialogue); the model never depends on it.
//
// [LAW:one-source-of-truth] The anchor is turnAnchorId(index) — the SAME string the
// renderer emits as the node's id — and the label is spineNodeLabel(node) — the SAME
// text the minimap markers read via data-topic. The outline is one more consumer of
// those two derivations, never a second scheme that could drift from them.

import type { Dialogue } from "./dialogue";
import { turnAnchorId, spineNodeLabel } from "./dialogue";

// [LAW:types-are-the-program] One entry per spine node. role is the discriminant the
// CSS colours by (the same three roles the minimap and renderer carry); anchor and
// label are the two derived values, computed by the shared functions above so an
// entry cannot name a turn the renderer didn't emit or show a label the minimap can't.
export interface OutlineEntry {
  readonly index: number;
  readonly anchor: string;
  readonly role: "user" | "system" | "assistant";
  readonly label: string;
}

export const deriveSpineOutline = (
  dialogue: Dialogue,
): ReadonlyArray<OutlineEntry> =>
  dialogue.map((node, index) => ({
    index,
    anchor: turnAnchorId(index),
    role: node.kind === "spoken" ? node.role : "assistant",
    label: spineNodeLabel(node),
  }));
