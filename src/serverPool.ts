import type { DB } from './db.js';

export interface ServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  rcon_port: number;
  rcon_password: string;
  status: 'idle' | 'reserved' | 'live' | 'offline';
  tv_port: number | null;
  tv_password: string | null;
  tv_enabled: number;
  /** 0 takes the box out of the matchmaker's pool without touching its status.
   *  Distinct from `status` on purpose: status is where the box is in the
   *  lifecycle of a match, `enabled` is whether an admin wants it used at all.
   *  Collapsing the two would mean expressing "do not use this" as a fake
   *  status that reconcileServers would then helpfully reset back to idle. */
  enabled: number;
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

/** Atomically reserve one idle, enabled server; returns it, or null if none is
 *  available. A disabled box is invisible here however idle it looks, which is
 *  the whole point: an admin can pull a misbehaving server out of rotation
 *  mid-evening without stopping it, kicking anyone, or editing the database. */
export function claimIdle(db: DB): ServerRow | null {
  return db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 ORDER BY id LIMIT 1")
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

/** Take a server in or out of the matchmaker's pool.
 *
 *  Deliberately does NOT touch `status`. Disabling a box that is mid-match
 *  lets that match finish and simply stops the next one being placed there;
 *  the release at the end still runs and still marks it idle, where it sits
 *  unclaimed until someone enables it again.
 */
export function setEnabled(db: DB, id: number, enabled: boolean): void {
  db.prepare('UPDATE servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

/** Every server, for the admin panel. Ordered by id so the list is stable. */
export function listServers(db: DB): ServerRow[] {
  return db.prepare('SELECT * FROM servers ORDER BY id').all() as ServerRow[];
}
