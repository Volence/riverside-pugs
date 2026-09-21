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
 *  single high occupancy round really can be luck. */
export function aggregate(rows: { steamid: string; metrics: RoundMetrics }[]): PlayerAgg[] {
  const by = new Map<string, { steamid: string; metrics: RoundMetrics }[]>();
  for (const r of rows) {
    const list = by.get(r.steamid) ?? [];
    list.push(r);
    by.set(r.steamid, list);
  }
  return [...by.values()].map((list) => ({
    steamid: list[0].steamid,
    rounds: list.length,
    fidMax: Math.max(...list.map((r) => r.metrics.fidMax)),
    fidP95: meanOrNull(list.map((r) => r.metrics.fidP95)) ?? 0,
    occZ: meanOrNull(list.map((r) => r.metrics.occZ)),
    teamGap: meanOrNull(list.map((r) => r.metrics.teamGap)),
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
