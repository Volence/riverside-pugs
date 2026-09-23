import { describe, it, expect, beforeEach } from 'vitest';
import { weaponSlots, drawWeapons, WEAPON_SAMPLE, BOX_ALPHA } from './weapons';
import { _setImageFactory, _setCanvasFactory, _resetAssetCache } from './render';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { artUrl } from './art';
import { screenW } from './units';
import { canvasFont, fontCell } from './fonts';

const design = (patch: Partial<HudDesign> = {}): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...patch });
/** One 640-wide unit of the game's box code (ScreenWidth / 640), in HUD units at 16:9. */
const U = screenW('16:9') / 640;
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
const nearBox = (r: { x: number; y: number; w: number; h: number }, x: number, y: number, w: number, h: number) => {
  near(r.x, x); near(r.y, y); near(r.w, w); near(r.h, h);
};

/** A recording 2D context, as render.test.ts has: every call snapshots font, fill, alignment and alpha. */
function recCtx() {
  const calls: { m: string; a: unknown[]; font: string; fill: string; align: string; alpha: number; op: string; baseline: string }[] = [];
  const stack: number[] = [];
  const noop = (m: string) => (...a: unknown[]) => {
    calls.push({ m, a, font: ctx.font, fill: ctx.fillStyle, align: ctx.textAlign, alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation, baseline: ctx.textBaseline });
  };
  const ctx = {
    canvas: { width: 853, height: 480 },
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
    globalCompositeOperation: 'source-over',
    save: (...a: unknown[]) => { stack.push(ctx.globalAlpha); noop('save')(...a); },
    restore: (...a: unknown[]) => { ctx.globalAlpha = stack.pop() ?? 1; noop('restore')(...a); },
    beginPath: noop('beginPath'), rect: noop('rect'), clip: noop('clip'), roundRect: noop('roundRect'), fill: noop('fill'),
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

describe('the slot being held', () => {
  // The owner's Ammo only screenshots, 2026-09-23: switching from the gun to the
  // pistol moved the gun's clip about 5 units right and its reserve about 3, and
  // the pistol's number about 1 right and half a unit up, as its box grew.
  it('draws the gun at its own size, its numbers without the held nudge, when the pistol is held', () => {
    const slots = weaponSlots(design(), '16:9', 100, 'pistol');
    expect(slots.map((s) => s.active)).toEqual([false, true, false, false, false]);
    nearBox(slots[0].box, 100 - 53 - 10, 10, 53, 24);
    const [clip, reserve] = slots[0].texts;
    near(clip.x, 100 - 38 - U);
    near(reserve.x, 100 - 38 + U);
    near(clip.y, 10);
    const y1 = 10 + 24 + 2 * U;
    nearBox(slots[1].box, 100 - 53 - 10 - 53 * 0.2, y1, 53 * 1.2, 24 * 1.2);
    near(slots[1].icon.x, 100 - 10 - 24 * 1.2 - U);
    near(slots[1].texts[0].y, y1 + (24 * 1.2 - 18) / 2);
  });

  it('grows the first item when an item is held, and holds nothing visible when there are no item slots', () => {
    const slots = weaponSlots(design(), '16:9', 100, 'item');
    expect(slots.map((s) => s.active)).toEqual([false, false, true, false, false]);
    expect(slots[2].box.w).toBeCloseTo(24 * 1.2, 6);
    const none = weaponSlots(design({ weapons: { itemSize: 0 } }), '16:9', 100, 'item');
    expect(none.map((s) => s.active)).toEqual([false, false]);
  });

  it('holds the gun by default', () => {
    expect(weaponSlots(design(), '16:9', 100)).toEqual(weaponSlots(design(), '16:9', 100, 'primary'));
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
    // HudAmmoLarge and HudAmmo are Trade Gothic Bold, 24 and 18 tall, weight
    // 0: drawn in that face, sized from its VDMX by the cell in pixels, each
    // from the top of its cell, so the baseline is the ascent below it.
    const large = fontCell('Trade Gothic Bold', 24 * k), small = fontCell('Trade Gothic Bold', 18 * k);
    expect(clip.font).toBe(canvasFont('Trade Gothic Bold', 0, 24 * k));
    expect(clip.baseline).toBe('alphabetic');
    expect(clip.align).toBe('right');
    expect(clip.a.slice(1)).toEqual([origin.x + slots[0].texts[0].x * k, origin.y + slots[0].texts[0].y * k + large.ascent]);
    expect(clip.fill).toBe('rgba(255,255,255,1)');
    expect(reserve.font).toBe(canvasFont('Trade Gothic Bold', 0, 18 * k));
    expect(reserve.align).toBe('left');
    expect(reserve.fill).toBe('rgba(128,128,128,1)');
    expect(reserve.a.slice(1)).toEqual([origin.x + slots[0].texts[1].x * k, origin.y + slots[0].texts[1].y * k + small.ascent]);
    expect(pistol.a.slice(1)).toEqual([origin.x + slots[1].texts[0].x * k, origin.y + slots[1].texts[0].y * k + small.ascent]);
  });

  it('adds the numbers onto the scene, as the game draws its additive fonts', () => {
    // HudAmmoLarge and HudAmmo both say "additive" "1" in clientscheme.res: the
    // game adds each glyph's colour to what is behind it, so a grey reserve on
    // a mid-brown wall shows lighter than a plain blend would draw it. The
    // canvas's 'lighter' composite is that same addition.
    const calls = draw().filter((c) => c.m === 'fillText');
    expect(calls.map((c) => c.op)).toEqual(['lighter', 'lighter', 'lighter']);
  });

  it('draws nothing while the art loads, and asks for a redraw', () => {
    const pending: (HTMLImageElement & { onload: (() => void) | null })[] = [];
    _setImageFactory((url) => {
      const img = { src: url, complete: false, naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null } as unknown as HTMLImageElement & { onload: (() => void) | null };
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

describe('the weapon edits in the preview', () => {
  const k = 2;
  const origin = { x: 1000, y: 300 };
  const at = (r: { x: number; y: number; w: number; h: number }) => [origin.x + r.x * k, origin.y + r.y * k, r.w * k, r.h * k];
  const drawn = (d: HudDesign) => { const { ctx, calls } = recCtx(); drawWeapons(ctx, d, origin, k, 100); return calls; };
  const boxArt = (calls: ReturnType<typeof recCtx>['calls']) => calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src?.includes('scalablepanel'));
  const iconArt = (calls: ReturnType<typeof recCtx>['calls']) => calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src?.includes('icon-equip'));

  it('reads the box art from mod_textures.txt, drawing nothing for a Hidden box', () => {
    const d = design({ weapons: { boxActive: { kind: 'hidden' } } });
    const slots = weaponSlots(d, '16:9', 100);
    expect(slots.map((s) => s.art)).toEqual([null, ...Array(4).fill('vgui/hud/scalablepanel_bgmidgrey')]);
    const calls = drawn(d);
    expect(boxArt(calls)).toHaveLength(9 * 4);          // only the four inactive boxes, nine pieces each
    expect(calls.some((c) => c.m === 'fillRect' || c.m === 'roundRect')).toBe(false);
  });

  it('draws a flat box as its colour over the frame, at the alpha the game draws every box at', () => {
    const d = design({ weapons: { boxInactive: { kind: 'flat', color: '10 20 30 255' } } });
    const slots = weaponSlots(d, '16:9', 100);
    expect(slots[1].fill).toEqual({ color: '10 20 30 255', rounded: false });
    const calls = drawn(d);
    expect(boxArt(calls)).toHaveLength(9);              // the active box keeps the game art
    const fills = calls.filter((c) => c.m === 'fillRect');
    expect(fills.map((c) => c.a)).toEqual(slots.slice(1).map((s) => at(s.frame)));
    for (const f of fills) { expect(f.fill).toBe('rgba(10,20,30,1)'); near(f.alpha, BOX_ALPHA); }
  });

  it('draws a rounded box with its corners round by one corner of the art, in the default colour when none is set', () => {
    const d = design({ weapons: { boxActive: { kind: 'rounded' } } });
    const slots = weaponSlots(d, '16:9', 100);
    expect(slots[0].fill).toEqual({ color: '40 40 40 215', rounded: true });
    const round = drawn(d).filter((c) => c.m === 'roundRect');
    expect(round).toHaveLength(1);
    expect(round[0].a).toEqual([...at(slots[0].frame), slots[0].corner * k]);
  });

  it('draws no gun or pistol picture with the weapon icons off, and no item pictures with the item icons off', () => {
    const guns = weaponSlots(design({ weapons: { weaponIcons: false } }), '16:9', 100);
    expect(guns.map((s) => !!s.icon.hidden)).toEqual([true, true, false, false, false]);
    expect(iconArt(drawn(design({ weapons: { weaponIcons: false } })))).toHaveLength(3);
    const items = weaponSlots(design({ weapons: { itemIcons: false } }), '16:9', 100);
    expect(items.map((s) => !!s.icon.hidden)).toEqual([false, false, true, true, true]);
    expect(iconArt(drawn(design({ weapons: { itemIcons: false } })))).toHaveLength(2);
  });

  it('draws no item slots at IconSize 0, box or picture, as the game does', () => {
    const d = design({ weapons: { itemSize: 0 } });
    expect(weaponSlots(d, '16:9', 100).map((s) => s.kind)).toEqual(['primary', 'pistol']);
    expect(boxArt(drawn(d))).toHaveLength(9 * 2);
  });

  it('draws the numbers at the sizes the player chose', () => {
    const d = design({ weapons: { clipFont: 30, pistolFont: 12 } });
    const [primary, pistol] = weaponSlots(d, '16:9', 100);
    expect(primary.texts.map((t) => t.font)).toEqual(['HudEd_HudAmmoLarge_t30', 'HudEd_HudAmmo_t12']);
    expect(pistol.texts[0].font).toBe('HudEd_HudAmmo_t12');
    const text = drawn(d).filter((c) => c.m === 'fillText');
    expect(text.map((c) => c.font)).toEqual([30, 12, 12].map((t) => canvasFont('Trade Gothic Bold', 0, t * k)));
  });
});
