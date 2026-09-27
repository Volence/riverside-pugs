import type { DB } from './db.js';
import { settingNumber } from './settings.js';

/**
 * Weekly awards, computed from the live tables for any week.
 *
 * Season boards rank totals, so the same heavy players top everything. The
 * weekly awards reset every Monday and cover many categories so that someone
 * who plays a few nights has something to reach. Every stat award names two
 * winners: the best per-match average among players with enough games, and
 * the biggest total. Nothing here writes; weeklyStore.ts freezes a closed
 * week so later voids cannot rewrite who won.
 */

export type AwardGroup = 'survivor' | 'infected' | 'overall' | 'shame';
export type AwardKind = 'avg' | 'total' | 'single';
export interface Winner { steamid: string; name: string; value: number; games: number; detail: string | null }
export interface AwardResult { key: string; label: string; group: AwardGroup; kind: AwardKind; winners: Winner[] }
export interface AwardDef { key: string; label: string; group: AwardGroup }

type FixedColumn = 'si_damage' | 'si_kills' | 'common_kills' | 'revives';
interface StatAward extends AwardDef { fixed?: FixedColumn; stats?: string[] }

/** Stat awards: an average and a total each. Order is display order. */
const STAT_AWARDS: StatAward[] = [
  { key: 'si_damage', label: 'SI damage', group: 'survivor', fixed: 'si_damage' },
  { key: 'si_kills', label: 'SI kills', group: 'survivor', fixed: 'si_kills' },
  { key: 'common_kills', label: 'Common kills', group: 'survivor', fixed: 'common_kills' },
  { key: 'revives', label: 'Revives', group: 'survivor', fixed: 'revives' },
  { key: 'skeets', label: 'Skeets', group: 'survivor', stats: ['skeets'] },
  { key: 'skeet_assists', label: 'Skeet assists', group: 'survivor', stats: ['skeet_assists'] },
  { key: 'boomer_pops', label: 'Boomer pops', group: 'survivor', stats: ['boomer_pops'] },
  // A draw crown (the witch took chip damage first) is still a crown.
  { key: 'crowns', label: 'Witch crowns', group: 'survivor', stats: ['crowns', 'draw_crowns'] },
  { key: 'rock_skeets', label: 'Rock skeets', group: 'survivor', stats: ['rock_skeets'] },
  { key: 'tongue_clears', label: 'Tongue clears', group: 'survivor', stats: ['tongue_clears'] },
  { key: 'insta_clears', label: 'Insta clears', group: 'survivor', stats: ['insta_clears'] },
  { key: 'tank_damage', label: 'Tank damage', group: 'survivor', stats: ['tank_damage'] },
  { key: 'damage_as_si', label: 'Damage as SI', group: 'infected', stats: ['damage_as_si'] },
  { key: 'dps_landed', label: 'Damage pounces', group: 'infected', stats: ['dps_landed'] },
  { key: 'pounce_damage', label: 'Pounce damage', group: 'infected', stats: ['pounce_damage_high'] },
  { key: 'quad_caps', label: 'Quad caps', group: 'infected', stats: ['quad_caps'] },
  { key: 'booms', label: 'Booms landed', group: 'infected', stats: ['boom_successes'] },
  { key: 'rocks', label: 'Tank rocks landed', group: 'infected', stats: ['tank_rocks_landed'] },
  { key: 'punches', label: 'Tank punches', group: 'infected', stats: ['tank_punches'] },
  { key: 'hunter_damage', label: 'Hunter damage', group: 'infected', stats: ['dmg_as_hunter'] },
  { key: 'smoker_damage', label: 'Smoker damage', group: 'infected', stats: ['dmg_as_smoker'] },
];

/** Single-winner awards, filled in by computeSingles (Task 3). */
const SINGLE_AWARDS: AwardDef[] = [];

export const AWARDS: AwardDef[] = [
  ...STAT_AWARDS.map(({ key, label, group }) => ({ key, label, group })),
  ...SINGLE_AWARDS,
];

