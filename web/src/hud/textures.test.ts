import { describe, it, expect } from 'vitest';
import { parseColour, flatTexture, roundedTexture, vmtFor, fadeTexture } from './textures';

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

describe('fadeTexture', () => {
  it('fades the colour from the left edge to clear at the right, the same on every row', () => {
    const px = fadeTexture(4, 2, '10 20 30 200');
    const alpha = (x: number, y: number) => px[(y * 4 + x) * 4 + 3];
    expect([0, 1, 2, 3].map((x) => alpha(x, 0))).toEqual([175, 125, 75, 25]);
    expect([0, 1, 2, 3].map((x) => alpha(x, 1))).toEqual([175, 125, 75, 25]);
    expect([...px.slice(0, 3)]).toEqual([10, 20, 30]);
  });
});

describe('vmtFor', () => {
  it('keeps its default output, which every existing download ships', () => {
    expect(vmtFor('vgui/hud/hudeditor/x')).toBe('UnlitGeneric\n{\n\t$basetexture "vgui/hud/hudeditor/x"\n\t$translucent 1\n\t$vertexcolor 1\n\t$vertexalpha 1\n\t$ignorez 1\n\t$no_fullbright 1\n\t$nomip 1\n}\n');
  });
  it('leaves out $vertexcolor, and only that, when asked', () => {
    const v = vmtFor('vgui/hud/hudeditor/x', { vertexColor: false });
    expect(v).not.toContain('$vertexcolor');
    expect(v).toBe(vmtFor('vgui/hud/hudeditor/x').replace('\t$vertexcolor 1\n', ''));
  });
});
