// [LAW:decomposition] The conversation's timeline: the whole paste laid out end to end on
// one clock, so a place in it can be named by a time, and a time can say what is under
// it. One sentence, no "and" hiding a second job: this module builds the clock and reads
// it. It measures nothing itself (the worker reports durations, speechManifest records
// them), plays nothing, and paints nothing; every function here is pure over a Timeline
// value, so scripts/timeline-check.ts drives it with no mocks at all
// [LAW:effects-at-boundaries].
//
// POSITION IS A TIME. Everything that reads where the voice is reads one number, a
// millisecond on this clock, and derives what it needs from the timeline at that number:
// the scrubber shows the number; the cursor asks what text is under it and paints nothing
// when the answer is silence; the status line asks which passage it is in; the skips ask
// which landmark is before or after it. There is no second shape of position for a
// reader to handle [LAW:one-source-of-truth]. A Mark — an utterance and a character — is
// the durable NAME of a place, what a tap on a word and a share link carry, and it is
// resolved to a time here (`timeAt`) at the moment it is used, never held as the
// position. This deliberately inverts an earlier principle that the Mark was the
// position and time derived from it; time is the authority now, and the shift of an
// estimated leg becoming a measured one is the player's own clock moving, which is what
// it really is.
//
// ONE CLASS OF LEG [LAW:one-type-per-behavior]. A leg is a duration with content, and the
// content is data: spoken text — which utterance, which characters of it, and the word
// times when the worker has measured it — or silence. A gap between two speakers is a
// silence leg like any other leg; it is on the scrubber, the clock runs through it, and a
// seek can land in it. Nothing below switches on a leg's content except the two readings
// whose answer differs by it: what text is under a time (none, in silence) and whether a
// time is still a guess (silence never is). A third content is a new value, not a new rule.
//
// THE GAP IS ONE RULE [LAW:single-enforcer]. `leadsOf` says how much silence precedes each
// span of a conversation given the anchors of its spans: GAP_MS where the anchor changes
// — a turn is a run of one anchor, so only a change of speaker gets a gap — and none
// before the first, because there is no turn before it. The timeline builds its silence
// legs from that list, and the neural performer hands the same list to the unit player as
// the lead-in before each unit's audio, so the clock and the audio cannot disagree about
// where a gap is or how long it runs.
//
// LANDMARKS ARE SPANS OF THE CLOCK. A turn skip lands on the top of the clock or on the
// start of a gap, and the landmark is the whole gap — the top being the span of no length
// at zero. Back is the last landmark strictly before the position, which for a span means
// all of it is; forward is the next landmark beginning strictly after it. That alone gives
// the music player's double tap — back from speech is the gap before this turn, back again
// from inside that gap is the landmark before it, since the gap is not yet wholly behind —
// with no tap window, no grace and no first-turn case [LAW:dataflow-not-control-flow].
//
// WHY THIS CLOCK RUNS PAST THE SYNTHESIZED PREFIX. A leg the worker has measured carries
// its measured milliseconds; a leg it has not carries its share of the conversation's
// characters at the rate the measured legs establish. So the timeline covers every passage
// from the first listen — a scrubber whose length was the measured prefix could never be
// dragged into text the model has not reached — and `estimated` says whether the time still
// to come is measured or guessed, so the panel prints "about" over exactly the guesses
// [LAW:no-silent-failure]. Before any unit is measured every speech leg is estimated at
// DEFAULT_MS_PER_CHAR, which is the honest shape of "we have not heard any of this yet".
//
// ONE BUILD, TWO SOURCES. Once the neural voice is on stage its timeline is built over the
// speech script — one speech leg per synthesis unit, in unit order, measured where the
// manifest has a record; before that, while the reader has a place but no performer yet,
// it is built over the page's own utterances, one leg each, all of it a guess. Everything
// downstream reads legs and cannot tell which built them.

import type { Mark } from "./performer";
import type { Utterance } from "./speech";
import { offsetAt, wordUnder, type Alignment, type Cursor, type Manifest } from "./speechManifest";

