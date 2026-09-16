// [LAW:decomposition] The conversation's timeline: the whole paste laid out end to end on
// one clock, so a place in it can be named by a time, and a time can say what is under
// it. One sentence, no "and" hiding a second job: this module builds the clock and reads
// it. It measures nothing itself (the worker reports durations, speechManifest records
// them), plays nothing, and paints nothing; every function here is pure over a Timeline
// value, so scripts/timeline-check.ts drives it with no mocks at all
// [LAW:effects-at-boundaries].
//
// VOCABULARY, AN EDITOR'S. There is a TIMELINE; on it are SEGMENTS; a segment has a
// duration and content, and content is data: spoken text or silence. A POSITION is a time
// on the timeline. A PLACE — an utterance and a character — is the durable NAME of a point
// in the text. A CURSOR is what the read-along paints: the utterance, the RANGE of its text
// the segment covers, and the word under the time. Each word means one thing here and
// downstream, so the word "segment" is never a character range and "position" is never a
// unit-and-offset [LAW:one-source-of-truth].
//
// POSITION IS A TIME. Everything that reads where the voice is reads one number, a
// millisecond on this clock, and derives what it needs from the timeline at that number:
// the scrubber shows the number; the cursor asks what text is under it and paints nothing
// when the answer is silence; the status line asks which passage it is in; the skips ask
// which landmark is before or after it. There is no second shape of position for a
// reader to handle [LAW:one-source-of-truth]. A Place is what a tap on a word and a share
// link carry, and it is resolved to a time here (`timeAt`) at the moment it is used, never
// held as the position. This deliberately inverts an earlier principle that the Place was
// the position and time derived from it; time is the authority now, and the shift of an
// estimated segment becoming a measured one is the player's own clock moving, which is
// what it really is.
//
// ONE CLASS OF SEGMENT [LAW:one-type-per-behavior]. A segment is a duration with content,
// and the content is data: spoken text — which utterance, which characters of it, and the
// word times the worker has measured of it so far — or silence. A gap between two speakers is a
// silence segment like any other segment; it is on the scrubber, the clock runs through
// it, the player sounds it and a seek can land in it. Nothing below switches on a
// segment's content except the readings whose answer differs by it: what text is under a
// time (none, in silence), what place a time names (in silence, the speech that follows)
// and whether a time is still a guess (silence never is). A third content is a new value,
// not a new rule.
//
// THE GAP IS THE TIMELINE'S OWN [LAW:single-enforcer]. `layoutOf` lays out the segments of
// a conversation from the anchors of its spans, before any duration is known: a silence
// slot of GAP_MS before every span that begins a new turn — a turn is a run of one anchor,
// so only a change of speaker gets a gap — and none before the first, because there is no
// turn before it. The timeline lays its segments on that layout, and the unit player plays
// that same layout, slot for slot, so the segment the clock is in and the segment the
// player is in are one index. The gap belongs to no unit: it is a slot of its own, between
// the speech slots, and nothing that plays or paints a unit owns it.
//
// LANDMARKS ARE SPANS OF THE CLOCK. A turn skip lands on the top of the clock or on the
// start of a gap, and the landmark is the whole gap — the top being the span of no length
// at zero. Back is the last landmark the position has left behind, which for a span means
// its end is strictly before the position; forward is the next landmark beginning strictly
// after it. That alone gives the music player's double tap — back from speech is the gap
// before this turn, back again from anywhere in that gap, its end included, is the
// landmark before it, since a gap is not behind you until you are past its end — with no
// tap window, no grace and no first-turn case [LAW:dataflow-not-control-flow].
//
// WHY THIS CLOCK RUNS PAST THE SYNTHESIZED PREFIX. A segment the worker has measured
// carries its measured milliseconds; one it has not carries its share of the
// conversation's characters at the rate the measured segments establish. So the timeline
// covers every passage from the first listen — a scrubber whose length was the measured
// prefix could never be dragged into text the model has not reached — and `estimated`
// says whether the time still to come is measured or guessed, so the panel prints "about"
// over exactly the guesses [LAW:no-silent-failure]. Before any unit is measured every
// speech segment is estimated at DEFAULT_MS_PER_CHAR, which is the honest shape of "we
// have not heard any of this yet".
//
// ONE BUILD, TWO SOURCES. Once the neural voice is on stage its timeline is built over the
// speech script — one speech segment per synthesis unit, in unit order, measured where
// the manifest has a record; before that, while the reader has a place but no performer
// yet, it is built over the page's own utterances, one segment each, all of it a guess.
// Everything downstream reads segments and cannot tell which built them.

