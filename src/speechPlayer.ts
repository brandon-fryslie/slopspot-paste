// The Listen tool's browser edge: it performs the utterances speech.ts derived, and owns
// the one thing a synthesizer cannot be trusted with — WHERE we are in the conversation.
//
// [LAW:decomposition] One sentence, no "and": this module plays an ordered list of
// utterances against a Web Speech synthesizer. It does not decide what is said (speech.ts
// did) and knows nothing of the dock, the panel's markup, or the page around it — the
// caller hands it a highlight callback and it calls that; it never reaches for a turn card.
//
// [LAW:no-ambient-temporal-coupling] Two pieces of ambient timing are deliberately refused:
//
//  1. We speak ONE utterance at a time and advance on its `end` event, rather than queueing
//     the whole conversation into the synthesizer. The browser queue is a global the page
//     shares with anything else that speaks, it cannot be seeked, and `cancel()` empties it
//     wholesale — so a queued design would have pause/stop fighting a structure it does not
//     own. Position lives HERE, in one state value, which is what makes stop-and-resume,
//     skip, and "which turn is playing" answerable at all.
//  2. Voices load asynchronously and `getVoices()` is empty on first call in most browsers.
//     Nothing here caches a voice list at construction; the assignment is recomputed at each
//     utterance, so a voice list that arrives late simply takes effect on the next sentence
//     rather than leaving the whole session stuck on the default voice.

import { charIn, TOP, type Mark, type Performer, type PerformerEvent, type PerformerState, type Spot } from "./performer";
import type { Utterance, Voice } from "./speech";
import { VOICES } from "./speech";
import { wordSpans, type WordSpan } from "./speechManifest";

// The window the player lives in, carried rather than reached for as a global — the same
// shape toolDockView uses, and for the same reason: the check drives this module against a
// jsdom window carrying a stub synthesizer, so every behaviour below has something standing
// in front of it [LAW:verifiable-goals] [LAW:no-shared-mutable-globals].
export type SpeechWindow = Window & typeof globalThis;

// [LAW:types-are-the-program] The player's total state. `at` is a mark in the page's text —
// the utterance, and the character it is being spoken from — and exists ONLY while there
// is something to be at: an idle player holding a stale position, or a paused player with
// no position, are not expressible, so nothing below has to defend against them.
export type PlayerState =
  | { readonly kind: "idle" }
  | { readonly kind: "speaking"; readonly at: Mark }
  | { readonly kind: "paused"; readonly at: Mark };

const sameMark = (a: Mark, b: Mark): boolean => a.utterance === b.utterance && a.char === b.char;

// [LAW:types-are-the-program] Everything that can move the player, as data. The set is
// closed, so `advance` below can be a total function over it and the compiler forces any
// new event to be given a meaning at every state rather than defaulting to "no change".
export type PlayerEvent = PerformerEvent | { readonly kind: "finished" };

