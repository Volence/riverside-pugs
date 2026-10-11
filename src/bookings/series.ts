import type { DB } from '../db.js';
import { logBookingEvent, type Side } from './bookings.js';
import type { BookingGameView } from './games.js';

/**
 * A booking's series result (owner, 2026-10-11): how many games each booking
 * side won, read from the booking's own games. Shown on the booking page, on
 * each team's Scrims panel from its own side, and sent privately to both
 * sides when the box comes back (runner announceResult). Never posted
 * anywhere public: scrims are participants-only.
 *
 * A game counts once it completed. An aborted game (stopped, its box lost,
 * the booking ended under it) and a voided one (stored as aborted with
 * voided_at) never count; a live one does not count yet. Which booking side
 * won follows that game's own booking_side_a (null reads as side a, as
 * bookingSideForTeamA's default does) and matches.winner, falling back to the
 * scores for a completed row with no winner.
 */
export interface SeriesTally { wins: Record<Side, number>; draws: number; counted: number }

const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

export function countsInSeries(g: Pick<BookingGameView, 'state' | 'voided'>): boolean {
  return g.state === 'completed' && !g.voided;
}

/** The booking side that won this game, 'draw', or null when it does not count. */
export function gameWinner(g: BookingGameView): Side | 'draw' | null {
  if (!countsInSeries(g)) return null;
  const teamA: Side = g.sideA ?? 'a';
  const w = g.winner ?? (g.scoreA > g.scoreB ? 'a' : g.scoreB > g.scoreA ? 'b' : 'draw');
  return w === 'draw' ? 'draw' : w === 'a' ? teamA : other(teamA);
}

export function seriesTally(games: BookingGameView[]): SeriesTally {
  const t: SeriesTally = { wins: { a: 0, b: 0 }, draws: 0, counted: 0 };
  for (const g of games) {
    const w = gameWinner(g);
    if (w === null) continue;
    t.counted++;
    if (w === 'draw') t.draws++;
    else t.wins[w]++;
  }
  return t;
}

/** A game's score for booking side a and side b. */
export function sideScores(g: BookingGameView): Record<Side, number> {
  return (g.sideA ?? 'a') === 'a' ? { a: g.scoreA, b: g.scoreB } : { a: g.scoreB, b: g.scoreA };
}

/** "Test 1 - 1 big BAD boys", with ", 1 draw" or ", 2 draws" after it.
 *  Mirrored by web/src/series.ts. */
export function seriesLine(first: string, firstWins: number, secondWins: number, second: string, draws: number): string {
  const tail = draws === 0 ? '' : draws === 1 ? ', 1 draw' : `, ${draws} draws`;
  return `${first} ${firstWins} - ${secondWins} ${second}${tail}`;
}

/** One game for the result DM, `first`'s score first. */
export function gameLine(g: BookingGameView, campaignName: string, first: Side): string {
  if (g.voided) return `${campaignName}: voided, not counted`;
  if (g.state !== 'completed') return `${campaignName}: not finished, not counted`;
  const s = sideScores(g);
  return `${campaignName}: ${s[first]} - ${s[other(first)]}${gameWinner(g) === 'draw' ? ' (draw)' : ''}`;
}

/** Claim the one result notice for this booking: true the first time only,
 *  when it also writes the result_sent event, as claimReviewAsk does. */
export function claimResultNotice(db: DB, bookingId: number, now: Date): boolean {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM booking_events WHERE booking_id = ? AND event = 'result_sent'").get(bookingId)) return false;
    logBookingEvent(db, bookingId, null, 'result_sent', {}, now);
    return true;
  })();
}
