import type { DB } from './db.js';
import { getSetting } from './settings.js';
import { STAT_DEFS } from './statKeys.js';
import { quantiles } from './quantiles.js';

/** Games before a player holds a rank. Under this they are listed as
 *  provisional: one lucky night at high sigma should not top the board. */
export const RANKED_MIN_GAMES = 3;

/** Fallback for the badge gate when the setting is missing or unreadable.
 *  Never RANKED_MIN_GAMES: see `standingMinGames`. */
export const STANDING_MIN_GAMES_DEFAULT = 10;

/**
 * Games before a player is ranked for the profile badges.
 *
 * A separate threshold from RANKED_MIN_GAMES, because the two answer different
 * questions. Three games is enough for a rating to be worth showing. It is
 * nowhere near enough for a per-match average, which is what every badge is:
 * divide three games of anything by three and the winner is usually whoever
 * has played least, which is exactly what the board kept showing.
 */
export function standingMinGames(db: DB): number {
  const raw = Number(getSetting(db, 'standing_min_games'));
  return Number.isInteger(raw) && raw > 0 ? raw : STANDING_MIN_GAMES_DEFAULT;
}

/** How many places earn a rank BADGE on a profile. Not what decides whether a
 *  standing is returned at all: playerStandings answers for every metric. */
export const STANDING_TOP = 5;

export interface Standing {
  rank: number;
  of: number;
  /**
   * Percentile rank against the same field, 0 to 100.
   *
   * The textbook formula, `(below + half of those level with you, self
   * included) / of`, rather than anything derived from `rank` alone. Ties are
   * the reason. Counting only those strictly below would put a player who
   * leads a field where everyone is level at the 0th percentile, and
   * `(of - rank) / (of - 1)` would put all of them at the 100th. Both are
   * wrong about the same situation, which is common here: on a quiet season
   * whole columns tie. The midrank puts that field at 50, which is what an
   * undifferentiated field means, and leaves a clear leader of twenty at 98.
   *
   * Meaningless at `of` 1, where it is 50 by the same formula: a sole
   * qualifier IS the distribution. The UI suppresses it rather than claiming
   * a player is averagely good at something nobody else has done.
   */
  pct: number;
}

/** Fixed match_players columns that are achievements. `ff` is left out on
 *  purpose: topping friendly fire is not a standing anyone wants shown. */
const FIXED_KEYS = ['sidmg', 'sikill', 'ck', 'rev'] as const;

/**
 * Where one player stands this season, among players past the badge gate
 * only, for every metric they have scored in.
 *
 * Every metric, not only the top five, so a profile can tell #6 of 40 from
 * #39 of 40. STANDING_TOP is the UI's test for which of them earns a badge.
 *
 * Counts are ranked PER MATCH, as a MEDIAN. A season total mostly ranks who
 * has played the most, and a mean is moved by exactly the one enormous night
 * it should resist. The median is also the figure each badge sits beside on
 * the profile: a badge that ranks a different number from the one it is next
 * to is worse than no badge. Win rate and boomer % are pooled rates and rank
 * as they are.
 *
 * Only `high_good` public stats rank: a "#1 in times skeeted" badge is what
 * the self visibility rule exists to prevent, and a neutral stat (a
 * denominator or a breakdown) is not an achievement. A zero never ranks, so a
 * stat nobody has recorded cannot hand out a #1.
 *
 * Ties share a rank (1, 1, 3), so two players on the same figure are shown as
 * equal rather than ordered by whatever the database returned first.
 *
 * Empty for a player short of `standingMinGames`, and the comparison field is
 * the same set: someone who does not qualify for a badge does not count
 * towards anyone else's `of` either, so the denominator is always the number
 * of people the rank was actually taken against.
 */
