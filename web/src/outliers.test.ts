import { describe, it, expect } from 'vitest';
import { markColumn, directionOf } from './outliers';
import type { StatDef } from './api';

const defs = [
  { key: 'skeets', side: 'survivor', visibility: 'public', label: 'Skeets',
    needsSkillDetect: true, direction: 'high_good' },
] as unknown as StatDef[];

describe('directionOf', () => {
  it('reads direction from the served registry', () => {
    expect(directionOf('skeets', defs)).toBe('high_good');
  });

  it('knows the five core counters, which are not registry entries', () => {
    // ck/sidmg/sikill/ff/rev are columns on match_players, not STAT_DEFS
    // entries, so the registry cannot answer for them. Same problem and the
    // same solution as WIRE_SIDE in src/roundStats.ts.
    expect(directionOf('ff', defs)).toBe('high_bad');
    expect(directionOf('ck', defs)).toBe('high_good');
    expect(directionOf('rev', defs)).toBe('high_good');
  });

  it('is neutral for a key it does not know, rather than guessing', () => {
    expect(directionOf('not_a_stat', defs)).toBe('neutral');
  });
});

describe('markColumn', () => {
  it('marks both ends: most is good and fewest is bad when high is good', () => {
    // "fewest clears" is as much a finding as "most skeets", so both extremes
    // are marked, not just the top.
    expect(markColumn([1, 5, 20], 'high_good')).toEqual(['bad', null, 'good']);
  });

  it('inverts both ends for a stat where high is bad', () => {
    // Most friendly fire is the problem; least friendly fire is the good one.
    expect(markColumn([5, 60, 300], 'high_bad')).toEqual(['good', null, 'bad']);
  });

  it('marks nothing at all for a neutral stat', () => {
    expect(markColumn([1, 2, 50], 'neutral')).toEqual([null, null, null]);
  });

  it('marks nobody when the spread is trivial', () => {
    // Seven players on 2 clears and one on 3 is not an outlier. Guard one.
    expect(markColumn([2, 2, 2, 2, 2, 2, 2, 3], 'high_good'))
      .toEqual([null, null, null, null, null, null, null, null]);
  });

  it('marks nobody when every value is equal', () => {
    expect(markColumn([4, 4, 4], 'high_good')).toEqual([null, null, null]);
  });

  it('marks nobody when the column was never measured', () => {
    // Guard two: absent is not zero. A server without skill_detect records no
    // skeets, and naming someone worst at an unmeasured stat is a fabrication.
    expect(markColumn([undefined, undefined, undefined], 'high_good'))
      .toEqual([null, null, null]);
  });

  it('ignores absent entries rather than treating them as zero', () => {
    // The absent player is not the minimum. Only the two real values compete.
    expect(markColumn([undefined, 1, 20], 'high_good')).toEqual([null, 'bad', 'good']);
  });

  it('leaves a tied end unmarked while still marking the other', () => {
    // Two players tie for the top, so neither is the standout, but the single
    // player at the bottom still is.
    expect(markColumn([1, 20, 20], 'high_good')).toEqual(['bad', null, null]);
  });

  it('marks nobody when both ends are tied', () => {
    expect(markColumn([1, 1, 20, 20], 'high_good')).toEqual([null, null, null, null]);
  });
});
