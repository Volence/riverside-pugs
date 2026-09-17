import { describe, it, expect } from 'vitest';
import { percentile, aggregate, scorePlayers } from '../src/integrity/score.js';
import type { RoundMetrics } from '../src/integrity/round.js';

const m = (over: Partial<RoundMetrics> = {}): RoundMetrics => ({
  fidMax: 0.2, fidP95: 0.1, occZ: 0, teamRank: 2, teamGap: 0, eligiblePairs: 100,
  gates: { considered: 400, notLive: 20, notGhost: 100, inGrace: 50, tooClose: 30, occluded: 100, passed: 100 },
  ...over,
});

describe('percentile', () => {
  it('is 0 for the lowest value and 1 for the highest', () => {
    expect(percentile([1, 2, 3], 1)).toBe(0);
    expect(percentile([1, 2, 3], 3)).toBe(1);
  });

  it('is the fraction of the population at or below the value', () => {
    expect(percentile([1, 2, 3, 4], 3)).toBeCloseTo(2 / 3);
  });

  it('is 0 for an empty or single-member population rather than NaN', () => {
    expect(percentile([], 5)).toBe(0);
    expect(percentile([5], 5)).toBe(0);
  });
});

describe('aggregate', () => {
  it('takes a player worst round for fidMax and their mean for the rest', () => {
    const got = aggregate([
      { steamid: 'a', metrics: m({ fidMax: 0.4, occZ: 1 }) },
      { steamid: 'a', metrics: m({ fidMax: 0.9, occZ: 3 }) },
    ]);
    expect(got[0].rounds).toBe(2);
    expect(got[0].fidMax).toBeCloseTo(0.9);
    expect(got[0].occZ).toBeCloseTo(2);
  });

  it('leaves occZ null for a player whose rounds were all on unscored maps', () => {
    expect(aggregate([{ steamid: 'a', metrics: m({ occZ: null, teamGap: null }) }])[0].occZ).toBeNull();
  });
});

describe('scorePlayers', () => {
  it('composites only the metrics a player actually has', () => {
    const [a] = scorePlayers([
      { steamid: 'a', rounds: 3, fidMax: 0.9, fidP95: 0.5, occZ: null, teamGap: null },
      { steamid: 'b', rounds: 3, fidMax: 0.1, fidP95: 0.05, occZ: null, teamGap: null },
    ]);
    expect(a.pOcc).toBeNull();
    expect(a.composite).toBeCloseTo(1);
  });

  it('ranks the tracking player above the rest', () => {
    const got = scorePlayers([
      { steamid: 'clean1', rounds: 5, fidMax: 0.2, fidP95: 0.1, occZ: 0.1, teamGap: 0 },
      { steamid: 'clean2', rounds: 5, fidMax: 0.3, fidP95: 0.12, occZ: -0.2, teamGap: -0.1 },
      { steamid: 'sus', rounds: 5, fidMax: 0.95, fidP95: 0.8, occZ: 4.2, teamGap: 3.9 },
    ]);
    expect(got[0].steamid).toBe('sus');
    expect(got[0].composite).toBeGreaterThan(got[1].composite);
  });
});
