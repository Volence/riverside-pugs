import { describe, it, expect } from 'vitest';
import { PLAYER_SLOTS, type Frame } from '../src/replayFormat.js';
import { DEFAULT_DELAY_MS, releasableFrames } from '../src/replayTail.js';

function f(tMs: number): Frame {
  return {
    tMs, offset: 0, entities: [],
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
  };
}

const START = 1_000_000_000_000;

describe('releasableFrames', () => {
  it('is ten seconds by default', () => {
    expect(DEFAULT_DELAY_MS).toBe(10_000);
  });

  it('releases only frames older than the delay', () => {
    const frames = [f(0), f(5_000), f(10_000), f(15_000)];
    // 20s into the round, so anything at or before t=10s is releasable.
    const got = releasableFrames(frames, START, START + 20_000);
    expect(got.map((x) => x.tMs)).toEqual([0, 5_000, 10_000]);
  });

  it('releases nothing at the very start of a round', () => {
    expect(releasableFrames([f(0), f(100)], START, START + 500)).toEqual([]);
  });

  it('releases everything long after the round ended', () => {
    const frames = [f(0), f(5_000)];
    expect(releasableFrames(frames, START, START + 600_000)).toHaveLength(2);
  });

  it('honours a custom delay', () => {
    const frames = [f(0), f(5_000)];
    expect(releasableFrames(frames, START, START + 6_000, 2_000).map((x) => x.tMs)).toEqual([0]);
  });

  it('refuses to release anything when the delay is zero or negative', () => {
    // Guards against a config value of 0 quietly turning the anti-ghosting
    // control off. Turning it off must be an explicit code change, not a
    // number someone typed into a settings row.
    const frames = [f(0), f(5_000)];
    expect(releasableFrames(frames, START, START + 600_000, 0)).toEqual([]);
    expect(releasableFrames(frames, START, START + 600_000, -1)).toEqual([]);
  });

  it('releases nothing when the round start is unknown', () => {
    // Without an origin there is no way to tell how old a frame is, and
    // guessing means guessing in the direction that leaks positions.
    expect(releasableFrames([f(0)], 0, START + 600_000)).toEqual([]);
  });
});
