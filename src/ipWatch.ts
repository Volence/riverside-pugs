import type { DB } from './db.js';
import { hashIp } from './playerNetworks.js';
import { resolveAlias } from './aliases.js';
import { hasActiveBan } from './banState.js';
import { publishAdminEvent } from './adminFeed.js';

/**
 * Same-connection alerts and the IP watch list (owner, 2026-10-08, after
 * dethisa came back a fourth time on a fresh Discord AND a fresh Steam
 * account: the Discord-move hold never saw him, but player_networks had him
 * on the same connection as all three banned accounts, and nothing said so).
 *
 * Two levels, both posted to the mod channel and never acting on anyone:
 *
 *   - 'banned': an account connects from an address an account under an open
 *     ban or hold has used. One plain line.
 *   - 'watch': an account connects from an address on the watch list. Loud:
 *     it pings the mod call role. The watch list holds every address a
 *     flagged ban evader has used, kept current as they turn up on new ones,
 *     plus any address staff add by hand.
 *
 * Each pair of (account, address) alerts once per level, ever, so a household
 * is told about once and not on every map change. A shared connection is
 * still not proof (a VPN, a house, a LAN cafe), which is why this posts and
 * a person decides.
 *
 * Addresses typed in by staff are hashed on the way in with the same salted
 * HMAC as player_networks and never stored, so the list can only ever answer
 * "is this connection one we are watching".
 */

export function ensureIpWatchSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evader_flags (
      steamid    TEXT PRIMARY KEY,
      reason     TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      cleared_by TEXT,
      cleared_at TEXT
    );
    -- One row per watched address. steamid is the flagged account it came
    -- from, or NULL for an address added by hand. removed_at set = no longer
    -- watched; adding it again reopens the row.
    CREATE TABLE IF NOT EXISTS ip_watch (
      ip_hash    TEXT PRIMARY KEY,
      steamid    TEXT,
      note       TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      removed_by TEXT,
      removed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ip_alerts (
      steamid    TEXT NOT NULL,
      ip_hash    TEXT NOT NULL,
      level      TEXT NOT NULL CHECK (level IN ('watch','banned')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (steamid, ip_hash, level)
    );
  `);
}

export function isFlagged(db: DB, steamid: string): boolean {
  return db.prepare('SELECT 1 FROM evader_flags WHERE steamid = ? AND cleared_at IS NULL').get(steamid) !== undefined;
}

/** Watch one address on behalf of a flagged account (or by hand, steamid
 *  null). An address already watched keeps who it came from. */
function watch(db: DB, ipHash: string, steamid: string | null, note: string, by: string, at: string): void {
  db.prepare(
    `INSERT INTO ip_watch (ip_hash, steamid, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ip_hash) DO UPDATE SET
       steamid = CASE WHEN ip_watch.removed_at IS NULL THEN ip_watch.steamid ELSE excluded.steamid END,
       note = CASE WHEN ip_watch.removed_at IS NULL AND ip_watch.note <> '' THEN ip_watch.note ELSE excluded.note END,
       created_by = CASE WHEN ip_watch.removed_at IS NULL THEN ip_watch.created_by ELSE excluded.created_by END,
       created_at = CASE WHEN ip_watch.removed_at IS NULL THEN ip_watch.created_at ELSE excluded.created_at END,
       removed_by = NULL, removed_at = NULL`,
  ).run(ipHash, steamid, note, by, at);
}

/** Flag an account as a ban evader: every address it has used goes on the
 *  watch list, and every address it turns up on later joins them. */
export function flagEvader(db: DB, steamid: string, reason: string, by: string, now = new Date()): void {
  const at = now.toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO evader_flags (steamid, reason, created_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(steamid) DO UPDATE SET reason = excluded.reason, created_by = excluded.created_by,
         created_at = excluded.created_at, cleared_by = NULL, cleared_at = NULL`,
    ).run(steamid, reason, by, at);
    for (const { ip_hash } of db.prepare('SELECT ip_hash FROM player_networks WHERE player_id = ?').all(steamid) as { ip_hash: string }[]) {
      watch(db, ip_hash, steamid, '', by, at);
    }
  })();
}

/** Clear the flag and stop watching the addresses it put on the list.
 *  Addresses added by hand, or by another flagged account, stay. */
export function clearEvader(db: DB, steamid: string, by: string, now = new Date()): boolean {
  const at = now.toISOString();
  let cleared = false;
  db.transaction(() => {
    cleared = db.prepare('UPDATE evader_flags SET cleared_by = ?, cleared_at = ? WHERE steamid = ? AND cleared_at IS NULL')
      .run(by, at, steamid).changes > 0;
    if (cleared) {
      db.prepare('UPDATE ip_watch SET removed_by = ?, removed_at = ? WHERE steamid = ? AND removed_at IS NULL').run(by, at, steamid);
    }
  })();
  return cleared;
}

/** Watch a raw address typed by staff. Returns false for something that is
 *  not a public IPv4 address. The address itself is not kept. */
export function watchAddress(db: DB, ip: string, note: string, by: string, now = new Date()): boolean {
  const s = ip.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.split('.').some((o) => Number(o) > 255)) return false;
  watch(db, hashIp(db, s), null, note, by, now.toISOString());
  return true;
}

export function unwatch(db: DB, ipHash: string, by: string, now = new Date()): boolean {
  return db.prepare('UPDATE ip_watch SET removed_by = ?, removed_at = ? WHERE ip_hash = ? AND removed_at IS NULL')
    .run(by, now.toISOString(), ipHash).changes > 0;
}

