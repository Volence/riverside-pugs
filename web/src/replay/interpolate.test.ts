import { describe, it, expect } from 'vitest';
import {
  lerp, lerpAngle, bracket, interpolatePlayers, interpolateEntities, MAX_ENTITY_JUMP,
} from './interpolate';
import { PLAYER_SLOTS, STATE, ENTITY_KIND, type Frame, type PlayerSample } from '../../../src/replayFormat';

function players(over: Partial<PlayerSample>[] = []): PlayerSample[] {
  return Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
    slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
    health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    ...(over[slot] ?? {}),
  }));
}

function frameAt(tMs: number, over: Partial<Frame> = {}): Frame {
  return { tMs, offset: 0, players: players(), entities: [], ...over };
}

describe('lerp', () => {
  it('interpolates linearly', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });
});

describe('lerpAngle', () => {
  it('interpolates the short way across the wrap', () => {
    // 170 to -170 is 20 degrees the short way, not 340 the long way.
    expect(lerpAngle(170, -170, 0.5)).toBeCloseTo(180, 5);
  });

  it('interpolates normally away from the wrap', () => {
    expect(lerpAngle(0, 90, 0.5)).toBeCloseTo(45, 5);
  });

  it('handles the other direction across the wrap', () => {
    expect(lerpAngle(-170, 170, 0.5)).toBeCloseTo(-180, 5);
  });
});

describe('bracket', () => {
  const frames = [frameAt(0), frameAt(100), frameAt(200), frameAt(300)];

  it('finds the pair a time falls between, and how far', () => {
    const got = bracket(frames, 150)!;
    expect(got.a.tMs).toBe(100);
    expect(got.b.tMs).toBe(200);
    expect(got.f).toBeCloseTo(0.5, 5);
  });

  it('clamps before the first frame', () => {
    const got = bracket(frames, -50)!;
    expect(got.a.tMs).toBe(0);
    expect(got.f).toBe(0);
  });

  it('clamps after the last frame', () => {
    const got = bracket(frames, 9999)!;
    expect(got.a.tMs).toBe(300);
    expect(got.b.tMs).toBe(300);
    expect(got.f).toBe(0);
  });

  it('returns null with no frames', () => {
    expect(bracket([], 0)).toBeNull();
  });

  it('does not scan linearly', () => {
    // A round is 4000-plus frames and this runs 60 times a second, so a
    // linear scan would be the slowest thing in the viewer. Binary search
    // over a large array must still land on the right pair.
    const many = Array.from({ length: 5000 }, (_, i) => frameAt(i * 100));
    const got = bracket(many, 4999 * 100 - 50)!;
    expect(got.a.tMs).toBe(4998 * 100);
    expect(got.b.tMs).toBe(4999 * 100);
  });
});

describe('interpolatePlayers', () => {
  it('moves a player between frames', () => {
    const a = frameAt(0, { players: players([{ x: 0, y: 0 }]) });
    const b = frameAt(100, { players: players([{ x: 100, y: -50 }]) });
    const got = interpolatePlayers(a, b, 0.5);
    expect(got[0].x).toBe(50);
    expect(got[0].y).toBe(-25);
  });

  // State is a bitfield. Half of "incapped" is not a thing, and interpolating
  // it would make a player flicker between states for a tenth of a second
  // every time one changed.
  it('takes discrete fields from the earlier frame', () => {
    const a = frameAt(0, { players: players([{ state: STATE.PRESENT | STATE.ALIVE, health: 100 }]) });
    const b = frameAt(100, { players: players([{ state: STATE.PRESENT, health: 0 }]) });
    const got = interpolatePlayers(a, b, 0.9);
    expect(got[0].state).toBe(STATE.PRESENT | STATE.ALIVE);
    expect(got[0].health).toBe(100);
  });
});

describe('interpolateEntities', () => {
  it('moves an entity whose ref and kind both match', () => {
    const a = frameAt(0, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: 0, y: 0, z: 0, health: 50 }] });
    const b = frameAt(100, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: 100, y: 0, z: 0, health: 50 }] });
    expect(interpolateEntities(a, b, 0.5)[0].x).toBe(50);
  });

  // Engine entity indices are recycled. A common that dies and a different
  // common that spawns can share ref 5 one frame apart, and interpolating
  // between them draws a zombie sliding impossibly across the map.
  it('does not interpolate a recycled ref that teleported', () => {
    const a = frameAt(0, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: 0, y: 0, z: 0, health: 50 }] });
    const b = frameAt(100, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: MAX_ENTITY_JUMP + 100, y: 0, z: 0, health: 50 }] });
    const got = interpolateEntities(a, b, 0.5);
    expect(got[0].x).toBe(MAX_ENTITY_JUMP + 100);
  });

  it('does not interpolate a ref whose kind changed', () => {
    const a = frameAt(0, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: 0, y: 0, z: 0, health: 50 }] });
    const b = frameAt(100, { entities: [{ ref: 5, kind: ENTITY_KIND.WITCH, state: 0, x: 100, y: 0, z: 0, health: 50 }] });
    expect(interpolateEntities(a, b, 0.5)[0].x).toBe(100);
  });

  it('shows an entity that only exists in the later frame', () => {
    const a = frameAt(0, { entities: [] });
    const b = frameAt(100, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: 100, y: 0, z: 0, health: 50 }] });
    expect(interpolateEntities(a, b, 0.5)).toHaveLength(1);
  });
});