// ── the timeline ────────────────────────────────────────────────────────────────────

// How long a character of text takes to say, before anything has been measured. Read off
// the neural voice's own output rather than guessed: driving a six-passage paste through
// Pocket TTS in the browser, the measured rate ran between 56 and 74 ms a character
// depending on the passage — short lines and announced code blocks are the fast end, long
// prose the slow — and 66 is the middle of that, which is also what the first unit of that
// paste measured. It sets the first listen's scale only: the moment one unit is measured,
// the rate is that device's own (see `build`), so this number ages into irrelevance rather
// than into a lie.
export const DEFAULT_MS_PER_CHAR = 66;

// The silence between two speakers, in media time: it runs at the reader's speed like
// every other leg.
export const GAP_MS = 500;

// [LAW:single-enforcer] The silence before each span of a conversation, from the anchors
// of the spans in order: a gap where the speaker changes, none before the first span and
// none within a turn.
export const leadsOf = (anchors: ReadonlyArray<string>): ReadonlyArray<number> =>
  anchors.map((anchor, index) => (index > 0 && anchor !== anchors[index - 1] ? GAP_MS : 0));

// What a leg holds. Spoken text names its utterance, the characters of that utterance's
// text it covers, and its word times — the worker's alignment when the leg is measured,
// none while it is a guess — which is the whole of what the cursor and a tap resolve
// through. Silence holds nothing.
export type Content =
  | {
      readonly kind: "speech";
      readonly utterance: number;
      readonly charStart: number;
      readonly charEnd: number;
      readonly alignment: Alignment | null;
    }
  | { readonly kind: "silence" };

// One stretch of the conversation on the clock: when it begins, how long it runs, and what
// is in it.
export interface Leg {
  readonly startMs: number;
  readonly ms: number;
  readonly content: Content;
}

// The conversation end to end: its legs in order, and how long it runs. A conversation with
// nothing to say has no clock: every reading below of a timeline with no legs is zero or
// nothing, stated once here so no caller carries an emptiness check
// [LAW:dataflow-not-control-flow].
export interface Timeline {
  readonly legs: ReadonlyArray<Leg>;
  readonly totalMs: number;
}

// What a speech leg is built from, before its place on the clock is known: the two
// constructors below differ only in what they put in this list. `anchor` is the turn the
// span belongs to, read for the gaps and kept nowhere.
interface Span {
  readonly utterance: number;
  readonly anchor: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly measuredMs: number | undefined;
  readonly alignment: Alignment | null;
}

type Speech = Extract<Content, { kind: "speech" }>;
const SILENCE: Content = { kind: "silence" };

// Whether a leg's duration is a guess: only unmeasured speech is; silence is by rule.
const guessed = (leg: Leg): boolean => leg.content.kind === "speech" && leg.content.alignment === null;

// [LAW:parse-dont-validate] The one place spans become a timeline: the measured legs set
// the rate, the rest take their character share of it, a silence leg is laid before every
// span that begins a new turn, and every leg is stamped with when it begins. A span
// covering no character could take no share and would be a leg no mark could ever land in,
// so it is a bug in whoever cut the text and says so rather than quietly making the clock
// shorter than the conversation [LAW:no-silent-failure].
const build = (spans: ReadonlyArray<Span>): Timeline => {
  const chars = (span: Span): number => span.charEnd - span.charStart;
  const measured = spans.filter((span) => span.measuredMs !== undefined);
  const measuredMs = measured.reduce((sum, span) => sum + (span.measuredMs ?? 0), 0);
  const measuredChars = measured.reduce((sum, span) => sum + chars(span), 0);
  // A rate of zero would put the whole unheard tail at the same instant; the default
  // stands in until a measurement says something about how long text takes.
  const rate = measuredChars > 0 && measuredMs > 0 ? measuredMs / measuredChars : DEFAULT_MS_PER_CHAR;
  const leads = leadsOf(spans.map((span) => span.anchor));

  let startMs = 0;
  const lay = (ms: number, content: Content): Leg => {
    const leg: Leg = { startMs, ms, content };
    startMs += ms;
    return leg;
  };
  const legs = spans.flatMap((span, index): Leg[] => {
    if (chars(span) <= 0) {
      throw new RangeError(`timeline: utterance ${span.utterance} has a span of no characters at ${span.charStart}`);
    }
    const lead = leads[index] ?? 0;
    const speech: Speech = { kind: "speech", utterance: span.utterance, charStart: span.charStart, charEnd: span.charEnd, alignment: span.alignment };
    return [...(lead > 0 ? [lay(lead, SILENCE)] : []), lay(span.measuredMs ?? chars(span) * rate, speech)];
  });
  return { legs, totalMs: startMs };
};

