import { describe, expect, it } from 'vitest';
import { STATE, type Frame, type PlayerSample } from '../../src/replayFormat.js';
import { buildProgressMap, furthestProg, progressAt } from '../../src/winLive/progressMap.js';

function player(x: number, state: number, infected: boolean): PlayerSample {
  return { slot: 0, x, y: 0, z: 0, yaw: 0, pitch: 0, state, health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0, infected };
}
const ALIVE = STATE.PRESENT | STATE.ALIVE;

describe('progress map', () => {
  it('takes the median of samples in one cell', () => {
    const pm = buildProgressMap('m', [{ x: 10, y: 10, z: 10, prog: 10 }, { x: 100, y: 5, z: 0, prog: 30 }]);
    expect(pm.map).toBe('m');
    expect(progressAt(pm, 50, 50, 50)).toBe(20);
  });
  it('uses the nearest filled cell within 3 cells, else null', () => {
    const pm = buildProgressMap('m', [{ x: 0, y: 0, z: 0, prog: 40 }]);
    expect(progressAt(pm, 2 * 128, 0, 0)).toBe(40);
    expect(progressAt(pm, 3 * 128, 0, 0)).toBe(40);
    expect(progressAt(pm, 5 * 128, 0, 0)).toBeNull();
  });
  it('breaks ties by Euclidean distance between cells', () => {
    const pm = buildProgressMap('m', [{ x: 2 * 128, y: 2 * 128, z: 0, prog: 1 }, { x: 2 * 128, y: 0, z: 0, prog: 2 }]);
    expect(progressAt(pm, 0, 0, 0)).toBe(2);
  });
  it('floors negative coordinates into their cell', () => {
    const pm = buildProgressMap('m', [{ x: -1, y: -1, z: -1, prog: 7 }]);
    expect(Object.keys(pm.cells)).toEqual(['-1,-1,-1']);
  });
  it('furthestProg is the max over alive survivors only', () => {
    const pm = buildProgressMap('m', [{ x: 0, y: 0, z: 0, prog: 10 }, { x: 1280, y: 0, z: 0, prog: 60 }, { x: 2560, y: 0, z: 0, prog: 90 }]);
    const f: Frame = { tMs: 0, offset: 0, entities: [], players: [
      player(0, ALIVE, false), player(1280, ALIVE, false), player(2560, STATE.PRESENT, false), player(2560, ALIVE, true),
    ] };
    expect(furthestProg(pm, f)).toBe(60);
    expect(furthestProg(pm, { ...f, players: [player(99999, ALIVE, false)] })).toBeNull();
  });
});
