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
// typed as one. `cursorAt` hands out a word cursor for `words` alone and the unit's own
// span otherwise, so a guess can never be painted as a measurement
// [LAW:no-silent-failure].
//
// WHY GLOBAL TIME RUNS OVER THE KNOWN PREFIX. Units finish out of order — the scheduler
// synthesizes ahead of the cursor and a seek starts it mid-paste — so a global timeline is
// only defined as far as every unit before a point is known. `totalDurationMs` sums the
// longest synthesized prefix, and the global<->position conversions return a typed absence
// beyond it, rather than summing whatever happens to exist and calling that a position
// [LAW:no-silent-failure].
//
// Nothing here is persisted and no audio is ever stored: the manifest is a client-side,
// disposable projection of the stored original's rendition [LAW:one-way-deps].

import { SAMPLE_RATE } from "./modelAssets";
import { RENDITION_VERSIONS, type RenditionVersions, type SynthesisUnit } from "./speechScript";

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
export const wordsOf = (unit: SynthesisUnit): ReadonlyArray<WordSpan> =>
  Array.from(unit.utterance.text.slice(unit.start, unit.end).matchAll(RUN))
    .filter((run) => LEXICAL.test(run[0]))
    .map((run) => ({ charStart: unit.start + run.index, charEnd: unit.start + run.index + run[0].length }));

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
): Stamped | Rejection => {
  const spans = wordsOf(unit);
  const wordCount: Rejection = { kind: "word-count", index, expected: spans.length, got: times.length };
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

const stamp = (index: number, unit: SynthesisUnit, durationMs: number, reported: ReportedAlignment): Stamped | Rejection =>
  reported.kind === "unit"
    ? { kind: "stamped", alignment: reported }
    : stampTimes(index, unit, durationMs, reported.kind, reported.times);

// [LAW:parse-dont-validate] The one checkpoint between the worker and a record: a report
// becomes a ManifestUnit here or is rejected with the reason. Whether a unit may be
// recorded twice is not this function's rule — the scheduler replaces a record when it
// re-synthesizes a unit whose audio it had dropped, `addUnit` refuses — so the duplicate
// arm lives with the manifest, below, and this stays the one stamping.
export type Recording = { readonly kind: "record"; readonly record: ManifestUnit } | Rejection;

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

// The units synthesized without a gap from the start — the stretch a global timeline is
// defined over.
export const knownPrefix = (manifest: Manifest): ReadonlyArray<ManifestUnit> => {
  const prefix: ManifestUnit[] = [];
  for (const unit of manifest.units) {
    if (unit === undefined) break;
    prefix.push(unit);
  }
  return prefix;
};

export const totalDurationMs = (manifest: Manifest): number =>
  knownPrefix(manifest).reduce((sum, unit) => sum + unit.durationMs, 0);

// Milliseconds from the start of the rendition, or `undefined` when a unit before the
// position (or the position's own unit) has not been synthesized.
export const toGlobalMs = (manifest: Manifest, position: Position): number | undefined => {
  const prefix = knownPrefix(manifest);
  return position.unitIndex < prefix.length
    ? prefix.slice(0, position.unitIndex).reduce((sum, unit) => sum + unit.durationMs, 0) + position.offsetMs
    : undefined;
};

// The position at a global time over the known prefix, clamped to its ends: before the
// start is the start, at or past the end is the end of the last known unit. `undefined`
// only when nothing has been synthesized yet, so there is no timeline to be on.
export const toPosition = (manifest: Manifest, globalMs: number): Position | undefined => {
  const prefix = knownPrefix(manifest);
  let start = 0;
  for (const [unitIndex, unit] of prefix.entries()) {
    if (globalMs < start + unit.durationMs) return { unitIndex, offsetMs: Math.max(0, globalMs - start) };
    start += unit.durationMs;
  }
  const lastUnit = prefix.at(-1);
  return lastUnit === undefined ? undefined : { unitIndex: prefix.length - 1, offsetMs: lastUnit.durationMs };
};

// The script units that say turn `index` — the node index every utterance of that turn
// carries as `Utterance.index`, the same N as its t<N> anchor — as a half-open index
// range. The script is in turn order, so the range is [first unit of a turn >= it, first
// unit of a turn > it): contiguous, and for a turn that says nothing (no utterances, or
// only whitespace) empty at the next spoken unit, which is where a seek to that turn lands.
export interface UnitRange {
  readonly from: number;
  readonly to: number;
}

export const unitsForTurn = (manifest: Manifest, index: number): UnitRange => {
  const firstAtOrAfter = (turn: number): number => {
    const at = manifest.script.findIndex((unit) => unit.utterance.index >= turn);
    return at === -1 ? manifest.script.length : at;
  };
  return { from: firstAtOrAfter(index), to: firstAtOrAfter(index + 1) };
};

// ── the cursor ──────────────────────────────────────────────────────────────────────

// The last word that has started by `offsetMs`: a read-along cursor stays on the word
// just said through the silence before the next, and there is none before the first word
// has begun. `endMs` is data for whoever wants the gap itself. A scan, not a search: a
// unit holds at most MAX_UNIT_TOKENS tokens, so this is a few dozen comparisons per
// animation frame at the very most.
export const wordAt = (words: ReadonlyArray<WordTime>, offsetMs: number): WordTime | undefined =>
  words.findLast((word) => word.startMs <= offsetMs);

// What to highlight at a position, in utterance-text coordinates, and what that
// highlight is allowed to claim: a word only from a measured alignment, otherwise the
// unit's own span — a guess never looks like a measurement [LAW:no-silent-failure].
export interface Cursor extends WordSpan {
  readonly precision: "word" | "unit";
}

export const cursorAt = (record: ManifestUnit, offsetMs: number): Cursor => {
  const span: Cursor = { precision: "unit", charStart: record.unit.start, charEnd: record.unit.end };
  if (record.alignment.kind !== "words") return span;
  const word = wordAt(record.alignment.words, offsetMs);
  return word === undefined ? span : { precision: "word", charStart: word.charStart, charEnd: word.charEnd };
};