// [LAW:dataflow-not-control-flow] The whole state machine as one pure total function:
// (state, event, length) → state. It performs nothing — no speaking, no highlighting — so
// the check can assert every transition directly, including the ones that are awkward to
// reach through a real synthesizer (finishing the last utterance, seeking while paused).
//
// `length` is passed rather than closed over because it is the one fact that decides
// whether "advance past here" means a next utterance or the end of the conversation.
export const advance = (state: PlayerState, event: PlayerEvent, length: number): PlayerState => {
  // A conversation with nothing to say cannot be played into a speaking state; every event
  // resolves to idle. Stated once, here, so no arm below carries an emptiness check. Same
  // reference when already idle — matching every arm's no-op pattern — because `send()`'s
  // short-circuit is a reference check: without this, a player constructed with an empty
  // `utterances` array would never pass its own no-op check and would cancel/report on
  // every single event for its whole life, even the redundant ones.
  if (length <= 0) return state.kind === "idle" ? state : { kind: "idle" };

  switch (event.kind) {
    case "play":
      // Already speaking is a true no-op, matching every other arm's pattern (pause,
      // stop, finished, seek's identical-position guard): `send()`'s no-op short-circuit
      // is a reference check, and a redundant `play` that allocated a fresh object would
      // fall into the general branch and cancel-then-restart the sentence already in
      // progress, discarding whatever the listener had already heard of it.
      // Otherwise: play from where we are — resuming a pause keeps its position, starting
      // from idle begins at the top.
      return state.kind === "speaking" ? state : { kind: "speaking", at: state.kind === "idle" ? TOP : state.at };
    case "pause":
      return state.kind === "speaking" ? { kind: "paused", at: state.at } : state;
    case "stop":
      // Already idle is a true no-op, not merely an equivalent state: `send()` below
      // decides whether to touch the synthesizer at all by reference-comparing the
      // before/after state, so a `stop` sent while idle (the page's `pagehide` handler
      // fires this unconditionally on every navigation) must return the SAME object or
      // it will cancel a synthesizer that was never given anything to cancel.
      return state.kind === "idle" ? state : { kind: "idle" };
    case "finished": {
      // Only a speaking player advances. A `finished` arriving while paused or idle is the
      // synthesizer reporting on an utterance we already abandoned — cancel() fires `end`
      // on whatever was mid-sentence — and acting on it would skip a turn the listener
      // never heard. Ignoring it is the whole reason position lives here and not in the
      // browser's queue.
      if (state.kind !== "speaking") return state;
      const next = state.at.utterance + 1;
      return next >= length ? { kind: "idle" } : { kind: "speaking", at: { utterance: next, char: 0 } };
    }
    case "seek": {
      // A seek out of range is not a silent clamp: an out-of-range target is a caller bug,
      // and clamping it would play a turn the caller did not ask for while reporting success
      // [LAW:no-silent-failure]. The character is checked against the utterance's text by
      // `send`, which has the text; this function has only the count.
      const { utterance } = event.to;
      if (!Number.isInteger(utterance) || utterance < 0 || utterance >= length) {
        throw new RangeError(`speech player: cannot seek to utterance ${utterance} of ${length}`);
      }
      // A seek to the SAME mark the player is already at (paused or speaking) is a true
      // no-op, not merely an equivalent-looking state: `send()` decides whether to cancel
      // and re-speak by reference-comparing before/after, and a paused player seeked to its
      // own position has nothing to resume from if this allocates a fresh object — the
      // general branch would cancel the held utterance and the next Play would restart it
      // from the beginning instead of resuming where the listener paused.
      if (state.kind !== "idle" && sameMark(state.at, event.to)) return state;
      // Seeking while paused keeps you paused at the new place — the listener asked to move,
      // not to start playing.
      return state.kind === "paused" ? { kind: "paused", at: event.to } : { kind: "speaking", at: event.to };
    }
  }
};

// ── voices ───────────────────────────────────────────────────────────────────────────

// The per-voice delivery. Narration is OUR words about the conversation, so it is set
// apart by how it sounds rather than by a spoken label like "narrator:" on every line —
// the listener learns the timbre in one sentence and never has to hear the word again.
const DELIVERY: { readonly [K in Voice]: { readonly rate: number; readonly pitch: number } } = {
  user: { rate: 1, pitch: 1 },
  assistant: { rate: 1, pitch: 0.95 },
  system: { rate: 1, pitch: 1.05 },
  narrator: { rate: 1.12, pitch: 0.85 },
};

// [LAW:dataflow-not-control-flow] Assign a distinct synthesizer voice to each of our four
// voices, from whatever the browser offers. Total by construction: a browser with one voice
// (or none) yields nulls, and null means "the synthesizer's default" — a legitimate value
// the caller passes straight through, never an error and never a silently dropped utterance.
//
// English voices are preferred but not required: the ordering puts them first and then
// takes what is left, so a browser with no English voice still gets four assignments rather
// than none. Deterministic given the same list, which is what makes it testable.
//
// The modulo is already the OPTIMAL spread a pigeonhole allows, not a shortcut that could
// be tightened: four roles poured into fewer than four voices must pair at least
// `4 - ordered.length` of them onto a voice something else already has, and `i %
// ordered.length` is exactly "use every available voice once before any voice repeats" —
// with 2 voices, (user, system) and (assistant, narrator) pair up; with 3, only one role
// repeats. No reassignment scheme does better once ordered.length < 4; DELIVERY's per-role
// rate/pitch is what keeps a paired role from sounding IDENTICAL, not merely different.
export const assignVoices = (available: ReadonlyArray<SpeechSynthesisVoice>): {
  readonly [K in Voice]: SpeechSynthesisVoice | null;
} => {
  const ordered = [...available].sort((a, b) => {
    const en = (v: SpeechSynthesisVoice): number => (v.lang.toLowerCase().startsWith("en") ? 0 : 1);
    return en(a) - en(b);
  });
  const chosen = {} as { [K in Voice]: SpeechSynthesisVoice | null };
  VOICES.forEach((voice, i) => {
    chosen[voice] = ordered[i % Math.max(ordered.length, 1)] ?? null;
  });
  return chosen;
};


