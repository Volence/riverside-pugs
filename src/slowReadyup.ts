import type { DB } from './db.js';
import { settingNumber } from './settings.js';
import { STALE_AFTER_MS } from './liveView.js';

/**
 * A ready-up that one or two players are holding up, told to staff once.
 *
 * Asked for 2026-11-15. The median ready-up is under 40 seconds, but about a
 * fifth of matches had one past five minutes, nearly always one player. Staff
 * can only nudge them if they know, so past `slow_readyup_ping_minutes` the
 * mod channel hears about it once, with the mod call role pinged.
 *
 * Only while every rostered player is on the server. Anyone dropped or not yet
 * connected is the reconnect clock's business (and, before the first connect,
 * the no-show reaper's), not this one's. So the clock starts at the later of
 * the ready-up opening and the last rostered player's current connection
 * beginning: a ready-up that began with someone still loading, or that
 * someone dropped out of and came back to, counts only from when the whole
 * roster was finally in. That is also why the match-start ready-up can count:
 * the minutes everyone spends loading in never reach the clock.
 *
 * A pause is a different phase (the plugin reports 'paused' first, even while
 * Rotoblin's unpause panel is up), so nothing pings during one. A pause inside
 * a ready-up closes that ready-up row and opens a new one after it, which
 * restarts the clock; the ping stamp is read across every row of the same map
 * and half, so the second row still cannot ping a second time.
 *
 * Queue PUGs only: tournament and scrim games have staff of their own on them,
 * and a match started in game has no reconnect tracking to say who is there.
 * Stateless like sweepPresence: the stamp is in match_readyups, so a backend
 * restart neither pings twice nor loses one.
 */

export interface SlowReadyup {
  matchId: number;
  serverId: number | null;
  serverName: string | null;
  map: string | null;
  /** Zero-based map of the match. */
  mapOrdinal: number;
  /** The half this ready-up is in front of, 1 or 2. */
  half: 1 | 2;
  /** Seconds since the clock started (see above), at the sweep that pinged. */
  waitedS: number;
  /** Still not ready, as the plugin last reported. */
  unready: string[];
}

/** 0 turns the ping off (the admin feed reads the same setting). */
export function slowReadyupMinutes(db: DB): number {
  return Math.max(0, settingNumber(db, 'slow_readyup_ping_minutes', 5));
}

/** SQLite's datetime('now') text ('YYYY-MM-DD HH:MM:SS', UTC) or an ISO string, as epoch ms. */
function toMs(s: string): number {
  return Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
}

function ids(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * When the whole roster has been on the server since, or null when somebody
 * is dropped or has never connected. A presence row is the reconnect
 * system's word; connected_at stands in for a player who has none (their
 * first connect line was the only one, or it predates the row).
 */
export function rosterInSince(db: DB, matchId: number): number | null {
  const rows = db.prepare(
    `SELECT mp.connected_at, pr.state, pr.since
       FROM match_players mp
       LEFT JOIN match_presence pr ON pr.match_id = mp.match_id AND pr.steamid = mp.player_id
      WHERE mp.match_id = ?`,
  ).all(matchId) as { connected_at: string | null; state: string | null; since: string | null }[];
  if (rows.length === 0) return null;
  let latest = 0;
  for (const r of rows) {
    let since: number;
    if (r.state === 'dropped') return null;
    if (r.state === 'connected' && r.since) since = toMs(r.since);
    else if (r.state === null && r.connected_at) since = toMs(r.connected_at);
    else return null;
    if (!Number.isFinite(since)) return null;
    latest = Math.max(latest, since);
  }
  return latest;
}

export function sweepSlowReadyups(db: DB, now = new Date()): SlowReadyup[] {
  const minutes = slowReadyupMinutes(db);
  if (minutes <= 0) return [];
  const limitMs = minutes * 60_000;
  const nowMs = now.getTime();

  const open = db.prepare(
    `SELECT r.id, r.match_id, r.map_ordinal, r.half, r.started_at,
            l.phase_unready, l.last_seen, l.current_map, m.server_id, s.name AS server_name
       FROM match_readyups r
       JOIN matches m ON m.id = r.match_id
       JOIN match_live l ON l.match_id = r.match_id
       LEFT JOIN servers s ON s.id = m.server_id
      WHERE r.ended_at IS NULL AND r.staff_pinged_at IS NULL
        AND m.state = 'live' AND m.kind = 'pug' AND m.booking_id IS NULL AND m.origin = 'queue'
        AND l.phase = 'readyup'
        AND (r.half IS NULL OR r.half = 1)
        AND NOT EXISTS (
          SELECT 1 FROM match_readyups o
           WHERE o.match_id = r.match_id AND o.map_ordinal = r.map_ordinal AND o.half IS r.half
             AND o.staff_pinged_at IS NOT NULL)
      ORDER BY r.id`,
  ).all() as {
    id: number; match_id: number; map_ordinal: number; half: number | null; started_at: string;
    phase_unready: string | null; last_seen: string | null; current_map: string | null;
    server_id: number | null; server_name: string | null;
  }[];

  const out: SlowReadyup[] = [];
  for (const r of open) {
    // A box that has gone quiet is not a slow ready-up; the reapers own it.
    if (!r.last_seen || nowMs - toMs(r.last_seen) > STALE_AFTER_MS) continue;
    // Empty: the go-live countdown, or a plugin that cannot say who.
    const unready = ids(r.phase_unready);
    if (unready.length === 0) continue;
    const inSince = rosterInSince(db, r.match_id);
    if (inSince === null) continue;
    const startMs = Math.max(toMs(r.started_at), inSince);
    const waited = nowMs - startMs;
    if (!Number.isFinite(waited) || waited < limitMs) continue;
    const stamped = db.prepare(
      'UPDATE match_readyups SET staff_pinged_at = ? WHERE id = ? AND staff_pinged_at IS NULL',
    ).run(now.toISOString(), r.id).changes;
    if (stamped !== 1) continue;
    out.push({
      matchId: r.match_id,
      serverId: r.server_id,
      serverName: r.server_name,
      map: r.current_map,
      mapOrdinal: r.map_ordinal,
      half: r.half === 1 ? 2 : 1,
      waitedS: Math.floor(waited / 1000),
      unready,
    });
  }
  return out;
}
