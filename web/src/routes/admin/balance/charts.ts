/** Pure geometry for the quick-check trend chart, kept apart from the
 *  component so the math is unit-tested without a DOM. */

/** Trailing mean with window `window`. The first entries average whatever is
 *  available (a window of 2 over [1, 2, 3, 4] gives [1, 1.5, 2.5, 3.5], not
 *  [NaN, 1.5, 2.5, 3.5]), so the line has a value at every point instead of a
 *  gap at the start. */
export function rolling(values: number[], window: number): number[] {
  return values.map((_, i) => {
    const from = Math.max(0, i - window + 1);
    const slice = values.slice(from, i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

/** Maps a list of {t, v} points onto a `w` by `h` viewport. Returns null with
 *  fewer than two points, since a single point has no time axis to scale
 *  against. `y` flips so larger values sit higher on the chart, and a flat
 *  series (every point equal) is centred rather than divided by zero. */
export function trendGeometry(
  points: { t: number; v: number }[],
  w: number,
  h: number,
  pad = 6,
): { x: (t: number) => number; y: (v: number) => number } | null {
  if (points.length < 2) return null;
  const ts = points.map((p) => p.t);
  const vs = points.map((p) => p.v);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const v0 = Math.min(...vs), v1 = Math.max(...vs);
  return {
    x: (t: number) => (t1 === t0 ? w / 2 : ((t - t0) / (t1 - t0)) * w),
    y: (v: number) => (v1 === v0 ? h / 2 : h - pad - ((v - v0) / (v1 - v0)) * (h - pad * 2)),
  };
}
