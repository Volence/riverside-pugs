import type { DB } from './db.js';
import { getServer, listServers, type ServerRow } from './serverPool.js';
import { treeReaderFor, type TreeFile, type TreeReader } from './fleetTree.js';
import type { FileSig } from './fleetCompare.js';

/**
 * Reads each game server's managed files for the fleet view, one box at a
 * time, only while the box is idle. Read-only. A failed or timed-out read keeps
 * the previous reading and records why. See
 * docs/superpowers/specs/2026-09-24-fleet-view-design.md.
 */

export type CheckState = 'queued' | 'busy' | 'disabled' | 'no_transport' | 'unknown';

const LIMITS: Record<TreeReader['kind'], number> = { local: 60_000, sftp: 180_000, ftp: 600_000 };
const HOUR = 3_600_000;
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const busyStatus = (s: ServerRow) => s.status !== 'idle' && s.status !== 'offline';

export class FleetReader {
  private chain: Promise<void> = Promise.resolve();
  private queued = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: {
    db: DB;
    reader?: (s: ServerRow) => TreeReader | null;
    limits?: Partial<Record<TreeReader['kind'], number>>;
    now?: () => string;
    tickMs?: number;
  }) {}

  private readerFor(s: ServerRow) { return (this.deps.reader ?? treeReaderFor)(s); }
  private now() { return (this.deps.now ?? sqlNow)(); }

  request(serverIds: number[]): Record<number, CheckState> {
    const out: Record<number, CheckState> = {};
    for (const id of serverIds) {
      const s = getServer(this.deps.db, id);
      if (!s) out[id] = 'unknown';
      else if (s.enabled !== 1) out[id] = 'disabled';
      else if (busyStatus(s)) out[id] = 'busy';
      else if (!this.readerFor(s)) out[id] = 'no_transport';
      else { out[id] = 'queued'; this.enqueue(id); }
    }
    return out;
  }

  pending(serverId: number): boolean { return this.queued.has(serverId); }
  idle(): Promise<void> { return this.chain; }

  private enqueue(id: number): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.chain = this.chain.then(() => this.readOne(id)).catch((err) => console.error('[fleet] read failed:', err))
      .finally(() => this.queued.delete(id));
  }

  private async readOne(id: number): Promise<void> {
    const db = this.deps.db;
    const s = getServer(db, id);
    const fail = (error: string) => db.prepare(`INSERT INTO fleet_readings (server_id, attempt_at, error) VALUES (?, ?, ?)
      ON CONFLICT (server_id) DO UPDATE SET attempt_at = excluded.attempt_at, error = excluded.error`).run(id, this.now(), error);
    // Rechecked here: the box may have been claimed since the request.
    if (!s || s.enabled !== 1 || busyStatus(s)) { fail('busy when its turn came; try after the match'); return; }
    const reader = this.readerFor(s);
    if (!reader) { fail('no transport configured'); return; }
    const limit = this.deps.limits?.[reader.kind] ?? LIMITS[reader.kind];
    let files: TreeFile[];
    try {
      let t: ReturnType<typeof setTimeout> | undefined;
      files = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`timed out after ${Math.round(limit / 1000)} s`)), limit); }),
      ]).finally(() => clearTimeout(t));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    const at = this.now();
    db.transaction(() => {
      db.prepare('DELETE FROM fleet_files WHERE server_id = ?').run(id);
      const ins = db.prepare('INSERT OR REPLACE INTO fleet_files (server_id, path, size, sha256) VALUES (?, ?, ?, ?)');
      for (const f of files) ins.run(id, f.path, f.size, f.sha256);
      db.prepare(`INSERT INTO fleet_readings (server_id, read_at, attempt_at, error) VALUES (?, ?, ?, NULL)
        ON CONFLICT (server_id) DO UPDATE SET read_at = excluded.read_at, attempt_at = excluded.attempt_at, error = NULL`).run(id, at, at);
    })();
  }

  /** Queues every enabled idle box never read, or last read over 24 h ago. */
  tick(): number[] {
    const stale = new Set((this.deps.db.prepare(`SELECT s.id FROM servers s LEFT JOIN fleet_readings f ON f.server_id = s.id
      WHERE f.read_at IS NULL OR f.read_at < datetime('now', '-24 hours')`).all() as { id: number }[]).map((r) => r.id));
    const picked = listServers(this.deps.db).filter((s) => stale.has(s.id) && s.enabled === 1 && !busyStatus(s) && this.readerFor(s));
    for (const s of picked) this.enqueue(s.id);
    return picked.map((s) => s.id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? HOUR);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function readingsOf(db: DB): Map<number, Map<string, FileSig> | null> {
  const out = new Map<number, Map<string, FileSig> | null>();
  for (const s of listServers(db)) out.set(s.id, null);
  const read = new Set((db.prepare('SELECT server_id FROM fleet_readings WHERE read_at IS NOT NULL').all() as { server_id: number }[]).map((r) => r.server_id));
  for (const id of read) out.set(id, new Map());
  for (const f of db.prepare('SELECT server_id, path, size, sha256 FROM fleet_files').all() as { server_id: number; path: string; size: number; sha256: string | null }[]) {
    out.get(f.server_id)?.set(f.path, { size: f.size, sha256: f.sha256 });
  }
  return out;
}

export function readingStates(db: DB): { serverId: number; readAt: string | null; attemptAt: string | null; error: string | null }[] {
  return (db.prepare(`SELECT s.id AS serverId, f.read_at AS readAt, f.attempt_at AS attemptAt, f.error AS error
    FROM servers s LEFT JOIN fleet_readings f ON f.server_id = s.id ORDER BY s.id`).all() as
    { serverId: number; readAt: string | null; attemptAt: string | null; error: string | null }[]);
}
