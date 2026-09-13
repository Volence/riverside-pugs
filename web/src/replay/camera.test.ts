import { describe, it, expect } from 'vitest';
import {
  FIT_CAMERA, FREE, TEAM, MAX_ZOOM, clampPan, clampZoom, followPoint, followSlotOf, zoomAbout, zoomedView,
} from './camera';
import { fitView, projectView, unprojectView, type MapTransform } from '../../../src/mapTransform';
import { STATE, type PlayerSample } from '../../../src/replayFormat';

const T: MapTransform = { originX: -1000, originY: 2000, unitsPerPixel: 4, image: null, width: 2048, height: 1271 };
// A content box the same shape as the canvas, so at fit (3 percent padding)
// the drawn map is a little smaller than the canvas on BOTH axes and at any
// zoom of 2 or more it overflows both. The clamp behaves differently in the
// two regimes and the tests below need each one cleanly.
const BOX = { x0: 0, y0: 0, x1: 1600, y1: 1000 };
const W = 800, H = 500;
const FIT = fitView(BOX, W, H);

function player(over: Partial<PlayerSample> = {}): PlayerSample {
  return {
    slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    state: STATE.PRESENT | STATE.ALIVE,
    health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    ...over,
  };
}

describe('unprojectView', () => {
  it('round-trips a world position through project and inverse', () => {
    const v = zoomedView(FIT, { zoom: 3, panX: 40, panY: -25 }, W, H);
    const p = projectView(T, v, 123.4, -567.8);
    const w = unprojectView(T, v, p.px, p.py);
    expect(w.x).toBeCloseTo(123.4, 6);
    expect(w.y).toBeCloseTo(-567.8, 6);
  });
});

describe('zoomedView', () => {
  it('is the fit itself at zoom 1 with no pan', () => {
    const v = zoomedView(FIT, FIT_CAMERA, W, H);
    expect(v.scale).toBeCloseTo(FIT.scale, 9);
    expect(v.offsetX).toBeCloseTo(FIT.offsetX, 9);
    expect(v.offsetY).toBeCloseTo(FIT.offsetY, 9);
    expect(v.box).toBe(FIT.box);
  });

  it('magnifies about the canvas centre', () => {
    const v = zoomedView(FIT, { zoom: 2, panX: 0, panY: 0 }, W, H);
    // The image point at the canvas centre before is still there after.
    const centreBefore = unprojectView(T, FIT, W / 2, H / 2);
    const centreAfter = unprojectView(T, v, W / 2, H / 2);
    expect(centreAfter.x).toBeCloseTo(centreBefore.x, 6);
    expect(centreAfter.y).toBeCloseTo(centreBefore.y, 6);
    expect(v.scale).toBeCloseTo(FIT.scale * 2, 9);
  });

  it('shifts by the pan in canvas pixels', () => {
    const a = zoomedView(FIT, { zoom: 2, panX: 0, panY: 0 }, W, H);
    const b = zoomedView(FIT, { zoom: 2, panX: 30, panY: -10 }, W, H);
    expect(b.offsetX - a.offsetX).toBeCloseTo(30, 9);
    expect(b.offsetY - a.offsetY).toBeCloseTo(-10, 9);
  });
});

describe('clampPan', () => {
  it('centres an axis where the drawn map fits inside the canvas', () => {
    // At fit the map is smaller than the canvas on both axes: no pan at all.
    const c = clampPan(FIT, { zoom: 1, panX: 300, panY: -300 }, W, H);
    expect(c.panX).toBe(0);
    expect(c.panY).toBe(0);
  });

  it('never shows void past the map edge on an axis the map overflows', () => {
    const cam = { zoom: 4, panX: 5000, panY: -5000 };
    const c = clampPan(FIT, cam, W, H);
    const v = zoomedView(FIT, c, W, H);
    const drawnW = (BOX.x1 - BOX.x0) * v.scale;
    const drawnH = (BOX.y1 - BOX.y0) * v.scale;
    // Left edge at or left of the canvas edge, right edge at or right of it.
    expect(v.offsetX).toBeLessThanOrEqual(0 + 1e-9);
    expect(v.offsetX + drawnW).toBeGreaterThanOrEqual(W - 1e-9);
    expect(v.offsetY).toBeLessThanOrEqual(0 + 1e-9);
    expect(v.offsetY + drawnH).toBeGreaterThanOrEqual(H - 1e-9);
  });

  it('leaves a pan that is already inside the limits alone', () => {
    const cam = { zoom: 4, panX: 10, panY: 10 };
    expect(clampPan(FIT, cam, W, H)).toEqual(cam);
  });
});

describe('zoomAbout', () => {
  it('keeps the map point under the cursor where it is', () => {
    const cam = { zoom: 2, panX: 0, panY: 0 };
    const cursor = { px: 500, py: 300 };
    const before = unprojectView(T, zoomedView(FIT, cam, W, H), cursor.px, cursor.py);
    const next = zoomAbout(FIT, cam, 4, cursor.px, cursor.py, W, H);
    const after = unprojectView(T, zoomedView(FIT, next, W, H), cursor.px, cursor.py);
    expect(next.zoom).toBe(4);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('clamps the zoom and then the pan', () => {
    const next = zoomAbout(FIT, FIT_CAMERA, 50, 10, 10, W, H);
    expect(next.zoom).toBe(MAX_ZOOM);
    expect(next).toEqual(clampPan(FIT, next, W, H));
  });

  it('clampZoom holds the range', () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(3)).toBe(3);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
  });
});

describe('follow', () => {
  const players = [
    player({ slot: 0, x: 0, y: 0 }),
    player({ slot: 1, x: 100, y: 0 }),
    player({ slot: 2, x: 100, y: 100, state: STATE.PRESENT }),          // dead: left out
    player({ slot: 3, x: 9999, y: 9999, state: 0 }),                     // empty slot
    player({ slot: 4, x: -500, y: -500 }),                               // infected: never in the centroid
  ];

  it('follows nobody when free', () => {
    expect(followPoint(players, FREE)).toBeNull();
    expect(followSlotOf(FREE)).toBeNull();
  });

  it('follows the slot, and reports it for the ring', () => {
    expect(followPoint(players, { kind: 'slot', slot: 1 })).toEqual({ x: 100, y: 0 });
    expect(followSlotOf({ kind: 'slot', slot: 1 })).toBe(1);
  });

  it('follows nobody rather than the world origin for an empty slot', () => {
    expect(followPoint(players, { kind: 'slot', slot: 3 })).toBeNull();
  });

  it('centres the team on the alive, present survivors', () => {
    expect(followPoint(players, TEAM)).toEqual({ x: 50, y: 0 });
    expect(followSlotOf(TEAM)).toBeNull();
  });

  it('falls back to the present survivors when none are alive', () => {
    const wiped = players.map((p) => ({ ...p, state: p.state & ~STATE.ALIVE }));
    expect(followPoint(wiped, TEAM)).toEqual({ x: 200 / 3, y: 100 / 3 });
  });

  it('follows nobody with no survivors present at all', () => {
    expect(followPoint([player({ slot: 4 })], TEAM)).toBeNull();
  });
});
