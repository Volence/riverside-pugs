import type { DB } from './db.js';
import { getServer, release, type ServerRow } from './serverPool.js';

/** Clears sv_password on a server we are done with. Injected so tests never
 *  dial rcon and so the reaper, which has no rcon of its own, can still do it. */
export type PasswordClearer = (server: ServerRow) => Promise<void>;

/**
 * The single place a server stops being ours.
 *
 * Before this existed there were four: three release() calls in the
 * orchestrator and a raw `UPDATE servers SET status = 'idle'` in the orphan
 * reaper. None of them cleared sv_password, so the first completed web match
 * left the box locked to pug_<token8> and shut out every casual player. The
 * reaper is exactly the path that most needs the clear, because a crashed
 * match is the case where nobody is around to notice.
 */
export class ServerReleaser {
  private waiters: Array<() => void> = [];

  constructor(private db: DB, private clearPassword: PasswordClearer) {}

  /** Called when a box frees, so a match waiting for one can claim it. */
  onFreed(fn: () => void): void {
    this.waiters.push(fn);
  }

  /**
   * Free the server. The DB half is synchronous so a caller can assert on it
   * immediately. The rcon half is best effort, because a match result is
   * never allowed to fail over a password reset, but waiters are held back
   * until it settles either way: once a drain hands this server to the next
   * match, that match dials its own sv_password set, and firing waiters
   * before the old clear lands would let the two rcon round trips race, with
   * the old clear sometimes landing after the new set and leaving a live
   * ranked match unpassworded.
   */
  release(serverId: number): void {
    const server = getServer(this.db, serverId);
    if (!server) return;
    release(this.db, serverId);
    this.clearPassword(server)
      .catch((err) => {
        // A dead rcon target must never wedge the queue: the waiters still
        // fire below even when the clear fails.
        console.error(`[serverRelease] could not clear sv_password on ${server.name}:`, err);
      })
      .then(() => {
        for (const fn of this.waiters) {
          try {
            fn();
          } catch (err) {
            console.error('[serverRelease] waiter threw:', err);
          }
        }
      });
  }
}

/**
 * Free servers that no live match owns any more.
 *
 * Marking a match aborted and freeing its server are two separate writes, and
 * deliberately not one transaction: the releaser notifies waiters that go on to
 * claim a server, which would be a nested write inside an open transaction. A
 * crash between the two therefore strands a server that no reaper can re-find,
 * since they all select on the match being live. Reconciling at boot is the
 * self-healing answer, and it covers strand paths a transaction never would.
 *
 * Only 'reserved' and 'live' qualify as stranded: those are exactly the
 * statuses a crash mid-match can leave behind with no owning row. 'offline'
 * is deliberately excluded even though it is not 'idle': it is the schema's
 * DEFAULT for every newly inserted server row, and nothing in production ever
 * calls markOffline, so it means "not yet verified reachable", not "a match
 * used to own this". Reconciling it to idle would silently make an unverified
 * server claimable the moment it boots.
 */
export function reconcileServers(db: DB, releaser: ServerReleaser): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM servers
       WHERE status IN ('reserved', 'live')
       AND id NOT IN (
         SELECT server_id FROM matches
         WHERE state IN ('configuring', 'live') AND server_id IS NOT NULL
       )`,
    )
    .all() as { id: number }[];

  for (const r of rows) {
    console.warn(`[serverRelease] reconciling stranded server ${r.id}: no live or configuring match owns it`);
    releaser.release(r.id);
  }
  return rows.map((r) => r.id);
}
