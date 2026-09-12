// How fast the model's bytes are arriving, and how long the rest will take
// (slopspot-read-along-a35.171). A pure record over the (time, bytes) samples the loader's
// progress messages become once the driver stamps their arrival: the clock is the
// caller's, so the check drives time by hand [LAW:effects-at-boundaries]
// [LAW:no-ambient-temporal-coupling].
//
// The rate is an exponential moving average over time, not over samples: a sample's
// weight is what its own span earns, so a stall — a long gap, few bytes — pulls the rate
// down as hard as the gap was long and the estimate widens, and a burst is folded in at
// the same pace, so the estimate converges rather than jumps. The average is
// bias-corrected: divided by the weight the whole span since the first sample has earned,
// so it is exact from the second sample on instead of starting near zero. Samples closer
// than a step fold into the next one kept — their bytes count from the last one kept, so
// nothing is lost, and a burst of chunks in one tick does not swing the rate
// [LAW:one-source-of-truth].
//
// The estimate is `estimating` until the pace has seen enough of the download to speak, and
// when no byte arrived over what it saw; it is never negative (the bytes are short of the
// total by construction) and `remainingText` never rounds it to zero.

export interface Sample {
  // Milliseconds on the caller's clock; only differences are read.
  readonly at: number;
  readonly bytes: number;
}

export interface Pace {
  readonly since: number;
  readonly at: number;
  readonly bytes: number;
  // The unnormalized average, in bytes per millisecond; `rate` divides the bias out.
  readonly ema: number;
}

// The memory of the average, the least gap between samples kept, and the least span the
// estimate speaks from.
const TAU_MS = 3_000;
const STEP_MS = 100;
const SPEAK_MS = 1_500;

const weight = (spanMs: number): number => 1 - Math.exp(-spanMs / TAU_MS);

export const begin = (sample: Sample): Pace => ({ since: sample.at, at: sample.at, bytes: sample.bytes, ema: 0 });

export const record = (pace: Pace, sample: Sample): Pace => {
  const spanMs = sample.at - pace.at;
  if (spanMs < STEP_MS) return pace;
  const seen = (sample.bytes - pace.bytes) / spanMs;
  return { since: pace.since, at: sample.at, bytes: sample.bytes, ema: pace.ema + weight(spanMs) * (seen - pace.ema) };
};

export type Estimate = { readonly kind: "estimating" } | { readonly kind: "remaining"; readonly seconds: number };

const ESTIMATING: Estimate = { kind: "estimating" };

export const estimate = (pace: Pace, totalBytes: number): Estimate => {
  const spanMs = pace.at - pace.since;
  if (spanMs < SPEAK_MS) return ESTIMATING;
  const rate = pace.ema / weight(spanMs);
  if (rate <= 0) return ESTIMATING;
  return { kind: "remaining", seconds: (totalBytes - pace.bytes) / rate / 1000 };
};

// The estimate as the status line says it: coarse on purpose, since the number is a guess,
// and never a zero that is not the end.
export const remainingText = (estimate: Estimate): string => {
  if (estimate.kind === "estimating") return "estimating time left…";
  const { seconds } = estimate;
  if (seconds >= 5400) return `about ${Math.round(seconds / 3600)} h left`;
  if (seconds >= 90) return `about ${Math.round(seconds / 60)} min left`;
  if (seconds >= 10) return `about ${Math.round(seconds / 10) * 10} s left`;
  return "a few seconds left";
};