import type { Place } from "./performer";
import type { Utterance } from "./speech";
import { measuredWords, offsetAt, wordUnder, type Alignment, type Manifest, type WordSpan, type WordStart } from "./speechManifest";

// ── the layout ──────────────────────────────────────────────────────────────────────

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
// every other segment.
export const GAP_MS = 500;

// [LAW:types-are-the-program] One slot of the layout: a span of the conversation — the
// unit, for a script — whose duration the clock learns from the worker, or a silence whose
// duration is its own. A silence slot is always followed by a speech slot and never by
// another silence, by `layoutOf`'s construction: it is laid before a span, and only there.
export type Slot = { readonly kind: "speech"; readonly span: number } | { readonly kind: "silence"; readonly ms: number };

// [LAW:single-enforcer] The order of a conversation's segments, from the anchors of its
// spans in order: a silence slot before every span whose anchor differs from the one
// before it, none before the first span and none within a turn, then the span's own slot.
export const layoutOf = (anchors: ReadonlyArray<string>): ReadonlyArray<Slot> =>
  anchors.flatMap((anchor, span): Slot[] => [
    ...(span > 0 && anchor !== anchors[span - 1] ? [{ kind: "silence" as const, ms: GAP_MS }] : []),
    { kind: "speech", span },
  ]);

// The layout of a script: the turn each unit belongs to decides where the gaps fall. The one
// layout the player plays and a rendition file is laid along [LAW:single-enforcer].
export const scriptLayout = (script: ReadonlyArray<{ readonly utterance: { readonly anchor: string } }>): ReadonlyArray<Slot> =>
  layoutOf(script.map((unit) => unit.utterance.anchor));

// ── the timeline ────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] What is known of when a segment's speech is said: a guess —
// its length is a share of the characters, and of its words only those the model has begun
// while its unit is still being made, none before — or the worker's measurement of the
// whole unit. A guess's begun words are measurements too, so the cursor stands on them as on
// a measured word; its length stays a guess until the unit is done, though never shorter
// than its last begun word.
export type Timing =
  | { readonly kind: "guess"; readonly begun: ReadonlyArray<WordStart> }
  | { readonly kind: "measured"; readonly alignment: Alignment };

// The timing of a segment nobody has begun to say.
export const UNHEARD: Timing = { kind: "guess", begun: [] };

// The words a segment's timing has measured starts for, in order: the cursor's words.
const wordsOfTiming = (timing: Timing): ReadonlyArray<WordStart> => (timing.kind === "guess" ? timing.begun : measuredWords(timing.alignment));

// What a segment holds. Spoken text names its utterance, the characters of that utterance's
// text it covers, and its timing, which is the whole of what the cursor and a tap resolve
// through. Silence holds nothing.
export type Content =
  | {
      readonly kind: "speech";
      readonly utterance: number;
      readonly charStart: number;
      readonly charEnd: number;
      readonly timing: Timing;
    }
  | { readonly kind: "silence" };

// One stretch of the conversation on the clock: when it begins, how long it runs, and what
// is in it.
export interface Segment {
  readonly startMs: number;
  readonly ms: number;
  readonly content: Content;
}

