import type { DB } from './db.js';
import { STAT_DEFS } from './statKeys.js';

/** Games before a player holds a rank. Under this they are listed as
 *  provisional: one lucky night at high sigma should not top the board. */
export const RANKED_MIN_GAMES = 3;

/** How many places count as a standing worth showing on a profile. */
export const STANDING_TOP = 5;

export interface Standing { rank: number; of: number }

/** Fixed match_players columns that are achievements. `ff` is left out on
 *  purpose: topping friendly fire is not a standing anyone wants shown. */
const FIXED_KEYS = ['sidmg', 'sikill', 'ck', 'rev'] as const;

/**
 * Where one player stands this season, among RANKED players only, for every
 * metric in which they place in the top STANDING_TOP.
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
 * Empty for a provisional player: they are not on the board yet, so they do
 * not hold a place on it either.
 */
export function playerStandings(db: DB, seasonId: number, steamid: string): Record<string, Standing> {
  const ratings = db.prepare(
    `SELECT pr.player_id AS steamid, pr.wins, pr.losses,
            (SELECT COUNT(*) FROM rating_history rh WHERE rh.player_id = pr.player_id AND rh.season_id = pr.season_id) AS games
     FROM player_ratings pr WHERE pr.season_id = ?`,
  ).all(seasonId) as { steamid: string; wins: number; losses: number; games: number }[];
  const ranked = ratings.filter((r) => r.games >= RANKED_MIN_GAMES);
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
    const rank = 1 + field.filter((v) => v > value).length;
    if (rank <= STANDING_TOP) out[key] = { rank, of: field.length };
  }
  return out;
}
