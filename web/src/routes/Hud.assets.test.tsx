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

import { assetsFor, assetSize } from './Hud';
import { validateDesign } from '../hud/design';
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
