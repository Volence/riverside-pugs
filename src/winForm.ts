/**
 * Team form for the win chance line: how each team has played so far in
 * this match, as a tilt on the halves it still has to play.
 *
 * Today's line (src/winProb.ts) draws every remaining survivor half from the
 * map's history alone, so a team that has made every saferoom is priced like
 * any other. Form measures each half already played against its own map's
 * distribution (the mid-rank percentile, so a wipe on a hard map and a wipe
 * on an easy one say different things) and leans the team's future halves
 * that way by an exponential tilt of their histograms.
 *
 * Two sides, as the design names them: survivor form (a team's own survivor
 * halves) and infected form (the other team's survivor halves, plus the SI
 * damage the team dealt against that map's norm where data feeds exist).
 * Each is shrunk toward zero by n / (n + shrink), n being the halves played
 * on that side, so map 1 stays close to the plain line.
 *
 * In a two-team match a team's survivor halves are exactly the other team's
 * infected halves, so survivor and infected score form are the same numbers
 * and only their sum moves the line. The fit (scripts/win-backtest.ts) keeps
 * infected at 0 and lets survivor carry both; the SI damage term is the only
 * infected signal that is new information.
 *
 * The strengths and the calibration temperature that goes with them are
 * fitted on history and read from winForm.fitted.json. Whether a line uses
 * form at all is the win_chance_form setting (formOption).
 */
import { readFileSync } from 'node:fs';
import type { DB } from './db.js';
import { getSetting } from './settings.js';
import { BIN, type PlayedHalf, type WinModel } from './winProb.js';

export interface FormParams {
  /** Tilt per unit of a team's shrunk mean survivor logit. */
  survivor: number;
  /** Tilt per unit of the other team's shrunk infected form. */
  infected: number;
  /** Tilt per unit of the other team's shrunk mean SI damage over its map's norm. */
  siDamage: number;
  /** Halves worth as much as the prior of no form at all. */
  shrink: number;
  /** Logit temperature for the line with form in it (CALIBRATION is for the line without). */
  calibration: number;
}

/** The fitted parameters (scripts/win-backtest.ts --part form writes them).
 *  The file also records whether they passed the backtest gate ("gate", the
 *  Brier numbers, the bins that missed); those fields are a record for
 *  people and are not read here. The win_chance_form setting is the guard. */
export const FORM_PARAMS: FormParams = JSON.parse(
  readFileSync(new URL('./winForm.fitted.json', import.meta.url), 'utf8'),
) as FormParams;

/** Percentiles are kept this far from 0 and 1, so one wipe on a map that is
 *  almost never wiped cannot send a logit off toward infinity. */
const P_CLAMP = 0.02;

/** Mid-rank CDF of `score` in the map's half-score distribution, in 0..1:
 *  the share of halves below it plus half the share in its own bucket. */
export function halfPercentile(model: WinModel, map: string, score: number): number {
  const d = model.dist(map);
  const k = Math.min(d.length - 1, Math.max(0, Math.round(score / BIN)));
  let below = 0;
  for (let i = 0; i < k; i++) below += d[i];
  return Math.min(1, Math.max(0, below + d[k] / 2));
}

function logit(p: number): number {
  const q = Math.min(1 - P_CLAMP, Math.max(P_CLAMP, p));
  return Math.log(q / (1 - q));
}

/**
 * Exponential tilt of a histogram over its bucket index, measured in the
 * histogram's own standard deviations: p_i * exp(theta * (i - mean) / sd),
 * renormalised. Scaling by the spread makes one theta mean the same lean on
 * a map whose scores run 0 to 600 as on one that runs 0 to 1,600. Theta 0,
 * or a histogram with no spread, comes back as it was.
 */
export function tilt(dist: Float64Array, theta: number): Float64Array {
  if (theta === 0) return dist;
  let mean = 0;
  for (let i = 0; i < dist.length; i++) mean += dist[i] * i;
  let variance = 0;
  for (let i = 0; i < dist.length; i++) variance += dist[i] * (i - mean) ** 2;
  const sd = Math.sqrt(variance);
  if (!(sd > 1e-9)) return dist;
  const out = new Float64Array(dist.length);
  let total = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] === 0) continue;
    out[i] = dist[i] * Math.exp(theta * (i - mean) / sd);
    total += out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Key for a half in an SI damage map: `${ordinal}:${half}`. */
export const halfKey = (ordinal: number, half: number) => `${ordinal}:${half}`;

/**
 * The log-odds tilt for each team's survivor halves still to come, from the
 * halves in `played`. `siDmg` holds, per half (halfKey), the SI damage the
 * infected team dealt in it as a ratio to that map's median minus 1; halves
 * without data feeds are simply absent.
 *
 * Team A's tilt is survivor * (A's survivor form) - infected * (B's infected
 * form) - siDamage * (B's SI damage form), and the same the other way round.
 * Nothing played (or every strength 0) is { a: 0, b: 0 }.
 */
export function teamForm(
  model: WinModel, played: PlayedHalf[], siDmg?: Map<string, number>, params: FormParams = FORM_PARAMS,
): { a: number; b: number } {
  const surv = { a: [] as number[], b: [] as number[] };
  const si = { a: [] as number[], b: [] as number[] };
  for (const r of played) {
    surv[r.survTeam].push(logit(halfPercentile(model, r.map, r.score)));
    const dmg = siDmg?.get(halfKey(r.ordinal, r.half));
    if (dmg !== undefined) si[r.survTeam === 'a' ? 'b' : 'a'].push(dmg);
  }
  const shrunk = (xs: number[]) =>
    xs.length === 0 ? 0 : (xs.reduce((s, x) => s + x, 0) / xs.length) * (xs.length / (xs.length + params.shrink));
  const survForm = { a: shrunk(surv.a), b: shrunk(surv.b) };
  // A team's infected form is how far below their maps' norm it held the
  // other team's survivors.
  const infForm = { a: -survForm.b, b: -survForm.a };
  const siForm = { a: shrunk(si.a), b: shrunk(si.b) };
  const of = (team: 'a' | 'b', other: 'a' | 'b') =>
    params.survivor * survForm[team] - params.infected * infForm[other] - params.siDamage * siForm[other];
  // `+ 0` turns a -0 into 0, so an unplayed match is exactly { a: 0, b: 0 }.
  return { a: of('a', 'b') + 0, b: of('b', 'a') + 0 };
}

/** The form parameters for a line, or undefined for the plain line: form is
 *  used when win_chance_form is on, or for an admin viewer (match page and
 *  /live only) so staff can watch it before it goes public. */
export function formOption(db: DB, adminViewer = false): FormParams | undefined {
  return adminViewer || getSetting(db, 'win_chance_form') === '1' ? FORM_PARAMS : undefined;
}
