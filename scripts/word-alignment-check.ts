// Word alignment: the port of dpm63/pocket-tts-timestamped's text units, token-to-unit
// map and alignment state machine, replayed against streams captured from the reference
// itself (slopspot-read-along-q35.v70). Run: `tsx scripts/word-alignment-check.ts`.
//
// FIXTURE. test/fixtures/word-alignment.json is the reference implementation's own record
// of six texts under english_2026-04 and the alba voice: the units it built over the text
// it fed the model, its token ids and piece strings, its token-to-unit matrix, and — for
// every generated frame — the unit scores its attention capture produced, whether the
// frame was voiced, and the events its state machine emitted; then the final words. It was
// written by scripts/capture-word-alignment.py (see test/fixtures/README.md). No model runs
// here: the check proves that, given the reference's per-frame inputs, the port builds the
// same units and map and emits the same events at the same times, so the reference's
// measured accuracy (49 ms mean error against CrisperWhisper, zero skips) is inherited by
// equality, not re-measured [LAW:verifiable-goals].
//
// Two of the reference's steps are not the port's to reproduce and are handled at the
// fixture's edge: it re-chunks text with its own chunker (it fed "foo. bar" for "foo.bar"),
// so the unit is built over the FED text; and it appends a terminal "." the source lacked,
// which is the speech script's own rule too, so the utterance the unit points into is the
// fed text minus that synthetic punctuation.
//
// [LAW:behavior-not-structure] Every assertion is about an observable: the units and map a
// text yields, the events a stream yields, the times the manifest admits. A different
// implementation of the same contract passes.

