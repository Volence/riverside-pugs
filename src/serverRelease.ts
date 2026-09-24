import type { DB } from './db.js';
import { getServer, markOffline, release, type ServerRow } from './serverPool.js';
import { restartsAfterMatch, type ServerRestarter } from './serverRestart.js';

/** How a server is being freed. `teardown` is the ending that went wrong:
 *  abandon, no-show, admin abort. The roster is still on the box, possibly
 *  paused, on the match map, and the plugin is asked to empty it and change
 *  to the reset map. A clean finish, a boot-time reconcile and a failed setup
 *  all pass false: the first is already empty (the plugin kicks at the end of
 *  a backend match), and the other two may have casual players on the box
 *  who have nothing to do with any match. */
export interface ReleaseOpts {
  teardown: boolean;
  /** Restart srcds before the box goes back in the pool. Passed by the two
   *  paths where a match has just finished with it, and never by the boot
   *  reconcile, which may be looking at a box with people on it. Only acts
   *  when that box also has restart_after_match set. */
  restart: boolean;
}

/** Hands a server back: restore sv_password, and tell the plugin the match whose
 *  token this is (if any) is over, with a teardown when asked. Injected so tests
 *  never dial rcon and so the reapers, which have no rcon of their own, can
 *  still do both.
 *
 *  `token` is null when no match on that box ever got one, in which case there
 *  is nothing to abort. */
