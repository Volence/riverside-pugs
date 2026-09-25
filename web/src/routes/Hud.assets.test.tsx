import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CrosshairArt } from '../crosshair/model';

// happy-dom has no 2D canvas, so the texture decoding the page does is
// stood in for: the import's own crosshair decodes to OWN, and any
// crosshair draws to blank pixels.
const OWN: CrosshairArt = { kind: 'image', png: 'data:image/png;base64,T1dO', w: 128, h: 128 };
vi.mock('../crosshair/texture', async (original) => ({
  ...(await original<typeof import('../crosshair/texture')>()),
  importedCrosshair: () => structuredClone(OWN),
  artPixels: async () => new Uint8ClampedArray(128 * 128 * 4),
}));

import { assetsFor, assetSize, halvingSteps } from './Hud';
import { validateDesign, DEFAULT_DESIGN, type HudDesign } from '../hud/design';
import { registerImport, unregisterImport } from '../hud/base';
import { sampleHud } from '../hud/importFixtures';

const ID = '9'.repeat(64);
afterEach(() => { unregisterImport(ID); });
const onImport = (xhairArt: CrosshairArt) => validateDesign({
  v: 1, name: 'x', preset: 'imported', imported: { id: ID, name: 'x' }, crosshair: 'bundle', xhairArt,
});

describe("assetsFor on an imported HUD's own crosshair", () => {
  it("marks the crosshair as the HUD's own while it is still the one the import made", async () => {
    registerImport(ID, sampleHud({ 'materials/vgui/hud/altcrosshair.vtf': new Uint8Array([1]) }));
    expect((await assetsFor(onImport(OWN))).ownCrosshair).toBe(true);
  });

  it('draws the pixels as usual once the player changed it', async () => {
    registerImport(ID, sampleHud({ 'materials/vgui/hud/altcrosshair.vtf': new Uint8Array([1]) }));
    const assets = await assetsFor(onImport({ ...OWN, png: 'data:image/png;base64,TkVX' }));
    expect(assets.ownCrosshair).toBeUndefined();
    expect(assets.crosshair).toHaveLength(128 * 128 * 4);
  });
});

describe('assetSize', () => {
  it("redraws a splatter upload at its texture's size, and a style slot at its own", () => {
    expect(assetSize('splatTeam')).toEqual({ w: 512, h: 256 });
    expect(assetSize('splatBottom')).toEqual({ w: 256, h: 64 });
    expect(assetSize('panelBg')).toEqual({ w: 32, h: 32 });
    expect(assetSize('nope')).toBeNull();
  });
});

describe('halvingSteps', () => {
  it('halves a big picture down to within twice the texture size, each side on its own', () => {
    expect(halvingSteps(4000, 2000, 512, 256)).toEqual([{ w: 2000, h: 1000 }, { w: 1000, h: 500 }]);
    expect(halvingSteps(3000, 100, 256, 64)).toEqual([{ w: 1500, h: 100 }, { w: 750, h: 100 }, { w: 375, h: 100 }]);
  });
  it('takes no step for a picture already near the size, or smaller', () => {
    expect(halvingSteps(900, 400, 512, 256)).toEqual([]);
    expect(halvingSteps(10, 10, 256, 64)).toEqual([]);
  });
});

describe('assetsFor and stored splatter pictures', () => {
  it('decodes no splatter picture whose kind is not Image', async () => {
    // happy-dom never loads a data URL image, so a decode attempt would hang: this resolving is the proof.
    const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN),
      splatters: { splatTop: { kind: 'fade' } },
      images: { splatTop: { w: 256, h: 64, png: 'iVBORw0KGgo=' }, splatBottom: { w: 256, h: 64, png: 'iVBORw0KGgo=' } } };
    const assets = await assetsFor(d);
    expect(assets.images?.splatTop).toBeUndefined();
    expect(assets.images?.splatBottom).toBeUndefined();
  });
});

describe('assetSize for weapon pictures', () => {
  it("redraws a gun picture at its own stored shape, and pistol, item and box pictures at their fixed size", () => {
    expect(assetSize('wiconMachinegun', { w: 192, h: 64 })).toEqual({ w: 192, h: 64 });
    expect(assetSize('wiconPills', { w: 64, h: 64 })).toEqual({ w: 64, h: 64 });
    expect(assetSize('weaponBoxActive', { w: 128, h: 128 })).toEqual({ w: 128, h: 128 });
  });
  it('refuses a stored size the design would not keep', () => {
    expect(assetSize('wiconMachinegun', { w: 999, h: 64 })).toBeNull();
    expect(assetSize('wiconPistol', { w: 128, h: 64 })).toBeNull();
    expect(assetSize('wiconMachinegun')).toBeNull();
  });
  it('decodes no weapon picture nothing names', async () => {
    // As above: a decode attempt would hang in happy-dom, so resolving is the proof.
    const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN), weapons: { boxActive: { kind: 'flat' } },
      images: { wiconUzi: { w: 128, h: 64, png: 'iVBORw0KGgo=' }, weaponBoxActive: { w: 128, h: 128, png: 'iVBORw0KGgo=' } } };
    expect((await assetsFor(d)).images).toEqual({});
  });
});
