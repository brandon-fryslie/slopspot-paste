// The conversation's timeline: where a mark falls on the clock, which mark a time names,
// where the turns begin, and which part of the clock is a measurement rather than a guess
// (slopspot-read-along-a35.3). Run: `tsx scripts/timeline-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is the contract the transport drives: that
// a scrubber position lands in the passage the reader aimed at, that the round trip through
// a mark is stable, that a measured leg is the worker's own duration and an unmeasured one
// the measured rate's share, and that "about" appears over exactly the guesses. Pure over
// values, no mocks of anything [LAW:effects-at-boundaries].

import type { Mark } from "../src/performer";
import type { Utterance } from "../src/speech";
import { addUnit, emptyManifest, type Manifest, type UnitReport } from "../src/speechManifest";
import type { SynthesisUnit } from "../src/speechScript";
import {
  clockText,
  DEFAULT_MS_PER_CHAR,
  estimated,
  markAt,
  timeAt,
  timelineOfScript,
  timelineOfUtterances,
  turnMark,
  turnStarts,
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
const recorded = (indices: ReadonlyArray<number>, ms: (index: number) => number): Manifest =>
  indices.reduce((manifest, index) => {
    const added = addUnit(manifest, index, report(ms(index)));
    if (added.kind !== "added") throw new Error(`fixture: unit ${index} was ${added.kind}`);
    return added.manifest;
  }, emptyManifest(script));

const chars = (unitIndex: number): number => {
  const u = script[unitIndex];
  if (u === undefined) throw new Error(`fixture: no unit ${unitIndex}`);
  return u.end - u.start;
};
const mark = (utterance: number, char = 0): Mark => ({ utterance, char });
const legsOf = (timeline: Timeline): string => timeline.legs.map((leg) => `${leg.utterance}:${leg.charStart}-${leg.charEnd}${leg.kind === "measured" ? "m" : "e"}`).join();

// ── the stand-in's clock: every leg a guess ───────────────────────────────────────────

console.log("timelineOfUtterances: one leg per passage, the whole thing an estimate");
{
  const line = timelineOfUtterances(utterances);
  assert("a leg per passage, each covering its whole text, all estimated", legsOf(line) === "0:0-42e,1:0-27e,2:0-8e,3:0-25e");
  const text = utterances.reduce((sum, u) => sum + u.text.length, 0);
  assert("the length is every character at the default rate", line.totalMs === text * DEFAULT_MS_PER_CHAR);
  assert("the first mark is at zero and the passages run in order", timeAt(line, mark(0)) === 0 && [1, 2, 3].every((u) => timeAt(line, mark(u)) > timeAt(line, mark(u - 1))));
  assert("a character halfway through a passage is halfway through its leg", Math.round(timeAt(line, mark(2, 4))) === Math.round(timeAt(line, mark(2)) + (4 / 8) * 8 * DEFAULT_MS_PER_CHAR));
  assert("the whole clock is a guess, so the time remaining is 'about' wherever the voice is", [0, line.totalMs / 2].every((ms) => estimated(line, ms)));
  assert("at the very end there is nothing left to guess about: 0:00 left is exact", !estimated(line, line.totalMs));
}

// ── the neural voice's clock: measured where the worker has finished ──────────────────

console.log("timelineOfScript: measured legs are the worker's, the rest its own rate's share");
{
  // Unit 0 measured at 40 ms a character, which is faster than the default.
  const RATE = 40;
  const partly = timelineOfScript(recorded([0], (i) => chars(i) * RATE), utteranceOf);
  assert("the measured unit is a measured leg; the rest are estimates", legsOf(partly) === "0:0-20m,0:21-42e,1:0-27e,2:0-8e,3:0-25e");
  const first = partly.legs[0];
  assert("the measured leg carries the worker's own duration", first?.ms === chars(0) * RATE);
  const second = partly.legs[1];
  assert(
    "an unmeasured leg takes the MEASURED rate's share, not the default's",
    second?.ms === chars(1) * RATE && chars(1) * RATE !== chars(1) * DEFAULT_MS_PER_CHAR,
  );
  assert("the passage a leg says is the PAGE's utterance, from the performer's table", partly.legs.map((leg) => leg.utterance).join() === utteranceOf.join());

  const whole = timelineOfScript(recorded([0, 1, 2, 3, 4], (i) => chars(i) * RATE), utteranceOf);
  assert("with everything measured the clock is the sum of the durations", whole.totalMs === script.reduce((sum, u) => sum + (u.end - u.start) * RATE, 0));
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
  throws("a mark naming a passage no leg says is a bug, not someone else's passage", () => timeAt(whole, mark(9)));
}

// ── the scrubber's round trip ─────────────────────────────────────────────────────────

console.log("markAt: a time on the clock names a place in the text");
{
  const RATE = 40;
  const line = timelineOfScript(recorded([0, 1, 2, 3, 4], (i) => chars(i) * RATE), utteranceOf);
  const round = (ms: number): number => {
    const at = markAt(line, ms);
    if (at === null) throw new Error("fixture: the clock named no mark");
    return timeAt(line, at);
  };
  const perChar = RATE;
  assert(
    "a time comes back as a mark within one character of itself, everywhere on the clock",
    Array.from({ length: 40 }, (_, i) => (line.totalMs * i) / 39).every((ms) => Math.abs(round(ms) - Math.min(ms, line.totalMs)) <= perChar),
  );
  assert("before the start is the start", markAt(line, -5000)?.utterance === 0 && markAt(line, -5000)?.char === 0);
  const end = markAt(line, line.totalMs + 60_000);
  const last = line.legs.at(-1);
  assert("past the end is the last character of the last leg, never past it", end?.utterance === 3 && last !== undefined && end?.char === last.charEnd - 1);
  assert(
    "every mark the clock can name is a character INSIDE its passage — what a performer's door requires",
    Array.from({ length: 200 }, (_, i) => (line.totalMs * i) / 199).every((ms) => {
      const at = markAt(line, ms);
      const text = utterances[at?.utterance ?? -1]?.text;
      return at !== null && text !== undefined && at.char >= 0 && at.char < text.length;
    }),
  );
  // Unit 1 begins at character 21 of passage 0: a drag to just after that boundary must
  // land in the second unit, which is the acceptance criterion the ticket names.
  const boundary = chars(0) * RATE;
  assert(
    "a drag across a unit boundary lands in the unit on the far side, at its own offset",
    (() => {
      const just = markAt(line, boundary + 5 * perChar);
      return just?.utterance === 0 && just.char >= 21 && just.char < 42;
    })(),
  );
  assert("a drag just short of the boundary stays in the near unit", (markAt(line, boundary - perChar)?.char ?? 99) < 21);
}

// ── the turns ─────────────────────────────────────────────────────────────────────────

console.log("turnStarts and turnMark: the landmarks a skip lands on");
{
  const turns = turnStarts(utterances);
  assert("one landmark per turn, at its first passage — not one per passage", turns.map((t) => t.utterance).join() === "0,2,3");
  assert("mid-turn, back is the start of the turn the reader is IN", turnMark(turns, mark(0, 30), -1)?.utterance === 0);
  assert("mid-turn, forward is the next turn", turnMark(turns, mark(0, 30), 1)?.utterance === 2);
  assert("at a turn's own start, back is the PREVIOUS turn", turnMark(turns, mark(2, 0), -1)?.utterance === 0);
  assert("a later passage of the same turn still belongs to that turn", turnMark(turns, mark(1, 3), -1)?.utterance === 0);
  assert("there is nothing before the first turn", turnMark(turns, mark(0, 0), -1) === null);
  assert("there is nothing after the last turn", turnMark(turns, mark(3, 2), 1) === null);
  assert("a conversation with no passages has no landmarks", turnStarts([]).length === 0);
}

// ── the edges ─────────────────────────────────────────────────────────────────────────

console.log("the edges: nothing to say, and a span that says nothing");
{
  const empty = timelineOfUtterances([]);
  assert("a conversation with nothing to say has no clock and names no mark", empty.totalMs === 0 && timeAt(empty, mark(0)) === 0 && markAt(empty, 0) === null && !estimated(empty, 0));
  throws("a unit covering no characters is a bug in whoever cut the text", () => timelineOfScript(emptyManifest([unit(one, 5, 5)]), [0]));
  assert(
    "every unit measured at nothing is a clock of nothing: the measurements are believed",
    timelineOfScript(recorded([0, 1, 2, 3, 4], () => 0), utteranceOf).totalMs === 0,
  );
  assert(
    "but a zero measurement does not collapse the tail it cannot speak for: the unmeasured legs take the default rate",
    (() => {
      const line = timelineOfScript(recorded([0], () => 0), utteranceOf);
      const tail = line.legs.slice(1);
      return line.legs[0]?.ms === 0 && tail.every((leg, i) => leg.ms === (leg.charEnd - leg.charStart) * DEFAULT_MS_PER_CHAR && tail[i] !== undefined);
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
