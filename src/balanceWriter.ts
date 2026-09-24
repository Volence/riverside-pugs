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
 */

export const BALANCE_CFG = 'pug_balance.cfg';
const SWEEP_MS = 60_000;
const TIMEOUT_MS = 60_000;

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

  constructor(private deps: {
    db: DB;
    /** Injected so tests never touch a filesystem or a network. */
    transport?: (s: ServerRow, dir: string) => AddonsTransport | null;
    intervalMs?: number;
    timeoutMs?: number;
  }) {}

  private queue<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const next = this.chain.then(fn).catch((err) => {
      console.error('[balanceWriter] pass failed:', err);
      return fallback;
    });
    this.chain = next;
    return next;
  }

  sync(): Promise<WriteOutcome[]> {
    return this.queue(() => this.pass(), []);
  }

  verifyAll(): Promise<WriteOutcome[]> {
    return this.queue(async () => {
      await this.verify();
      return this.pass();
    }, []);
  }

  /** Never rejects: the release path must free the box whatever happens here. */
  async writeForRelease(serverId: number): Promise<void> {
    await this.queue(async () => {
      const ro = activeRollout(this.deps.db);
      const server = getServer(this.deps.db, serverId);
      if (!ro || !server || server.enabled !== 1) return;
      ensureServerRows(this.deps.db, ro.id);
      if (this.needsWrite(ro.id, serverId)) await this.writeOne(server, ro);
    }, undefined);
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
      if (s.status !== 'idle') { out.push({ serverId: s.id, server: s.name, ok: false, skipped: 'busy' }); continue; }
      out.push(await this.writeOne(s, ro));
    }
    return out;
  }

  private transportOf(server: ServerRow): AddonsTransport | null {
    const dir = cfgDirOf(server);
    return dir ? (this.deps.transport ?? transportFor)(server, dir) : null;
  }

  private bounded<T>(p: Promise<T>): Promise<T> {
    const ms = this.deps.timeoutMs ?? TIMEOUT_MS;
    let t: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
  }

  private async writeOne(server: ServerRow, ro: RolloutRow): Promise<WriteOutcome> {
    const base = { serverId: server.id, server: server.name };
    const t = this.transportOf(server);
    if (!t) return this.fail(server, ro, 'no addons transport configured');
    const dir = await mkdtemp(join(tmpdir(), 'pug-balance-'));
    try {
      const local = join(dir, BALANCE_CFG);
      await writeFile(local, ro.content, 'utf8');
      const back = await this.bounded((async () => {
        await t.put(local, BALANCE_CFG);
        return t.readText(BALANCE_CFG);
      })());
      if (back !== ro.content) return this.fail(server, ro, 'read-back differs from what was written');
      // A newer apply may have landed while this one was in flight; its own
      // pass writes the new content, so only the still-active rollout is marked.
      if (activeRollout(this.deps.db)?.id === ro.id) markWritten(this.deps.db, ro.id, server.id);
      return { ...base, ok: true };
    } catch (err) {
      return this.fail(server, ro, err instanceof Error ? err.message : String(err));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
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
