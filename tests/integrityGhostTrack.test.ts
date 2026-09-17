import { describe, it, expect } from 'vitest';
import { STATE, PLAYER_SLOTS, type Frame, type PlayerSample } from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';
import { bearing } from '../src/integrity/geometry.js';
import { trackFidelity, trackWindows, pickClips, type TrackWindow } from '../src/integrity/ghostTrack.js';

function blank(slot: number): PlayerSample {
  return {
    slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
    health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
  };
}

/**
 * A round where survivor slot 0 stands at the origin and ghost slot 4 walks an
 * arc around them at `radius`, `stepDeg` of bearing per frame, starting at
 * `startDeg`. `yawOf` decides where the survivor looks.
 *
 * `stepDeg` matters: the ghost has to stay inside E_TRACK of the survivor's aim
 * for W consecutive frames or no window forms at all and a test asserting over
 * the windows passes vacuously.
 */
function round(
  n: number,
  yawOf: (i: number, trueBearing: number) => number,
  radius = 1200,
  stepDeg = 6,
  startDeg = 0,
): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const a = (startDeg + i * stepDeg) * Math.PI / 180;
    const gx = Math.cos(a) * radius;
    const gy = Math.sin(a) * radius;
    const trueB = bearing({ x: 0, y: 0 }, { x: gx, y: gy });
    const players = Array.from({ length: PLAYER_SLOTS }, (_, s) => blank(s));
    players[0] = { ...blank(0), state: STATE.PRESENT | STATE.ALIVE, yaw: yawOf(i, trueB) };
    players[4] = { ...blank(4), state: STATE.PRESENT | STATE.GHOST, x: gx, y: gy };
    frames.push({ tMs: TUNING.SPAWN_GRACE_MS + i * 100, offset: 0, players, entities: [] });
  }
  return frames;
}

describe('trackFidelity', () => {
  it('is 1 when the crosshair moved exactly as needed to follow the target', () => {
    expect(trackFidelity([2, 3, 4], [2, 3, 4])).toBeCloseTo(1);
  });

  it('is 1 for perfect tracking of a target moving at a CONSTANT rate', () => {
    // The case that defeats Pearson: constant deltas have no variance, so a
    // correlation is undefined exactly when the tracking is most blatant.
    expect(trackFidelity([6, 6, 6, 6], [6, 6, 6, 6])).toBeCloseTo(1);
  });

  it('is 0 for a crosshair that never moved while the target did', () => {
    expect(trackFidelity([0, 0, 0], [5, 5, 5])).toBeCloseTo(0);
  });

  it('is 0, not negative, for a crosshair moving opposite to the target', () => {
    expect(trackFidelity([-5, -5, -5], [5, 5, 5])).toBe(0);
  });

  it('penalises moving at the wrong rate in proportion', () => {
    const half = trackFidelity([3, 3, 3], [6, 6, 6]);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
  });

  it('is 0 when the target never moved, so there was nothing to track', () => {
    expect(trackFidelity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('is 0 for series shorter than one delta', () => {
    expect(trackFidelity([], [])).toBe(0);
  });
});

describe('trackWindows', () => {
  it('scores near 1 when the crosshair follows the ghost exactly', () => {
    const w = trackWindows(round(40, (_i, b) => b), 0);
    expect(w.length).toBeGreaterThan(0);
    expect(Math.max(...w.map((x) => x.fidelity))).toBeGreaterThan(0.9);
  });

  it('scores near 0 for a held angle, which is what pre-aiming a spawn looks like', () => {
    // The ghost drifts slowly across a held crosshair: slow enough that a window
    // DOES form (a quarter degree per frame keeps it inside E_TRACK for all 40),
    // so this asserts over real windows rather than passing vacuously.
    const frames = round(40, () => 0, 1200, 0.25, -5);
    const windows = trackWindows(frames, 0);
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) expect(w.fidelity).toBeLessThan(0.2);
  });

  it('produces no window when the aim never stays inside E_TRACK', () => {
    expect(trackWindows(round(40, (_i, b) => b + 90), 0)).toEqual([]);
  });

  it('produces no window for a ghost closer than D_MIN', () => {
    expect(trackWindows(round(40, (_i, b) => b, TUNING.D_MIN - 50), 0)).toEqual([]);
  });

  it('ignores frames inside the spawn grace window', () => {
    const frames = round(40, (_i, b) => b);
    for (const f of frames) f.tMs -= TUNING.SPAWN_GRACE_MS;
    expect(trackWindows(frames, 0)).toEqual([]);
  });

  it('reports the window bounds and the ghost slot', () => {
    const w = trackWindows(round(40, (_i, b) => b), 0);
    expect(w[0].ghostSlot).toBe(4);
    expect(w[0].endMs).toBeGreaterThan(w[0].startMs);
  });
});

describe('pickClips', () => {
  const win = (startMs: number, endMs: number, fidelity: number): TrackWindow =>
    ({ startMs, endMs, ghostSlot: 4, fidelity, meanErr: 1, meanDist: 900 });

  it('drops anything under CLIP_MIN', () => {
    expect(pickClips([win(0, 2000, TUNING.CLIP_MIN - 0.01)])).toEqual([]);
  });

  it('keeps the highest scoring window and drops ones overlapping it', () => {
    const got = pickClips([win(0, 2000, 0.8), win(1000, 3000, 0.95)]);
    expect(got).toHaveLength(1);
    expect(got[0].fidelity).toBeCloseTo(0.95);
  });

  it('keeps non-overlapping windows, best first', () => {
    const got = pickClips([win(0, 2000, 0.8), win(5000, 7000, 0.95)]);
    expect(got.map((g) => g.fidelity)).toEqual([0.95, 0.8]);
  });

  it('keeps at most CLIPS_PER_ROUND', () => {
    const many = Array.from({ length: TUNING.CLIPS_PER_ROUND + 4 }, (_, i) => win(i * 5000, i * 5000 + 2000, 0.9));
    expect(pickClips(many)).toHaveLength(TUNING.CLIPS_PER_ROUND);
  });
});
