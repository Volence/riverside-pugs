import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; author_id: string; author_name: string | null; text: string; created_at: string }

/** What staff have written about this player by hand. Reviews land here too
 *  once Task 5 adds them, because "somebody looked at this and thought it was
 *  fine" is exactly the kind of note the next person needs. */
export const notesAdapter: TimelineAdapter = {
  source: 'note',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT n.id, n.author_id, a.name AS author_name, n.text, n.created_at
       FROM player_notes n LEFT JOIN players a ON a.steamid = n.author_id
       WHERE n.player_id IN (${marks(ids)}) ORDER BY n.id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.created_at),
      source: 'note' as const,
      kind: 'note',
      summary: `${r.author_name ?? r.author_id}: ${r.text}`,
      matchId: null,
      replay: null,
      ref: { type: 'note', id: r.id },
    }));
  },
};
