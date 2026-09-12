// [LAW:decomposition] The performer seam: the one shape a voice must have to be driven by
// the Listen panel. One sentence, no "and": this module says what a performer is. It
// performs nothing — the browser synthesizer is speechPlayer.ts, the neural voice is
// neuralPerformer.ts — and it depends on nothing but the manifest's span types, so both
// implementations, the painter and the panel sit downhill of it [LAW:one-way-deps].
//
// [LAW:one-type-per-behavior] Two engines, one type. The neural unit player and the Web
// Speech synthesizer differ in everything internal — one plays PCM on the audio clock unit
// by unit, the other hands the browser a sentence at a time — and in nothing the panel can
// see: both answer the same four verbs, both are idle, speaking or paused, and both stand
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
// performer's state, `carry`: the same events for the browser voice handing over to the
// neural voice once it is ready as for the neural voice handing back on a crash. The
// place carries over as a Mark — the word under the voice when it had one, else the start
// of the segment it was inside — which is the one place both performers can stand.

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
