import { describe, expect, it } from 'vitest';
import { defs, GUNS } from '../../src/metrics/defs/weapons.js';
import { buildTimeline } from '../../src/metrics/timeline.js';
import type { RoundInput } from '../../src/metrics/types.js';
import { frames, input, replayOf, stats } from './fixtures.js';

const run = (id: string, i: RoundInput) => defs.find((m) => m.id === id)!.compute({ ...i, timeline: i.replay ? buildTimeline(i.replay, i.marks) : null });

describe('weapon metrics', () => {
  it('defines three families for six guns', () => {
    expect(GUNS).toEqual(['pistol', 'smg', 'pumpshotgun', 'autoshotgun', 'rifle', 'hunting_rifle']);
    expect(defs).toHaveLength(18);
  });

  it('hold share over standing survivor time', () => {
    const replay = replayOf(frames(0, 1000, () => ({ surv: [{ x: 0, y: 0, weapon: 3 }, { x: 1, y: 0, weapon: 2 }, { x: 2, y: 0, weapon: 3 }, { x: 3, y: 0, weapon: 3 }] })));
    const out = run('weapons.hold.pumpshotgun', input({ replay }))!;
    expect(out.all!.num / out.all!.den).toBeCloseTo(0.75, 5);
    expect(run('weapons.hold.smg', input({ replay }))!.all!.num / run('weapons.hold.smg', input({ replay }))!.all!.den).toBeCloseTo(0.25, 5);
  });

  it('damage share from per-round weapon stats', () => {
    const i = input({ hasStats: true, stats: stats([['s1', 'w_pumpshotgun_sidmg', 300], ['s2', 'w_smg_sidmg', 100], ['i1', 'w_smg_sidmg', 999]]) });
    expect(run('weapons.si_damage.pumpshotgun', i)!.all).toEqual({ num: 300, den: 400 });
    expect(run('weapons.si_damage.rifle', i)!.all).toEqual({ num: 0, den: 400 });
    expect(run('weapons.tank_damage.rifle', i)).toBeNull();
    expect(run('weapons.si_damage.smg', input())).toBeNull();
  });
});
