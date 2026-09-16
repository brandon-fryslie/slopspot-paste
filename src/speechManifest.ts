// [LAW:decomposition] The speech manifest: the record, filled in one unit at a time as the
// synthesis worker finishes them, of how long each unit's audio is and where its words
// fall in it — and the word arithmetic the cursor reads off that record. One sentence, no
// "and" hiding a second job: it does not cut text (speechScript),
// it does not run the model (the worker), it does not play audio (the unit player) and it
// paints nothing. Every function here is pure over a manifest value, so the check drives
// it with no mocks at all [LAW:effects-at-boundaries].
//
// WHY THE SCRIPT IS THE SPINE. A manifest is built over the speech script it renders: the
// units, their order, their char ranges and their words are the script's facts, read from
// it and never copied where they could disagree [LAW:one-source-of-truth]. What the worker
// adds per unit is exactly what only the model knows — the audio's length and, when the
// attention read-out ran, when each word was said. So the worker reports word TIMES in
// word order and never word char ranges: the words themselves are `wordsOf(unit)`, defined
// once here over the utterance text, and a time is stamped onto the word it belongs to at
// admission. A report cannot name a word the script does not have, and a stamped word
// cannot point outside its unit, by construction [LAW:types-are-the-program].
//
// WHY PRECISION IS A KIND. Only `words` is a measurement. `unit` says the model gave no
// per-word signal; `estimated` carries times interpolated by character length, a guess
// typed as one. `wordUnder` hands out a word for `words` alone and no word otherwise, so a
// guess can never be painted as a measurement [LAW:no-silent-failure]. The other
// direction, `offsetAt` — where in the audio a character of the text falls, for a reader
// who taps a word — reads the estimate too: a seek that lands a word early is a better
// answer to the tap than the start of the sentence group, and the cursor painted after it
// still claims no word. Cost, stated once: on an estimated unit a tapped word may start
// a word or so off.
//
// WHERE GLOBAL TIME LIVES, AND WHY NOT HERE. This module measures ONE unit's audio: its
// duration and where its words fall in it. Laying those measurements end to end into a clock
// for the whole conversation is timeline.ts's job, because a transport's clock must also
// cover the passages nobody has measured yet — and a length this module could honestly
// report would stop at the synthesized prefix, which is a scrubber the reader cannot drag
// forward [LAW:one-source-of-truth]. So a record here, a clock there, and no second answer
// to "how long is this paste" in between.
//
// Nothing here is persisted: the manifest is a client-side, disposable projection of the
// stored original's rendition [LAW:one-way-deps]. The reports the device keeps beside a unit's
// audio (keptAudio.ts) come back through `recordUnit`, the one door a report enters by.

import { SAMPLE_RATE } from "./modelAssets";
import { RENDITION_VERSIONS, unitText, type RenditionVersions, type SynthesisUnit } from "./speechScript";
import { voicedNotation, type Voiced } from "./spokenNotation";

// ── words ───────────────────────────────────────────────────────────────────────────

// A char range into the UTTERANCE text (the unit's offset already applied), the same
// coordinates every cursor is painted in.
export interface WordSpan {
  readonly charStart: number;
  readonly charEnd: number;
}

// [LAW:one-source-of-truth] THE word segmentation of a unit, shared by the attention
// read-out's token-to-word map, the estimator and the cursor: a maximal run of non-
// whitespace in the unit's source text that carries at least one letter or digit, or
// notation the voice says as words ("=" in "9 x 10 = 90", spokenNotation.ts). A run of
// bare punctuation (an em dash, an ellipsis) is not a word: it gets no time and no cursor.
// Punctuation attached to a word travels with it ("world.", "(ok)"). Whether a symbol is
// notation depends on its neighbours, so where notation is said is found in the widest text
// the caller has and handed in, in `text`'s coordinates.
const RUN = /\S+/gu;
const LEXICAL = /[\p{L}\p{N}]/u;

// The rule over any text, with `offset` placing the spans in a larger string's
// coordinates. The read-along painter (readAlong.ts) segments the page's own text nodes
// with THIS function, so what it paints as a word is what the manifest times as one.
export const wordSpans = (text: string, offset: number, voiced: ReadonlyArray<Voiced> = voicedNotation(text)): ReadonlyArray<WordSpan> =>
  Array.from(text.matchAll(RUN))
    .filter((run) => LEXICAL.test(run[0]) || voiced.some((said) => run.index <= said.begin && said.end <= run.index + run[0].length))
    .map((run) => ({ charStart: offset + run.index, charEnd: offset + run.index + run[0].length }));

export const wordsOf = (unit: SynthesisUnit): ReadonlyArray<WordSpan> => wordSpans(unitText(unit).source, unit.start);

export interface WordTiming {
  readonly startMs: number;
  readonly endMs: number;
}

