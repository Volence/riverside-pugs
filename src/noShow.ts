import type { DB } from './db.js';
import { getSetting } from './settings.js';
import type { ServerReleaser } from './serverRelease.js';

/**
 * Stamp the first time a rostered player is seen on the match server.
 *
 * First connect only: the plugin re-fires PLAYER connect for every client
 * across a map transition (they "reconnect" through the changelevel), so
 * overwriting would make every timestamp read as the most recent map change.
 */
export function recordPlayerConnect(db: DB, token: string, steamid: string): void {
  db.prepare(
    `UPDATE match_players SET connected_at = datetime('now')
     WHERE player_id = ?
       AND connected_at IS NULL
       AND match_id IN (SELECT id FROM matches WHERE token = ?)`,
  ).run(steamid, token);
}

function num(db: DB, key: string, fallback: number): number {
  const raw = Number(getSetting(db, key));
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * Abort live matches that never actually got going, and free their box.
 *
 * The orphan reaper cannot see these. Timer_Heartbeat fires whenever the
 * plugin holds a match, connected humans or not, so a match nobody joined
 * heartbeats forever and pins servers.status = 'live' forever. Since a match
 * with no free server now waits rather than aborting, that pin would deadlock
 * every future queue pop.
 *
 * Two rules:
 *   1. Past noshow_minutes with fewer than noshow_min_connected of the roster
 *      ever connected: nobody turned up.
 *   2. Past no_round_minutes with no round ever recorded: everyone turned up
 *      and then nobody readied.
 */
export function reapNoShowMatches(db: DB, releaser: ServerReleaser): number[] {
  const noShowMin = num(db, 'noshow_minutes', 10);
  const minConnected = num(db, 'noshow_min_connected', 6);
  const noRoundMin = num(db, 'no_round_minutes', 30);

  const rows = db
    .prepare(
      `SELECT m.id, m.server_id,
              (julianday('now') - julianday(m.went_live_at)) * 24 * 60 AS age_min,
              (SELECT COUNT(*) FROM match_players mp
                WHERE mp.match_id = m.id AND mp.connected_at IS NOT NULL) AS connected,
              (SELECT COUNT(*) FROM match_rounds r WHERE r.match_id = m.id) AS rounds
         FROM matches m
        WHERE m.state = 'live' AND m.went_live_at IS NOT NULL`,
    )
    .all() as { id: number; server_id: number | null; age_min: number; connected: number; rounds: number }[];

  const doomed = rows.filter(
    (r) =>
      (r.age_min >= noShowMin && r.connected < minConnected) ||
      (r.age_min >= noRoundMin && r.rounds === 0),
  );

  for (const r of doomed) {
    db.prepare("UPDATE matches SET state = 'aborted', ended_at = datetime('now') WHERE id = ?")
      .run(r.id);
    if (r.server_id !== null) releaser.release(r.server_id);
    console.warn(
      `[noShow] aborted match ${r.id}: ${r.connected} connected, ${r.rounds} rounds, ${Math.round(r.age_min)} min live`,
    );
  }
  return doomed.map((r) => r.id);
}