// The timeline before any performer exists: one leg per passage, none of it measured, since
// nothing has spoken a word of it yet.
export const timelineOfUtterances = (utterances: ReadonlyArray<Utterance>): Timeline =>
  build(
    utterances.map((utterance, index) => ({
      utterance: index,
      anchor: utterance.anchor,
      charStart: 0,
      charEnd: utterance.text.length,
      measuredMs: undefined,
      alignment: null,
    })),
  );

// The neural voice's timeline: one speech leg per synthesis unit, in unit order, measured
// wherever the worker has finished one. `utteranceOf` is the neural performer's own table —
// the page utterance each unit says — so the marks this timeline names are the page's,
// never the script's [LAW:one-source-of-truth]; the turn each unit belongs to is the
// script's own word, since a unit holds its utterance.
export const timelineOfScript = (manifest: Manifest, utteranceOf: ReadonlyArray<number>): Timeline =>
  build(
    manifest.script.map((unit, index) => {
      const utterance = utteranceOf[index];
      if (utterance === undefined) throw new RangeError(`timeline: no utterance for unit ${index} of ${manifest.script.length}`);
      const record = manifest.units[index];
      return {
        utterance,
        anchor: unit.utterance.anchor,
        charStart: unit.start,
        charEnd: unit.end,
        measuredMs: record?.durationMs,
        alignment: record?.alignment ?? null,
      };
    }),
  );

// ── reading it ──────────────────────────────────────────────────────────────────────

// The speech legs in order. For a script timeline this is indexed by unit, which is how
// the neural performer turns its player's unit and offset into a time and back.
export type SpeechLeg = Leg & { readonly content: Speech };
export const speechLegs = (timeline: Timeline): ReadonlyArray<SpeechLeg> =>
  timeline.legs.filter((leg): leg is SpeechLeg => leg.content.kind === "speech");

// [LAW:parse-dont-validate] Where a mark falls on the clock — the one door a Mark comes
// through. Among the legs saying that utterance, the last that begins at or before the
// character, else its first, by the same rule the neural performer chooses a unit with;
// within it, the time the word holding the character begins when the leg has word times,
// and the leg's start when it has none — a guess is not a place in audio nobody has heard.
// An utterance no leg says is a timeline built for another page, and a character outside
// the utterance's text is a caller's bug: both throw rather than answer with someone
// else's passage [LAW:no-silent-failure]. Zero on a conversation with nothing to say.
export const timeAt = (timeline: Timeline, mark: Mark): number => {
  const saying = speechLegs(timeline).filter((leg) => leg.content.utterance === mark.utterance);
  const first = saying[0];
  const last = saying.at(-1);
  if (timeline.legs.length === 0) return 0;
  if (first === undefined || last === undefined) throw new RangeError(`timeline: nothing on this timeline says utterance ${mark.utterance}`);
  if (!Number.isInteger(mark.char) || mark.char < 0 || mark.char >= last.content.charEnd) {
    throw new RangeError(`timeline: no character ${mark.char} of ${last.content.charEnd} in utterance ${mark.utterance}`);
  }
  const leg = saying.findLast((candidate) => candidate.content.charStart <= mark.char) ?? first;
  return leg.startMs + (leg.content.alignment === null ? 0 : offsetAt(leg.content.alignment, mark.char));
};

