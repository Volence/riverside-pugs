import type { DB } from '../../db.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; match_id: number | null; kind: string; severity: string; at: string }

/** Flags Little Anti-Cheat raised during play. No replay behind them, so
 *  there is nothing to watch: the value is the pattern, not the single hit.
 *  "suspected" is LilAC's own word and its own documentation says few and
 *  rare suspicions are usually false positives, which is why the line says
 *  that here too. The source column is filtered rather than assumed: the
 *  table takes flags from any plugin that wants to report one. */
export const lilacAdapter: TimelineAdapter = {
  source: 'lilac',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT id, match_id, kind, severity, at FROM integrity_flags
       WHERE source = 'lilac' AND steamid IN (${marks(ids)})
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'lilac' as const,
      kind: r.kind,
      summary: r.severity === 'banned'
        ? `Little Anti-Cheat banned this account on the game server for ${r.kind}.`
        : `Little Anti-Cheat suspected ${r.kind}. Few and rare suspicions are usually false positives; a run of them is what matters.`,
      matchId: r.match_id,
      replay: null,
      ref: { type: 'integrity_flag', id: r.id },
    }));
  },
  evidence(db: DB) {
    return db.prepare(
      "SELECT steamid, MAX(at) AS at FROM integrity_flags WHERE source = 'lilac' GROUP BY steamid",
    ).all() as { steamid: string; at: string }[];
  },
};
