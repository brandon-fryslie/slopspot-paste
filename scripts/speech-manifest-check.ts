// The speech manifest: the per-unit record the player reads — audio length, word times
// stamped onto the script's words, alignment precision as a kind — and the position math
// over it (slopspot-read-along-q35.4). Run: `tsx scripts/speech-manifest-check.ts`.
//
// FIXTURE. The units are the real speech script of test/fixtures/chatgpt-share.md under
// the same word-ish tokenizer speech-script-check uses. The worker REPORTS are constructed
// by a stated rule, because no worker exists yet to capture from (q35.q3l): a unit's audio
// is one 80 ms frame per 1.2 source characters; unit i reports `words` (times on frame
// boundaries, one frame-share per word), `unit`, or `estimated` (the module's own
// estimator) by i mod 3; reports are admitted in a stride order, so the builder is proven
// on out-of-order arrival. When the worker lands, a captured report set replaces the rule
// and every assertion below holds unchanged, because none reads the rule — only the
// invariants a record must satisfy whatever the model said.
//
// [LAW:behavior-not-structure] Every assertion is about an observable: what a position
// converts to, which word a time lands on, what the cursor claims, which report is
// refused and why. A different implementation of the same contract passes.

import { readFileSync } from "node:fs";
import { deriveDialogue, plainView } from "../src/dialogue";
import { FRAME_MS, SAMPLE_RATE } from "../src/modelAssets";
import { parseChatgptShare } from "../src/parsers/chatgpt-share";
import { deriveUtterances, type Utterance } from "../src/speech";
import {
  addUnit,
  cursorAt,
  emptyManifest,
  estimateTimes,
  knownPrefix,
  toGlobalMs,
  toPosition,
  totalDurationMs,
  unitsForTurn,
  wordAt,
  wordsOf,
  type Manifest,
  type ManifestUnit,
  type Rejection,
  type UnitReport,
  type WordTime,
  type WordTiming,
} from "../src/speechManifest";
import { deriveSpeechScript, type SynthesisUnit, type TokenCount } from "../src/speechScript";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const wordish: TokenCount = (text) => (text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? []).length;
const utter = (text: string, index = 0): Utterance => ({ index, anchor: `t${index}`, voice: "assistant", text });
const scriptOf = (...texts: string[]): ReadonlyArray<SynthesisUnit> =>
  deriveSpeechScript(
    texts.map((t, i) => utter(t, i)),
    wordish,
  );
const spans = (unit: SynthesisUnit): ReadonlyArray<string> =>
  wordsOf(unit).map((w) => unit.utterance.text.slice(w.charStart, w.charEnd));
const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// ── the constructed reports ─────────────────────────────────────────────────────────

const framesOf = (unit: SynthesisUnit): number => Math.max(1, Math.ceil((unit.end - unit.start) / 1.2));

// Each word gets an equal share of the unit's frames, rounded to frame boundaries.
const frameTimes = (unit: SynthesisUnit): ReadonlyArray<WordTiming> => {
  const frames = framesOf(unit);
  const count = wordsOf(unit).length;
  return Array.from({ length: count }, (_, i) => ({
    startMs: Math.floor((i * frames) / count) * FRAME_MS,
    endMs: Math.floor(((i + 1) * frames) / count) * FRAME_MS,
  }));
};

const report = (unit: SynthesisUnit, index: number): UnitReport => {
  const durationMs = framesOf(unit) * FRAME_MS;
  const alignment: UnitReport["alignment"] =
    index % 3 === 0
      ? { kind: "words", times: frameTimes(unit) }
      : index % 3 === 1
        ? { kind: "unit" }
        : { kind: "estimated", times: estimateTimes(unit, durationMs) };
  return { durationMs, alignment };
};

// Indices in stride order: 0, 7, 14, …, then 1, 8, …: every unit once, far from sequence.
const strideOrder = (n: number): ReadonlyArray<number> =>
  Array.from({ length: n }, (_, i) => i).sort((a, b) => (a % 7) - (b % 7) || a - b);

interface Built {
  readonly manifest: Manifest;
  readonly rejections: ReadonlyArray<Rejection>;
}

const build = (script: ReadonlyArray<SynthesisUnit>, order: ReadonlyArray<number>): Built =>
  order.reduce<Built>(
    ({ manifest, rejections }, index) => {
      const unit = script[index];
      if (unit === undefined) throw new Error(`fixture order names unit ${index} outside the script`);
      const admission = addUnit(manifest, index, report(unit, index));
      return admission.kind === "added"
        ? { manifest: admission.manifest, rejections }
        : { manifest, rejections: [...rejections, admission] };
    },
    { manifest: emptyManifest(script), rejections: [] },
  );

