/**
 * The missing-art path, in its own file because it mocks ./art for the whole
 * module: one material a drawn child names (the stock scratch overlay on the
 * player's own health bar) is made to be absent from the index, so the
 * renderer has to hatch that child's rect and warn about it once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const GONE = 'vgui/hud/detail_scratches_top_1';
// An item icon too, as if the font glyph could not be exported: the Items row falls back to its stand-ins.
const GONE_ICON = 'icon/item/pills';
vi.mock('./art', async (importOriginal) => {
  const real = await importOriginal<typeof import('./art')>();
  return { ...real, artUrl: (m: string) => (m === GONE || m === GONE_ICON ? undefined : real.artUrl(m)) };
});

import { childRects, drawPanel, _setImageFactory, _resetAssetCache } from './render';
import { DEFAULT_DESIGN } from './design';

function recCtx() {
  const calls: { m: string; a: unknown[] }[] = [];
  const noop = (m: string) => (...a: unknown[]) => { calls.push({ m, a }); };
  const ctx = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
    save: noop('save'), restore: noop('restore'), beginPath: noop('beginPath'), rect: noop('rect'), clip: noop('clip'),
    fillRect: noop('fillRect'), strokeRect: noop('strokeRect'), fillText: noop('fillText'), drawImage: noop('drawImage'),
    setLineDash: noop('setLineDash'), moveTo: noop('moveTo'), lineTo: noop('lineTo'), stroke: noop('stroke'), fill: noop('fill'),
    arc: noop('arc'), closePath: noop('closePath'), measureText: () => ({ width: 10 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const instantImage = (url: string) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement;

describe('a material the index lacks', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { _resetAssetCache(); _setImageFactory(instantImage); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('hatches the child where the file puts it and warns once across draws', () => {
    const d = structuredClone(DEFAULT_DESIGN);
    const r = childRects(d, 'ownHealth', { x: 5, y: 7 }, 2).find((c) => c.name === 'HealthbarTextureTop')!;
    for (let i = 0; i < 2; i++) {
      const { ctx, calls } = recCtx();
      expect(() => drawPanel(ctx, d, 'ownHealth', { x: 5, y: 7 }, 2)).not.toThrow();
      expect(calls.filter((c) => c.m === 'strokeRect').map((c) => c.a)).toContainEqual([r.x, r.y, r.w, r.h]);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(GONE);
  });

  it('draws the stand-in item icons when an icon is not in the index, warning once across draws', () => {
    const d = { ...structuredClone(DEFAULT_DESIGN), elements: {} };
    const r = childRects(d, 'teamColumn', { x: 0, y: 0 }, 1).find((c) => c.name === 'Items')!;
    for (let i = 0; i < 2; i++) {
      const { ctx, calls } = recCtx();
      expect(() => drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 })).not.toThrow();
      // Stock's L4D_Icons_medium is 18 tall, centred on the 14-tall label.
      expect(calls.filter((c) => c.m === 'strokeRect').map((c) => c.a)).toContainEqual([r.x, r.y + (r.h - 18) / 2, 18, 18]);
      expect(calls.some((c) => c.m === 'drawImage' && /icon-item-/.test((c.a[0] as HTMLImageElement).src))).toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('item icon');
  });
});
