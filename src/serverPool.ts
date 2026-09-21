import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';

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
  /** Whether this box carries the left4dead_dlc4 mappack. Set by the probe
   *  in setHasDlc4; present on the row because claimIdle does SELECT *. */
  has_dlc4: number;
  /** 1 to restart srcds after every match on this box. Off by default; see
   *  src/serverRestart.ts for why it is per server rather than global. */
  restart_after_match: number;
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

/** Every server row a datagram from `source` could belong to, by address
 *  alone.
 *
 *  A remote box sends from its own public IP, which is its servers.host. The
 *  box the backend shares sends to logPublicAddress; a loopback target is
 *  sourced from 127.0.0.1, so that and the feed host both mean the servers whose
 *  host IS the feed host. With a single server row, anything admitted belongs to
 *  it (the original one-box behaviour). */
function serversAtAddress(db: DB, source: string, feedHost: string): { id: number; name: string; port: number }[] {
  const rows = db.prepare('SELECT id, name, host, port FROM servers ORDER BY id')
    .all() as { id: number; name: string; host: string; port: number }[];
  const exact = rows.filter((r) => r.host === source);
  if (exact.length > 0) return exact;
  if (source === '127.0.0.1' || (feedHost && source === feedHost)) {
    const atFeed = rows.filter((r) => r.host === feedHost);
    if (atFeed.length > 0) return atFeed;
    return rows.length === 1 ? rows : [];
  }
  return [];
}

/** Whether a datagram from this address may be looked at at all. Separate
 *  from resolveServerBySource on purpose: that one answers null for an address
 *  two servers share when the port settles nothing, and the listener's
 *  admission gate must not start refusing a real game server over it. */
export function isKnownServerAddress(db: DB, source: string, feedHost: string): boolean {
  return serversAtAddress(db, source, feedHost).length > 0;
}

/** When each shared address was last reported as unattributable, epoch ms. */
const ambiguityReported = new Map<string, number>();
const AMBIGUITY_REPORT_EVERY_MS = 30 * 60_000;

/** For tests only. */
export function _resetAmbiguityReports(): void { ambiguityReported.clear(); }

/**
 * Which game server a log datagram came from, by sender address and port.
 *
 * The address is enough while every server has a host of its own. Two srcds
 * on one machine (Riverside #3 and #4) share one, and picking the first row
 * credited everything #4 sent to #3: evidence on the wrong match, and a match
 * started in game on #4 handed back to #3, which answered PUGERR bad token
 * (match 73, 2026-09-20).
 *
 * srcds sends log datagrams from its game socket (the engine writes them with
 * NET_OutOfBandPrintf on NS_SERVER), so the sender's port is the game port,
 * servers.port. That is engine knowledge and not something this repository
 * has a capture of, so it is used the careful way round: an exact host and
 * port match wins; failing that, the host alone decides when only one server
 * is on it, which is every box but Riverside and is what happened before; and
 * when two servers share the host and the port settles nothing, the answer is
 * NEITHER, reported to the admin feed with the port that was seen, rather
 * than quietly the first. A NAT that rewrites source ports would look like
 * that, and the report is how anyone would find out.
 *
 * A line that carries a valid MAC names its server outright and never gets
 * here; see src/logAuth.ts.
 */
export function resolveServerBySource(db: DB, source: string, feedHost: string, port?: number): number | null {
  const at = serversAtAddress(db, source, feedHost);
  if (at.length === 0) return null;
  if (port !== undefined) {
    const exact = at.find((r) => r.port === port);
    if (exact) return exact.id;
  }
  if (at.length === 1) return at[0].id;

  const now = Date.now();
  if (now - (ambiguityReported.get(source) ?? 0) >= AMBIGUITY_REPORT_EVERY_MS) {
    ambiguityReported.set(source, now);
    const names = at.map((r) => `${r.name} (port ${r.port})`).join(' and ');
    publishAdminEvent({
      kind: 'problem',
      text: `Log lines from ${source}${port === undefined ? '' : `:${port}`} could belong to ${names}, and the port they came from matches neither, so they were credited to NEITHER. Evidence and in-game match starts from that address are being lost until a server's game port matches, or the servers are given a log secret (a signed line names its own server).`,
    });
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
export function setRestartAfterMatch(db: DB, id: number, on: boolean): void {
  db.prepare('UPDATE servers SET restart_after_match = ? WHERE id = ?').run(on ? 1 : 0, id);
}

export function setEnabled(db: DB, id: number, enabled: boolean): void {
  db.prepare('UPDATE servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

/** Every server, for the admin panel. Ordered by id so the list is stable. */
export function listServers(db: DB): ServerRow[] {
  return db.prepare('SELECT * FROM servers ORDER BY id').all() as ServerRow[];
}

/** Records the result of probing a server for the dlc4 mappack (Task 4). */
export function setHasDlc4(db: DB, serverId: number, has: boolean): void {
  db.prepare('UPDATE servers SET has_dlc4 = ? WHERE id = ?').run(has ? 1 : 0, serverId);
}

/** Enabled servers without the mappack, by name, for telling an admin exactly
 *  which box is holding the dlc4 campaigns out of the pool. */
export function serversMissingDlc4(db: DB): string[] {
  return (db
    .prepare('SELECT name FROM servers WHERE enabled = 1 AND has_dlc4 = 0 ORDER BY id')
    .all() as { name: string }[]).map((s) => s.name);
}

/** True when every enabled server carries the dlc4 mappack. */
export function allServersHaveDlc4(db: DB): boolean {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM servers WHERE enabled = 1 AND has_dlc4 = 0')
    .get() as { n: number };
  return row.n === 0;
}

/** The servers a custom campaign must be on before it can be pooled: every
 *  server actually in play, matching campaignInstall's own install targets. */
export function enabledServerIds(db: DB): number[] {
  return (db.prepare('SELECT id FROM servers WHERE enabled = 1').all() as { id: number }[])
    .map((s) => s.id);
}