const records = (manifest: Manifest): ReadonlyArray<ManifestUnit> =>
  manifest.units.flatMap((u) => (u === undefined ? [] : [u]));

const wordsAscending = (words: ReadonlyArray<WordTime>, durationMs: number): boolean =>
  words.every(
    (w, i) =>
      0 <= w.startMs && w.startMs <= w.endMs && w.endMs <= durationMs && (i === 0 || (words[i - 1]?.endMs ?? Infinity) <= w.startMs),
  );

// ── invariants over the fixture paste ───────────────────────────────────────────────

console.log("\nSpeech manifest — invariants over the fixture paste (slopspot-read-along-q35.4):");
{
  const gpt = parseChatgptShare(readFileSync("test/fixtures/chatgpt-share.md", "utf8"));
  assert("chatgpt-share: fixture parses", gpt !== null);
  if (gpt !== null) {
    const utterances = deriveUtterances(plainView(deriveDialogue(gpt)));
    const script = deriveSpeechScript(utterances, wordish);
    const { manifest, rejections } = build(script, strideOrder(script.length));
    const all = records(manifest);
    console.log(`  (${utterances.length} utterances, ${script.length} units, ${all.length} records)`);

    assert("every report is admitted, in stride order, none rejected", rejections.length === 0 && all.length === script.length);
    assert(
      "the manifest carries the versions and the codec's sample rate",
      manifest.sampleRate === SAMPLE_RATE && manifest.versions.pipeline.length > 0 && manifest.versions.model.length > 0,
    );
    assert(
      "records sit at their script index and hold the script's unit by reference",
      manifest.units.every((u, i) => u !== undefined && u.unit === script[i]),
    );

    // Words: inside their unit, non-whitespace, lexical, ascending in char and in time.
    const timed = all.filter((r) => r.alignment.kind !== "unit");
    const wordsSound = timed.every((r) => {
      const words = r.alignment.kind === "unit" ? [] : r.alignment.words;
      const text = r.unit.utterance.text;
      return (
        words.every(
          (w, i) =>
            r.unit.start <= w.charStart &&
            w.charStart < w.charEnd &&
            w.charEnd <= r.unit.end &&
            /^\S+$/u.test(text.slice(w.charStart, w.charEnd)) &&
            /[\p{L}\p{N}]/u.test(text.slice(w.charStart, w.charEnd)) &&
            (i === 0 || (words[i - 1]?.charEnd ?? Infinity) <= w.charStart),
        ) && wordsAscending(words, r.durationMs)
      );
    });
    assert("every stamped word is a lexical non-whitespace run inside its unit, ascending in text and in time", wordsSound);
    assert(
      "a stamped word list is exactly wordsOf(unit) with times attached",
      timed.every((r) => {
        const words = r.alignment.kind === "unit" ? [] : r.alignment.words;
        const own = wordsOf(r.unit);
        return words.length === own.length && words.every((w, i) => w.charStart === own[i]?.charStart && w.charEnd === own[i]?.charEnd);
      }),
    );
    assert(
      "all three precisions occur in the fixture",
      ["words", "unit", "estimated"].every((k) => all.some((r) => r.alignment.kind === k)),
    );

    // Global time over the complete manifest.
    const total = totalDurationMs(manifest);
    assert(
      "totalDurationMs is the sum of every unit's duration once all are known",
      total === all.reduce((s, r) => s + r.durationMs, 0) && knownPrefix(manifest).length === script.length,
    );
    const roundTrips = all.every((r, unitIndex) =>
      [0, r.durationMs / 2, r.durationMs - 1].every((offsetMs) => {
        const g = toGlobalMs(manifest, { unitIndex, offsetMs });
        const p = g === undefined ? undefined : toPosition(manifest, g);
        return p !== undefined && p.unitIndex === unitIndex && p.offsetMs === offsetMs;
      }),
    );
    assert("position -> global -> position round-trips for every unit at its start, middle and last ms", roundTrips);
    const globalStarts = all.map((_, unitIndex) => toGlobalMs(manifest, { unitIndex, offsetMs: 0 }) ?? -1);
    assert(
      "global time of unit starts is strictly increasing and starts at 0",
      globalStarts[0] === 0 && globalStarts.every((g, i) => i === 0 || g > (globalStarts[i - 1] ?? Infinity)),
    );
    const end = toPosition(manifest, total);
    const past = toPosition(manifest, total + 5000);
    const before = toPosition(manifest, -5);
    assert(
      "a global time at or past the end is the end of the last unit; before the start is the start",
      end !== undefined &&
        end.unitIndex === script.length - 1 &&
        end.offsetMs === all[script.length - 1]?.durationMs &&
        past !== undefined &&
        past.unitIndex === end.unitIndex &&
        past.offsetMs === end.offsetMs &&
        before !== undefined &&
        before.unitIndex === 0 &&
        before.offsetMs === 0,
    );

    // The cursor: a word only from a measured alignment.
    const cursorHonest = all.every((r) => {
      const probes = [0, r.durationMs / 3, r.durationMs / 2, r.durationMs];
      return probes.every((ms) => {
        const c = cursorAt(r, ms);
        const inUnit = r.unit.start <= c.charStart && c.charEnd <= r.unit.end;
        return r.alignment.kind === "words"
          ? inUnit
          : c.precision === "unit" && c.charStart === r.unit.start && c.charEnd === r.unit.end;
      });
    });
    assert("cursorAt claims word precision only for a `words` alignment; `unit` and `estimated` get the unit span", cursorHonest);
    const measured = all.filter((r) => r.alignment.kind === "words" && r.alignment.words.length > 0);
    assert(
      "for a measured unit the cursor is on a word by the time its last word has started",
      measured.every((r) => cursorAt(r, r.durationMs).precision === "word"),
    );

    // Turn ranges tile the script in order. Several utterances share a turn (a turn's
    // prose, its announced code blocks, its images), so the distinct turn indices are
    // what tile.
    const turns = [...new Set(utterances.map((u) => u.index))];
    const ranges = turns.map((t) => unitsForTurn(manifest, t));
    assert(
      "unitsForTurn ranges are contiguous, in turn order, tile the script exactly, and hold only that turn's units",
      turns.length < utterances.length &&
        ranges.every((r, i) => r.from <= r.to && (i === 0 ? r.from === 0 : r.from === ranges[i - 1]?.to)) &&
        ranges.at(-1)?.to === script.length &&
        ranges.every((r, i) => script.slice(r.from, r.to).every((u) => u.utterance.index === turns[i])),
    );
  }
}

