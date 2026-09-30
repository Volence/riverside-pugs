import type { DB } from './db.js';

/**
 * Who may see a match (spec: foundation section 1, Visibility).
 *
 * public: everyone. participants: staff and the players of that match (later
 * plans add ringers, approved spectators and invited casters). staff: staff
 * only. Every route that returns a match, its demos, replays, timeline or live
 * round goes through canViewMatch or visibleMatchesSql, and answers a match the
 * viewer may not see exactly like a match that does not exist.
 */
export interface Viewer { steamid: string | null; staff: boolean }

export function viewerFor(db: DB, steamid: string | null): Viewer {
  if (!steamid) return { steamid: null, staff: false };
  const row = db.prepare('SELECT is_admin, is_mod FROM players WHERE steamid = ?').get(steamid) as
    { is_admin: number; is_mod: number } | undefined;
  return { steamid, staff: row?.is_admin === 1 || row?.is_mod === 1 };
}

export function canViewMatch(db: DB, viewer: Viewer, matchId: number): boolean {
  const row = db.prepare('SELECT visibility FROM matches WHERE id = ?').get(matchId) as { visibility: string } | undefined;
  if (!row) return false;
  if (row.visibility === 'public' || viewer.staff) return true;
  if (row.visibility !== 'participants' || !viewer.steamid) return false;
  return db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, viewer.steamid) !== undefined;
}

export function visibleMatchesSql(viewer: Viewer, alias: string): { sql: string; params: (string | number)[] } {
  if (viewer.staff) return { sql: '1 = 1', params: [] };
  if (!viewer.steamid) return { sql: `${alias}.visibility = 'public'`, params: [] };
  return {
    sql: `(${alias}.visibility = 'public' OR (${alias}.visibility = 'participants' AND EXISTS (
            SELECT 1 FROM match_players vis_mp WHERE vis_mp.match_id = ${alias}.id AND vis_mp.player_id = ?)))`,
    params: [viewer.steamid],
  };
}
