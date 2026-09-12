// [LAW:decomposition] The performer seam: the one shape a voice must have to be driven by
// the Listen panel. One sentence, no "and": this module says what a performer is. It
// performs nothing — the browser synthesizer is speechPlayer.ts, the neural voice is
// neuralPerformer.ts — and it depends on nothing but the word-span type, so both
// implementations and the panel sit downhill of it [LAW:one-way-deps].
//
// [LAW:one-type-per-behavior] Two engines, one type. The neural unit player and the Web
// Speech synthesizer differ in everything internal — one plays PCM on the audio clock unit
// by unit, the other hands the browser a sentence at a time — and in nothing the panel can
// see: both answer the same four verbs, both are idle, speaking or paused, and both stand
// somewhere in the page's utterance list. That shared surface is this file; what a
// performer cannot be asked here (a seek inside an utterance, the manifest's timeline) is
// the neural performer's own, reached through its own type.
//
// [LAW:one-source-of-truth] Position is ONE value, `Spot`: which utterance, and the span of
// its text the voice is on right now, in utterance-text coordinates. The panel reads it —
// on every frame while speaking, through `state()` — and paints from it; it never keeps a
// copy of its own. A synthesizer reports the span from its word boundaries where the
// browser fires them, the neural voice from the manifest's word table; a voice that has no
// word yet reports the whole utterance, so a guess never looks like a measurement.
//
// [LAW:no-ambient-temporal-coupling] The takeover is a pure function of the outgoing
// performer's state, `carry`: the same events for the browser voice handing over to the
// neural voice once it is ready as for the neural voice handing back on a crash. The
// utterance index carries over; the offset restarts at the utterance, which is the one
// place both performers can stand.

import type { WordSpan } from "./speechManifest";

// Where a performer is: an index into the page's utterance list, and the span of that
// utterance's text under the voice.
export interface Spot {
  readonly utterance: number;
  readonly span: WordSpan;
}

// [LAW:types-are-the-program] `at` exists only while there is somewhere to be: an idle
// performer holding a stale position is not expressible.
export type PerformerState =
  | { readonly kind: "idle" }
  | { readonly kind: "speaking"; readonly at: Spot }
  | { readonly kind: "paused"; readonly at: Spot };

// The reader's four verbs. `seek` moves to the start of an utterance: a speaking or idle
// performer plays from there, a paused one stays paused there — the reader asked to move,
// not to start.
export type PerformerEvent =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "stop" }
  | { readonly kind: "seek"; readonly to: number };

export interface Performer {
  readonly send: (event: PerformerEvent) => void;
  // A live read: within an utterance the span moves with no event, so the panel reads it
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
      return [{ kind: "seek", to: from.at.utterance }];
    case "paused":
      return [{ kind: "seek", to: from.at.utterance }, { kind: "pause" }];
  }
};
