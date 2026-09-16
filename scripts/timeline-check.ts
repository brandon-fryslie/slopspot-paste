// The conversation's timeline: the layout with the gaps between speakers as silence
// slots, where a place falls on the clock, what a time names and what it paints, the
// landmarks a skip lands on, and which part of the clock is a measurement rather than a
// guess (slopspot-read-along-a35.3, slopspot-read-along-a35.1ni). Run:
// `tsx scripts/timeline-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is the contract the transport drives: that
// exactly one silence segment of GAP_MS sits between consecutive turns and none before the
// first, that a time inside a gap paints nothing and names the turn about to begin, that
// back and forward over the landmarks behave at every boundary, that a measured segment is
// the worker's own duration and an unmeasured one the measured rate's share, and that
// "about" appears over exactly the guesses. Pure over values, no mocks of anything
// [LAW:effects-at-boundaries].

import type { Place } from "../src/performer";
import type { Utterance } from "../src/speech";
import { addUnit, emptyManifest, type Manifest, type UnitReport, type WordStart } from "../src/speechManifest";
import { prepareText, type SynthesisUnit } from "../src/speechScript";
import {
  clockText,
  DEFAULT_MS_PER_CHAR,
  estimated,
  GAP_MS,
  landmark,
  landmarks,
  layoutOf,
  placeAt,
  placeIn,
  pointAt,
  speechSegments,
  startAt,
  timeOfStart,
  cursorAt,
  timeAt,
  timelineOfScript,
  timelineOfUtterances,
  type Point,
  type Timeline,
} from "../src/timeline";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const throws = (label: string, f: () => unknown): void => {
  let threw = false;
  try {
    f();
  } catch {
    threw = true;
  }
  assert(label, threw);
};

// ── fixtures ──────────────────────────────────────────────────────────────────────────

// Four passages on three turns — the first turn speaks twice, as a turn with prose and an
// announced code block does — and the first passage is long enough for two units.
const one: Utterance = { index: 1, anchor: "t1", origin: "page", voice: "user", text: "First sentence here. Second sentence here." };
const two: Utterance = { index: 1, anchor: "t1", origin: "announcement", voice: "narrator", text: "python code block, 2 lines." };
const three: Utterance = { index: 2, anchor: "t2", origin: "page", voice: "assistant", text: "A reply." };
const four: Utterance = { index: 3, anchor: "t3", origin: "page", voice: "user", text: "And a follow-up question." };
const utterances = [one, two, three, four];

const unit = (utterance: Utterance, start: number, end: number): SynthesisUnit => ({ utterance, start, end, ...prepareText(utterance.text.slice(start, end)) });
const script: SynthesisUnit[] = [unit(one, 0, 20), unit(one, 21, 42), unit(two, 0, 27), unit(three, 0, 8), unit(four, 0, 25)];
const utteranceOf = [0, 0, 1, 2, 3];
// No unit is being made: the model has begun no word of any.
const nothingBegun = (): ReadonlyArray<WordStart> => [];

const report = (durationMs: number): UnitReport => ({ durationMs, alignment: { kind: "unit" } });
const recorded = (indices: ReadonlyArray<number>, ms: (index: number) => number, manifest: Manifest = emptyManifest(script)): Manifest =>
  indices.reduce((manifest, index) => {
    const added = addUnit(manifest, index, report(ms(index)));
    if (added.kind !== "added") throw new Error(`fixture: unit ${index} was ${added.kind}`);
    return added.manifest;
  }, manifest);

const chars = (unitIndex: number): number => {
  const u = script[unitIndex];
  if (u === undefined) throw new Error(`fixture: no unit ${unitIndex}`);
  return u.end - u.start;
};
const mark = (utterance: number, char = 0): Place => ({ utterance, char });
// Each segment as "utterance:chars" with m/e for measured/estimated, or "gap" for silence.
const legsOf = (timeline: Timeline): string =>
  timeline.segments
    .map((leg) => (leg.content.kind === "silence" ? `gap${leg.ms}` : `${leg.content.utterance}:${leg.content.charStart}-${leg.content.charEnd}${leg.content.timing.kind === "guess" ? "e" : "m"}`))
    .join();
// A layout as "s" per speech slot and "g" per gap.
const shapeOf = (anchors: ReadonlyArray<string>): string => layoutOf(anchors).map((slot) => (slot.kind === "silence" ? "g" : "s")).join("");
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

