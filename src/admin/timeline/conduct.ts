import type { DB } from '../../db.js';
import { findSlurs } from '../../slurs.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; match_id: number | null; kind: string; detail: string; at: string }

/** Slurs this player typed in chat or used as a name, one row per line (see
 *  src/conductFlags.ts). The exact text is on the row: staff judging a slur
 *  need the letters the player typed, and the file is staff-only. */
export const conductAdapter: TimelineAdapter = {
  source: 'conduct',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT id, match_id, kind, detail, at FROM integrity_flags
       WHERE source = 'conduct' AND steamid IN (${marks(ids)})
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => {
      const what = findSlurs(r.detail).join(', ') || 'slur';
      return {
        at: toIso(r.at),
        source: 'conduct' as const,
        kind: r.kind,
        summary: r.kind === 'name'
          ? `Used the name "${r.detail}" (${what}).`
          : `Typed "${r.detail}" in chat (${what}).`,
        matchId: r.match_id,
        replay: null,
        ref: { type: 'integrity_flag', id: r.id },
      };
    });
  },
  evidence(db: DB) {
    return db.prepare(
      "SELECT steamid, MAX(at) AS at FROM integrity_flags WHERE source = 'conduct' GROUP BY steamid",
    ).all() as { steamid: string; at: string }[];
  },
};