// ── the rules, on constructed units ─────────────────────────────────────────────────

console.log("\nSpeech manifest — words, estimation and the cursor:");
{
  const [unit] = scriptOf("hello — world, 3.5 (ok)... isn’t it? Yes.");
  assert("script fixture yields a unit", unit !== undefined);
  if (unit !== undefined) {
    assert(
      "wordsOf: non-whitespace runs with a letter or digit, punctuation attached, bare punctuation dropped",
      same(spans(unit), ["hello", "world,", "3.5", "(ok)...", "isn’t", "it?", "Yes."]),
    );
    const est = estimateTimes(unit, 1000);
    assert("estimateTimes: one time per word, ascending, within the duration", est.length === 7 && wordsAscending(est.map((t, i) => ({ ...t, charStart: i, charEnd: i + 1 })), 1000));
    const length = unit.end - unit.start;
    assert(
      "estimateTimes: a word's share of the audio is its share of the characters",
      est[0]?.startMs === 0 && est[0]?.endMs === (1000 * 5) / length && est[6]?.endMs === 1000,
    );
  }

  const words: ReadonlyArray<WordTime> = [
    { charStart: 0, charEnd: 3, startMs: 100, endMs: 300 },
    { charStart: 4, charEnd: 7, startMs: 400, endMs: 600 },
    { charStart: 8, charEnd: 9, startMs: 800, endMs: 800 },
  ];
  assert("wordAt: before the first word has started there is no word", wordAt(words, 50) === undefined);
  assert("wordAt: inside a word returns it", wordAt(words, 250)?.charStart === 0 && wordAt(words, 400)?.charStart === 4);
  assert("wordAt: in the silence between words the cursor stays on the word just said", wordAt(words, 700)?.charStart === 4);
  assert("wordAt: after the last word it stays on the last word", wordAt(words, 5000)?.charStart === 8);
}

