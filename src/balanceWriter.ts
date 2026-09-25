import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from './db.js';
import { transportFor, type AddonsTransport } from './addonsTransport.js';
import { getServer, listServers, type ServerRow } from './serverPool.js';
import { publishAdminEvent } from './adminFeed.js';
import { activeRollout, ensureServerRows, markFailed, markPending, markWritten, type RolloutRow } from './balanceRollouts.js';

/**
 * Puts the active rollout's cfg/pug_balance.cfg on every enabled server.
 *
 * Idle boxes are written on a timer; a reserved or live box waits for the
 * release path (writeForRelease), which runs after the rcon cleanup and
 * before the after-match restart, so a match never changes config halfway.
 * "Written" means the bytes read back equal what was sent.
 *
 * pug_balance.cfg runs on every map, so a match that started while the file
 * was going out would play map 1 on the old values and the rest on the new.
 * An idle box is therefore held out of the pool for the whole write, the way
 * the release engine holds one: idle -> reserved in a single guarded UPDATE,
 * which claimIdle can never see, and back to idle only once the transport
 * call has actually settled (a call that outlived its timeout included). An
 * idle row is not an empty server either (an in-game !load_4v4p only shows
 * up once adopted), so under the hold the box's players are counted over
 * rcon and a box with anyone on it, or whose count cannot be read, is left
 * for a later pass.
 */

export const BALANCE_CFG = 'pug_balance.cfg';
const SWEEP_MS = 60_000;
const TIMEOUT_MS = 60_000;
/** The error a box with no reachable cfg directory is failed with; the
 *  Knobs tab shows it as its own state rather than as a retrying write. */
export const NO_TRANSPORT = 'no addons transport configured';

/** `<game>/left4dead/addons` -> `<game>/left4dead/cfg`; null for a layout we
 *  cannot reason about, which then reads as "no transport". */
export function cfgDirOf(server: ServerRow): string | null {
  const dir = (server as ServerRow & { addons_dir?: string | null }).addons_dir;
  if (!dir) return null;
  const m = /^(.*)\/addons\/?$/.exec(dir);
  return m ? `${m[1]}/cfg` : null;
}

export interface WriteOutcome { serverId: number; server: string; ok: boolean; skipped?: string; error?: string }

export class BalanceRolloutWriter {
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** A transport call that outlives its timeout keeps running against the
   *  box (an FTP rename cannot be cancelled from here); this tracks it by
   *  server id until it actually settles, so a second write is never started
   *  against the same box while the first might still land, and the temp
   *  file it reads from is only removed once it is done with it. */
  private inFlight = new Map<number, Promise<void>>();

  constructor(private deps: {
    db: DB;
    /** Injected so tests never touch a filesystem or a network. */
    transport?: (s: ServerRow, dir: string) => AddonsTransport | null;
    intervalMs?: number;
    timeoutMs?: number;
    /** Humans on the box, over rcon (parseHumans of `status`). Absent in
     *  tests that do not care, where every box counts as empty. */
    humans?: (s: ServerRow) => Promise<number>;
    /** Called when a hold ends and the box is back in the pool, so a match
     *  waiting for a server can claim it (the pending list's drain). */
    onFreed?: () => void;
  }) {}

  /** idle -> reserved in one statement, so nothing can claim the box
   *  between the check and the write. False when it was not idle. */
  private hold(serverId: number): boolean {
    return this.deps.db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ? AND status = 'idle' AND enabled = 1")
      .run(serverId).changes === 1;
  }

  /** Back to idle, unless a match took the box over meanwhile (an in-game
   *  match adopted on it goes live whatever the row said). */
  private unhold(serverId: number): void {
    const r = this.deps.db.prepare(`UPDATE servers SET status = 'idle' WHERE id = ? AND status = 'reserved'
      AND NOT EXISTS (SELECT 1 FROM matches WHERE server_id = ? AND state IN ('configuring', 'live'))`).run(serverId, serverId);
    if (r.changes === 1) {
      try { this.deps.onFreed?.(); } catch (err) { console.error('[balanceWriter] onFreed threw:', err); }
    }
  }

