import { TUNING } from './constants.js';
import type { HiddenMetrics } from './hidden.js';
import { TRACKED_CLASSES, type InfectedClass } from './los.js';
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
 *
 * `pick` chooses which occupancy is being calibrated: metric B's, or metric
 * E's, which is calibrated on its own because hidden pairs are a different
 * population of moments.
 */
export function calibrate(
  rows: ScoreRow[], pick: (m: RoundMetrics) => OccResult | null | undefined = (m) => m.occ,
): (map: string | null | undefined) => number {
  const byMap = new Map<string, { observed: number; expected: number }>();
  const all = { observed: 0, expected: 0 };
  for (const r of rows) {
    const occ = pick(r.metrics);
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

export interface ClassScores { hiddenShare: number | null; hiddenOccZ: number | null; revealShare: number | null }

export interface PlayerAgg {
  steamid: string;
  rounds: number;
  /** Rounds in which at least one pair cleared every gate: the rounds the
   *  detector actually ran in. What MIN_BOARD_ROUNDS counts. */
  eligibleRounds: number;
  /** The best single window anywhere in their history. CONTEXT ONLY. It is a
   *  maximum, so it can only rise with playtime, and it must not be ranked on. */
  fidMax: number;
  fidP95: number;
  /** Fidelity windows that could be scored, over every round. */
  scoreable: number;
  /** Metric A as the board ranks it: the summed fidelity of those windows over
   *  their number. Null under MIN_TRACK_WINDOWS. */
  trackShare: number | null;
  occZ: number | null;
  teamGap: number | null;
  /** Rounds whose replay recorded line of sight: what the hidden metrics'
   *  MIN_BOARD_ROUNDS counts. Version 4 rows have none. */
  losRounds: number;
  hiddenScoreable: number;
  /** Metric D: pooled lag-tolerant fidelity over scoreable hidden windows. */
  hiddenShare: number | null;
  /** Metric E: mean per-round z against its own per-map calibration. */
  hiddenOccZ: number | null;
  reveals: number;
  /** Metric F: share of reveals already on target. Null under MIN_REVEALS. */
  revealShare: number | null;
  /** The same three per infected class. Hunters are quiet when crouched, so a
   *  player far above the league on hunters is the strongest signal. */
  byClass: Record<InfectedClass, ClassScores>;
}

function meanOrNull(xs: (number | null)[]): number | null {
  const ns = xs.filter((x): x is number => x != null);
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
}

/** D, E and F for one player's rounds, at the given class or overall. Every
 *  value is null under MIN_BOARD_ROUNDS rounds with line of sight: sample
 *  sizes here are small, and a small sample must read "not enough", not a
 *  number (spec section 3, Minimums). */
function hiddenScores(
  hid: { h: HiddenMetrics; map: string | null | undefined }[],
  k: (map: string | null | undefined) => number,
  part: (h: HiddenMetrics) => { scoreable: number; fidSum: number; occ: OccResult | null; reveals: number; revealOn: number },
): ClassScores & { scoreable: number; reveals: number } {
  const enough = hid.length >= TUNING.MIN_BOARD_ROUNDS;
  const parts = hid.map((x) => ({ p: part(x.h), map: x.map }));
  const scoreable = parts.reduce((a, x) => a + x.p.scoreable, 0);
  const fidSum = parts.reduce((a, x) => a + x.p.fidSum, 0);
  const reveals = parts.reduce((a, x) => a + x.p.reveals, 0);
  const on = parts.reduce((a, x) => a + x.p.revealOn, 0);
  return {
    scoreable,
    reveals,
    hiddenShare: enough && scoreable >= TUNING.MIN_TRACK_WINDOWS ? fidSum / scoreable : null,
    hiddenOccZ: enough ? meanOrNull(parts.map((x) => (x.p.occ ? occupancyZ(x.p.occ, k(x.map)) : null))) : null,
    revealShare: enough && reveals >= TUNING.MIN_REVEALS ? on / reveals : null,
  };
}

/** Roll a player's rounds into one row.
 *
 *  TRACKING IS A SHARE, NOT A MAXIMUM. Until version 4 the board ranked on
 *  fidMax, the best window in any round, on the argument that one round of
 *  following an invisible target should not be averaged away by twenty clean
 *  ones. But a maximum can only go up: on the live board it averaged 0.00 for
 *  players with 8 to 15 rounds and 0.25 for players with 64 or more, so the
 *  column ranked playtime. The share is the summed fidelity of every window
 *  that could be scored over the number of them, pooled across rounds rather
 *  than averaged per round, so a round with more chances in it weighs more and
 *  one lucky window is worth less the more chances there were. The argument
 *  for the maximum is answered by clips, not by the ranking: a single window
 *  over CLIP_MIN is surfaced for review whatever the player's share is.
 *
 *  Occupancy and the team gap are SCORED here, not read: each round's sums
 *  become a z against its map's calibration, and metric C is that z minus the
 *  mean of the teammates' in the same round. C is a second control on a
 *  different axis from the prior. The prior removes what is normal for this
 *  MAP across all history; this removes what was normal for this ROUND,
 *  including whatever the director happened to do. Both are means over
 *  rounds, because a single high occupancy round really can be luck. */
export function aggregate(rows: ScoreRow[]): PlayerAgg[] {
  const k = calibrate(rows);
  const kHidden = calibrate(rows, (m) => m.hidden?.occ);
  const kClass = new Map(TRACKED_CLASSES.map((c) => [c, calibrate(rows, (m) => m.hidden?.byClass[c].occ)]));
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
  return [...by.values()].map((list) => {
    // `?? 0`: a row written before these counts existed has none, and reads as
    // a round with nothing scoreable in it until it is measured again.
    const scoreable = list.reduce((a, r) => a + (r.metrics.scoreable ?? 0), 0);
    const fidSum = list.reduce((a, r) => a + (r.metrics.fidSum ?? 0), 0);
    return {
      steamid: list[0].steamid,
      rounds: list.length,
      eligibleRounds: list.filter((r) => r.metrics.eligiblePairs > 0).length,
      fidMax: Math.max(...list.map((r) => r.metrics.fidMax)),
      fidP95: meanOrNull(list.map((r) => r.metrics.fidP95)) ?? 0,
      scoreable,
      trackShare: scoreable >= TUNING.MIN_TRACK_WINDOWS ? fidSum / scoreable : null,
      occZ: meanOrNull(list.map((r) => r.z)),
      teamGap: meanOrNull(list.map(gapOf)),
      ...(() => {
        const hid = list.flatMap((r) => (r.metrics.hidden ? [{ h: r.metrics.hidden, map: r.map }] : []));
        const all = hiddenScores(hid, kHidden, (h) => h);
        return {
          losRounds: hid.length,
          hiddenScoreable: all.scoreable,
          hiddenShare: all.hiddenShare,
          hiddenOccZ: all.hiddenOccZ,
          reveals: all.reveals,
          revealShare: all.revealShare,
          byClass: Object.fromEntries(TRACKED_CLASSES.map((c) => {
            const s = hiddenScores(hid, kClass.get(c)!, (h) => h.byClass[c]);
            return [c, { hiddenShare: s.hiddenShare, hiddenOccZ: s.hiddenOccZ, revealShare: s.revealShare }];
          })) as Record<InfectedClass, ClassScores>,
        };
      })(),
    };
  });
}

export interface ScoredPlayer extends PlayerAgg {
  /** False under MIN_BOARD_ROUNDS. An unranked player is listed, after
   *  everyone ranked, with no percentiles and no composite. */
  ranked: boolean;
  pFid: number | null;
  pOcc: number | null;
  pGap: number | null;
  /** Percentiles of D, E and F among ranked players who have them. Shown, NOT
   *  in the composite: their thresholds are uncalibrated (spec section 6), and
   *  an uncalibrated number in the rank would reorder the review list on it. */
  pHidden: number | null;
  pHiddenOcc: number | null;
  pReveal: number | null;
  /** Mean of the three percentiles, with a MISSING one counted as the middle of
   *  the population rather than dropped. A sort key, not a claim. Null when
   *  unranked. */
  composite: number | null;
}

/** The middle of the population. An unmeasured metric says nothing about a
 *  player, so it should move their composite neither up nor down. */
export const NEUTRAL_PERCENTILE = 0.5;

export function scorePlayers(aggs: PlayerAgg[]): ScoredPlayer[] {
  // The population is the RANKED players only. Someone with two rounds is not
  // part of what "top of this board" means, in either direction: they cannot
  // be placed in it and they must not move anyone else's place in it.
  const pool = aggs.filter((a) => a.eligibleRounds >= TUNING.MIN_BOARD_ROUNDS);
  const some = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);
  const fids = some(pool.map((a) => a.trackShare));
  const occs = some(pool.map((a) => a.occZ));
  const gaps = some(pool.map((a) => a.teamGap));
  const hiddens = some(pool.map((a) => a.hiddenShare));
  const hiddenOccs = some(pool.map((a) => a.hiddenOccZ));
  const revealsP = some(pool.map((a) => a.revealShare));

  const ranked = pool.map((a) => {
    const pFid = a.trackShare == null ? null : percentile(fids, a.trackShare);
    const pOcc = a.occZ == null ? null : percentile(occs, a.occZ);
    const pGap = a.teamGap == null ? null : percentile(gaps, a.teamGap);
    // A missing metric counts as NEUTRAL, not as absent. Averaging only the
    // parts a player happens to have meant that having less evidence made it
    // easier to reach the top: a player with one metric at the 95th percentile
    // and two n/a scored 0.95, while a player measured on all three had to be
    // high on all three to match. Seen live on 2026-09-21, where a 3-round
    // player with two n/a ranked 1 of 82 on a single number.
    const parts = [pFid, pOcc, pGap].map((x) => (x == null ? NEUTRAL_PERCENTILE : x));
    return {
      ...a, ranked: true, pFid, pOcc, pGap,
      pHidden: a.hiddenShare == null ? null : percentile(hiddens, a.hiddenShare),
      pHiddenOcc: a.hiddenOccZ == null ? null : percentile(hiddenOccs, a.hiddenOccZ),
      pReveal: a.revealShare == null ? null : percentile(revealsP, a.revealShare),
      composite: parts.reduce((x, y) => x + y, 0) / parts.length,
    };
  }).sort((x, y) => y.composite - x.composite);

  // Listed, because an admin searching for a name should find it, and last,
  // because nothing is known about them. Most rounds first: the nearest to
  // being ranked, and the most there is to look at in the meantime.
  const unranked = aggs.filter((a) => a.eligibleRounds < TUNING.MIN_BOARD_ROUNDS)
    .map((a) => ({
      ...a, ranked: false, pFid: null, pOcc: null, pGap: null,
      pHidden: null, pHiddenOcc: null, pReveal: null, composite: null,
    }))
    .sort((x, y) => y.eligibleRounds - x.eligibleRounds);
  return [...ranked, ...unranked];
}
