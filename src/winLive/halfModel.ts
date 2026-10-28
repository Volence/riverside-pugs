import { readFileSync } from 'node:fs';
import { BIN, type WinModel } from '../winProb.js';
import { tilt } from '../winForm.js';
import type { Snapshot } from './snapshot.js';

/**
 * The live half model: from a snapshot of a half in progress, the
 * distribution of that half's final score, in the 20-point bins of
 * src/winProb.ts so it drops into the same convolution as a half still to
 * play.
 *
 * It starts from the distribution the half-end line already uses for the
 * half (the map's history, tilted by team form when that is on) and reweights
 * it. The score axis is cut into a few classes in units of the map's typical
 * made score (WinModel.scale): four wipe bands, then made with losses, then
 * three made bands. A multinomial logistic on the snapshot moves weight
 * between the classes; inside a class the base shape is kept. Every feature
 * is 0 at the opening state (no progress, four standing survivors at full
 * health, the tank still to come, no time gone), and the logistic's
 * intercepts are the base's own class shares, so the opening snapshot gives
 * back the base distribution exactly and the line does not jump when a half
 * goes live. The map's identity enters only through that base, which is
 * already shrunk toward the pool for maps with little history.
 *
 * The tank is priced in at half start (owner ruling 2026-10-27): every half
 * has one, so its spawn alone must not move the number. The tank feature is
 * the share of the tank already beaten (0 while pending and at spawn, rising
 * as it takes damage, 1 once dead); what the fight costs shows up in the
 * health, down and alive features.
 *
 * Two rules come from how versus scores (checked on the 2026-10-28 data, see
 * the task 5 report): a wiped half scores close to the distance reached,
 * about `wipePerProg` of the map's scale per 100% of progress, and the score
 * never falls far below that, so the bins under `floorPerProg` of it are
 * emptied into the wipe bands above. And once nobody is alive the half is
 * over: a point mass at the wipe score.
 *
 * Progress the snapshot does not know (null: no feed or position yet) is
 * marginalised, never read as 0%: the prediction is averaged over quantiles
 * of where halves typically are at that time.
 *
 * Fitted by scripts/win-backtest.ts --part live, read from
 * halfModel.fitted.json. The win_chance_live setting decides whether any
 * line uses it.
 */

/** The snapshot features, in the order of each class's weights. Progress
 *  and time enter as hinges (piecewise linear), since how much a stretch of
 *  distance or a minute says changes along the half. */
export const FEATURES = [
  /** Progress, 0..1. */
  'prog',
  /** Progress past 25%, 50% and 75%. */
  'prog25',
  'prog50',
  'prog75',
  /** Survivors dead (4 - alive). */
  'aliveLost',
  /** Survivors incapped or on a ledge. */
  'down',
  /** Health lost, in survivors' worth ((400 - health) / 100). */
  'healthLost',
  /** Share of the tank beaten: 0 pending, 1 - health fraction alive, 1 dead. */
  'tankDone',
  /** Progress again on a team's second half of a map (survivors second). */
  'half2Prog',
  /** Time into the half in tens of minutes (capped at 2), and past 2 and 5 minutes. */
  'time',
  'time2m',
  'time5m',
] as const;

export interface HalfModelParams {
  /** Upper edges of the score classes, in units of the map's scale, ascending. */
  classEdges: number[];
  /** FEATURES as fitted, a record for people (the order is FEATURES). */
  features: string[];
  /** One row per class (classEdges.length + 1), one weight per feature. */
  weights: number[][];
  /** A wipe's score per 100% progress, in units of scale. 0 turns the
   *  everyone-dead point mass off. */
  wipePerProg: number;
  /** The lowest score a half can still end on per 100% progress, in units of
   *  scale. 0 turns the floor off. */
  floorPerProg: number;
  /** Bins below this many scales are the wipe bands the floor's mass goes to. */
  wipeTop: number;
  /** Progress quantiles (0..100) by time into the half, bucket i covering
   *  [i * stepMs, (i + 1) * stepMs), the last bucket for anything later. */
  progByTime: { stepMs: number; quantiles: number[][] };
}

export const HALF_PARAMS: HalfModelParams = JSON.parse(
  readFileSync(new URL('./halfModel.fitted.json', import.meta.url), 'utf8'),
) as HalfModelParams;

const TEN_MINUTES_MS = 600_000;
const MAX_TEN_MINUTES = 2;

/** The feature vector for a snapshot at progress `prog` (0..100, resolved). */
export function featureVector(snap: Snapshot, prog: number, half: 1 | 2): Float64Array {
  const p = prog / 100;
  const tankDone = snap.tank === 'dead' ? 1
    : snap.tank === 'alive' ? 1 - Math.min(1, Math.max(0, snap.tankHealthFrac ?? 1)) : 0;
  const t = Math.min(MAX_TEN_MINUTES, Math.max(0, snap.tMs) / TEN_MINUTES_MS);
  const past = (x: number, at: number) => Math.max(0, x - at);
  return Float64Array.of(
    p, past(p, 0.25), past(p, 0.5), past(p, 0.75),
    4 - snap.alive,
    snap.down,
    (400 - snap.health) / 100,
    tankDone,
    half === 2 ? p : 0,
    t, past(t, 0.2), past(t, 0.5),
  );
}

