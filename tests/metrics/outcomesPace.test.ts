import { describe, expect, it } from 'vitest';
import { defs as outcomes } from '../../src/metrics/defs/outcomes.js';
import { defs as pace } from '../../src/metrics/defs/pace.js';
import { buildTimeline } from '../../src/metrics/timeline.js';
import type { RoundInput } from '../../src/metrics/types.js';
import { ev, frames, input, replayOf, standing4, stats } from './fixtures.js';

const byId = (id: string) => [...outcomes, ...pace].find((m) => m.id === id)!;
const run = (id: string, i: RoundInput) => byId(id).compute({ ...i, timeline: i.replay ? buildTimeline(i.replay, i.marks) : null });

describe('outcome metrics', () => {
  it('saferoom and survivors alive need a reliable, ended round', () => {
    expect(run('round.saferoom', input({ survivorsAlive: 3 }))).toEqual({ all: { num: 1, den: 1 } });
    expect(run('round.saferoom', input({ survivorsAlive: 0 }))).toEqual({ all: { num: 0, den: 1 } });
    expect(run('round.saferoom', input({ survivorsAlive: null }))).toBeNull();
    expect(run('round.saferoom', input({ reliable: false }))).toBeNull();
    expect(run('round.survivors_alive', input({ survivorsAlive: 2 }))).toEqual({ all: { num: 2, den: 1 } });
  });

  it('score on wipe only counts wipes', () => {
    expect(run('round.score_on_wipe', input({ survivorsAlive: 0, score: 250 }))).toEqual({ all: { num: 250, den: 1 } });
    expect(run('round.score_on_wipe', input({ survivorsAlive: 1 }))).toBeNull();
  });

  it('length and phase share come from the replay', () => {
    const replay = replayOf(frames(0, 60_000, (t) => ({ surv: standing4, inf: t >= 45_000 ? [{ cls: 5 }] : [] })));
    expect(run('round.length_min', input({ replay }))!.all!.num).toBeCloseTo(1, 3);
    const share = run('round.phase_share', input({ replay }))!;
    expect(share.tank!.num / share.tank!.den).toBeCloseTo(0.25, 2);
    expect(share.all).toBeUndefined();
    expect(run('round.length_min', input())).toBeNull();
  });
});

describe('pace metrics', () => {
  const replay = replayOf(frames(0, 120_000, () => ({ surv: standing4 })));

  it('SI damage per minute from per-round stats', () => {
    const out = run('pace.si_damage_per_min', input({ replay, hasStats: true, stats: stats([['i1', 'damage_as_si', 200], ['i2', 'damage_as_si', 100]]) }))!;
    expect(out.all!.num).toBe(300);
    expect(out.all!.den).toBeCloseTo(2, 2);
    expect(run('pace.si_damage_per_min', input({ replay }))).toBeNull();
  });

  it('friendly fire per minute is weighted by damage', () => {
    const out = run('pace.ff_per_min', input({ replay, events: [ev('ff', 's1', 1000, 's2', 40)] }))!;
    expect(out.all!.num).toBe(40);
  });

  it('pin gap is the mean seconds between pins', () => {
    const out = run('pace.pin_gap_s', input({ events: [ev('pinned', 'i1', 10_000, 's1'), ev('pinned', 'i2', 30_000, 's2'), ev('pinned', 'i1', 40_000, 's3')] }))!;
    expect(out.all).toEqual({ num: 30, den: 2 });
  });

  it('survivor spread averages pairwise distance of standing survivors', () => {
    const out = run('pace.survivor_spread', input({ replay: replayOf(frames(0, 1000, () => ({ surv: [{ x: 0, y: 0 }, { x: 300, y: 0 }] }))) }))!;
    expect(out.all!.num / out.all!.den).toBeCloseTo(300, 3);
  });
});
