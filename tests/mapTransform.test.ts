import { describe, it, expect } from 'vitest';
import {
  normalizeMapName, transformFor, autoFitTransform, worldToImage, boundsOf,
} from '../src/mapTransform.js';

describe('normalizeMapName', () => {
  it('strips the versus infix so a vs map finds its overview', () => {
    expect(normalizeMapName('l4d_vs_farm01_hilltop')).toBe('l4d_farm01_hilltop');
  });

  it('leaves a coop map name alone', () => {
    expect(normalizeMapName('l4d_farm01_hilltop')).toBe('l4d_farm01_hilltop');
  });

  it('lowercases, because the header is whatever the engine reported', () => {
    expect(normalizeMapName('L4D_VS_Farm01_Hilltop')).toBe('l4d_farm01_hilltop');
  });
});

describe('transformFor', () => {
  it('finds the Valve numbers for a versus map', () => {
    const t = transformFor('l4d_vs_farm01_hilltop')!;
    expect(t.originX).toBe(-13730);
    expect(t.originY).toBe(-6299);
    expect(t.unitsPerPixel).toBe(9);
    expect(t.image).toBe('/overviews/l4d_farm01_hilltop.png');
  });

  it('returns null for a map with no overview', () => {
    expect(transformFor('l4d_vs_hospital01_apartment')).toBeNull();
  });
});

describe('worldToImage', () => {
  it('puts the origin corner at pixel 0,0', () => {
    const t = transformFor('l4d_farm01_hilltop')!;
    expect(worldToImage(t, -13730, -6299)).toEqual({ px: 0, py: 0 });
  });

  // y is flipped: mapinfo's y is the UPPER-left corner, and world y grows
  // north while image y grows down.
  it('flips the y axis', () => {
    const t = transformFor('l4d_farm01_hilltop')!;
    const got = worldToImage(t, -13730, -6299 - 900);
    expect(got.px).toBe(0);
    expect(got.py).toBe(100);
  });

  it('scales x by units per pixel', () => {
    const t = transformFor('l4d_farm01_hilltop')!;
    expect(worldToImage(t, -13730 + 900, -6299).px).toBe(100);
  });
});

describe('boundsOf', () => {
  it('finds the extent of the points', () => {
    expect(boundsOf([{ x: 1, y: 5 }, { x: -3, y: 2 }, { x: 7, y: 9 }]))
      .toEqual({ minX: -3, maxX: 7, minY: 2, maxY: 9 });
  });

  it('returns null for no points', () => {
    expect(boundsOf([])).toBeNull();
  });
});

describe('autoFitTransform', () => {
  it('fits a wide world into the canvas without distorting it', () => {
    // 2000 wide, 1000 tall, into a 500x500 canvas. The wide axis governs.
    const t = autoFitTransform({ minX: 0, maxX: 2000, minY: 0, maxY: 1000 }, 500, 500, 0);
    expect(t.unitsPerPixel).toBe(4);
    // Both axes share one scale, which is what keeps pixels square.
    const a = worldToImage(t, 0, 1000);
    const b = worldToImage(t, 2000, 1000);
    expect(b.px - a.px).toBe(500);
  });

  it('centres the fitted world on the short axis', () => {
    const t = autoFitTransform({ minX: 0, maxX: 2000, minY: 0, maxY: 1000 }, 500, 500, 0);
    // The world is 1000 tall at 4 units per pixel, so 250px of a 500px
    // canvas, leaving 125px of margin above and below.
    expect(worldToImage(t, 0, 1000).py).toBe(125);
    expect(worldToImage(t, 0, 0).py).toBe(375);
  });

  it('has no image', () => {
    const t = autoFitTransform({ minX: 0, maxX: 100, minY: 0, maxY: 100 }, 500, 500);
    expect(t.image).toBeNull();
  });

  it('survives a degenerate world where every point is the same', () => {
    const t = autoFitTransform({ minX: 10, maxX: 10, minY: 10, maxY: 10 }, 500, 500);
    expect(Number.isFinite(t.unitsPerPixel)).toBe(true);
    expect(t.unitsPerPixel).toBeGreaterThan(0);
  });
});
