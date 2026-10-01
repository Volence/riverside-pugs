import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { actingSides, getBooking, isOpen, logBookingEvent, type Result, type Side } from './bookings.js';

/**
 * Casters on a booked scrim (plan 4c). A scrim stays `participants`, so a
 * caster sees it only when BOTH sides' managers invite them: each side sets
 * its own half of the booking_casters row. A fully invited caster sees the
 * booking's games (canViewMatch, visibleMatchesSql) and gets the booking's
 * relay password on /cast.
 *
 * Whether someone is a caster is never stored here: fullyInvited asks
 * players.is_caster and good standing on every call, so clearing the flag or
 * a ban takes everything away at once.
 */

export interface CasterView { steamid: string; name: string; a: boolean; b: boolean }

interface CasterRow { booking_id: number; caster_steamid: string; invited_by_a: string | null; invited_by_b: string | null }

/** Holds is_caster and is in good standing right now. */
export function isActiveCaster(db: DB, steamid: string): boolean {
  return getPlayer(db, steamid)?.is_caster === 1 && inGoodStanding(db, steamid);
}

function rowOf(db: DB, bookingId: number, steamid: string): CasterRow | undefined {
  return db.prepare('SELECT * FROM booking_casters WHERE booking_id = ? AND caster_steamid = ?')
    .get(bookingId, steamid) as CasterRow | undefined;
}

/** `by` invites `caster` for the side they act for (the first if both). */
export function inviteCaster(db: DB, o: { bookingId: number; by: string; caster: string; now?: Date }): Result<{ side: Side }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ side: Side }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return { ok: false, error: 'not_found' };
    const side = actingSides(db, b.id, o.by)[0];
    if (!side) return { ok: false, error: 'not_manager' };
    if (!isOpen(b)) return { ok: false, error: 'wrong_state' };
    if (!isActiveCaster(db, o.caster)) return { ok: false, error: 'not_caster' };
    const col = side === 'a' ? 'invited_by_a' : 'invited_by_b';
    db.prepare(
      `INSERT INTO booking_casters (booking_id, caster_steamid, ${col}, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (booking_id, caster_steamid) DO UPDATE SET ${col} = excluded.${col}`,
    ).run(b.id, o.caster, o.by, now.toISOString());
    logBookingEvent(db, b.id, o.by, 'caster_invited', { steamid: o.caster, side }, now);
    return { ok: true, value: { side } };
  })();
}

/** `by` takes back their side's half; the row goes when both halves are empty. */
export function withdrawCaster(db: DB, o: { bookingId: number; by: string; caster: string; now?: Date }): Result<{ side: Side }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ side: Side }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return { ok: false, error: 'not_found' };
    const side = actingSides(db, b.id, o.by)[0];
    if (!side) return { ok: false, error: 'not_manager' };
    const row = rowOf(db, b.id, o.caster);
    if (!row || (side === 'a' ? row.invited_by_a : row.invited_by_b) === null) return { ok: false, error: 'not_person' };
    const col = side === 'a' ? 'invited_by_a' : 'invited_by_b';
    db.prepare(`UPDATE booking_casters SET ${col} = NULL WHERE booking_id = ? AND caster_steamid = ?`).run(b.id, o.caster);
    db.prepare('DELETE FROM booking_casters WHERE booking_id = ? AND caster_steamid = ? AND invited_by_a IS NULL AND invited_by_b IS NULL')
      .run(b.id, o.caster);
    logBookingEvent(db, b.id, o.by, 'caster_withdrawn', { steamid: o.caster, side }, now);
    return { ok: true, value: { side } };
  })();
}

/** Everyone invited by either side, with which halves are set. */
export function castersOf(db: DB, bookingId: number): CasterView[] {
  const rows = db.prepare('SELECT * FROM booking_casters WHERE booking_id = ? ORDER BY created_at, caster_steamid')
    .all(bookingId) as CasterRow[];
  return rows.map((r) => ({
    steamid: r.caster_steamid, name: getPlayer(db, r.caster_steamid)?.name ?? r.caster_steamid,
    a: r.invited_by_a !== null, b: r.invited_by_b !== null,
  }));
}

/** Both halves set, and the player is a caster in good standing right now. */
export function fullyInvited(db: DB, bookingId: number, steamid: string): boolean {
  const row = rowOf(db, bookingId, steamid);
  return !!row && row.invited_by_a !== null && row.invited_by_b !== null && isActiveCaster(db, steamid);
}

/** Casters a manager may pick from: is_caster and in good standing. */
export function activeCasters(db: DB): { steamid: string; name: string; avatar: string | null }[] {
  const rows = db.prepare('SELECT steamid, name, avatar FROM players WHERE is_caster = 1 ORDER BY name COLLATE NOCASE')
    .all() as { steamid: string; name: string; avatar: string | null }[];
  return rows.filter((r) => inGoodStanding(db, r.steamid));
}
