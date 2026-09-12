// [LAW:decomposition] The conversation's timeline: the whole paste laid out end to end, so
// a place in it can be named three ways — a mark in the text, a time on its clock, the turn
// it falls in. One sentence, no "and" hiding a second job: this module places a mark on the
// conversation and names the mark at any point of it. It measures nothing itself (the
// worker reports durations, speechManifest records them), plays nothing, and paints
// nothing; every function here is pure over a Timeline value, so scripts/timeline-check.ts
// drives it with no mocks at all [LAW:effects-at-boundaries].
//
// WHY THIS CLOCK RUNS PAST THE SYNTHESIZED PREFIX. speechManifest used to answer global
// time over its `knownPrefix` — the units synthesized without a gap from the start — and
// returned a typed absence beyond it. That is the right answer for a question about
// measured audio and the wrong one for a transport: a scrubber whose length is the prefix
// grows from nothing to the whole paste as the reader listens, its thumb pinned to the
// right edge, and can never be dragged into text the model has not reached yet — which is
// exactly the drag the scheduler exists to answer. So the timeline covers every passage
// from the first listen, and those four functions are gone rather than left beside this one
// for the next reader to pick the wrong clock [LAW:one-source-of-truth].
//
// WHY A GUESS IS STILL HONEST HERE. A leg the worker has measured carries its measured
// milliseconds; a leg it has not carries its share of the conversation's characters at the
// rate the measured legs establish — the same character-share rule speechManifest's
// `estimateTimes` distributes a unit's audio to its words by, one level up. The estimate is
// typed as one on every leg, so `estimated` below can say whether the time still to come is
// measured or guessed, and the panel prints "about" over exactly the guesses
// [LAW:no-silent-failure]. Before any unit is measured — the whole of the first listen,
// and the entire life of a browser-voice stand-in — every leg is estimated at
// DEFAULT_MS_PER_CHAR, which is the honest shape of "we have not heard any of this yet".
//
// [LAW:one-type-per-behavior] One Leg, two sources. The neural voice's timeline is built
// over the speech script — one leg per synthesis unit, measured where the manifest has a
// record — and the stand-in's over the page's utterances, one leg each, since a browser
// synthesizer reports no durations at all. Everything downstream reads legs and cannot tell
// which built them.

import type { Mark } from "./performer";
import type { Utterance } from "./speech";
import type { Manifest } from "./speechManifest";

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

// One stretch of the conversation on the clock: which utterance it says, the characters of
// that utterance's text it covers, when it begins and how long it runs. `kind` is the whole
// of the honesty: `measured` is the worker's report, `estimated` is this module's share-out.
export interface Leg {
  readonly utterance: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly startMs: number;
  readonly ms: number;
  readonly kind: "measured" | "estimated";
}

// The conversation end to end: its legs in order, and how long it runs. The turn landmarks
// are deliberately NOT in here — a turn boundary is a fact of the page's utterance list and
// owes nothing to any measurement, so `turnStarts` below stands alone and a caller that
// wants only the landmarks does not build a clock to get them [LAW:polishing-by-subtraction].
//
// A conversation with nothing to say has no clock: every reading below of a timeline with
// no legs is zero or nothing, stated once here so no caller carries an emptiness check
// [LAW:dataflow-not-control-flow].
export interface Timeline {
  readonly legs: ReadonlyArray<Leg>;
  readonly totalMs: number;
}

// What a leg is built from, before its place on the clock is known: the two constructors
// below differ only in what they put in this list.
interface Span {
  readonly utterance: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly measuredMs: number | undefined;
}

// The mark each turn begins at: the first utterance of every run of one anchor. Utterances
// are in page order and a turn's utterances are contiguous, so a run is a turn.
export const turnStarts = (utterances: ReadonlyArray<Utterance>): ReadonlyArray<Mark> =>
  utterances.flatMap((utterance, index) => (utterance.anchor === utterances[index - 1]?.anchor ? [] : [{ utterance: index, char: 0 }]));

// [LAW:parse-dont-validate] The one place spans become a timeline: the measured legs set
// the rate, the rest take their character share of it, and every leg is stamped with when
// it begins. A span covering no character could take no share and would be a leg no mark
// could ever land in, so it is a bug in whoever cut the text and says so rather than
// quietly making the clock shorter than the conversation [LAW:no-silent-failure].
const build = (spans: ReadonlyArray<Span>): Timeline => {
  const chars = (span: Span): number => span.charEnd - span.charStart;
  const measured = spans.filter((span) => span.measuredMs !== undefined);
  const measuredMs = measured.reduce((sum, span) => sum + (span.measuredMs ?? 0), 0);
  const measuredChars = measured.reduce((sum, span) => sum + chars(span), 0);
  // A rate of zero would put the whole unheard tail at the same instant; the default
  // stands in until a measurement says something about how long text takes.
  const rate = measuredChars > 0 && measuredMs > 0 ? measuredMs / measuredChars : DEFAULT_MS_PER_CHAR;

  let startMs = 0;
  const legs = spans.map((span): Leg => {
    if (chars(span) <= 0) {
      throw new RangeError(`timeline: utterance ${span.utterance} has a span of no characters at ${span.charStart}`);
    }
    const leg: Leg = {
      utterance: span.utterance,
      charStart: span.charStart,
      charEnd: span.charEnd,
      startMs,
      ms: span.measuredMs ?? chars(span) * rate,
      kind: span.measuredMs === undefined ? "estimated" : "measured",
    };
    startMs += leg.ms;
    return leg;
  });
  return { legs, totalMs: startMs };
};