// The conversation end to end: its segments in order — one per slot of its layout, index
// for index — and how long it runs. A conversation with nothing to say has no clock: every
// reading below of a timeline with no segments is zero or nothing, stated once here so no
// caller carries an emptiness check [LAW:dataflow-not-control-flow].
export interface Timeline {
  readonly segments: ReadonlyArray<Segment>;
  readonly totalMs: number;
}

// What a speech segment is built from, before its place on the clock is known: the two
// constructors below differ only in what they put in this list. `anchor` is the turn the
// span belongs to, read for the layout and kept nowhere. A measured span carries its length.
interface Span {
  readonly utterance: number;
  readonly anchor: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly heard: Extract<Timing, { kind: "guess" }> | (Extract<Timing, { kind: "measured" }> & { readonly ms: number });
}

type Speech = Extract<Content, { kind: "speech" }>;
const SILENCE: Content = { kind: "silence" };

// Whether a segment's duration is a guess: only unmeasured speech is; silence is by rule.
const guessed = (segment: Segment): boolean => segment.content.kind === "speech" && segment.content.timing.kind === "guess";

// [LAW:parse-dont-validate] The one place spans become a timeline: the measured segments
// set the rate, the rest take their character share of it, the layout says where the
// silence goes, and every segment is stamped with when it begins. A span covering no
// character could take no share and would be a segment no place could ever land in, so it
// is a bug in whoever cut the text and says so rather than quietly making the clock
// shorter than the conversation [LAW:no-silent-failure].
const build = (spans: ReadonlyArray<Span>): Timeline => {
  const chars = (span: Span): number => span.charEnd - span.charStart;
  const measured = spans.flatMap((span) => (span.heard.kind === "measured" ? [{ ms: span.heard.ms, chars: chars(span) }] : []));
  const measuredMs = measured.reduce((sum, span) => sum + span.ms, 0);
  const measuredChars = measured.reduce((sum, span) => sum + span.chars, 0);
  // A rate of zero would put the whole unheard tail at the same instant; the default
  // stands in until a measurement says something about how long text takes.
  const rate = measuredChars > 0 && measuredMs > 0 ? measuredMs / measuredChars : DEFAULT_MS_PER_CHAR;

  let startMs = 0;
  const segments = layoutOf(spans.map((span) => span.anchor)).map((slot): Segment => {
    const lay = (ms: number, content: Content): Segment => {
      const segment: Segment = { startMs, ms, content };
      startMs += segment.ms;
      return segment;
    };
    if (slot.kind === "silence") return lay(slot.ms, SILENCE);
    const span = spans[slot.span];
    if (span === undefined) throw new RangeError(`timeline: the layout names span ${slot.span} of ${spans.length}`);
    if (chars(span) <= 0) {
      throw new RangeError(`timeline: utterance ${span.utterance} has a span of no characters at ${span.charStart}`);
    }
    const { heard } = span;
    const timing: Timing = heard.kind === "measured" ? { kind: "measured", alignment: heard.alignment } : heard;
    const speech: Speech = { kind: "speech", utterance: span.utterance, charStart: span.charStart, charEnd: span.charEnd, timing };
    // A begun word has been heard, so a guess is never shorter than the last of them: a unit
    // streaming past its share of the characters lengthens as its words begin, and the voice's
    // clock, held at the segment's end, stands on the word being said.
    return lay(heard.kind === "measured" ? heard.ms : Math.max(chars(span) * rate, ...heard.begun.map((word) => word.startMs)), speech);
  });
  return { segments, totalMs: startMs };
};

// The timeline before any performer exists: one segment per passage, none of it measured,
// since nothing has spoken a word of it yet.
export const timelineOfUtterances = (utterances: ReadonlyArray<Utterance>): Timeline =>
  build(
    utterances.map((utterance, index) => ({
      utterance: index,
      anchor: utterance.anchor,
      charStart: 0,
      charEnd: utterance.text.length,
      heard: UNHEARD,
    })),
  );

