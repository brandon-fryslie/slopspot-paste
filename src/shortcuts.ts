// [LAW:decomposition] The transport's keyboard: it says which gesture a key press is, or
// none. One sentence, no "and" hiding a second job — this module decides nothing about
// whether the transport is listening (listenPanel's `listening`), performs nothing, and
// touches no element; it is handed the facts of one press and answers with a value, so
// scripts/shortcuts-check.ts presses every key with no browser at all
// [LAW:effects-at-boundaries].
//
// WHY THESE KEYS AND NOT THE OBVIOUS ONES. This is a page a reader reads, not a player they
// stand in front of, so the transport may only take keys the page does not need. Up and
// Down scroll and stay the page's; Left and Right do nothing on a vertical document and
// become the ten-second nudges. Space is the one genuine collision — it pages a document
// and it plays a voice — and it is taken only while a voice is playing or paused, which is
// the panel's reading (`listening`), checked by whoever wires this. Before the first Listen
// and after a Stop, every key here is the page's own.
//
// [LAW:one-source-of-truth] What "the reader is typing, not gesturing" means is follow.ts's
// PAGING_KEYS and EDITABLE, not a second list here: that map already says, per key, which
// elements take it instead of the page — Space belongs to a focused button and a fold as
// well as to a text field, while a bracket or a bare minus belongs to the text field alone.
// Reading it here is what keeps a focused Stop button from being "pressed" and a speed
// change at once, and a minus typed into the Ask box from slowing the voice.

import { EDITABLE, PAGING_KEYS } from "./follow";
import type { Gesture } from "./listenPanel";

// How far a nudge moves on the conversation's clock. Ten seconds is the ticket's, and the
// interval every podcast player has taught readers to expect from an arrow.
export const NUDGE_SECONDS = 10;

// [LAW:types-are-the-program] Exactly the facts of a press this answer depends on, so a
// real KeyboardEvent satisfies it structurally and the check builds one as a plain value.
// Shift is deliberately absent: "+" IS a shifted key on most layouts, so a press with
// Shift held is an ordinary press, while Ctrl, Meta and Alt make it the browser's or the
// system's — Cmd+[ goes back, and a voice that changed speed on the way out would be a bug.
export interface Press {
  readonly key: string;
  readonly target: EventTarget | null;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

// [LAW:dataflow-not-control-flow] The whole keyboard as one table from key to gesture: a
// new shortcut is a row, never a branch. Several names for one gesture where a layout gives
// the reader more than one way to type it — "+" and "=" are the same key with and without
// Shift, as are "-" and "_".
const KEYS: ReadonlyMap<string, Gesture> = new Map<string, Gesture>([
  [" ", { kind: "tap", control: "play" }],
  ["ArrowLeft", { kind: "nudge", bySeconds: -NUDGE_SECONDS }],
  ["ArrowRight", { kind: "nudge", bySeconds: NUDGE_SECONDS }],
  ["[", { kind: "turn", by: -1 }],
  ["]", { kind: "turn", by: 1 }],
  ["-", { kind: "speed", by: -1 }],
  ["_", { kind: "speed", by: -1 }],
  ["+", { kind: "speed", by: 1 }],
  ["=", { kind: "speed", by: 1 }],
]);

// Whether the element under the press takes this key itself: the editor, the ask box and
// the scrubber take every key here, and Space additionally belongs to a focused button or a
// fold — which is exactly what PAGING_KEYS records, key by key.
const consumed = (press: Press): boolean =>
  press.target instanceof Element && press.target.closest(PAGING_KEYS.get(press.key) ?? EDITABLE) !== null;

// [LAW:parse-dont-validate] A press, parsed into the gesture it is — or the typed absence
// that means the page keeps the key. The caller's whole obligation is to prevent the key's
// default when a gesture comes back, which is also what tells the follower the page did not
// scroll [LAW:no-ambient-temporal-coupling].
export const shortcut = (press: Press): Gesture | null => {
  if (press.ctrlKey || press.metaKey || press.altKey) return null;
  const gesture = KEYS.get(press.key);
  return gesture === undefined || consumed(press) ? null : gesture;
};
