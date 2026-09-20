import type { DB } from './db.js';
import { getSetting } from './settings.js';
import { STAT_DEFS } from './statKeys.js';

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

/** How many places earn a rank BADGE on a profile. No longer what decides
 *  whether a standing is returned at all: see playerStandings. */
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
 * Every metric, not only the top five. Truncating here meant a player outside
 * the top five was told nothing at all: #6 of 40 and #39 of 40 were both an
 * absent key, and the profile could not tell a near miss from a weakness. The
 * top five still gets the badge, but STANDING_TOP is now the UI's test for
 * that and not this function's test for whether to answer at all.
 *
 * Counts are ranked PER MATCH, not as totals. A season total mostly ranks who
 * has played the most, which is the same reason the profile's tiles prefer
 * rates. Win rate and boomer % are already rates and rank as they are.
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

  const fixed = db.prepare(
    `SELECT mp.player_id AS steamid, COUNT(*) AS matches,
            COALESCE(SUM(mp.si_damage),0) AS sidmg, COALESCE(SUM(mp.si_kills),0) AS sikill,
            COALESCE(SUM(mp.common_kills),0) AS ck, COALESCE(SUM(mp.revives),0) AS rev
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE m.season_id = ? AND m.state = 'completed'
     GROUP BY mp.player_id`,
  ).all(seasonId) as ({ steamid: string; matches: number } & Record<string, number>)[];
  const skill = db.prepare(
    `SELECT mps.player_id AS steamid, mps.stat, SUM(mps.value) AS total
     FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
     WHERE m.season_id = ? AND m.state = 'completed'
     GROUP BY mps.player_id, mps.stat`,
  ).all(seasonId) as { steamid: string; stat: string; total: number }[];

  const rankable = new Set(
    STAT_DEFS.filter((d) => d.visibility === 'public' && d.direction === 'high_good').map((d) => d.key),
  );
  const fixedBy = new Map(fixed.map((r) => [r.steamid, r]));
  const skillBy = new Map<string, Record<string, number>>();
  for (const r of skill) {
    const bag = skillBy.get(r.steamid) ?? {};
    bag[r.stat] = r.total;
    skillBy.set(r.steamid, bag);
  }

  /** Every metric for one player, absent where it has no denominator. */
  const metricsOf = (r: (typeof ranked)[number]): Record<string, number> => {
    const out: Record<string, number> = {};
    const decided = r.wins + r.losses;
    if (decided > 0) out.winrate = r.wins / decided;
    const f = fixedBy.get(r.steamid);
    const matches = f?.matches ?? 0;
    if (matches === 0) return out;
    for (const k of FIXED_KEYS) out[k] = (f?.[k] ?? 0) / matches;
    const bag = skillBy.get(r.steamid) ?? {};
    for (const [k, v] of Object.entries(bag)) if (rankable.has(k)) out[k] = v / matches;
    if ((bag.boomer_spawns ?? 0) > 0) out.boomer_rate = (bag.boom_successes ?? 0) / bag.boomer_spawns;
    return out;
  };

  const all = ranked.map((r) => ({ steamid: r.steamid, m: metricsOf(r) }));
  const mine = all.find((x) => x.steamid === steamid)!.m;
  const out: Record<string, Standing> = {};
  for (const [key, value] of Object.entries(mine)) {
    if (!(value > 0)) continue;
    const field = all.map((x) => x.m[key]).filter((v): v is number => v !== undefined);
    const above = field.filter((v) => v > value).length;
    const level = field.filter((v) => v === value).length;
    out[key] = {
      rank: 1 + above,
      of: field.length,
      pct: Math.round(100 * (field.length - above - level + level / 2) / field.length),
    };
  }
  return out;
}
