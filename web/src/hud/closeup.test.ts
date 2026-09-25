import { describe, it, expect } from 'vitest';
import { closeUpRegion, CLOSEUP_MAX_ZOOM } from './closeup';

describe('closeUpRegion', () => {
  it('centres a small piece and enlarges it to fill the view with room around it', () => {
    const r = closeUpRegion({ x: 800, y: 400, w: 20, h: 20 }, 1000, 560, 320, 180);
    expect(r.zoom).toBeCloseTo(180 / 32);
    expect(r.x + r.w / 2).toBeCloseTo(810);
    expect(r.y + r.h / 2).toBeCloseTo(410);
    expect(r.w / r.h).toBeCloseTo(320 / 180);
  });

  it('caps the zoom on a tiny piece', () => {
    expect(closeUpRegion({ x: 100, y: 100, w: 2, h: 2 }, 1000, 560, 320, 180).zoom).toBe(CLOSEUP_MAX_ZOOM);
  });

  it('keeps the region on the canvas at an edge', () => {
    const r = closeUpRegion({ x: 990, y: 550, w: 10, h: 10 }, 1000, 560, 320, 180);
    expect(r.x + r.w).toBeCloseTo(1000);
    expect(r.y + r.h).toBeCloseTo(560);
  });

  it('shows the whole screen, not less, for a selection as big as the canvas', () => {
    const r = closeUpRegion({ x: 0, y: 0, w: 1000, h: 560 }, 1000, 560, 320, 180);
    expect(r.zoom).toBeCloseTo(180 / 560);
    expect(r.w).toBeGreaterThanOrEqual(1000);
  });
});
