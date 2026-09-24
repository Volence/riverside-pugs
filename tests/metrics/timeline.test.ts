// tests/metrics/timeline.test.ts
import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../../src/metrics/timeline.js';
import { frames, replayOf, standing4 } from './fixtures.js';

describe('buildTimeline', () => {
  it('finds the tank window from a player tank', () => {
    const r = replayOf(frames(0, 10_000, (t) => ({
      surv: standing4, inf: t >= 3000 && t < 6000 ? [{ cls: 5 }] : [],
    })));
    const tl = buildTimeline(r, []);
    expect(tl.tank).toEqual([{ from: 3000, to: 6000 }]);
    expect(tl.phaseAt(4000)).toBe('tank');
    expect(tl.phaseAt(7000)).toBe('normal');
    expect(tl.minutes('tank')).toBeCloseTo(3000 / 60000, 5);
    expect(tl.minutes('all')).toBeCloseTo(10_000 / 60000, 5);
  });

  it('treats a ghost tank as not alive and merges a short flicker', () => {
    const r = replayOf(frames(0, 8000, (t) => ({
      surv: standing4,
      inf: t >= 1000 && t < 7000 ? [{ cls: 5, state: (t >= 3000 && t < 3500) ? 1 | 2 | 128 : 1 | 2 }] : [],
    })));
    expect(buildTimeline(r, []).tank).toEqual([{ from: 1000, to: 7000 }]);
  });

  it('counts an AI tank', () => {
    const r = replayOf(frames(0, 3000, (t) => ({ surv: standing4, tankAi: t >= 1000 })));
    expect(buildTimeline(r, []).tank).toEqual([{ from: 1000, to: 3000 }]);
  });

  it('does not count a dead AI tank (present but not alive)', () => {
    const r = replayOf(frames(0, 3000, (t) => ({ surv: standing4, tankAi: t >= 1000 ? 'dead' : false })));
    expect(buildTimeline(r, []).tank).toEqual([]);
  });

  it('marks witch-near only within range of a standing survivor', () => {
    const r = replayOf(frames(0, 4000, (t) => ({
      surv: standing4, witch: [{ x: t < 2000 ? 5000 : 500, y: 0 }],
    })));
    const tl = buildTimeline(r, []);
    expect(tl.witch).toEqual([{ from: 2000, to: 4000 }]);
    expect(tl.phaseAt(1000)).toBe('normal');
    expect(tl.phaseAt(2500)).toBe('witch');
  });

  it('adds a panic window and lets tank win over it', () => {
    const r = replayOf(frames(0, 60_000, (t) => ({ surv: standing4, inf: t >= 10_000 && t < 20_000 ? [{ cls: 5 }] : [] })));
    const tl = buildTimeline(r, [{ kind: 'panic', tMs: 5000 }]);
    expect(tl.event).toEqual([{ from: 5000, to: 50_000 }]);
    expect(tl.phaseAt(6000)).toBe('event');
    expect(tl.phaseAt(15_000)).toBe('tank');
    expect(tl.phaseAt(55_000)).toBe('normal');
  });

  it('runs a finale window to the end of the round', () => {
    const r = replayOf(frames(0, 10_000, () => ({ surv: standing4 })));
    expect(buildTimeline(r, [{ kind: 'finale_start', tMs: 4000 }]).event).toEqual([{ from: 4000, to: 10_000 }]);
  });
});
