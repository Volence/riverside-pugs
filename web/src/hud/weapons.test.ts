import { describe, it, expect, beforeEach } from 'vitest';
import { weaponSlots, drawWeapons, WEAPON_SAMPLE, BOX_ALPHA } from './weapons';
import { _setImageFactory, _setCanvasFactory, _resetAssetCache } from './render';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { artUrl } from './art';
import { screenW } from './units';

const design = (patch: Partial<HudDesign> = {}): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...patch });
/** One 640-wide unit of the game's box code (ScreenWidth / 640), in HUD units at 16:9. */
const U = screenW('16:9') / 640;
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
const nearBox = (r: { x: number; y: number; w: number; h: number }, x: number, y: number, w: number, h: number) => {
  near(r.x, x); near(r.y, y); near(r.w, w); near(r.h, h);
};

/** A recording 2D context, as render.test.ts has: every call snapshots font, fill, alignment and alpha. */
function recCtx() {
  const calls: { m: string; a: unknown[]; font: string; fill: string; align: string; alpha: number; op: string }[] = [];
  const stack: number[] = [];
  const noop = (m: string) => (...a: unknown[]) => {
    calls.push({ m, a, font: ctx.font, fill: ctx.fillStyle, align: ctx.textAlign, alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation });
  };
  const ctx = {
    canvas: { width: 853, height: 480 },
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
    globalCompositeOperation: 'source-over',
    save: (...a: unknown[]) => { stack.push(ctx.globalAlpha); noop('save')(...a); },
    restore: (...a: unknown[]) => { ctx.globalAlpha = stack.pop() ?? 1; noop('restore')(...a); },
    beginPath: noop('beginPath'), rect: noop('rect'), clip: noop('clip'),
    fillRect: noop('fillRect'), strokeRect: noop('strokeRect'), fillText: noop('fillText'), drawImage: noop('drawImage'),
    measureText: () => ({ width: 10 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** Images that are loaded the moment they are made, at the size the art really is. */
const SIZES: Record<string, [number, number]> = {};
const instantImage = (url: string) => {
  const [w, h] = SIZES[url] ?? [64, 64];
  return { src: url, complete: true, naturalWidth: w, naturalHeight: h, onload: null, onerror: null } as unknown as HTMLImageElement;
};

beforeEach(() => {
  _resetAssetCache();
  _setImageFactory(instantImage);
  SIZES[artUrl('icon/equip/pumpshotgun')!] = [192, 64];
  SIZES[artUrl('vgui/hud/scalablepanel_bgmidgrey')!] = [128, 128];
  SIZES[artUrl('vgui/hud/scalablepanel_bgmidgrey_glow')!] = [128, 128];
});

describe('weaponSlots', () => {
  // Stock HudWeaponSelection at 16:9: wide 100, PrimaryWeaponsYPos 10, PrimaryWeaponBoxWide/Tall 53 x 24,
  // PrimaryWeaponTall 20, PrimaryWeaponAmmoX 38, ReserveAmmoYPos 5, PistolBoxWide/Tall 53 x 24,
  // RightSideIndent 10, IconSize 24. The primary slot is the active one, drawn 1.2 times its size.
  const slots = weaponSlots(design(), '16:9', 100);

  it('lays out the five slots top down, the active primary grown left by a fifth', () => {
    expect(slots.map((s) => s.kind)).toEqual(['primary', 'pistol', 'item', 'item', 'item']);
    expect(slots.map((s) => s.active)).toEqual([true, false, false, false, false]);
    nearBox(slots[0].box, 100 - 53 - 10 - 53 * 0.2, 10, 53 * 1.2, 24 * 1.2);
    const y1 = 10 + 24 * 1.2 + 2 * U;                   // each slot starts two 640-units below the last
    nearBox(slots[1].box, 100 - 53 - 10, y1, 53, 24);
    const y2 = y1 + 24 + 2 * U;
    for (const [i, s] of slots.slice(2).entries()) nearBox(s.box, 100 - 24 - 10, y2 + i * (24 + 2 * U), 24, 24);
  });

  it('frames each box with the game art, grown by its pad, the active one glowing', () => {
    expect(slots[0].art).toBe('vgui/hud/scalablepanel_bgmidgrey_glow');
    for (const s of slots.slice(1)) expect(s.art).toBe('vgui/hud/scalablepanel_bgmidgrey');
    const b0 = slots[0].box;
    nearBox(slots[0].frame, b0.x - 4 * U, b0.y - 4 * U, b0.w + 8 * U, b0.h + 8 * U);
    near(slots[0].corner, 8 * U);
    const b1 = slots[1].box;
    nearBox(slots[1].frame, b1.x - 2 * U, b1.y - 2 * U, b1.w + 4 * U, b1.h + 4 * U);
    near(slots[1].corner, 4 * U);
  });

  it('places the icons: the shotgun as wide as its cell allows, centred on the box top; the rest square', () => {
    const shotgun = slots[0].icon;
    expect(shotgun.name).toBe('icon/equip/pumpshotgun');
    nearBox(shotgun, 100 - 72 - 10, 10 - 12, 72, 24);   // 20 tall, times 1.2, and three times as wide
    expect(slots[1].icon.name).toBe('icon/equip/dualpistols');
    nearBox(slots[1].icon, 100 - 10 - 24 - U, slots[1].box.y, 24, 24);
    expect(slots.slice(2).map((s) => s.icon.name)).toEqual(['icon/equip/molotov', 'icon/equip/medkit', 'icon/equip/pills']);
    for (const s of slots.slice(2)) nearBox(s.icon, s.box.x, s.box.y, s.box.w, s.box.h);
  });

  it('dims the empty slot with InactiveItemColor and nothing else', () => {
    expect(slots.map((s) => s.icon.tint)).toEqual([null, null, null, '90 90 90 255', null]);
  });

  it('writes the ammo where the game does, in its fonts and colours', () => {
    const [clip, reserve] = slots[0].texts;
    expect(clip).toMatchObject({ text: '5', font: 'HudAmmoLarge', colour: null, align: 'right' });
    near(clip.x, 100 - 38 - 5 - U);
    near(clip.y, 10 + (24 * 1.2 - 24) / 2);              // centred in the box on the font's tall
    expect(reserve).toMatchObject({ text: '105', font: 'HudAmmo', colour: '128 128 128 255', align: 'left' });
    near(reserve.x, 100 - 38 + U - 3);
    near(reserve.y, clip.y + 5);
    const [pistol] = slots[1].texts;
    expect(pistol).toMatchObject({ text: '20', font: 'HudAmmo', colour: null, align: 'right' });
    near(pistol.x, slots[1].icon.x - 2 * U);
    near(pistol.y, slots[1].box.y + (24 - 18) / 2);
    for (const s of slots.slice(2)) expect(s.texts).toEqual([]);
  });

  it('reads the preset: Modern squares its items at IconSize 20', () => {
    const modern = weaponSlots(design({ preset: 'modern' }), '16:9', 100);
    expect(modern).toHaveLength(5);
    for (const s of modern.slice(2)) { near(s.box.w, 20); near(s.box.x, 100 - 20 - 10); }
  });

  it('sizes the pads by the screen width, as the game does: one unit at 4:3', () => {
    const narrow = weaponSlots(design(), '4:3', 100);
    near(narrow[1].box.y, 10 + 24 * 1.2 + 2);
    near(narrow[0].corner, 8);
  });

  it('keeps the sample loadout fixed', () => {
    expect(WEAPON_SAMPLE).toEqual({ clip: '5', reserve: '105', pistolClip: '20' });
  });
});

describe('drawWeapons', () => {
  const k = 2;
  const origin = { x: 1000, y: 300 };
  const slots = weaponSlots(design(), '16:9', 100);
  const at = (r: { x: number; y: number; w: number; h: number }) => [origin.x + r.x * k, origin.y + r.y * k, r.w * k, r.h * k];

  function draw() {
    const { ctx, calls } = recCtx();
    drawWeapons(ctx, design(), origin, k, 100);
    return calls;
  }

  it('draws each box nine-sliced from the game art, its 16-texel corners kept square', () => {
    const calls = draw();
    const glow = artUrl('vgui/hud/scalablepanel_bgmidgrey_glow')!;
    const pieces = calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === glow);
    expect(pieces).toHaveLength(9);
    const [fx, fy, fw, fh] = at(slots[0].frame);
    const c = slots[0].corner * k;
    // The top-left corner: texels 0..16 of 128 onto a corner square at the frame's corner.
    expect(pieces[0].a.slice(1)).toEqual([0, 0, 16, 16, fx, fy, c, c]);
    // The bottom-right corner, and the centre stretched to what is left.
    expect(pieces[8].a.slice(1)).toEqual([112, 112, 16, 16, fx + fw - c, fy + fh - c, c, c]);
    expect(pieces[4].a.slice(1)).toEqual([16, 16, 96, 96, fx + c, fy + c, fw - 2 * c, fh - 2 * c]);
    for (const p of pieces) near(p.alpha, BOX_ALPHA);
    const grey = artUrl('vgui/hud/scalablepanel_bgmidgrey')!;
    expect(calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === grey)).toHaveLength(9 * 4);
  });

  it('draws every icon over its box, in the order the game does', () => {
    const calls = draw();
    const icons = calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src?.includes('icon-equip'));
    expect(icons).toHaveLength(5);
    expect(icons.map((c) => (c.a[0] as HTMLImageElement).src)).toEqual(slots.map((s) => artUrl(s.icon.name)));
    for (const [i, s] of slots.entries()) {
      if (s.icon.tint) continue;                         // the dimmed one is drawn from a tinted copy, below
      expect(icons[i].a.slice(1)).toEqual(at(s.icon));
    }
  });

  it('tints the empty slot by InactiveItemColor, as an ImagePanel drawColor is', () => {
    const scratch = recCtx();
    const made: HTMLCanvasElement[] = [];
    _setCanvasFactory((w, h) => {
      const c = { width: w, height: h, getContext: () => scratch.ctx } as unknown as HTMLCanvasElement;
      made.push(c);
      return c;
    });
    try {
      const calls = draw();
      expect(made).toHaveLength(1);
      expect(scratch.calls.find((c) => c.m === 'fillRect' && c.op === 'multiply')?.fill).toBe('rgb(90,90,90)');
      expect(calls.some((c) => c.m === 'drawImage' && c.a[0] === made[0] && JSON.stringify(c.a.slice(1)) === JSON.stringify(at(slots[3].icon)))).toBe(true);
    } finally { _setCanvasFactory(null); }
  });

  it('writes the numbers at their font sizes, aligned as the game measures them', () => {
    const calls = draw().filter((c) => c.m === 'fillText');
    expect(calls.map((c) => c.a[0])).toEqual(['5', '105', '20']);
    const [clip, reserve, pistol] = calls;
    expect(clip.font).toMatch(new RegExp(`^bold ${24 * k}px `));
    expect(clip.align).toBe('right');
    expect(clip.a.slice(1)).toEqual([origin.x + slots[0].texts[0].x * k, origin.y + (slots[0].texts[0].y + 12) * k]);
    expect(clip.fill).toBe('rgba(255,255,255,1)');
    expect(reserve.font).toMatch(new RegExp(`^bold ${18 * k}px `));
    expect(reserve.align).toBe('left');
    expect(reserve.fill).toBe('rgba(128,128,128,1)');
    expect(pistol.a.slice(1)).toEqual([origin.x + slots[1].texts[0].x * k, origin.y + (slots[1].texts[0].y + 9) * k]);
  });

  it('draws nothing while the art loads, and asks for a redraw', () => {
    const pending: HTMLImageElement[] = [];
    _setImageFactory((url) => {
      const img = { src: url, complete: false, naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null } as unknown as HTMLImageElement;
      pending.push(img);
      return img;
    });
    const { ctx, calls } = recCtx();
    let redraws = 0;
    drawWeapons(ctx, design(), origin, k, 100, () => { redraws++; });
    expect(calls.filter((c) => c.m === 'drawImage')).toHaveLength(0);
    pending[0].onload!();
    expect(redraws).toBe(1);
  });
});
