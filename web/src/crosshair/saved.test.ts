import { describe, it, expect, afterEach, vi } from 'vitest';
import { savedCrosshair, savedArt, saveImage, crosshairPixels, CROSSHAIR_IMAGE_KEY } from './saved';
import { PNG_PREFIX } from './model';
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
      // The image shape is savedArt's to read: savedCrosshair is the drawn shapes only.
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

describe('savedArt', () => {
  const IMAGE = { png: PNG_PREFIX + 'AAAA', w: 128, h: 128 };

  it('is the saved builder crosshair as built art', () => {
    localStorage.setItem('xhair', JSON.stringify({ shape: 'dot', dot: 3 }));
    expect(savedArt()).toEqual({ kind: 'built', state: { ...DEFAULT_STATE, shape: 'dot', dot: 3 } });
  });

  it('is the saved image when the page is on its image shape', () => {
    localStorage.setItem('xhair', JSON.stringify({ shape: 'image' }));
    expect(savedArt()).toBeNull();
    saveImage(IMAGE);
    expect(JSON.parse(localStorage.getItem(CROSSHAIR_IMAGE_KEY)!)).toEqual(IMAGE);
    expect(savedArt()).toEqual({ kind: 'image', ...IMAGE });
    // A saved image is not used while the page is on a drawn shape.
    localStorage.setItem('xhair', JSON.stringify({ shape: 'cross' }));
    expect(savedArt()?.kind).toBe('built');
  });

  it('is null for a broken image entry, or when storage throws', () => {
    localStorage.setItem('xhair', JSON.stringify({ shape: 'image' }));
    for (const raw of ['{', JSON.stringify({ ...IMAGE, w: 9999 }), JSON.stringify({ ...IMAGE, png: 'x' })]) {
      localStorage.setItem(CROSSHAIR_IMAGE_KEY, raw);
      expect(savedArt(), raw).toBeNull();
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(savedArt()).toBeNull();
  });

  it('saves nothing, quietly, when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    expect(() => saveImage(IMAGE)).not.toThrow();
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
