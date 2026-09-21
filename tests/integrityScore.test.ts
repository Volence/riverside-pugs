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

  it('is the fraction STRICTLY below the value, over n-1 rather than n', () => {
    // Two of the four are below 3, and the denominator is 3, so 2/3. Over n it
    // would be 1/2. The description used to say "at or below", which would be
    // 3/4 and is not what any of these assertions show.
    expect(percentile([1, 2, 3, 4], 3)).toBeCloseTo(2 / 3);
  });

  it('returns exactly 1 for the top of the population, by construction', () => {
    // Why the admin board renders a rank and not this number: the leader always
    // reads 100%, whatever they actually measured.
    expect(percentile([0.1, 0.2, 0.62], 0.62)).toBe(1);
  });

  it('is 0 for an empty or single-member population rather than NaN', () => {
    expect(percentile([], 5)).toBe(0);
    expect(percentile([5], 5)).toBe(0);
  });
});

describe('aggregate', () => {
  it('takes a player HIGHEST round for fidMax and their mean for the rest', () => {
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
  // CHANGED 2026-09-21. This previously asserted a composite of 1.0: only the
  // metrics a player actually had were averaged. That is a defensible reading
  // (an unmeasured metric is not evidence either way) but on the live board it
  // put a 3-round player with two n/a at rank 1 of 82, ranked on one number,
  // above players with a hundred rounds measured on all three. Since the
  // composite exists to order WHO IS WORTH WATCHING, ranking someone top for
  // having almost no data wastes exactly the reviewer time it is meant to save.
  // A missing metric now counts as the middle of the population.
  it('reports a missing metric as null but counts it as neutral in the composite', () => {
    const [a] = scorePlayers([
      { steamid: 'a', rounds: 3, fidMax: 0.9, fidP95: 0.5, occZ: null, teamGap: null },
      { steamid: 'b', rounds: 3, fidMax: 0.1, fidP95: 0.05, occZ: null, teamGap: null },
    ]);
    expect(a.pOcc).toBeNull();
    expect(a.composite).toBeCloseTo((1 + 0.5 + 0.5) / 3, 5);
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

describe('missing metrics do not inflate the composite', () => {
  // Found on the live board 2026-09-21: "Ragebot", with 3 rounds and n/a for
  // both occupancy and team gap, ranked 1 of 82. Its composite was a single
  // metric at the 95th percentile with nothing to average it down, while a
  // player measured on all three had to be high on all three to match. Having
  // LESS evidence made it EASIER to reach the top of the board.
  const agg = (steamid: string, rounds: number, fidMax: number, occZ: number | null, teamGap: number | null) =>
    ({ steamid, rounds, fidMax, fidP95: 0, occZ, teamGap });

  it('ranks a player measured on one metric below one high on all three', () => {
    const scored = scorePlayers([
      agg('sparse', 3, 10, null, null),      // top of the fid distribution, nothing else
      agg('full', 50, 9, 9, 9),              // high on all three
      agg('a', 20, 1, 1, 1),
      agg('b', 20, 2, 2, 2),
      agg('c', 20, 3, 3, 3),
    ]);
    expect(scored[0].steamid).toBe('full');
    expect(scored.findIndex((s) => s.steamid === 'sparse')).toBeGreaterThan(0);
  });

  it('treats a missing metric as the middle of the population, not as absent', () => {
    const [sparse] = scorePlayers([
      agg('sparse', 3, 10, null, null),
      agg('a', 20, 1, 1, 1),
      agg('b', 20, 2, 2, 2),
    ]).filter((s) => s.steamid === 'sparse');
    // pFid is 1.0 here; the two missing parts count as 0.5 each rather than
    // being dropped, so the composite is 2/3 rather than 1.0.
    expect(sparse.composite).toBeCloseTo((1 + 0.5 + 0.5) / 3, 5);
  });

  it('still ranks a fully measured player on their real numbers', () => {
    const scored = scorePlayers([
      agg('x', 20, 3, 3, 3),
      agg('y', 20, 1, 1, 1),
    ]);
    expect(scored[0].steamid).toBe('x');
  });
});
