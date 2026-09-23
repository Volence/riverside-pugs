/** Pure statistics for comparing two groups of patches. Everything here is
 *  deterministic given a seeded random source, so a comparison is reproducible. */

export const REAL_MIN_MATCHES = 10;
export const NOISE_MIN_MATCHES = 30;
export const FDR = 0.1;
export const REPS = 1000;
export const SEED = 20260923;
const Z95 = 1.96;

/** mulberry32: small, seedable, good enough for a bootstrap. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export type MapSums = { num: number; den: number };
/** One match's totals for one metric and phase, per map. */
export type MatchSample = Map<string, MapSums>;

function totalsByMap(side: MatchSample[]): Map<string, MapSums> {
  const out = new Map<string, MapSums>();
  for (const s of side) for (const [map, v] of s) {
    const t = out.get(map) ?? { num: 0, den: 0 };
    t.num += v.num; t.den += v.den;
    out.set(map, t);
  }
  return out;
}

export function sharedMaps(a: MatchSample[], b: MatchSample[]): { shared: string[]; excluded: string[] } {
  const ta = totalsByMap(a), tb = totalsByMap(b);
  const has = (t: Map<string, MapSums>, k: string) => (t.get(k)?.den ?? 0) > 0;
  const all = [...new Set([...ta.keys(), ...tb.keys()])].sort();
  return {
    shared: all.filter((k) => has(ta, k) && has(tb, k)),
    excluded: all.filter((k) => has(ta, k) !== has(tb, k)),
  };
}

/** Side A's share of the denominator on each shared map. */
export function mapWeights(a: MatchSample[], shared: string[]): Map<string, number> {
  const ta = totalsByMap(a);
  const total = shared.reduce((s, k) => s + (ta.get(k)?.den ?? 0), 0);
  return new Map(shared.map((k) => [k, total > 0 ? (ta.get(k)?.den ?? 0) / total : 0]));
}

/** Per-map rate combined with fixed weights; maps a sample lacks are dropped
 *  and the remaining weights renormalized. Null when no weighted map has data. */
export function weightedValue(side: MatchSample[], weights: Map<string, number>): number | null {
  const t = totalsByMap(side);
  let v = 0, wsum = 0;
  for (const [map, w] of weights) {
    const s = t.get(map);
    if (!s || s.den <= 0 || w <= 0) continue;
    v += w * (s.num / s.den);
    wsum += w;
  }
  return wsum > 0 ? v / wsum : null;
}

/** Paired B-minus-A rate, weighted, over only the maps with data on BOTH
 *  sides of this replicate. This avoids the bias weightedValue's separate
 *  per-side renormalization introduces when one side drops a map from a
 *  resample and the other does not: null when no map qualifies. */
export function weightedDiff(a: MatchSample[], b: MatchSample[], weights: Map<string, number>): number | null {
  const ta = totalsByMap(a), tb = totalsByMap(b);
  let v = 0, wsum = 0;
  for (const [map, w] of weights) {
    const sa = ta.get(map), sb = tb.get(map);
    if (!sa || !sb || sa.den <= 0 || sb.den <= 0 || w <= 0) continue;
    v += w * (sb.num / sb.den - sa.num / sa.den);
    wsum += w;
  }
  return wsum > 0 ? v / wsum : null;
}

function resample(side: MatchSample[], rand: () => number): MatchSample[] {
  const out: MatchSample[] = new Array(side.length);
  for (let i = 0; i < side.length; i++) out[i] = side[Math.floor(rand() * side.length)];
  return out;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
}

/** Bootstrap of B minus A by resampling whole matches on each side. Uses the
 *  paired weightedDiff (not weightedValue(b) - weightedValue(a)) for every
 *  replicate so a map dropped from one side's resample but not the other's
 *  cannot bias the difference. seA/seB are each side's own replicate spread,
 *  used by matchesNeeded to see how much of the uncertainty A already fixes. */
export function bootstrapDiff(a: MatchSample[], b: MatchSample[], weights: Map<string, number>,
  reps: number, rand: () => number): { lo: number; hi: number; p: number; se: number; seA: number; seB: number } | null {
  if (a.length === 0 || b.length === 0) return null;
  const diffs: number[] = [];
  const vas: number[] = [];
  const vbs: number[] = [];
  for (let r = 0; r < reps; r++) {
    const ra = resample(a, rand);
    const rb = resample(b, rand);
    const va = weightedValue(ra, weights);
    const vb = weightedValue(rb, weights);
    if (va !== null) vas.push(va);
    if (vb !== null) vbs.push(vb);
    const d = weightedDiff(ra, rb, weights);
    if (d !== null) diffs.push(d);
  }
  if (diffs.length < 2) return null;
  diffs.sort((x, y) => x - y);
  const le = diffs.filter((d) => d <= 0).length / diffs.length;
  const ge = diffs.filter((d) => d >= 0).length / diffs.length;
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const se = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (diffs.length - 1));
  const p = Math.max(1 / (reps + 1), Math.min(1, 2 * Math.min(le, ge)));
  return { lo: quantile(diffs, 0.025), hi: quantile(diffs, 0.975), p, se, seA: stdev(vas), seB: stdev(vbs) };
}

/** Which p-values survive Benjamini-Hochberg at false discovery rate q. */
export function benjaminiHochberg(ps: (number | null)[], q: number): boolean[] {
  const idx = ps.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => x.p !== null)
    .sort((x, y) => x.p - y.p);
  const m = idx.length;
  let cut = -1;
  idx.forEach((x, k) => { if (x.p <= ((k + 1) / m) * q) cut = k; });
  const out = ps.map(() => false);
  for (let k = 0; k <= cut; k++) out[idx[k].i] = true;
  return out;
}

/** Extra matches for side B alone (the newer patch) for the difference to
 *  clear a 95% interval, holding side A's match count fixed. Side A's own
 *  replicate variance (seA) already contributes a fixed amount to the target
 *  variance; only the leftover budget can be paid down by adding B matches,
 *  which is assumed to shrink B's variance with the square root of its
 *  sample. Null when the diff is zero or seA alone already meets or exceeds
 *  the target, meaning no amount of additional B matches can settle it. */
export function matchesNeeded(diff: number, seA: number, seB: number, nB: number): number | null {
  if (diff === 0) return null;
  const target = (Math.abs(diff) / Z95) ** 2;
  if (seA * seA >= target) return null;
  const nBPrime = (nB * seB * seB) / (target - seA * seA);
  return Math.max(1, Math.ceil(nBPrime - nB));
}

export type Verdict = 'real' | 'too_early' | 'noise' | 'no_data';

export function verdictOf(o: { hasData: boolean; significant: boolean; nA: number; nB: number }): Verdict {
  if (!o.hasData) return 'no_data';
  if (o.significant && o.nA >= REAL_MIN_MATCHES && o.nB >= REAL_MIN_MATCHES) return 'real';
  if (!o.significant && o.nA >= NOISE_MIN_MATCHES && o.nB >= NOISE_MIN_MATCHES) return 'noise';
  return 'too_early';
}
