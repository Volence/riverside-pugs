import type { DB } from '../db.js';
import { resolveAlias } from '../aliases.js';
import { marks, toIso } from './timeline/types.js';

export interface FileReview {
  id: number;
  steamid: string;
  reviewedBy: string;
  reviewedByName: string | null;
  reviewedAt: string;
  note: string;
}

interface Row { id: number; steamid: string; reviewed_by: string; name: string | null; reviewed_at: string; note: string }

const SELECT = `SELECT r.id, r.steamid, r.reviewed_by, p.name, r.reviewed_at, r.note
  FROM player_reviews r LEFT JOIN players p ON p.steamid = r.reviewed_by`;

const toReview = (r: Row): FileReview => ({
  id: r.id, steamid: r.steamid, reviewedBy: r.reviewed_by, reviewedByName: r.name,
  reviewedAt: toIso(r.reviewed_at), note: r.note,
});

/** Somebody looked. Written against the canonical account, so a review of a
 *  file reached through a merged alt still settles the person. */
export function markLookedAt(
  db: DB, steamid: string, by: string, note = '', now = new Date(),
): FileReview {
  const canonical = resolveAlias(db, steamid);
  const at = now.toISOString();
  const id = Number(db.prepare(
    'INSERT INTO player_reviews (steamid, reviewed_by, reviewed_at, note) VALUES (?, ?, ?, ?)',
  ).run(canonical, by, at, note.slice(0, 1000)).lastInsertRowid);
  return toReview(db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as Row);
}

/** The newest review of this file, or null. */
export function lastReviewOf(db: DB, steamid: string): FileReview | null {
  const canonical = resolveAlias(db, steamid);
  const row = db.prepare(
    `${SELECT} WHERE r.steamid = ? ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1`,
  ).get(canonical) as Row | undefined;
  return row ? toReview(row) : null;
}

/** Every review held under any of these ids, newest first. For the timeline,
 *  which already knows the canonical id and each alias. */
export function reviewsOf(db: DB, ids: string[], limit = 200): FileReview[] {
  return (db.prepare(
    `${SELECT} WHERE r.steamid IN (${marks(ids)}) ORDER BY r.id DESC LIMIT ?`,
  ).all(...ids, limit) as Row[]).map(toReview);
}
