import { describe, it, expect } from 'vitest';
import {
  normalizeMapName, autoFitTransform, worldToImage, boundsOf, pickLayer, transformOfLayer,
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

describe('pickLayer', () => {
  const layers = [
    { image: '/a.webp', cutHeight: 0, unitsPerPixel: 8, originX: 0, originY: 0, width: 2048, height: 1271 },
    { image: '/b.webp', cutHeight: 500, unitsPerPixel: 8, originX: 0, originY: 0, width: 2048, height: 1271 },
    { image: '/c.webp', cutHeight: 1000, unitsPerPixel: 8, originX: 0, originY: 0, width: 2048, height: 1271 },
  ];

  it('picks the lowest layer cut above the players', () => {
    expect(pickLayer(layers, 300, null)?.image).toBe('/b.webp');
  });

  it('picks the bottom layer for someone below every cut', () => {
    expect(pickLayer(layers, -800, null)?.image).toBe('/a.webp');
  });

  // A layer shows everything BELOW its cut, so someone above the highest cut is
  // not visible on any layer. The top one is the least wrong answer and is what
  // the spec's own rule falls back to.
  it('falls back to the top layer for someone above every cut', () => {
    expect(pickLayer(layers, 9000, null)?.image).toBe('/c.webp');
  });

  // Hysteresis. Without it a player standing on a boundary flips the whole map
  // back and forth several times a second, which is unwatchable.
  it('holds the current layer through small excursions past its boundary', () => {
    const current = layers[1];
    // 470 would select /b.webp anyway. 510 is past b's cut, but only just, so
    // the bias holds it rather than jumping to /c.webp.
    expect(pickLayer(layers, 510, current)?.image).toBe('/b.webp');
  });

  it('still switches once the excursion is decisive', () => {
    expect(pickLayer(layers, 700, layers[1])?.image).toBe('/c.webp');
  });

  it('returns null for an empty stack', () => {
    expect(pickLayer([], 0, null)).toBeNull();
  });
});

describe('transformOfLayer', () => {
  const layer = {
    image: '/a.webp', cutHeight: 0, unitsPerPixel: 8,
    originX: -1000, originY: 2000, width: 2048, height: 1271,
  };

  it('projects the layer origin to pixel 0,0', () => {
    expect(worldToImage(transformOfLayer(layer), -1000, 2000)).toEqual({ px: 0, py: 0 });
  });

  // World +Y is up, pixel +Y is down.
  it('flips the y axis', () => {
    expect(worldToImage(transformOfLayer(layer), -1000, 2000 - 800).py).toBe(100);
  });

  it('carries the image and its dimensions through', () => {
    const t = transformOfLayer(layer);
    expect(t.image).toBe('/a.webp');
    expect(t.width).toBe(2048);
    expect(t.height).toBe(1271);
  });
});

describe('worldToImage', () => {
  // transformFor is gone (Task 19 removed the Valve table), so these use a
  // literal transform carrying the same numbers the table used to produce for
  // l4d_farm01_hilltop. worldToImage itself is what is under test here, not
  // where the transform came from.
  const t = {
    originX: -13730, originY: -6299, unitsPerPixel: 9,
    image: '/overviews/l4d_farm01_hilltop.png', width: 1024, height: 1024,
  };

  it('puts the origin corner at pixel 0,0', () => {
    expect(worldToImage(t, -13730, -6299)).toEqual({ px: 0, py: 0 });
  });

  // y is flipped: mapinfo's y is the UPPER-left corner, and world y grows
  // north while image y grows down.
  it('flips the y axis', () => {
    const got = worldToImage(t, -13730, -6299 - 900);
    expect(got.px).toBe(0);
    expect(got.py).toBe(100);
  });

  it('scales x by units per pixel', () => {
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
