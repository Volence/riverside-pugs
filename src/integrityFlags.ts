import type { DB } from './db.js';

/**
 * Flags raised by something other than the replay analyser: today Little
 * Anti-Cheat, reported live from the game server.
 *
 * These sit beside integrity_clips rather than inside them. A clip is a span of
 * a recorded round that an analyser scored and that an admin can watch; a flag
 * is a moment another plugin shouted about, with no replay behind it. Folding
 * them together would mean either inventing start and end times a flag does not
 * have, or loosening the clip schema for everything.
 *
 * A flag is evidence for an admin and is never shown to players.
 */

/** LilAC's Lilac_DetectionType. Its own header says, in capitals, that these
 *  numbers must never change because forwards depend on them, so the numbers
 *  are the stable part and the names are ours. Pinned by test: if upstream ever
 *  renumbers, the test fails rather than the admin list quietly relabelling one
 *  cheat as another. */
export const LILAC_CHEATS: Record<number, string> = {
  0: 'angles',
  1: 'chatclear',
  2: 'convar',
  3: 'nolerp',
  4: 'bhop',
  5: 'aimbot',
  6: 'aimlock',
  7: 'anti_duck_delay',
  8: 'noisemaker_spam',
  9: 'macro',
  10: 'newline_name',
};

export function cheatName(n: number): string {
  return LILAC_CHEATS[n] ?? `unknown(${n})`;
}

/** The match a flag or an input burst is evidence ABOUT: the live one on this
 *  server that the player is rostered in, or null. Not simply the newest live
 *  match on the box, which files a spectator's flag on a game they were not
 *  playing and lets a stale live match take evidence from the real one.
 *  `steamid` is the canonical id, which is what match_players holds. */
export function liveMatchOf(db: DB, serverId: number | null, steamid: string): number | null {
  if (serverId === null) return null;
  const row = db.prepare(
    `SELECT m.id FROM matches m JOIN match_players mp ON mp.match_id = m.id
     WHERE m.state = 'live' AND m.server_id = ? AND mp.player_id = ?
     ORDER BY m.id DESC LIMIT 1`,
  ).get(serverId, steamid) as { id: number } | undefined;
  return row?.id ?? null;
}

/** LilAC fires repeatedly while a cheat looks active, so one player in one round
 *  can produce a long run of identical flags. The admin list wants the event,
 *  not every repetition, and an un-deduped feed would bury everything else. */
export const DEDUPE_MS = 60_000;

export type FlagSeverity = 'suspected' | 'banned';

export interface IntegrityFlagInput {
  matchId: number | null;
  serverId: number | null;
  steamid: string;
  source: string;
  kind: string;
  severity: FlagSeverity;
  detail: string;
}

export interface IntegrityFlagRow extends IntegrityFlagInput { id: number; at: string }

/** Store one flag. Returns null when it was collapsed into a recent identical
 *  one, so the caller knows whether to announce it. */
export function recordIntegrityFlag(
  db: DB, f: IntegrityFlagInput, now = new Date(),
): IntegrityFlagRow | null {
  const iso = now.toISOString();
  const since = new Date(now.getTime() - DEDUPE_MS).toISOString();
  const dup = db.prepare(
    `SELECT 1 FROM integrity_flags
     WHERE steamid = ? AND source = ? AND kind = ? AND severity = ? AND at > ? AND at <= ?
     LIMIT 1`,
  ).get(f.steamid, f.source, f.kind, f.severity, since, iso);
  if (dup) return null;

  const info = db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(f.matchId, f.serverId, f.steamid, f.source, f.kind, f.severity, f.detail, iso);
  return { ...f, id: Number(info.lastInsertRowid), at: iso };
}

const SELECT = `SELECT id, match_id AS matchId, server_id AS serverId, steamid, source,
                       kind, severity, detail, at FROM integrity_flags`;

export function flagsForPlayer(db: DB, steamid: string, limit = 50): IntegrityFlagRow[] {
  return db.prepare(`${SELECT} WHERE steamid = ? ORDER BY at DESC, id DESC LIMIT ?`)
    .all(steamid, limit) as IntegrityFlagRow[];
}

export function recentFlags(db: DB, limit = 100): IntegrityFlagRow[] {
  return db.prepare(`${SELECT} ORDER BY at DESC, id DESC LIMIT ?`).all(limit) as IntegrityFlagRow[];
}

export interface CaptureHealth {
  bursts: number;
  detections: number;
  lilacFlags: number;
  lastBurstAt: string | null;
  lastFlagAt: string | null;
  matchesWithBursts: number;
}

/**
 * Whether anything is being captured at all.
 *
 * Exists because an empty panel cannot tell you the difference between "nothing
 * suspicious happened" and "the pipeline is silently broken", and on the first
 * day of a detector that distinction is the only thing worth knowing.
 */
export function captureHealth(db: DB): CaptureHealth {
  const one = (sql: string): number =>
    (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
  const at = (sql: string): string | null =>
    (db.prepare(sql).get() as { a: string | null } | undefined)?.a ?? null;
  return {
    bursts: one('SELECT COUNT(*) AS c FROM input_bursts'),
    detections: one('SELECT COUNT(*) AS c FROM input_detections'),
    lilacFlags: one('SELECT COUNT(*) AS c FROM integrity_flags'),
    lastBurstAt: at('SELECT MAX(at) AS a FROM input_bursts'),
    lastFlagAt: at('SELECT MAX(at) AS a FROM integrity_flags'),
    matchesWithBursts: one('SELECT COUNT(DISTINCT match_id) AS c FROM input_bursts WHERE match_id IS NOT NULL'),
  };
}

export interface RecentFlag {
  id: number;
  kind: string;
  source: string;
  severity: string;
  steamid: string;
  name: string;
  matchId: number | null;
  at: string;
}

/** Everything flagged recently, across all players and both sources, so the
 *  panel has a front door instead of requiring you to guess whom to open. */
export function recentFlagFeed(db: DB, limit = 50): RecentFlag[] {
  const rows = db.prepare(
    `SELECT f.id, f.kind, f.source, f.severity, f.steamid, f.match_id AS matchId, f.at,
            COALESCE(p.name, f.steamid) AS name
     FROM integrity_flags f LEFT JOIN players p ON p.steamid = f.steamid
     UNION ALL
     SELECT d.id, d.signature AS kind, 'inputstats' AS source, d.severity, d.steamid,
            d.match_id AS matchId, d.at, COALESCE(p.name, d.steamid) AS name
     FROM input_detections d LEFT JOIN players p ON p.steamid = d.steamid
     ORDER BY at DESC, id DESC LIMIT ?`,
  ).all(limit) as RecentFlag[];
  return rows;
}
