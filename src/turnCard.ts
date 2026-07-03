// [LAW:decomposition] The single-turn card render target: given the derived spine
// and a URL turn segment ("t<N>"), produce the HTML for exactly that one turn — the
// embeddable card the permalinks epic promises and the embed epic (oEmbed) will wrap.
// It is a pure projection of the stored original like every other view; it depends on
// the renderer and the model, never the reverse [LAW:one-way-deps].
//
// [LAW:single-enforcer] It renders through the SAME renderDialogueHtml the full page
// uses — there is no second card component — so a turn drawn as a card cannot drift
// from the same turn drawn in the full conversation. Rendering a one-element view whose
// DisplayNode carries its true index restores the node's t<N> identity [LAW:one-source-
// of-truth].

import type { ViewableDialogue } from "./dialogue";
import { renderDialogueHtml } from "./renderDialogue";

// The URL names a turn by the SAME t<N> spine index the in-page permalink and minimap
// use. The form is canonical: exactly one string per turn — "t0", "t1", … with no
// leading zeros — so "t007" is not a silent alias for "t7" [LAW:one-source-of-truth].
const TURN_SEGMENT = /^t(0|[1-9]\d*)$/;

// [LAW:no-silent-failure] A segment that isn't a canonical t<N>, or an index that names
// no visible node, is an honest absence (null) — the route renders it as 404, never a
// fallback to turn 0 or to the whole conversation. The lookup is by CARRIED index, not
// array position, so a turn OMITTED by a feature overlay (absent from the view) 404s
// correctly rather than resolving whatever node now sits at that array slot
// [LAW:one-source-of-truth].
export const renderTurnCard = (view: ViewableDialogue, segment: string): string | null => {
  const match = TURN_SEGMENT.exec(segment);
  if (!match) return null;
  const index = Number(match[1]);
  const displayNode = view.find((d) => d.index === index);
  if (displayNode === undefined) return null;
  return renderDialogueHtml([displayNode], true);
};
