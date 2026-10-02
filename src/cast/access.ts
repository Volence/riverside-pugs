import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { viewerFor } from '../matchVisibility.js';
import { fullyInvited } from '../bookings/casters.js';
import { getBooking, isOpen, sideName, sidesOf } from '../bookings/bookings.js';
import { campaignDisplayName } from '../campaignRegistry.js';

/**
 * What a caster may put on air (plan ruling 2). The same rule as /cast
 * (src/routes/cast.ts): every PUG and tournament match, and a booking's game
 * only for staff or a caster both sides invited. Asked again on every overlay
 * read, so a withdrawn invite, a cleared caster flag or a ban takes the feed
 * away at once.
 */

/** Holds the caster role (or is an admin) and is in good standing now. */
export function mayCast(db: DB, steamid: string): boolean {
  const p = getPlayer(db, steamid);
  return !!p && (p.is_admin === 1 || p.is_caster === 1) && inGoodStanding(db, steamid);
}

export function canCastBooking(db: DB, steamid: string, bookingId: number): boolean {
  if (!mayCast(db, steamid)) return false;
  if (!getBooking(db, bookingId)) return false;
  return viewerFor(db, steamid).staff || fullyInvited(db, bookingId, steamid);
}

export function canCastMatch(db: DB, steamid: string, matchId: number): boolean {
  if (!mayCast(db, steamid)) return false;
  const m = db.prepare('SELECT kind, booking_id AS bookingId FROM matches WHERE id = ?')
    .get(matchId) as { kind: string; bookingId: number | null } | undefined;
  if (!m) return false;
  if (m.bookingId !== null) return viewerFor(db, steamid).staff || fullyInvited(db, m.bookingId, steamid);
  return m.kind === 'pug' || m.kind === 'tournament';
}

export interface PickableMatch {
  id: number;
  kind: string;
  state: string;
  campaign: string;
  campaignName: string;
  teamA: string[];
  teamB: string[];
  scoreA: number;
  scoreB: number;
  bookingId: number | null;
  createdAt: string;
  endedAt: string | null;
}

export interface PickableBooking {
  id: number;
  purpose: string;
  state: string;
  startsAt: string;
  sideA: string;
  sideB: string;
  /** Newest game's match id, or null before the first. */
  latestMatchId: number | null;
}

/** How long a finished match stays in the picker, for the stats and winner scenes. */
export const RECENT_HOURS = 6;

export function pickableMatches(db: DB, steamid: string): PickableMatch[] {
  if (!mayCast(db, steamid)) return [];
  const rows = db.prepare(
    `SELECT m.id, m.kind, m.state, m.campaign, m.booking_id AS bookingId, m.created_at AS createdAt,
            m.ended_at AS endedAt, m.team_a_score AS scoreA, m.team_b_score AS scoreB
     FROM matches m
     WHERE m.state IN ('configuring', 'live')
        OR (m.state = 'completed' AND m.ended_at >= datetime('now', ?))
     ORDER BY CASE m.state WHEN 'live' THEN 0 WHEN 'configuring' THEN 1 ELSE 2 END, m.id DESC
     LIMIT 60`,
  ).all(`-${RECENT_HOURS} hours`) as Omit<PickableMatch, 'campaignName' | 'teamA' | 'teamB'>[];
  const teamOf = db.prepare(
    `SELECT p.name FROM match_players mp JOIN players p ON p.steamid = mp.player_id
     WHERE mp.match_id = ? AND mp.team = ? ORDER BY p.name COLLATE NOCASE`,
  );
  const liveScore = db.prepare(
    'SELECT COALESCE(SUM(team_a_score), 0) AS a, COALESCE(SUM(team_b_score), 0) AS b FROM match_live_maps WHERE match_id = ?',
  );
  return rows.filter((r) => canCastMatch(db, steamid, r.id)).map((r) => {
    const live = r.state === 'live' ? liveScore.get(r.id) as { a: number; b: number } : null;
    return {
      ...r,
      scoreA: live ? live.a : r.scoreA,
      scoreB: live ? live.b : r.scoreB,
      campaignName: campaignDisplayName(db, r.campaign),
      teamA: (teamOf.all(r.id, 'a') as { name: string }[]).map((p) => p.name),
      teamB: (teamOf.all(r.id, 'b') as { name: string }[]).map((p) => p.name),
    };
  });
}

export function pickableBookings(db: DB, steamid: string): PickableBooking[] {
  if (!mayCast(db, steamid)) return [];
  const rows = db.prepare('SELECT id FROM bookings WHERE ended_at IS NULL ORDER BY starts_at, id').all() as { id: number }[];
  const latest = db.prepare('SELECT id FROM matches WHERE booking_id = ? ORDER BY id DESC LIMIT 1');
  const out: PickableBooking[] = [];
  for (const { id } of rows) {
    const b = getBooking(db, id);
    if (!b || !isOpen(b) || !canCastBooking(db, steamid, id)) continue;
    const sides = sidesOf(db, id);
    const a = sides.find((s) => s.side === 'a');
    const bs = sides.find((s) => s.side === 'b');
    out.push({
      id, purpose: b.purpose, state: b.state, startsAt: b.starts_at,
      sideA: a ? sideName(db, a) : 'Side A',
      sideB: bs ? sideName(db, bs) : 'Side B',
      latestMatchId: (latest.get(id) as { id: number } | undefined)?.id ?? null,
    });
  }
  return out;
}

/** The match a studio shows: a followed booking's newest game, else the
 *  picked match. Null when there is nothing (yet) or the caster may no
 *  longer see it. */
export function resolveOnAir(
  db: DB, steamid: string, pick: { matchId: number | null; bookingId: number | null },
): { matchId: number | null; game: { number: number; of: number } | null } {
  if (pick.bookingId !== null) {
    if (!canCastBooking(db, steamid, pick.bookingId)) return { matchId: null, game: null };
    const games = db.prepare('SELECT id FROM matches WHERE booking_id = ? ORDER BY id').all(pick.bookingId) as { id: number }[];
    const b = getBooking(db, pick.bookingId);
    if (games.length === 0) return { matchId: null, game: null };
    return { matchId: games[games.length - 1]!.id, game: { number: games.length, of: Math.max(games.length, b?.games_allowed ?? 0) } };
  }
  if (pick.matchId !== null && canCastMatch(db, steamid, pick.matchId)) return { matchId: pick.matchId, game: null };
  return { matchId: null, game: null };
}
