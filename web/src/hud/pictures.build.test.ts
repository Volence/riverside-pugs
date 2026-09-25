import { describe, it, expect } from 'vitest';
import { buildHud } from './build';
import { newDesign, type HudDesign } from './design';
import { missingPictures } from './materials';

const FONTS = { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } };
const files = (d: HudDesign) => new Map(buildHud(d, FONTS).map((f) => [f.path, f.data]));

// Every picture a download names must be in it or in the game. One that is in
// neither draws as the purple and black checkerboard: the Modern preset named
// its flat panels but shipped them only in the owner's own gameinfo.txt
// folder, so every player but the owner saw checkerboards on the kill notices
// and the versus score panel (research/2026-09-25-hud-missing-textures.md).
describe('a download ships every picture it names', () => {
  for (const preset of ['stock', 'modern'] as const) {
    for (const advanced of [false, true]) {
      it(`${preset}${advanced ? ', advanced' : ''}`, () => {
        expect(missingPictures(files({ ...newDesign(null), preset, advanced }))).toEqual([]);
      });
    }
  }

  // The Tab screen's three slots (tab screen spec task 8): each names its
  // generated texture in a Tab file, so each must ship it.
  for (const preset of ['stock', 'modern'] as const) {
    it(`${preset}, with the Tab screen's slots styled`, () => {
      const styles = { tabStatBox: { kind: 'flat' as const, color: '0 128 0 255' }, tabTeamBox: { kind: 'rounded' as const, color: '255 0 255 255' },
        tabRowBg: { kind: 'flat' as const, color: '128 0 128 255' } };
      const out = files({ ...newDesign(null), preset, styles });
      expect(missingPictures(out)).toEqual([]);
      for (const id of ['tabstatbox', 'tabteambox', 'tabrowbg']) expect(out.has(`materials/vgui/hud/hudeditor/${id}.vtf`), id).toBe(true);
    });
  }

  it('Modern ships its flat panels at the colours the Modern HUD uses', () => {
    const out = files({ ...newDesign(null), preset: 'modern' });
    for (const name of ['mod_panel_flat', 'mod_panel_flat_red', 'mod_equip_active', 'mod_equip_inactive']) {
      expect(out.has(`materials/vgui/hud/${name}.vmt`), name).toBe(true);
      expect(out.has(`materials/vgui/hud/${name}.vtf`), name).toBe(true);
    }
    expect(files({ ...newDesign(null), preset: 'stock' }).has('materials/vgui/hud/mod_panel_flat.vtf')).toBe(false);
  });
});