// ── the gap rule ──────────────────────────────────────────────────────────────────────

console.log("layoutOf: a silence slot before every change of speaker, none before the first");
{
  assert("one rule over the anchors", shapeOf(["a", "a", "b", "c", "c"]) === "ssgsgss");
  assert("a single speaker has no gap anywhere", shapeOf(["a", "a", "a"]) === "sss");
  assert("nobody speaking has no slot at all", shapeOf([]) === "");
  const laid = layoutOf(["a", "b"]);
  assert("a speech slot names its span in order and a silence its length", JSON.stringify(laid) === JSON.stringify([{ kind: "speech", span: 0 }, { kind: "silence", ms: GAP_MS }, { kind: "speech", span: 1 }]));
  assert("the timeline's segments are the layout's slots, index for index", timelineOfUtterances(utterances).segments.map((s) => (s.content.kind === "silence" ? "g" : "s")).join("") === shapeOf(utterances.map((u) => u.anchor)));
}

// ── before any performer exists: every leg a guess ────────────────────────────────────

console.log("timelineOfUtterances: one leg per passage, a gap between turns, the whole thing an estimate");
{
  const line = timelineOfUtterances(utterances);
  assert("a leg per passage, each covering its whole text, a silence leg between turns and none before the first", legsOf(line) === `0:0-42e,1:0-27e,gap${GAP_MS},2:0-8e,gap${GAP_MS},3:0-25e`);
  const text = utterances.reduce((sum, u) => sum + u.text.length, 0);
  assert("the length is every character at the default rate plus the two gaps", line.totalMs === text * DEFAULT_MS_PER_CHAR + 2 * GAP_MS);
  assert("the first mark is at zero and the passages run in order", timeAt(line, mark(0)) === 0 && [1, 2, 3].every((u) => timeAt(line, mark(u)) > timeAt(line, mark(u - 1))));
  assert("a passage of a new turn begins at its gap's end", timeAt(line, mark(2)) === (one.text.length + two.text.length) * DEFAULT_MS_PER_CHAR + GAP_MS);
  assert("an unmeasured leg has no word times, so every character of it resolves to the leg's start", [0, 4, 7].every((ch) => timeAt(line, mark(2, ch)) === timeAt(line, mark(2))));
  assert("the whole clock is a guess, so the time remaining is 'about' wherever the voice is", [0, line.totalMs / 2].every((ms) => estimated(line, ms)));
  assert("at the very end there is nothing left to guess about: 0:00 left is exact", !estimated(line, line.totalMs));
  assert("a paste with one turn has no silence segment", timelineOfUtterances([one, two]).segments.every((leg) => leg.content.kind === "speech"));
}

// ── the neural voice's clock: measured where the worker has finished ──────────────────

