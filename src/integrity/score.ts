import { TUNING } from './constants.js';
import type { OccResult } from './occupancy.js';
import type { RoundMetrics } from './round.js';

/**
 * Rankings, computed fresh on every read.
 *
 * Nothing here is ever stored. That is what lets a threshold be wrong: change
 * a constant, re-run the backfill, and the whole history re-scores. A stored
 * score would have to be migrated, and in practice would quietly go stale.
 *
 * Note what is absent: accuracy, kills, headshots, skeet rate. Those measure
 * SKILL, and a list sorted by any of them is a list of the best players. See
 * "Anti-metrics" in the spec. They may sit beside a clip as context. They must
 * never enter the composite.
 */

/** Fraction of the population strictly below this value. */
export function percentile(values: number[], v: number): number {
  if (values.length < 2) return 0;
  const below = values.filter((x) => x < v).length;
  return below / (values.length - 1);
}

/** One stored player-round as the board reads it. `map` and `round` come from
 *  the query, not from the measurements: which map the round was on, for the
 *  calibration, and which round it was, so teammates can be found. */
export interface ScoreRow {
  steamid: string;
  metrics: RoundMetrics;
  map?: string | null;
  round?: string;
}

/**
 * Metric B as a score: the excess of observed over expected on-target blocks,
 * in binomial standard deviations, with the prior scaled by `k` first.
 *
 * Null when the variance is nothing, which means the prior claims certainty
 * about every block and dividing by that would manufacture a number.
 */
export function occupancyZ(occ: OccResult, k: number): number | null {
  const variance = k * occ.expected - k * k * occ.expectedSq;
  if (variance <= 1e-9) return null;
  return (occ.observed - k * occ.expected) / Math.sqrt(variance);
}

/**
 * How much of what the prior predicts the players on this board actually do,
 * per map: observed over expected, summed over every row on that map.
 *
 * WHY THE PRIOR CANNOT BE TAKEN AT ITS WORD. It is not the probability that a
 * player is within E_DWELL of a ghost. It is how often any survivor's wedge
 * touched the ghost's 256 unit cell, from anywhere on the map, through walls;
 * and the frames it is compared against have already lost every moment
 * something visible stood near the ghost's bearing, which is exactly when
 * people look that way. Measured over the 189 replays in hand on 2026-09-21,
 * players were on a ghost 0.47 times as often as the prior said, and by map
 * that ran from 0.20 (airport01) to 0.97 (smalltown03). Uncalibrated, the
 * typical honest player-round scored -0.6 and a whole player's history pooled
 * to -3.9. So the prior is asked for its SHAPE, which cells are stared at more
 * than others, and the level comes from here.
 *
 * The subject's own rows are in their map's ratio. One player among dozens
 * moves it by a few percent at most, and it moves AGAINST them: being on
 * ghosts more raises what is expected of everyone, themselves included.
 *
 * A map with under MIN_CAL_EXPECTED expected blocks on the board uses the whole
 * board's ratio, and a board with nothing measured uses 1.
 */
export function calibrate(rows: ScoreRow[]): (map: string | null | undefined) => number {
  const byMap = new Map<string, { observed: number; expected: number }>();
  const all = { observed: 0, expected: 0 };
  for (const r of rows) {
    const occ = r.metrics.occ;
    if (!occ) continue;
    all.observed += occ.observed;
    all.expected += occ.expected;
    if (r.map == null) continue;
    const m = byMap.get(r.map) ?? { observed: 0, expected: 0 };
    m.observed += occ.observed;
    m.expected += occ.expected;
    byMap.set(r.map, m);
  }
  const board = all.expected > 0 ? all.observed / all.expected : 1;
  return (map) => {
    const m = map == null ? undefined : byMap.get(map);
    return m && m.expected >= TUNING.MIN_CAL_EXPECTED ? m.observed / m.expected : board;
  };
}

export interface PlayerAgg {
  steamid: string;
  rounds: number;
  fidMax: number;
  fidP95: number;
  occZ: number | null;
  teamGap: number | null;
}

