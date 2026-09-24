import type { DB } from './db.js';

export interface PublicPatch {
  id: number; number: number; name: string; notes: string;
  source: 'announced' | 'detected' | 'historical';
  /** The patch itself is a historical reconstruction. */
  approximate: boolean;
  /** First and last counted round (match_rounds.started_at, falling back to matches.ended_at). */
  firstRound: string | null; lastRound: string | null;
  matches: number; rounds: number;
  publishedAt: string | null;
}

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Every patch with its counted-round stats, ordered for the public timeline:
 *  by first counted round, else first_seen_at, then id. */
export function patchTimeline(db: DB): (PublicPatch & { hasInputs: boolean })[] {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.notes, p.source, p.first_seen_at, p.published_at, p.inputs_json IS NOT NULL AS has_inputs,
           ROW_NUMBER() OVER (ORDER BY p.first_seen_at, p.id) AS number,
           s.matches, s.rounds, s.first_round, s.last_round
    FROM balance_patches p
    LEFT JOIN (
      SELECT c.patch_id, COUNT(DISTINCT c.match_id) AS matches, COUNT(*) AS rounds,
             MIN(COALESCE(r.started_at, m.ended_at)) AS first_round, MAX(COALESCE(r.started_at, m.ended_at)) AS last_round
      FROM round_metric_context c
      JOIN matches m ON m.id = c.match_id
      LEFT JOIN match_rounds r ON r.match_id = c.match_id AND r.ordinal = c.ordinal AND r.half = c.half
      WHERE m.state = 'completed' AND m.voided_at IS NULL AND c.patch_id IS NOT NULL
      GROUP BY c.patch_id
    ) s ON s.patch_id = p.id`).all() as {
      id: number; name: string | null; notes: string; source: PublicPatch['source']; first_seen_at: string;
      published_at: string | null; has_inputs: number; number: number;
      matches: number | null; rounds: number | null; first_round: string | null; last_round: string | null }[];
  rows.sort((x, y) => (x.first_round ?? x.first_seen_at).localeCompare(y.first_round ?? y.first_seen_at) || x.id - y.id);
  return rows.map((r) => ({
    id: r.id, number: r.number,
    // A published patch whose name was later cleared still needs a heading.
    name: r.name?.trim() ? r.name : `Patch ${r.number}`,
    notes: r.notes, source: r.source, approximate: r.source === 'historical',
    firstRound: r.first_round, lastRound: r.last_round, matches: r.matches ?? 0, rounds: r.rounds ?? 0,
    publishedAt: r.published_at, hasInputs: r.has_inputs === 1,
  }));
}

const strip = ({ hasInputs: _h, ...p }: PublicPatch & { hasInputs: boolean }): PublicPatch => p;

/** Published patches newest first. */
export function listPublished(db: DB): PublicPatch[] {
  return patchTimeline(db).filter((p) => p.publishedAt !== null).reverse().map(strip);
}

export type PublishResult = { ok: true } | { ok: false; status: 400 | 404; error: string };

export function publishPatch(db: DB, id: number, published: boolean, now: string = nowSql()): PublishResult {
  const row = db.prepare('SELECT name, notes, published_at FROM balance_patches WHERE id = ?').get(id) as
    { name: string | null; notes: string; published_at: string | null } | undefined;
  if (!row) return { ok: false, status: 404, error: 'no such patch' };
  if (!published) {
    db.prepare('UPDATE balance_patches SET published_at = NULL WHERE id = ?').run(id);
    return { ok: true };
  }
  const p = patchTimeline(db).find((x) => x.id === id)!;
  const missing = [
    !row.name?.trim() && 'a name', !row.notes.trim() && 'notes', p.rounds === 0 && 'at least one counted round',
  ].filter(Boolean);
  if (missing.length) return { ok: false, status: 400, error: `publishing needs ${missing.join(', ')}` };
  if (row.published_at === null) db.prepare('UPDATE balance_patches SET published_at = ? WHERE id = ?').run(now, id);
  return { ok: true };
}
