import { describe, it, expect } from 'vitest';
import { missingPictures, stockVgui } from './materials';

const enc = (s: string) => new TextEncoder().encode(s);
const hud = (files: Record<string, string>) => new Map(Object.entries(files).map(([k, v]) => [k, enc(v)]));
const LAYOUT = { 'scripts/hudlayout.res': '"Resource/HudLayout.res" { }' };

describe('stockVgui', () => {
  it('knows the stock panel textures and their pictures', () => {
    const s = stockVgui();
    expect(s.has('vgui/hud/800corner1.vmt')).toBe(true);
    expect(s.has('vgui/hud/scalablepanel_bgblack_outlinegrey.vtf')).toBe(true);
    expect(s.has('vgui/hud/sigh.vmt')).toBe(false);
  });
});

describe('missingPictures', () => {
  it('finds nothing in a HUD that only names the game\'s own pictures', () => {
    const files = hud({
      ...LAYOUT,
      'resource/ui/versusmodescoreboard.res': '"x" { "Bg" { "image" "../vgui/hud/ScalablePanel_bgBlack_outlineGrey" } }',
      'resource/ui/scoreboard.res': '"x" { "Medal" { "image" "hud/holdout_medal_gold" } "Clock" { "fg_image" "hud\\holdoutTimerClockFace" } }',
      'scripts/hud_textures.txt': '"sprites/640_hud" { TextureData { "a" { "file" "vgui/hud/iconsheet" "x" "0" } "b" { "file" "sprites/crosshairs" } } }',
    });
    expect(missingPictures(files)).toEqual([]);
  });

  it('names a picture the HUD points at but neither ships nor the game has', () => {
    const files = hud({
      ...LAYOUT,
      'resource/ui/hud/pzdamagerecordpanel.res': '"x" { "label4background" { "image" "../vgui/hud/sigh" } }',
    });
    expect(missingPictures(files)).toEqual([{ material: 'vgui/hud/sigh', file: 'resource/ui/hud/pzdamagerecordpanel.res' }]);
  });

  it('accepts a picture the HUD ships itself, material and texture', () => {
    const files = hud({
      ...LAYOUT,
      'resource/ui/hud/pzdamagerecordpanel.res': '"x" { "label4background" { "image" "../vgui/hud/sigh" } }',
      'materials/vgui/hud/sigh.vmt': '"UnlitGeneric" { "$basetexture" "vgui/hud/sigh" "$translucent" "1" }',
      'materials/vgui/hud/sigh.vtf': 'VTF',
    });
    expect(missingPictures(files)).toEqual([]);
  });

  it('names a shipped material whose texture is missing', () => {
    const files = hud({
      ...LAYOUT,
      'resource/ui/hud/pzdamagerecordpanel.res': '"x" { "label4background" { "image" "../vgui/hud/sigh" } }',
      'materials/vgui/hud/sigh.vmt': '"UnlitGeneric" { "$baseTexture" "VGUI\\hud\\sigh_art" }',
    });
    expect(missingPictures(files)).toEqual([{ material: 'vgui/hud/sigh_art', file: 'materials/vgui/hud/sigh.vmt' }]);
  });

  it('reads the rounded corner keys and texture files relative to materials/', () => {
    const files = hud({
      ...LAYOUT,
      'resource/ui/scoreboard.res': '"x" { "Box" { "PaintBackgroundType" "2" "Texture1" "vgui/hud/round_tl" "Texture2" "vgui/hud/800corner2" } }',
      'scripts/mod_textures.txt': '"sprites/640_hud" { TextureData { "icon_equip_rifle" { "file" "vgui/hud/myicons" } } }',
    });
    expect(missingPictures(files)).toEqual([
      { material: 'vgui/hud/round_tl', file: 'resource/ui/scoreboard.res' },
      { material: 'vgui/hud/myicons', file: 'scripts/mod_textures.txt' },
    ]);
  });

  it('leaves a bare image name alone: it can be a texture entry, not a file', () => {
    const files = hud({ ...LAYOUT, 'resource/ui/hud/tips.res': '"x" { "Tip" { "image" "tip_boomer" } "Other" { "image" "not_a_thing" } }' });
    expect(missingPictures(files)).toEqual([]);
  });

  it('leaves the crosshair addon\'s picture to the crosshair addon', () => {
    const files = hud({ 'scripts/hudlayout.res': '"x" { "xHair" { "image" "hud/altcrosshair" } }' });
    expect(missingPictures(files)).toEqual([]);
  });

  it('lists each missing picture once, and skips a file it cannot read', () => {
    const files = hud({
      ...LAYOUT,
      'resource/ui/a.res': '"x" { "p" { "image" "hud/custom_bg" } "q" { "image" "hud/custom_bg" } }',
      'resource/ui/b.res': '"x" { "p" { "image" "hud/custom_bg" }',
    });
    expect(missingPictures(files)).toEqual([{ material: 'vgui/hud/custom_bg', file: 'resource/ui/a.res' }]);
  });
});
