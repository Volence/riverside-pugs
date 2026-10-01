import type { DB } from '../db.js';
import type { BookingRow } from '../bookings/bookings.js';
import { getPlayer } from '../players.js';
import { getSetting } from '../settings.js';
import { roleOf } from '../teams/teams.js';
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
 * excused: excused marks (late cancels and no-shows), in neither count.
 * Early, staff and system cancels are in no count at all.
 */
export interface Reliability { shown: number; booked: number; noShows: number; lateCancels: number; excused: number }

export function reliability(db: DB, party: Party, nowMs: number = Date.now()): Reliability {
  const w = partyWhere(party);
  const rows = db.prepare(
    `SELECT b.*, s.side AS my_side, s.peak_present AS my_peak, s.no_show_at AS my_no_show, s.excused_at AS my_excused
       FROM booking_sides s JOIN bookings b ON b.id = s.booking_id
      WHERE ${w.sql} AND s.confirmed_at IS NOT NULL AND b.starts_at <= ? AND b.state IN ('ended','no_show','cancelled')`,
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
    // excused no-show.
    if (excused) { out.excused++; continue; }
    out.booked++;
    if (r.my_peak >= SHOWN_MIN) out.shown++;
    if (r.my_no_show !== null) out.noShows++;
  }
  return out;
}

/** Who may see a side's record: staff, a current member of the team, the
 *  pickup captain themselves, or anyone once scrim_reliability_public is on. */
export function canSeeReliability(db: DB, party: Party, viewer: string | null): boolean {
  if (getSetting(db, 'scrim_reliability_public') === 'on') return true;
  if (!viewer) return false;
  const p = getPlayer(db, viewer);
  if (p && (p.is_admin === 1 || p.is_mod === 1)) return true;
  return 'teamId' in party ? roleOf(db, party.teamId, viewer) !== null : party.captain === viewer;
}