export function awardDef(key: string): AwardDef | undefined {
  return AWARDS.find((a) => a.key === key);
}

const DAY_MS = 86_400_000;
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** The Monday (UTC) of the week `d` falls in, as 'YYYY-MM-DD'. */
export function weekStartOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;   // Monday 0 .. Sunday 6
  return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY_MS));
}

export function addWeeks(week: string, n: number): string {
  return ymd(new Date(Date.parse(`${week}T00:00:00Z`) + n * 7 * DAY_MS));
}

/** In the form datetime('now') writes, so string comparison is correct. */
export function weekBounds(week: string): { from: string; to: string } {
  return { from: `${week} 00:00:00`, to: `${addWeeks(week, 1)} 00:00:00` };
}

export function weeklyMinGames(db: DB): number {
  // settingNumber, not Number(): the documented reader for numeric settings,
  // so a blank or out-of-range row falls back rather than reading as 0.
  return settingNumber(db, 'weekly_min_games', 5, { min: 1, max: 50, integer: true });
}

/** The matches that count for a week, as a reusable SQL fragment. */
export const WEEK_MATCHES =
  "SELECT id FROM matches WHERE state = 'completed' AND voided_at IS NULL AND ended_at >= ? AND ended_at < ?";

interface PlayerGames { steamid: string; name: string; games: number }

export function playerGames(db: DB, week: string): Map<string, PlayerGames> {
  const { from, to } = weekBounds(week);
  const rows = db.prepare(
    `SELECT mp.player_id AS steamid, p.name, COUNT(*) AS games
     FROM match_players mp JOIN players p ON p.steamid = mp.player_id
     WHERE mp.match_id IN (${WEEK_MATCHES})
     GROUP BY mp.player_id`,
  ).all(from, to) as PlayerGames[];
  return new Map(rows.map((r) => [r.steamid, r]));
}

/** Everyone holding the highest value, if it is above zero. */
export function topOf<T extends { value: number }>(rows: T[]): T[] {
  const best = Math.max(0, ...rows.map((r) => r.value));
  if (!(best > 0)) return [];
  return rows.filter((r) => r.value === best);
}

function statTotals(db: DB, week: string, a: StatAward): Map<string, number> {
  const { from, to } = weekBounds(week);
  const rows = a.fixed
    ? db.prepare(
      `SELECT player_id AS steamid, SUM(${a.fixed}) AS v FROM match_players
       WHERE match_id IN (${WEEK_MATCHES}) GROUP BY player_id`,
    ).all(from, to)
    : db.prepare(
      `SELECT player_id AS steamid, SUM(value) AS v FROM match_player_stats
       WHERE match_id IN (${WEEK_MATCHES}) AND stat IN (${a.stats!.map(() => '?').join(',')})
       GROUP BY player_id`,
    ).all(from, to, ...a.stats!);
  return new Map((rows as { steamid: string; v: number }[]).map((r) => [r.steamid, r.v]));
}

const winner = (g: PlayerGames, value: number, detail: string | null = null): Winner =>
  ({ steamid: g.steamid, name: g.name, value, games: g.games, detail });

export function computeWeek(db: DB, week: string): AwardResult[] {
  const games = playerGames(db, week);
  const min = weeklyMinGames(db);
  const out: AwardResult[] = [];
  for (const a of STAT_AWARDS) {
    const totals = statTotals(db, week, a);
    const rows = [...games.values()].map((g) => ({ g, total: totals.get(g.steamid) ?? 0 }));
    const avg = topOf(rows.filter((r) => r.g.games >= min).map((r) => ({ ...r, value: r.total / r.g.games })));
    const tot = topOf(rows.map((r) => ({ ...r, value: r.total })));
    const base = { key: a.key, label: a.label, group: a.group };
    if (avg.length) out.push({ ...base, kind: 'avg', winners: avg.map((r) => winner(r.g, r.value)) });
    if (tot.length) out.push({ ...base, kind: 'total', winners: tot.map((r) => winner(r.g, r.value)) });
  }
  return out;
}