import { readFileSync } from "node:fs";
import { FRAME_MS, MODEL_ASSETS } from "../src/modelAssets";
import { recordUnit, wordsOf } from "../src/speechManifest";
import { unitText, type SynthesisUnit } from "../src/speechScript";
import {
  createWordAligner,
  isVoiced,
  lexicalWords,
  planAlignment,
  textUnits,
  tokenSpans,
  tokenToUnit,
  unitScores,
  type AlignmentEvent,
  type Span,
} from "../src/wordAlignment";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const throws = (label: string, fn: () => void): void => {
  try {
    fn();
    assert(`${label} (no throw)`, false);
  } catch (error) {
    assert(`${label}: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error);
  }
};

// ── the fixture ─────────────────────────────────────────────────────────────────────

interface FixtureUnit {
  readonly text: string;
  readonly begin: number;
  readonly end: number;
  readonly isWord: boolean;
  readonly synthetic: boolean;
  readonly wordIndex: number | null;
}

interface FixtureEvent {
  readonly kind: "start" | "end";
  readonly word: string;
  readonly index: number;
  readonly t: number; // seconds
  readonly start?: number;
}

interface FixtureFrame {
  readonly scores: ReadonlyArray<number>;
  readonly voiced: boolean;
  readonly frameStart: number; // seconds
  readonly events: ReadonlyArray<FixtureEvent>;
}

interface Capture {
  readonly source: string;
  readonly fed: string;
  readonly units: ReadonlyArray<FixtureUnit>;
  readonly tokens: ReadonlyArray<number>;
  readonly pieces: ReadonlyArray<string>;
  readonly tokenToUnit: ReadonlyArray<ReadonlyArray<number>>;
  readonly frames: ReadonlyArray<FixtureFrame>;
  readonly finish: { readonly audioEnd: number; readonly events: ReadonlyArray<FixtureEvent> };
  readonly words: ReadonlyArray<{ readonly word: string; readonly index: number; readonly start: number; readonly end: number }>;
  readonly samples: number;
}

interface Fixture {
  readonly model: string;
  readonly voice: string;
  readonly captures: ReadonlyArray<Capture>;
}

const fixture = JSON.parse(readFileSync("test/fixtures/word-alignment.json", "utf8")) as Fixture;

// The unit as the speech script would have cut it for the fed text: the utterance is the
// fed text without the punctuation the reference appended, the unit spans all of it.
const unitOf = (capture: Capture): SynthesisUnit => {
  const last = capture.units.at(-1);
  const text = last !== undefined && !last.isWord && last.synthetic ? capture.fed.slice(0, last.begin) : capture.fed;
  return { utterance: { index: 0, anchor: "t0", voice: "assistant", text }, start: 0, end: text.length, text: capture.fed };
};

const ms = (seconds: number): number => seconds * 1000;
const near = (a: number, b: number, tolerance = 1e-6): boolean => Math.abs(a - b) <= tolerance;
const sameEvent = (ours: AlignmentEvent, theirs: FixtureEvent): boolean =>
  ours.kind === theirs.kind && ours.word === theirs.index && near(ours.at, ms(theirs.t)) && (ours.kind === "start" || near(ours.start, ms(theirs.start ?? NaN)));

assert(`the fixture was captured from ${fixture.model} with the ${fixture.voice} voice`, fixture.model === "english_2026-04" && fixture.voice === "alba" && fixture.captures.length === 6);

for (const capture of fixture.captures) {
  console.log(`\nreplay: ${JSON.stringify(capture.source)}`);
  const unit = unitOf(capture);
  const plan = planAlignment(unitText(unit), capture.pieces);

  const sameUnits =
    plan.units.length === capture.units.length &&
    plan.units.every((ours, i) => {
      const theirs = capture.units[i];
      if (theirs === undefined || ours.begin !== theirs.begin || ours.end !== theirs.end) return false;
      return ours.kind === "word" ? theirs.isWord && ours.word === theirs.wordIndex : !theirs.isWord && ours.synthetic === theirs.synthetic;
    });
  assert(`${capture.units.length} text units with the reference's spans, kinds, word indices and synthetic flags`, sameUnits);
  assert(
    "every unit spells the reference's text",
    plan.units.every((ours, i) => capture.fed.slice(ours.begin, ours.end) === capture.units[i]?.text),
  );

  assert(`${capture.pieces.length} pieces, one per token id`, capture.pieces.length === capture.tokens.length);
  const sameMap =
    plan.tokenToUnit.length === capture.tokenToUnit.length &&
    plan.tokenToUnit.every((row, t) => {
      const theirs = capture.tokenToUnit[t];
      return theirs !== undefined && row.length === theirs.length && row.every((x, u) => near(x, theirs[u] ?? NaN));
    });
  assert(`the ${capture.tokens.length}×${capture.units.length} token-to-unit map equals the reference's`, sameMap);

  const aligner = createWordAligner(plan);
  let mismatches = 0;
  let frameStarts = true;
  for (const [frameIndex, frame] of capture.frames.entries()) {
    frameStarts &&= near(ms(frame.frameStart), frameIndex * FRAME_MS);
    const events = aligner.frame(Float64Array.from(frame.scores), frame.voiced, frameIndex * FRAME_MS);
    const same = events.length === frame.events.length && events.every((ours, i) => sameEvent(ours, frame.events[i] ?? { kind: "start", word: "", index: -1, t: NaN }));
    if (!same) mismatches++;
  }
  assert(`the reference's frame starts are ${FRAME_MS} ms multiples`, frameStarts);
  assert(`${capture.frames.length} frames replayed with the reference's events at the reference's times`, mismatches === 0);

  const audioEndMs = (capture.samples / MODEL_ASSETS.weights.frameSamples) * FRAME_MS;
  assert("the audio is a whole number of frames, one per replayed frame", near(audioEndMs, ms(capture.finish.audioEnd)) && capture.samples === capture.frames.length * MODEL_ASSETS.weights.frameSamples);
  const times = aligner.finish(audioEndMs);

  // The reference's lexical words, projected onto the manifest's words: a manifest word
  // spans its first lexical word's start to its last one's end.
  const words = wordsOf(unit);
  const lexical = lexicalWords(unit.text);
  const expected = words.map((word) => {
    const own = capture.words.filter((w) => {
      const span = lexical[w.index];
      return span !== undefined && word.charStart <= span.begin && span.end <= word.charEnd;
    });
    const first = own[0];
    const last = own.at(-1);
    return first === undefined || last === undefined ? undefined : { startMs: ms(first.start), endMs: ms(last.end) };
  });
  assert(`${capture.words.length} reference words fall into ${words.length} manifest words, none empty`, expected.every((e) => e !== undefined) && capture.words.length === lexical.length);
  assert(
    "finish yields the reference's word times, projected onto the manifest's words",
    times.length === expected.length && times.every((ours, i) => near(ours.startMs, expected[i]?.startMs ?? NaN) && near(ours.endMs, expected[i]?.endMs ?? NaN)),
  );

  const recorded = recordUnit([unit], 0, { durationMs: capture.frames.length * FRAME_MS, alignment: { kind: "words", times } });
  assert(
    "the manifest admits the report as a `words` alignment, one time on each of its words",
    recorded.kind === "record" && recorded.record.alignment.kind === "words" && recorded.record.alignment.words.length === words.length,
  );
}

// ── the token spans ─────────────────────────────────────────────────────────────────

console.log("\ntoken spans");
{
  const same = (a: ReadonlyArray<Span>, b: ReadonlyArray<[number, number]>): boolean =>
    a.length === b.length && a.every((s, i) => s.begin === b[i]?.[0] && s.end === b[i]?.[1]);
  assert("the dummy boundary piece spans nothing; a word piece spans its characters", same(tokenSpans("Hi there", ["▁", "Hi", "▁there"]), [[0, 0], [0, 2], [2, 8]]));
  assert("a piece spanning a boundary starts at the space", same(tokenSpans("Hi there", ["▁Hi", "▁there"]), [[0, 2], [2, 8]]));
  assert("a collapsed whitespace run stands for its first character", same(tokenSpans("a  b", ["▁a", "▁b"]), [[0, 1], [1, 4]]));
  assert("leading whitespace is trimmed, and the offsets stay in the text's coordinates", same(tokenSpans("  a", ["▁a"]), [[2, 3]]));
  assert(
    "the byte pieces of one character all get that character's span",
    same(tokenSpans("a—b", ["▁a", "<0xE2>", "<0x80>", "<0x94>", "b"]), [[0, 1], [1, 2], [1, 2], [1, 2], [2, 3]]),
  );
  assert("an astral character is one code point of two UTF-16 units", same(tokenSpans("a😀b", ["▁a", "<0xF0>", "<0x9F>", "<0x98>", "<0x80>", "b"]), [[0, 1], [1, 3], [1, 3], [1, 3], [1, 3], [3, 4]]));
  throws("a piece that does not spell the text is thrown", () => tokenSpans("Hi there", ["▁Hi", "▁then"]));
  throws("pieces that stop short of the text are thrown", () => tokenSpans("Hi there", ["▁Hi"]));
  throws("pieces that run past the text are thrown", () => tokenSpans("Hi", ["▁Hi", "▁there"]));
  throws("a byte sequence cut short by a word piece is thrown", () => tokenSpans("a—b", ["▁a", "<0xE2>", "b"]));
}

// ── the map and the scores ──────────────────────────────────────────────────────────

console.log("\nunit scores");
{
  const text = "Hello world.";
  const units = textUnits(text, text.length);
  const spans = tokenSpans(text, ["▁Hello", "▁wor", "ld", "."]);
  const map = tokenToUnit(spans, units);
  assert("a token inside one unit gives it all its share", map[0]?.join() === "1,0,0" && map[3]?.join() === "0,0,1");
  assert("a token split over two units shares by overlap", map[1]?.join() === "0,1,0" && map[2]?.join() === "0,1,0");
  const plan = planAlignment({ text, source: text }, ["▁Hello", "▁wor", "ld", "."]);
  const uniform = unitScores(plan, [0, 0, 0, 0]);
  assert("uniform logits spread attention by token count: 1/4, 2/4, 1/4", near(uniform[0] ?? NaN, 0.25) && near(uniform[1] ?? NaN, 0.5) && near(uniform[2] ?? NaN, 0.25));
  const peaked = unitScores(plan, [100, 0, 0, 0]);
  assert("a dominant logit takes the whole frame", near(peaked[0] ?? NaN, 1) && near(peaked[1] ?? NaN, 0));
  throws("a logits row of the wrong length is thrown", () => unitScores(plan, [0, 0]));
  assert("a silent frame is not voiced; a frame above the RMS threshold is", !isVoiced(new Float32Array(1920)) && isVoiced(new Float32Array(1920).fill(0.01)) && !isVoiced(new Float32Array(0)));
}

// ── skipped words ───────────────────────────────────────────────────────────────────

console.log("\nskipped words");
{
  const text = "One two three.";
  const unit: SynthesisUnit = { utterance: { index: 0, anchor: "t0", voice: "assistant", text }, start: 0, end: text.length, text };
  const plan = planAlignment(unitText(unit), ["▁One", "▁two", "▁three", "."]);
  const aligner = createWordAligner(plan);
  const score = (...xs: number[]): Float64Array => Float64Array.from(xs);
  const opened = aligner.frame(score(0.9, 0.05, 0.03, 0.02), true, 0);
  assert("the first voiced frame opens the first word", opened.length === 1 && opened[0]?.kind === "start" && opened[0].word === 0);
  const handed = aligner.frame(score(0.2, 0.7, 0.05, 0.05), true, FRAME_MS);
  assert("the next word dominating closes the open word and opens it", handed.map((e) => `${e.kind} ${e.word}`).join() === "end 0,start 1");
  const closed = aligner.frame(score(0.1, 0.2, 0.1, 0.6), false, 2 * FRAME_MS);
  assert("a silent frame with attention past the open word closes it", closed.map((e) => `${e.kind} ${e.word}`).join() === "end 1");
  const times = aligner.finish(3 * FRAME_MS);
  assert(
    "a word never opened is an empty interval at the previous word's end",
    times.map((t) => `${t.startMs}-${t.endMs}`).join() === `0-${FRAME_MS},${FRAME_MS}-${2 * FRAME_MS},${2 * FRAME_MS}-${2 * FRAME_MS}`,
  );
  const recorded = recordUnit([unit], 0, { durationMs: 3 * FRAME_MS, alignment: { kind: "words", times } });
  assert("the manifest admits the empty interval", recorded.kind === "record");
  throws("a scores row of the wrong length is thrown", () => aligner.frame(score(1), true, 0));
}

if (process.exitCode === 1) {
  console.error("\nSome word-alignment checks failed.");
} else {
  console.log("\nAll word-alignment checks passed.");
}
