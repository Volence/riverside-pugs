import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../../src/metrics/timeline.js';
import { classAt, countByPhase, perMinute, ratioByPhase, sideStat, single } from '../../src/metrics/kit.js';
import { ev, frames, input, replayOf, standing4, stats } from './fixtures.js';

const withTank = () => {
  const replay = replayOf(frames(0, 60_000, (t) => ({ surv: standing4, inf: t >= 30_000 ? [{ cls: 5 }] : [] })));
  return { ...input({ replay }), timeline: buildTimeline(replay, []) };
};

describe('metric kit', () => {
  it('sums a stat over one side', () => {
    const c = { ...input({ stats: stats([['s1', 'crowns', 1], ['s2', 'crowns', 2], ['i1', 'crowns', 9]]) }), timeline: null };
    expect(sideStat(c, 'survivor', 'crowns')).toBe(3);
    expect(sideStat(c, 'infected', 'crowns')).toBe(9);
    expect(sideStat(c, 'survivor', 'nope')).toBe(0);
  });

  it('knows an infected player class at a time', () => {
    const c = { ...input({ events: [ev('si_spawn', 'i1', 1000, null, 3), ev('tank_spawn', 'i1', 5000), ev('si_spawn', 'i1', 9000, null, 1)] }), timeline: null };
    expect(classAt(c, 'i1', 500)).toBeNull();
    expect(classAt(c, 'i1', 2000)).toBe(3);
    expect(classAt(c, 'i1', 6000)).toBe(5);
    expect(classAt(c, 'i1', 9000)).toBe(1);
  });

  it('counts events per phase with one round as the denominator', () => {
    const c = withTank();
    const out = countByPhase(c, [ev('boom', 'i1', 10_000), ev('boom', 'i1', 40_000), ev('boom', 'i2', 45_000)]);
    expect(out.all).toEqual({ num: 3, den: 1 });
    expect(out.normal).toEqual({ num: 1, den: 1 });
    expect(out.tank).toEqual({ num: 2, den: 1 });
  });

  it('skips a sub-phase row for a phase the round never had', () => {
    const c = withTank();
    const out = countByPhase(c, [ev('boom', 'i1', 10_000)]);
    expect(out.witch).toBeUndefined();
  });

  it('gives only all without a timeline, and skips unknown times in phases', () => {
    const c = { ...input(), timeline: null };
    expect(countByPhase(c, [ev('boom', 'i1', -1)])).toEqual({ all: { num: 1, den: 1 } });
  });

  it('rates per minute of each phase', () => {
    const c = withTank();
    const out = perMinute(c, [ev('ff', 's1', 40_000, 's2', 30)], (e) => e.value)!;
    expect(out.all!.num).toBe(30);
    expect(out.all!.den).toBeCloseTo(1, 3);
    expect(out.tank!.den).toBeCloseTo(0.5, 3);
    expect(perMinute({ ...input(), timeline: null }, [])).toBeNull();
  });

  it('builds a ratio per phase and drops empty denominators', () => {
    const c = withTank();
    const out = ratioByPhase(c, [ev('skeet', 's1', 40_000)], [ev('si_spawn', 'i1', 10_000, null, 3), ev('si_spawn', 'i1', 35_000, null, 3)])!;
    expect(out.all).toEqual({ num: 1, den: 2 });
    expect(out.tank).toEqual({ num: 1, den: 1 });
    expect(out.normal).toEqual({ num: 0, den: 1 });
    expect(out.witch).toBeUndefined();
    expect(ratioByPhase(c, [], [])).toBeNull();
  });

  it('single wraps one number', () => {
    expect(single(5)).toEqual({ all: { num: 5, den: 1 } });
  });
});
