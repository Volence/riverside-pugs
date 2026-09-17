import type { DB } from './db.js';

export interface ServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  rcon_port: number;
  rcon_password: string;
  status: 'idle' | 'reserved' | 'live' | 'offline';
}

export function addServer(
  db: DB,
  s: {
    name: string; host: string; port: number; rconPort: number; rconPassword: string;
    status?: ServerRow['status'];
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO servers (name, host, port, rcon_port, rcon_password, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(s.name, s.host, s.port, s.rconPort, s.rconPassword, s.status ?? 'idle');
  return Number(info.lastInsertRowid);
}

export function getServer(db: DB, id: number): ServerRow | undefined {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow | undefined;
}

/** Atomically reserve one idle server; returns it, or null if none are idle. */
export function claimIdle(db: DB): ServerRow | null {
  return db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM servers WHERE status = 'idle' ORDER BY id LIMIT 1")
      .get() as ServerRow | undefined;
    if (!row) return null;
    db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(row.id);
    return { ...row, status: 'reserved' as const };
  })();
}

function setStatus(db: DB, id: number, status: ServerRow['status']): void {
  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run(status, id);
}

export const release = (db: DB, id: number) => setStatus(db, id, 'idle');
export const markLive = (db: DB, id: number) => setStatus(db, id, 'live');
export const markOffline = (db: DB, id: number) => setStatus(db, id, 'offline');

/**
 * Which game server a log datagram came from, by sender address.
 *
 * A remote box sends from its own public IP, which is its servers.host. The
 * box the backend shares sends to logPublicAddress; a loopback target is
 * sourced from 127.0.0.1, so that and the feed host both mean the server whose
 * host IS the feed host. With a single server row, anything admitted belongs to
 * it (the original one-box behaviour).
 */
export function resolveServerBySource(db: DB, source: string, feedHost: string): number | null {
  const rows = db.prepare('SELECT id, host FROM servers ORDER BY id').all() as { id: number; host: string }[];
  const exact = rows.find((r) => r.host === source);
  if (exact) return exact.id;
  if (source === '127.0.0.1' || (feedHost && source === feedHost)) {
    return rows.find((r) => r.host === feedHost)?.id ?? (rows.length === 1 ? rows[0].id : null);
  }
  return null;
}
