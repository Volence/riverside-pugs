import { describe, it, expect } from 'vitest';
import { canvasSize, resolveSize, THEATER_PIXEL_BUDGET } from './canvasSize';
import { CANVAS_PIXEL_BUDGET } from '../../../src/mapTransform';

describe('canvasSize', () => {
  // The bug this exists for: the canvas carried a fixed 1280x794 backing
  // store inside a page at most 1120px wide, so it displayed at about 1024
  // CSS px on a desktop and 279 on a phone. Everything the draw code calls a
  // screen unit was resampled to 0.8 or 0.22 by the time anyone saw it.
  it('gives one backing pixel per CSS pixel at ratio 1', () => {
    const s = canvasSize(1024, 1280 / 794, 1);
    expect(s.cssW).toBe(1024);
    expect(s.pixelW).toBe(1024);
    expect(s.ratio).toBe(1);
  });

  it('takes the device ratio when there is budget for it', () => {
    const s = canvasSize(279, 1280 / 794, 3);
    expect(s.ratio).toBe(3);
    expect(s.pixelW).toBe(837);
  });

  // A retina phone at 3x on a wide element would otherwise cost several
  // times the memory of the fixed canvas it replaced.
  it('caps the backing store at the pixel budget', () => {
    const s = canvasSize(1280, 1280 / 794, 3);
    expect(s.pixelW * s.pixelH).toBeLessThanOrEqual(CANVAS_PIXEL_BUDGET * 1.01);
    expect(s.ratio).toBeLessThan(3);
  });

  // A display reporting no ratio, or a fractional one, still gets a full
  // pixel per CSS pixel: softening the map is never the right default.
  it('never drops below one backing pixel per CSS pixel', () => {
    expect(canvasSize(600, 1.6, 0.5).ratio).toBe(1);
    expect(canvasSize(600, 1.6, 0).ratio).toBe(1);
  });

  // The element's CSS aspect-ratio is set from the same number, so a backing
  // store of a different shape would be letterboxed a second time by the
  // browser, inside a canvas that already letterboxes the map itself.
  it('keeps the backing store the same shape as the layout box', () => {
    for (const aspect of [0.55, 0.7364, 1.0, 1.6113, 2.2]) {
      const s = canvasSize(800, aspect, 2);
      expect(s.cssW / s.cssH).toBeCloseTo(aspect, 6);
      expect(s.pixelW / s.pixelH).toBeCloseTo(aspect, 2);
    }
  });

  it('survives a zero width rather than dividing by it', () => {
    const s = canvasSize(0, 1.6, 1);
    expect(Number.isFinite(s.pixelW)).toBe(true);
    expect(s.pixelW).toBeGreaterThan(0);
  });
});

describe('resolveSize', () => {
  it('uses the map aspect and the page budget when not filling', () => {
    const s = resolveSize(1000, 3000, 1.6, 1, false);
    expect(s.cssW).toBe(1000);
    expect(s.cssH).toBeCloseTo(625, 6);
  });

  it('takes the element shape and the theater budget when filling', () => {
    const s = resolveSize(1920, 1080, 1.6, 2, true);
    expect(s.cssW).toBe(1920);
    expect(s.cssH).toBe(1080);
    // 1920x1080 at 2x is 8.3M backing pixels, over the 3.7M theater budget:
    // capped, but well above the 0.7 the page budget would have left.
    expect(s.pixelW * s.pixelH).toBeLessThanOrEqual(THEATER_PIXEL_BUDGET * 1.01);
    expect(s.ratio).toBeGreaterThan(1.3);
  });

  it('falls back to the map aspect while filling with no height yet', () => {
    const s = resolveSize(1920, 0, 1.6, 1, true);
    expect(s.cssH).toBeCloseTo(1200, 6);
  });
});