/** True the first time this (account, address, level) is seen. */
function firstAlert(db: DB, steamid: string, ipHash: string, level: 'watch' | 'banned', at: string): boolean {
  return db.prepare('INSERT OR IGNORE INTO ip_alerts (steamid, ip_hash, level, created_at) VALUES (?, ?, ?, ?)')
    .run(steamid, ipHash, level, at).changes > 0;
}

/**
 * Called on every recorded connect, after player_networks has the sighting.
 * Never throws into the log listener: the caller wraps it.
 */
export function checkConnection(db: DB, steamid: string, ipHash: string, now = new Date()): void {
  const at = now.toISOString();
  const me = resolveAlias(db, steamid);
  // An evader on a new address: watch it too. They are not alerted on
  // themselves.
  if (isFlagged(db, steamid) || isFlagged(db, me)) {
    watch(db, ipHash, isFlagged(db, steamid) ? steamid : me, '', 'system', at);
    return;
  }
  // Already banned or held: the ban has it, and the game server refuses
  // them anyway.
  if (hasActiveBan(db, steamid, now) || hasActiveBan(db, me, now)) return;

  const same = (other: string) => other === steamid || resolveAlias(db, other) === me;

  const w = db.prepare('SELECT steamid, note FROM ip_watch WHERE ip_hash = ? AND removed_at IS NULL').get(ipHash) as
    | { steamid: string | null; note: string } | undefined;
  if (w && !(w.steamid && same(w.steamid))) {
    if (firstAlert(db, steamid, ipHash, 'watch', at)) {
      const others = (db.prepare('SELECT player_id FROM player_networks WHERE ip_hash = ? AND player_id <> ?').all(ipHash, steamid) as { player_id: string }[])
        .map((r) => r.player_id).filter((o) => !same(o));
      publishAdminEvent({ kind: 'ip_match', level: 'watch', steamid, others, flagged: w.steamid, note: w.note });
    }
    return;
  }

  const banned = (db.prepare('SELECT player_id FROM player_networks WHERE ip_hash = ? AND player_id <> ?').all(ipHash, steamid) as { player_id: string }[])
    .map((r) => r.player_id).filter((o) => !same(o) && hasActiveBan(db, o, now));
  if (banned.length > 0 && firstAlert(db, steamid, ipHash, 'banned', at)) {
    publishAdminEvent({ kind: 'ip_match', level: 'banned', steamid, others: banned, flagged: null, note: '' });
  }
}

export interface EvaderFlag {
  steamid: string; name: string; reason: string;
  createdAt: string; createdBy: string; createdByName: string | null;
}

export interface WatchEntry {
  ipHash: string; country: string | null; note: string;
  steamid: string | null; name: string | null;
  createdAt: string; createdByName: string | null;
  /** Every account seen on this address, banned or not. */
  accounts: { steamid: string; name: string; banned: boolean; flagged: boolean; lastSeen: string }[];
}

export function evaderFlagOf(db: DB, steamid: string): EvaderFlag | null {
  return (db.prepare(
    `SELECT f.steamid, COALESCE(p.name, f.steamid) AS name, f.reason, f.created_at AS createdAt,
            f.created_by AS createdBy, c.name AS createdByName
       FROM evader_flags f LEFT JOIN players p ON p.steamid = f.steamid LEFT JOIN players c ON c.steamid = f.created_by
      WHERE f.steamid = ? AND f.cleared_at IS NULL`,
  ).get(steamid) as EvaderFlag | undefined) ?? null;
}

export function ipWatchView(db: DB, now = new Date()): { flags: EvaderFlag[]; entries: WatchEntry[] } {
  const flags = db.prepare(
    `SELECT f.steamid, COALESCE(p.name, f.steamid) AS name, f.reason, f.created_at AS createdAt,
            f.created_by AS createdBy, c.name AS createdByName
       FROM evader_flags f LEFT JOIN players p ON p.steamid = f.steamid LEFT JOIN players c ON c.steamid = f.created_by
      WHERE f.cleared_at IS NULL ORDER BY f.created_at DESC`,
  ).all() as EvaderFlag[];
  const rows = db.prepare(
    `SELECT w.ip_hash AS ipHash, w.note, w.steamid, p.name, w.created_at AS createdAt, c.name AS createdByName
       FROM ip_watch w LEFT JOIN players p ON p.steamid = w.steamid LEFT JOIN players c ON c.steamid = w.created_by
      WHERE w.removed_at IS NULL ORDER BY w.created_at DESC`,
  ).all() as Omit<WatchEntry, 'accounts' | 'country'>[];
  const seen = db.prepare(
    `SELECT n.player_id AS steamid, COALESCE(p.name, n.player_id) AS name, n.last_seen AS lastSeen, n.country
       FROM player_networks n LEFT JOIN players p ON p.steamid = n.player_id
      WHERE n.ip_hash = ? ORDER BY n.last_seen DESC`,
  );
  const entries = rows.map((r) => {
    const accts = seen.all(r.ipHash) as { steamid: string; name: string; lastSeen: string; country: string | null }[];
    return {
      ...r,
      country: accts.find((a) => a.country)?.country ?? null,
      accounts: accts.map((a) => ({
        steamid: a.steamid, name: a.name, lastSeen: a.lastSeen,
        banned: hasActiveBan(db, a.steamid, now), flagged: isFlagged(db, a.steamid),
      })),
    };
  });
  return { flags, entries };
}
