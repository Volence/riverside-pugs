import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { hashIp } from './playerNetworks.js';
import { publishAdminEvent } from './adminFeed.js';

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
  if (ev.event === 'start') {
    // A crashed server sends no stop and no leaves, so every row this
    // listener still thinks is open on this server is stale the moment
    // SourceTV comes back up. Close them before recording the start itself.
    db.prepare(
      `UPDATE sourcetv_sessions SET left_at = ?, leave_reason = 'SourceTV restarted'
        WHERE server_id = ? AND left_at IS NULL`,
    ).run(now, serverId);
  }
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
 * Wired into src/server.ts next to player_net. Records the session and, on a
 * join into a live match, alerts admins about any rostered players sharing
 * that connection. Never on the critical path: recordSourceTv already
 * happened by the time this looks for accounts to alert on, so a failure
 * here never loses the session row.
 *
 * At most one post per match per hashed connection, never one per rejoin:
 * spectators are dropped and reconnect at every map change, and this alert
 * says nothing new the second time it happens on the same connection in the
 * same match. All matched players go in a single post rather than one post
 * each, since the connection is one thing sharing itself.
 *
 * The dedup is keyed on whether an alert was actually PUBLISHED for this
 * match + connection (sourcetv_sessions.alerted_at), not on whether an
 * earlier session row merely exists. player_networks gains a row on every
 * human connect for the whole life of a match, so a spectator who joins
 * before the matching player has connected yet gets a session with no
 * likely rostered account and no post; if dedup keyed on row existence, that
 * earlier no-op session would permanently suppress the real first alert on
 * a later reconnect. Keying on alerted_at instead means only a session that
 * actually posted can suppress a later one.
 */
export function onSourceTv(db: DB, serverId: number, ev: SourceTvEvent): void {
  const { opened } = recordSourceTv(db, serverId, ev);
  if (opened === undefined) return;

  const row = db.prepare(
    'SELECT match_id AS matchId, ip_hash AS ipHash, name FROM sourcetv_sessions WHERE id = ?',
  ).get(opened) as { matchId: number | null; ipHash: string; name: string } | undefined;
  if (!row || row.matchId === null) return;

  const matchId = row.matchId;
  const inMatch = db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?');
  const steamids = likelyAccounts(db, row.ipHash)
    .map((a) => a.steamid)
    .filter((steamid) => inMatch.get(matchId, steamid));
  if (steamids.length === 0) return;

  const alreadyAlerted = db.prepare(
    'SELECT 1 FROM sourcetv_sessions WHERE match_id = ? AND ip_hash = ? AND alerted_at IS NOT NULL',
  ).get(matchId, row.ipHash);
  if (alreadyAlerted) return;

  db.prepare('UPDATE sourcetv_sessions SET alerted_at = ? WHERE id = ?')
    .run(new Date().toISOString(), opened);

  publishAdminEvent({
    kind: 'sourcetv_watch', matchId, serverId, spectatorName: row.name, steamids,
  });
}
