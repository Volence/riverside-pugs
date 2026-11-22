import type { DB } from '../db.js';
import * as E from '../events/events.js';
import * as P from '../events/play.js';
import * as R from '../events/room.js';
import { matchLabel } from '../events/playViews.js';
import { matchRoomView, phaseOf, type MatchRoomView, type RoomPhase } from '../events/roomViews.js';
import { competitiveAccess } from '../teams/access.js';
import { mayCast, RECENT_HOURS } from './access.js';
import type { StudioState } from './types.js';

/**
 * The tournament room a caster follows (owner 2026-11-22, DT2: "a room scene
 * where you can see vetos and map selection and all that for obs"), and the
 * series math the studio and desk read from it.
 *
 * What goes on air is the public room only: matchRoomView as an anonymous
 * viewer reads it (no lineups until both are locked, no proposal notes, no
 * pause reasons, no connect line), so like the draft (Ruling 3 of drafts plan
 * D2b2) there is no stake rule here. The gate is the caster role (or admin),
 * in good standing, with competitive access, asked again on every read.
 */

/** Statuses a room can be followed in while its stage is live: about to
 *  open (waiting, both teams known) and every open room status. */
const FOLLOWABLE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['waiting', ...P.ROOM_OPEN]);
const FINISHED: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['done', 'forfeit']);
const MAX_ROOMS = 30;

interface Row { id: number; event_id: number; status: P.MatchStatus; finished_at: string | null }

/** Rooms that can go on air: published events, both teams known, a live
 *  stage's open or upcoming rooms, or a result within RECENT_HOURS (for the
 *  winner and the series total after the last game). */
function castableRows(db: DB, now: Date, id?: number): Row[] {
  const since = new Date(now.getTime() - RECENT_HOURS * 3_600_000).toISOString();
  const open = [...FOLLOWABLE].map(() => '?').join(', ');
  return db.prepare(
    `SELECT m.id, m.event_id, m.status, m.finished_at FROM event_matches m
       JOIN events e ON e.id = m.event_id JOIN event_stages st ON st.id = m.stage_id
     WHERE e.status NOT IN ('draft', 'cancelled') AND m.entry_a IS NOT NULL AND m.entry_b IS NOT NULL
       AND ((st.status = 'live' AND e.status = 'live' AND m.status IN (${open}))
         OR (m.status IN ('done', 'forfeit') AND m.finished_at IS NOT NULL AND m.finished_at >= ?))
       ${id === undefined ? '' : 'AND m.id = ?'}
     ORDER BY CASE WHEN m.status IN ('done', 'forfeit') THEN 2 WHEN m.status = 'waiting' THEN 1 ELSE 0 END,
              m.scheduled_at IS NULL, m.scheduled_at, m.id
     LIMIT ${MAX_ROOMS}`,
  ).all(...[...FOLLOWABLE], since, ...(id === undefined ? [] : [id])) as Row[];
}

export function canCastRoom(db: DB, steamid: string, eventMatchId: number, now = new Date()): boolean {
  return mayCast(db, steamid) && competitiveAccess(db, steamid) && castableRows(db, now, eventMatchId).length > 0;
}

export interface PickableRoom {
  id: number; eventName: string; roundLabel: string; a: string; b: string; phase: RoomPhase; finished: boolean;
}

export function pickableRooms(db: DB, steamid: string, now = new Date()): PickableRoom[] {
  if (!mayCast(db, steamid) || !competitiveAccess(db, steamid)) return [];
  const name = db.prepare('SELECT name FROM event_entries WHERE id = ?');
  return castableRows(db, now).map((r) => {
    const m = P.getMatch(db, r.id)!;
    const ev = E.getEvent(db, r.event_id)!;
    const entry = (id: number | null) => (id === null ? 'TBD' : (name.get(id) as { name: string } | undefined)?.name ?? 'TBD');
    return { id: m.id, eventName: ev.name, roundLabel: matchLabel(db, ev, m), a: entry(m.entry_a), b: entry(m.entry_b), phase: phaseOf(m), finished: FINISHED.has(m.status) };
  });
}

/** The event match a booking (or a game of one) belongs to, or null. */
function roomOfBooking(db: DB, bookingId: number | null): number | null {
  return bookingId === null ? null : R.matchOfBooking(db, bookingId)?.id ?? null;
}

/**
 * The room on the feed: the one picked, else the room of the followed
 * booking or of the match on air. Null when there is none or the caster may
 * not follow it.
 */
export function castRoom(
  db: DB, steamid: string, state: Pick<StudioState, 'roomMatchId' | 'bookingId'>, onAirMatchId: number | null, now = new Date(),
): MatchRoomView | null {
  let id = state.roomMatchId;
  if (id === null) id = roomOfBooking(db, state.bookingId);
  if (id === null && onAirMatchId !== null) {
    const row = db.prepare('SELECT booking_id FROM matches WHERE id = ?').get(onAirMatchId) as { booking_id: number | null } | undefined;
    id = roomOfBooking(db, row?.booking_id ?? null);
  }
  if (id === null || !canCastRoom(db, steamid, id, now)) return null;
  const m = P.getMatch(db, id)!;
  const ev = E.getEvent(db, m.event_id)!;
  return matchRoomView(db, ev, m, null, false, now);
}
