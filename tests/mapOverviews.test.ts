import { describe, it, expect } from 'vitest';
import { OVERVIEWS, overviewFor } from '../src/mapOverviews.js';

describe('OVERVIEWS', () => {
  it('covers all 22 maps', () => {
    expect(Object.keys(OVERVIEWS)).toHaveLength(22);
  });

  it('has 182 layers in total', () => {
    const n = Object.values(OVERVIEWS).reduce((t, m) => t + m.layers.length, 0);
    expect(n).toBe(182);
  });

  // The selection rule walks the array assuming ascending order. A manifest out
  // of order would pick a layer that hides the players rather than showing them,
  // and would do it silently.
  it('orders every map ascending by cut height', () => {
    for (const m of Object.values(OVERVIEWS)) {
      const heights = m.layers.map((l) => l.cutHeight);
      expect(heights).toEqual([...heights].sort((a, b) => a - b));
    }
  });

  // The spec states this, and layer switching relies on it: if two layers of one
  // map disagreed on the transform, swapping between them would shift the map
  // under the players.
  it('shares one transform across every layer of a map', () => {
    for (const m of Object.values(OVERVIEWS)) {
      const first = m.layers[0];
      for (const l of m.layers) {
        expect(l.unitsPerPixel).toBe(first.unitsPerPixel);
        expect(l.originX).toBe(first.originX);
        expect(l.originY).toBe(first.originY);
      }
    }
  });

  it('points every layer at a webp under /overviews/', () => {
    for (const m of Object.values(OVERVIEWS)) {
      for (const l of m.layers) {
        expect(l.image).toMatch(/^\/overviews\/[a-z0-9_+-]+\.webp$/);
      }
    }
  });

  it('carries the spec values for a known map', () => {
    const m = overviewFor('l4d_vs_farm01_hilltop')!;
    expect(m.layers).toHaveLength(5);
    expect(m.layers[0].unitsPerPixel).toBeCloseTo(7.250983, 5);
    expect(m.layers[0].originX).toBe(-16547);
    expect(m.layers[0].originY).toBe(-6299);
  });
});

describe('overviewFor', () => {
  it('finds a versus map by the name the server reports', () => {
    expect(overviewFor('l4d_vs_hospital01_apartment')?.map).toBe('l4d_vs_hospital01_apartment');
  });

  it('finds Crash Course by its co-op name, which is what the server reports', () => {
    expect(overviewFor('l4d_garage01_alleys')?.map).toBe('l4d_garage01_alleys');
  });

  // Second chance, because a miss is silent: the viewer just falls back to
  // auto-fit and looks worse, with nothing logged.
  it('tries the other spelling of the versus infix', () => {
    expect(overviewFor('l4d_farm01_hilltop')?.map).toBe('l4d_vs_farm01_hilltop');
  });

  it('is case insensitive', () => {
    expect(overviewFor('L4D_VS_Farm01_Hilltop')?.map).toBe('l4d_vs_farm01_hilltop');
  });

  it('returns null for a map with no art', () => {
    expect(overviewFor('l4d_vs_nonsense99_nowhere')).toBeNull();
  });
});