// The stand-in's timeline: one leg per passage, none of it measured, because a browser
// synthesizer reports no duration for anything it says.
export const timelineOfUtterances = (utterances: ReadonlyArray<Utterance>): Timeline =>
  build(utterances.map((utterance, index) => ({ utterance: index, charStart: 0, charEnd: utterance.text.length, measuredMs: undefined })));

// The neural voice's timeline: one leg per synthesis unit, measured wherever the worker has
// finished one. `utteranceOf` is the neural performer's own table — the page utterance each
// unit says — so the marks this timeline names are the page's, never the script's
// [LAW:one-source-of-truth].
export const timelineOfScript = (manifest: Manifest, utteranceOf: ReadonlyArray<number>): Timeline =>
  build(
    manifest.script.map((unit, index) => {
      const utterance = utteranceOf[index];
      if (utterance === undefined) throw new RangeError(`timeline: no utterance for unit ${index} of ${manifest.script.length}`);
      return { utterance, charStart: unit.start, charEnd: unit.end, measuredMs: manifest.units[index]?.durationMs };
    }),
  );

// ── reading it ──────────────────────────────────────────────────────────────────────

// The leg a mark stands in, by the same rule the neural performer seeks a unit with: among
// the legs saying that utterance, the last that begins at or before the character, else its
// first [LAW:one-source-of-truth]. An utterance with no leg at all is a timeline built for
// another page, and throws rather than answering with someone else's passage.
const legAt = (timeline: Timeline, mark: Mark): Leg => {
  const leg =
    timeline.legs.findLast((candidate) => candidate.utterance === mark.utterance && candidate.charStart <= mark.char) ??
    timeline.legs.find((candidate) => candidate.utterance === mark.utterance);
  if (leg === undefined) throw new RangeError(`timeline: nothing on this timeline says utterance ${mark.utterance}`);
  return leg;
};

const share = (leg: Leg, char: number): number => Math.min(Math.max(char - leg.charStart, 0), leg.charEnd - leg.charStart) / (leg.charEnd - leg.charStart);

// Where a mark falls on the clock: its leg's start plus its character's share of that leg.
export const timeAt = (timeline: Timeline, mark: Mark): number => {
  if (timeline.legs.length === 0) return 0;
  const leg = legAt(timeline, mark);
  return leg.startMs + leg.ms * share(leg, mark.char);
};

// The mark at a point on the clock, clamped to both ends — before the start is the start,
// past the end is the last character of the last leg. Null only for a conversation with
// nothing to say, which names no mark at all. The character is the point's share of the
// leg, so the mark it hands back is a place in the text and not a unit index: whoever
// receives it resolves it their own way — the neural voice to the word's own time, the
// browser voice to the sentence from that character.
export const markAt = (timeline: Timeline, ms: number): Mark | null => {
  const leg = timeline.legs.findLast((candidate) => candidate.startMs <= ms) ?? timeline.legs[0];
  if (leg === undefined) return null;
  const width = leg.charEnd - leg.charStart;
  const into = leg.ms <= 0 ? 0 : Math.min(Math.max(ms - leg.startMs, 0), leg.ms) / leg.ms;
  return { utterance: leg.utterance, char: leg.charStart + Math.min(Math.floor(into * width), width - 1) };
};

// Whether any of the conversation still to come at `ms` is a guess rather than a
// measurement — what puts the word "about" in front of the time remaining.
export const estimated = (timeline: Timeline, ms: number): boolean =>
  timeline.legs.some((leg) => leg.kind === "estimated" && leg.startMs + leg.ms > ms);

// The turn mark a skip lands on: the last turn to begin strictly before the mark, or the
// first to begin strictly after it. [LAW:dataflow-not-control-flow] "Strictly" is the whole
// rule — a reader halfway through a turn goes back to the start of the turn they are in,
// and one exactly at its start goes back to the previous turn, with no case for either.
// Null at the ends, where there is no such turn: the transport shows the control disabled
// rather than offering a jump that goes nowhere.
export const turnMark = (turns: ReadonlyArray<Mark>, from: Mark, by: -1 | 1): Mark | null => {
  const before = (a: Mark, b: Mark): boolean => a.utterance < b.utterance || (a.utterance === b.utterance && a.char < b.char);
  return (by < 0 ? turns.findLast((turn) => before(turn, from)) : turns.find((turn) => before(from, turn))) ?? null;
};

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
