// [LAW:decomposition] The single-turn card render target: given the derived spine
// and a URL turn segment ("t<N>"), produce the HTML for exactly that one turn — the
// embeddable card the permalinks epic promises and the embed epic (oEmbed) wraps.
// It is a pure projection of the stored original like every other view; it depends on
// the renderer and the model, never the reverse [LAW:one-way-deps].
//
// [LAW:single-enforcer] It renders through the SAME renderDialogueHtml the full page
// uses — there is no second card component — so a turn drawn as a card cannot drift
// from the same turn drawn in the full conversation. Rendering a one-element view whose
// DisplayNode carries its true index restores the node's t<N> identity [LAW:one-source-
// of-truth]. The canonical t<N> grammar it parses lives in slug.ts (parseTurnSegment),
// the one grammar the oEmbed turn-URL parser reads too — so "what counts as turn t<N>"
// is decided in exactly one place.

import type { ViewableDialogue, DisplayNode } from "./dialogue";
import { renderDialogueHtml } from "./renderDialogue";
import { parseTurnSegment } from "./slug";

// [LAW:single-enforcer] The SINGLE resolver of "which display node is turn N in this view".
// The lookup is by the node's CARRIED index, not array position, so a turn OMITTED by a
// feature overlay (absent from the view) resolves to null rather than whatever node now
// sits at that array slot [LAW:one-source-of-truth]. Both the card render below and the
// oEmbed turn endpoint answer "does t<N> exist?" through THIS one function, so the set of
// turns that render as a card and the set the endpoint will embed are identical by
// construction — a non-existent turn is an honest absence (null) on both surfaces.
export const findTurn = (view: ViewableDialogue, index: number): DisplayNode | null =>
  view.find((d) => d.index === index) ?? null;

// [LAW:no-silent-failure] A segment that isn't a canonical t<N>, or an index that names no
// visible node, is an honest absence (null) — the route renders it as 404, never a fallback
// to turn 0 or to the whole conversation.
export const renderTurnCard = (view: ViewableDialogue, segment: string): string | null => {
  const index = parseTurnSegment(segment);
  if (index === null) return null;
  const node = findTurn(view, index);
  return node === null ? null : renderDialogueHtml([node], true);
};
