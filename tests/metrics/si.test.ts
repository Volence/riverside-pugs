import { describe, expect, it } from 'vitest';
import { defs } from '../../src/metrics/defs/si.js';
import { buildTimeline } from '../../src/metrics/timeline.js';
import type { RoundInput } from '../../src/metrics/types.js';
import { ev, frames, input, replayOf, standing4, stats } from './fixtures.js';

const run = (id: string, i: RoundInput) => defs.find((m) => m.id === id)!.compute({ ...i, timeline: i.replay ? buildTimeline(i.replay, i.marks) : null });

describe('special infected metrics', () => {
  const events = [
    ev('si_spawn', 'i1', 1000, null, 3), ev('pinned', 'i1', 2000, 's1'),
    ev('si_spawn', 'i2', 1000, null, 1), ev('pinned', 'i2', 3000, 's2'), ev('cleared', 's3', 7000, 's2'),
    ev('si_spawn', 'i3', 1000, null, 3), ev('skeet', 's1', 4000, 'i3'),
    ev('si_spawn', 'i4', 1000, null, 3), ev('dp', 'i4', 5000, 's3', 20),
    ev('si_spawn', 'i1', 8000, null, 2), ev('boom', 'i1', 9000, 's1'), ev('boom', 'i1', 9000, 's2'),
  ];

  it('hunter rates per hunter spawn', () => {
    expect(run('hunter.spawns', input({ events }))!.all).toEqual({ num: 3, den: 1 });
    expect(run('hunter.skeet_rate', input({ events }))!.all).toEqual({ num: 1, den: 3 });
    expect(run('hunter.dp_rate', input({ events }))!.all).toEqual({ num: 1, den: 3 });
    expect(run('hunter.dp_avg_damage', input({ events }))!.all).toEqual({ num: 20, den: 1 });
    expect(run('hunter.pounce_rate', input({ events }))!.all).toEqual({ num: 1, den: 3 });
  });

  it('smoker pulls and clear time', () => {
    expect(run('smoker.pull_rate', input({ events }))!.all).toEqual({ num: 1, den: 1 });
    expect(run('smoker.clear_time_s', input({ events }))!.all).toEqual({ num: 4, den: 1 });
  });

  it('boomer booms per spawn and pops need skill_detect', () => {
    expect(run('boomer.boomed_per_spawn', input({ events }))!.all).toEqual({ num: 2, den: 1 });
    expect(run('boomer.pop_rate', input({ events }))).toBeNull();
    expect(run('boomer.pop_rate', input({ events, hasStats: true, skillDetect: true, stats: stats([['s1', 'boomer_pops', 1]]) }))!.all)
      .toEqual({ num: 1, den: 1 });
  });

  it('hunter lifetime from the replay', () => {
    const replay = replayOf(frames(0, 20_000, (t) => ({ surv: standing4, inf: [{ cls: 3, state: t >= 5000 && t < 9000 ? 3 : 1 | 128 }] })));
    expect(run('hunter.lifetime_s', input({ replay }))!.all).toEqual({ num: 4, den: 1 });
  });

  it('quad caps need per-round stats', () => {
    expect(run('si.quad_caps', input())).toBeNull();
    expect(run('si.quad_caps', input({ hasStats: true, stats: stats([['i1', 'quad_caps', 1]]) }))!.all).toEqual({ num: 1, den: 1 });
  });
});