// The leg under a point on the clock, clamped to both ends: before the start is the first
// leg, past the end is the last. Undefined only for a conversation with nothing to say.
const legAt = (timeline: Timeline, ms: number): Leg | undefined => timeline.legs.findLast((leg) => leg.startMs <= ms) ?? timeline.legs[0];

// The name of the place at a point on the clock: the first spoken character at or after
// it — inside speech, the character under the point; inside silence, the first character
// of the speech that follows, which is what a link to a gap should open on and what a
// retry from a gap should start at. Past the last word it is the last character. Null
// only for a conversation with nothing to say.
export const markAt = (timeline: Timeline, ms: number): Mark | null => {
  const speech = speechLegs(timeline);
  const leg = speech.find((candidate) => candidate.startMs + candidate.ms > ms) ?? speech.at(-1);
  if (leg === undefined) return null;
  const width = leg.content.charEnd - leg.content.charStart;
  const into = leg.ms <= 0 ? 0 : Math.min(Math.max(ms - leg.startMs, 0), leg.ms) / leg.ms;
  return { utterance: leg.content.utterance, char: leg.content.charStart + Math.min(Math.floor(into * width), width - 1) };
};

// What the read-along paints at a point on the clock: the utterance, the segment of its
// text the leg covers, and the word under the point when the leg's alignment is a
// measurement. Null in silence and on a conversation with nothing to say: nothing is
// being said, so nothing is painted.
export interface Spot extends Cursor {
  readonly utterance: number;
}

export const spotAt = (timeline: Timeline, ms: number): Spot | null => {
  const leg = legAt(timeline, ms);
  if (leg === undefined || leg.content.kind === "silence") return null;
  const { utterance, charStart, charEnd, alignment } = leg.content;
  return { utterance, segment: { charStart, charEnd }, word: alignment === null ? null : wordUnder(alignment, ms - leg.startMs) };
};

// Whether any of the conversation still to come at `ms` is a guess rather than a
// measurement — what puts the word "about" in front of the time remaining.
export const estimated = (timeline: Timeline, ms: number): boolean => timeline.legs.some((leg) => guessed(leg) && leg.startMs + leg.ms > ms);

// ── the landmarks ───────────────────────────────────────────────────────────────────

// A span of the clock a turn skip lands at the start of.
export interface Landmark {
  readonly startMs: number;
  readonly endMs: number;
}

// Where a turn skip can land: the top of the clock, a span of no length, and every gap. A
// conversation with nothing to say has no top.
export const landmarks = (timeline: Timeline): ReadonlyArray<Landmark> =>
  timeline.legs.flatMap((leg, index) => [
    ...(index === 0 ? [{ startMs: 0, endMs: 0 }] : []),
    ...(leg.content.kind === "silence" ? [{ startMs: leg.startMs, endMs: leg.startMs + leg.ms }] : []),
  ]);

// The landmark a skip lands on: the start of the last one wholly before the point, or of
// the first one beginning after it. [LAW:dataflow-not-control-flow] "Strictly" is the
// whole rule — a reader in a turn goes back to the gap before it, one anywhere inside that
// gap, or standing at its start, goes back to the landmark before, with no case for
// either. Null at the ends, where there is no such landmark: the transport shows the
// control disabled rather than offering a jump that goes nowhere.
export const landmark = (marks: ReadonlyArray<Landmark>, from: number, by: -1 | 1): number | null =>
  (by < 0 ? marks.findLast((mark) => mark.startMs < from && mark.endMs <= from) : marks.find((mark) => mark.startMs > from))?.startMs ?? null;

// ── saying it ───────────────────────────────────────────────────────────────────────

// A time on the clock, as a listener reads one: m:ss under an hour, h:mm:ss over it, and
// never a negative zero on a clock that has not started.
export const clockText = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};
