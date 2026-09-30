import type { DB } from './db.js';

/**
 * What happens to the people in a match once it has been aborted.
 *
 * Six paths end a match with no result (an admin, the no-show reaper, the
 * orphan reaper, a failed setup, an abandon, a result that could not be
 * collected), and every one of them used to stop at the state write. The
 * eight people on the roster found out by the match card vanishing from the
 * Play page, and the ones who had done nothing wrong had to notice, go back
 * and queue again at the back. Each path now reports here once, right after
 * its own state write, and this does the rest the same way for all of them:
 *
 *   - the cause is on the match row, written by the path in the SAME UPDATE
 *     as state = 'aborted': the Discord sync can run between any two awaits,
 *     and a card it closes with no cause never gets its #queue-here line.
 *     Its public wording (ABORT_REASON) is what the channel says, so it never
 *     names anyone at fault (the admin feed already does that);
 *   - every rostered player gets a notice on the site that outlives a reload
 *     until they dismiss it;
 *   - the players not at fault go back to the FRONT of the queue, as a failed
 *     ready check does for the players who readied. The requeue itself is the
 *     matchmaker's (queue rules, bans, timeouts), reached through the bus
 *     below because none of these paths holds a matchmaker.
 *
 * A process-wide bus for the same reason adminFeed.ts and banEvents.ts are
 * one, and the event carries its database so a listener can ignore aborts
 * from another instance (the test suite builds dozens of servers).
 */

export type AbortCause =
  | 'admin' | 'no_show' | 'no_round' | 'setup_failed' | 'abandon' | 'server_lost' | 'uncollected';

/** The public half of each cause. Neutral on purpose: this is what the
 *  Discord channel and every player on the roster read. */
export const ABORT_REASON: Record<AbortCause, string> = {
  admin: 'staff cancelled it',
  no_show: 'not enough players connected in time',
  no_round: 'nobody readied up in game in time',
  setup_failed: 'the game server could not be set up',
  abandon: 'a player ran out of reconnect time',
  server_lost: 'the game server stopped responding',
  uncollected: 'its result could not be collected from the game server',
};

/** Where each rostered player stands in an abort.
 *   innocent    not at fault; requeued when `requeue` is set and they may queue.
 *   culprit     the no-show or the abandoner; never requeued.
 *   file_check  never got in because the file check rejected them. They did
 *               try, so it is no no-show, but requeueing them would only have
 *               the next match reject them again. */
export type AbortRole = 'innocent' | 'culprit' | 'file_check';

export interface MatchAbort {
  matchId: number;
  cause: AbortCause;
  /** Players the abort is on. */
  culprits?: string[];
  /** Players rejected by the file check. */
  fileCheck?: string[];
  /** Whether the innocent go back to the front of the queue. False where the
   *  match was played out (uncollected) or everyone let it die (no_round). */
  requeue: boolean;
  /** Innocent players staff chose not to put back, such as one they are
   *  about to ban: requeued with the rest, the same eight re-pop at once.
   *  Still told, as innocent and not requeued. */
  leaveOut?: string[];
}

export interface MatchAbortEvent extends MatchAbort {
  db: DB;
  /** The innocent, in roster order, when `requeue` is set; else empty. */
  requeueIds: string[];
}

type Listener = (e: MatchAbortEvent) => string[] | void;
const listeners = new Set<Listener>();

/** The requeue hook. The listener answers with who it actually put back,
 *  which is what the notices then say. */
