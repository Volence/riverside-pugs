import type { DB } from '../db.js';
import type { BookingRow } from '../bookings/bookings.js';
import { getPlayer } from '../players.js';
import { getSetting } from '../settings.js';
import { myTeams, roleOf } from '../teams/teams.js';
import { isLateCancel, iso, partyWhere, SHOWN_MIN, type Party } from '../bookings/rules.js';

/**
 * A side's scrim record (scrim spec section 3; plan 2 Ruling 1), computed
 * from booking rows every time and never counted in place, so a staff excuse
 * fixes it at once. A team's record is the team's; a pickup group's is its
 * captain's (booking_sides.captain_steamid with team_id NULL), so forming a
 * new group does not escape it.
 *
 * booked: confirmed bookings whose start has passed that closed as ended or
 *   no_show, or that this side cancelled late, minus the excused ones.
 * shown: those of them where the side had SHOWN_MIN people on the box.
 * excused: excused marks (late cancels, no-shows, and short sides staff
 *   excused with no claim, bookings.ts shortSide), in neither count.
 * Early, staff and system cancels are in no count at all.
 * Tournament bookings (purpose 'tournament') are in no count: the event
 * handles a tournament no-show, not scrim standing (plan D2c Ruling 1).
 * The booking allowance (rules.ts allowance) moves only on claimed no-shows:
 * an unclaimed short side is often an idle end nobody joined or a scrim both
 * sides moved, so it lowers shown here but should not cost a booking slot.
 */
export interface Reliability { shown: number; booked: number; noShows: number; lateCancels: number; excused: number }

export function reliability(db: DB, party: Party, nowMs: number = Date.now()): Reliability {
  const w = partyWhere(party);
  const rows = db.prepare(
    `SELECT b.*, s.side AS my_side, s.peak_present AS my_peak, s.no_show_at AS my_no_show, s.excused_at AS my_excused
       FROM booking_sides s JOIN bookings b ON b.id = s.booking_id
      WHERE ${w.sql} AND b.purpose <> 'tournament' AND s.confirmed_at IS NOT NULL AND b.starts_at <= ? AND b.state IN ('ended','no_show','cancelled')`,
  ).all(w.arg, iso(nowMs)) as (BookingRow & { my_side: string; my_peak: number; my_no_show: string | null; my_excused: string | null })[];
  const out: Reliability = { shown: 0, booked: 0, noShows: 0, lateCancels: 0, excused: 0 };
  for (const r of rows) {
    const excused = r.my_excused !== null;
    if (r.state === 'cancelled') {
      if (r.cancel_side !== r.my_side || !isLateCancel(db, r)) continue;
      if (excused) { out.excused++; continue; }
      out.booked++;
      out.lateCancels++;
      continue;
    }
    // Only a side with a mark can be excused, so an excused row here is an
    // excused no-show or an excused short side (bookings.ts shortSide).
    if (excused) { out.excused++; continue; }
    out.booked++;
    if (r.my_peak >= SHOWN_MIN) out.shown++;
    if (r.my_no_show !== null) out.noShows++;
  }
  return out;
}

/** Whether every side's record is public (scrim_reliability_public). */
export function reliabilityPublic(db: DB): boolean {
  return getSetting(db, 'scrim_reliability_public') === 'on';
}

/** Who may see a side's record: staff, a current member of the team, the
 *  pickup captain themselves, or anyone once scrim_reliability_public is on. */
export function canSeeReliability(db: DB, party: Party, viewer: string | null): boolean {
  if (reliabilityPublic(db)) return true;
  if (!viewer) return false;
  const p = getPlayer(db, viewer);
  if (p && (p.is_admin === 1 || p.is_mod === 1)) return true;
  return 'teamId' in party ? roleOf(db, party.teamId, viewer) !== null : party.captain === viewer;
}

/** A player's scrim records for the staff People desk: theirs as a pickup
 *  captain, and each current team's. Staff only; never sent to a player. */
export interface ScrimRecord {
  pickup: Reliability;
  teams: { teamId: number; slug: string; name: string; tag: string; record: Reliability }[];
}

export function scrimRecordOf(db: DB, steamid: string, nowMs: number = Date.now()): ScrimRecord {
  return {
    pickup: reliability(db, { captain: steamid }, nowMs),
    teams: myTeams(db, steamid).map((t) => ({ teamId: t.id, slug: t.slug, name: t.name, tag: t.tag, record: reliability(db, { teamId: t.id }, nowMs) })),
  };
}

/** Whether this player has ever captained a pickup side on a booking, so
 *  their own Bookings page has a pickup record worth showing. */
export function hasPickupBookings(db: DB, steamid: string): boolean {
  return db.prepare("SELECT 1 FROM booking_sides s JOIN bookings b ON b.id = s.booking_id WHERE s.team_id IS NULL AND s.captain_steamid = ? AND b.purpose <> 'tournament' LIMIT 1").get(steamid) !== undefined;
}