function meanOrNull(xs: (number | null)[]): number | null {
  const ns = xs.filter((x): x is number => x != null);
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
}

/** Roll a player's rounds into one row.
 *
 *  fidMax is a MAXIMUM across rounds, not a mean: one round of following an
 *  invisible target is the thing worth looking at, and averaging it away with
 *  twenty clean rounds is how a detector misses. The rest are means, because a
 *  single high occupancy round really can be luck.
 *
 *  Occupancy and the team gap are SCORED here, not read: each round's sums
 *  become a z against its map's calibration, and metric C is that z minus the
 *  mean of the teammates' in the same round. C is a second control on a
 *  different axis from the prior. The prior removes what is normal for this
 *  MAP across all history; this removes what was normal for this ROUND,
 *  including whatever the director happened to do. */
export function aggregate(rows: ScoreRow[]): PlayerAgg[] {
  const k = calibrate(rows);
  const scored = rows.map((r) => ({ ...r, z: r.metrics.occ ? occupancyZ(r.metrics.occ, k(r.map)) : null }));

  const byRound = new Map<string, number[]>();
  for (const r of scored) {
    if (r.round == null || r.z == null) continue;
    byRound.set(r.round, [...(byRound.get(r.round) ?? []), r.z]);
  }
  const gapOf = (r: typeof scored[number]): number | null => {
    const team = r.round == null ? undefined : byRound.get(r.round);
    if (r.z == null || !team || team.length < 2) return null;
    // The others' mean, from the round's sum less this player's own score.
    return r.z - (team.reduce((a, b) => a + b, 0) - r.z) / (team.length - 1);
  };

  const by = new Map<string, typeof scored>();
  for (const r of scored) by.set(r.steamid, [...(by.get(r.steamid) ?? []), r]);
  return [...by.values()].map((list) => ({
    steamid: list[0].steamid,
    rounds: list.length,
    fidMax: Math.max(...list.map((r) => r.metrics.fidMax)),
    fidP95: meanOrNull(list.map((r) => r.metrics.fidP95)) ?? 0,
    occZ: meanOrNull(list.map((r) => r.z)),
    teamGap: meanOrNull(list.map(gapOf)),
  }));
}

export interface ScoredPlayer extends PlayerAgg {
  pFid: number;
  pOcc: number | null;
  pGap: number | null;
  /** Mean of the three percentiles, with a MISSING one counted as the middle of
   *  the population rather than dropped. A sort key, not a claim. */
  composite: number;
}

/** The middle of the population. An unmeasured metric says nothing about a
 *  player, so it should move their composite neither up nor down. */
export const NEUTRAL_PERCENTILE = 0.5;

export function scorePlayers(aggs: PlayerAgg[]): ScoredPlayer[] {
  const fids = aggs.map((a) => a.fidMax);
  const occs = aggs.map((a) => a.occZ).filter((x): x is number => x != null);
  const gaps = aggs.map((a) => a.teamGap).filter((x): x is number => x != null);

  return aggs.map((a) => {
    const pFid = percentile(fids, a.fidMax);
    const pOcc = a.occZ == null ? null : percentile(occs, a.occZ);
    const pGap = a.teamGap == null ? null : percentile(gaps, a.teamGap);
    // A missing metric counts as NEUTRAL, not as absent. Averaging only the
    // parts a player happens to have meant that having less evidence made it
    // easier to reach the top: a player with one metric at the 95th percentile
    // and two n/a scored 0.95, while a player measured on all three had to be
    // high on all three to match. Seen live on 2026-09-21, where a 3-round
    // player with two n/a ranked 1 of 82 on a single number.
    const parts = [pFid, pOcc, pGap].map((x) => (x == null ? NEUTRAL_PERCENTILE : x));
    return { ...a, pFid, pOcc, pGap, composite: parts.reduce((x, y) => x + y, 0) / parts.length };
  }).sort((x, y) => y.composite - x.composite);
}
