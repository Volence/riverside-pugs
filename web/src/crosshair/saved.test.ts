import { describe, it, expect, afterEach, vi } from 'vitest';
import { savedCrosshair, crosshairPixels } from './saved';
import { DEFAULT_STATE, PX_AT_1080, TEX } from './draw';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('savedCrosshair', () => {
  it('reads what the Crosshair page saved, over its defaults', () => {
    localStorage.setItem('xhair', JSON.stringify({ shape: 'dot', color: '#ffffff', dot: 3 }));
    expect(savedCrosshair()).toEqual({ ...DEFAULT_STATE, shape: 'dot', color: '#ffffff', dot: 3 });
  });

  it('is null when nothing usable is saved', () => {
    expect(savedCrosshair()).toBeNull();
    for (const raw of ['{', '"x"', 'null', '[]', JSON.stringify({ shape: 'laser' }), JSON.stringify({ color: 'red' }),
      JSON.stringify({ len: 'long' }), JSON.stringify({ alpha: null }), JSON.stringify({ round: 'yes' }),
      // An imported image is never saved, only its shape name, so there is nothing to draw.
      JSON.stringify({ shape: 'image' })]) {
      localStorage.setItem('xhair', raw);
      expect(savedCrosshair(), raw).toBeNull();
    }
  });

  it('is null when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(savedCrosshair()).toBeNull();
  });
});

describe('crosshairPixels', () => {
  it('draws the crosshair into the page texture size and returns its pixels', () => {
    const px = new Uint8ClampedArray(TEX * TEX * 4).fill(9);
    const arcs: number[][] = [];
    const ctx = new Proxy({}, {
      get: (_t, k) => (k === 'getImageData' ? (x: number, y: number, w: number, h: number) => ({ data: px, x, y, w, h })
        : k === 'arc' ? (...a: number[]) => { arcs.push(a); } : () => {}),
      set: () => true,
    });
    const sizes: number[][] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      sizes.push([this.width, this.height]);
      return ctx as unknown as CanvasRenderingContext2D;
    } as never);
    expect(crosshairPixels({ ...DEFAULT_STATE, shape: 'dot', dot: 2, outline: 0 }, null)).toBe(px);
    expect(sizes).toEqual([[TEX, TEX]]);
    // The dot sits at the texture's centre at the Crosshair page's own scale.
    expect(arcs[0].slice(0, 3)).toEqual([TEX / 2, TEX / 2, 1 * TEX / PX_AT_1080]);
  });

  it('is null without a 2D context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(crosshairPixels(DEFAULT_STATE, null)).toBeNull();
  });
});
