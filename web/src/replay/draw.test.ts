import { describe, it, expect } from 'vitest';
import { avatarRadius, medianHeight, isSurvivor, entityStyle } from './draw';
import { STATE, ENTITY_KIND, PLAYER_SLOTS, type PlayerSample } from '../../../src/replayFormat';

function player(over: Partial<PlayerSample> = {}): PlayerSample {
  return {
    slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    state: STATE.PRESENT | STATE.ALIVE,
    health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    ...over,
  };
}

describe('isSurvivor', () => {
  // A survivor is the slot half, not a recorded flag. Slots 0-3 are team A's
  // survivors for the half and 4-7 are the infected, which is how the roster
  // is laid out in the header.
  it('reads the slot', () => {
    expect(isSurvivor(player({ slot: 0 }))).toBe(true);
    expect(isSurvivor(player({ slot: 3 }))).toBe(true);
    expect(isSurvivor(player({ slot: 4 }))).toBe(false);
  });
});

describe('medianHeight', () => {
  it('ignores players who are not alive', () => {
    const ps = [
      player({ slot: 0, z: 100 }),
      player({ slot: 1, z: 200 }),
      player({ slot: 2, z: 9000, state: STATE.PRESENT }),
      player({ slot: 3, z: 300 }),
    ];
    expect(medianHeight(ps)).toBe(200);
  });

  it('returns 0 when nobody is alive', () => {
    expect(medianHeight([player({ state: 0 })])).toBe(0);
  });
});

describe('avatarRadius', () => {
  it('is the base size at the team median', () => {
    expect(avatarRadius(500, 500, 10)).toBe(10);
  });

  // Higher reads as closer to an overhead camera, which is what separates a
  // rooftop from the alley under it without a layer system.
  it('grows above the median and shrinks below', () => {
    expect(avatarRadius(900, 500, 10)).toBeGreaterThan(10);
    expect(avatarRadius(100, 500, 10)).toBeLessThan(10);
  });

  it('clamps to plus or minus 20 percent however extreme the height', () => {
    expect(avatarRadius(99_999, 0, 10)).toBeCloseTo(12, 5);
    expect(avatarRadius(-99_999, 0, 10)).toBeCloseTo(8, 5);
  });
});

describe('entityStyle', () => {
  it('styles every kind the recorder writes', () => {
    for (const kind of Object.values(ENTITY_KIND)) {
      expect(entityStyle(kind)).not.toBeNull();
    }
  });

  it('returns null for a kind it does not know', () => {
    expect(entityStyle(99)).toBeNull();
  });
});
