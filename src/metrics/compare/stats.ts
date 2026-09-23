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

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
}

interface PackedSide {
  /** offset[i]..offset[i+1) is match i's slice of idx/num/den. Length n + 1. */
  offset: Int32Array;
  /** Map index (into the weighted-maps list) for each packed entry. */
  idx: Int32Array;
  num: Float64Array;
  den: Float64Array;
  n: number;
}

/** Packs one side's per-match, per-map sums into a CSR-style layout: only
 *  the (map, num, den) entries a match actually has, addressed by `offset`.
 *  A bootstrap replicate can then sum a resampled match's row with plain
 *  array arithmetic and no Map lookups, and without paying for the maps
 *  that match never touched (most matches cover only a few of the maps in
 *  play across a whole comparison). */
function packSide(side: MatchSample[], mapIndex: Map<string, number>): PackedSide {
  const n = side.length;
  const offset = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (const map of side[i].keys()) if (mapIndex.has(map)) c++;
    offset[i + 1] = offset[i] + c;
  }
  const total = offset[n];
  const idx = new Int32Array(total);
  const num = new Float64Array(total);
  const den = new Float64Array(total);
  for (let i = 0; i < n; i++) {
    let p = offset[i];
    for (const [map, v] of side[i]) {
      const j = mapIndex.get(map);
      if (j === undefined) continue;
      idx[p] = j; num[p] = v.num; den[p] = v.den; p++;
    }
  }
  return { offset, idx, num, den, n };
}

/** Bootstrap of B minus A by resampling whole matches on each side. Uses the
 *  paired weightedDiff (not weightedValue(b) - weightedValue(a)) semantics
 *  for every replicate so a map dropped from one side's resample but not the
 *  other's cannot bias the difference. seA/seB are each side's own replicate
 *  spread, used by matchesNeeded to see how much of the uncertainty A already
 *  fixes.
 *
 *  Restricted up front to the positively-weighted maps and packed into flat
 *  typed arrays in CSR form (packSide: one contiguous slice of map/num/den
 *  per match, addressed by `offset`), so the reps loop only touches the
 *  entries a resampled match actually has and does plain array arithmetic:
 *  no Map allocation or lookup per replicate. That is what made this the hot
 *  path at match counts in the hundreds. */
export function bootstrapDiff(a: MatchSample[], b: MatchSample[], weights: Map<string, number>,
  reps: number, rand: () => number): { lo: number; hi: number; p: number; se: number; seA: number; seB: number } | null {
  if (a.length === 0 || b.length === 0) return null;
  const mapKeys = [...weights].filter(([, w]) => w > 0).map(([k]) => k);
  const M = mapKeys.length;
  if (M === 0) return null;
  const w = new Float64Array(M);
  const mapIndex = new Map<string, number>();
  mapKeys.forEach((k, i) => { w[i] = weights.get(k)!; mapIndex.set(k, i); });

  const pa = packSide(a, mapIndex), pb = packSide(b, mapIndex);
  const sumNumA = new Float64Array(M), sumDenA = new Float64Array(M);
  const sumNumB = new Float64Array(M), sumDenB = new Float64Array(M);

  const diffs: number[] = [];
  const vas: number[] = [];
  const vbs: number[] = [];
  for (let r = 0; r < reps; r++) {
    sumNumA.fill(0); sumDenA.fill(0);
    for (let i = 0; i < pa.n; i++) {
      const m = Math.floor(rand() * pa.n);
      for (let e = pa.offset[m], end = pa.offset[m + 1]; e < end; e++) {
        const j = pa.idx[e];
        sumNumA[j] += pa.num[e]; sumDenA[j] += pa.den[e];
      }
    }
    sumNumB.fill(0); sumDenB.fill(0);
    for (let i = 0; i < pb.n; i++) {
      const m = Math.floor(rand() * pb.n);
      for (let e = pb.offset[m], end = pb.offset[m + 1]; e < end; e++) {
        const j = pb.idx[e];
        sumNumB[j] += pb.num[e]; sumDenB[j] += pb.den[e];
      }
    }

    let va = 0, vaW = 0, vb = 0, vbW = 0, d = 0, dW = 0;
    for (let j = 0; j < M; j++) {
      const hasA = sumDenA[j] > 0, hasB = sumDenB[j] > 0;
      const rateA = hasA ? sumNumA[j] / sumDenA[j] : 0;
      const rateB = hasB ? sumNumB[j] / sumDenB[j] : 0;
      if (hasA) { va += w[j] * rateA; vaW += w[j]; }
      if (hasB) { vb += w[j] * rateB; vbW += w[j]; }
      if (hasA && hasB) { d += w[j] * (rateB - rateA); dW += w[j]; }
    }
    if (vaW > 0) vas.push(va / vaW);
    if (vbW > 0) vbs.push(vb / vbW);
    if (dW > 0) diffs.push(d / dW);
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

/** Inverse of the standard normal CDF (the z with P(Z <= z) = p), by
 *  Acklam's rational approximation: relative error under 1.2e-9 over (0, 1),
 *  far below anything a match-count estimate can notice. Throws outside
 *  (0, 1), where no finite z exists. */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`inverseNormalCdf needs 0 < p < 1, got ${p}`);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const tail = (q: number) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  const LOW = 0.02425;
  if (p < LOW) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - LOW) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Extra matches for side B alone (the newer patch) for the difference to
 *  clear a two-sided interval at `z` (1.96 is 95%; compareSides passes the
 *  z of the row's own Benjamini-Hochberg cutoff), holding side A's match
 *  count fixed. Side A's own replicate variance (seA) already contributes a
 *  fixed amount to the target variance; only the leftover budget can be paid
 *  down by adding B matches, which is assumed to shrink B's variance with the
 *  square root of its sample. Null when the diff is zero or seA alone already
 *  meets or exceeds the target (no amount of additional B matches can settle
 *  it), and null when the formula says no more matches are needed at all:
 *  then sample size is not what is holding the row back, so there is no
 *  honest number to show. */
export function matchesNeeded(diff: number, seA: number, seB: number, nB: number, z = Z95): number | null {
  if (diff === 0) return null;
  const target = (Math.abs(diff) / z) ** 2;
  if (seA * seA >= target) return null;
  const more = Math.ceil((nB * seB * seB) / (target - seA * seA) - nB);
  return more > 0 ? more : null;
}

export type Verdict = 'real' | 'too_early' | 'noise' | 'no_data';

export function verdictOf(o: { hasData: boolean; significant: boolean; nA: number; nB: number }): Verdict {
  if (!o.hasData) return 'no_data';
  if (o.significant && o.nA >= REAL_MIN_MATCHES && o.nB >= REAL_MIN_MATCHES) return 'real';
  if (!o.significant && o.nA >= NOISE_MIN_MATCHES && o.nB >= NOISE_MIN_MATCHES) return 'noise';
  return 'too_early';
}