console.log("timelineOfScript: measured legs are the worker's, the rest its own rate's share, the gaps by rule");
{
  // Unit 0 measured at 40 ms a character, which is faster than the default.
  const RATE = 40;
  const partly = timelineOfScript(recorded([0], (i) => chars(i) * RATE), utteranceOf, nothingBegun);
  assert("the measured unit is a measured leg; the rest are estimates; the gaps sit before units 3 and 4", legsOf(partly) === `0:0-20m,0:21-42e,1:0-27e,gap${GAP_MS},2:0-8m`.replace("2:0-8m", "2:0-8e") + `,gap${GAP_MS},3:0-25e`);
  const first = partly.segments[0];
  assert("the measured leg carries the worker's own duration", first?.ms === chars(0) * RATE);
  const second = partly.segments[1];
  assert(
    "an unmeasured leg takes the MEASURED rate's share, not the default's",
    second?.ms === chars(1) * RATE && chars(1) * RATE !== chars(1) * DEFAULT_MS_PER_CHAR,
  );
  assert("the passage a segment says is the PAGE's utterance, from the performer's table", speechSegments(partly).map((leg) => leg.content.utterance).join() === utteranceOf.join());
  assert("the speech segments are the units in order: the performer's table from unit to segment", speechSegments(partly).map((leg) => leg.content.charStart).join() === script.map((u) => u.start).join());

  const whole = timelineOfScript(recorded([0, 1, 2, 3, 4], (i) => chars(i) * RATE), utteranceOf, nothingBegun);
  assert("with everything measured the clock is the sum of the durations and the gaps", whole.totalMs === script.reduce((sum, u) => sum + (u.end - u.start) * RATE, 0) + 2 * GAP_MS);
  assert("nothing is a guess any more, so no time remaining says 'about'", [0, whole.totalMs / 2, whole.totalMs].every((ms) => !estimated(whole, ms)));
  assert(
    "'about' is scoped to what is still unmeasured: true before the gap, false after it",
    (() => {
      const gapped = timelineOfScript(recorded([0, 1, 2], (i) => chars(i) * RATE), utteranceOf, nothingBegun);
      const tail = timeAt(gapped, mark(2));
      return estimated(gapped, 0) && estimated(gapped, tail) && !estimated(gapped, gapped.totalMs);
    })(),
  );
  // The two units of passage 0 are contiguous in time, so a mark in the second lands after
  // the first's whole duration — the boundary the scrubber must land on the right side of.
  assert("a mark in the second unit of a passage is past the first unit's audio", timeAt(whole, mark(0, 21)) === chars(0) * RATE);
  assert("a silence leg is never a guess: 'about' does not appear for a gap alone", !estimated(whole, whole.totalMs - GAP_MS - chars(4) * RATE - 1));
  throws("a mark naming a passage no leg says is a bug, not someone else's passage", () => timeAt(whole, mark(9)));
  throws("a character past the passage's text is a bug, not an empty sentence", () => timeAt(whole, mark(3, 25)));
  throws("a negative character is a bug", () => timeAt(whole, mark(1, -1)));

  // A measured unit with word times: a mark resolves to its word's own time.
  const timed = addUnit(emptyManifest(script), 0, {
    durationMs: 300,
    alignment: { kind: "words", times: [{ startMs: 0, endMs: 100 }, { startMs: 100, endMs: 200 }, { startMs: 200, endMs: 300 }] },
  });
  if (timed.kind !== "added") throw new Error("fixture: the words report was rejected");
  const worded = timelineOfScript(timed.manifest, utteranceOf, nothingBegun);
  assert("a character inside a timed word resolves to when that word begins", timeAt(worded, mark(0, 8)) === 100 && timeAt(worded, mark(0, 17)) === 200 && timeAt(worded, mark(0, 3)) === 0);
  assert("the cursor under a timed word is that word, inside the segment's range", (() => {
    const spot = cursorAt(worded, 150);
    return spot?.utterance === 0 && spot.range.charStart === 0 && spot.range.charEnd === 20 && spot.word?.charStart === 6 && spot.word.charEnd === 14;
  })());
  // The name of a moment on timed words is the word the cursor paints there, and it comes
  // back to that word: what a resume position and a link keep (slopspot-read-along-a35.4).
  assert("a moment inside a timed word is named by that word's first character, anywhere in the word", (() => {
    const first = worded.segments[0];
    return first !== undefined && [100, 150, 199].every((ms) => placeIn(worded, first, ms).char === 6) && placeAt(worded, 250)?.char === 15;
  })());
  assert("the name of every moment on timed words resolves to the start of the word painted at that moment", Array.from({ length: 30 }, (_, i) => i * 10).every((ms) => {
    const named = placeAt(worded, ms);
    const back = named === null ? undefined : cursorAt(worded, timeAt(worded, named))?.word;
    return back !== undefined && back !== null && back.charStart === cursorAt(worded, ms)?.word?.charStart;
  }));

  // A unit still being made (slopspot-read-along-a35.8o0): the words the model has begun are
  // painted and named like measured ones, while its length and a seek into it stay a guess.
  // "First sentence here.": "First" and "sentence" begun, "here." not yet.
  const making = timelineOfScript(emptyManifest(script), utteranceOf, (unit) => (unit === 0 ? [{ charStart: 0, charEnd: 5, startMs: 0 }, { charStart: 6, charEnd: 14, startMs: 400 }] : []));
  const streaming = making.segments[0];
  assert("a unit being made paints the last word begun by the time, and past it stays on it", cursorAt(making, 100)?.word?.charStart === 0 && cursorAt(making, 450)?.word?.charStart === 6 && cursorAt(making, 1200)?.word?.charStart === 6);
  assert("a unit being made names a moment by the word begun there", streaming !== undefined && placeIn(making, streaming, 450).char === 6);
  assert("its length is still a guess: 'about', and a place in it resolves to its start", estimated(making, 0) && timeAt(making, mark(0, 6)) === 0 && streaming?.ms === chars(0) * DEFAULT_MS_PER_CHAR);
  assert("a unit nothing has begun paints its range and no word", cursorAt(making, (making.segments[1]?.startMs ?? 0) + 10)?.word === null);

  // A measured unit whose voice draws breath before its first word and trails off after its
  // last (slopspot-read-along-a35.iey). Painted frame by frame, no frame may fall back to
  // the whole sentence group: a word-less cursor on a measured unit is that fallback.
  const breathing = addUnit(emptyManifest(script), 0, {
    durationMs: 600,
    alignment: { kind: "words", times: [{ startMs: 180, endMs: 260 }, { startMs: 260, endMs: 380 }, { startMs: 380, endMs: 440 }] },
  });
  if (breathing.kind !== "added") throw new Error("fixture: the breathing words report was rejected");
  const breathed = timelineOfScript(breathing.manifest, utteranceOf, nothingBegun);
  const frames = Array.from({ length: Math.floor(600 / 16) + 1 }, (_, i) => i * 16);
  const cursors = frames.map((ms) => cursorAt(breathed, ms));
  assert("a measured unit with leading and trailing silence paints a word on every frame, never the whole unit alone", cursors.every((spot) => spot !== null && spot.word !== null));
  assert("through the leading silence the cursor waits on the first word", cursors.slice(0, 12).every((spot) => spot?.word?.charStart === 0 && spot.word.charEnd === 5));
  assert("through the trailing silence the cursor holds the last word", cursors.slice(28).every((spot) => spot?.word?.charStart === 15 && spot.word.charEnd === 20));
}