// The neural voice's timeline: one speech segment per synthesis unit, in unit order,
// measured wherever the worker has finished one, and elsewhere a guess holding the words
// `begun` says the model has begun of that unit so far. `utteranceOf` is the neural
// performer's own table — the page utterance each unit says — so the places this timeline
// names are the page's, never the script's [LAW:one-source-of-truth]; the turn each unit
// belongs to is the script's own word, since a unit holds its utterance.
export const timelineOfScript = (
  manifest: Manifest,
  utteranceOf: ReadonlyArray<number>,
  begun: (unit: number) => ReadonlyArray<WordStart>,
): Timeline =>
  build(
    manifest.script.map((unit, index): Span => {
      const utterance = utteranceOf[index];
      if (utterance === undefined) throw new RangeError(`timeline: no utterance for unit ${index} of ${manifest.script.length}`);
      const record = manifest.units[index];
      return {
        utterance,
        anchor: unit.utterance.anchor,
        charStart: unit.start,
        charEnd: unit.end,
        heard: record === undefined ? { kind: "guess", begun: begun(index) } : { kind: "measured", ms: record.durationMs, alignment: record.alignment },
      };
    }),
  );

// ── reading it ──────────────────────────────────────────────────────────────────────

// The speech segments in order. For a script timeline this is indexed by unit, which is
// how a unit's holding is named by its passage.
export type SpeechSegment = Segment & { readonly content: Speech };
const isSpeech = (segment: Segment): segment is SpeechSegment => segment.content.kind === "speech";
export const speechSegments = (timeline: Timeline): ReadonlyArray<SpeechSegment> => timeline.segments.filter(isSpeech);

// [LAW:parse-dont-validate] Where a place falls on the clock — the one door a Place comes
// through. Among the segments saying that utterance, the last that begins at or before the
// character, else its first, by the same rule the neural performer chooses a unit with;
// within it, the time the word holding the character begins when the segment has word
// times, and the segment's start when it has none — a guess is not a place in audio nobody
// has heard. An utterance no segment says is a timeline built for another page, and a
// character outside the utterance's text is a caller's bug: both throw rather than answer
// with someone else's passage [LAW:no-silent-failure]. Zero on a conversation with nothing
// to say.
export const timeAt = (timeline: Timeline, place: Place): number => {
  if (timeline.segments.length === 0) return 0;
  const { startMs, content } = speechOf(timeline, place);
  return startMs + (content.timing.kind === "guess" ? 0 : offsetAt(content.timing.alignment, place.char));
};

// The speech segment a place is in, by timeAt's rule; its throws are timeAt's.
const speechOf = (timeline: Timeline, place: Place): SpeechSegment => {
  const saying = speechSegments(timeline).filter((segment) => segment.content.utterance === place.utterance);
  const first = saying[0];
  const last = saying.at(-1);
  if (first === undefined || last === undefined) throw new RangeError(`timeline: nothing on this timeline says utterance ${place.utterance}`);
  if (!Number.isInteger(place.char) || place.char < 0 || place.char >= last.content.charEnd) {
    throw new RangeError(`timeline: no character ${place.char} of ${last.content.charEnd} in utterance ${place.utterance}`);
  }
  return saying.findLast((candidate) => candidate.content.charStart <= place.char) ?? first;
};

// The segment under a point on the clock, clamped to both ends: before the start is the
// first segment, past the end is the last; at a boundary, the segment that begins there.
// Undefined only for a conversation with nothing to say.
const segmentAt = (timeline: Timeline, ms: number): Segment | undefined =>
  timeline.segments.findLast((segment) => segment.startMs <= ms) ?? timeline.segments[0];

// The first speech segment that has not ended by a point on the clock, else the last:
// inside speech, that speech; inside silence, the speech that follows.
const speechFrom = (timeline: Timeline, ms: number): SpeechSegment | undefined => {
  const speech = speechSegments(timeline);
  return speech.find((candidate) => candidate.startMs + candidate.ms > ms) ?? speech.at(-1);
};

