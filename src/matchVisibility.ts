import type { DB } from './db.js';
import { managesSide, sidesOf } from './bookings/bookings.js';
import { fullyInvited } from './bookings/casters.js';
import { inGoodStanding } from './standing.js';

/**
 * Who may see a match (spec: foundation section 1, Visibility).
 *
 * public: everyone. participants: staff, the players of that match, and, for
 * a match that is a booking's game (plan 4b), that booking's accepted people,
 * the managers of its confirmed sides, and a caster both sides invited
 * (plan 4c, src/bookings/casters.ts). staff: staff only. Every route that
 * returns a match, its demos, replays, timeline or live round goes through
 * canViewMatch or visibleMatchesSql, and answers a match the viewer may not
 * see exactly like a match that does not exist.
 */
export interface Viewer {
  steamid: string | null;
  staff: boolean;
  /** Holds is_caster and is in good standing, read fresh for every request,
   *  so clearing the flag or a ban ends an invited caster's access at once. */
  caster: boolean;
}

export function viewerFor(db: DB, steamid: string | null): Viewer {
  if (!steamid) return { steamid: null, staff: false, caster: false };
  const row = db.prepare('SELECT is_admin, is_mod, is_caster FROM players WHERE steamid = ?').get(steamid) as
    { is_admin: number; is_mod: number; is_caster: number } | undefined;
  return {
    steamid,
    staff: row?.is_admin === 1 || row?.is_mod === 1,
    caster: row?.is_caster === 1 && inGoodStanding(db, steamid),
  };
}

/** True when steamid is an accepted person of this booking, or manages one
 *  of its confirmed sides (pickup captain, or captain/co-captain of a team
 *  side). An unconfirmed side's prospective manager only confirms or
 *  declines (see actingSides in bookings/bookings.ts), so they do not see
 *  the booking's games through managing it either. */
function bookingParticipant(db: DB, bookingId: number, steamid: string): boolean {
  if (db.prepare("SELECT 1 FROM booking_people WHERE booking_id = ? AND steamid = ? AND status = 'accepted'")
    .get(bookingId, steamid)) return true;
  return sidesOf(db, bookingId).some((s) => s.confirmed_at !== null && managesSide(db, s, steamid));
}

export function canViewMatch(db: DB, viewer: Viewer, matchId: number): boolean {
  const row = db.prepare('SELECT visibility, booking_id FROM matches WHERE id = ?').get(matchId) as
    { visibility: string; booking_id: number | null } | undefined;
  if (!row) return false;
  if (row.visibility === 'public' || viewer.staff) return true;
  if (row.visibility !== 'participants' || !viewer.steamid) return false;
  if (db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, viewer.steamid)) return true;
  if (row.booking_id === null) return false;
  return bookingParticipant(db, row.booking_id, viewer.steamid) || fullyInvited(db, row.booking_id, viewer.steamid);
}

export function visibleMatchesSql(viewer: Viewer, alias: string): { sql: string; params: (string | number)[] } {
  if (viewer.staff) return { sql: '1 = 1', params: [] };
  if (!viewer.steamid) return { sql: `${alias}.visibility = 'public'`, params: [] };
  // A caster both sides invited (src/bookings/casters.ts fullyInvited). The
  // good-standing half of that rule is not expressible here, so the clause is
  // only added for a viewer who passes it right now (viewer.caster).
  const casterSql = viewer.caster
    ? `
            OR EXISTS (SELECT 1 FROM booking_casters vis_bc
              JOIN players vis_cp ON vis_cp.steamid = vis_bc.caster_steamid AND vis_cp.is_caster = 1
              WHERE vis_bc.booking_id = ${alias}.booking_id AND vis_bc.caster_steamid = ?
                AND vis_bc.invited_by_a IS NOT NULL AND vis_bc.invited_by_b IS NOT NULL)`
    : '';
  return {
    sql: `(${alias}.visibility = 'public' OR (${alias}.visibility = 'participants' AND (
            EXISTS (SELECT 1 FROM match_players vis_mp WHERE vis_mp.match_id = ${alias}.id AND vis_mp.player_id = ?)
            OR EXISTS (SELECT 1 FROM booking_people vis_bp WHERE vis_bp.booking_id = ${alias}.booking_id
              AND vis_bp.steamid = ? AND vis_bp.status = 'accepted')
            OR EXISTS (SELECT 1 FROM booking_sides vis_bs WHERE vis_bs.booking_id = ${alias}.booking_id
              AND vis_bs.team_id IS NULL AND vis_bs.captain_steamid = ? AND vis_bs.confirmed_at IS NOT NULL)
            OR EXISTS (SELECT 1 FROM booking_sides vis_bs2
              JOIN team_members vis_tm ON vis_tm.team_id = vis_bs2.team_id
                AND vis_tm.left_at IS NULL AND vis_tm.role IN ('captain','cocaptain')
              WHERE vis_bs2.booking_id = ${alias}.booking_id AND vis_tm.steamid = ? AND vis_bs2.confirmed_at IS NOT NULL)${casterSql}
          )))`,
    params: [viewer.steamid, viewer.steamid, viewer.steamid, viewer.steamid, ...(viewer.caster ? [viewer.steamid] : [])],
  };
}
