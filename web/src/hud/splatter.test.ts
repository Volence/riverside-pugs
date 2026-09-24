import { describe, it, expect } from 'vitest';
import { SPLATTERS, splatterDef, splatterMaterial, splatterImageKey, splatterForMaterial, splatterActive, fadePixels } from './splatter';
import { baseFile } from './base';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { fadeTexture } from './textures';

describe('the splatter registry', () => {
  it('names blocks both presets really have, with the stock image each one shows', () => {
    // The stock image keys pin the registry to the files: a typo here lands in a player's game.
    const stockImage: Record<string, string> = {
      splatTeam: 'hud/healthbar_bg_1',
      splatTop: '../vgui/hud/detail_scratches_top_1',
      splatBottom: '../vgui/hud/detail_scratches_bottom_1',
    };
    for (const def of SPLATTERS) {
      for (const preset of ['stock', 'modern'] as const) {
        const root = parseKv(baseFile(preset, def.file))[0].value as KvNode[];
        expect(kvFind(root, [def.block]), `${preset} ${def.file} ${def.block}`).toBeDefined();
      }
      const stock = kvFind(parseKv(baseFile('stock', def.file))[0].value as KvNode[], [def.block])!;
      expect(kvGet(stock, 'image')).toBe(stockImage[def.id]);
    }
  });

  it('uses the stock texture sizes, powers of two, and new names under hudeditor', () => {
    expect(SPLATTERS.map((d) => [d.id, d.size.w, d.size.h])).toEqual([
      ['splatTeam', 512, 256], ['splatTop', 256, 64], ['splatBottom', 256, 64],
    ]);
    expect(splatterMaterial('splatTeam')).toBe('vgui/hud/hudeditor/splatteam');
    expect(splatterImageKey('splatBottom')).toBe('hud/hudeditor/splatbottom');
    expect(splatterForMaterial('vgui/hud/hudeditor/splattop')?.id).toBe('splatTop');
    expect(splatterForMaterial('vgui/hud/hudeditor/panelbg')).toBeUndefined();
    expect(splatterDef('nope')).toBeUndefined();
  });

  it('marks only the scratches as tinted by health, and only the teammate splatter as a stand-in', () => {
    expect(SPLATTERS.map((d) => [d.id, d.route, d.healthTint])).toEqual([
      ['splatTeam', 'standIn', false], ['splatTop', 'repoint', true], ['splatBottom', 'repoint', true],
    ]);
  });
});

describe('splatterActive', () => {
  const png = { w: 512, h: 256, png: 'AAAA' };
  it('is true for a Fade, and for an Image only with its picture stored', () => {
    expect(splatterActive({ splatters: { splatTeam: { kind: 'fade' } }, images: {} }, 'splatTeam')).toBe(true);
    expect(splatterActive({ splatters: { splatTeam: { kind: 'image' } }, images: {} }, 'splatTeam')).toBe(false);
    expect(splatterActive({ splatters: { splatTeam: { kind: 'image' } }, images: { splatTeam: png } }, 'splatTeam')).toBe(true);
    expect(splatterActive({ splatters: { splatTeam: { kind: 'stock' } }, images: { splatTeam: png } }, 'splatTeam')).toBe(false);
    expect(splatterActive({ images: {} }, 'splatTop')).toBe(false);
  });
});

describe('fadePixels', () => {
  it("is fadeTexture at the splatter's size, in its colour or the default", () => {
    const def = splatterDef('splatTop')!;
    expect(fadePixels(def, { kind: 'fade', color: '1 2 3 4' })).toEqual(fadeTexture(256, 64, '1 2 3 4'));
    expect(fadePixels(def, { kind: 'fade' })).toEqual(fadeTexture(256, 64, def.defaultColor));
  });
});