export function subscribeMatchAborts(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** What noteMatchAborted did: the roster size and who actually went back,
 *  for a caller whose admin feed line says so. */
export interface AbortOutcome { rostered: number; requeued: string[] }

/**
 * Report an abort that has just been written. Call it after the state write
 * and outside any transaction: the listener requeues, which can pop a lobby.
 * Never throws; a failure here must not undo or block the abort itself.
 */
export function noteMatchAborted(db: DB, a: MatchAbort): AbortOutcome {
  try {
    const roster = (db.prepare('SELECT player_id FROM match_players WHERE match_id = ? ORDER BY rowid').all(a.matchId) as
      { player_id: string }[]).map((r) => r.player_id);
    const culprits = new Set(a.culprits ?? []);
    const fileCheck = new Set((a.fileCheck ?? []).filter((p) => !culprits.has(p)));
    const role = (p: string): AbortRole => culprits.has(p) ? 'culprit' : fileCheck.has(p) ? 'file_check' : 'innocent';
    const now = new Date().toISOString();
    db.transaction(() => {
      // Only a backstop for a writer that forgot: the path's own state write
      // is where the cause belongs, and it is never overwritten here.
      db.prepare('UPDATE matches SET abort_cause = COALESCE(abort_cause, ?) WHERE id = ?').run(a.cause, a.matchId);
      const ins = db.prepare(
        `INSERT INTO match_abort_notices (match_id, player_id, role, requeued, created_at) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(match_id, player_id) DO NOTHING`,
      );
      for (const p of roster) ins.run(a.matchId, p, role(p), now);
    })();
    // Only a match the site's queue made puts anyone back in it. A match
    // started in game (!load_4v4p) rostered whoever was on the server, who
    // never queued here and may not play PUGs at all.
    const origin = (db.prepare('SELECT origin FROM matches WHERE id = ?').get(a.matchId) as { origin: string | null } | undefined)?.origin;
    const leaveOut = new Set(a.leaveOut ?? []);
    const requeueIds = a.requeue && origin !== 'in_game' ? roster.filter((p) => role(p) === 'innocent' && !leaveOut.has(p)) : [];
    const back = new Set<string>();
    for (const fn of listeners) {
      try {
        for (const id of fn({ ...a, db, requeueIds }) ?? []) back.add(id);
      } catch (err) {
        console.error('[matchAborts] listener failed:', err);
      }
    }
    if (back.size > 0) {
      const mark = db.prepare('UPDATE match_abort_notices SET requeued = 1 WHERE match_id = ? AND player_id = ?');
      for (const id of back) mark.run(a.matchId, id);
    }
    return { rostered: roster.length, requeued: [...back] };
  } catch (err) {
    console.error(`[matchAborts] could not note the abort of match ${a.matchId}:`, err);
    return { rostered: 0, requeued: [] };
  }
}

export interface AbortNotice {
  matchId: number;
  cause: AbortCause;
  reason: string;
  role: AbortRole;
  requeued: boolean;
}

/** Old notices stop showing on their own: "your match was aborted" from two
 *  days ago is noise, dismissed or not. */
const NOTICE_TTL_MS = 12 * 60 * 60 * 1000;

/** The viewer's most recent undismissed abort notice, or null. */
export function abortNoticeFor(db: DB, steamid: string, now = new Date()): AbortNotice | null {
  const since = new Date(now.getTime() - NOTICE_TTL_MS).toISOString();
  const row = db.prepare(
    `SELECT n.match_id, n.role, n.requeued, m.abort_cause FROM match_abort_notices n
     JOIN matches m ON m.id = n.match_id
     WHERE n.player_id = ? AND n.dismissed_at IS NULL AND n.created_at >= ?
     ORDER BY n.created_at DESC, n.match_id DESC LIMIT 1`,
  ).get(steamid, since) as { match_id: number; role: AbortRole; requeued: number; abort_cause: AbortCause | null } | undefined;
  if (!row || !row.abort_cause) return null;
  return {
    matchId: row.match_id, cause: row.abort_cause, reason: ABORT_REASON[row.abort_cause],
    role: row.role, requeued: row.requeued === 1,
  };
}

/** The viewer has read it. Every notice of theirs goes, not just the one on
 *  screen: an older one surfacing next would be about a match long gone. */
export function dismissAbortNotices(db: DB, steamid: string, now = new Date()): void {
  db.prepare('UPDATE match_abort_notices SET dismissed_at = ? WHERE player_id = ? AND dismissed_at IS NULL')
    .run(now.toISOString(), steamid);
}

/** Whether any innocent player on this abort was put back in the queue, for
 *  the public line that says so. */
export function anyRequeued(db: DB, matchId: number): boolean {
  return db.prepare('SELECT 1 FROM match_abort_notices WHERE match_id = ? AND requeued = 1 LIMIT 1').get(matchId) !== undefined;
}
