import type { DB } from '../../db.js';
import { AIM_SOURCE, aimRulesMode } from '../../aimRules.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; match_id: number | null; kind: string; detail: string; at: string }

/** What each aim rule means, in the words an admin reads. An unknown kind
 *  (a future rule) shows as itself rather than disappearing. */
const RULE_TEXT: Record<string, string> = {
  hs_share: 'Aim rule hs_share: far more headshots on infected than the pool',
  flick_return: 'Aim rule flick_return: turned 90+ degrees onto an infected for the kill and straight back',
  aimbot_multi: 'Two or more aim rules fired in one match',
};

/**
 * The aim rules' flags (src/aimRules.ts): whole matches, judged after they
 * ended, from the plugin's SI kill lines and LilAC's big snaps.
 *
 * While aim_rules is not on, the thresholds are still being re-measured, so
 * a flag is on the file for the record and never puts it in the queue: the
 * same treatment as an uncalibrated analyzer clip.
 */
export const aimAdapter: TimelineAdapter = {
  source: 'aim',
  items({ db, ids }): TimelineItem[] {
    const calibrated = aimRulesMode(db) === 'on';
    const rows = db.prepare(
      `SELECT id, match_id, kind, detail, at FROM integrity_flags
       WHERE source = ? AND steamid IN (${marks(ids)})
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(AIM_SOURCE, ...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'aim' as const,
      kind: r.kind,
      summary: `${RULE_TEXT[r.kind] ?? r.kind} (${r.detail}). Evidence, not a verdict: watch the replay before deciding anything.`,
      matchId: r.match_id,
      replay: null,
      ref: { type: 'integrity_flag', id: r.id },
      ...(calibrated ? {} : { allowed: true as const }),
    }));
  },
  evidence(db: DB) {
    if (aimRulesMode(db) !== 'on') return [];
    return db.prepare(
      'SELECT steamid, MAX(at) AS at FROM integrity_flags WHERE source = ? GROUP BY steamid',
    ).all(AIM_SOURCE) as { steamid: string; at: string }[];
  },
};