export type ServerCleaner = (server: ServerRow, token: string | null, opts: ReleaseOpts) => Promise<void>;

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
  private inFlight = new Set<Promise<void>>();

  constructor(
    private db: DB,
    private cleanServer: ServerCleaner,
    /** Absent in tests and on an install that never restarts anything, in
     *  which case `restart` is a no-op however the boxes are configured. */
    private restarter: ServerRestarter | null = null,
    /** Runs after the rcon cleanup and before the restart, for every release.
     *  The balance writer puts a pending pug_balance.cfg here, so the new
     *  values land between matches and the restart loads them. Failures are
     *  logged and never stop the release. */
    private beforeRestart: ((server: ServerRow) => Promise<void>) | null = null,
  ) {}

  /** Called when a box frees, so a match waiting for one can claim it. */
  onFreed(fn: () => void): void {
    this.waiters.push(fn);
  }

  /**
   * Resolves once every cleanup started BEFORE this call has settled.
   *
   * For boot, which is the one moment that frees servers outside the waiter
   * mechanism: reconcileServers releases stranded boxes and server.ts then has
   * to drain the pending list, and doing that synchronously put a setup's
   * `sv_password "pug_..."` in flight against the clear those releases had just
   * started. Awaiting this first puts the drain on the same footing as a
   * waiter. Deliberately a snapshot of what is outstanding now, not a barrier:
   * a waiter is free to release another box, and waiting on that too would
   * never finish.
   */
  async settled(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  /**
   * Free the server. The DB half is synchronous so a caller can assert on it
   * immediately. The rcon half is best effort, because a match result is
   * never allowed to fail over a password reset or an abort.
   *
   * Waiters are held back until that rcon half settles either way, and what
   * that buys is narrower than it looks, so state it exactly: a match handed
   * this box by the DRAIN path dials its own sv_password set strictly after
   * the old clear has landed, so those two round trips cannot cross and leave
   * a live ranked match unpassworded. The boot drain gets the same ordering by
   * a different route, since it runs on no waiter: server.ts sequences it
   * behind settled() below.
   *
   * That is the whole guarantee, and it is not a general one: onLobbyComplete
   * calls setupMatch directly (src/matchmaker.ts) rather than through a waiter,
   * so a lobby completing while the clear is still in flight can claim the row
   * the instant release() marks it idle and race the clear anyway. Closing that
   * would mean keeping the row unclaimable until the rcon settles, which is a
   * larger change than this class.
   */
  release(serverId: number, opts: Partial<ReleaseOpts> = {}): void {
    const server = getServer(this.db, serverId);
    if (!server) return;
    const full: ReleaseOpts = { teardown: opts.teardown ?? false, restart: opts.restart ?? false };
    // A restarting box must not be claimable, and the window is now ten to
    // twenty seconds rather than one rcon round trip, so it goes OFFLINE here
    // and only becomes idle once it answers again. Without a restart the row
    // still goes straight to idle, synchronously, exactly as before.
    const restarting = full.restart && this.restarter !== null && restartsAfterMatch(this.db, serverId);
    // Read before the row is freed, though nothing here depends on the order:
    // release() writes only the servers table. The newest match on the box is
    // the one whose match the plugin may still be holding. A stale or already
    // aborted token is harmless: the plugin answers PUGERR and changes nothing.
    const token = lastTokenOn(this.db, serverId);
    if (restarting) markOffline(this.db, serverId);
    else release(this.db, serverId);
    const done = this.cleanServer(server, token, full)
      .catch((err) => {
        // A dead rcon target must never wedge the queue: the waiters still
        // fire below even when the cleanup fails.
        console.error(`[serverRelease] could not clean up ${server.name}:`, err);
      })
      .then(async () => {
        if (!this.beforeRestart) return;
        try {
          await this.beforeRestart(server);
        } catch (err) {
          console.error(`[serverRelease] before-restart step failed on ${server.name}:`, err);
        }
      })
      .then(async () => {
        if (!restarting) return;
        // A box that never came back stays offline on purpose: the matchmaker
        // simply uses another, and the restarter has already said so in the
        // admin feed. An admin puts it back with Set idle.
        if (await this.restarter!.restart(server)) release(this.db, serverId);
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
    // Tracked only so settled() can order the boot drain behind it. Dropped
    // again on completion so a long-lived process does not accumulate one
    // entry per match it ever ran.
    this.inFlight.add(done);
    void done.finally(() => this.inFlight.delete(done));
  }
}

/**
 * The token of the most recent match to hold this server, or null.
 *
 * The releaser looks this up itself rather than taking it as an argument
 * because three of its four callers (both reapers and reconcileServers) know
 * only a server id, and threading a token through them would spread knowledge
 * of the plugin protocol into code that has no other reason to hold it. One
 * narrow read of a column the releaser is already keyed on is cheaper.
 */
function lastTokenOn(db: DB, serverId: number): string | null {
  const row = db
    .prepare('SELECT token FROM matches WHERE server_id = ? AND token IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(serverId) as { token: string } | undefined;
  return row?.token ?? null;
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
 *
 * Only a 'live' match protects its server, and 'configuring' deliberately does
 * NOT. A configuring match can only hold a server_id because setupMatch wrote
 * one after a successful claimIdle and the process then died before flipping
 * the match to 'live' (setupMatch and SelfStartedMatches, which inserts rows
 * that are already 'live', are the only two writers of that column). Excluding it
 * meant boot left that server reserved and skipped: rebuildFromDb re-pended
 * the match, drain called setupMatch, claimIdle found nothing because the only
 * box was the one the match itself was holding, onNoServer re-pended it, and
 * the match was immortal in a state hasOpenMatch counts, locking all eight
 * players out of the queue for good. A match that is merely WAITING for a box
 * has server_id IS NULL, so it can never be reconciled by accident.
 */
export function reconcileServers(db: DB, releaser: ServerReleaser): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM servers
       WHERE status IN ('reserved', 'live')
       AND id NOT IN (
         SELECT server_id FROM matches
         WHERE state = 'live' AND server_id IS NOT NULL
       )`,
    )
    .all() as { id: number }[];

  for (const r of rows) {
    console.warn(`[serverRelease] reconciling stranded server ${r.id}: no live match owns it`);
    releaser.release(r.id);
  }
  return rows.map((r) => r.id);
}