// ── the player ───────────────────────────────────────────────────────────────────────

// What the page hands the player: where to speak, what to say, and the one way the player
// reports back. The callback is REQUIRED rather than optional — an optional callback
// invites a caller to build a player nobody can see the state of, and every real caller
// wants it [LAW:no-defensive-null-guards].
export interface PlayerConfig {
  readonly window: SpeechWindow;
  readonly utterances: ReadonlyArray<Utterance>;
  // Called on every discontinuity: play, pause, stop, seek, and each utterance the
  // synthesizer moves on to. The word within an utterance moves with no report; it is
  // read live through `state()`.
  readonly onState: (state: PerformerState) => void;
}

// The synthesizer as a performer: the seam's verbs, plus `finished`, which the
// synthesizer's own `end` sends.
export interface Player extends Performer {
  readonly send: (event: PlayerEvent) => void;
}

// [LAW:parse-dont-validate] The capability check, as a parser: it returns the synthesizer
// (a type that could not exist if the browser lacked one) or null, so `createPlayer` below
// takes a proven synthesizer and never re-asks. The page uses the same answer to decide
// whether the browser voice stands in at all — a browser with no speech has no stand-in,
// rather than one that does nothing [LAW:no-silent-failure].
export const speechSupport = (
  w: SpeechWindow,
): { readonly synth: SpeechSynthesis; readonly Utter: typeof SpeechSynthesisUtterance } | null => {
  const synth: unknown = w.speechSynthesis;
  const Utter: unknown = w.SpeechSynthesisUtterance;
  if (!synth || typeof synth !== "object" || typeof Utter !== "function") return null;
  return { synth: synth as SpeechSynthesis, Utter: Utter as typeof SpeechSynthesisUtterance };
};

// The word a boundary names, by the manifest's own word rule so a painted word is exactly
// a timed word would be [LAW:one-source-of-truth]: the word containing the boundary's
// character, or the last word begun before it when the browser reports a boundary on
// punctuation. A boundary before any word names no word.
export const boundaryWord = (text: string, charIndex: number): WordSpan | null =>
  wordSpans(text, 0).findLast((word) => word.charStart <= charIndex) ?? null;


