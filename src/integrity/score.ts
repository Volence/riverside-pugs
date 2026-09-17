import type { RoundMetrics } from './ghostTrack.js';

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
  corrMax: number;
  corrP95: number;
  occZ: number | null;
  teamGap: number | null;
}

function meanOrNull(xs: (number | null)[]): number | null {
  const ns = xs.filter((x): x is number => x != null);
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
}

/** Roll a player's rounds into one row.
 *
 *  corrMax is a MAXIMUM across rounds, not a mean: one round of following an
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
    corrMax: Math.max(...list.map((r) => r.metrics.fidMax)),
    corrP95: meanOrNull(list.map((r) => r.metrics.fidP95)) ?? 0,
    occZ: meanOrNull(list.map((r) => r.metrics.occZ)),
    teamGap: meanOrNull(list.map((r) => r.metrics.teamGap)),
  }));
}

export interface ScoredPlayer extends PlayerAgg {
  pCorr: number;
  pOcc: number | null;
  pGap: number | null;
  /** Mean of whichever percentiles this player has. A sort key, not a claim. */
  composite: number;
}

export function scorePlayers(aggs: PlayerAgg[]): ScoredPlayer[] {
  const corrs = aggs.map((a) => a.corrMax);
  const occs = aggs.map((a) => a.occZ).filter((x): x is number => x != null);
  const gaps = aggs.map((a) => a.teamGap).filter((x): x is number => x != null);

  return aggs.map((a) => {
    const pCorr = percentile(corrs, a.corrMax);
    const pOcc = a.occZ == null ? null : percentile(occs, a.occZ);
    const pGap = a.teamGap == null ? null : percentile(gaps, a.teamGap);
    const parts = [pCorr, pOcc, pGap].filter((x): x is number => x != null);
    return { ...a, pCorr, pOcc, pGap, composite: parts.reduce((x, y) => x + y, 0) / parts.length };
  }).sort((x, y) => y.composite - x.composite);
}