// The name of a point on the clock within a speech segment's span. Where the segment has
// measured words, the first character of the word under the point — the word the cursor
// paints there — so the name resolves back through `timeAt` to that word's own start once
// the unit is measured, and a place kept at a moment resumes on the word the reader saw
// [LAW:one-source-of-truth]. Where it has none, the character the point's share of the
// segment reaches: the first before the segment begins, the last past its end.
const placeInSpeech = (segment: SpeechSegment, ms: number): Place => {
  const { utterance, charStart, charEnd, timing } = segment.content;
  const word = wordUnder(wordsOfTiming(timing), ms - segment.startMs);
  if (word !== null) return { utterance, char: word.charStart };
  const width = charEnd - charStart;
  const into = segment.ms <= 0 ? 0 : Math.min(Math.max(ms - segment.startMs, 0), segment.ms) / segment.ms;
  return { utterance, char: charStart + Math.min(Math.floor(into * width), width - 1) };
};

// The name of the place at a point on the clock: the first spoken character at or after
// it — inside speech, the character under the point; inside silence, the first character
// of the speech that follows, which is what a link to a gap should open on and what a
// retry from a gap should start at. Past the last word it is the last character. Null
// only for a conversation with nothing to say.
export const placeAt = (timeline: Timeline, ms: number): Place | null => {
  const segment = speechFrom(timeline, ms);
  return segment === undefined ? null : placeInSpeech(segment, ms);
};

// The name of a point on the clock within a given segment. The segment is the caller's
// fact — the neural voice knows the segment its player is in outright, and a time put to
// the whole timeline would name a neighbour while a unit still streams past its guessed
// length. In speech, the character the point's share of the segment reaches; in silence,
// the first character of the speech that follows it, the same answer `placeAt` gives, since
// silence is never a guess and its end is exact. A silence with no speech after it is a
// layout `layoutOf` cannot produce and throws [LAW:no-silent-failure].
export const placeIn = (timeline: Timeline, segment: Segment, ms: number): Place => {
  if (isSpeech(segment)) return placeInSpeech(segment, ms);
  const next = speechFrom(timeline, segment.startMs + segment.ms);
  if (next === undefined) throw new RangeError("timeline: a silence segment with no speech after it");
  return placeInSpeech(next, next.startMs);
};

// [LAW:types-are-the-program] Where a voice starts, named so the name survives a change of
// timeline: the page's clock before the voice arrives and the voice's own after it disagree
// on every length, so a time names nothing across them. In speech, a place; in silence, the
// gap before a turn, named by the place it leads into — silence has no text of its own —
// and how far into the gap, which is GAP_MS on every timeline. A Place alone cannot name a
// gap: a start kept as one moves every gap to the speech after it.
export type Start =
  | { readonly kind: "speech"; readonly place: Place }
  | { readonly kind: "silence"; readonly before: Place; readonly offsetMs: number };

// The start at a point in a segment.
export const startIn = (timeline: Timeline, segment: Segment, ms: number): Start =>
  isSpeech(segment)
    ? { kind: "speech", place: placeInSpeech(segment, ms) }
    : { kind: "silence", before: placeIn(timeline, segment, ms), offsetMs: Math.min(Math.max(ms - segment.startMs, 0), segment.ms) };

// The start a time names on this timeline. Null only for a conversation with nothing to say.
export const startAt = (timeline: Timeline, ms: number): Start | null => {
  const segment = segmentAt(timeline, ms);
  return segment === undefined ? null : startIn(timeline, segment, ms);
};

// Where a start falls on this timeline's clock: a place's time; for a gap, the silence
// segment laid just before the speech its place is in, and the offset into it. A place
// whose speech has no silence before it is a start named on another page, and throws
// [LAW:no-silent-failure].
export const timeOfStart = (timeline: Timeline, start: Start): number => {
  if (start.kind === "speech") return timeAt(timeline, start.place);
  const index = timeline.segments.indexOf(speechOf(timeline, start.before));
  const gap = timeline.segments[index - 1];
  if (gap === undefined || gap.content.kind !== "silence") {
    throw new RangeError(`timeline: no gap before utterance ${start.before.utterance} at character ${start.before.char}`);
  }
  return gap.startMs + Math.min(start.offsetMs, gap.ms);
};

