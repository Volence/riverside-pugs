import { describe, it, expect } from 'vitest';
import { STATE, type PlayerSample } from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';
import {
  wrapDeg, bearing, aimError, dist2d, isLiveSurvivor, isGhost, pairEligible, pitchError, onTarget,
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

/**
 * Source pitch is NEGATIVE UP. Checked against the 189 real replays rather than
 * trusted: over 13261 frames where a survivor fired with their yaw inside 3
 * degrees of a spawned special infected, pitch against elevation has slope
 * -0.87 and r = -0.84, and targets 15 degrees or more BELOW read a median pitch
 * of +23.
 */
describe('pitchError', () => {
  it('is near zero looking level at a ghost on the same floor', () => {
    expect(Math.abs(pitchError(p(), { x: 1200, y: 0, z: 0 }))).toBeLessThan(2);
  });

  it('is near zero looking UP, which is negative pitch, at a ghost above', () => {
    // 1000 out and 1000 up, less the eye and aim point heights: about 44 degrees.
    expect(Math.abs(pitchError(p({ pitch: -44 }), { x: 1000, y: 0, z: 1000 }))).toBeLessThan(2);
  });

  it('is large for the same ghost when looking level or down', () => {
    expect(pitchError(p({ pitch: 0 }), { x: 1000, y: 0, z: 1000 })).toBeGreaterThan(40);
    expect(pitchError(p({ pitch: 44 }), { x: 1000, y: 0, z: 1000 })).toBeGreaterThan(80);
  });
});

describe('onTarget', () => {
  it('needs the yaw inside the tolerance it is given', () => {
    expect(onTarget(p({ yaw: 4 }), { x: 1200, y: 0, z: 0 }, 5)).toBe(true);
    expect(onTarget(p({ yaw: 6 }), { x: 1200, y: 0, z: 0 }, 5)).toBe(false);
  });

  it('needs the pitch inside PITCH_TOL too, so a ghost two floors up is not being looked at', () => {
    const above = { x: 600, y: 0, z: 500 };
    expect(onTarget(p({ pitch: 0 }), above, 5)).toBe(false);
    expect(onTarget(p({ pitch: -36 }), above, 5)).toBe(true);
  });

  it('is loose: eye height, crouching and whole-degree pitch must not cost a real frame', () => {
    // A crouched survivor's eye is about 18 units lower than assumed and a
    // hunter's body is lower than the aim point, at D_MIN, with the pitch
    // rounded away from the truth. Still on target.
    expect(onTarget(p({ pitch: 10 }), { x: TUNING.D_MIN, y: 0, z: 0 }, 5)).toBe(true);
    expect(onTarget(p({ pitch: -10 }), { x: TUNING.D_MIN, y: 0, z: 0 }, 5)).toBe(true);
  });
});
