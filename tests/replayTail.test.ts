import { describe, it, expect } from 'vitest';
import { HEADER_BYTES, PLAYER_SLOTS, frameBytes, type Frame } from '../src/replayFormat.js';
import { DEFAULT_DELAY_MS, releasableBytes, releasableFrames } from '../src/replayTail.js';

function f(tMs: number, offset = 0, entities = 0): Frame {
  return {
    tMs, offset,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: Array.from({ length: entities }, (_, i) => ({
      ref: i, kind: 1, state: 0, x: 0, y: 0, z: 0, health: 0,
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

describe('releasableBytes', () => {
  const started = 1_800_000_000_000;

  it('returns the offset one past the last releasable frame', () => {
    // Two frames with no entities, laid out as the writer would lay them out.
    const a = f(0, HEADER_BYTES);
    const b = f(1000, HEADER_BYTES + frameBytes(0));
    // 20 seconds after the round started, both frames are older than the
    // 10 second delay.
    const got = releasableBytes([a, b], started, started + 20_000);
    expect(got).toBe(HEADER_BYTES + frameBytes(0) * 2);
  });

  it('accounts for a frame carrying entities, which is longer', () => {
    const a = f(0, HEADER_BYTES, 5);
    const got = releasableBytes([a], started, started + 20_000);
    expect(got).toBe(HEADER_BYTES + frameBytes(5));
  });

  it('stops at the cutoff rather than at the end of the array', () => {
    const a = f(0, HEADER_BYTES);
    const b = f(19_000, HEADER_BYTES + frameBytes(0));
    // Now is 20s in, so the cutoff is t=10000. Frame b at t=19000 is inside
    // the delay window and must not be released.
    const got = releasableBytes([a, b], started, started + 20_000);
    expect(got).toBe(HEADER_BYTES + frameBytes(0));
  });

  it('returns 0 when nothing may be released yet', () => {
    const a = f(19_000, HEADER_BYTES);
    expect(releasableBytes([a], started, started + 20_000)).toBe(0);
  });

  it('returns 0 for an unknown round start, matching releasableFrames', () => {
    const a = f(0, HEADER_BYTES);
    expect(releasableBytes([a], 0, started + 20_000)).toBe(0);
  });
});
