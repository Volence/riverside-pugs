import { buildTimeline } from './timeline.js';
import type { MetricDef, Phase, RoundCtx, RoundInput } from './types.js';
import { defs as outcomes } from './defs/outcomes.js';
import { defs as pace } from './defs/pace.js';
import { defs as tank } from './defs/tank.js';
import { defs as witch } from './defs/witch.js';
import { defs as si } from './defs/si.js';
import { defs as weapons } from './defs/weapons.js';

export const METRICS: MetricDef[] = [...outcomes, ...pace, ...tank, ...witch, ...si, ...weapons];

/** Changes whenever a metric is added, removed or has its version bumped; the
 *  job recomputes every round whose stored engine differs. */
export const ENGINE = METRICS.map((m) => `${m.id}:${m.version}`).sort().join(',');

export interface MetricRow { metric: string; phase: Phase; num: number; den: number }

export function computeRound(input: RoundInput): MetricRow[] {
  const ctx: RoundCtx = { ...input, timeline: input.replay ? buildTimeline(input.replay, input.marks) : null };
  const rows: MetricRow[] = [];
  for (const m of METRICS) {
    let out;
    try { out = m.compute(ctx); } catch (err) {
      console.error(`[metrics] ${m.id} failed on match ${input.key.matchId} round ${input.key.ordinal}/${input.key.half}`, err);
      continue;
    }
    if (!out) continue;
    for (const [phase, r] of Object.entries(out) as [Phase, { num: number; den: number }][]) {
      if (!r || !Number.isFinite(r.num) || !Number.isFinite(r.den) || r.den <= 0) continue;
      rows.push({ metric: m.id, phase, num: r.num, den: r.den });
    }
  }
  return rows;
}