export const createPlayer = (config: PlayerConfig): Player | null => {
  const support = speechSupport(config.window);
  if (support === null) return null;
  const { synth, Utter } = support;
  const { utterances, onState } = config;

  let state: PlayerState = { kind: "idle" };
  // The utterance object currently handed to the synthesizer, and which mark it is FOR.
  // `live` alone answers "is a late `end` from a cancelled sentence real" (the browser
  // fires `end` on cancel, and without this the player would advance a turn nobody
  // heard); `liveAt` additionally answers "does the synthesizer actually hold the text
  // from THIS mark" — the fact the resume shortcut below needs, since a paused player
  // whose mark changed via `seek` has a live-utterance slot that no longer agrees with
  // `state.at` at all.
  let live: SpeechSynthesisUtterance | null = null;
  let liveAt: Mark | null = null;
  // The word under the voice within the live utterance: none until the browser fires a
  // word boundary, then the word each boundary names. Browsers that fire no boundaries
  // (Safari) never claim one, which is honest: no word is claimed that was not measured
  // [LAW:no-silent-failure]. The segment is what the synthesizer holds: the utterance's
  // text from the mark it was spoken from.
  let word: WordSpan | null = null;

  const utteranceAt = (at: number): Utterance => {
    const utterance = utterances[at];
    if (utterance === undefined) throw new RangeError(`speech player: no utterance at ${at} of ${utterances.length}`);
    return utterance;
  };
  const segmentOf = (at: Mark): WordSpan => ({ charStart: at.char, charEnd: utteranceAt(at.utterance).text.length });

  const spot = (at: Mark): Spot => ({ utterance: at.utterance, segment: segmentOf(at), word });
  const performerState = (): PerformerState =>
    state.kind === "idle" ? { kind: "idle" } : { kind: state.kind, at: spot(state.at) };

  // The synthesizer is handed the text from the mark on, so a seek to a word starts on
  // that word; a boundary's index is into that suffix, and is put back into utterance
  // coordinates before the word rule reads it.
  const speak = (at: Mark): void => {
    const utterance = utteranceAt(at.utterance);
    const { text } = utterance;
    const voices = assignVoices(synth.getVoices());
    const spoken = new Utter(text.slice(at.char));
    const delivery = DELIVERY[utterance.voice];
    spoken.rate = delivery.rate;
    spoken.pitch = delivery.pitch;
    // A null assignment leaves the synthesizer's own default in place — the honest
    // encoding of "this browser had nothing to choose from".
    const chosen = voices[utterance.voice];
    if (chosen !== null) spoken.voice = chosen;
    spoken.onend = (): void => {
      if (spoken !== live) return;
      send({ kind: "finished" });
    };
    // A boundary from a sentence already abandoned names a word nobody is hearing.
    spoken.onboundary = (event): void => {
      if (spoken !== live || event.name !== "word") return;
      word = boundaryWord(text, at.char + event.charIndex);
    };
    live = spoken;
    liveAt = at;
    word = null;
    synth.speak(spoken);
  };

  // [LAW:single-enforcer] The ONE place state changes and effects are applied. Every
  // control on the page routes through here, so "cancel the current sentence before
  // starting another" is guaranteed by the shape rather than remembered at four call sites.
  const send = (event: PlayerEvent): void => {
    const before = state;
    const after = advance(before, event, utterances.length);
    if (event.kind === "seek") charIn(utteranceAt(event.to.utterance).text, event.to);

    // A TRUE no-op — advance() returns `state` itself, unchanged, exactly for the cases
    // it is legitimately ignoring (e.g. `finished` arriving while paused, `pause` while
    // already paused). Nothing below may run for these: the general branch would cancel
    // a sentence that is still correctly playing/held, for no reason a caller asked for.
    if (after === before) return;
    state = after;

    // Pause/resume are the synthesizer's own — they hold the sentence mid-word, which is
    // what a listener expects, and are the one case where re-speaking would be wrong.
    // The resume shortcut fires ONLY when the synthesizer still genuinely holds the
    // utterance for `after.at` (`liveAt`, not merely `before.at === after.at`): a `seek`
    // taken while paused moves the position without ever calling speak() again — the
    // general branch below cancels whatever was live — so a subsequent Play at that same
    // index has nothing to resume and must speak() fresh.
    if (before.kind === "speaking" && after.kind === "paused") {
      synth.pause();
      onState(performerState());
      return;
    }
    if (before.kind === "paused" && after.kind === "speaking" && liveAt !== null && sameMark(liveAt, after.at)) {
      synth.resume();
      onState(performerState());
      return;
    }

    // Everything else is a position change: abandon whatever is mid-sentence, then either
    // start the new one, hold at a new PAUSED position, or fall silent. `live = null`
    // BEFORE cancel() is what disarms the `end` this cancel is about to fire.
    live = null;
    liveAt = null;
    synth.cancel();
    if (after.kind === "speaking") {
      speak(after.at);
    } else if (after.kind === "paused") {
      // A seek taken while paused (paused@1 → seek{to:2} → paused@2) has a position worth
      // showing even though nothing is vocalizing — the segment from the mark, and no
      // word, since none of it has been said.
      word = null;
    }
    onState(performerState());
  };

  return { send, state: performerState, dispose: () => send({ kind: "stop" }) };
};
