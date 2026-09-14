// The conversation's timeline: the gaps between speakers as silence legs, where a mark
// falls on the clock, what a time names and what it paints, the landmarks a skip lands
// on, and which part of the clock is a measurement rather than a guess
// (slopspot-read-along-a35.3, slopspot-read-along-a35.1ni). Run: `tsx scripts/timeline-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is the contract the transport drives: that
// exactly one silence leg of GAP_MS sits between consecutive turns and none before the
// first, that a time inside a gap paints nothing and names the turn about to begin, that
// back and forward over the landmarks behave at every boundary, that a measured leg is the
// worker's own duration and an unmeasured one the measured rate's share, and that "about"
// appears over exactly the guesses. Pure over values, no mocks of anything
// [LAW:effects-at-boundaries].

import type { Mark } from "../src/performer";
import type { Utterance } from "../src/speech";
import { addUnit, emptyManifest, type Manifest, type UnitReport } from "../src/speechManifest";
import type { SynthesisUnit } from "../src/speechScript";
import {
  clockText,
  DEFAULT_MS_PER_CHAR,
  estimated,
  GAP_MS,
  landmark,
  landmarks,
  leadsOf,
  markAt,
  speechLegs,
  spotAt,
  timeAt,
  timelineOfScript,
  timelineOfUtterances,
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
const one: Utterance = { index: 1, anchor: "t1", voice: "user", text: "First sentence here. Second sentence here." };
const two: Utterance = { index: 1, anchor: "t1", voice: "narrator", text: "python code block, 2 lines." };
const three: Utterance = { index: 2, anchor: "t2", voice: "assistant", text: "A reply." };
const four: Utterance = { index: 3, anchor: "t3", voice: "user", text: "And a follow-up question." };
const utterances = [one, two, three, four];

const unit = (utterance: Utterance, start: number, end: number): SynthesisUnit => ({ utterance, start, end, text: utterance.text.slice(start, end) });
const script: SynthesisUnit[] = [unit(one, 0, 20), unit(one, 21, 42), unit(two, 0, 27), unit(three, 0, 8), unit(four, 0, 25)];
const utteranceOf = [0, 0, 1, 2, 3];

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
const mark = (utterance: number, char = 0): Mark => ({ utterance, char });
// Each leg as "utterance:chars" with m/e for measured/estimated, or "gap" for silence.
const legsOf = (timeline: Timeline): string =>
  timeline.legs
    .map((leg) => (leg.content.kind === "silence" ? `gap${leg.ms}` : `${leg.content.utterance}:${leg.content.charStart}-${leg.content.charEnd}${leg.content.alignment === null ? "e" : "m"}`))
    .join();
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

// ── the gap rule ──────────────────────────────────────────────────────────────────────

console.log("leadsOf: a gap before every change of speaker, none before the first");
{
  assert("one rule over the anchors", leadsOf(["a", "a", "b", "c", "c"]).join() === `0,0,${GAP_MS},${GAP_MS},0`);
  assert("a single speaker has no gap anywhere", leadsOf(["a", "a", "a"]).join() === "0,0,0");
  assert("nobody speaking has no lead", leadsOf([]).length === 0);
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
  assert("a paste with one turn has no silence leg", timelineOfUtterances([one, two]).legs.every((leg) => leg.content.kind === "speech"));
}

// ── the neural voice's clock: measured where the worker has finished ──────────────────

console.log("timelineOfScript: measured legs are the worker's, the rest its own rate's share, the gaps by rule");
{
  // Unit 0 measured at 40 ms a character, which is faster than the default.
  const RATE = 40;
  const partly = timelineOfScript(recorded([0], (i) => chars(i) * RATE), utteranceOf);
  assert("the measured unit is a measured leg; the rest are estimates; the gaps sit before units 3 and 4", legsOf(partly) === `0:0-20m,0:21-42e,1:0-27e,gap${GAP_MS},2:0-8m`.replace("2:0-8m", "2:0-8e") + `,gap${GAP_MS},3:0-25e`);
  const first = partly.legs[0];
  assert("the measured leg carries the worker's own duration", first?.ms === chars(0) * RATE);
  const second = partly.legs[1];
  assert(
    "an unmeasured leg takes the MEASURED rate's share, not the default's",
    second?.ms === chars(1) * RATE && chars(1) * RATE !== chars(1) * DEFAULT_MS_PER_CHAR,
  );
  assert("the passage a leg says is the PAGE's utterance, from the performer's table", speechLegs(partly).map((leg) => leg.content.utterance).join() === utteranceOf.join());
  assert("the speech legs are the units in order: the performer's table from unit to leg", speechLegs(partly).map((leg) => leg.content.charStart).join() === script.map((u) => u.start).join());

  const whole = timelineOfScript(recorded([0, 1, 2, 3, 4], (i) => chars(i) * RATE), utteranceOf);
  assert("with everything measured the clock is the sum of the durations and the gaps", whole.totalMs === script.reduce((sum, u) => sum + (u.end - u.start) * RATE, 0) + 2 * GAP_MS);
  assert("nothing is a guess any more, so no time remaining says 'about'", [0, whole.totalMs / 2, whole.totalMs].every((ms) => !estimated(whole, ms)));
  assert(
    "'about' is scoped to what is still unmeasured: true before the gap, false after it",
    (() => {
      const gapped = timelineOfScript(recorded([0, 1, 2], (i) => chars(i) * RATE), utteranceOf);
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
  const worded = timelineOfScript(timed.manifest, utteranceOf);
  assert("a character inside a timed word resolves to when that word begins", timeAt(worded, mark(0, 8)) === 100 && timeAt(worded, mark(0, 17)) === 200 && timeAt(worded, mark(0, 3)) === 0);
  assert("the spot under a timed word is that word, inside the leg's segment", (() => {
    const spot = spotAt(worded, 150);
    return spot?.utterance === 0 && spot.segment.charStart === 0 && spot.segment.charEnd === 20 && spot.word?.charStart === 6 && spot.word.charEnd === 14;
  })());
}

// ── what a time names and paints ──────────────────────────────────────────────────────

console.log("markAt and spotAt: a time on the clock names a place, and paints it or nothing");
{
  const RATE = 40;
  const line = timelineOfScript(recorded([0, 1, 2, 3, 4], (i) => chars(i) * RATE), utteranceOf);
  const gapStart = timeAt(line, mark(1)) + chars(2) * RATE;
  const gapEnd = gapStart + GAP_MS;
  assert("the gap begins where the previous turn's audio ends, and the next turn begins at its end", timeAt(line, mark(2)) === gapEnd);
  assert("inside a gap: nothing to paint", spotAt(line, gapStart + GAP_MS / 2) === null && spotAt(line, gapStart) === null);
  assert("inside a gap: the place named is the turn about to begin", (() => {
    const named = markAt(line, gapStart + GAP_MS / 2);
    return named?.utterance === 2 && named.char === 0;
  })());
  assert("at the gap's end: the first character of the new turn, painted as its leg's segment", (() => {
    const spot = spotAt(line, gapEnd);
    const named = markAt(line, gapEnd);
    return spot?.utterance === 2 && spot.segment.charStart === 0 && spot.segment.charEnd === 8 && spot.word === null && named?.utterance === 2 && named.char === 0;
  })());
  assert("inside speech: the spot is the leg's segment and the name is the character under the time", (() => {
    const t = timeAt(line, mark(0, 21)) + 5 * RATE;
    const spot = spotAt(line, t);
    const named = markAt(line, t);
    return spot?.utterance === 0 && spot.segment.charStart === 21 && named?.utterance === 0 && named.char >= 21 && named.char < 42;
  })());
  assert("a time inside speech comes back as a character within one character of itself", (() => {
    const t = timeAt(line, mark(0, 21)) + 5 * RATE;
    const named = markAt(line, t);
    return named !== null && named.char === 21 + 5;
  })());
  assert("before the start is the start", markAt(line, -5000)?.utterance === 0 && markAt(line, -5000)?.char === 0 && spotAt(line, -5000)?.utterance === 0);
  const end = markAt(line, line.totalMs + 60_000);
  assert("past the end is the last character of the last leg, never past it", end?.utterance === 3 && end?.char === 24);
  assert(
    "every mark the clock can name is a character INSIDE its passage — what a mark's door requires",
    Array.from({ length: 200 }, (_, i) => (line.totalMs * i) / 199).every((ms) => {
      const at = markAt(line, ms);
      const text = utterances[at?.utterance ?? -1]?.text;
      return at !== null && text !== undefined && at.char >= 0 && at.char < text.length && timeAt(line, at) >= 0;
    }),
  );
  // Unit 1 begins at character 21 of passage 0: a time just after that boundary must name
  // a character in the second unit.
  const boundary = chars(0) * RATE;
  assert("a time across a unit boundary names a character in the unit on the far side", (markAt(line, boundary + 5 * RATE)?.char ?? 0) >= 21);
  assert("a time just short of the boundary stays in the near unit", (markAt(line, boundary - RATE)?.char ?? 99) < 21);
}

// ── the landmarks ─────────────────────────────────────────────────────────────────────

console.log("landmarks and landmark: back and forward at every boundary");
{
  const RATE = 40;
  const line = timelineOfScript(recorded([0, 1, 2, 3, 4], (i) => chars(i) * RATE), utteranceOf);
  const marks = landmarks(line);
  const g1 = timeAt(line, mark(2)) - GAP_MS;
  const g2 = timeAt(line, mark(3)) - GAP_MS;
  assert("the top and each gap — one landmark per turn, not one per passage; the top a span of no length, a gap its whole self", marks.length === 3 && marks[0]?.startMs === 0 && marks[0].endMs === 0 && marks[1]?.startMs === g1 && marks[1].endMs === g1 + GAP_MS && marks[2]?.startMs === g2);
  assert("mid-turn in the first turn, back is the top", landmark(marks, timeAt(line, mark(0, 30)), -1) === 0);
  assert("mid-turn, forward is the gap before the next turn", landmark(marks, timeAt(line, mark(0, 30)), 1) === g1);
  assert("from speech in the second turn, back lands at the gap's start", landmark(marks, timeAt(line, mark(2, 4)), -1) === g1);
  assert("from inside that gap, back again reaches the landmark before it: the double tap", landmark(marks, g1 + GAP_MS / 2, -1) === 0);
  assert("standing exactly at a gap's start, back is the landmark before it", landmark(marks, g1, -1) === 0);
  assert("standing exactly at a gap's start, forward is the next gap", landmark(marks, g1, 1) === g2);
  assert("standing exactly at a gap's end, the gap is wholly behind: back is that gap", landmark(marks, g1 + GAP_MS, -1) === g1);
  assert("from inside a gap, forward is the gap after the turn it leads to", landmark(marks, g1 + GAP_MS / 2, 1) === g2);
  assert("from inside the last turn, forward is nothing", landmark(marks, timeAt(line, mark(3, 5)), 1) === null);
  assert("from the last turn, back is the gap before it, and back again the gap before that", landmark(marks, timeAt(line, mark(3, 5)), -1) === g2 && landmark(marks, g2, -1) === g1);
  assert("at the top there is nothing before", landmark(marks, 0, -1) === null);
  assert("a later passage of the same turn still belongs to that turn", landmark(marks, timeAt(line, mark(1, 3)), -1) === 0);
  assert("a conversation with no passages has no landmarks", landmarks(timelineOfUtterances([])).length === 0);
  assert("the page's own clock has the same landmarks as the voice's, before anything is measured", (() => {
    const page = landmarks(timelineOfUtterances(utterances));
    const voice = landmarks(timelineOfScript(emptyManifest(script), utteranceOf));
    return page.length === voice.length && page[0]?.startMs === voice[0]?.startMs;
  })());
}

// ── the edges ─────────────────────────────────────────────────────────────────────────

console.log("the edges: nothing to say, and a span that says nothing");
{
  const empty = timelineOfUtterances([]);
  assert("a conversation with nothing to say has no clock, names no mark and paints nothing", empty.totalMs === 0 && timeAt(empty, mark(0)) === 0 && markAt(empty, 0) === null && spotAt(empty, 0) === null && !estimated(empty, 0));
  throws("a unit covering no characters is a bug in whoever cut the text", () => timelineOfScript(emptyManifest([unit(one, 5, 5)]), [0]));
  assert(
    "every unit measured at nothing is a clock of the gaps alone: the measurements are believed",
    timelineOfScript(recorded([0, 1, 2, 3, 4], () => 0), utteranceOf).totalMs === 2 * GAP_MS,
  );
  assert(
    "but a zero measurement does not collapse the tail it cannot speak for: the unmeasured legs take the default rate",
    (() => {
      const line = timelineOfScript(recorded([0], () => 0), utteranceOf);
      const tail = speechLegs(line).slice(1);
      return line.legs[0]?.ms === 0 && tail.every((leg) => near(leg.ms, (leg.content.charEnd - leg.content.charStart) * DEFAULT_MS_PER_CHAR));
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
