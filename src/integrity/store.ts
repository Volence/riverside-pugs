import type { DB } from '../db.js';
import type { PriorTable } from './aimPrior.js';
import type { RoundMetrics, TrackWindow } from './ghostTrack.js';

/** Bump whenever a metric changes MEANING, so stale rows are identifiable
 *  without guessing from computed_at. */
export const ANALYZER_VERSION = 1;

export interface RoundKey { matchId: number; ordinal: number; half: number }
export interface SaveRow { slot: number; steamid: string; metrics: RoundMetrics; clips: TrackWindow[] }

const countsToJson = (m: Map<string, number>): string => JSON.stringify([...m]);
const countsFromJson = (s: string): Map<string, number> => new Map(JSON.parse(s) as [string, number][]);

/** Write one round's analysis, replacing any previous one.
 *
 *  Deliberately does NOT touch integrity_reviews. An admin's judgement outlives
 *  the numbers that prompted it. */
export function saveRound(db: DB, key: RoundKey, rows: SaveRow[]): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM integrity_rounds WHERE match_id = ? AND ordinal = ? AND half = ?')
      .run(key.matchId, key.ordinal, key.half);
    db.prepare('DELETE FROM integrity_clips WHERE match_id = ? AND ordinal = ? AND half = ?')
      .run(key.matchId, key.ordinal, key.half);
    const insRound = db.prepare(
      `INSERT INTO integrity_rounds (match_id, ordinal, half, slot, steamid, analyzer_version, metrics, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insClip = db.prepare(
      `INSERT INTO integrity_clips (match_id, ordinal, half, slot, steamid, start_ms, end_ms, kind, score, detail, analyzer_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insRound.run(key.matchId, key.ordinal, key.half, r.slot, r.steamid, ANALYZER_VERSION, JSON.stringify(r.metrics), now);
      for (const c of r.clips) {
        insClip.run(
          key.matchId, key.ordinal, key.half, r.slot, r.steamid, c.startMs, c.endMs,
          'ghost_track', c.fidelity, JSON.stringify({ ghostSlot: c.ghostSlot, meanErr: c.meanErr, meanDist: c.meanDist }),
          ANALYZER_VERSION,
        );
      }
    }
  });
  tx();
}

export function savePrior(db: DB, map: string, pool: PriorTable, rounds: number): void {
  db.prepare(
    `INSERT INTO integrity_prior (map, frames, rounds, counts, analyzer_version) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(map) DO UPDATE SET frames = excluded.frames, rounds = excluded.rounds,
       counts = excluded.counts, analyzer_version = excluded.analyzer_version`,
  ).run(map, pool.frames, rounds, countsToJson(pool.counts), ANALYZER_VERSION);
}

export function loadPrior(db: DB, map: string): { table: PriorTable; rounds: number } | null {
  const row = db.prepare('SELECT frames, rounds, counts FROM integrity_prior WHERE map = ?').get(map) as
    { frames: number; rounds: number; counts: string } | undefined;
  if (!row) return null;
  return { table: { frames: row.frames, counts: countsFromJson(row.counts) }, rounds: row.rounds };
}

export function saveRoundPrior(db: DB, key: RoundKey, p: PriorTable): void {
  db.prepare(
    `INSERT INTO integrity_prior_rounds (match_id, ordinal, half, frames, counts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(match_id, ordinal, half) DO UPDATE SET frames = excluded.frames, counts = excluded.counts`,
  ).run(key.matchId, key.ordinal, key.half, p.frames, countsToJson(p.counts));
}

export function loadRoundPrior(db: DB, key: RoundKey): PriorTable | null {
  const row = db.prepare('SELECT frames, counts FROM integrity_prior_rounds WHERE match_id = ? AND ordinal = ? AND half = ?')
    .get(key.matchId, key.ordinal, key.half) as { frames: number; counts: string } | undefined;
  if (!row) return null;
  return { frames: row.frames, counts: countsFromJson(row.counts) };
}

export function setReview(db: DB, key: RoundKey, slot: number, state: string, note: string, adminId: string): void {
  db.prepare(
    `INSERT INTO integrity_reviews (match_id, ordinal, half, slot, state, note, reviewed_by, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(match_id, ordinal, half, slot) DO UPDATE SET state = excluded.state, note = excluded.note,
       reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`,
  ).run(key.matchId, key.ordinal, key.half, slot, state, note, adminId, new Date().toISOString());
}
