import type { DB } from './db.js';
import { sideName, sidesOf } from './bookings/bookings.js';
import { getTeam } from './teams/teams.js';

/** One team of a booked game, as the match pages name it: a draft entry's
 *  snapshot, or the registered team's own name and tag. */
export interface BookedTeam { name: string; tag: string | null }

/** Who a booked game (a scrim or a tournament game) was between, by match
 *  team, and the event it was played for. Null for a PUG or any game with no
 *  booking behind it, so the pages keep their plain "Team A" / "Team B". */
export interface BookedSides {
  kind: 'scrim' | 'tournament';
  a: BookedTeam;
  b: BookedTeam;
  /** The tournament this game belongs to, with the event match page it was
   *  played under; null for a scrim. */
  event: { slug: string; name: string; matchId: number } | null;
}

/**
 * The booking sides of a game turned into its match teams. matches.booking_side_a
 * says which booking side played as match team a (src/bookings/games.ts); a game
 * adopted before that column existed reads as side a, the same default the
 * adoption itself uses.
 */
export function bookedSidesFor(db: DB, matchId: number): BookedSides | null {
  const m = db.prepare(
    `SELECT m.booking_side_a AS sideA, b.id AS bookingId, b.purpose
       FROM matches m JOIN bookings b ON b.id = m.booking_id WHERE m.id = ?`,
  ).get(matchId) as { sideA: 'a' | 'b' | null; bookingId: number; purpose: string } | undefined;
  if (!m || (m.purpose !== 'scrim' && m.purpose !== 'tournament')) return null;
  const sides = sidesOf(db, m.bookingId);
  const sa = sides.find((s) => s.side === 'a');
  const sb = sides.find((s) => s.side === 'b');
  if (!sa || !sb) return null;
  const team = (s: typeof sa): BookedTeam => ({
    name: sideName(db, s),
    tag: s.tag ?? (s.team_id !== null ? getTeam(db, s.team_id)?.tag ?? null : null),
  });
  const [teamA, teamB] = (m.sideA ?? 'a') === 'a' ? [team(sa), team(sb)] : [team(sb), team(sa)];
  const event = m.purpose === 'tournament'
    ? (db.prepare(
        `SELECT e.slug, e.name, g.event_match_id AS matchId
           FROM event_games g JOIN event_matches em ON em.id = g.event_match_id JOIN events e ON e.id = em.event_id
          WHERE g.match_id = ? ORDER BY g.id DESC LIMIT 1`,
      ).get(matchId) as { slug: string; name: string; matchId: number } | undefined) ?? null
    : null;
  return { kind: m.purpose as BookedSides['kind'], a: teamA, b: teamB, event };
}
