import type { DB } from './db.js';
import { getSetting } from './settings.js';
import { decodeIntervals, encodeIntervals, pounceSpam } from './inputStats.js';

/**
 * Storage for input bursts and the signatures that fire on them.
 *
 * Design: docs/superpowers/specs/2026-09-21-input-macro-detection-design.md
 *
 * A burst is evidence for an admin, never an accusation and never shown to
 * players. The signature that ships is the one that needs no statistical
 * tuning; the rate and variance ones wait for real player distributions.
 */

/** A human issues one or two `+attack` presses per pounce. Someone holding the
 *  button through the air issues dozens. Default rather than constant so it can
 *  be raised from settings without a deploy. */
export const DEFAULT_POUNCE_SPAM_THRESHOLD = 12;

/** Threshold from settings, so it can be raised without a deploy if a real
 *  match ever shows a legitimate player above it. Falls back to the default
 *  for an absent or nonsense value rather than disabling the signature. */
export function pounceSpamThreshold(db: DB): number {
  const raw = Number(getSetting(db, 'input_pounce_spam_threshold'));
  return Number.isFinite(raw) && raw >= 3 ? Math.floor(raw) : DEFAULT_POUNCE_SPAM_THRESHOLD;
}

export interface InputBurstInput {
  matchId: number | null;
  serverId: number | null;
  steamid: string;
  kind: 'fire' | 'pounce' | 'bhop';
  weapon: string;
  airPresses: number;
  groundTicks: number;
  serverTick: number;
  clientTick: number;
  intervals: number[];
}

export interface StoredBurst { id: number; detections: string[] }

/** Store one burst and run the shipped signatures over it. */
export function recordInputBurst(
  db: DB, b: InputBurstInput, threshold = DEFAULT_POUNCE_SPAM_THRESHOLD, now = new Date(),
): StoredBurst {
  const iso = now.toISOString();
  // encodeIntervals, never a local copy: this had its own inlined base and
  // silently drifted when the alphabet changed, so every stored burst decoded
  // to nothing on re-run and the signatures found zero.
  const encoded = encodeIntervals(b.intervals);
  const info = db.prepare(
    `INSERT INTO input_bursts (match_id, server_id, steamid, kind, weapon, n, ground_ticks,
       air_presses, server_tick, client_tick, intervals, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(b.matchId, b.serverId, b.steamid, b.kind, b.weapon, b.intervals.length,
        b.groundTicks, b.airPresses, b.serverTick, b.clientTick, encoded, iso);
  const id = Number(info.lastInsertRowid);
  const fired = runSignatures(db, id, b, threshold, iso);
  return { id, detections: fired };
}

function runSignatures(
  db: DB, burstId: number, b: InputBurstInput, threshold: number, iso: string,
): string[] {
  const fired: string[] = [];
  if (pounceSpam(b, threshold)) {
    db.prepare(
      `INSERT OR IGNORE INTO input_detections (burst_id, match_id, steamid, kind, signature, severity, at)
       VALUES (?, ?, ?, ?, 'pounce_spam', 'high', ?)`,
    ).run(burstId, b.matchId, b.steamid, b.kind, iso);
    fired.push('pounce_spam');
  }
  return fired;
}

export interface DetectionRow {
  id: number; burstId: number; matchId: number | null; steamid: string;
  kind: string; signature: string; severity: string; at: string;
}

export function detectionsForPlayer(db: DB, steamid: string, limit = 50): DetectionRow[] {
  return db.prepare(
    `SELECT id, burst_id AS burstId, match_id AS matchId, steamid, kind, signature, severity, at
     FROM input_detections WHERE steamid = ? ORDER BY at DESC LIMIT ?`,
  ).all(steamid, limit) as DetectionRow[];
}

/** Whether this is the first detection for this player in this match. The admin
 *  feed posts on that and never on later ones: a macro fires on every pounce, so
 *  posting per burst would bury the feed in one player's round. */
export function isFirstDetectionInMatch(db: DB, steamid: string, matchId: number | null): boolean {
  if (matchId === null) return false;
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM input_detections WHERE steamid = ? AND match_id = ?',
  ).get(steamid, matchId) as { c: number };
  return row.c === 1;
}

/**
 * Re-run signatures over stored bursts. This is the payoff of storing raw
 * ordered intervals: a signature written months from now applies to everything
 * recorded since day one, with nothing re-deployed to a game server.
 */
export function rerunSignatures(db: DB, threshold = DEFAULT_POUNCE_SPAM_THRESHOLD): number {
  const rows = db.prepare(
    `SELECT id, match_id AS matchId, server_id AS serverId, steamid, kind, weapon,
            ground_ticks AS groundTicks, air_presses AS airPresses,
            server_tick AS serverTick, client_tick AS clientTick, intervals, at
     FROM input_bursts ORDER BY id`,
  ).all() as (InputBurstInput & { id: number; intervals: unknown; at: string })[];
  let fired = 0;
  for (const r of rows) {
    const ticks = decodeIntervals(String(r.intervals));
    if (!ticks) continue;
    fired += runSignatures(db, r.id, { ...r, intervals: ticks }, threshold, r.at).length;
  }
  return fired;
}
