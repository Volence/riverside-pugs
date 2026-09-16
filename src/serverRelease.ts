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
   * immediately; the rcon half is best effort and fire-and-forget, because a
   * match result is never allowed to fail over a password reset.
   */
  release(serverId: number): void {
    const server = getServer(this.db, serverId);
    if (!server) return;
    release(this.db, serverId);
    void this.clearPassword(server).catch((err) => {
      console.error(`[serverRelease] could not clear sv_password on ${server.name}:`, err);
    });
    for (const fn of this.waiters) {
      try {
        fn();
      } catch (err) {
        console.error('[serverRelease] waiter threw:', err);
      }
    }
  }
}
