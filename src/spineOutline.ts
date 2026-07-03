// [LAW:decomposition] The topic spine outline: a clickable, no-JS navigation derived
// PURELY from the viewable dialogue. One entry per VISIBLE top-level spine node, each
// anchored to that node's existing t<N> id and labeled from its own text — a projection of
// the stored original computed at render time, so it re-derives for every existing paste
// for free with zero migration [LAW:no-ambient-temporal-coupling]. [LAW:one-way-deps] it
// depends on the model (dialogue); the model never depends on it.
//
// [LAW:one-source-of-truth] It consumes the SAME ViewableDialogue the renderer draws, so an
// overlay's effects reach the outline by construction: a feature-omitted turn is absent from
// the view and so from the outline, and each entry's index/anchor is the node's CARRIED
// index — never the array position — so omission never renumbers a survivor's anchor. The
// anchor is turnAnchorId(index) — the SAME string the renderer emits as the node's id — and
// the label is spineNodeLabel(node) — the SAME text the minimap markers read via data-topic.

import type { ViewableDialogue } from "./dialogue";
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
  view: ViewableDialogue,
): ReadonlyArray<OutlineEntry> =>
  view.map(({ index, node }) => ({
    index,
    anchor: turnAnchorId(index),
    role: node.kind === "spoken" ? node.role : "assistant",
    label: spineNodeLabel(node),
  }));
