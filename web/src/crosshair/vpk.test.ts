import { describe, it, expect } from 'vitest';
import { buildVPK, crosshairFiles, encodeVTF } from './vpk';

describe('buildVPK', () => {
  it('packs the four files the game needs to show a crosshair', () => {
    const out = buildVPK('My Crosshair', 2, 2, new Uint8ClampedArray(16), 'LAYOUT');
    const text = new TextDecoder().decode(out);
    expect(text).toContain('altcrosshair');
    expect(text).toContain('hudlayout');
    expect(text).toContain('addoninfo');
    expect(text).toContain('LAYOUT');
    expect(text).toContain('My Crosshair');
  });

  it('strips quotes from the addon name so the manifest cannot be broken', () => {
    // addoninfo.txt is a KeyValues file: an unescaped quote in the title
    // truncates the block and the addon silently fails to load.
    const out = buildVPK('He said "hi"', 2, 2, new Uint8ClampedArray(16), 'L');
    expect(new TextDecoder().decode(out)).toContain('addontitle\t\t"He said hi"');
  });

  it('packs the texture and material crosshairFiles makes, byte for byte', () => {
    // The HUD editor bundles the same two files, so a crosshair made on the
    // Crosshair page looks the same from either download.
    const px = new Uint8ClampedArray(16).map((_, i) => i * 7);
    const files = crosshairFiles(2, 2, px);
    expect(files.map((f) => f.path)).toEqual(['materials/vgui/hud/altcrosshair.vtf', 'materials/vgui/hud/altcrosshair.vmt']);
    expect(files[0].data).toEqual(encodeVTF(2, 2, px));
    const out = buildVPK('x', 2, 2, px, 'L');
    for (const f of files) expect(indexOf(out, f.data), f.path).toBeGreaterThan(0);
  });
});

/** Where `needle` first occurs in `hay`, or -1. */
function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