console.log("\nSpeech manifest — admission and rejection:");
{
  const script = scriptOf("One two three.", "Four five.", "   ", "Six.");
  assert("fixture: four utterances, three spoken, yield one unit each", script.length === 3);
  const empty = emptyManifest(script);
  const dur = (i: number): number => (script[i]?.end ?? 0) * 100;
  const times = (i: number, ...t: ReadonlyArray<readonly [number, number]>): ReadonlyArray<WordTiming> =>
    t.map(([startMs, endMs]) => ({ startMs, endMs }));

  const first = addUnit(empty, 0, { durationMs: dur(0), alignment: { kind: "words", times: times(0, [0, 200], [200, 500], [500, 900]) } });
  assert("a well-formed `words` report is added", first.kind === "added" && first.manifest.units[0]?.alignment.kind === "words");
  const m1 = first.kind === "added" ? first.manifest : empty;
  assert("the source manifest is untouched by an admission", empty.units.every((u) => u === undefined));

  const dup = addUnit(m1, 0, { durationMs: dur(0), alignment: { kind: "unit" } });
  assert("a second report for the same unit is rejected as duplicate", dup.kind === "duplicate" && dup.index === 0);
  const unknown = addUnit(m1, 3, { durationMs: 100, alignment: { kind: "unit" } });
  assert("a report for a unit the script does not have is rejected as unknown-unit", unknown.kind === "unknown-unit" && unknown.index === 3);
  const negative = addUnit(m1, 1, { durationMs: -1, alignment: { kind: "unit" } });
  const nan = addUnit(m1, 1, { durationMs: Number.NaN, alignment: { kind: "unit" } });
  assert("a negative or non-finite duration is rejected as bad-duration", negative.kind === "bad-duration" && nan.kind === "bad-duration");
  const short = addUnit(m1, 1, { durationMs: dur(1), alignment: { kind: "words", times: times(1, [0, 100]) } });
  assert(
    "fewer times than words is rejected as word-count, naming both counts",
    short.kind === "word-count" && short.expected === 2 && short.got === 1,
  );
  const long = addUnit(m1, 1, { durationMs: dur(1), alignment: { kind: "estimated", times: times(1, [0, 100], [100, 200], [200, 300]) } });
  assert("more times than words is rejected as word-count too", long.kind === "word-count" && long.expected === 2 && long.got === 3);
  const overlap = addUnit(m1, 1, { durationMs: dur(1), alignment: { kind: "words", times: times(1, [0, 300], [200, 400]) } });
  assert("overlapping word times are rejected as times-out-of-order at the offending word", overlap.kind === "times-out-of-order" && overlap.word === 1);
  const inverted = addUnit(m1, 1, { durationMs: dur(1), alignment: { kind: "words", times: times(1, [300, 100], [400, 500]) } });
  assert("a word that ends before it starts is rejected at that word", inverted.kind === "times-out-of-order" && inverted.word === 0);
  const beyond = addUnit(m1, 1, { durationMs: 500, alignment: { kind: "words", times: times(1, [0, 200], [300, 600]) } });
  assert("a word time past the unit's duration is rejected", beyond.kind === "times-out-of-order" && beyond.word === 1);
  assert("a rejected report leaves the manifest as it was", m1.units[1] === undefined);

  // Out of order: the last unit first, then the middle; global time waits for the gap.
  const third = addUnit(m1, 2, { durationMs: dur(2), alignment: { kind: "unit" } });
  const m2 = third.kind === "added" ? third.manifest : m1;
  assert("a unit far ahead of the prefix is admitted", third.kind === "added" && m2.units[2] !== undefined);
  assert(
    "until the gap is filled the timeline stops at the prefix: total is unit 0 alone, unit 2 has no global time",
    totalDurationMs(m2) === dur(0) && toGlobalMs(m2, { unitIndex: 2, offsetMs: 0 }) === undefined && toGlobalMs(m2, { unitIndex: 1, offsetMs: 0 }) === undefined,
  );
  assert("a global time past the prefix lands at the end of the prefix, not in the unknown", toPosition(m2, dur(0) + 1000)?.unitIndex === 0);
  assert("an empty manifest has no timeline: total 0, no position", totalDurationMs(empty) === 0 && toPosition(empty, 0) === undefined);
  const unit1 = script[1];
  if (unit1 === undefined) throw new Error("fixture: the script has no unit 1 to fill the gap with");
  const second = addUnit(m2, 1, { durationMs: dur(1), alignment: { kind: "estimated", times: estimateTimes(unit1, dur(1)) } });
  const m3 = second.kind === "added" ? second.manifest : m2;
  assert(
    "filling the gap extends the timeline over all three units",
    second.kind === "added" && totalDurationMs(m3) === dur(0) + dur(1) + dur(2) && toGlobalMs(m3, { unitIndex: 2, offsetMs: 10 }) === dur(0) + dur(1) + 10,
  );

  const r1 = m3.units[1];
  assert(
    "the cursor on an `estimated` unit is its span at every offset, never a word",
    r1 !== undefined && r1.alignment.kind === "estimated" && [0, dur(1) / 2, dur(1)].every((ms) => cursorAt(r1, ms).precision === "unit"),
  );
  const r0 = m3.units[0];
  assert(
    "the cursor on a `words` unit is the utterance's own word at that time",
    r0 !== undefined && (() => {
      const c = cursorAt(r0, 250);
      return c.precision === "word" && r0.unit.utterance.text.slice(c.charStart, c.charEnd) === "two";
    })(),
  );

  assert(
    "unitsForTurn: a whitespace-only turn is an empty range at the next spoken unit; a missing one is empty at the end",
    (() => {
      const blank = unitsForTurn(m3, 2);
      const missing = unitsForTurn(m3, 9);
      return blank.from === 2 && blank.to === 2 && unitsForTurn(m3, 3).from === 2 && missing.from === 3 && missing.to === 3;
    })(),
  );
}
