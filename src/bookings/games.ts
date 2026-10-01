import type { DB } from '../db.js';
import { holdFor } from '../serverHolds.js';
import { getBooking, peopleOf, sideName, sidesOf, type BookingRow, type Side } from './bookings.js';

/**
 * Games inside a booked block.
 *
 * A booking holds one box for a stretch of time, and the two sides may play
 * several campaigns on it. Each of those is a game: its own `matches` row
 * (kind from the booking's purpose, visibility 'participants', booking_id
 * set), so it gets its own replay and stats like any match.
 *
 * Nothing on the site starts a booking game. The players ready up on the box
 * and the plugin's auto-track starts the match itself, exactly as a PUG that
 * was started in game, so it arrives through SelfStartedMatches. That path
 * asks bookingOnServer() whether a booking holds the box, and if one does the
 * match is filed under it instead of as a public PUG.
 *
 * Which booking side is match team a (ruling 2) is decided at adoption by
 * majority: the pairing of booking sides to match teams that puts more of the
 * booking's people on the team they booked with. A tie or nobody known goes
 * to booking side a. Stored as matches.booking_side_a.
 */

/** The open booking (not ending, state ready or active) holding this box. */
export function bookingOnServer(db: DB, serverId: number): BookingRow | null {
  const hold = holdFor(db, serverId);
  if (hold?.kind !== 'booking') return null;
  const b = getBooking(db, hold.rowId);
  return b && b.ending_at === null && (b.state === 'ready' || b.state === 'active') ? b : null;
}

/** Which booking side match team a is (ruling 2). */
export function bookingSideForTeamA(db: DB, bookingId: number, teamA: string[], teamB: string[]): Side {
  const sideOf = new Map(peopleOf(db, bookingId).map((p) => [p.steamid, p.side] as const));
  // Score: people of booking side a on match team a, plus people of booking
  // side b on match team b, against the opposite pairing.
  let straight = 0;
  let crossed = 0;
  for (const s of teamA) { const x = sideOf.get(s); if (x === 'a') straight++; else if (x === 'b') crossed++; }
  for (const s of teamB) { const x = sideOf.get(s); if (x === 'b') straight++; else if (x === 'a') crossed++; }
  return crossed > straight ? 'b' : 'a';
}

export interface BookingGameView {
  matchId: number;
  campaign: string;
  state: string;
  scoreA: number;
  scoreB: number;
  sideA: Side | null;
  /** matches.created_at: a game is adopted when it goes live, and an adopted
   *  match never stamps went_live_at (see SelfStartedMatches.commit). */
  startedAt: string;
  endedAt: string | null;
}

/** Every game of a booking, oldest first. */
export function bookingGames(db: DB, bookingId: number): BookingGameView[] {
  const rows = db.prepare(
    `SELECT id, campaign, state, team_a_score, team_b_score, booking_side_a, created_at, ended_at
       FROM matches WHERE booking_id = ? ORDER BY id`,
  ).all(bookingId) as {
    id: number; campaign: string; state: string; team_a_score: number; team_b_score: number;
    booking_side_a: Side | null; created_at: string; ended_at: string | null;
  }[];
  return rows.map((r) => ({
    matchId: r.id, campaign: r.campaign, state: r.state, scoreA: r.team_a_score, scoreB: r.team_b_score,
    sideA: r.booking_side_a, startedAt: r.created_at, endedAt: r.ended_at,
  }));
}

/** How many of a booking's games have finished: completed, through the
 *  game-ended path. An aborted game or one still live is not counted. */
export function gamesPlayed(db: DB, bookingId: number): number {
  return bookingGames(db, bookingId).filter((g) => g.state === 'completed').length;
}

/** The booking's game being played right now, if any. */
export function liveBookingGame(db: DB, bookingId: number): { id: number; token: string; campaign: string } | null {
  return (db.prepare("SELECT id, token, campaign FROM matches WHERE booking_id = ? AND state = 'live' ORDER BY id DESC LIMIT 1")
    .get(bookingId) as { id: number; token: string; campaign: string } | undefined) ?? null;
}

export interface TeamScrim {
  bookingId: number; opponent: string; startsAt: string; state: string;
  games: { matchId: number; campaign: string; state: string; us: number; them: number }[];
}

/** A team's Scrims tab (plan 4c, ruling 5): every booking the team was a
 *  side of, newest first, at most 50. Each game's score is oriented to the
 *  team's own side of the booking, via that game's own booking_side_a (ruling
 *  2: which match team is which booking side is decided per game, at
 *  adoption, so two games of the same booking can disagree). */
export function teamScrims(db: DB, teamId: number): TeamScrim[] {
  const rows = db.prepare(
    `SELECT b.id, b.state, b.starts_at, s.side
       FROM bookings b JOIN booking_sides s ON s.booking_id = b.id AND s.team_id = ?
       ORDER BY b.starts_at DESC, b.id DESC LIMIT 50`,
  ).all(teamId) as { id: number; state: string; starts_at: string; side: Side }[];
  return rows.map((r) => {
    const other = sidesOf(db, r.id).find((s) => s.side !== r.side)!;
    return {
      bookingId: r.id, opponent: sideName(db, other), startsAt: r.starts_at, state: r.state,
      games: bookingGames(db, r.id).map((g) => ({
        matchId: g.matchId, campaign: g.campaign, state: g.state,
        us: g.sideA === r.side ? g.scoreA : g.scoreB,
        them: g.sideA === r.side ? g.scoreB : g.scoreA,
      })),
    };
  });
}

/** Abort a live booking game because its booking ended. Returns the match
 *  token so the caller can unregister it, or null when the match is not a
 *  live booking game. ended_at is written in the same `YYYY-MM-DD HH:MM:SS`
 *  form as datetime('now') everywhere else. */
export function abortBookingGame(db: DB, matchId: number, now: Date): string | null {
  return db.transaction(() => {
    const row = db.prepare("SELECT token FROM matches WHERE id = ? AND booking_id IS NOT NULL AND state = 'live'")
      .get(matchId) as { token: string } | undefined;
    if (!row) return null;
    db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'booking_ended', ended_at = ? WHERE id = ? AND state = 'live'")
      .run(now.toISOString().replace('T', ' ').slice(0, 19), matchId);
    return row.token;
  })();
}