// ── what a time names and paints ──────────────────────────────────────────────────────

console.log("placeAt, placeIn and cursorAt: a time on the clock names a place, and paints it or nothing");
{
  const RATE = 40;
  const line = timelineOfScript(recorded([0, 1, 2, 3, 4], (i) => chars(i) * RATE), utteranceOf, nothingBegun);
  const gapStart = timeAt(line, mark(1)) + chars(2) * RATE;
  const gapEnd = gapStart + GAP_MS;
  assert("the gap begins where the previous turn's audio ends, and the next turn begins at its end", timeAt(line, mark(2)) === gapEnd);
  assert("inside a gap: nothing to paint", cursorAt(line, gapStart + GAP_MS / 2) === null && cursorAt(line, gapStart) === null);
  assert("inside a gap: the place named is the turn about to begin", (() => {
    const named = placeAt(line, gapStart + GAP_MS / 2);
    return named?.utterance === 2 && named.char === 0;
  })());
  const gap = line.segments.find((segment) => segment.content.kind === "silence");
  assert("the gap segment given outright names the same place, the turn about to begin, and paints nothing", gap !== undefined && placeIn(line, gap, gap.startMs + 100).utterance === 2 && placeIn(line, gap, gap.startMs + 100).char === 0 && cursorAt(line, gap.startMs + 100) === null);
  assert("at the gap's end: the first character of the new turn, painted as its segment's range", (() => {
    const spot = cursorAt(line, gapEnd);
    const named = placeAt(line, gapEnd);
    return spot?.utterance === 2 && spot.range.charStart === 0 && spot.range.charEnd === 8 && spot.word === null && named?.utterance === 2 && named.char === 0;
  })());
  assert("inside speech: the cursor is the segment's range and the name is the character under the time", (() => {
    const t = timeAt(line, mark(0, 21)) + 5 * RATE;
    const spot = cursorAt(line, t);
    const named = placeAt(line, t);
    return spot?.utterance === 0 && spot.range.charStart === 21 && named?.utterance === 0 && named.char >= 21 && named.char < 42;
  })());
  assert("a time inside speech comes back as a character within one character of itself", (() => {
    const t = timeAt(line, mark(0, 21)) + 5 * RATE;
    const named = placeAt(line, t);
    return named !== null && named.char === 21 + 5;
  })());
  assert("a speech segment given outright names the character its share reaches, its end included", (() => {
    const second = line.segments[1];
    return second !== undefined && placeIn(line, second, second.startMs + second.ms).char === 41 && placeIn(line, second, second.startMs - 100).char === 21;
  })());
  assert("before the start is the start: it names the first character and paints the first segment", placeAt(line, -5000)?.utterance === 0 && placeAt(line, -5000)?.char === 0 && cursorAt(line, -5000)?.range.charStart === 0);
  const end = placeAt(line, line.totalMs + 60_000);
  assert("past the end is the last character of the last segment, never past it", end?.utterance === 3 && end?.char === 24);
  assert(
    "every place the clock can name is a character INSIDE its passage — what a place's door requires",
    Array.from({ length: 200 }, (_, i) => (line.totalMs * i) / 199).every((ms) => {
      const at = placeAt(line, ms);
      const text = utterances[at?.utterance ?? -1]?.text;
      return at !== null && text !== undefined && at.char >= 0 && at.char < text.length && timeAt(line, at) >= 0;
    }),
  );
  // Unit 1 begins at character 21 of passage 0: a time just after that boundary must name
  // a character in the second unit.
  const boundary = chars(0) * RATE;
  assert("a time across a unit boundary names a character in the unit on the far side", (placeAt(line, boundary + 5 * RATE)?.char ?? 0) >= 21);
  assert("a time just short of the boundary stays in the near unit", (placeAt(line, boundary - RATE)?.char ?? 99) < 21);
}

