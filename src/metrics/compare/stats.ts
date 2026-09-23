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

function resample(side: MatchSample[], rand: () => number): MatchSample[] {
  const out: MatchSample[] = new Array(side.length);
  for (let i = 0; i < side.length; i++) out[i] = side[Math.floor(rand() * side.length)];
  return out;
}

/** Bootstrap of B minus A by resampling whole matches on each side. */
export function bootstrapDiff(a: MatchSample[], b: MatchSample[], weights: Map<string, number>,
  reps: number, rand: () => number): { lo: number; hi: number; p: number; se: number } | null {
  if (a.length === 0 || b.length === 0) return null;
  const diffs: number[] = [];
  for (let r = 0; r < reps; r++) {
    const va = weightedValue(resample(a, rand), weights);
    const vb = weightedValue(resample(b, rand), weights);
    if (va !== null && vb !== null) diffs.push(vb - va);
  }
  if (diffs.length < 2) return null;
  diffs.sort((x, y) => x - y);
  const le = diffs.filter((d) => d <= 0).length / diffs.length;
  const ge = diffs.filter((d) => d >= 0).length / diffs.length;
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const se = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (diffs.length - 1));
  return { lo: quantile(diffs, 0.025), hi: quantile(diffs, 0.975), p: Math.min(1, 2 * Math.min(le, ge)), se };
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

/** Extra matches per side for the current difference to clear a 95% interval,
 *  assuming the standard error shrinks with the square root of the sample. */
export function matchesNeeded(diff: number, se: number, n: number): number | null {
  if (diff === 0 || se <= 0 || n <= 0) return null;
  const factor = (Z95 * se / Math.abs(diff)) ** 2;
  return Math.max(0, Math.ceil(n * factor - n));
}

export type Verdict = 'real' | 'too_early' | 'noise' | 'no_data';

export function verdictOf(o: { hasData: boolean; significant: boolean; nA: number; nB: number }): Verdict {
  if (!o.hasData) return 'no_data';
  if (o.significant && o.nA >= REAL_MIN_MATCHES && o.nB >= REAL_MIN_MATCHES) return 'real';
  if (!o.significant && o.nA >= NOISE_MIN_MATCHES && o.nB >= NOISE_MIN_MATCHES) return 'noise';
  return 'too_early';
}
