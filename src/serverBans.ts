import type { DB } from './db.js';
import { listServers, type ServerRow } from './serverPool.js';
import { steam64ToSteam2 } from './steamId.js';
import { publishAdminEvent } from './adminFeed.js';
import { subscribeBanChanges, type BanChange } from './banEvents.js';

/**
 * Keeps every enabled game server's ban list equal to the website's.
 *
 * The website is the source of truth and the boxes are replicas that
 * converge. Three pushes, in order of how much correctness rests on them:
 *
 *   1. The sweep. Every SWEEP_MS, every open ban is re-sent to every enabled
 *      server, unconditionally, with no memory of what a box was told before.
 *      This is what makes the system right: `sm_addban` on an id that is
 *      already banned is harmless, so re-sending is free, and a box that was
 *      offline, restarted or rebuilt heals on its next sweep.
 *   2. The setup push (pushAll), run by the orchestrator on the connection it
 *      already holds before a match goes live, so a box about to host ranked
 *      play is current whatever the sweep's phase.
 *   3. The immediate push (onChange), fed by banEvents. Latency only.
 *
 * Bans go to the box as PERMANENT (`sm_addban 0`). SourceMod only writes
 * `banned_user.cfg` for permanent bans (core/logic/smn_banning.cpp, the
 * writeid is behind `ban_time == 0`), so a timed engine ban would be lost on
 * every server restart while most of ours are 1 to 7 day abandon bans. The
 * website already knows when each ban ends (liftExpiredBans runs every
 * minute) and lifts on the box at the same moment, so there is one clock.
 *
 * `sm_unban` reaches RemoveBan, which issues removeid AND writeid, so a lift
 * persists too. Checked; without it a lift would resurrect on restart.
 *
 * The sweep sends one `sm_addban` per open ban to every enabled server every
 * five minutes, and each one triggers a `writeid` of banned_user.cfg on the
 * box. Trivial at today's ban counts, but worth revisiting (a delta against
 * the box's own list, or a longer interval) if the table grows into the
 * hundreds.
 */

export const SWEEP_MS = 5 * 60 * 1000;
/** How far back the sweep keeps re-sending sm_unban. A permanent ban on disk
 *  survives however long a box is down, so this must cover the longest
 *  plausible outage. A box down longer than this is being rebuilt anyway. */
export const UNBAN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const REPORT_EVERY_MS = 60 * 60 * 1000;

/** Runs a batch of console commands on one server. Injected so tests never
 *  dial RCON. Must reject on failure; the caller does the logging. */
export type ServerExec = (server: ServerRow, commands: string[]) => Promise<void>;

/** Quotes and semicolons would end the argument or the command on the
 *  console; newlines would start a new one. Reasons are admin-typed text. */
function consoleSafe(reason: string): string {
  const s = reason.replace(/["\r\n;]/g, ' ').slice(0, 120).trim();
  return s || 'banned';
}

export function banCommand(steamid: string, reason: string): string {
  return `sm_addban 0 "${steam64ToSteam2(steamid)}" "${consoleSafe(reason)}"`;
}

export function unbanCommand(steamid: string): string {
  return `sm_unban "${steam64ToSteam2(steamid)}"`;
}

export class ServerBanSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Server id to the last time its failure was posted to the admin feed. */
  private lastReported = new Map<number, number>();

  constructor(private deps: { db: DB; exec: ServerExec; now?: () => number }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Everything a box should be told right now: a ban for every player with an
   * open ban (newest reason wins), then an unban for every player lifted
   * inside the window who has no open ban left. Deterministic order so tests
   * and logs are readable.
   */
  commands(): string[] {
    const nowIso = new Date(this.now()).toISOString();
    const since = new Date(this.now() - UNBAN_WINDOW_MS).toISOString();
    const open = this.deps.db.prepare(
      `SELECT b.player_id, b.reason FROM bans b
       WHERE b.id IN (
         SELECT MAX(id) FROM bans
         WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         GROUP BY player_id
       )
       ORDER BY b.player_id`,
    ).all(nowIso) as { player_id: string; reason: string }[];
    const openIds = new Set(open.map((r) => r.player_id));
    const lifted = this.deps.db.prepare(
      'SELECT DISTINCT player_id FROM bans WHERE lifted_at IS NOT NULL AND lifted_at >= ? ORDER BY player_id',
    ).all(since) as { player_id: string }[];
    return [
      ...open.map((r) => banCommand(r.player_id, r.reason)),
      ...lifted.filter((r) => !openIds.has(r.player_id)).map((r) => unbanCommand(r.player_id)),
    ];
  }

  /** The unconditional repair pass. See the class comment. */
  async sweep(): Promise<void> {
    const cmds = this.commands();
    if (cmds.length === 0) return;
    await this.pushToAll(cmds);
  }

  /** One change, now. The sweep will say it again in five minutes anyway. */
  async onChange(e: BanChange): Promise<void> {
    const cmd = e.kind === 'ban' ? banCommand(e.steamid, e.reason) : unbanCommand(e.steamid);
    await this.pushToAll([cmd]);
  }

  /** For a caller that already holds a connection to one box (match setup). */
  async pushAll(exec: (cmd: string) => Promise<unknown>): Promise<void> {
    for (const c of this.commands()) await exec(c);
  }

  private async pushToAll(cmds: string[]): Promise<void> {
    const servers = listServers(this.deps.db).filter((s) => s.enabled === 1);
    await Promise.all(servers.map(async (s) => {
      try {
        await this.deps.exec(s, cmds);
      } catch (err) {
        // Never rethrown: a dead box is out of date until it is back, and
        // that must not stop the other boxes or the caller.
        console.error(`[serverBans] push to ${s.name} failed:`, err);
        this.report(s, err);
      }
    }));
  }

  private report(s: ServerRow, err: unknown): void {
    const last = this.lastReported.get(s.id) ?? 0;
    if (this.now() - last < REPORT_EVERY_MS) return;
    this.lastReported.set(s.id, this.now());
    publishAdminEvent({
      kind: 'problem',
      text: `Could not push bans to ${s.name}: ${err instanceof Error ? err.message : String(err)}. `
        + `Its ban list may be out of date; it is retried every ${SWEEP_MS / 60_000} minutes.`,
    });
  }

  /** Subscribe to changes and start the sweep timer. */
  start(): void {
    // A second start would leak the first subscription and interval.
    if (this.timer) return;
    this.unsubscribe = subscribeBanChanges((e) => {
      void this.onChange(e).catch((err) => console.error('[serverBans] change push failed:', err));
    });
    this.timer = setInterval(() => {
      this.sweep().catch((err) => console.error('[serverBans] sweep failed:', err));
    }, SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
