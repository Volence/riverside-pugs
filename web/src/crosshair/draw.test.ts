import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  drawBackdrop, gameBackdropImage, loadGameBackdrop, resetGameBackdrops, GAME_BACKDROPS, SIDE_BACKDROP, isGameBackdrop,
} from './draw';

/** An Image that loads (or fails) only when the test says so. */
class FakeImage {
  static made: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  naturalWidth = 1920;
  naturalHeight = 1080;
  constructor() { FakeImage.made.push(this); }
}

function recorder() {
  const calls: [string, unknown[]][] = [];
  const ctx = new Proxy({}, {
    get: (_t, k) => (...a: unknown[]) => {
      calls.push([String(k), a]);
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
      return undefined;
    },
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

afterEach(() => {
  resetGameBackdrops();
  FakeImage.made = [];
  vi.unstubAllGlobals();
});

describe('game backdrops', () => {
  it('are the four in-game shots, served from /hud-backdrops/', () => {
    expect(Object.keys(GAME_BACKDROPS).sort()).toEqual(['infected-ghost', 'infected-hunter', 'survivor-hilltop', 'survivor-subway']);
    for (const [k, v] of Object.entries(GAME_BACKDROPS)) expect(v.src).toBe(`/hud-backdrops/${k}.jpg`);
    expect(isGameBackdrop('survivor-hilltop')).toBe(true);
    expect(isGameBackdrop('scene')).toBe(false);
  });

  it('match a side: the hilltop for survivors, the spawned Hunter for infected (the ghost shot has a smeared band)', () => {
    expect(SIDE_BACKDROP).toEqual({ survivor: 'survivor-hilltop', infected: 'infected-hunter' });
  });

  it('draws a flat dark fill until the shot loads, then the shot, and says when it has', () => {
    vi.stubGlobal('Image', FakeImage);
    const loaded = vi.fn();
    const a = recorder();
    drawBackdrop(a.ctx, 960, 540, 'infected-hunter', null, null, loaded);
    expect(a.calls.some(([k]) => k === 'drawImage')).toBe(false);
    expect(a.calls.some(([k]) => k === 'fillRect')).toBe(true);
    expect(FakeImage.made).toHaveLength(1);
    expect(FakeImage.made[0]!.src).toBe('/hud-backdrops/infected-hunter.jpg');

    FakeImage.made[0]!.onload!();
    expect(loaded).toHaveBeenCalledTimes(1);
    const b = recorder();
    drawBackdrop(b.ctx, 960, 540, 'infected-hunter', null, null);
    const draw = b.calls.find(([k]) => k === 'drawImage');
    expect(draw?.[1]).toEqual([FakeImage.made[0], 0, 0, 960, 540]);
    // Loaded once, whatever asks for it next.
    expect(FakeImage.made).toHaveLength(1);
  });

  it('covers a 4:3 canvas, cropping the sides as the game does', () => {
    vi.stubGlobal('Image', FakeImage);
    gameBackdropImage('survivor-hilltop');
    FakeImage.made[0]!.onload!();
    const r = recorder();
    drawBackdrop(r.ctx, 720, 540, 'survivor-hilltop', null, null);
    expect(r.calls.find(([k]) => k === 'drawImage')?.[1]).toEqual([FakeImage.made[0], -120, 0, 960, 540]);
  });

  it('loadGameBackdrop resolves once the shot is in, and null when it cannot load', async () => {
    vi.stubGlobal('Image', FakeImage);
    const p = loadGameBackdrop('survivor-subway');
    FakeImage.made[0]!.onload!();
    expect(await p).toBe(FakeImage.made[0]);
    expect(await loadGameBackdrop('survivor-subway')).toBe(FakeImage.made[0]);

    const q = loadGameBackdrop('infected-ghost');
    FakeImage.made[1]!.onerror!();
    expect(await q).toBeNull();
    expect(gameBackdropImage('infected-ghost')).toBeNull();
  });
});
