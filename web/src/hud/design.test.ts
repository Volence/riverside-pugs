// @vitest-environment node
// CompressionStream is a Node and browser global; happy-dom does not provide it.
import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_DESIGN, validateDesign, newDesign, usableCrosshair, encodeShare, decodeShare, safeName, clampOverride, clampChild, baseTeam, validKeys, weaponIconId, weaponImageKind } from './design';
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
    // Stock's own row at 140: 150 wide overlapped, 122 fitted (the bar where the game draws it) leaves 18.
    expect(team('stock', { dir: 'row', spacing: 140 })).toEqual({ dir: 'row', fit: true, gap: 18 });
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

  it('keeps the infected row\'s gap and fit, drops a stale spacing once a gap is set, and never gives it slots', () => {
    // Plan Task 11: the row is spaced by the gap; a saved spacing stays only while no gap replaces it (its bytes are pinned).
    const d = validateDesign({ v: 1, elements: { infectedRow: { spacing: 124, gap: 5, fit: true, slots: [] } } });
    expect(d.elements.infectedRow).toEqual({ gap: 5, fit: true });
    expect(validateDesign({ v: 1, elements: { infectedRow: { spacing: 124 } } }).elements.infectedRow).toEqual({ spacing: 124 });
  });

  it('keeps a negative infected row gap, down to a card overlapping all but one unit', () => {
    // The stock card is 256 wide at a 140 pitch: its unfitted gap is -116.
    expect(validateDesign({ v: 1, elements: { infectedRow: { gap: -116 } } }).elements.infectedRow).toEqual({ gap: -116 });
    expect(validateDesign({ v: 1, elements: { infectedRow: { gap: -9999 } } }).elements.infectedRow).toEqual({ gap: -511 });
    // The survivor team's gap stays 0..200.
    expect(validateDesign({ v: 1, elements: { teamColumn: { gap: -5 } } }).elements.teamColumn!.gap).toBe(0);
  });

  it('leaves fit off when a saved design has none, while a new design starts fitted', () => {
    expect(validateDesign({ v: 1 }).elements).toEqual({});
    expect(validateDesign({ v: 1, elements: { chat: { x: 5 } } }).elements.teamColumn).toBeUndefined();
    expect(DEFAULT_DESIGN.elements.teamColumn).toEqual({ fit: true });
    // Probe Q2 passed (slice 2.F G2): a new design fits your own health too; saved designs stay as saved.
    expect(DEFAULT_DESIGN.elements.ownHealth).toEqual({ fit: true });
    expect(validateDesign(structuredClone(DEFAULT_DESIGN)).elements.ownHealth).toEqual({ fit: true });
    expect(validateDesign({ v: 1, elements: { teamColumn: { fit: true } } }).elements.ownHealth).toBeUndefined();
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
      Head: { color: '1 2 3 4' },
      Items: { fontSize: 22, y: 20 },
      BackgroundImage: { x: 5, visible: false },
    });
  });

  it('keeps a tint on the splatter, movable and free-sized like any wh piece, and on the portrait (T1), and drops one on the dead art', () => {
    const got = kids({ teamColumn: {
      BackgroundImage: { x: 5, y: 6, w: 90, h: 40, color: '10 20 30 255' },
      Head: { color: '10 20 30 255' },
      Dead: { color: '10 20 30 255' },
    } }).teamColumn;
    expect(got).toEqual({ BackgroundImage: { x: 5, y: 6, w: 90, h: 40, color: '10 20 30 255' }, Head: { color: '10 20 30 255' } });
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
    expect(validateDesign({ v: 1, weapons: { boxActive: { kind: 'stock' } } }).weapons).toBeUndefined();
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

  const img = (w: number, h: number) => ({ w, h, png: 'AAAA' });

  it('keeps an icon upload for a gun or item entry whose picture is stored at its texel size', () => {
    const d = validateDesign({ v: 1,
      images: { wiconMachinegun: img(192, 64), wiconPistol: img(64, 64), wiconPills: img(64, 64) },
      weapons: { icons: { icon_equip_machinegun: 'wiconMachinegun', icon_equip_pistol: 'wiconPistol', icon_equip_pills: 'wiconPills' } } });
    expect(d.weapons?.icons).toEqual({ icon_equip_machinegun: 'wiconMachinegun', icon_equip_pistol: 'wiconPistol', icon_equip_pills: 'wiconPills' });
    expect(Object.keys(d.images).sort()).toEqual(['wiconMachinegun', 'wiconPills', 'wiconPistol']);
  });

  it('drops an unknown entry, an id that is not the entry own, and an id with no stored picture', () => {
    const d = validateDesign({ v: 1,
      images: { wiconUzi: img(128, 64) },
      weapons: { icons: { icon_equip_flashlight: 'wiconUzi', icon_equip_rifle: 'wiconUzi', icon_equip_uzi: 'wiconUzi', icon_equip_pills: 'wiconPills' } } });
    expect(d.weapons).toEqual({ icons: { icon_equip_uzi: 'wiconUzi' } });
    expect(validateDesign({ v: 1, weapons: { icons: { icon_equip_pills: 'wiconPills' } } }).weapons).toBeUndefined();
  });

  it('drops a stored icon picture that is not its texel size (plan decision 5)', () => {
    const d = validateDesign({ v: 1,
      images: { wiconMachinegun: img(300, 64), wiconRifle: img(64, 32), wiconPistol: img(128, 64), wiconMedkit: img(32, 32), wiconUzi: img(16, 64) },
      weapons: { icons: { icon_equip_machinegun: 'wiconMachinegun', icon_equip_rifle: 'wiconRifle', icon_equip_pistol: 'wiconPistol',
        icon_equip_medkit: 'wiconMedkit', icon_equip_uzi: 'wiconUzi' } } });
    // A gun is 64 texels tall and up to four times as wide (or a quarter as wide); the pistols and items are 64 square.
    expect(d.weapons).toEqual({ icons: { icon_equip_uzi: 'wiconUzi' } });
    expect(Object.keys(d.images)).toEqual(['wiconUzi']);
  });

  it('keeps an Image box with its 128-texel picture, and keeps the kind with none (the "No picture yet" note, as splatters do)', () => {
    const d = validateDesign({ v: 1,
      images: { weaponBoxActive: img(128, 128), weaponBoxInactive: img(64, 64) },
      weapons: { boxActive: { kind: 'image', color: '1 2 3 4' }, boxInactive: { kind: 'image' } } });
    expect(d.weapons).toEqual({ boxActive: { kind: 'image' }, boxInactive: { kind: 'image' } });
    expect(Object.keys(d.images)).toEqual(['weaponBoxActive']);
  });

  it('keeps an Image box kind through a share link, which carries no picture', async () => {
    const d = { ...structuredClone(DEFAULT_DESIGN), images: { weaponBoxActive: img(128, 128) }, weapons: { boxActive: { kind: 'image' as const } } };
    const back = await decodeShare(await encodeShare(d));
    expect(back?.weapons).toEqual({ boxActive: { kind: 'image' } });
    expect(back?.images).toEqual({});
  });

  it('keeps a box picture through a switch to another box style, so switching back brings it back', () => {
    const d = validateDesign({ v: 1, images: { weaponBoxActive: img(128, 128), weaponBoxInactive: img(128, 128) },
      weapons: { boxActive: { kind: 'flat' } } });
    expect(Object.keys(d.images).sort()).toEqual(['weaponBoxActive', 'weaponBoxInactive']);
    // An icon picture nothing names is still dropped.
    expect(validateDesign({ v: 1, images: { wiconUzi: img(128, 64) } }).images).toEqual({});
  });

  it('keeps the uploads while the pictures are hidden, so turning them back on brings them back', () => {
    const d = validateDesign({ v: 1, images: { wiconUzi: img(128, 64) },
      weapons: { weaponIcons: false, icons: { icon_equip_uzi: 'wiconUzi' } } });
    expect(d.weapons).toEqual({ weaponIcons: false, icons: { icon_equip_uzi: 'wiconUzi' } });
  });

  it('names each entry own picture id', () => {
    expect(weaponIconId('icon_equip_machinegun')).toBe('wiconMachinegun');
    expect(weaponIconId('icon_equip_dualpistols')).toBe('wiconDualpistols');
    expect(weaponImageKind('icon_equip_autoshotgun')).toBe('gun');
    expect(weaponImageKind('icon_equip_dualpistols')).toBe('pistol');
    expect(weaponImageKind('icon_equip_pipebomb')).toBe('item');
    expect(weaponImageKind('icon_equip_flashlight')).toBeUndefined();
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
    _setProbe('Q3', false);                                        // Q3 passed in slice 2.F G3: close it to test the rule
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
    // Q8, Q1 and Q3 passed (slice 2.F G5, G1, G3): the crouch icon's colour, the panel colour and the
    // inset are kept by default; the cross colour never is (Q5 failed).
    expect(validateDesign(raw).children.ownHealth).toEqual({
      DuckingIcon: { color: '255 0 255 255' }, Health: { x: 4, keys: { monochrome_color: '255 0 255 255', inset: '3' } } });
    _setProbe('Q8', false); _setProbe('Q1', false); _setProbe('Q3', false);
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
  it('clamps the inset so the bar keeps a unit of fill (review L1)', () => {
    const team = (h: Record<string, unknown>, preset = 'stock') => validateDesign({ v: 1, preset, children: { teamColumn: { Health: h } } }).children.teamColumn?.Health;
    expect(team({ keys: { inset: 8 } })).toEqual({ keys: { inset: '3' } });                  // stock card bar: 7 tall
    expect(team({ h: 20, keys: { inset: 8 } })).toEqual({ h: 20, keys: { inset: '8' } });  // the design's own tall wins
    expect(team({ h: 2, keys: { inset: 8 } })).toEqual({ h: 2, keys: { inset: '0' } });
    const own = validateDesign({ v: 1, preset: 'modern', children: { ownHealth: { Health: { keys: { inset: 5 } } } } });
    expect(own.children.ownHealth?.Health).toEqual({ keys: { inset: '2' } });              // Modern own bar: 6 tall
  });
  it('keeps your own health fit only once probe Q2 passes, and never adds it', () => {
    const raw = { v: 1, elements: { ownHealth: { fit: true, x: 20 } } };
    _setProbe('Q2', false);                                        // Q2 passed in slice 2.F G2: close it to test the rule
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

describe('fit on your infected health', () => {
  it('keeps a stored fit on siHealth as a real boolean, and never adds one', () => {
    expect(validateDesign({ v: 1, elements: { siHealth: { fit: true } } }).elements.siHealth).toEqual({ fit: true });
    expect(validateDesign({ v: 1, elements: { siHealth: { fit: false } } }).elements.siHealth).toEqual({ fit: false });
    expect(validateDesign({ v: 1, elements: { siHealth: { fit: 'yes' } } }).elements.siHealth).toBeUndefined();
    expect(validateDesign({ v: 1, elements: { siHealth: { scale: 1.5 } } }).elements.siHealth).toEqual({ scale: 1.5 });
    // Opt-in: a new design does not fit it (fit moves the container a player placed).
    expect(DEFAULT_DESIGN.elements.siHealth).toBeUndefined();
  });

  it('drops fit on an element that has no fit rule', () => {
    for (const id of ['abilityRing', 'chat', 'ghostPanel', 'weaponSelection']) {
      expect(validateDesign({ v: 1, elements: { [id]: { fit: true } } }).elements[id], id).toBeUndefined();
    }
  });
});

/**
 * The Tab screen's stored edits (tab screen spec 4.2, 4.3 and task 9, with
 * the probe answers of section 7): a hide, a move and a colour are each
 * dropped while their gate is closed, so a gate that flips back off clears
 * them, and kept once it is open.
 */
describe('validateDesign on the Tab screen', () => {
  const GATES = ['TS1', 'TS3', 'TS4', 'TS5', 'TS5b', 'TS6', 'TS7'] as const;
  afterEach(() => { for (const g of GATES) _setProbe(g, null); });
  const withKids = (children: Record<string, Record<string, unknown>>) => validateDesign({ v: 1, children });
  const withEls = (elements: Record<string, unknown>, aspect = '16:9') => validateDesign({ v: 1, aspect, elements });

  it('drops a Tab piece\'s stored hide while TS7 is closed, and keeps it once open', () => {
    _setProbe('TS7', false);
    expect(withKids({ tabBoard: { MissionTitle: { visible: false } } }).children).toEqual({});
    _setProbe('TS7', true);
    expect(withKids({ tabBoard: { MissionTitle: { visible: false } } }).children).toEqual({ tabBoard: { MissionTitle: { visible: false } } });
  });

  it('hides the Health Bonus number with its label, and neither while the hide is gated', () => {
    expect(withKids({ tabVersus: { HealthLabel: { visible: false } } }).children.tabVersus)
      .toEqual({ HealthLabel: { visible: false }, HealthAmount: { visible: false } });
    // The number keeps its own edits beside the hide it takes.
    expect(withKids({ tabVersus: { HealthLabel: { visible: false }, HealthAmount: { color: '1 2 3 255' } } }).children.tabVersus!.HealthAmount)
      .toEqual({ color: '1 2 3 255', visible: false });
    // Hidden on its own, the number leaves the label alone.
    expect(withKids({ tabVersus: { HealthAmount: { visible: false } } }).children.tabVersus).toEqual({ HealthAmount: { visible: false } });
    _setProbe('TS7', false);
    expect(withKids({ tabVersus: { HealthLabel: { visible: false } } }).children).toEqual({});
  });

  it('drops a gated colour while its gate is closed: the title (TS1), the infected names (TS6)', () => {
    _setProbe('TS1', false); _setProbe('TS6', false);
    expect(withKids({ tabBoard: { MissionTitle: { color: '255 0 0 255' } }, tabInfected: { Name: { color: '0 255 255 255' } } }).children).toEqual({});
    _setProbe('TS1', true); _setProbe('TS6', true);
    expect(withKids({ tabBoard: { MissionTitle: { color: '255 0 0 255' } }, tabInfected: { Name: { color: '0 255 255 255' } } }).children)
      .toEqual({ tabBoard: { MissionTitle: { color: '255 0 0 255' } }, tabInfected: { Name: { color: '0 255 255 255' } } });
  });

  it('drops the other infected rows\' colour while TS5b is closed, as it ships, and keeps your row\'s (TS5)', () => {
    const d = withKids({ tabInfected: {
      PlayerBackground: { keys: { bgcolor_override: '0 0 255 255' } },
      PlayerBackground_Selected: { keys: { bgcolor_override: '255 255 0 255' } },
    } });
    expect(d.children.tabInfected).toEqual({ PlayerBackground_Selected: { keys: { bgcolor_override: '255 255 0 255' } } });
    _setProbe('TS5b', true);
    expect(withKids({ tabInfected: { PlayerBackground: { keys: { bgcolor_override: '0 0 255 255' } } } }).children.tabInfected)
      .toEqual({ PlayerBackground: { keys: { bgcolor_override: '0 0 255 255' } } });
  });

  it('never keeps a colour code decides: the versus scores (TS2 failed) and the survivor names', () => {
    expect(withKids({
      tabVersus: { TeamYourScoreSurvivors: { color: '255 128 0 255' }, TeamEnemyScoreSurvivors: { color: '255 128 0 255' } },
      tabSurvivors: { SurvivorStatsName: { color: '0 255 255 255' }, SurvivorStatsNoAvatarName: { color: '0 255 255 255' } },
    }).children).toEqual({});
  });

  it('never keeps a move, a size or a text size on a Tab piece in v1', () => {
    expect(withKids({ tabVersus: { TeamYours: { x: 30, y: 60, w: 50, h: 20, fontSize: 20 } } }).children).toEqual({});
  });

  it('keeps the row bars as one colour, or by health (the key taken out), behind TS3', () => {
    expect(withKids({ tabSurvivors: { SurvivorStatsHealth: { keys: { monochrome_color: '255 0 0 255' } } } }).children.tabSurvivors)
      .toEqual({ SurvivorStatsHealth: { keys: { monochrome_color: '255 0 0 255' } } });
    expect(withKids({ tabSurvivors: { SurvivorStatsHealth: { keys: { monochrome_color: '' } } } }).children.tabSurvivors)
      .toEqual({ SurvivorStatsHealth: { keys: { monochrome_color: '' } } });
    _setProbe('TS3', false);
    expect(withKids({ tabSurvivors: { SurvivorStatsHealth: { keys: { monochrome_color: '' } } } }).children).toEqual({});
  });

  it('takes a key out of the file only where the registry says it may', () => {
    expect(withKids({ tabBoard: { BackgroundImage: { keys: { bgcolor_override: '' } } } }).children).toEqual({});
    expect(withKids({ teamColumn: { Health: { keys: { monochrome_color: '' } } } }).children).toEqual({});
    expect(withKids({ tabBoard: { BackgroundImage: { keys: { bgcolor_override: '0 0 96 200' } } } }).children)
      .toEqual({ tabBoard: { BackgroundImage: { keys: { bgcolor_override: '0 0 96 200' } } } });
  });

  it('drops the versus panel\'s move while TS4 is closed and its hide while TS7 is, and keeps them once open', () => {
    _setProbe('TS4', false); _setProbe('TS7', false);
    expect(withEls({ tabVersus: { x: 100, y: 20, visible: false } }).elements).toEqual({});
    _setProbe('TS4', true); _setProbe('TS7', true);
    expect(withEls({ tabVersus: { x: 100, y: 20, visible: false } }).elements).toEqual({ tabVersus: { x: 100, y: 20, visible: false } });
  });

  it('keeps the versus panel on screen at the design\'s aspect: x 0 to the width less its 354, y 0 to 360', () => {
    expect(withEls({ tabVersus: { x: 900, y: 400 } }).elements.tabVersus).toEqual({ x: 853 - 354, y: 360 });
    expect(withEls({ tabVersus: { x: -50, y: -10 } }).elements.tabVersus).toEqual({ x: 0, y: 0 });
    expect(withEls({ tabVersus: { x: 900 } }, '4:3').elements.tabVersus).toEqual({ x: 640 - 354 });
    expect(withEls({ tabVersus: { x: 420, y: 20 } }).elements.tabVersus).toEqual({ x: 420, y: 20 });
  });

  it('never keeps a move or a hide on the Tab elements that take neither', () => {
    expect(withEls({ tabBoard: { x: 10, y: 10, visible: false }, tabSurvivors: { x: 60 }, tabInfected: { y: 5 } }).elements).toEqual({});
  });
});
