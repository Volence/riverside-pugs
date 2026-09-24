import { describe, expect, it } from 'vitest';
import { fmtChange, fmtMoreMatches, fmtValue, isShareMetric, readCompareQuery, writeCompareQuery } from './format';

describe('balance formatting', () => {
  it('knows share metrics', () => {
    expect(isShareMetric('round.saferoom')).toBe(true);
    expect(isShareMetric('tank.killed_rate')).toBe(true);
    expect(isShareMetric('weapons.hold.smg')).toBe(true);
    expect(isShareMetric('tank.lifetime_s')).toBe(false);
    expect(isShareMetric('hunter.skeet_rate')).toBe(false);
    expect(isShareMetric('smoker.pull_rate')).toBe(false);
    expect(isShareMetric('smoker.kill_clear_share')).toBe(true);
  });
  it('formats values by unit', () => {
    expect(fmtValue('round.saferoom', 0.234)).toBe('23%');
    expect(fmtValue('tank.lifetime_s', 104.25)).toBe('104 s');
    expect(fmtValue('round.length_min', 4.439)).toBe('4.4 min');
    expect(fmtValue('hunter.skeet_rate', null)).toBe('n/a');
    expect(fmtValue('tank.spawns', 0.9612)).toBe('0.96');
  });
  it('formats changes as points for shares and percent otherwise', () => {
    expect(fmtChange('round.saferoom', { diff: 0.06, rel: 0.26, lo: -0.03, hi: 0.15 })).toEqual({ main: '+6 pts', range: '[-3, +15]' });
    expect(fmtChange('tank.lifetime_s', { diff: 12, rel: 0.12, lo: 2, hi: 23 })).toEqual({ main: '+12%', range: '[+2 s, +23 s]' });
    expect(fmtChange('tank.spawns', { diff: null, rel: null, lo: null, hi: null })).toEqual({ main: 'n/a', range: '' });
  });
  it('handles near-zero values without sign', () => {
    expect(fmtChange('tank.lifetime_s', { diff: -0.2, rel: -0.001, lo: null, hi: null }).main).toBe('0%');
    expect(fmtChange('tank.spawns', { diff: -0.001, rel: null, lo: null, hi: null }).main).toBe('0');
    expect(fmtChange('tank.lifetime_s', { diff: 12, rel: 0.12, lo: -0.001, hi: 23 }).range).toBe('[0 s, +23 s]');
  });
  it('says match or matches as the number needs', () => {
    expect(fmtMoreMatches(1)).toBe('1 more match');
    expect(fmtMoreMatches(60)).toBe('60 more matches');
    expect(fmtMoreMatches(500)).toBe('500+ more matches');
  });
  it('reads and writes the comparison in the URL', () => {
    expect(readCompareQuery('', [1, 2, 3])).toEqual({ a: [2], b: [3], origin: 'all', maps: [], phases: 'all', view: 'ranked' });
    const q = readCompareQuery('?a=1,2&b=3&origin=queue&view=topic&phases=split', [1, 2, 3]);
    expect(q).toEqual({ a: [1, 2], b: [3], origin: 'queue', maps: [], phases: 'split', view: 'topic' });
    expect(readCompareQuery('?a=99&b=3', [1, 2, 3]).a).toEqual([2]);
    // Defaults skip patches with no counted rounds; URL-chosen ids stay.
    expect(readCompareQuery('', [1, 2, 3, 4], [1, 2])).toMatchObject({ a: [1], b: [2] });
    expect(readCompareQuery('?a=3&b=4', [1, 2, 3, 4], [1, 2])).toMatchObject({ a: [3], b: [4] });
    expect(readCompareQuery('', [1, 2, 3], [2])).toMatchObject({ a: [2], b: [3] });
    expect(writeCompareQuery({ a: [1, 2], b: [3], origin: 'all', maps: [], phases: 'all', view: 'ranked' })).toBe('?a=1%2C2&b=3');
  });
});
