import type { DB } from '../../db.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row {
  id: number; match_id: number | null; kind: string; signature: string;
  severity: string; at: string; hits: number; note: string;
}

import { STEADY_TAPS, isWheel } from '../../inputStats.js';

/** Input-timing detections. A row exists only once a signature has repeated
 *  across separate bursts in one match, so each one is already a pattern and
 *  not a single fast burst. It is still evidence to read beside the replay,
 *  and the summary says so rather than leaving the reader to supply it. */
export const inputAdapter: TimelineAdapter = {
  source: 'input',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT id, match_id, kind, signature, severity, at, hits, note
       FROM input_detections WHERE steamid IN (${marks(ids)})
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'input' as const,
      kind: r.signature,
      summary: isWheel(r.note)
        ? `Input check ${r.signature} on ${r.hits} ${r.kind} burst${r.hits === 1 ? '' : 's'}, one-tick presses of a `
          + 'scroll wheel bind, which is allowed. Kept for the record, not a flag.'
        : `Input check ${r.signature} on ${r.hits} ${r.kind} burst${r.hits === 1 ? '' : 's'}`
          + `${r.note.startsWith(STEADY_TAPS)
            ? ', one-tick presses at a fixed rate no hand-spun scroll wheel holds (a rapid-fire bind or mouse auto-fire)'
            : r.note ? `, holds look ${r.note}` : ''}. Button timing, to be read beside the replay.`,
      matchId: r.match_id,
      replay: null,
      ref: { type: 'input_detection', id: r.id },
      ...(isWheel(r.note) ? { allowed: true as const } : {}),
    }));
  },
  evidence(db: DB) {
    return db.prepare(
      `SELECT steamid, MAX(at) AS at FROM input_detections
       WHERE note NOT LIKE 'wheel-like%' GROUP BY steamid`,
    )
      .all() as { steamid: string; at: string }[];
  },
};