export type WordTime = WordSpan & WordTiming;

// A word whose start is known and whose end is not yet: what the worker says of a word the
// moment the model begins it, while the rest of its unit is still being made.
export type WordStart = WordSpan & Pick<WordTiming, "startMs">;

// What the worker reports for one finished unit: times in word order, one per
// `wordsOf(unit)`, or the honest admission that it has none.
export type ReportedAlignment =
  | { readonly kind: "words"; readonly times: ReadonlyArray<WordTiming> }
  | { readonly kind: "unit" }
  | { readonly kind: "estimated"; readonly times: ReadonlyArray<WordTiming> };

export interface UnitReport {
  readonly durationMs: number;
  readonly alignment: ReportedAlignment;
}

// The estimator, exported so a worker without a read-out reports `estimated` times from
// the one rule rather than its own: each word's share of the unit's audio is its share of
// the unit's characters. Ascending and non-overlapping by construction.
export const estimateTimes = (unit: SynthesisUnit, durationMs: number): ReadonlyArray<WordTiming> => {
  const length = unit.end - unit.start;
  return wordsOf(unit).map((word) => ({
    startMs: (durationMs * (word.charStart - unit.start)) / length,
    endMs: (durationMs * (word.charEnd - unit.start)) / length,
  }));
};

// ── the manifest ────────────────────────────────────────────────────────────────────

// Stamped: every time is on its word. This is the type the report becomes on admission
// and the only one the player and cursor ever read [LAW:parse-dont-validate].
export type Alignment =
  | { readonly kind: "words"; readonly words: ReadonlyArray<WordTime> }
  | { readonly kind: "unit" }
  | { readonly kind: "estimated"; readonly words: ReadonlyArray<WordTime> };

export interface ManifestUnit {
  readonly unit: SynthesisUnit;
  readonly durationMs: number;
  readonly alignment: Alignment;
}

// `units[i]` is the synthesized record of `script[i]`, or `undefined` while the worker has
// not finished it; the two arrays are always the same length.
export interface Manifest {
  readonly versions: RenditionVersions;
  readonly sampleRate: number;
  readonly script: ReadonlyArray<SynthesisUnit>;
  readonly units: ReadonlyArray<ManifestUnit | undefined>;
}

export const emptyManifest = (
  script: ReadonlyArray<SynthesisUnit>,
  versions: RenditionVersions = RENDITION_VERSIONS,
  sampleRate: number = SAMPLE_RATE,
): Manifest => ({ versions, sampleRate, script, units: script.map(() => undefined) });

// [LAW:no-silent-failure] Every way a report can fail to be a record, named. A rejection
// leaves the manifest untouched; the caller decides whether to resynthesize or surface.
export type Rejection =
  | { readonly kind: "unknown-unit"; readonly index: number }
  | { readonly kind: "duplicate"; readonly index: number }
  | { readonly kind: "bad-duration"; readonly index: number; readonly durationMs: number }
  | { readonly kind: "word-count"; readonly index: number; readonly expected: number; readonly got: number }
  | { readonly kind: "times-out-of-order"; readonly index: number; readonly word: number };

export type Admission = { readonly kind: "added"; readonly manifest: Manifest } | Rejection;

type Stamped = { readonly kind: "stamped"; readonly alignment: Alignment };

// One time per word, each within the unit's audio, ascending and non-overlapping: the
// theorem the stamped `words` array states, proven here once.
const stampTimes = (
  index: number,
  unit: SynthesisUnit,
  durationMs: number,
  kind: "words" | "estimated",
  times: ReadonlyArray<WordTiming>,
): Stamped | RecordRejection => {
  const spans = wordsOf(unit);
  const wordCount: RecordRejection = { kind: "word-count", index, expected: spans.length, got: times.length };
  const words: WordTime[] = [];
  let floor = 0;
  for (const [i, span] of spans.entries()) {
    const timing = times[i];
    if (timing === undefined) return wordCount;
    if (!(floor <= timing.startMs && timing.startMs <= timing.endMs && timing.endMs <= durationMs)) {
      return { kind: "times-out-of-order", index, word: i };
    }
    floor = timing.endMs;
    words.push({ ...span, ...timing });
  }
  return times.length > spans.length ? wordCount : { kind: "stamped", alignment: { kind, words } };
};

const stamp = (index: number, unit: SynthesisUnit, durationMs: number, reported: ReportedAlignment): Stamped | RecordRejection =>
  reported.kind === "unit"
    ? { kind: "stamped", alignment: reported }
    : stampTimes(index, unit, durationMs, reported.kind, reported.times);

