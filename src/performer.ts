// [LAW:decomposition] The performer seam: the shape a voice has to be driven by the Listen
// panel. One sentence, no "and": this module says what a performer is. It performs nothing
// — the neural voice is neuralPerformer.ts — and it depends on nothing but the manifest's
// span types, so the performer, the painter and the panel sit downhill of it
// [LAW:one-way-deps].
//
// [LAW:one-source-of-truth] Position is ONE value, `Spot`: which utterance, the segment of
// its text the voice is inside, and the word it is on when one may be claimed — all in
// utterance-text coordinates. The panel reads it — on every frame while speaking, through
// `state()` — and paints from it; it never keeps a copy of its own. The voice reports the
// word from the manifest's word table; a unit that has no record yet reports none, so a
// guess never looks like a measurement [LAW:no-silent-failure].
//
// A `Mark` is the same coordinates as a point: an utterance and a character in its text.
// It is what a seek names — the start of an utterance, a tapped word, the place the voice
// stood before a crash — and the performer resolves it to its own clock: the unit that
// holds the character and the time its word begins.

import type { Cursor } from "./speechManifest";

// A point in the page's text: an index into the page's utterance list, and a character
// offset into that utterance's text.
export interface Mark {
  readonly utterance: number;
  readonly char: number;
}

// Where a performer is: an utterance, and the cursor within its text.
export interface Spot extends Cursor {
  readonly utterance: number;
}

// The mark a spot stands at: its word when it has one, else where its segment begins.
export const markOf = (at: Spot): Mark => ({ utterance: at.utterance, char: (at.word ?? at.segment).charStart });

// The top of the conversation: where a performer stands before anyone has asked for a place.
export const TOP: Mark = { utterance: 0, char: 0 };

// [LAW:single-enforcer] The one check that a mark's character is in its utterance's text,
// run at the performer's door: a caller naming a character past the end is a bug, not a
// sentence that plays empty and moves on [LAW:no-silent-failure].
export const charIn = (text: string, mark: Mark): number => {
  if (!Number.isInteger(mark.char) || mark.char < 0 || mark.char >= text.length) {
    throw new RangeError(`performer: cannot seek to character ${mark.char} of ${text.length} in utterance ${mark.utterance}`);
  }
  return mark.char;
};

// [LAW:types-are-the-program] `at` exists only while there is somewhere to be: an idle
// performer holding a stale position is not expressible.
export type PerformerState =
  | { readonly kind: "idle" }
  | { readonly kind: "speaking"; readonly at: Spot }
  | { readonly kind: "paused"; readonly at: Spot };

// The reader's four verbs. `seek` moves to a mark: a speaking or idle performer plays from
// there, a paused one stays paused there — the reader asked to move, not to start.
export type PerformerEvent =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "stop" }
  | { readonly kind: "seek"; readonly to: Mark };

export interface Performer {
  readonly send: (event: PerformerEvent) => void;
  // A live read: within an utterance the cursor moves with no event, so the panel reads it
  // on every frame while speaking.
  readonly state: () => PerformerState;
  // The performer's last call: silent, and whatever it held is released.
  readonly dispose: () => void;
}
