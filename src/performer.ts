// [LAW:decomposition] The performer seam: the one shape a voice must have to be driven by
// the Listen panel. One sentence, no "and": this module says what a performer is. It
// performs nothing — the browser synthesizer is speechPlayer.ts, the neural voice is
// neuralPerformer.ts — and it depends on nothing but the manifest's span types, so both
// implementations, the painter and the panel sit downhill of it [LAW:one-way-deps].
//
// [LAW:one-type-per-behavior] Two engines, one type. The neural unit player and the Web
// Speech synthesizer differ in everything internal — one plays PCM on the audio clock unit
// by unit, the other hands the browser a sentence at a time — and in nothing the panel can
// see: both answer the same five verbs, both are idle, speaking or paused, and both stand
// somewhere in the page's text. That shared surface is this file; what a performer cannot
// be asked here (the manifest's timeline) is the neural performer's own, reached through
// its own type.
//
// [LAW:one-source-of-truth] Position is ONE value, `Spot`: which utterance, the segment of
// its text the voice is inside, and the word it is on when one may be claimed — all in
// utterance-text coordinates. The panel reads it — on every frame while speaking, through
// `state()` — and paints from it; it never keeps a copy of its own. A synthesizer reports
// the word from its boundary events where the browser fires them, the neural voice from
// the manifest's word table; a voice that has no word yet reports none, so a guess never
// looks like a measurement [LAW:no-silent-failure].
//
// A `Mark` is the same coordinates as a point: an utterance and a character in its text.
// It is what a seek names — the start of an utterance, a tapped word, the place the last
// performer stood — and both performers resolve it to their own clock: the synthesizer
// speaks the text from that character, the neural voice finds the unit that holds it and
// the time its word begins.
//
// [LAW:no-ambient-temporal-coupling] The takeover is a pure function of the outgoing
// performer's state, `carry` — the place alone, since the speed is not a performer's fact
// to hand over but the panel's, sent to whoever takes the stage: the same events for the
// browser voice handing over to the neural voice once it is ready as for the neural voice
// handing back on a crash. The place carries over as a Mark — the word under the voice
// when it had one, else the start of the segment it was inside — which is the one place
// both performers can stand.

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
// run at each performer's door: a caller naming a character past the end is a bug, not a
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

// The reader's five verbs. `seek` moves to a mark: a speaking or idle performer plays from
// there, a paused one stays paused there — the reader asked to move, not to start. `rate`
// is obeyed at once and never reported back: the speed is the transport's one value, held
// by the panel across handovers and crashes, and a performer that kept its own copy would
// be a second clock for it [LAW:one-source-of-truth].
export type PerformerEvent =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "stop" }
  | { readonly kind: "seek"; readonly to: Mark }
  | { readonly kind: "rate"; readonly to: Speed };

export interface Performer {
  readonly send: (event: PerformerEvent) => void;
  // A live read: within an utterance the cursor moves with no event, so the panel reads it
  // on every frame while speaking.
  readonly state: () => PerformerState;
  // The performer's last call: silent, and whatever it held is released.
  readonly dispose: () => void;
}

// What an incoming performer is told so it stands where the outgoing one stood. Idle
// carries nothing; speaking seeks (which plays); paused seeks, then holds.
export const carry = (from: PerformerState): ReadonlyArray<PerformerEvent> => {
  switch (from.kind) {
    case "idle":
      return [];
    case "speaking":
      return [{ kind: "seek", to: markOf(from.at) }];
    case "paused":
      return [{ kind: "seek", to: markOf(from.at) }, { kind: "pause" }];
  }
};
