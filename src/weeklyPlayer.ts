import type { DB } from './db.js';
import { completedPug } from './matchKinds.js';
import { STAT_AWARDS, playerGames, statTotals, weekStartOf, weeklyMinGames, type AwardGroup } from './weeklyAwards.js';
import { frozenWeek } from './weeklyStore.js';

/**
 * One player's place on a weekly board (Lulu's request, 2026-10-23): for every
 * stat award, their own per-game average and total with a rank among everyone
 * who played that week and the gap to the leader, so a player can see how
 * close they are to showing up on the board.
 *
 * The numbers come from the same queries the board uses (playerGames,
 * statTotals, the weekly minimum), so "1st" here means the board shows them.
 * A past week is recomputed from the live tables; the frozen board stays the
 * record of who won, and a later void can make the two differ slightly.
 */

/** Competition ranking: 1 + how many have strictly more. Ties share a rank. */
export interface Standing { value: number; rank: number; of: number; leader: number; gap: number }
export interface PlayerStat {
  key: string; label: string; group: AwardGroup;
  /** Null when the player has no games that week. The rank is null under the minimum games. */
  avg: (Omit<Standing, 'rank'> & { rank: number | null }) | null;
  total: Standing | null;
}
export interface PlayerWeek { week: string; games: number; minGames: number; qualifies: boolean; players: number; stats: PlayerStat[] }

function standing(value: number, all: number[]): Standing {
  const leader = Math.max(0, ...all);
  return { value, rank: 1 + all.filter((v) => v > value).length, of: all.length, leader, gap: Math.max(0, leader - value) };
}

export function playerWeek(db: DB, week: string, steamid: string): PlayerWeek {
  const games = playerGames(db, week);
  const min = weeklyMinGames(db);
  const mine = games.get(steamid)?.games ?? 0;
  const stats: PlayerStat[] = [];
  for (const a of STAT_AWARDS) {
    const totals = statTotals(db, week, a);
    const base = { key: a.key, label: a.label, group: a.group };
    if (mine === 0) { stats.push({ ...base, avg: null, total: null }); continue; }
    const all = [...games.values()];
    const totalOf = (id: string) => totals.get(id) ?? 0;
    const total = standing(totalOf(steamid), all.map((g) => totalOf(g.steamid)));
    const gated = all.filter((g) => g.games >= min).map((g) => totalOf(g.steamid) / g.games);
    const myAvg = totalOf(steamid) / mine;
    const ranked = standing(myAvg, gated);
    // Under the minimum the average is shown but not ranked; the leader and
    // gap still read against the qualified players, which is the board's.
    const avg = mine >= min ? ranked : { value: myAvg, rank: null, of: gated.length, leader: ranked.leader, gap: Math.max(0, ranked.leader - myAvg) };
    stats.push({ ...base, avg, total });
  }
  return { week, games: mine, minGames: min, qualifies: mine >= min, players: games.size, stats };
}

/** The profile's week rows: games, a few headline stats, and the awards won. */
export interface PlayerWeekRow {
  week: string; live: boolean; games: number;
  skeets: number; commonKills: number; damageAsSi: number;
  awards: { key: string; label: string; kind: 'avg' | 'total' | 'single' }[];
}

const HEADLINE_STATS = ['skeets', 'damage_as_si'];

export function playerWeekHistory(db: DB, steamid: string, now: Date = new Date()): PlayerWeekRow[] {
  const matches = db.prepare(
    `SELECT m.id, m.ended_at, mp.common_kills FROM matches m
     JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = ?
     WHERE ${completedPug('m')} AND m.voided_at IS NULL AND m.ended_at IS NOT NULL`,
  ).all(steamid) as { id: number; ended_at: string; common_kills: number }[];
  if (!matches.length) return [];
  const statRows = db.prepare(
    `SELECT match_id, stat, value FROM match_player_stats
     WHERE player_id = ? AND stat IN (${HEADLINE_STATS.map(() => '?').join(',')})`,
  ).all(steamid, ...HEADLINE_STATS) as { match_id: number; stat: string; value: number }[];
  const byMatch = new Map<number, Record<string, number>>();
  for (const r of statRows) byMatch.set(r.match_id, { ...(byMatch.get(r.match_id) ?? {}), [r.stat]: (byMatch.get(r.match_id)?.[r.stat] ?? 0) + r.value });
  const current = weekStartOf(now);
  const weeks = new Map<string, PlayerWeekRow>();
  for (const m of matches) {
    // ended_at is "YYYY-MM-DD HH:MM:SS" UTC; the week turns Monday 12:00 UTC.
    const week = weekStartOf(new Date(`${m.ended_at.replace(' ', 'T')}Z`));
    const w = weeks.get(week) ?? { week, live: week === current, games: 0, skeets: 0, commonKills: 0, damageAsSi: 0, awards: [] };
    const s = byMatch.get(m.id) ?? {};
    w.games++; w.commonKills += m.common_kills ?? 0; w.skeets += s.skeets ?? 0; w.damageAsSi += s.damage_as_si ?? 0;
    weeks.set(week, w);
  }
  for (const w of weeks.values()) {
    if (w.live) continue;   // the live week has no winners yet; the board shows the race
    const f = frozenWeek(db, w.week);
    if (!f) continue;
    w.awards = f.awards.filter((a) => a.group !== 'shame' && a.winners.some((x) => x.steamid === steamid))
      .map((a) => ({ key: a.key, label: a.label, kind: a.kind }));
  }
  return [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week));
}

