import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { getPlayer } from '../players.js';

/**
 * Whether this viewer may see and use teams, by the staged rollout switch
 * `competitive_enabled` (off | admins | everyone, default off). `viewer` is an
 * active player's SteamID or null. Anything the switch does not recognise
 * reads as off: unlike practice, nothing here is half-built for admins.
 */
export function competitiveAccess(db: DB, viewer: string | null): boolean {
  if (!viewer) return false;
  const mode = getSetting(db, 'competitive_enabled') ?? 'off';
  if (mode === 'everyone') return true;
  if (mode === 'admins') return getPlayer(db, viewer)?.is_admin === 1;
  return false;
}

/**
 * Whether the read-only team pages (list, one team, a logo) are open to a
 * signed-out visitor: true only once the switch is all the way to `everyone`.
 * Under `admins`, the feature is still being tried out and nothing about it
 * is public yet, not even to a stranger who just wants to look; a signed-in
 * viewer there still goes through competitiveAccess as always.
 */
export function competitivePublic(db: DB): boolean {
  return (getSetting(db, 'competitive_enabled') ?? 'off') === 'everyone';
}

/**
 * Whether this viewer may see and use the scrim board: the competitive switch
 * lets them in AND `scrims_enabled` (off | admins | everyone, default admins)
 * does too, so events can go out to everyone while scrims stay with admins.
 * Anything the setting does not recognise reads as off.
 */
export function scrimsAccess(db: DB, viewer: string | null): boolean {
  if (!competitiveAccess(db, viewer)) return false;
  const mode = getSetting(db, 'scrims_enabled') ?? 'admins';
  if (mode === 'everyone') return true;
  if (mode === 'admins') return getPlayer(db, viewer!)?.is_admin === 1;
  if (mode === 'event') return getPlayer(db, viewer!)?.is_admin === 1 || onScrimEventTeam(db, viewer!);
  return false;
}

/** The event `scrims_enabled = event` opens scrims for (draft tourney 2
 *  plan), or null in any other mode or with no event set. */
export function scrimEventId(db: DB): number | null {
  if ((getSetting(db, 'scrims_enabled') ?? 'admins') !== 'event') return null;
  const id = Number(getSetting(db, 'scrims_event_id') ?? '');
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** A live team of the scrim event whose entry is still in it. */
const EVENT_TEAM_SQL = `SELECT 1 FROM teams t JOIN event_entries e ON e.id = t.event_entry_id
  WHERE t.disbanded_at IS NULL AND e.event_id = ? AND e.status NOT IN ('dropped','disqualified')`;

function onScrimEventTeam(db: DB, steamid: string): boolean {
  const eventId = scrimEventId(db);
  if (eventId === null) return false;
  return db.prepare(`${EVENT_TEAM_SQL} AND t.id IN (SELECT team_id FROM team_members WHERE steamid = ? AND left_at IS NULL) LIMIT 1`)
    .get(eventId, steamid) !== undefined;
}

/** Whether a scrim side (posting, accepting, challenged, or either side of a
 *  scrim booking) may play: any side, except under `scrims_enabled = event`,
 *  where only that event's teams may (no pickup sides, no site teams). */
export function scrimSideAllowed(db: DB, side: { teamId: number } | { captain: string }): boolean {
  if ((getSetting(db, 'scrims_enabled') ?? 'admins') !== 'event') return true;
  const eventId = scrimEventId(db);
  if (eventId === null || !('teamId' in side)) return false;
  return db.prepare(`${EVENT_TEAM_SQL} AND t.id = ? LIMIT 1`).get(eventId, side.teamId) !== undefined;
}

/** Whether scrims are public (the Discord scrim cards and night reminder):
 *  both switches all the way to `everyone`. */
export function scrimsPublic(db: DB): boolean {
  return competitivePublic(db) && (getSetting(db, 'scrims_enabled') ?? 'admins') === 'everyone';
}
