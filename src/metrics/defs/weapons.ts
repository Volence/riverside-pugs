import type { MetricDef, MetricOut, Phase, RoundCtx } from '../types.js';
import { SUB_PHASES } from '../types.js';
import { sideStat } from '../kit.js';
import { liveSurvivors } from '../timeline.js';

/** Replay weapon ids 1 to 6, in id order. */
export const GUNS = ['pistol', 'smg', 'pumpshotgun', 'autoshotgun', 'rifle', 'hunting_rifle'] as const;
const LABEL: Record<(typeof GUNS)[number], string> = {
  pistol: 'pistols', smg: 'the Uzi', pumpshotgun: 'the pump shotgun', autoshotgun: 'the auto shotgun',
  rifle: 'the assault rifle', hunting_rifle: 'the hunting rifle',
};

const PUBLIC_HOLD: Partial<Record<(typeof GUNS)[number], string>> = {
  pumpshotgun: 'Time holding the pump shotgun', smg: 'Time holding the Uzi',
};

function holdShare(c: RoundCtx, id: number): MetricOut | null {
  if (!c.replay || !c.timeline) return null;
  const held: Record<Phase, number> = { all: 0, tank: 0, witch: 0, event: 0, normal: 0 };
  const total: Record<Phase, number> = { all: 0, tank: 0, witch: 0, event: 0, normal: 0 };
  for (const f of c.replay.frames) {
    const p = c.timeline.phaseAt(f.tMs);
    for (const s of liveSurvivors(f)) {
      total.all++; total[p]++;
      if (s.weapon === id) { held.all++; held[p]++; }
    }
  }
  if (total.all === 0) return null;
  const out: MetricOut = { all: { num: held.all, den: total.all } };
  for (const p of SUB_PHASES) if (total[p] > 0) out[p] = { num: held[p], den: total[p] };
  return out;
}

function damageShare(c: RoundCtx, gun: string, suffix: 'sidmg' | 'tankdmg'): MetricOut | null {
  if (!c.hasStats) return null;
  const all = GUNS.reduce((s, g) => s + sideStat(c, 'survivor', `w_${g}_${suffix}`), 0)
    + sideStat(c, 'survivor', `w_other_${suffix}`)
    + sideStat(c, 'survivor', `w_molotov_${suffix}`) + sideStat(c, 'survivor', `w_pipe_bomb_${suffix}`);
  if (all === 0) return null;
  return { all: { num: sideStat(c, 'survivor', `w_${gun}_${suffix}`), den: all } };
}

export const defs: MetricDef[] = GUNS.flatMap((g, i) => [
  { id: `weapons.hold.${g}`, group: 'weapons' as const, version: 1,
    description: `Share of standing survivor time spent holding ${LABEL[g]}.`,
    ...(PUBLIC_HOLD[g] ? { public: { label: PUBLIC_HOLD[g]! } } : {}),
    compute: (c: RoundCtx) => holdShare(c, i + 1) },
  { id: `weapons.si_damage.${g}`, group: 'weapons' as const, version: 1,
    description: `Share of survivor damage to special infected dealt with ${LABEL[g]}.`,
    compute: (c: RoundCtx) => damageShare(c, g, 'sidmg') },
  { id: `weapons.tank_damage.${g}`, group: 'weapons' as const, version: 1,
    description: `Share of survivor damage to the tank dealt with ${LABEL[g]}.`,
    compute: (c: RoundCtx) => damageShare(c, g, 'tankdmg') },
]);
