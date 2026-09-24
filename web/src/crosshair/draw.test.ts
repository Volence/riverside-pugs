import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  drawBackdrop, gameBackdropImage, loadGameBackdrop, resetGameBackdrops, GAME_BACKDROPS, SIDE_BACKDROP, isGameBackdrop,
  CROSSHAIR_BACKDROP, DEFAULT_STATE,
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

describe('the crosshair backdrop', () => {
  it('defaults to the forest shot, for the maker and the community cards alike', () => {
    expect(CROSSHAIR_BACKDROP).toBe('survivor-hilltop');
    expect(DEFAULT_STATE.backdrop).toBe(CROSSHAIR_BACKDROP);
  });

  it('with a scale, draws a game shot at its own pixels on that screen, centred, so the crosshair and the shot agree on size', () => {
    vi.stubGlobal('Image', FakeImage);
    gameBackdropImage('survivor-hilltop');
    FakeImage.made[0]!.onload!();
    const r = recorder();
    drawBackdrop(r.ctx, 960, 540, 'survivor-hilltop', null, null, undefined, 1);
    expect(r.calls.find(([k]) => k === 'drawImage')?.[1]).toEqual([FakeImage.made[0], -480, -270, 1920, 1080]);
    // 1.5 screen pixels per 1080p pixel: a 96 square shows the middle 64 x 64 of the shot.
    const c = recorder();
    drawBackdrop(c.ctx, 96, 96, 'survivor-hilltop', null, null, undefined, 1.5);
    expect(c.calls.find(([k]) => k === 'drawImage')?.[1]).toEqual([FakeImage.made[0], -1392, -762, 2880, 1620]);
  });

  it('never leaves the canvas uncovered: a small scale falls back to covering it', () => {
    vi.stubGlobal('Image', FakeImage);
    gameBackdropImage('survivor-subway');
    FakeImage.made[0]!.onload!();
    const r = recorder();
    drawBackdrop(r.ctx, 960, 540, 'survivor-subway', null, null, undefined, 0.25);
    expect(r.calls.find(([k]) => k === 'drawImage')?.[1]).toEqual([FakeImage.made[0], 0, 0, 960, 540]);
  });

  it('with a scale, takes a screenshot as one of that screen: 1440 lines at 2560 x 1440 are 1:1', () => {
    const img = {} as CanvasImageSource;
    const r = recorder();
    drawBackdrop(r.ctx, 1000, 500, 'shot', img, { w: 2560, h: 1440 }, undefined, 4 / 3);
    expect(r.calls.find(([k]) => k === 'drawImage')?.[1]).toEqual([img, -780, -470, 2560, 1440]);
  });
});
