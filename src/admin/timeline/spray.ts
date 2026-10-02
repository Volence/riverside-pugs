import type { DB } from '../../db.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; match_id: number | null; detail: string; at: string }

/** Crash sprays spray_exploit_fixer caught (l4d_spray_report's L4DS line).
 *  Each was blocked before anyone saw it, so this is a record of intent: no
 *  real spray fails the header check (all 89 on Dallas passed, 2026-10-02). */
export const sprayAdapter: TimelineAdapter = {
  source: 'spray',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT id, match_id, detail, at FROM integrity_flags
       WHERE source = 'spray' AND steamid IN (${marks(ids)})
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => {
      const crc = /^crc=([0-9a-f]{8})/.exec(r.detail)?.[1] ?? '?';
      return {
        at: toIso(r.at),
        source: 'spray' as const,
        kind: 'crash_spray',
        summary: `Tried to use a crash spray (file ${crc}, a malformed VTF that crashes anyone who sees it). `
          + 'The server blocked it and kicked them.',
        matchId: r.match_id,
        replay: null,
        ref: { type: 'integrity_flag', id: r.id },
      };
    });
  },
  evidence(db: DB) {
    return db.prepare(
      "SELECT steamid, MAX(at) AS at FROM integrity_flags WHERE source = 'spray' GROUP BY steamid",
    ).all() as { steamid: string; at: string }[];
  },
};
