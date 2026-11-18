import { describe, expect, it } from 'vitest';
import type { AltReportHalf } from '../../../api';
import { curveSegments, tankText } from './AltCurveChart';

const h = (over: Partial<AltReportHalf>): AltReportHalf => ({
  ordinal: 0, half: 1, map: 'm', survTeam: 'a', real: null, walk: 0, tank: 0, door: 0, total: 0,
  tankPct: null, tankBy: null, survivorsIn: 0, mismatch: false, ...over,
});

describe('curveSegments', () => {
  it('turns the 21 points into runs of [covered, health], split at every -1', () => {
    const curve = [100, 90, -1, 80, 70, ...Array(16).fill(-1)];
    expect(curveSegments(curve)).toEqual([[[0, 100], [5, 90]], [[15, 80], [20, 70]]]);
  });

  it('a full curve is one run ending at 100%, an empty one none', () => {
    expect(curveSegments(Array(21).fill(50))).toEqual([Array.from({ length: 21 }, (_, i) => [i * 5, 50])]);
    expect(curveSegments(Array(21).fill(-1))).toEqual([]);
  });
});

describe('tankText', () => {
  it('names the fight, a tank still up at the end, or nothing', () => {
    expect(tankText(h({ tankOpen: 37, tankClose: 54 }))).toBe('Team A (half 1): tank fight from 37% to 54% of the map');
    expect(tankText(h({ survTeam: 'b', half: 2, tankOpen: 27, tankClose: -1 }))).toBe('Team B (half 2): tank came at 27% of the map and was still up when the half ended');
    expect(tankText(h({ tankOpen: -1, tankClose: -1 }))).toBeNull();
    expect(tankText(h({ tankOpen: null, tankClose: null }))).toBeNull();
    expect(tankText(h({}))).toBeNull();
  });
});
