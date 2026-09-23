import type { MetricOut, Phase, RoundCtx, RoundEvent, SubPhase } from './types.js';
import { SUB_PHASES } from './types.js';

export function onSide(c: RoundCtx, steamid: string, side: 'survivor' | 'infected'): boolean {
  const t = c.teamOf.get(steamid);
  if (t === undefined) return false;
  return side === 'survivor' ? t === c.survTeam : t !== c.survTeam;
}

export function sideStat(c: RoundCtx, side: 'survivor' | 'infected', stat: string): number {
  let n = 0;
  for (const [p, m] of c.stats) if (onSide(c, p, side)) n += m.get(stat) ?? 0;
  return n;
}

const TANK = 5;
export function classAt(c: RoundCtx, steamid: string, tMs: number): number | null {
  let cls: number | null = null;
  for (const e of c.events) {
    if (e.tMs > tMs || e.tMs < 0) continue;
    if (e.actor !== steamid) continue;
    if (e.kind === 'si_spawn') cls = e.value;
    else if (e.kind === 'tank_spawn' || e.kind === 'tank_take') cls = TANK;
  }
  return cls;
}

function phaseOf(c: RoundCtx, e: RoundEvent): SubPhase | null {
  return c.timeline && e.tMs >= 0 ? c.timeline.phaseAt(e.tMs) : null;
}

function sums(c: RoundCtx, evs: RoundEvent[], weight: (e: RoundEvent) => number) {
  const s: Record<Phase, number> = { all: 0, tank: 0, witch: 0, event: 0, normal: 0 };
  for (const e of evs) {
    const w = weight(e);
    s.all += w;
    const p = phaseOf(c, e);
    if (p) s[p] += w;
  }
  return s;
}

const one = () => 1;

export function single(num: number, den = 1): MetricOut {
  return { all: { num, den } };
}

export function countByPhase(c: RoundCtx, evs: RoundEvent[], weight: (e: RoundEvent) => number = one): MetricOut {
  const s = sums(c, evs, weight);
  const out: MetricOut = { all: { num: s.all, den: 1 } };
  if (c.timeline) for (const p of SUB_PHASES) if (c.timeline.minutes(p) > 0) out[p] = { num: s[p], den: 1 };
  return out;
}

export function perMinute(c: RoundCtx, evs: RoundEvent[], weight: (e: RoundEvent) => number = one): MetricOut | null {
  if (!c.timeline) return null;
  const s = sums(c, evs, weight);
  const out: MetricOut = {};
  for (const p of ['all', ...SUB_PHASES] as Phase[]) {
    const m = c.timeline.minutes(p);
    if (m > 0) out[p] = { num: s[p], den: m };
  }
  return out.all ? out : null;
}

export function ratioByPhase(c: RoundCtx, numEvs: RoundEvent[], denEvs: RoundEvent[],
  numWeight: (e: RoundEvent) => number = one): MetricOut | null {
  const n = sums(c, numEvs, numWeight);
  const d = sums(c, denEvs, one);
  if (d.all === 0) return null;
  const out: MetricOut = { all: { num: n.all, den: d.all } };
  if (c.timeline) for (const p of SUB_PHASES) if (d[p] > 0) out[p] = { num: n[p], den: d[p] };
  return out;
}

/** Events of one kind. */
export const kind = (c: RoundCtx, k: string) => c.events.filter((e) => e.kind === k);
