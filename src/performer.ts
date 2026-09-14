// [LAW:decomposition] The performer seam: the shape a voice has to be driven by the Listen
// panel. One sentence, no "and": this module says what a performer is. It performs nothing
// — the neural voice is neuralPerformer.ts — and it depends on nothing, so the performer,
// the timeline, the painter and the panel sit downhill of it [LAW:one-way-deps].
//
// [LAW:one-source-of-truth] Position is ONE value: a time in milliseconds on the
// conversation's timeline (timeline.ts). The panel reads it — on every frame while
// speaking, through `state()` — and derives everything it paints from the timeline at that
// time; it never keeps a copy of its own, and there is no second shape of position for it
// to handle. A `Mark` is the durable NAME of a place — an utterance and a character in its
// text, what a tap on a word and a share link carry — and it is resolved to a time by the
// timeline at the moment it is used, never held as the position.

// A point in the page's text: an index into the page's utterance list, and a character
// offset into that utterance's text.
export interface Mark {
  readonly utterance: number;
  readonly char: number;
}

// The top of the conversation: where a performer stands before anyone has asked for a place.
export const TOP: Mark = { utterance: 0, char: 0 };

// [LAW:types-are-the-program] `atMs` exists only while there is somewhere to be: an idle
// performer holding a stale position is not expressible.
export type PerformerState =
  | { readonly kind: "idle" }
  | { readonly kind: "speaking"; readonly atMs: number }
  | { readonly kind: "paused"; readonly atMs: number };

// [LAW:types-are-the-program] How fast the voice reads, as the closed set the transport
// offers rather than a number: the strongest true theorem about a speed in this program is
// that it is one of these seven, so no performer has a rate to check at its door and no
// caller can name 40x. The ticket's 0.75x–2.5x, in the steps a reader recognises.
export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const;
export type Speed = (typeof SPEEDS)[number];
export const NORMAL: Speed = 1;

// One step along the list, stopping at its ends — where `stepSpeed` returns the speed it
// was given, which is what disables the control that would have gone further.
export const stepSpeed = (from: Speed, by: -1 | 1): Speed => SPEEDS[Math.min(Math.max(SPEEDS.indexOf(from) + by, 0), SPEEDS.length - 1)] ?? from;

// The reader's five verbs. `seek` moves to a time on the timeline: a speaking or idle
// performer plays from there, a paused one stays paused there — the reader asked to move,
// not to start. `rate`
// is obeyed at once and never reported back: the speed is the transport's one value, held
// by the panel across crashes and the whole download, and a performer that kept its own
// copy would be a second clock for it [LAW:one-source-of-truth].
export type PerformerEvent =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "stop" }
  | { readonly kind: "seek"; readonly toMs: number }
  | { readonly kind: "rate"; readonly to: Speed };

export interface Performer {
  readonly send: (event: PerformerEvent) => void;
  // A live read: the clock moves with no event, so the panel reads it on every frame while
  // speaking.
  readonly state: () => PerformerState;
  // The performer's last call: silent, and whatever it held is released.
  readonly dispose: () => void;
}