  /** Under a hold: null when the box may be written, else why not. */
  private async emptyOrWhy(server: ServerRow): Promise<string | null> {
    if (!this.deps.humans) return null;
    try {
      const n = await this.bounded(this.deps.humans(server));
      return n > 0 ? 'players on the server' : null;
    } catch (err) {
      return `could not count players: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Hold an idle box, check it is empty, write it, and let it go once the
   *  write has settled. */
  private async writeHeld(server: ServerRow, ro: RolloutRow): Promise<WriteOutcome> {
    const base = { serverId: server.id, server: server.name };
    // Nothing to hold or count for a box this cannot write at all.
    if (!this.transportOf(server)) return this.failIfStillActive(server, ro, NO_TRANSPORT);
    if (!this.hold(server.id)) return { ...base, ok: false, skipped: 'busy' };
    const why = await this.emptyOrWhy(server);
    if (why) {
      this.unhold(server.id);
      return { ...base, ok: false, skipped: why };
    }
    return this.writeOne(server, ro, () => this.unhold(server.id));
  }

  private queue<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const next = this.chain.then(fn).catch((err) => {
      console.error('[balanceWriter] pass failed:', err);
      return fallback;
    });
    this.chain = next;
    return next;
  }

  /** A sweep queued behind the chain that has not started yet: a second
   *  sync() in that window joins it instead of queueing another full pass. */
  private queuedSync: Promise<WriteOutcome[]> | null = null;

  sync(): Promise<WriteOutcome[]> {
    if (this.queuedSync) return this.queuedSync;
    const p = this.queue(() => {
      this.queuedSync = null;
      return this.pass();
    }, []);
    this.queuedSync = p;
    return p;
  }

  verifyAll(): Promise<WriteOutcome[]> {
    return this.queue(async () => {
      await this.verify();
      return this.pass();
    }, []);
  }

  /** Never rejects: the release path must free the box whatever happens here.
   *
   *  Writes only a box that is enabled and still 'offline' (restarting for
   *  this release) or 'idle'. Without a restart the releaser marks the row
   *  idle straight away, so by the time this turn runs a new match may
   *  already have claimed it (reserved or live); that box is left to the
   *  minute sweep, which writes it once it is idle again.
   *
   *  Resolves after at most 2x timeoutMs even if its queued turn has not
   *  come up yet: waiting behind a chain of slow writes would stall the
   *  after-match restart, which is what this runs in front of. If the cap
   *  fires first, the queued work still runs later (freeing the chain for
   *  whatever comes after), but from then on it behaves like an ordinary
   *  sweep for this one server: it writes only if the box is still enabled
   *  and idle, never regardless of status, because by then the release this
   *  call was for has already moved on without it. */
  async writeForRelease(serverId: number): Promise<void> {
    const capMs = (this.deps.timeoutMs ?? TIMEOUT_MS) * 2;
    let capExpired = false;
    let capTimer!: ReturnType<typeof setTimeout>;
    const cap = new Promise<void>((resolve) => {
      capTimer = setTimeout(() => { capExpired = true; resolve(); }, capMs);
      capTimer.unref();
    });
    const queued = this.queue(async () => {
      if (this.inFlight.has(serverId)) return;
      const ro = activeRollout(this.deps.db);
      const server = getServer(this.deps.db, serverId);
      if (!ro || !server || server.enabled !== 1) return;
      ensureServerRows(this.deps.db, ro.id);
      if (!this.needsWrite(ro.id, serverId)) return;
      if (server.status !== 'offline' && server.status !== 'idle') return;
      if (capExpired && server.status !== 'idle') return;
      if (server.status === 'idle') { await this.writeHeld(server, ro); return; }
      // Offline: the releaser took the box out of the pool for its restart
      // and puts it back afterwards, so the hold is already there. Wait for a
      // write that timed out to settle (it was aborted, so this is short)
      // before letting the restart and the release go ahead.
      await this.writeOne(server, ro);
      const late = this.inFlight.get(serverId);
      if (late) await Promise.race([late, new Promise<void>((r) => { setTimeout(r, this.deps.timeoutMs ?? TIMEOUT_MS).unref(); })]);
    }, undefined);
    await Promise.race([queued, cap]);
    clearTimeout(capTimer);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sync(), this.deps.intervalMs ?? SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private needsWrite(rolloutId: number, serverId: number): boolean {
    const r = this.deps.db.prepare('SELECT state FROM balance_rollout_servers WHERE rollout_id = ? AND server_id = ?')
      .get(rolloutId, serverId) as { state: string } | undefined;
    return r?.state === 'pending' || r?.state === 'failed';
  }

  private async pass(): Promise<WriteOutcome[]> {
    const ro = activeRollout(this.deps.db);
    if (!ro) return [];
    ensureServerRows(this.deps.db, ro.id);
    const out: WriteOutcome[] = [];
    for (const s of listServers(this.deps.db).filter((x) => x.enabled === 1)) {
      if (!this.needsWrite(ro.id, s.id)) continue;
      if (this.inFlight.has(s.id)) {
        out.push({ serverId: s.id, server: s.name, ok: false, skipped: 'previous write still running' });
        continue;
      }
      // Re-read right before writing, not once at the top of the loop: a
      // pass can take up to a minute per server, and a box already in this
      // same pass can go live in the meantime. The hold in writeHeld is what
      // makes that check and the write one step.
      const fresh = getServer(this.deps.db, s.id);
      if (!fresh || fresh.enabled !== 1 || fresh.status !== 'idle') {
        out.push({ serverId: s.id, server: s.name, ok: false, skipped: 'busy' });
        continue;
      }
      out.push(await this.writeHeld(fresh, ro));
    }
    return out;
  }

  private transportOf(server: ServerRow): AddonsTransport | null {
    const dir = cfgDirOf(server);
    return dir ? (this.deps.transport ?? transportFor)(server, dir) : null;
  }

  /** Rejects after timeoutMs, and then aborts `ac` so the transport call
   *  itself is cancelled (FTP client closed, scp/ssh child killed) rather
   *  than left to land on the box later. */
  private bounded<T>(p: Promise<T>, ac?: AbortController): Promise<T> {
    const ms = this.deps.timeoutMs ?? TIMEOUT_MS;
    let t: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      t = setTimeout(() => { ac?.abort(); reject(new Error(`timed out after ${ms} ms`)); }, ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
  }

  /** `release` ends the caller's hold on the box; it runs once the write has
   *  settled, which for a timed-out write is after this returns. */
  private async writeOne(server: ServerRow, ro: RolloutRow, release: () => void = () => {}): Promise<WriteOutcome> {
    const t = this.transportOf(server);
    if (!t) { release(); return this.failIfStillActive(server, ro, NO_TRANSPORT); }

    let dir: string;
    try {
      dir = await mkdtemp(join(tmpdir(), 'pug-balance-'));
    } catch (err) {
      release();
      return this.failIfStillActive(server, ro, err instanceof Error ? err.message : String(err));
    }

    const local = join(dir, BALANCE_CFG);
    // The real operation, tracked separately from the timeout below. On a
    // timeout bounded() aborts it, but a rename already on the wire can still
    // land, so it is tracked until it settles: no second write starts against
    // the box and the hold is not let go before then, and a late landing can
    // never pass for a later write's verified bytes.
    const ac = new AbortController();
    const op = (async () => {
      await writeFile(local, ro.content, 'utf8');
      await t.put(local, BALANCE_CFG, { signal: ac.signal });
      return t.readText(BALANCE_CFG, { signal: ac.signal });
    })();
    const settled = op.then(() => undefined, () => undefined).finally(() => {
      this.inFlight.delete(server.id);
      release();
      void rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    this.inFlight.set(server.id, settled);

    const base = { serverId: server.id, server: server.name };
    try {
      const back = await this.bounded(op, ac);
      if (back !== ro.content) return this.failIfStillActive(server, ro, 'read-back differs from what was written');
      // A newer apply may have landed while this one was in flight; its own
      // pass writes the new content, so only the still-active rollout is marked.
      if (activeRollout(this.deps.db)?.id === ro.id) markWritten(this.deps.db, ro.id, server.id);
      return { ...base, ok: true };
    } catch (err) {
      return this.failIfStillActive(server, ro, err instanceof Error ? err.message : String(err));
    }
  }

  /** A rollout superseded while a write to it was in flight is no longer
   *  this writer's business: the new rollout's own pass writes the box, and
   *  marking the old rollout's row failed would alert on a version nobody is
   *  being asked for any more. */
  private failIfStillActive(server: ServerRow, ro: RolloutRow, error: string): WriteOutcome {
    if (activeRollout(this.deps.db)?.id !== ro.id) return { serverId: server.id, server: server.name, ok: false, error };
    return this.fail(server, ro, error);
  }

  private fail(server: ServerRow, ro: RolloutRow, error: string): WriteOutcome {
    console.error(`[balanceWriter] ${server.name}: ${error}`);
    if (markFailed(this.deps.db, ro.id, server.id, error)) {
      publishAdminEvent({ kind: 'problem', text: `Could not write the balance config to ${server.name}: ${error}. It is retried every minute; see Admin > Balance > Knobs.` });
    }
    return { serverId: server.id, server: server.name, ok: false, error };
  }

  private async verify(): Promise<void> {
    const ro = activeRollout(this.deps.db);
    if (!ro) return;
    ensureServerRows(this.deps.db, ro.id);
    for (const s of listServers(this.deps.db).filter((x) => x.enabled === 1)) {
      const t = this.transportOf(s);
      if (!t) continue;
      let text: string | null;
      try {
        text = await this.bounded(t.readText(BALANCE_CFG));
      } catch (err) {
        console.error(`[balanceWriter] boot read-back on ${s.name} failed:`, err);
        continue;
      }
      const row = this.deps.db.prepare('SELECT state FROM balance_rollout_servers WHERE rollout_id = ? AND server_id = ?')
        .get(ro.id, s.id) as { state: string } | undefined;
      if (!row) continue;
      if (text === ro.content && (row.state === 'pending' || row.state === 'failed')) markWritten(this.deps.db, ro.id, s.id);
      if (text !== ro.content && (row.state === 'written' || row.state === 'confirmed')) {
        markPending(this.deps.db, ro.id, s.id, 'the file on the box differs from the rollout');
      }
    }
  }
}
