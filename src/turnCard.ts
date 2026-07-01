// [LAW:decomposition] The single-turn card render target: given the derived spine
// and a URL turn segment ("t<N>"), produce the HTML for exactly that one turn — the
// embeddable card the permalinks epic promises and the embed epic (oEmbed) will wrap.
// It is a pure projection of the stored original like every other view; it depends on
// the renderer and the model, never the reverse [LAW:one-way-deps].
//
// [LAW:single-enforcer] It renders through the SAME renderDialogueHtml the full page
// uses — there is no second card component — so a turn drawn as a card cannot drift
// from the same turn drawn in the full conversation. Slicing to [node] and passing
// baseIndex=index restores the node's true t<N> identity [LAW:one-source-of-truth].

import type { Dialogue } from "./dialogue";
import { renderDialogueHtml } from "./renderDialogue";

// The URL names a turn by the SAME t<N> spine index the in-page permalink and minimap
// use. The form is canonical: exactly one string per turn — "t0", "t1", … with no
// leading zeros — so "t007" is not a silent alias for "t7" [LAW:one-source-of-truth].
const TURN_SEGMENT = /^t(0|[1-9]\d*)$/;

// [LAW:no-silent-failure] A segment that isn't a canonical t<N>, or an index past the
// end of the spine, is an honest absence (null) — the route renders it as 404, never
// a fallback to turn 0 or to the whole conversation. deriveDialogue emits only spine
// nodes at top level, so every in-range index names a real, addressable turn; the
// only invalid index is one beyond the spine, which reads as undefined here.
export const renderTurnCard = (dialogue: Dialogue, segment: string): string | null => {
  const match = TURN_SEGMENT.exec(segment);
  if (!match) return null;
  const index = Number(match[1]);
  const node = dialogue[index];
  if (node === undefined) return null;
  return renderDialogueHtml([node], true, index);
};
