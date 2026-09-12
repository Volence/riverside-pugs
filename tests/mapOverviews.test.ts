import { describe, it, expect } from 'vitest';
import { OVERVIEWS, overviewFor } from '../src/mapOverviews.js';
import {
  boxSpan, canvasAspect, canvasForBox, fitView, type ViewBox,
} from '../src/mapTransform.js';

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

describe('content boxes', () => {
  it('gives every map a content box inside its image', () => {
    for (const m of Object.values(OVERVIEWS)) {
      const b = m.contentBox;
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.y0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(m.layers[0].width);
      expect(b.y1).toBeLessThanOrEqual(m.layers[0].height);
      expect(b.x1).toBeGreaterThan(b.x0);
      expect(b.y1).toBeGreaterThan(b.y0);
    }
  });

});

/**
 * The acceptance test for the crop.
 *
 * This used to assert that the median content box covered less than 0.75 of
 * its image BY AREA. Area fraction has no relationship to how big a map is
 * drawn, which is why the crop shipped believing it had worked while making
 * eighteen of twenty-two maps smaller on screen: the captures and the canvas
 * were the same shape, so cropping horizontal void out of a landscape frame
 * left the height governing the fit and merely moved the void from the image
 * into the canvas as black bars.
 *
 * What is asserted instead is the quantity that was supposed to improve: the
 * scale `fitView` draws at, in canvas pixels per image pixel. Both sides of
 * the comparison get a canvas of the same backing-store budget and the same
 * padding, so the only difference between them is whether the box was
 * cropped.
 */
describe('cropping to the content box', () => {
  const scaleOf = (box: ViewBox): number => {
    const canvas = canvasForBox(box);
    return fitView(box, canvas.width, canvas.height).scale;
  };

  const gains = Object.values(OVERVIEWS).map((m) => ({
    map: m.map,
    gain: scaleOf(m.contentBox)
      / scaleOf({ x0: 0, y0: 0, x1: m.layers[0].width, y1: m.layers[0].height }),
  }));

  it('never draws a map smaller than it would uncropped', () => {
    const worse = gains
      .filter((g) => g.gain < 1 - 1e-6)
      .map((g) => `${g.map} ${g.gain.toFixed(3)}x`);
    expect(worse).toEqual([]);
  });

  // The clamp is the fallback for a map shaped like a ribbon, and it costs
  // scale when it bites: a clamped canvas letterboxes exactly as the old
  // fixed one did. Nothing shipped is close to it, and a future map that is
  // should be a deliberate decision rather than a silent loss of scale.
  it('needs the aspect clamp for none of the shipped maps', () => {
    const clamped = Object.values(OVERVIEWS)
      .filter((m) => {
        const { w, h } = boxSpan(m.contentBox);
        return w / h !== canvasAspect(m.contentBox);
      })
      .map((m) => m.map);
    expect(clamped).toEqual([]);
  });

  it('draws the median map meaningfully bigger than uncropped', () => {
    const sorted = gains.map((g) => g.gain).sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeGreaterThan(1.15);
  });
});
