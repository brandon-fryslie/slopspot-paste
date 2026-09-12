// [LAW:decomposition] The speech manifest: the record, filled in one unit at a time as the
// synthesis worker finishes them, of how long each unit's audio is and where its words
// fall in it — and the position arithmetic the player and the cursor read off that
// record. One sentence, no "and" hiding a second job: it does not cut text (speechScript),
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
// typed as one. `cursorAt` hands out a word for `words` alone and no word otherwise, so a
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
// Nothing here is persisted and no audio is ever stored: the manifest is a client-side,
// disposable projection of the stored original's rendition [LAW:one-way-deps].

import { SAMPLE_RATE } from "./modelAssets";
import { RENDITION_VERSIONS, unitText, type RenditionVersions, type SynthesisUnit } from "./speechScript";

// ── words ───────────────────────────────────────────────────────────────────────────

// A char range into the UTTERANCE text (the unit's offset already applied), the same
// coordinates every cursor is painted in.
export interface WordSpan {
  readonly charStart: number;
  readonly charEnd: number;
}

// [LAW:one-source-of-truth] THE word segmentation of a unit, shared by the attention
// read-out's token-to-word map, the estimator and the cursor: a maximal run of non-
// whitespace in the unit's source text that carries at least one letter or digit. A run
// of bare punctuation (an em dash, an ellipsis) is not a word: it gets no time and no
// cursor. Punctuation attached to a word travels with it ("world.", "(ok)").
const RUN = /\S+/gu;
const LEXICAL = /[\p{L}\p{N}]/u;

// The rule over any text, with `offset` placing the spans in a larger string's
// coordinates. The read-along painter (readAlong.ts) segments the page's own text nodes
// with THIS function, so what it paints as a word is what the manifest times as one.
export const wordSpans = (text: string, offset: number): ReadonlyArray<WordSpan> =>
  Array.from(text.matchAll(RUN))
    .filter((run) => LEXICAL.test(run[0]))
    .map((run) => ({ charStart: offset + run.index, charEnd: offset + run.index + run[0].length }));

export const wordsOf = (unit: SynthesisUnit): ReadonlyArray<WordSpan> => wordSpans(unitText(unit).source, unit.start);

export interface WordTiming {
  readonly startMs: number;
  readonly endMs: number;
}

export type WordTime = WordSpan & WordTiming;

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

// Out of order is legal — the scheduler finishes ahead of the cursor — so admission is by
// index, not by sequence; a second report for a recorded unit is refused.
export const addUnit = (manifest: Manifest, index: number, report: UnitReport): Admission => {
  if (manifest.units[index] !== undefined) return { kind: "duplicate", index };
  const recorded = recordUnit(manifest.script, index, report);
  if (recorded.kind !== "record") return recorded;
  return { kind: "added", manifest: { ...manifest, units: manifest.units.with(index, recorded.record) } };
};

// ── position math ───────────────────────────────────────────────────────────────────

// Where playback is: a unit and how far into its audio. The player derives it from the
// audio clock; everything else reads it.
export interface Position {
  readonly unitIndex: number;
  readonly offsetMs: number;
}

// ── the cursor ──────────────────────────────────────────────────────────────────────

// The last word that has started by `offsetMs`: a read-along cursor stays on the word
// just said through the silence before the next, and there is none before the first word
// has begun. `endMs` is data for whoever wants the gap itself. A scan, not a search: a
// unit holds at most MAX_UNIT_TOKENS tokens, so this is a few dozen comparisons per
// animation frame at the very most.
export const wordAt = (words: ReadonlyArray<WordTime>, offsetMs: number): WordTime | undefined =>
  words.findLast((word) => word.startMs <= offsetMs);

// What to highlight at a position, in utterance-text coordinates: the segment the voice
// is inside — the unit's own span — and the word it is on, or null when no word may be
// claimed: an alignment that is not a measurement, or a position before the first word
// has begun [LAW:types-are-the-program]. The two are the two tiers the page paints.
export interface Cursor {
  readonly segment: WordSpan;
  readonly word: WordSpan | null;
}

export const unitSpan = (unit: SynthesisUnit): WordSpan => ({ charStart: unit.start, charEnd: unit.end });

export const cursorAt = (record: ManifestUnit, offsetMs: number): Cursor => {
  const segment = unitSpan(record.unit);
  if (record.alignment.kind !== "words") return { segment, word: null };
  const word = wordAt(record.alignment.words, offsetMs);
  return { segment, word: word === undefined ? null : { charStart: word.charStart, charEnd: word.charEnd } };
};

// The reverse: how far into the unit's audio the word holding `char` (or the last word
// begun before it) starts — the offset a tap on that character seeks to. Zero before the
// first word, and zero for a `unit` alignment, which has no word times at all.
export const offsetAt = (record: ManifestUnit, char: number): number =>
  record.alignment.kind === "unit" ? 0 : (record.alignment.words.findLast((word) => word.charStart <= char)?.startMs ?? 0);
