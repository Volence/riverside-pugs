import type { DB } from '../../db.js';
import { cvarActOf } from '../../integrityFlags.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; match_id: number | null; kind: string; detail: string; at: string }

/** What each watched client setting means, in one sentence an admin can act on. */
const MEANING: Record<string, string> = {
  cpu_level: 'low effect detail, which thins smoke, fire and the boomer cloud enough to see infected through. '
    + 'Some players set it for frame rate; the server settings check expects 1 or higher',
};

function summaryOf(r: Row): string {
  const value = /^value=(\S+)/.exec(r.detail)?.[1] ?? '?';
  const meaning = MEANING[r.kind] ?? 'a setting outside the allowed range';
  switch (cvarActOf(r.detail)) {
    case 'held': return `Held in ready-up for ${r.kind} ${value}: ${meaning}.`;
    case 'fixed': return `Changed ${r.kind} to ${value} after being held in ready-up.`;
    default: return `Played with ${r.kind} ${value}: ${meaning}.`;
  }
}

/** Client settings l4d_cvarwatch reported out of bounds: one row per
 *  connection that had it, not one per poll. */
export const cvarAdapter: TimelineAdapter = {
  source: 'cvar',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT id, match_id, kind, detail, at FROM integrity_flags
       WHERE source = 'cvar' AND steamid IN (${marks(ids)})
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'cvar' as const,
      // A fix is on the timeline but is not evidence; isEvidence reads this.
      kind: cvarActOf(r.detail) === 'fixed' ? `${r.kind}_fixed` : r.kind,
      summary: summaryOf(r),
      matchId: r.match_id,
      replay: null,
      ref: { type: 'integrity_flag', id: r.id },
    }));
  },
  evidence(db: DB) {
    return db.prepare(
      "SELECT steamid, MAX(at) AS at FROM integrity_flags WHERE source = 'cvar' AND detail NOT LIKE '% act=fixed' GROUP BY steamid",
    ).all() as { steamid: string; at: string }[];
  },
};
