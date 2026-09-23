import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { hashIp } from './playerNetworks.js';

/**
 * Who watched, from which connection, and when.
 *
 * Every SourceTV spectator on the L4D1 game servers, on record for admins.
 * A spectator never authenticates, so there is no steamid to key on, only a
 * slot number that the engine reuses the moment someone leaves. The address
 * is handled exactly like a player's: hashed with the same salted HMAC as
 * player_networks (see src/playerNetworks.ts) and never stored raw, so a
 * spectator's connection can be matched against the accounts that played
 * from it without this table ever holding the address itself.
 */

export type SourceTvEvent = Extract<LogEvent, { kind: 'sourcetv' }>;

export interface SourceTvSession {
  id: number;
  name: string;
  country: string | null;
  joinedAt: string;
  leftAt: string | null;
  leaveReason: string | null;
  accounts: { steamid: string; name: string | null }[];
}

/**
 * Record one SourceTV event. Returns the new row id on a join, so a caller
 * can react to the specific session that just opened.
 */
export function recordSourceTv(
  db: DB, serverId: number, ev: SourceTvEvent, nowIso?: string,
): { opened?: number } {
  const now = nowIso ?? new Date().toISOString();

  // Checked first, and specifically, so the fields below narrow cleanly:
  // TypeScript will not exclude the `start`/`stop` member by negation alone,
  // since its `event` is a union rather than one literal.
  if (ev.event === 'join') {
    // First close any stale row left open on the same server and slot. A
    // slot only reappears in a join line once the engine has actually reused
    // it, so anything still open there is a leave this listener never saw.
    db.prepare(
      `UPDATE sourcetv_sessions SET left_at = ?, leave_reason = 'replaced'
        WHERE server_id = ? AND slot = ? AND left_at IS NULL`,
    ).run(now, serverId, ev.slot);

    const match = db.prepare(
      "SELECT id FROM matches WHERE server_id = ? AND state = 'live'",
    ).get(serverId) as { id: number } | undefined;

    const ipHash = hashIp(db, ev.ip);
    const opened = db.prepare(
      `INSERT INTO sourcetv_sessions (server_id, match_id, slot, name, ip_hash, country, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(serverId, match?.id ?? null, ev.slot, ev.name, ipHash, ev.country, now).lastInsertRowid;

    return { opened: Number(opened) };
  }

  if (ev.event === 'leave') {
    db.prepare(
      `UPDATE sourcetv_sessions SET left_at = ?, leave_reason = ?
        WHERE server_id = ? AND slot = ? AND left_at IS NULL`,
    ).run(now, ev.reason, serverId, ev.slot);
    return {};
  }

  // start or stop.
  db.prepare('INSERT INTO sourcetv_server_events (server_id, event, at) VALUES (?, ?, ?)')
    .run(serverId, ev.event, now);
  if (ev.event === 'stop') {
    db.prepare(
      `UPDATE sourcetv_sessions SET left_at = ?, leave_reason = 'SourceTV stopped'
        WHERE server_id = ? AND left_at IS NULL`,
    ).run(now, serverId);
  }
  return {};
}

export function likelyAccounts(db: DB, ipHash: string): { steamid: string; name: string | null }[] {
  return db.prepare(
    `SELECT n.player_id AS steamid, p.name AS name
       FROM player_networks n
       LEFT JOIN players p ON p.steamid = n.player_id
      WHERE n.ip_hash = ?
      ORDER BY n.last_seen DESC`,
  ).all(ipHash) as { steamid: string; name: string | null }[];
}

export function sessionsForMatch(db: DB, matchId: number): SourceTvSession[] {
  const rows = db.prepare(
    `SELECT id, name, country, ip_hash AS ipHash, joined_at AS joinedAt,
            left_at AS leftAt, leave_reason AS leaveReason
       FROM sourcetv_sessions WHERE match_id = ? ORDER BY joined_at`,
  ).all(matchId) as {
    id: number; name: string; country: string | null; ipHash: string;
    joinedAt: string; leftAt: string | null; leaveReason: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id, name: r.name, country: r.country, joinedAt: r.joinedAt,
    leftAt: r.leftAt, leaveReason: r.leaveReason,
    accounts: likelyAccounts(db, r.ipHash),
  }));
}

/**
 * Wired into src/server.ts next to player_net. Records the session and (Task
 * 3) posts the admin alert. Never on the critical path.
 */
export function onSourceTv(db: DB, serverId: number, ev: SourceTvEvent): void {
  recordSourceTv(db, serverId, ev);
}
