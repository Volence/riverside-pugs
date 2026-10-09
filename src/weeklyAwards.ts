import type { DB } from './db.js';
import { completedPug } from './matchKinds.js';
import { displaySr } from './rating.js';
import { settingNumber } from './settings.js';
import type { EndorseKind } from './endorsements.js';

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

export type AwardGroup = 'survivor' | 'infected' | 'overall' | 'endorsed' | 'shame';
export type AwardKind = 'avg' | 'total' | 'single';
export interface Winner { steamid: string; name: string; value: number; games: number; detail: string | null }
export interface AwardResult { key: string; label: string; group: AwardGroup; kind: AwardKind; winners: Winner[] }
export interface AwardDef { key: string; label: string; group: AwardGroup }

type FixedColumn = 'si_damage' | 'si_kills' | 'common_kills' | 'revives' | 'ff_dealt';
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
  { key: 'pounce_damage', label: 'Damage from pounces', group: 'infected', stats: ['pounce_damage_high'] },
  { key: 'quad_caps', label: 'Quad caps', group: 'infected', stats: ['quad_caps'] },
  { key: 'booms', label: 'Booms landed', group: 'infected', stats: ['boom_successes'] },
  { key: 'rocks', label: 'Tank rocks landed', group: 'infected', stats: ['tank_rocks_landed'] },
  { key: 'punches', label: 'Tank punches', group: 'infected', stats: ['tank_punches'] },
  { key: 'hunter_damage', label: 'Hunter damage', group: 'infected', stats: ['dmg_as_hunter'] },
  { key: 'smoker_damage', label: 'Smoker damage', group: 'infected', stats: ['dmg_as_smoker'] },
];

/** Single-winner awards. Order is display order. */
const SINGLE_AWARDS: AwardDef[] = [
  { key: 'sr_climb', label: 'Biggest SR climb', group: 'overall' },
  { key: 'wins', label: 'Most wins', group: 'overall' },
  { key: 'win_streak', label: 'Longest win streak', group: 'overall' },
  { key: 'matches', label: 'Iron man', group: 'overall' },
  { key: 'win_rate', label: 'Best win rate', group: 'overall' },
  { key: 'slow_ready', label: 'Slowest ready-up', group: 'shame' },
  { key: 'friendly_fire', label: 'Friendly fire', group: 'shame' },
  { key: 'group_hug', label: 'Group hug', group: 'shame' },
];

/** Endorsement awards, one per kind plus the total. Order is display order. */
const ENDORSE_AWARDS: (AwardDef & { kind: EndorseKind | null })[] = [
  { key: 'endorsed_total', label: 'Most endorsed', group: 'endorsed', kind: null },
  { key: 'endorsed_caller', label: 'Top caller', group: 'endorsed', kind: 'caller' },
  { key: 'endorsed_clutch', label: 'Most clutch', group: 'endorsed', kind: 'clutch' },
  { key: 'endorsed_vibes', label: 'Best vibes', group: 'endorsed', kind: 'vibes' },
];

export const AWARDS: AwardDef[] = [
  ...STAT_AWARDS.map(({ key, label, group }) => ({ key, label, group })),
  ...SINGLE_AWARDS,
  ...ENDORSE_AWARDS.map(({ key, label, group }) => ({ key, label, group })),
];

export function awardDef(key: string): AwardDef | undefined {
  return AWARDS.find((a) => a.key === key);
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

// US play peaks 00:00-07:00 UTC (Sunday evening into early Monday US time), so
// a Monday 00:00 UTC cut split that session across two weeks; noon UTC is the
// quietest hour, so the week (and the Discord post) turns over there instead.
export const WEEK_START_HOUR = 12;
const START_HHMMSS = `${String(WEEK_START_HOUR).padStart(2, '0')}:00:00`;

/** The Monday (UTC) of the week containing instant `d`, under the
 *  WEEK_START_HOUR rule: shift back by that many hours, then take the
 *  Monday of the calendar week the shifted instant falls on. */
export function weekStartOf(d: Date): string {
  const shifted = new Date(d.getTime() - WEEK_START_HOUR * HOUR_MS);
  const day = (shifted.getUTCDay() + 6) % 7;   // Monday 0 .. Sunday 6
  return ymd(new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - day * DAY_MS));
}

