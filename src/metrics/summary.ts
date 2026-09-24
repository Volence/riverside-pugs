import type { DB } from '../db.js';
import type { Phase } from './types.js';

export interface PatchSummaryRow { patchId: number | null; patchName: string | null; metric: string; rounds: number; value: number }

/** Pooled value (sum of numerators over sum of denominators) per balance patch
 *  for each metric, over rounds of completed, unvoided matches. */
export function summarizeByPatch(db: DB, metrics: string[], phase: Phase = 'all'): PatchSummaryRow[] {
  if (metrics.length === 0) return [];
  const marks = metrics.map(() => '?').join(',');
  return db.prepare(`
    SELECT c.patch_id AS patchId, p.name AS patchName, rm.metric AS metric,
           COUNT(*) AS rounds, SUM(rm.num) / SUM(rm.den) AS value
    FROM round_metrics rm
    JOIN round_metric_context c ON c.match_id = rm.match_id AND c.ordinal = rm.ordinal AND c.half = rm.half
    JOIN matches m ON m.id = rm.match_id
    LEFT JOIN balance_patches p ON p.id = c.patch_id
    WHERE rm.phase = ? AND rm.metric IN (${marks}) AND m.state = 'completed' AND m.voided_at IS NULL
    GROUP BY c.patch_id, rm.metric
    ORDER BY MIN(p.first_seen_at), c.patch_id, rm.metric`).all(phase, ...metrics) as PatchSummaryRow[];
}