/** Which class a score of `u` scales falls in. */
export function classOf(u: number, edges: number[]): number {
  let c = 0;
  while (c < edges.length && u >= edges[c]) c += 1;
  return c;
}

/** The class probabilities given the base's class shares `shares` and a
 *  feature vector: shares[c] * exp(w_c . x), normalised. */
export function classProbs(shares: ArrayLike<number>, weights: number[][], x: ArrayLike<number>): Float64Array {
  const z = new Float64Array(shares.length);
  let top = -Infinity;
  for (let c = 0; c < shares.length; c++) {
    let s = 0;
    for (let f = 0; f < x.length; f++) s += weights[c][f] * x[f];
    z[c] = s;
    if (shares[c] > 0 && s > top) top = s;
  }
  let total = 0;
  for (let c = 0; c < shares.length; c++) {
    z[c] = shares[c] > 0 ? shares[c] * Math.exp(z[c] - top) : 0;
    total += z[c];
  }
  for (let c = 0; c < z.length; c++) z[c] /= total;
  return z;
}

/** The progress values to average over: the snapshot's own, or the time
 *  bucket's quantiles when it has none. */
export function progressCandidates(params: HalfModelParams, snap: Snapshot): number[] {
  if (snap.prog !== null) return [snap.prog];
  const { stepMs, quantiles } = params.progByTime;
  if (quantiles.length === 0) return [0];
  return quantiles[Math.min(quantiles.length - 1, Math.max(0, Math.floor(snap.tMs / stepMs)))];
}

/** The score a half wiped at `prog` ends on. */
export function wipeScore(model: WinModel, params: HalfModelParams, map: string, prog: number): number {
  return params.wipePerProg * (prog / 100) * model.scale(map);
}

/** `base` reweighted for the state `x` at progress `prog`, added into `out` with weight `w`. */
function addReweighted(
  out: Float64Array, base: Float64Array, cls: Int32Array, shares: Float64Array, scale: number,
  params: HalfModelParams, x: Float64Array, prog: number, w: number,
): void {
  const probs = classProbs(shares, params.weights, x);
  const d = new Float64Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const c = cls[i];
    if (base[i] > 0) d[i] = base[i] * probs[c] / shares[c];
  }
  // The floor: a bin wholly below it cannot be the final score. Its weight
  // was a wipe ending short of the distance already made, so it goes to the
  // wipe bands at or above the floor, in proportion.
  const floorScore = params.floorPerProg * (prog / 100) * scale;
  const below = Math.min(base.length, Math.floor(floorScore / BIN));
  if (below > 0) {
    let lost = 0;
    for (let i = 0; i < below; i++) { lost += d[i]; d[i] = 0; }
    const top = Math.min(base.length, Math.ceil(params.wipeTop * scale / BIN));
    let room = 0;
    for (let i = below; i < top; i++) room += d[i];
    if (room > 0) for (let i = below; i < top; i++) d[i] += lost * d[i] / room;
    else d[Math.min(base.length - 1, below)] += lost;
  }
  for (let i = 0; i < base.length; i++) out[i] += w * d[i];
}

/**
 * The final-score distribution of a half from its snapshot `snap` (null: no
 * live state, the base distribution exactly). `theta` is the team-form tilt
 * the half-end line uses for this half (0 without form), `half` whether the
 * team is surviving first or second on the map.
 */
export function predictHalf(
  model: WinModel, params: HalfModelParams, map: string, theta: number, snap: Snapshot | null, half: 1 | 2 = 1,
): Float64Array {
  const base = tilt(model.dist(map), theta);
  if (!snap) return base;
  const scale = model.scale(map);
  const progs = progressCandidates(params, snap);
  const out = new Float64Array(base.length);
  const w = 1 / progs.length;
  if (snap.alive <= 0 && params.wipePerProg > 0) {
    for (const p of progs) {
      out[Math.min(base.length - 1, Math.max(0, Math.round(wipeScore(model, params, map, p) / BIN)))] += w;
    }
    return out;
  }
  const cls = new Int32Array(base.length);
  const shares = new Float64Array(params.classEdges.length + 1);
  for (let i = 0; i < base.length; i++) {
    cls[i] = classOf((i * BIN) / scale, params.classEdges);
    shares[cls[i]] += base[i];
  }
  for (const p of progs) addReweighted(out, base, cls, shares, scale, params, featureVector(snap, p, half), p, w);
  return out;
}