// ── the landmarks ─────────────────────────────────────────────────────────────────────

console.log("landmarks and landmark: back and forward at every boundary");
{
  const RATE = 40;
  const line = timelineOfScript(recorded([0, 1, 2, 3, 4], (i) => chars(i) * RATE), utteranceOf, nothingBegun);
  const marks = landmarks(line);
  const g1 = timeAt(line, mark(2)) - GAP_MS;
  const g2 = timeAt(line, mark(3)) - GAP_MS;
  const at = (ms: number): Point => {
    const point = pointAt(line, ms);
    if (point === undefined) throw new Error("fixture: a timeline with nothing to say");
    return point;
  };
  assert("the top and each gap — one landmark per turn, not one per passage; the top a span of no length, a gap its whole self", marks.length === 3 && marks[0]?.startMs === 0 && marks[0].endMs === 0 && marks[1]?.startMs === g1 && marks[1].endMs === g1 + GAP_MS && marks[2]?.startMs === g2);
  assert("mid-turn in the first turn, back is the top", landmark(marks, at(timeAt(line, mark(0, 30))), -1) === 0);
  assert("mid-turn, forward is the gap before the next turn", landmark(marks, at(timeAt(line, mark(0, 30))), 1) === g1);
  // A `unit` alignment puts every mark at its leg's start, the gap's own end; the reader
  // in speech is a little past it.
  assert("from speech in the second turn, back lands at the gap's start", landmark(marks, at(timeAt(line, mark(2, 4)) + 10), -1) === g1);
  assert("from inside that gap, back again reaches the landmark before it: the double tap", landmark(marks, at(g1 + GAP_MS / 2), -1) === 0);
  assert("standing exactly at a gap's start, back is the landmark before it", landmark(marks, at(g1), -1) === 0);
  assert("standing exactly at a gap's start, forward is the next gap", landmark(marks, at(g1), 1) === g2);
  assert("standing exactly at a gap's end, the turn has begun: back is that gap", landmark(marks, at(g1 + GAP_MS), -1) === g1);
  assert("one step past a gap's end, the gap is behind: back is that gap", landmark(marks, at(g1 + GAP_MS + 1), -1) === g1);
  assert("from inside a gap, forward is the gap after the turn it leads to", landmark(marks, at(g1 + GAP_MS / 2), 1) === g2);
  assert("from inside the last turn, forward is nothing", landmark(marks, at(timeAt(line, mark(3, 5))), 1) === null);
  assert("from the last turn, back is the gap before it, and back again the gap before that", landmark(marks, at(timeAt(line, mark(3, 5)) + 10), -1) === g2 && landmark(marks, at(g2), -1) === g1);
  assert("at the top there is nothing before", landmark(marks, at(0), -1) === null);
  assert("a later passage of the same turn still belongs to that turn", landmark(marks, at(timeAt(line, mark(1, 3))), -1) === 0);
    // A unit streaming past its guessed length holds the voice's clock at its segment's end,
  // the very time the gap after it begins; the voice knows it is still in the speech.
  const ending = line.segments.find((segment) => segment.content.kind === "speech" && segment.startMs + segment.ms === g1);
  if (ending === undefined) throw new Error("fixture: no speech ends where the first gap begins");
  assert("held at a speech segment's end, forward is the gap that end touches, not the gap after it", landmark(marks, { atMs: g1, segment: ending }, 1) === g1);
  assert("held there, back is the landmark before the turn", landmark(marks, { atMs: g1, segment: ending }, -1) === 0);
  const turnTwo = line.segments.find((segment) => segment.startMs === g1 + GAP_MS);
  if (turnTwo === undefined) throw new Error("fixture: no speech begins where the first gap ends");
  assert("a place partway into a guessed passage reads as its start, and back from it is the gap before its turn", landmark(marks, { atMs: turnTwo.startMs, segment: turnTwo }, -1) === g1);
  const opening = line.segments[0];
  if (opening === undefined) throw new Error("fixture: no first segment");
  assert("at the first passage's start there is nothing before, the voice's point or a place's", landmark(marks, { atMs: 0, segment: opening }, -1) === null);
  const inGap = startAt(line, g1 + 100);
  assert("a time inside a gap names the gap itself, by the turn it leads into and the offset into it", inGap?.kind === "silence" && inGap.before.utterance === mark(2).utterance && inGap.offsetMs === 100);
  assert("that start falls back on the clock exactly where it was named", inGap !== null && timeOfStart(line, inGap) === g1 + 100);
  const inSpeech = startAt(line, timeAt(line, mark(2, 4)));
  assert("a time in speech names a place, and falls back at that place's time", inSpeech?.kind === "speech" && timeOfStart(line, inSpeech) === timeAt(line, mark(2, 4)));
  throws("a gap named before a turn with no gap before it is a start from another page", () => timeOfStart(line, { kind: "silence", before: mark(1), offsetMs: 0 }));
  assert("a bare time at a boundary is in the segment that begins there", at(g1).segment.content.kind === "silence" && at(g1 + GAP_MS).segment.content.kind === "speech");
  assert("a conversation with no passages has no landmarks", landmarks(timelineOfUtterances([])).length === 0);
  assert("the page's own clock has the same landmarks as the voice's, before anything is measured", (() => {
    const page = landmarks(timelineOfUtterances(utterances));
    const voice = landmarks(timelineOfScript(emptyManifest(script), utteranceOf, nothingBegun));
    return page.length === voice.length && page[0]?.startMs === voice[0]?.startMs;
  })());
}

