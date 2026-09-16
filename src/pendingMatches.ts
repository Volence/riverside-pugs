import type { DB } from './db.js';

/**
 * Matches that could not claim a server and are waiting for one.
 *
 * The owner's rule: a box running a pug is not claimable, a free one is, and
 * if none are free the pug waits rather than dying. Drained by the
 * ServerReleaser rather than polled, since there is exactly one place a server
 * becomes free.
 *
 * Held in memory but rebuilt from state='configuring' at boot. The same shape
 * of bug bit once already: registered match tokens lived only in memory, so
 * every deploy deafened the matches in flight until server.ts learned to
 * re-register them on startup.
 */
export class PendingMatches {
  private waiting: number[] = [];

  constructor(private db: DB, private setup: (matchId: number) => Promise<void>) {}

  add(matchId: number): void {
    if (!this.waiting.includes(matchId)) this.waiting.push(matchId);
  }

  size(): number {
    return this.waiting.length;
  }

  /** Re-read the waiting set from the database. Call once at startup. */
  rebuildFromDb(): void {
    const rows = this.db
      .prepare("SELECT id FROM matches WHERE state = 'configuring' ORDER BY id")
      .all() as { id: number }[];
    this.waiting = rows.map((r) => r.id);
  }

  /**
   * One box freed, so retry one match. Oldest first, and only one: a second
   * waiting match has no server to go to and would just abort itself.
   */
  drain(): void {
    while (this.waiting.length > 0) {
      const matchId = this.waiting.shift()!;
      const row = this.db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as
        | { state: string }
        | undefined;
      // Aborted or already live while it waited: drop it and try the next one.
      if (!row || row.state !== 'configuring') continue;
      void this.setup(matchId).catch((err) => {
        console.error(`[pendingMatches] retry failed for match ${matchId}:`, err);
      });
      return;
    }
  }
}
