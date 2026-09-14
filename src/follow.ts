// [LAW:decomposition] The follower: it keeps the read-along cursor in view while the voice
// moves, and lets go when the reader takes the page. One sentence, no "and" hiding a second
// job: this module decides when the page scrolls to the cursor. It paints nothing
// (readAlong.ts), knows no performer and no panel; it is handed what was painted and the
// reader's own gestures, and asks the page to reveal an element.
//
// [LAW:no-ambient-temporal-coupling] Whether the page follows is ONE fact, `Follow`, and
// every change to it is an event with a name: the reader scrolled the page themselves
// (released), the reader asked for it back — the Follow button, or a tap on a word, which
// is the reader looking exactly where the voice is about to be (following), the voice
// moved on to another turn (following: the reader who scrolled away to check something
// gets brought back at the next passage, the ticket's rule). No timer decides any of it,
// and no scroll is inferred from a scroll event, which cannot say who scrolled: a
// programmatic reveal fires the same event a wheel does. The reader's gestures are read
// where they are gestures — the wheel, a touch, the keys that page, a pointer on the
// scrollbar. Cost, stated once: a scrollbar drag is known by the pointer's place, which the
// page answers from its own geometry.
//
// [LAW:dataflow-not-control-flow] After every event the same step runs: the button shows
// whatever the state is, and the last painted cursor is revealed exactly when the state
// says follow and its rect is outside the band. The band — the middle half of the viewport
// — is why a following page does not scroll on every word: a word moving down a paragraph
// stays inside it, and only a word that has left it recentres the page.
//
// [LAW:effects-at-boundaries] Geometry and scrolling are the browser's: the module is
// handed a `FollowView` with exactly the three readings and one action it uses, so
// scripts/follow-check.ts drives it under jsdom with a stub of each [LAW:verifiable-goals].

import type { Painted } from "./readAlong";

// ── the pure part ──────────────────────────────────────────────────────────────────────

export type Follow = "following" | "released";

export type FollowEvent =
  // The reader moved the page themselves.
  | { readonly kind: "reader" }
  // The reader asked the page to follow again.
  | { readonly kind: "follow" }
  // The voice moved on to another turn.
  | { readonly kind: "turn" };

// [LAW:polishing-by-subtraction] The next state is the event's alone — no transition reads
// the state it leaves — so the reducer takes no state: a fact set by the last event.
export const follow = (event: FollowEvent): Follow => {
  switch (event.kind) {
    case "reader":
      return "released";
    case "follow":
    case "turn":
      return "following";
  }
};

export interface Rect {
  readonly top: number;
  readonly bottom: number;
}

// The share of the viewport, top and bottom, outside which a cursor is revealed.
export const BAND_MARGIN = 0.25;

// Whether the cursor at `rect` is inside the band of a viewport `height` tall.
export const inBand = (rect: Rect, height: number, margin: number = BAND_MARGIN): boolean =>
  rect.top >= height * margin && rect.bottom <= height * (1 - margin);

// The keys that scroll a page, each with the elements on which it does something else
// instead: all of them type or move a caret in an editable element; Space alone also
// presses a button and opens a fold, while the others scroll straight through both.
//
// [LAW:one-source-of-truth] Exported because the transport's keyboard asks the same
// question of the same page (shortcuts.ts): "does the element under this press take the key
// itself?" One table answers it for both, so a control that swallows Space cannot be a
// button to one of them and the page to the other. EDITABLE is the answer for every key
// this map does not name.
export const EDITABLE = "input, textarea, select, [contenteditable]";
export const PAGING_KEYS: ReadonlyMap<string, string> = new Map([
  ["PageUp", EDITABLE],
  ["PageDown", EDITABLE],
  ["Home", EDITABLE],
  ["End", EDITABLE],
  ["ArrowUp", EDITABLE],
  ["ArrowDown", EDITABLE],
  [" ", `${EDITABLE}, button, summary`],
]);

// ── the driver ─────────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] Exactly the surface of the browser the follower reads and
// moves, so a window satisfies it structurally and the check's stub implements no more.
export interface FollowView {
  readonly viewportHeight: () => number;
  readonly rectOf: (el: Element) => Rect;
  // Bring the element to the middle of the viewport; how (smooth or not) is the page's.
  readonly reveal: (el: Element) => void;
  // Whether a pointer at (x, y) is on the page's scrollbar rather than its content.
  readonly scrollbarAt: (x: number, y: number) => boolean;
}

export interface FollowerConfig {
  readonly view: FollowView;
  // Where the reader's gestures arrive: the window.
  readonly gestures: EventTarget;
  // The Follow control: shown while released and there is a cursor to follow.
  readonly button: HTMLButtonElement;
}

export interface Follower {
  // What the painter painted, or null when nothing is.
  readonly cursor: (painted: Painted | null) => void;
  readonly send: (event: FollowEvent) => void;
  readonly state: () => Follow;
  // Stops listening to the reader's gestures, the Follow button among them.
  readonly dispose: () => void;
}

export const createFollower = (config: FollowerConfig): Follower => {
  const { view, gestures, button } = config;
  // [LAW:no-shared-mutable-globals] Owned here; `state` written only through `send`,
  // `last` only through `cursor`.
  let state: Follow = "following";
  let last: Painted | null = null;

  const sync = (): void => {
    button.hidden = state === "following" || last === null;
    if (last !== null && state === "following" && !inBand(view.rectOf(last.el), view.viewportHeight())) view.reveal(last.el);
  };

  const send = (event: FollowEvent): void => {
    state = follow(event);
    sync();
  };

  const cursor = (painted: Painted | null): void => {
    const turned = painted !== null && painted.anchor !== last?.anchor;
    last = painted;
    if (turned) state = follow({ kind: "turn" });
    sync();
  };

  const reader = (): void => send({ kind: "reader" });
  const onKey = (event: Event): void => {
    const key = event as KeyboardEvent;
    // A key whose default has already been prevented did not scroll the page: the transport
    // claimed it (shortcuts.ts, in the capture phase, which the DOM runs before this
    // listener whatever order the page wired them in) and the reader is seeking, not
    // scrolling away from the voice [LAW:no-ambient-temporal-coupling].
    if (key.defaultPrevented) return;
    const consumedOn = PAGING_KEYS.get(key.key);
    const consumed = consumedOn !== undefined && key.target instanceof Element && key.target.closest(consumedOn) !== null;
    if (consumedOn !== undefined && !consumed) reader();
  };
  const onPointer = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (view.scrollbarAt(pointer.clientX, pointer.clientY)) reader();
  };
  const listeners: ReadonlyArray<readonly [EventTarget, string, (event: Event) => void]> = [
    [gestures, "wheel", reader],
    [gestures, "touchmove", reader],
    [gestures, "keydown", onKey],
    [gestures, "pointerdown", onPointer],
    [button, "click", () => send({ kind: "follow" })],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener, { passive: true });
  sync();

  return {
    cursor,
    send,
    state: () => state,
    dispose: () => {
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    },
  };
};
