import { describe, it, expect } from 'vitest';
import { readState, readArt, fitSquare, drawArt, LIMITS, PNG_PREFIX } from './model';
import { DEFAULT_STATE, PX_AT_1080 } from './draw';
import { MAX_IMAGE_B64, MAX_IMAGE_SIDE } from '../hud/limits';

describe('readState', () => {
  it('reads a builder state over the defaults, keeping only its own keys', () => {
    expect(readState({ shape: 'dot', dot: 3, color: '#ffffff', extra: 1 })).toEqual({ ...DEFAULT_STATE, shape: 'dot', dot: 3, color: '#ffffff' });
  });

  it("clamps every number to its slider's range, so a design holds only what the builder can make", () => {
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      expect(readState({ [k]: hi + 100 })?.[k as keyof typeof LIMITS], k).toBe(hi);
      expect(readState({ [k]: lo - 100 })?.[k as keyof typeof LIMITS], k).toBe(lo);
    }
  });

  it('is null for anything the builder could not have made, the image shape included', () => {
    for (const raw of [null, 'x', [], { shape: 'laser' }, { shape: 'image' }, { color: 'red' }, { len: 'long' },
      { alpha: Infinity }, { round: 'yes' }]) {
      expect(readState(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('falls back to the default preview backdrop and resolution, which never reach the texture', () => {
    expect(readState({ backdrop: 'moon', res: '99' })).toEqual(DEFAULT_STATE);
  });
});

describe('readArt', () => {
  const png = (n: number) => PNG_PREFIX + 'A'.repeat(n);

  it('reads a built crosshair through readState', () => {
    expect(readArt({ kind: 'built', state: { shape: 'dot', len: 99 } })).toEqual({ kind: 'built', state: { ...DEFAULT_STATE, shape: 'dot', len: 30 } });
    expect(readArt({ kind: 'built', state: { shape: 'image' } })).toBeNull();
    expect(readArt({ kind: 'built' })).toBeNull();
  });

  it('reads an image crosshair within the uploaded style images\' caps', () => {
    expect(readArt({ kind: 'image', png: png(8), w: 128, h: 64, extra: 1 })).toEqual({ kind: 'image', png: png(8), w: 128, h: 64 });
    expect(readArt({ kind: 'image', png: png(MAX_IMAGE_B64), w: 1, h: MAX_IMAGE_SIDE })).not.toBeNull();
    for (const bad of [
      { png: png(MAX_IMAGE_B64 + 1), w: 1, h: 1 },
      { png: png(8), w: 0, h: 1 },
      { png: png(8), w: 1, h: MAX_IMAGE_SIDE + 1 },
      { png: png(8), w: 1.5, h: 1 },
      { png: 'data:image/svg+xml;base64,AAAA', w: 1, h: 1 },
      { png: PNG_PREFIX + '<script>', w: 1, h: 1 },
      { png: 'AAAA', w: 1, h: 1 },
      { w: 1, h: 1 },
    ]) expect(readArt({ kind: 'image', ...bad }), JSON.stringify(bad).slice(0, 80)).toBeNull();
  });

  it('is null for any other kind', () => {
    expect(readArt({ kind: 'addon' })).toBeNull();
    expect(readArt(undefined)).toBeNull();
  });
});

describe('fitSquare', () => {
  it('scales an image into the square, aspect kept, centred', () => {
    expect(fitSquare(64, 64, 128)).toEqual({ x: 0, y: 0, w: 128, h: 128 });
    expect(fitSquare(256, 128, 128)).toEqual({ x: 0, y: 32, w: 128, h: 64 });
    expect(fitSquare(10, 40, 128)).toEqual({ x: 48, y: 0, w: 32, h: 128 });
  });
});

describe('drawArt', () => {
  /** A context that records every call. */
  function rec() {
    const calls: { m: string; a: unknown[] }[] = [];
    const ctx = new Proxy({}, {
      get: (_t, k) => (...a: unknown[]) => { calls.push({ m: String(k), a }); },
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  }

  it('draws a built crosshair at the scale that fills `size` as the texture fills the element', () => {
    const { ctx, calls } = rec();
    drawArt(ctx, 50, 60, 26, { kind: 'built', state: { ...DEFAULT_STATE, shape: 'dot', dot: 2, outline: 0 } }, null);
    // A 2-pixel dot at 1080p in a 26-pixel element: radius 1 1080p pixel, at 26 / PX_AT_1080 each.
    expect(calls.find((c) => c.m === 'arc')?.a.slice(0, 3)).toEqual([50, 60, 26 / PX_AT_1080]);
  });

  it('draws an image fitted into the square around the centre, and nothing while it loads', () => {
    const { ctx, calls } = rec();
    const img = {} as HTMLImageElement;
    const art = { kind: 'image' as const, png: PNG_PREFIX, w: 256, h: 128 };
    drawArt(ctx, 100, 100, 40, art, img);
    expect(calls.find((c) => c.m === 'drawImage')?.a).toEqual([img, 80, 90, 40, 20]);
    const idle = rec();
    drawArt(idle.ctx, 100, 100, 40, art, null);
    expect(idle.calls.some((c) => c.m === 'drawImage')).toBe(false);
  });
});
