import { describe, it, expect } from 'vitest';
import { STATE, type PlayerSample } from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';
import {
  wrapDeg, bearing, aimError, dist2d, isLiveSurvivor, isGhost, pairEligible,
} from '../src/integrity/geometry.js';

function p(over: Partial<PlayerSample> = {}): PlayerSample {
  return {
    slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    state: STATE.PRESENT | STATE.ALIVE,
    health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    ...over,
  };
}

describe('wrapDeg', () => {
  it('leaves an angle already in range alone', () => {
    expect(wrapDeg(0)).toBe(0);
    expect(wrapDeg(90)).toBe(90);
    expect(wrapDeg(-90)).toBe(-90);
  });

  it('wraps past a half turn to the short way round', () => {
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-190)).toBe(170);
    expect(wrapDeg(370)).toBe(10);
  });

  it('never returns a magnitude above 180', () => {
    for (const d of [359, -359, 720, -721, 180, -180]) {
      expect(Math.abs(wrapDeg(d))).toBeLessThanOrEqual(180);
    }
  });
});

describe('bearing and aimError', () => {
  it('measures east as zero and north as ninety', () => {
    expect(bearing({ x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(0);
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: 100 })).toBeCloseTo(90);
  });

  it('is zero error when the yaw points straight at the target', () => {
    expect(aimError(90, { x: 0, y: 0 }, { x: 0, y: 500 })).toBeCloseTo(0);
  });

  it('takes the short way round rather than reporting 350 degrees', () => {
    expect(aimError(-175, { x: 0, y: 0 }, { x: -100, y: 0 })).toBeCloseTo(-5, 0);
  });
});

describe('dist2d', () => {
  it('ignores height entirely', () => {
    expect(dist2d({ x: 0, y: 0 }, { x: 300, y: 400 })).toBeCloseTo(500);
  });
});

describe('player predicates', () => {
  it('accepts a present living survivor', () => {
    expect(isLiveSurvivor(p())).toBe(true);
  });

  it('rejects a survivor who is incapacitated, ledged or pinned', () => {
    expect(isLiveSurvivor(p({ state: STATE.PRESENT | STATE.ALIVE | STATE.INCAP }))).toBe(false);
    expect(isLiveSurvivor(p({ state: STATE.PRESENT | STATE.ALIVE | STATE.LEDGED }))).toBe(false);
    expect(isLiveSurvivor(p({ state: STATE.PRESENT | STATE.ALIVE | STATE.PINNED }))).toBe(false);
  });

  it('rejects a dead or absent survivor', () => {
    expect(isLiveSurvivor(p({ state: STATE.PRESENT }))).toBe(false);
    expect(isLiveSurvivor(p({ state: 0 }))).toBe(false);
  });

  it('accepts only a present ghost', () => {
    expect(isGhost(p({ state: STATE.PRESENT | STATE.GHOST }))).toBe(true);
    expect(isGhost(p({ state: STATE.PRESENT | STATE.ALIVE }))).toBe(false);
    expect(isGhost(p({ state: STATE.GHOST }))).toBe(false);
  });
});

describe('pairEligible', () => {
  const base = {
    survivor: p(),
    ghost: p({ slot: 4, x: 1000, y: 0, state: STATE.PRESENT | STATE.GHOST }),
    others: [] as { x: number; y: number }[],
    tMs: 60000,
    roundStartMs: 0,
  };

  it('accepts a clean pair', () => {
    expect(pairEligible(base)).toBe(true);
  });

  it('rejects a ghost closer than D_MIN', () => {
    expect(pairEligible({ ...base, ghost: p({ slot: 4, x: TUNING.D_MIN - 1, y: 0, state: STATE.PRESENT | STATE.GHOST }) })).toBe(false);
  });

  it('rejects frames inside the spawn grace window', () => {
    expect(pairEligible({ ...base, tMs: TUNING.SPAWN_GRACE_MS - 1 })).toBe(false);
  });

  it('rejects when something visible sits in the same direction as the ghost', () => {
    expect(pairEligible({ ...base, others: [{ x: 700, y: 20 }] })).toBe(false);
  });

  it('accepts when the visible thing is well off the ghost bearing', () => {
    expect(pairEligible({ ...base, others: [{ x: 0, y: 700 }] })).toBe(true);
  });
});
