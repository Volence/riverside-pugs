import { reviewsOf } from '../reviews.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; author_id: string; author_name: string | null; text: string; created_at: string }

/** What staff have written about this player by hand, and every time one of
 *  them marked the file looked at. A review belongs beside the notes because
 *  "somebody read this and thought it was fine" is exactly what the next
 *  person needs to know before reading the same evidence again. */
export const notesAdapter: TimelineAdapter = {
  source: 'note',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT n.id, n.author_id, a.name AS author_name, n.text, n.created_at
       FROM player_notes n LEFT JOIN players a ON a.steamid = n.author_id
       WHERE n.player_id IN (${marks(ids)}) ORDER BY n.id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    const notes: TimelineItem[] = rows.map((r) => ({
      at: toIso(r.created_at),
      source: 'note' as const,
      kind: 'note',
      summary: `${r.author_name ?? r.author_id}: ${r.text}`,
      matchId: null,
      replay: null,
      ref: { type: 'note', id: r.id },
    }));
    const reviews: TimelineItem[] = reviewsOf(db, ids, ROW_LIMIT).map((r) => ({
      at: r.reviewedAt,
      source: 'note' as const,
      kind: 'review',
      summary: `${r.reviewedByName ?? r.reviewedBy} looked at this file`
        + `${r.note ? `: ${r.note}` : '.'}`,
      matchId: null,
      replay: null,
      ref: { type: 'review', id: r.id },
    }));
    return [...notes, ...reviews];
  },
};