// ── the edges ─────────────────────────────────────────────────────────────────────────

console.log("the edges: nothing to say, and a span that says nothing");
{
  const empty = timelineOfUtterances([]);
  assert("a conversation with nothing to say has no clock, names no place and paints nothing", empty.totalMs === 0 && timeAt(empty, mark(0)) === 0 && placeAt(empty, 0) === null && cursorAt(empty, 0) === null && !estimated(empty, 0));
  throws("a unit covering no characters is a bug in whoever cut the text", () => timelineOfScript(emptyManifest([unit(one, 5, 5)]), [0], nothingBegun));
  assert(
    "every unit measured at nothing is a clock of the gaps alone: the measurements are believed",
    timelineOfScript(recorded([0, 1, 2, 3, 4], () => 0), utteranceOf, nothingBegun).totalMs === 2 * GAP_MS,
  );
  assert(
    "but a zero measurement does not collapse the tail it cannot speak for: the unmeasured legs take the default rate",
    (() => {
      const line = timelineOfScript(recorded([0], () => 0), utteranceOf, nothingBegun);
      const tail = speechSegments(line).slice(1);
      return line.segments[0]?.ms === 0 && tail.every((leg) => near(leg.ms, (leg.content.charEnd - leg.content.charStart) * DEFAULT_MS_PER_CHAR));
    })(),
  );
}

console.log("clockText: the time as a listener reads it");
{
  assert("under a minute", clockText(0) === "0:00" && clockText(4400) === "0:04" && clockText(59_400) === "0:59");
  assert("minutes and seconds", clockText(65_000) === "1:05" && clockText(600_000) === "10:00");
  assert("hours, with padded minutes", clockText(3_723_000) === "1:02:03");
  assert("a negative time reads as zero rather than a minus sign on a clock", clockText(-500) === "0:00");
}
