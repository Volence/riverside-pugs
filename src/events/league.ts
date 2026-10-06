import { circleRounds } from './roundRobin.js';
import type { Pairing } from './swiss.js';

/**
 * A league season (plan T2 Rulings 7, 18 to 20; owner 2026-10-05): a number
 * of rounds, one result per team per round, played some a week from a start
 * day. Pure, and imported by the web stage editor's season calculator, so it
 * must not import anything that reaches the database or node.
 */

/** Mirrors src/events/validate.ts LEAGUE_MATCHES_MAX (not imported: the web
 *  bundle must not pull in the validator). */
const MATCHES_MAX = 40;
const DAY = 86_400_000;

/** Full round robins back to back, every other one with sides swapped, cut
 *  at `rounds`. An odd field sits each team out once per cycle. */
export function repeatedRoundRobin(ids: number[], rounds: number): Pairing[] {
  const cycle = circleRounds(ids);
  const out: Pairing[] = [];
  for (let c = 0; out.length < rounds && cycle.length > 0; c++) {
    for (const r of cycle) {
      if (out.length >= rounds) break;
      out.push(c % 2 === 0 ? r : { pairs: r.pairs.map(([a, b]): [number, number] => [b, a]), bye: r.bye });
    }
  }
  return out;
}

export const leagueWeeks = (matches: number, perWeek: number): number => Math.ceil(matches / perWeek);
export const weekOfRound = (round: number, perWeek: number): number => Math.floor((round - 1) / perWeek) + 1;

const day = (iso: string): number => Date.parse(`${iso}T00:00:00.000Z`);
const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Week N runs 7 days from seasonStart + 7 x (N - 1), both ends inclusive. */
export function weekDates(seasonStart: string, week: number): { from: string; to: string } {
  const from = day(seasonStart) + 7 * (week - 1) * DAY;
  return { from: ymd(from), to: ymd(from + 6 * DAY) };
}

/** A league week as a scheduling window (plan T4 Ruling 4): the first day's
 *  midnight to the last second of the last day, UTC. */
export function weekWindow(seasonStart: string, round: number, perWeek: number): { from: string; to: string } {
  const w = weekDates(seasonStart, weekOfRound(round, perWeek));
  return { from: `${w.from}T00:00:00.000Z`, to: `${w.to}T23:59:59.000Z` };
}

/** A weekly pattern: the k-th match of every week on this weekday (0 Sunday
 *  to 6 Saturday) at this UTC time. */
export interface WeeklySlot { day: number; time: string }

/** The desk's "fill from a weekly pattern" (plan T4 Ruling 2): one row per
 *  round, its window the week, its default time the slot's weekday on or
 *  after the week's first day. A missing or unreadable slot leaves the
 *  round with no default. */
export function weeklyRoundTimes(o: { seasonStart: string; matches: number; perWeek: number; slots: WeeklySlot[] }): { round: number; at: string | null; from: string; to: string }[] {
  const out: { round: number; at: string | null; from: string; to: string }[] = [];
  for (let round = 1; round <= o.matches; round++) {
    const w = weekWindow(o.seasonStart, round, o.perWeek);
    const slot = o.slots[(round - 1) % o.perWeek];
    let at: string | null = null;
    if (slot && Number.isInteger(slot.day) && slot.day >= 0 && slot.day <= 6 && /^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) {
      const start = Date.parse(w.from);
      const offset = (slot.day - new Date(start).getUTCDay() + 7) % 7;
      at = new Date(start + offset * DAY + Number(slot.time.slice(0, 2)) * 3_600_000 + Number(slot.time.slice(3)) * 60_000).toISOString();
    }
    out.push({ round, at, from: w.from, to: w.to });
  }
  return out;
}

/** The fewest matches a week that fit `matches` into the full weeks from
 *  `from` to `to` (both inclusive), or null past 3 a week. */
export function perWeekFor(matches: number, from: string, to: string): number | null {
  const weeks = Math.floor((day(to) - day(from) + DAY) / (7 * DAY));
  if (weeks < 1) return null;
  const per = Math.ceil(matches / weeks);
  return per <= 3 ? per : null;
}

/** Byes per team over `matches` rounds with an odd field (each team sits
 *  once per `teams` rounds), and the match counts nearest `matches` at
 *  which everyone gets the same number. Null for an even field. */
export function byeSpread(matches: number, teams: number): { min: number; max: number; even: number[] } | null {
  if (teams % 2 === 0) return null;
  const min = Math.floor(matches / teams);
  const max = Math.ceil(matches / teams);
  const even = [...new Set([min * teams, max * teams])].filter((n) => n >= 1 && n <= MATCHES_MAX);
  return { min, max, even };
}
