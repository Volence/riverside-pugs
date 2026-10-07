import type { DB } from './db.js';
import type { ServerReleaser } from './serverRelease.js';
import { archiveAborted } from './matchArchive.js';
import { insertBan } from './admin/players.js';
import { publishAdminEvent } from './adminFeed.js';
import { publishBanChange } from './banEvents.js';
import { noteMatchAborted } from './matchAborts.js';

/** Abandon bans escalate within this window: 1 day, then 3, then 7. */
const LADDER_MINUTES = [1440, 4320, 10080];
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The next abandon ban's length, from the abandons already on record.
 *
 * A ban staff lifted by hand does not count: lifting one is staff saying the
 * abandon was not the player's doing (a crash, our server, a mistaken end),
 * and it used to push the player's next real abandon up the ladder anyway. A
 * ban that ran out still counts, lifted_by 'system' being the expiry sweep
 * (liftExpiredBans), and so does one a human lifted only after it had already
 * run out, since that one was served in full.
 */
export function abandonBanMinutes(db: DB, steamid: string, now = new Date()): number {
  const n = abandonsSince(db, steamid, new Date(now.getTime() - WINDOW_MS));
  return LADDER_MINUTES[Math.min(n, LADDER_MINUTES.length - 1)];
}

/** Abandon bans on record since `since`, counted as abandonBanMinutes counts
 *  them: a ban staff lifted by hand before it ran out does not count. The
 *  draft desk shows it as PUG reliability (drafts plan D1 Ruling 8). */
export function abandonsSince(db: DB, steamid: string, since: Date): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM bans
     WHERE player_id = ? AND reason LIKE 'Abandoned match #%' AND created_at >= ?
       AND (lifted_at IS NULL OR lifted_by = 'system' OR (expires_at IS NOT NULL AND lifted_at >= expires_at))`,
  ).get(steamid, since.toISOString()) as { n: number }).n;
}

export interface AbandonDeps {
  db: DB;
  releaser: ServerReleaser;
  /** Ask the game server whether it really recorded this player as the
   *  abandoner (sm_pug_status). The log line alone arrives over UDP from an
   *  address anyone could spoof, and it ends a match and bans someone. */
  confirm: (serverId: number, steamid: string) => Promise<boolean>;
}

const inFlight = new Set<string>();
/** Booked games whose ABANDON was refused, logged once each (the plugin repeats the line every heartbeat). */
const bookedLogged = new Set<string>();

/** Whether an sm_pug_status body names `steamid` as the match's abandoner. */
export function statusShowsAbandoner(body: string, steamid: string): boolean {
  return body.split('\n').some((l) => l.trim().startsWith(`STATUS leave abandoner=${steamid} `));
}

/**
 * A rostered player used up their reconnect allowance (pug-leave.inc).
 *
 * The match ends with no rating change for anyone: aborted, server released
 * (which also tells the plugin, unpausing the game), live scratch cleared. The
 * leaver is banned, escalating with repeat abandons. Returns the match id when
 * this call ended it; null when there was nothing to do, including every repeat
 * of the line the plugin sends until the match is gone.
 */
export async function handleAbandon(deps: AbandonDeps, token: string, steamid: string): Promise<number | null> {
  const { db } = deps;
  const match = db.prepare(
    "SELECT id, server_id, booking_id FROM matches WHERE token = ? AND state IN ('configuring', 'live')",
  ).get(token) as { id: number; server_id: number | null; booking_id: number | null } | undefined;
  if (!match || match.server_id === null) return null;
  // A booked game (a scrim, or a tournament game the series engine started)
  // is never ended as an abandon: no abort, no ban, no requeue. A tournament
  // box is pushed sm_pug_leave_budget 0 so the plugin never sends this; an
  // older box or a lost push must still not stall a series (T3b final review).
  if (match.booking_id !== null) {
    if (!bookedLogged.has(token)) {
      bookedLogged.add(token);
      console.warn(`[abandon] ignored ABANDON of ${steamid} on match ${match.id}: it is a booked game (booking ${match.booking_id})`);
    }
    return null;
  }
  if (!db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(match.id, steamid)) return null;
  if (inFlight.has(token)) return null;
  inFlight.add(token);
  try {
    let confirmed = false;
    try {
      confirmed = await deps.confirm(match.server_id, steamid);
    } catch (err) {
      console.error(`[abandon] could not confirm abandon on match ${match.id}; will retry on the next line:`, err);
      return null;
    }
    if (!confirmed) return null;

    const minutes = abandonBanMinutes(db, steamid);
    const reason = `Abandoned match #${match.id}`;
    const changed = db.transaction(() => {
      const n = db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'abandon', ended_at = datetime('now') WHERE id = ? AND state IN ('configuring', 'live')")
        .run(match.id).changes;
      if (n === 0) return false;
      insertBan(db, steamid, 'system', reason, minutes);
      return true;
    })();
    if (!changed) return null;
    // After the outer commit, never inside it: see insertBan's doc comment.
    publishBanChange({ kind: 'ban', steamid, reason });
    archiveAborted(db, match.id);
    deps.releaser.release(match.server_id, { teardown: true, restart: true });
    publishAdminEvent({ kind: 'abandon', steamid, matchId: match.id, minutes });
    // The seven who stayed go back to the front of the queue; the leaver is
    // banned, which keeps them out of it anyway.
    noteMatchAborted(db, { matchId: match.id, cause: 'abandon', culprits: [steamid], requeue: true });
    console.warn(`[abandon] match ${match.id} ended: ${steamid} abandoned it; banned for ${minutes} minutes`);
    return match.id;
  } finally {
    inFlight.delete(token);
  }
}
