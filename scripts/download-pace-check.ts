// The download's pace and the estimate the status line reads from it
// (slopspot-read-along-a35.171). Run: `tsx scripts/download-pace-check.ts`.
//
// Time is a number the check advances by hand [LAW:no-ambient-temporal-coupling]: a steady
// link converges on the true remaining time; a stall widens the estimate rather than
// freezing it; a burst is folded in and converges; too few samples say `estimating`; the
// readout strings never say zero. Every expected value is stated as the arithmetic a reader
// can redo [LAW:verifiable-goals].

import { begin, estimate, record, remainingText, type Estimate, type Pace, type Sample } from "../src/downloadPace";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const TOTAL = 240_000_000;
const MB_PER_S = 1_000_000;

const seconds = (e: Estimate): number => (e.kind === "remaining" ? e.seconds : Number.NaN);
const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;
const run = (samples: ReadonlyArray<Sample>): Pace => {
  const [first, ...rest] = samples;
  if (first === undefined) throw new Error("no samples");
  return rest.reduce(record, begin(first));
};
// A link delivering `rate` bytes per second, sampled every 250 ms from `from` for `spanS`
// seconds, starting at `bytes`.
const steady = (from: Sample, rate: number, spanS: number): Sample[] =>
  Array.from({ length: spanS * 4 }, (_, i) => ({ at: from.at + 250 * (i + 1), bytes: from.bytes + (rate * (i + 1)) / 4 }));

console.log("estimate: a steady link");
{
  const first: Sample = { at: 1_000, bytes: 0 };
  assert("one sample: estimating", estimate(begin(first), TOTAL).kind === "estimating");
  const short = run([first, ...steady(first, MB_PER_S, 1)]);
  assert("a second of samples: still estimating (the least span is 1.5 s)", estimate(short, TOTAL).kind === "estimating");
  const steadied = run([first, ...steady(first, MB_PER_S, 10)]);
  // 10 s at 1 MB/s: 10 MB down, 230 MB to go at 1 MB/s = 230 s. The average is exact on a
  // constant rate, bias correction included.
  assert("ten seconds at 1 MB/s: 230 s left", near(seconds(estimate(steadied, TOTAL)), 230, 0.01));
  assert("the readout: about 4 min left", remainingText(estimate(steadied, TOTAL)) === "about 4 min left");
  const twice = run([first, ...steady(first, 2 * MB_PER_S, 10)]);
  assert("twice the rate: half the time", near(seconds(estimate(twice, TOTAL)), (TOTAL - 20_000_000) / (2 * MB_PER_S), 0.01));
}

console.log("estimate: a stall widens it, a burst converges it");
{
  const first: Sample = { at: 0, bytes: 0 };
  const before = run([first, ...steady(first, MB_PER_S, 10)]);
  const stalled = record(before, { at: 30_000, bytes: 10_010_000 });
  // 20 s for 10 KB: the stall's 0.5 KB/s carries all but e^(-20/3) of the average, so the
  // 1 MB/s before it is a rounding error and the 230 s left become tens of hours.
  assert("a 20 s stall for 10 KB widens the estimate past a hundred times", seconds(estimate(stalled, TOTAL)) > 100 * seconds(estimate(before, TOTAL)));
  assert("the readout widens with it, in hours", /^about \d\d h left$/.test(remainingText(estimate(stalled, TOTAL))));
  const recovered = run([first, ...steady(first, MB_PER_S, 10), { at: 30_000, bytes: 10_010_000 }, ...steady({ at: 30_000, bytes: 10_010_000 }, MB_PER_S, 15)]);
  // 15 s of steady link after the stall: the stall's weight has decayed to e^-5 of what it
  // was, and the estimate is within a few percent of the true 215 s.
  assert("fifteen steady seconds later the estimate has converged", near(seconds(estimate(recovered, TOTAL)), (TOTAL - 25_010_000) / MB_PER_S, 8));
  const burst = run([first, ...steady(first, MB_PER_S, 10), ...steady({ at: 10_000, bytes: 10_000_000 }, 5 * MB_PER_S, 1)]);
  // One second at 5 MB/s after ten at 1 MB/s: the estimate falls, but not to the burst's
  // own 45 s — the average remembers the slower link.
  const burstS = seconds(estimate(burst, TOTAL));
  assert("a one-second burst lowers the estimate without adopting its rate", burstS < 225 && burstS > 60);
  const sustained = run([first, ...steady(first, MB_PER_S, 10), ...steady({ at: 10_000, bytes: 10_000_000 }, 5 * MB_PER_S, 15)]);
  assert("a sustained burst converges on its rate", near(seconds(estimate(sustained, TOTAL)), (TOTAL - 85_000_000) / (5 * MB_PER_S), 1));
}

console.log("record: samples fold, the estimate never runs backwards");
{
  const first: Sample = { at: 0, bytes: 0 };
  const kept = record(begin(first), { at: 50, bytes: 4_096 });
  assert("a sample within the step is folded, not kept", kept.at === 0 && kept.bytes === 0);
  const later = record(kept, { at: 500, bytes: 500_000 });
  assert("the next kept sample counts the folded bytes from the last kept one", later.at === 500 && later.bytes === 500_000);
  const noBytes = run([first, { at: 2_000, bytes: 0 }]);
  assert("a span with no bytes: estimating, not infinity", estimate(noBytes, TOTAL).kind === "estimating");
  const done = run([first, ...steady(first, MB_PER_S, 240)]);
  assert("the last byte short of the total: a few seconds, never zero or negative", seconds(estimate(record(done, { at: 240_250, bytes: TOTAL - 1 }), TOTAL)) > 0 && remainingText(estimate(record(done, { at: 240_250, bytes: TOTAL - 1 }), TOTAL)) === "a few seconds left");
}

console.log("remainingText: the words for every span");
{
  const at = (seconds: number): string => remainingText({ kind: "remaining", seconds });
  assert("estimating", remainingText({ kind: "estimating" }) === "estimating time left…");
  assert("hours from 90 min", at(5400) === "about 2 h left" && at(3600 * 3.4) === "about 3 h left");
  assert("minutes from 90 s to 90 min", at(90) === "about 2 min left" && at(150) === "about 3 min left" && at(5399) === "about 90 min left");
  assert("tens of seconds from 10 s", at(10) === "about 10 s left" && at(44) === "about 40 s left" && at(89) === "about 90 s left");
  assert("under ten seconds: a few, never zero", at(9.9) === "a few seconds left" && at(0.01) === "a few seconds left");
}