export function playerStandings(db: DB, seasonId: number, steamid: string): Record<string, Standing> {
  const ratings = db.prepare(
    `SELECT pr.player_id AS steamid, pr.wins, pr.losses,
            (SELECT COUNT(*) FROM rating_history rh WHERE rh.player_id = pr.player_id AND rh.season_id = pr.season_id) AS games
     FROM player_ratings pr WHERE pr.season_id = ?`,
  ).all(seasonId) as { steamid: string; wins: number; losses: number; games: number }[];
  const ranked = ratings.filter((r) => r.games >= standingMinGames(db));
  if (!ranked.some((r) => r.steamid === steamid)) return {};

  // One row per match, not a SUM, because the metrics below are MEDIANS.
  // `stats_json IS NOT NULL` is the captured test for the fixed columns; see
  // FIXED_STAT_KEYS in statKeys.ts.
  const fixedRows = db.prepare(
    `SELECT mp.player_id AS steamid, mp.si_damage AS sidmg, mp.si_kills AS sikill,
            mp.common_kills AS ck, mp.revives AS rev
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE m.season_id = ? AND m.state = 'completed' AND mp.stats_json IS NOT NULL`,
  ).all(seasonId) as ({ steamid: string } & Record<string, number>)[];
  const skillRows = db.prepare(
    `SELECT mps.player_id AS steamid, mps.stat, mps.value
     FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
     WHERE m.season_id = ? AND m.state = 'completed'`,
  ).all(seasonId) as { steamid: string; stat: string; value: number }[];

  const rankable = new Set(
    STAT_DEFS.filter((d) => d.visibility === 'public' && d.direction === 'high_good').map((d) => d.key),
  );
  const samplesBy = new Map<string, Map<string, number[]>>();
  const sample = (id: string, key: string, value: number) => {
    let bags = samplesBy.get(id);
    if (!bags) { bags = new Map(); samplesBy.set(id, bags); }
    const bag = bags.get(key);
    if (bag) bag.push(value);
    else bags.set(key, [value]);
  };
  for (const r of fixedRows) for (const k of FIXED_KEYS) sample(r.steamid, k, r[k]);
  // boomer_spawns and boom_successes are not rankable themselves but are the
  // two inputs to boomer_rate, so they are sampled and summed rather than
  // ranked. Everything else that is not rankable is dropped here.
  const POOLED_INPUTS = ['boomer_spawns', 'boom_successes'];
  for (const r of skillRows) {
    if (rankable.has(r.stat) || POOLED_INPUTS.includes(r.stat)) sample(r.steamid, r.stat, r.value);
  }

  /**
   * What a metric is ranked on: the median a badge sits beside, with the mean
   * behind it to break ties.
   *
   * The median alone cannot order most of this board. Measured against the
   * live season, 13 of the 29 rankable stats have three or fewer distinct
   * medians across the whole ranked field, because their per-match counts are
   * small integers: every crown but one is a median of 0, and `rev` puts 14 of
   * 15 players in the top five. The mean separates them, and by the same
   * thing the median measures, how much of it they do per match.
   *
   * Rates rank on themselves. `mean` is set to the rate so one comparator
   * serves both without a special case.
   */
  interface Metric { median: number; mean: number }

  /** Median first, mean behind it. Positive when `a` outranks `b`. */
  const compare = (a: Metric, b: Metric) => a.median - b.median || a.mean - b.mean;

  /**
   * Every metric for one player, absent where it has no denominator.
   *
   * Win rate and boomer % are POOLED ratios. A median of per-match rates would
   * weigh a one-boomer night the same as a four-boomer night.
   */
  const metricsOf = (r: (typeof ranked)[number]): Record<string, Metric> => {
    const out: Record<string, Metric> = {};
    const decided = r.wins + r.losses;
    if (decided > 0) {
      const winrate = r.wins / decided;
      out.winrate = { median: winrate, mean: winrate };
    }
    const bags = samplesBy.get(r.steamid);
    if (!bags) return out;
    for (const [k, values] of bags) {
      if (!rankable.has(k) && !(FIXED_KEYS as readonly string[]).includes(k)) continue;
      out[k] = {
        median: quantiles(values)!.p50,
        mean: values.reduce((a, b) => a + b, 0) / values.length,
      };
    }
    const sum = (k: string) => (bags.get(k) ?? []).reduce((a, b) => a + b, 0);
    const spawns = sum('boomer_spawns');
    if (spawns > 0) {
      const rate = sum('boom_successes') / spawns;
      out.boomer_rate = { median: rate, mean: rate };
    }
    return out;
  };

  const all = ranked.map((r) => ({ steamid: r.steamid, m: metricsOf(r) }));
  const mine = all.find((x) => x.steamid === steamid)!.m;
  const out: Record<string, Standing> = {};
  for (const [key, metric] of Object.entries(mine)) {
    // Gated on the mean, not on the median. A player who crowns in a third of
    // their matches has a median of 0 and a real place on that board; gating
    // on the median would tell them nothing about a stat they do score in.
    if (!(metric.mean > 0)) continue;
    const field = all.map((x) => x.m[key]).filter((v): v is Metric => v !== undefined);
    const above = field.filter((v) => compare(v, metric) > 0).length;
    const level = field.filter((v) => compare(v, metric) === 0).length;
    out[key] = {
      rank: 1 + above,
      of: field.length,
      pct: Math.round(100 * (field.length - above - level + level / 2) / field.length),
    };
  }
  return out;
}
