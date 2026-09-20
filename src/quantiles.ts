/**
 * Quantiles over a sample of numbers. The only place the formula lives.
 *
 * Every stat surface on the site reported a sum, or a mean of sums, which
 * answers "who has played the most" rather than "what does this player usually
 * get". A median answers the second question and a season total cannot, because
 * one enormous night moves a total and a mean by the same amount and moves a
 * median hardly at all.
 *
 * Pure, and deliberately free of any database import: the read models decide
 * what a sample is, this decides nothing but the arithmetic.
 */

/** A sample's shape. `n` travels with the numbers because none of them mean
 *  anything without it: a median over three matches and a median over forty
 *  read identically and are not the same claim. Every caller is expected to
 *  show it. */
export interface Quantiles {
  n: number;
  p25: number;
  p50: number;
  p75: number;
}

/**
 * The 25th, 50th and 75th percentiles of `values`, or null for an empty sample.
 *
 * Null rather than zeros: an absent statistic must never arrive at a page as a
 * zero, which would read as "did this badly" instead of "was never measured".
 * That is the rule the rest of the stats path already follows.
 *
 * Linear interpolation between order statistics (the R-7 default, and numpy's),
 * one formula for all three rather than a median by one rule and hinges by
 * another. Rounded to one decimal, matching perMapAverages in playerStats.ts.
 *
 * The input is not mutated: a caller's array is usually the accumulator it is
 * still filling.
 */
export function quantiles(values: number[]): Quantiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p25: quantileOf(sorted, 0.25),
    p50: quantileOf(sorted, 0.5),
    p75: quantileOf(sorted, 0.75),
  };
}

/**
 * One arbitrary percentile, for the callers that want a cut `quantiles` does
 * not carry (a p90, say). Null for an empty sample, on the same rule.
 *
 * `p` is a fraction, not a percentage: 0.9, never 90. Same formula as
 * `quantiles`, which is the point of it living here rather than being open
 * coded at the call site.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  return quantileOf([...values].sort((a, b) => a - b), p);
}

/** One quantile of an already sorted, non-empty sample. */
function quantileOf(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const value = sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  return Math.round(value * 10) / 10;
}
