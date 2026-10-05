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