// [LAW:parse-dont-validate] The one checkpoint between the worker and a record: a report
// becomes a ManifestUnit here or is rejected with the reason. Whether a unit may be
// recorded twice is not this function's rule — the scheduler replaces a record when it
// re-synthesizes a unit whose audio it had dropped, `addUnit` refuses — so the duplicate
// arm lives with the manifest, below, and this stays the one stamping.
export type RecordRejection = Exclude<Rejection, { kind: "duplicate" }>;
export type Recording = { readonly kind: "record"; readonly record: ManifestUnit } | RecordRejection;

export const recordUnit = (script: ReadonlyArray<SynthesisUnit>, index: number, report: UnitReport): Recording => {
  const unit = script[index];
  if (unit === undefined) return { kind: "unknown-unit", index };
  if (!(Number.isFinite(report.durationMs) && report.durationMs >= 0)) {
    return { kind: "bad-duration", index, durationMs: report.durationMs };
  }
  const stamped = stamp(index, unit, report.durationMs, report.alignment);
  if (stamped.kind !== "stamped") return stamped;
  return { kind: "record", record: { unit, durationMs: report.durationMs, alignment: stamped.alignment } };
};

// [LAW:parse-dont-validate] The one checkpoint between the worker's word start and a word the
// cursor may stand on while its unit streams: the word is the unit's own, begun after every
// word already begun (words begin in order, by the aligner's construction) and no earlier
// than the last one, at a time in the unit's audio. A start that is none of these is a worker
// that broke the protocol, and says so rather than painting a word out of order
// [LAW:no-silent-failure]. `begun` is the unit's starts so far, as this function returned them.
export const beginWord = (
  script: ReadonlyArray<SynthesisUnit>,
  index: number,
  begun: ReadonlyArray<WordStart>,
  word: number,
  startMs: number,
): ReadonlyArray<WordStart> => {
  const unit = script[index];
  if (unit === undefined) throw new RangeError(`speech manifest: a word start for unit ${index} of ${script.length}`);
  const spans = wordsOf(unit);
  const span = spans[word];
  const last = begun.at(-1);
  const after = last === undefined ? -1 : spans.findIndex((s) => s.charStart === last.charStart);
  if (span === undefined || word <= after || !(Number.isFinite(startMs) && startMs >= (last?.startMs ?? 0))) {
    throw new RangeError(`speech manifest: unit ${index} word ${word} of ${spans.length} begun at ${startMs} ms after word ${after}`);
  }
  return [...begun, { ...span, startMs }];
};

// Out of order is legal — the scheduler finishes ahead of the cursor — so admission is by
// index, not by sequence; a second report for a recorded unit is refused.
export const addUnit = (manifest: Manifest, index: number, report: UnitReport): Admission => {
  if (manifest.units[index] !== undefined) return { kind: "duplicate", index };
  const recorded = recordUnit(manifest.script, index, report);
  if (recorded.kind !== "record") return recorded;
  return { kind: "added", manifest: { ...manifest, units: manifest.units.with(index, recorded.record) } };
};

// ── the cursor ──────────────────────────────────────────────────────────────────────

// The word a read-along cursor stands on at `offsetMs`: the last word that has started,
// so it stays on the word just said through the silence before the next and after the
// last; and through the unit's leading silence, the word about to be said. Every offset of
// a unit with words is on one of them, so a measured unit never falls back to painting its
// whole sentence group between frames; only a unit with no words at all has none. `endMs`
// is data for whoever wants the gap itself. A scan, not a search: a unit holds at most
// MAX_UNIT_TOKENS tokens, so this is a few dozen comparisons per animation frame at the
// very most.
export const wordAt = <W extends WordStart>(words: ReadonlyArray<W>, offsetMs: number): W | undefined =>
  words.findLast((word) => word.startMs <= offsetMs) ?? words[0];

// The measured words of an alignment: every word of a `words` alignment, none of an estimate
// or of a unit with no word times, so a guess is never painted as a measurement
// [LAW:types-are-the-program].
export const measuredWords = (alignment: Alignment): ReadonlyArray<WordTime> => (alignment.kind === "words" ? alignment.words : []);

// The word under a point in a unit's audio, in utterance-text coordinates, among words whose
// starts are measurements; null when there are none. The timeline builds the cursor the page
// paints from it: the segment's range and this word are its two tiers.
export const wordUnder = (words: ReadonlyArray<WordStart>, offsetMs: number): WordSpan | null => {
  const word = wordAt(words, offsetMs);
  return word === undefined ? null : { charStart: word.charStart, charEnd: word.charEnd };
};

// The reverse: how far into the unit's audio the word holding `char` (or the last word
// begun before it) starts — the offset a tap on that character seeks to. Zero before the
// first word, and zero for a `unit` alignment, which has no word times at all.
export const offsetAt = (alignment: Alignment, char: number): number =>
  alignment.kind === "unit" ? 0 : (alignment.words.findLast((word) => word.charStart <= char)?.startMs ?? 0);
