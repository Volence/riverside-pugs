import { describe, it, expect } from 'vitest';
import { PLAYER_SLOTS, STATE, canSee, type Frame, type PlayerSample, type ReplayHeader } from '../src/replayFormat.js';
import { NO_LOS, classOf, isSpawnedTarget, losView } from '../src/integrity/los.js';

/** Survivors in slots 0 and 3, infected in 1 and 2, the layout of the first
 *  real file checked (survivor ranks 0,-1,-1,1 and infected -1,0,1,-1). */
function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: 3, token: '0'.repeat(32), ordinal: 1, half: 1, playerHz: 10, entityHz: 10,
    map: 'l4d_vs_hospital01_apartment', startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['1', '2', '3', '4', '', '', '', ''], infectedMask: 0b0110, sidesKnown: true, losKnown: true,
    ...over,
  };
}
const frame = (los: number): Frame => ({ tMs: 0, offset: 0, players: [], entities: [], los });
const sample = (over: Partial<PlayerSample>): PlayerSample => ({
  slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0, ...over,
});

describe('losView', () => {
  it('agrees with canSee for every survivor and infected pair', () => {
    const h = header();
    const v = losView(h);
    for (const los of [0, 0b1, 0b10, 1 << 4, 1 << 5, 0xffff]) {
      const f = frame(los);
      for (let s = 0; s < PLAYER_SLOTS; s++) {
        for (let i = 0; i < PLAYER_SLOTS; i++) expect(v.sees(f, s, i)).toBe(canSee(h, f, s, i));
      }
    }
  });

  it('is unknown, never false, when the file does not record line of sight', () => {
    const v = losView(header({ losKnown: false }));
    expect(v.known).toBe(false);
    expect(v.sees(frame(0), 0, 1)).toBeNull();
    expect(v.othersSee(frame(0), 1, 0)).toBeNull();
    expect(NO_LOS.sees(frame(0xffff), 0, 1)).toBeNull();
  });

  it('asks the other survivors, never the one being measured', () => {
    const v = losView(header());
    // Survivor slot 3 is rank 1 and infected slot 2 is rank 1: bit 1*4+1.
    expect(v.othersSee(frame(1 << 5), 2, 0)).toBe(true);
    // Only survivor slot 0 (rank 0) sees infected slot 2 (rank 1): bit 0*4+1.
    expect(v.othersSee(frame(1 << 1), 2, 0)).toBe(false);
    expect(v.othersSee(frame(1 << 1), 2, 3)).toBe(true);
  });

  it('has no answer for a slot with no rank on the side asked about', () => {
    const v = losView(header());
    expect(v.sees(frame(0xffff), 1, 2)).toBeNull();
    expect(v.othersSee(frame(0xffff), 0, 3)).toBeNull();
  });
});

describe('classOf and isSpawnedTarget', () => {
  it('scores smokers, boomers and hunters only', () => {
    expect([0, 1, 2, 3, 4, 5].map(classOf)).toEqual([null, 'smoker', 'boomer', 'hunter', null, null]);
  });

  it('is a living, spawned, scored infected', () => {
    const live = STATE.PRESENT | STATE.ALIVE;
    expect(isSpawnedTarget(sample({ state: live, cls: 3 }))).toBe(true);
    expect(isSpawnedTarget(sample({ state: live | STATE.GHOST, cls: 3 }))).toBe(false);
    expect(isSpawnedTarget(sample({ state: STATE.PRESENT, cls: 3 }))).toBe(false);
    expect(isSpawnedTarget(sample({ state: live, cls: 5 }))).toBe(false);
    expect(isSpawnedTarget(sample({ state: 0, cls: 3 }))).toBe(false);
  });

  it('never takes a survivor for an infected, whatever character number cls holds', () => {
    // A survivor's cls is its character (0 Bill, 1 Zoey, 2 Louis, 3 Francis),
    // so 1 to 3 collide with smoker, boomer and hunter.
    const live = STATE.PRESENT | STATE.ALIVE;
    for (const cls of [1, 2, 3]) {
      expect(isSpawnedTarget(sample({ state: live, cls, infected: false }))).toBe(false);
      expect(isSpawnedTarget(sample({ state: live, cls, infected: true }))).toBe(true);
    }
  });
});
