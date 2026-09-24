// @vitest-environment node
// CompressionStream is a Node and browser global; happy-dom does not provide it.
import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_DESIGN, validateDesign, newDesign, usableCrosshair, encodeShare, decodeShare, safeName, clampOverride, clampChild, baseTeam, validKeys } from './design';
import type { KeyDef } from './children';
import { _setProbe } from './probes';
import { DEFAULT_STATE } from '../crosshair/draw';
import { PNG_PREFIX, type CrosshairArt } from '../crosshair/model';

/** A crosshair saved on the Crosshair page, and one a design carries. */
const SAVED: CrosshairArt = { kind: 'built', state: { ...DEFAULT_STATE, shape: 'dot', dot: 3 } };
const OWN: CrosshairArt = { kind: 'image', png: PNG_PREFIX + 'AAAA', w: 64, h: 64 };

describe('validateDesign', () => {
  it('returns the defaults for junk', () => {
    expect(validateDesign(null)).toEqual(DEFAULT_DESIGN);
    expect(validateDesign('x')).toEqual(DEFAULT_DESIGN);
    expect(validateDesign({ v: 99 })).toEqual(DEFAULT_DESIGN);
  });

  it('clamps numbers and drops unknown keys', () => {
    const d = validateDesign({
      v: 1, preset: 'modern', evil: 1,
      elements: { teamColumn: { x: 99999, y: -99999, scale: 50, junk: true, dir: 'column', spacing: 9999 } },
    });
    expect(d.preset).toBe('modern');
    expect((d as unknown as Record<string, unknown>).evil).toBeUndefined();
    // spacing 9999 is first held to its old cap (400), then becomes the gap that keeps that pitch:
    // 400 / scale 2 - Modern's 34-unit column card = 166.
    expect(d.elements.teamColumn).toEqual({ x: 1000, y: -200, scale: 2, dir: 'column', gap: 166 });
  });

  it('rejects colours that are not four bytes', () => {
    const d = validateDesign({ v: 1, elements: { chat: { color: '255 0 0 255', bg: '999 0 0 0' } } });
    expect(d.elements.chat).toEqual({ color: '255 0 0 255' });
  });

  it('drops oversize images', () => {
    const d = validateDesign({ v: 1, images: {
      panelBg: { w: 64, h: 64, png: 'AAAA' },
      incapPanel: { w: 4096, h: 64, png: 'AAAA' },
      deadPanel: { w: 64, h: 64, png: 'A'.repeat(1_500_000) },
    } });
    expect(Object.keys(d.images)).toEqual(['panelBg']);
  });

  it('drops styles and images for slots the editor no longer has', () => {
    const d = validateDesign({ v: 1,
      styles: { barGreen: { kind: 'flat' }, barWhite: { kind: 'flat' }, panelBg: { kind: 'flat' } },
      images: { barRed: { w: 8, h: 8, png: 'AAAA' } } });
    expect(Object.keys(d.styles)).toEqual(['panelBg']);
    expect(d.images).toEqual({});
  });

  it('drops overrides for elements the editor no longer has', () => {
    const d = validateDesign({ v: 1, elements: { killFeed: { visible: false }, chat: { x: 5 } } });
    expect(d.elements).toEqual({ chat: { x: 5 } });
  });

  // Owner in-game evidence 2026-09-23: aimed at and revived a downed
  // teammate, nothing ever drew near the crosshair. TargetIDLabel is an empty
  // label L4D1 never fills, so targetId is gone from the registry, and a
  // design saved before that (or a hand-edited one) loads with the override
  // dropped, same as any other id the editor no longer has.
  it('drops a saved targetId override, the element removed as dead weight', () => {
    const d = validateDesign({ v: 1, elements: { targetId: { visible: false, x: 5 }, chat: { x: 5 } } });
    expect(d.elements).toEqual({ chat: { x: 5 } });
  });

  it('reads the crosshair choice, migrating the old xhair boolean', () => {
    for (const c of ['bundle', 'addon', 'none'] as const) {
      expect(validateDesign({ v: 1, crosshair: c }).crosshair).toBe(c);
      expect(validateDesign({ v: 1, crosshair: c, xhair: c === 'none' }).crosshair, 'crosshair wins over xhair').toBe(c);
    }
    // A design saved before the choice existed keeps writing xHair, as it did.
    expect(validateDesign({ v: 1, xhair: true }).crosshair).toBe('addon');
    expect(validateDesign({ v: 1 }).crosshair).toBe('addon');
    expect(validateDesign({ v: 1, xhair: false }).crosshair).toBe('none');
    expect(validateDesign({ v: 1, crosshair: 'laser', xhair: false }).crosshair).toBe('none');
    expect(validateDesign({ v: 1, crosshair: 'laser' }).crosshair).toBe('addon');
    // One source of truth: the old boolean is read, never kept.
    expect('xhair' in validateDesign({ v: 1, xhair: true })).toBe(false);
    expect('xhair' in DEFAULT_DESIGN).toBe(false);
  });

  it('starts a new design carrying the crosshair saved on the Crosshair page when there is one, else with none', () => {
    expect(DEFAULT_DESIGN.crosshair).toBe('none');
    expect('xhairArt' in DEFAULT_DESIGN).toBe(false);
    expect(newDesign(SAVED)).toEqual({ ...DEFAULT_DESIGN, crosshair: 'bundle', xhairArt: SAVED });
    expect(newDesign(null)).toEqual(DEFAULT_DESIGN);
    expect(newDesign(null)).not.toBe(DEFAULT_DESIGN);
    // A copy: editing the design's crosshair never reaches the saved one.
    expect(newDesign(SAVED).xhairArt).not.toBe(SAVED);
  });

  it('gives a bundle with no crosshair of its own the saved one, once, or else makes it none', () => {
    const bare = { ...DEFAULT_DESIGN, crosshair: 'bundle' as const };
    expect(usableCrosshair(bare, SAVED)).toEqual({ ...bare, xhairArt: SAVED });
    expect(usableCrosshair(bare, null)).toEqual({ ...bare, crosshair: 'none' });
    // Its own crosshair wins over whatever is saved.
    const own = { ...bare, xhairArt: OWN };
    expect(usableCrosshair(own, SAVED)).toBe(own);
    expect(usableCrosshair(own, null)).toBe(own);
    for (const c of ['addon', 'none'] as const) {
      const d = { ...DEFAULT_DESIGN, crosshair: c };
      expect(usableCrosshair(d, SAVED)).toBe(d);
      expect(usableCrosshair(d, null)).toBe(d);
    }
  });

  it("keeps a valid crosshair and drops one the builder or an upload could not have made", () => {
    expect(validateDesign({ v: 1, crosshair: 'bundle', xhairArt: SAVED }).xhairArt).toEqual(SAVED);
    expect(validateDesign({ v: 1, crosshair: 'bundle', xhairArt: OWN }).xhairArt).toEqual(OWN);
    // Clamped to the builder's own slider range, like any other number.
    expect(validateDesign({ v: 1, xhairArt: { kind: 'built', state: { len: 500 } } }).xhairArt).toEqual({ kind: 'built', state: { ...DEFAULT_STATE, len: 30 } });
    for (const bad of [{ kind: 'built', state: { shape: 'image' } }, { ...OWN, w: 513 }, { ...OWN, png: 'data:text/html,hi' }, 'x']) {
      expect('xhairArt' in validateDesign({ v: 1, xhairArt: bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps hideGameCrosshair only when it is true', () => {
    expect(validateDesign({ v: 1, hideGameCrosshair: true }).hideGameCrosshair).toBe(true);
    expect('hideGameCrosshair' in validateDesign({ v: 1, hideGameCrosshair: 'yes' })).toBe(false);
    expect('hideGameCrosshair' in validateDesign({ v: 1 })).toBe(false);
  });
});

describe('baseTeam', () => {
  it('reads each preset card, direction and pitch from its own teamdisplayhud.res', () => {
    expect(baseTeam('stock')).toEqual({ dir: 'row', pitch: 140, card: { w: 150, h: 150 } });
    expect(baseTeam('modern')).toEqual({ dir: 'column', pitch: 34, card: { w: 120, h: 34 } });
  });
});

describe('validateDesign, the teammate layout', () => {
  const team = (preset: 'stock' | 'modern', o: Record<string, unknown>) =>
    validateDesign({ v: 1, preset, elements: { teamColumn: o } }).elements.teamColumn;

  it('migrates a saved spacing to the gap that keeps the same pitch', () => {
    // gap = spacing / scale - the unfitted card along the direction.
    expect(team('stock', { dir: 'column', spacing: 180 })).toEqual({ dir: 'column', gap: 30 });
    expect(team('modern', { spacing: 40 })).toEqual({ gap: 6 });                            // Modern's own column, card 34 tall
    expect(team('modern', { dir: 'row', spacing: 130 })).toEqual({ dir: 'row', gap: 10 });  // card 120 wide
    expect(team('modern', { dir: 'column', spacing: 45, scale: 1.25 })).toEqual({ dir: 'column', scale: 1.25, gap: 2 });
  });

  it('fits an old design whose unfitted cards overlapped, and keeps its pitch with the fitted card', () => {
    // Stock column at 40: the 150-tall card overlapped, the 36-tall fitted one leaves 4.
    expect(team('stock', { dir: 'column', spacing: 40 })).toEqual({ dir: 'column', fit: true, gap: 4 });
    // Stock's own row at 140: 150 wide overlapped, 121 fitted leaves 19.
    expect(team('stock', { dir: 'row', spacing: 140 })).toEqual({ dir: 'row', fit: true, gap: 19 });
    // Tighter than even the fitted card: fitted, then clamped at 0.
    expect(team('stock', { dir: 'column', spacing: 20 })).toEqual({ dir: 'column', fit: true, gap: 0 });
  });

  it('keeps the pitch of a saved spacing that was already fitted, and never overrides fit off', () => {
    expect(team('stock', { dir: 'column', fit: true, spacing: 60 })).toEqual({ dir: 'column', fit: true, gap: 24 });
    expect(team('stock', { dir: 'column', fit: false, spacing: 40 })).toEqual({ dir: 'column', fit: false, gap: 0 });
  });

  it('keeps a stored gap over a stale spacing, and clamps it to 0..200', () => {
    expect(team('stock', { gap: 12, spacing: 400 })).toEqual({ gap: 12 });
    expect(team('stock', { gap: 500 })).toEqual({ gap: 200 });
    expect(team('stock', { gap: -5 })).toEqual({ gap: 0 });
  });

  it('keeps the infected row spacing as it is, and never gives it a gap, fit or slots', () => {
    const d = validateDesign({ v: 1, elements: { infectedRow: { spacing: 124, gap: 5, fit: true, slots: [] } } });
    expect(d.elements.infectedRow).toEqual({ spacing: 124 });
  });

  it('leaves fit off when a saved design has none, while a new design starts fitted', () => {
    expect(validateDesign({ v: 1 }).elements).toEqual({});
    expect(validateDesign({ v: 1, elements: { chat: { x: 5 } } }).elements.teamColumn).toBeUndefined();
    expect(DEFAULT_DESIGN.elements.teamColumn).toEqual({ fit: true });
    expect(validateDesign(null).elements.teamColumn).toEqual({ fit: true });
    expect(team('stock', { fit: false })).toEqual({ fit: false });
    expect(team('stock', { fit: 'yes' })).toBeUndefined();
  });

  it('clamps slots like element positions, and drops any set that is not four finite points', () => {
    const four = [{ x: 5000, y: -900 }, { x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }];
    expect(team('stock', { dir: 'free', slots: four })).toEqual({
      dir: 'free', slots: [{ x: 1000, y: -200 }, { x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }],
    });
    expect(team('stock', { dir: 'free', slots: four.slice(0, 3) })).toBeUndefined();
    expect(team('stock', { slots: [...four.slice(0, 3), { x: NaN, y: 1 }] })).toBeUndefined();
    // Row with slots stored keeps them, so switching back to Free restores the cards.
    expect(team('stock', { dir: 'row', slots: four })!.slots).toHaveLength(4);
  });

  it('keeps Free only on the survivor team', () => {
    expect(validateDesign({ v: 1, elements: { chat: { dir: 'free' } } }).elements.chat).toBeUndefined();
  });
});

describe('clampOverride', () => {
  // The editor's number boxes call this directly so a typed value snaps to
  // the same cap validateDesign would clamp it to on load: the canvas and
  // the downloaded file must never disagree about what a value became.
  it('clamps to the same RANGES bounds validateDesign uses, and leaves an in-range value alone', () => {
    expect(clampOverride('spacing', 500)).toBe(400);
    expect(clampOverride('spacing', -50)).toBe(0);
    expect(clampOverride('spacing', 120)).toBe(120);
  });
});

describe('validateDesign, the teammate card children', () => {
  const kids = (raw: unknown) => validateDesign({ v: 1, children: raw }).children;

  it('keeps only registered panels, only registry children, and clamps their numbers', () => {
    // ownHealth is registered since Phase 2 (its own tests are under "children of every registered panel").
    expect(kids({ siHealth: { Head: { x: 1 } } })).toEqual({});
    expect(kids({ teamColumn: { Nope: { x: 1 }, Head: { x: 9999, y: -9999, junk: 1 } } }))
      .toEqual({ teamColumn: { Head: { x: 512, y: -64 } } });
  });

  it('drops each field the child does not offer', () => {
    const got = kids({ teamColumn: {
      Name: { color: '10 20 30 255', fontSize: 99, on: true },
      HealthNumber: { color: '10 20 30 255', on: true, fontSize: 14 },
      Head: { fontSize: 20, color: '1 2 3 4' },
      Items: { w: 90, h: 9, fontSize: 22, y: 20 },
      BackgroundImage: { x: 5, fontSize: 30, visible: false },
    } }).teamColumn;
    expect(got).toEqual({
      Name: { color: '10 20 30 255', fontSize: 64 },
      HealthNumber: { on: true, fontSize: 14 },
      Items: { fontSize: 22, y: 20 },
      BackgroundImage: { x: 5, visible: false },
    });
  });

  it('keeps a tint on the splatter, movable and free-sized like any wh piece, and drops one on the portrait', () => {
    const got = kids({ teamColumn: {
      BackgroundImage: { x: 5, y: 6, w: 90, h: 40, color: '10 20 30 255' },
      Head: { color: '10 20 30 255' },
    } }).teamColumn;
    expect(got).toEqual({ BackgroundImage: { x: 5, y: 6, w: 90, h: 40, color: '10 20 30 255' } });
  });

  it('stores square art with both sides equal, the smaller winning', () => {
    expect(kids({ teamColumn: { Head: { w: 30, h: 20 } } }).teamColumn!.Head).toEqual({ w: 20, h: 20 });
    expect(kids({ teamColumn: { Dead: { w: 30 } } }).teamColumn!.Dead).toEqual({ w: 30, h: 30 });
    expect(kids({ teamColumn: { Health: { w: 30, h: 5 } } }).teamColumn!.Health).toEqual({ w: 30, h: 5 });
  });

  it('starts a new design with no children', () => {
    expect(DEFAULT_DESIGN.children).toEqual({});
    expect(validateDesign({ v: 1 }).children).toEqual({});
  });
});

describe('clampChild', () => {
  it('clamps child numbers to their own ranges', () => {
    expect(clampChild('x', 9999)).toBe(512);
    expect(clampChild('y', -100)).toBe(-64);
    expect(clampChild('w', 0)).toBe(1);
    expect(clampChild('fontSize', 99)).toBe(64);
  });
});

describe('safeName', () => {
  it('keeps a file-safe subset and never returns empty', () => {
    expect(safeName('my "cool" hud!!')).toBe('my cool hud');
    expect(safeName('///')).toBe('my_hud');
  });
});

describe('share links', () => {
  it('round-trips a design without its images', async () => {
    const d = validateDesign({ v: 1, preset: 'modern', elements: { chat: { x: 134, y: 320 } },
      images: { panelBg: { w: 8, h: 8, png: 'AAAA' } } });
    const s = await encodeShare(d);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = await decodeShare(s);
    expect(back).toEqual({ ...d, images: {} });
  });

  it('returns null for a damaged link', async () => {
    expect(await decodeShare('not-a-design')).toBeNull();
  });

  it('carries the teammate card children through a share link', async () => {
    const d = validateDesign({ v: 1, children: { teamColumn: { HealthNumber: { on: true }, Items: { y: 20 } } } });
    expect((await decodeShare(await encodeShare(d)))!.children).toEqual(d.children);
  });

  it('carries the crosshair through a share link, built or image, so the link is the whole HUD', async () => {
    for (const art of [SAVED, OWN]) {
      const d = validateDesign({ v: 1, crosshair: 'bundle', xhairArt: art });
      expect((await decodeShare(await encodeShare(d)))!.xhairArt).toEqual(art);
    }
  });
});

describe('validateDesign, the weapon selection', () => {
  it('keeps each weapon key clamped to the range the generator writes, and drops junk', () => {
    const d = validateDesign({ v: 1, weapons: {
      primaryY: 999, indent: -999, primaryBoxW: 250, primaryBoxH: -5, pistolBoxW: 40, pistolBoxH: 12.4,
      iconTall: 20, itemSize: 0, ammoX: 48, reserveY: -3, clipFont: 2, pistolFont: 90,
      reserveColor: '255 0 255 255', inactiveColor: '0 255 0 999', evil: 1, weaponIcons: 'no', itemIcons: false,
    } });
    expect(d.weapons).toEqual({
      primaryY: 200, indent: -200, primaryBoxW: 200, primaryBoxH: 0, pistolBoxW: 40, pistolBoxH: 12.4,
      iconTall: 20, itemSize: 0, ammoX: 48, reserveY: -3, clipFont: 6, pistolFont: 64,
      reserveColor: '255 0 255 255', itemIcons: false,
    });
  });

  it('keeps the box styles it can write, a colour only where one draws, and nothing for stock', () => {
    const d = validateDesign({ v: 1, weapons: {
      boxActive: { kind: 'rounded', color: '10 20 30 200' }, boxInactive: { kind: 'hidden', color: '1 2 3 4' },
    } });
    expect(d.weapons).toEqual({ boxActive: { kind: 'rounded', color: '10 20 30 200' }, boxInactive: { kind: 'hidden' } });
    expect(validateDesign({ v: 1, weapons: { boxActive: { kind: 'stock' }, boxInactive: { kind: 'image' } } }).weapons).toBeUndefined();
  });

  it('leaves an untouched design without weapons, so its download is unchanged', () => {
    expect(validateDesign({ v: 1 }).weapons).toBeUndefined();
    expect(validateDesign({ v: 1, weapons: {} }).weapons).toBeUndefined();
    expect(DEFAULT_DESIGN.weapons).toBeUndefined();
  });

  // The old Advanced-only weaponBoxActive/Inactive slots overwrote the pak01 box
  // textures by name, which only an advanced (gameinfo.txt) install could do.
  // Their styles move to the new setting, which works from a normal addon.
  it('moves the old advanced weapon box styles to the new box setting, with their old default colours', () => {
    const d = validateDesign({ v: 1, advanced: true, styles: {
      weaponBoxActive: { kind: 'rounded', color: '9 9 9 99' }, weaponBoxInactive: { kind: 'flat' }, panelBg: { kind: 'flat' },
    } });
    expect(d.weapons).toEqual({ boxActive: { kind: 'rounded', color: '9 9 9 99' }, boxInactive: { kind: 'flat', color: '0 0 0 130' } });
    expect(Object.keys(d.styles)).toEqual(['panelBg']);
  });

  it('drops the old weapon box styles of a design not in advanced mode, which never shipped them', () => {
    const d = validateDesign({ v: 1, styles: { weaponBoxActive: { kind: 'flat' } }, images: { weaponBoxActive: { w: 1, h: 1, png: 'AAAA' } } });
    expect(d.weapons).toBeUndefined();
    expect(d.styles).toEqual({});
    expect(d.images).toEqual({});
  });

  it('prefers a new box setting over an old slot, and drops an old image style it cannot carry', () => {
    const d = validateDesign({ v: 1, advanced: true,
      styles: { weaponBoxActive: { kind: 'flat' }, weaponBoxInactive: { kind: 'image' } },
      weapons: { boxActive: { kind: 'hidden' } } });
    expect(d.weapons).toEqual({ boxActive: { kind: 'hidden' } });
  });

  it('carries the weapons through a share link', async () => {
    const d = { ...structuredClone(DEFAULT_DESIGN), weapons: { ammoX: 48, weaponIcons: false, boxActive: { kind: 'hidden' as const } } };
    expect((await decodeShare(await encodeShare(d)))?.weapons).toEqual(d.weapons);
  });
});

describe('splatters', () => {
  const PNG_OK = 'iVBORw0KGgo=';
  it('keeps valid splatter styles and drops what does not belong', () => {
    const d = validateDesign({ v: 1, splatters: {
      splatTeam: { kind: 'fade', color: '1 2 3 4', keepColours: true },   // keepColours is for the scratches only
      splatTop: { kind: 'image', keepColours: true },
      splatBottom: { kind: 'none' },
      nope: { kind: 'fade' },
    } });
    // A scratch's None loads as its child's hide (plan decision 4), below.
    expect(d.splatters).toEqual({
      splatTeam: { kind: 'fade', color: '1 2 3 4' },
      splatTop: { kind: 'image', keepColours: true },
      splatBottom: { kind: 'stock' },
    });
  });

  it("loads a scratch's None as the child hide Layers uses, keeping its Fade colour for later", () => {
    const d = validateDesign({ v: 1, splatters: { splatTop: { kind: 'none', color: '1 2 3 4' } } });
    expect(d.children.ownHealth?.HealthbarTextureTop).toEqual({ visible: false });
    expect(d.splatters?.splatTop).toEqual({ kind: 'stock', color: '1 2 3 4' });
  });

  it('never holds None for any splatter after a load', () => {
    const d = validateDesign({ v: 1, splatters: { splatTeam: { kind: 'none' }, splatTop: { kind: 'none' }, splatBottom: { kind: 'none' } },
      children: { ownHealth: { HealthbarTextureBottom: { x: 3 } } } });
    expect(Object.values(d.splatters ?? {}).some((s) => s?.kind === 'none')).toBe(false);
    // A stored edit on the same piece is kept beside the hide.
    expect(d.children.ownHealth).toEqual({ HealthbarTextureTop: { visible: false }, HealthbarTextureBottom: { x: 3, visible: false } });
  });

  it("never stores None for the teammate splatter: that is the child's hide", () => {
    expect(validateDesign({ v: 1, splatters: { splatTeam: { kind: 'none' } } }).splatters).toBeUndefined();
  });

  it('turns an unknown kind into stock and leaves no splatters key when nothing survives', () => {
    expect(validateDesign({ v: 1, splatters: { splatTop: { kind: 'sparkles' } } }).splatters).toEqual({ splatTop: { kind: 'stock' } });
    expect(validateDesign({ v: 1, splatters: 'x' }).splatters).toBeUndefined();
    expect(validateDesign({ v: 1 }).splatters).toBeUndefined();
  });

  it("keeps a splatter image only at its splatter's exact texture size", () => {
    const d = validateDesign({ v: 1, images: {
      splatTeam: { w: 512, h: 256, png: PNG_OK },
      splatTop: { w: 512, h: 256, png: PNG_OK },          // wrong size for a scratch
      splatBottom: { w: 256, h: 64, png: PNG_OK },
    } });
    expect(Object.keys(d.images).sort()).toEqual(['splatBottom', 'splatTeam']);
  });

  it('sends splatter kinds and Fade colours in a share link, and no images', async () => {
    const d = validateDesign({ v: 1, splatters: { splatTeam: { kind: 'image' }, splatTop: { kind: 'fade', color: '9 9 9 99' } },
      images: { splatTeam: { w: 512, h: 256, png: PNG_OK } } });
    const back = (await decodeShare(await encodeShare(d)))!;
    expect(back.splatters).toEqual(d.splatters);
    expect(back.images).toEqual({});
  });
});

describe('typed keys', () => {
  const defs: KeyDef[] = [
    { key: 'fill_color', label: 'Fill', type: 'colour', evidence: 't' },
    { key: 'gap', label: 'Gap', type: 'int', range: [0, 8], evidence: 't' },
    { key: 'east_aligned', label: 'East', type: 'bool', evidence: 't' },
    { key: 'inset', label: 'Inset', type: 'int', range: [0, 8], evidence: 't', gate: 'Q3' },
  ];
  afterEach(() => { _setProbe('Q3', null); });

  it('keeps each declared key as the text the file takes, clamped and rounded', () => {
    expect(validKeys(defs, { fill_color: '1 2 3 4', gap: 9.6, east_aligned: true })).toEqual({ fill_color: '1 2 3 4', gap: '8', east_aligned: '1' });
    expect(validKeys(defs, { gap: '3', east_aligned: '0' })).toEqual({ gap: '3', east_aligned: '0' });
  });
  it('drops undeclared keys, bad values, and a gated key until its probe passes', () => {
    expect(validKeys(defs, { nope: '1', fill_color: 'red', gap: 'x', inset: 2 })).toBeUndefined();
    _setProbe('Q3', true);
    expect(validKeys(defs, { inset: 2 })).toEqual({ inset: '2' });
  });
  it('has nothing to keep without definitions', () => {
    expect(validKeys(undefined, { gap: 1 })).toBeUndefined();
  });
});

describe('children of every registered panel', () => {
  it('validates the teammate card as before, and drops a panel the registry does not have', () => {
    const d = validateDesign({ v: 1, children: { teamColumn: { Head: { x: 3 } }, nopePanel: { Head: { x: 3 } } } });
    expect(d.children).toEqual({ teamColumn: { Head: { x: 3 } } });
  });
  it('keeps a zpos as a whole number in -50..50, and never keys a child does not declare', () => {
    const d = validateDesign({ v: 1, children: { teamColumn: { Head: { z: 99.4 }, Name: { z: -3, keys: { font: 'x' } } } } });
    expect(d.children.teamColumn).toEqual({ Head: { z: 50 }, Name: { z: -3 } });
  });
  it('drops your own health gated values while their probes are off, and keeps them once they pass', () => {
    const raw = { v: 1, children: { ownHealth: {
      HealthIcon: { color: '0 0 255 255' }, DuckingIcon: { color: '255 0 255 255' },
      Health: { x: 4, keys: { monochrome_color: '255 0 255 255', inset: 3 } },
    } } };
    expect(validateDesign(raw).children.ownHealth).toEqual({ Health: { x: 4 } });
    try {
      _setProbe('Q1', true); _setProbe('Q3', true); _setProbe('Q8', true);
      // The cross colour is dropped with every gate open: probe Q5 failed and the control is gone (slice 2.F G4).
      expect(validateDesign(raw).children.ownHealth).toEqual({
        DuckingIcon: { color: '255 0 255 255' },
        Health: { x: 4, keys: { monochrome_color: '255 0 255 255', inset: '3' } },
      });
    } finally {
      for (const q of ['Q1', 'Q3', 'Q8'] as const) _setProbe(q, null);
    }
  });
  it('keeps your own health fit only once probe Q2 passes, and never adds it', () => {
    const raw = { v: 1, elements: { ownHealth: { fit: true, x: 20 } } };
    expect(validateDesign(raw).elements.ownHealth).toEqual({ x: 20 });
    expect(validateDesign({ v: 1 }).elements.ownHealth).toBeUndefined();
    try {
      _setProbe('Q2', true);
      expect(validateDesign(raw).elements.ownHealth).toEqual({ x: 20, fit: true });
      expect(validateDesign({ v: 1, elements: { ownHealth: { fit: 'yes' } } }).elements.ownHealth).toBeUndefined();
      expect(validateDesign({ v: 1 }).elements.ownHealth).toBeUndefined();
    } finally { _setProbe('Q2', null); }
  });
  it('drops element keys no element declares yet', () => {
    expect(validateDesign({ v: 1, elements: { chat: { x: 5, keys: { foo: '1' } } } }).elements.chat).toEqual({ x: 5 });
  });
});