// What the read-along paints at a point on the clock: the utterance, the range of its text
// the segment covers, and the word under the point when a measured word is. Null in silence and on a conversation with nothing to say: nothing is
// being said, so nothing is painted.
export interface Cursor {
  readonly utterance: number;
  readonly range: WordSpan;
  readonly word: WordSpan | null;
}

export const cursorAt = (timeline: Timeline, ms: number): Cursor | null => {
  const segment = segmentAt(timeline, ms);
  return segment === undefined ? null : cursorIn(segment, ms);
};

// What the read-along paints at a point on the clock within a given segment: the
// segment's range, with the word under the point among the segment's measured words — all
// of a measured unit's, the begun ones of a unit still being made; nothing in silence.
export const cursorIn = (segment: Segment, ms: number): Cursor | null => {
  if (!isSpeech(segment)) return null;
  const { utterance, charStart, charEnd, timing } = segment.content;
  return { utterance, range: { charStart, charEnd }, word: wordUnder(wordsOfTiming(timing), ms - segment.startMs) };
};

// Whether any of the conversation still to come at `ms` is a guess rather than a
// measurement — what puts the word "about" in front of the time remaining.
export const estimated = (timeline: Timeline, ms: number): boolean =>
  timeline.segments.some((segment) => guessed(segment) && segment.startMs + segment.ms > ms);

// ── the landmarks ───────────────────────────────────────────────────────────────────

// A span of the clock a turn skip lands at the start of.
export interface Landmark {
  readonly startMs: number;
  readonly endMs: number;
}

// Where a turn skip can land: the top of the clock, a span of no length, and every gap. A
// conversation with nothing to say has no top.
export const landmarks = (timeline: Timeline): ReadonlyArray<Landmark> =>
  timeline.segments.flatMap((segment, index) => [
    ...(index === 0 ? [{ startMs: 0, endMs: 0 }] : []),
    ...(segment.content.kind === "silence" ? [{ startMs: segment.startMs, endMs: segment.startMs + segment.ms }] : []),
  ]);

// [LAW:types-are-the-program] A point on the clock with the segment it is in. The time
// alone does not name the segment at a boundary: a unit streaming past its guessed length
// holds the clock at its segment's end, which is the very time the segment after it
// begins. The voice knows which segment it is in; a time with no voice behind it is in the
// segment that begins there.
export interface Point {
  readonly atMs: number;
  readonly segment: Segment;
}

// The point a bare time names. Undefined only for a conversation with nothing to say.
export const pointAt = (timeline: Timeline, ms: number): Point | undefined => {
  const segment = segmentAt(timeline, ms);
  return segment === undefined ? undefined : { atMs: ms, segment };
};

// The landmark a skip lands on: back, the start of the last one beginning strictly before
// the point's segment or ending strictly before the point's time; forward, the first one
// beginning strictly after the point's segment begins. [LAW:dataflow-not-control-flow]
// "Strictly" is the whole rule, with no case for any of these: a reader anywhere in a turn,
// its first sample included, goes back to the gap before it; one anywhere in that gap goes
// back to the landmark before; one past the top of the first passage goes back to the top;
// and forward from anywhere in a segment passes over no landmark that segment's end
// touches. A place on a guessed segment is at the segment's start, where the voice will
// begin it, so it reads the same before the voice as the voice's own point does after.
// Null at the ends, where there is no such landmark: the transport shows the control
// disabled rather than offering a jump that goes nowhere.
export const landmark = (marks: ReadonlyArray<Landmark>, at: Point, by: -1 | 1): number | null =>
  (by < 0
    ? marks.findLast((mark) => mark.startMs < at.segment.startMs || mark.endMs < at.atMs)
    : marks.find((mark) => mark.startMs > at.segment.startMs)
  )?.startMs ?? null;

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
