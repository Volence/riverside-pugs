import type { DB } from '../../db.js';
import { ENGINE } from '../registry.js';
import type { Phase } from '../types.js';
import type { MatchSample } from './stats.js';
import type { SideQuery, SideSummary } from './types.js';

export interface SideData { summary: SideSummary; samples: Map<string, MatchSample[]> }

export const rowKey = (metric: string, phase: Phase) => `${metric}|${phase}`;
const UNKNOWN_MAP = '(unknown map)';

/** WHERE fragment over c (round_metric_context) and m (matches). */
export function sideFilterSql(q: SideQuery): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [];
  const parts = ["m.state = 'completed'", 'm.voided_at IS NULL'];
  parts.push(`c.patch_id IN (${q.patchIds.map(() => '?').join(',') || 'NULL'})`);
  params.push(...q.patchIds);
  if (q.origin !== 'all') { parts.push('c.origin = ?'); params.push(q.origin); }
  if (q.maps && q.maps.length > 0) {
    parts.push(`COALESCE(c.map, '${UNKNOWN_MAP}') IN (${q.maps.map(() => '?').join(',')})`);
    params.push(...q.maps);
  }
  return { sql: parts.join(' AND '), params };
}

export function loadSide(db: DB, q: SideQuery, phases: Phase[]): SideData {
  const f = sideFilterSql(q);
  const s = db.prepare(`
    SELECT COUNT(DISTINCT c.match_id) AS matches, COUNT(*) AS rounds,
           AVG(CASE WHEN c.surv_mu IS NOT NULL AND c.inf_mu IS NOT NULL THEN (c.surv_mu + c.inf_mu) / 2 END) AS meanMu,
           AVG(CASE WHEN c.surv_mu IS NOT NULL AND c.inf_mu IS NOT NULL THEN c.surv_mu - c.inf_mu END) AS meanGap,
           SUM(CASE WHEN c.engine != ? THEN 1 ELSE 0 END) AS older
    FROM round_metric_context c JOIN matches m ON m.id = c.match_id
    WHERE ${f.sql}`).get(ENGINE, ...f.params) as
    { matches: number; rounds: number; meanMu: number | null; meanGap: number | null; older: number | null };
  const historical = q.patchIds.length > 0 && (db.prepare(
    `SELECT COUNT(*) AS n FROM balance_patches WHERE source = 'historical' AND id IN (${q.patchIds.map(() => '?').join(',')})`,
  ).get(...q.patchIds) as { n: number }).n > 0;

  const rows = phases.length === 0 ? [] : db.prepare(`
    SELECT rm.match_id AS matchId, COALESCE(c.map, '${UNKNOWN_MAP}') AS map, rm.metric AS metric, rm.phase AS phase,
           SUM(rm.num) AS num, SUM(rm.den) AS den
    FROM round_metrics rm
    JOIN round_metric_context c ON c.match_id = rm.match_id AND c.ordinal = rm.ordinal AND c.half = rm.half
    JOIN matches m ON m.id = rm.match_id
    WHERE ${f.sql} AND rm.phase IN (${phases.map(() => '?').join(',')})
    GROUP BY rm.match_id, map, rm.metric, rm.phase
    ORDER BY rm.match_id`).all(...f.params, ...phases) as
    { matchId: number; map: string; metric: string; phase: Phase; num: number; den: number }[];

  const byKey = new Map<string, Map<number, MatchSample>>();
  for (const r of rows) {
    const k = rowKey(r.metric, r.phase);
    let perMatch = byKey.get(k);
    if (!perMatch) { perMatch = new Map(); byKey.set(k, perMatch); }
    let sample = perMatch.get(r.matchId);
    if (!sample) { sample = new Map(); perMatch.set(r.matchId, sample); }
    sample.set(r.map, { num: r.num, den: r.den });
  }
  const samples = new Map<string, MatchSample[]>();
  for (const [k, v] of byKey) samples.set(k, [...v.values()]);
  return {
    summary: {
      matches: s.matches, rounds: s.rounds, meanMu: s.meanMu, meanGap: s.meanGap,
      olderEngineRounds: s.older ?? 0, historical,
    },
    samples,
  };
}
