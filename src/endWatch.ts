import type { DB } from './db.js';
import { getServer, type ServerRow } from './serverPool.js';

/**
 * Collects a finished match whose MATCH_END line never arrived.
 *
 * MATCH_END is one UDP datagram, sent in the burst of ~80 lines that closes the
 * last round, and nothing re-sends it. Match 1143 (2026-11-12) lost it: the
 * game ended normally, the plugin kicked everyone with the result, and the
 * site never asked for the dump, so the match sat 'live' until an admin
 * aborted it unrated. Its heartbeats kept coming the whole time, so neither
 * the orphan reaper nor the lost-server watch could see anything wrong.
 *
 * The plugin, though, knows: after its last map it holds the match in state
 * `ended` (with the result) until the site collects it. So the site asks it.
 * A check is due shortly after each MAP_RESULT and each map load (the moments
 * a match can have just ended, and the lines that travel with or right after
 * MATCH_END), and every live match is also checked on a slow sweep, for the
 * case where all of those lines were lost as well. `sm_pug_status` is a few
 * lines and changes nothing; only an answer of `ended` for this very match and
 * token leads anywhere, and that goes through the normal collection path,
 * which checks the state again with its own nonce before rating anything.
 */

/** How long after a map result or map load to ask: MATCH_END, when it does
 *  arrive, is handled well before this, and the box has finished loading. */
export const END_CHECK_DELAY_MS = 20_000;
/** Every live match is asked at least this often regardless. */
export const END_SWEEP_EVERY_MS = 5 * 60_000;

/** Reads pug-match's status block. Throws when rcon fails. */
export type EndStatusProbe = (server: ServerRow) => Promise<string>;

/** Whether an sm_pug_status body says this match (id and token) has ended. */
export function statusSaysEnded(body: string, matchId: number, token: string): boolean {
  const m = /^STATUS state=(\w+) match=(-?\d+) token=(\S+)/m.exec(body);
  return m !== null && m[1] === 'ended' && Number(m[2]) === matchId && m[3] === token;
}

interface LiveRow { id: number; token: string; server_id: number }

export class EndWatch {
  private readonly due = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly lastChecked = new Map<number, number>();
  private readonly checking = new Set<number>();
  private sweeping = false;

  constructor(private readonly deps: {
    db: DB;
    status: EndStatusProbe;
    /** Collect the match as a MATCH_END would. Must tolerate being called for
     *  a match that is already being collected. */
    collect: (matchId: number) => void;
    delayMs?: number;
    sweepEveryMs?: number;
    now?: () => number;
  }) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private liveByToken(token: string): LiveRow | undefined {
    return this.deps.db
      .prepare("SELECT id, token, server_id FROM matches WHERE token = ? AND state = 'live' AND server_id IS NOT NULL")
      .get(token) as LiveRow | undefined;
  }

  /** A map result or map load arrived for this token: check it soon, once. */
  nudge(token: string): void {
    let row: LiveRow | undefined;
    try { row = this.liveByToken(token); } catch { return; }
    if (!row || this.due.has(row.id)) return;
    const id = row.id;
    const t = setTimeout(() => {
      this.due.delete(id);
      void this.check(id);
    }, this.deps.delayMs ?? END_CHECK_DELAY_MS);
    t.unref?.();
    this.due.set(id, t);
  }

  /** Ask the match's server whether it has ended; collect it if so.
   *  Resolves true when a collection was started. Never throws. */
  async check(matchId: number): Promise<boolean> {
    if (this.checking.has(matchId)) return false;
    this.checking.add(matchId);
    this.lastChecked.set(matchId, this.now());
    try {
      const row = this.deps.db
        .prepare("SELECT id, token, server_id FROM matches WHERE id = ? AND state = 'live' AND server_id IS NOT NULL")
        .get(matchId) as LiveRow | undefined;
      if (!row || !row.token) return false;
      const server = getServer(this.deps.db, row.server_id);
      if (!server) return false;
      const body = await this.deps.status(server);
      if (!statusSaysEnded(body, row.id, row.token)) return false;
      // Re-read: a MATCH_END that arrived during the rcon round trip has
      // already started (or finished) the collection.
      const still = this.deps.db.prepare("SELECT state FROM matches WHERE id = ?").get(matchId) as
        { state: string } | undefined;
      if (still?.state !== 'live') return false;
      console.warn(`[endWatch] match ${matchId}: ${server.name} says the match has ended but no MATCH_END arrived; collecting it`);
      this.deps.collect(matchId);
      return true;
    } catch (err) {
      console.error(`[endWatch] check of match ${matchId} failed:`, err instanceof Error ? err.message : err);
      return false;
    } finally {
      this.checking.delete(matchId);
    }
  }

  /** The slow pass, from the minute reaper: every live match not checked
   *  within the sweep interval is checked now, one at a time. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = this.deps.db
        .prepare("SELECT id FROM matches WHERE state = 'live' AND server_id IS NOT NULL AND token IS NOT NULL")
        .all() as { id: number }[];
      const live = new Set(rows.map((r) => r.id));
      for (const id of [...this.lastChecked.keys()]) if (!live.has(id)) this.lastChecked.delete(id);
      const every = this.deps.sweepEveryMs ?? END_SWEEP_EVERY_MS;
      for (const { id } of rows) {
        const last = this.lastChecked.get(id);
        if (last === undefined) {
          // First sight (a fresh match, or a web restart): start its clock
          // rather than dial every box at once.
          this.lastChecked.set(id, this.now());
          continue;
        }
        if (this.now() - last < every) continue;
        await this.check(id);
      }
    } catch (err) {
      console.error('[endWatch] sweep failed:', err instanceof Error ? err.message : err);
    } finally {
      this.sweeping = false;
    }
  }

  stop(): void {
    for (const t of this.due.values()) clearTimeout(t);
    this.due.clear();
  }
}
