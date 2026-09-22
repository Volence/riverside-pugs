import { describe, it, expect } from 'vitest';
import { parseColour, flatTexture, roundedTexture, vmtFor } from './textures';

const px = (t: Uint8ClampedArray, w: number, x: number, y: number) => [...t.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

describe('textures', () => {
  it('parses a colour string', () => { expect(parseColour('40 40 40 215')).toEqual([40, 40, 40, 215]); });

  it('fills a flat texture', () => {
    const t = flatTexture(4, 2, '10 20 30 40');
    expect(t.length).toBe(32);
    expect(px(t, 4, 3, 1)).toEqual([10, 20, 30, 40]);
  });

  it('rounds the corners and leaves the middle solid', () => {
    const t = roundedTexture(32, 32, '0 0 0 200', 8);
    expect(px(t, 32, 0, 0)[3]).toBe(0);
    expect(px(t, 32, 31, 31)[3]).toBe(0);
    expect(px(t, 32, 16, 16)).toEqual([0, 0, 0, 200]);
    expect(px(t, 32, 16, 0)[3]).toBe(200);
  });

  it('writes a lower-case UnlitGeneric material', () => {
    const v = vmtFor('vgui/hud/hudeditor/panelbg');
    expect(v).toContain('$basetexture "vgui/hud/hudeditor/panelbg"');
    expect(v).toContain('$translucent 1');
  });
});