export function addWeeks(week: string, n: number): string {
  return ymd(new Date(Date.parse(`${week}T00:00:00Z`) + n * 7 * DAY_MS));
}

/** In the form datetime('now') writes, so string comparison is correct. */
export function weekBounds(week: string): { from: string; to: string } {
  return { from: `${week} ${START_HHMMSS}`, to: `${addWeeks(week, 1)} ${START_HHMMSS}` };
}

/** True for a canonical week id: 'YYYY-MM-DD' shape, a real calendar date,
 *  and that date is a Monday (UTC). Use this wherever a week id from the
 *  outside world (a query param, a stored row, a CLI arg) needs checking;
 *  it never calls weekStartOf, so a calendar-invalid id such as
 *  '2026-13-01' or '2026-01-32' cannot reach its toISOString() and throw. */
export function isWeekStart(week: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return false;
  const parsed = Date.parse(`${week}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).getUTCDay() === 1;
}

export function weeklyMinGames(db: DB): number {
  // settingNumber, not Number(): the documented reader for numeric settings,
  // so a blank or out-of-range row falls back rather than reading as 0.
  return settingNumber(db, 'weekly_min_games', 5, { min: 1, max: 50, integer: true });
}

/** The matches that count for a week, as a reusable SQL fragment. */
export const WEEK_MATCHES =
  `SELECT id FROM matches WHERE ${completedPug()} AND voided_at IS NULL AND ended_at >= ? AND ended_at < ?`;

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

interface Result { steamid: string; winner: 'a' | 'b' | 'draw' | null; team: 'a' | 'b' }

/** Each player's matches this week in order, as W, L or D. */
function resultsByPlayer(db: DB, week: string): Map<string, ('W' | 'L' | 'D')[]> {
  const { from, to } = weekBounds(week);
  const rows = db.prepare(
    `SELECT mp.player_id AS steamid, m.winner, mp.team
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE m.id IN (${WEEK_MATCHES})
     ORDER BY m.ended_at, m.id`,
  ).all(from, to) as Result[];
  const out = new Map<string, ('W' | 'L' | 'D')[]>();
  for (const r of rows) {
    const c = r.winner === r.team ? 'W' : r.winner === 'a' || r.winner === 'b' ? 'L' : 'D';
    out.set(r.steamid, [...(out.get(r.steamid) ?? []), c]);
  }
  return out;
}

function longestRun(seq: string[]): number {
  let best = 0; let run = 0;
  for (const c of seq) { run = c === 'W' ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}

/** Displayed SR after the last rated match of the week minus before the first. */
function srClimbs(db: DB, week: string): Map<string, number> {
  const { from, to } = weekBounds(week);
  const rows = db.prepare(
    `SELECT rh.player_id AS steamid, rh.mu_before, rh.sigma_before, rh.mu_after, rh.sigma_after
     FROM rating_history rh JOIN matches m ON m.id = rh.match_id
     WHERE m.id IN (${WEEK_MATCHES})
     ORDER BY m.ended_at, m.id`,
  ).all(from, to) as { steamid: string; mu_before: number; sigma_before: number; mu_after: number; sigma_after: number }[];
  const first = new Map<string, number>(); const last = new Map<string, number>();
  for (const r of rows) {
    if (!first.has(r.steamid)) first.set(r.steamid, displaySr(r.mu_before, r.sigma_before));
    last.set(r.steamid, displaySr(r.mu_after, r.sigma_after));
  }
  return new Map([...first].map(([id, sr]) => [id, last.get(id)! - sr]));
}

function slowReadyAverages(db: DB, week: string): Map<string, number> {
  const { from, to } = weekBounds(week);
  const rows = db.prepare(
    `SELECT player_id AS steamid, AVG(seconds) AS v FROM match_readyup_players
     WHERE match_id IN (${WEEK_MATCHES}) GROUP BY player_id`,
  ).all(from, to) as { steamid: string; v: number }[];
  return new Map(rows.map((r) => [r.steamid, r.v]));
}

function computeSingles(db: DB, week: string, games: Map<string, PlayerGames>, min: number): AwardResult[] {
  const results = resultsByPlayer(db, week);
  const climbs = srClimbs(db, week);
  const ready = slowReadyAverages(db, week);
  const ff = statTotals(db, week, { key: '', label: '', group: 'shame', fixed: 'ff_dealt' });
  const hugs = statTotals(db, week, { key: '', label: '', group: 'shame', stats: ['times_quadded'] });
  const all = [...games.values()];
  const gated = all.filter((g) => g.games >= min);
  const record = (id: string) => {
    const seq = results.get(id) ?? [];
    return { w: seq.filter((c) => c === 'W').length, l: seq.filter((c) => c === 'L').length, seq };
  };
  const pick: Record<string, Winner[]> = {
    sr_climb: topOf(gated.map((g) => ({ g, value: climbs.get(g.steamid) ?? 0 }))).map((r) => winner(r.g, r.value)),
    wins: topOf(all.map((g) => ({ g, value: record(g.steamid).w }))).map((r) => winner(r.g, r.value)),
    win_streak: topOf(all.map((g) => ({ g, value: longestRun(record(g.steamid).seq) }))).map((r) => winner(r.g, r.value)),
    matches: topOf(all.map((g) => ({ g, value: g.games }))).map((r) => winner(r.g, r.value)),
    win_rate: topOf(all
      .map((g) => ({ g, ...record(g.steamid) }))
      .filter((r) => r.w + r.l >= min)
      .map((r) => ({ ...r, value: r.w / (r.w + r.l) })))
      .map((r) => winner(r.g, r.value, `${r.w}-${r.l}`)),
    slow_ready: topOf(gated.map((g) => ({ g, value: ready.get(g.steamid) ?? 0 }))).map((r) => winner(r.g, r.value)),
    friendly_fire: topOf(gated.map((g) => ({ g, value: (ff.get(g.steamid) ?? 0) / g.games }))).map((r) => winner(r.g, r.value)),
    group_hug: topOf(gated.map((g) => ({ g, value: (hugs.get(g.steamid) ?? 0) / g.games }))).map((r) => winner(r.g, r.value)),
  };
  return SINGLE_AWARDS
    .filter((a) => pick[a.key].length > 0)
    .map((a) => ({ key: a.key, label: a.label, group: a.group, kind: 'single' as const, winners: pick[a.key] }));
}

/**
 * Endorsement awards go to whoever the most DIFFERENT people endorsed, so two
 * friends trading endorsements every match cannot buy one; a tie on that goes
 * to the bigger count. The value is the number of people, the detail the count.
 *
 * An endorsement counts for the week it was GIVEN, not the week its match
 * ended: the window stays open for a day after a match, and the week freezes
 * at Monday noon, so a Sunday night match's endorsements would otherwise land
 * after its week was already frozen and never count anywhere.
 */
function computeEndorsed(db: DB, week: string, games: Map<string, PlayerGames>): AwardResult[] {
  const { from, to } = weekBounds(week);
  const rows = db.prepare(
    `SELECT e.to_id AS steamid, p.name, e.kind, e.from_id
     FROM endorsements e
     JOIN matches m ON m.id = e.match_id AND ${completedPug('m')} AND m.voided_at IS NULL
     JOIN players p ON p.steamid = e.to_id
     WHERE e.created_at >= ? AND e.created_at < ?`,
  ).all(from, to) as { steamid: string; name: string; kind: EndorseKind; from_id: string }[];
  const out: AwardResult[] = [];
  for (const a of ENDORSE_AWARDS) {
    const by = new Map<string, { name: string; count: number; givers: Set<string> }>();
    for (const r of rows) {
      if (a.kind && r.kind !== a.kind) continue;
      const e = by.get(r.steamid) ?? { name: r.name, count: 0, givers: new Set<string>() };
      e.count++; e.givers.add(r.from_id);
      by.set(r.steamid, e);
    }
    const ranked = [...by].map(([steamid, e]) => ({ steamid, name: e.name, count: e.count, value: e.givers.size }));
    const most = topOf(ranked);
    const bestCount = Math.max(0, ...most.map((r) => r.count));
    const winners = most.filter((r) => r.count === bestCount).map((r): Winner => ({
      steamid: r.steamid, name: r.name, value: r.value,
      games: games.get(r.steamid)?.games ?? 0, detail: String(r.count),
    }));
    if (winners.length) out.push({ key: a.key, label: a.label, group: a.group, kind: 'single', winners });
  }
  return out;
}

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
  out.push(...computeSingles(db, week, games, min));
  out.push(...computeEndorsed(db, week, games));
  return out;
}
