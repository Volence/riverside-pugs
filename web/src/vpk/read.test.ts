import { describe, it, expect } from 'vitest';
import { readVPK, decodeVTF } from './read';
import { encodeVPK, encodeVTF } from './index';

const enc = new TextEncoder();

/**
 * A VPK v2 header in front of a v1 archive's tree and data: the same tree,
 * plus the four section sizes v2 adds. Valve's own tools write v2, and a
 * crosshair addon packed with them is what players will actually upload.
 */
function asV2(v1: Uint8Array): Uint8Array {
  const dv1 = new DataView(v1.buffer, v1.byteOffset, v1.byteLength);
  const treeSize = dv1.getUint32(8, true);
  const body = v1.slice(12);
  const out = new Uint8Array(28 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x55AA1234, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, treeSize, true);
  dv.setUint32(12, body.length - treeSize, true);   // file data section
  out.set(body, 28);
  return out;
}

describe('readVPK', () => {
  it('reads back every file this project\'s own writer packs', () => {
    const files = [
      { path: 'materials/vgui/hud/altcrosshair.vtf', data: new Uint8Array([1, 2, 3, 4]) },
      { path: 'scripts/hudlayout.res', data: enc.encode('LAYOUT') },
      { path: 'addoninfo.txt', data: enc.encode('INFO') },
    ];
    const got = readVPK(encodeVPK(files));
    for (const f of files) expect(got.get(f.path), f.path).toEqual(f.data);
    expect(got.size).toBe(3);
  });

  it('reads a v2 archive too', () => {
    const got = readVPK(asV2(encodeVPK([{ path: 'materials/vgui/hud/altcrosshair.vtf', data: new Uint8Array([9, 8, 7]) }])));
    expect(got.get('materials/vgui/hud/altcrosshair.vtf')).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('finds a path whatever its case, since the game ignores case', () => {
    const got = readVPK(encodeVPK([{ path: 'Materials/VGUI/Hud/AltCrosshair.VTF', data: new Uint8Array([5]) }]));
    expect(got.get('materials/vgui/hud/altcrosshair.vtf')).toEqual(new Uint8Array([5]));
  });

  it('joins preload bytes to the rest of the file', () => {
    // Hand-made: one file "a.txt" of 5 bytes, 2 preloaded in the tree and 3 in the data.
    const tree = [...enc.encode('txt\0 \0a\0')];
    const entry = new Uint8Array(18);
    const dv = new DataView(entry.buffer);
    dv.setUint16(4, 2, true);            // preload bytes
    dv.setUint16(6, 0x7FFF, true);       // data in this file
    dv.setUint32(8, 0, true);
    dv.setUint32(12, 3, true);
    dv.setUint16(16, 0xFFFF, true);
    const treeBytes = [...tree, ...entry, ...enc.encode('he'), 0, 0, 0];
    const out = new Uint8Array(12 + treeBytes.length + 3);
    const h = new DataView(out.buffer);
    h.setUint32(0, 0x55AA1234, true);
    h.setUint32(4, 1, true);
    h.setUint32(8, treeBytes.length, true);
    out.set(treeBytes, 12);
    out.set(enc.encode('llo'), 12 + treeBytes.length);
    expect(new TextDecoder().decode(readVPK(out).get('a.txt'))).toBe('hello');
  });

  it('refuses what is not a VPK, or is cut short', () => {
    expect(() => readVPK(enc.encode('PK\x03\x04 not a vpk at all'))).toThrow(/not a \.vpk/);
    const whole = encodeVPK([{ path: 'a/b.vtf', data: new Uint8Array(40) }]);
    expect(() => readVPK(whole.slice(0, 20))).toThrow(/not a \.vpk/);
    expect(() => readVPK(whole.slice(0, whole.length - 10))).toThrow(/not a \.vpk/);
  });
});

/**
 * A VTF by hand: the 7.x header fields decodeVTF reads, then the low-res
 * thumbnail when there is one, then the mips smallest first, which is how
 * the format lays them out. 7.3 and later find the image through a resource
 * entry instead of by position.
 */
function vtf(opts: {
  minor?: number; format: number; w: number; h: number; mips: Uint8Array[];
  frames?: number; flags?: number; lowRes?: { w: number; h: number };
}): Uint8Array {
  const minor = opts.minor ?? 2;
  const frames = opts.frames ?? 1;
  const resources = minor >= 3;
  const headerSize = resources ? 80 + 16 : 80;
  const low = opts.lowRes ? new Uint8Array(Math.ceil(opts.lowRes.w / 4) * Math.ceil(opts.lowRes.h / 4) * 8).fill(0xAB) : new Uint8Array(0);
  // opts.mips is largest first; the file wants smallest first, each mip once per frame.
  const body: number[] = [...low];
  for (const m of [...opts.mips].reverse()) for (let f = 0; f < frames; f++) body.push(...m);
  const out = new Uint8Array(headerSize + body.length);
  const dv = new DataView(out.buffer);
  out.set([0x56, 0x54, 0x46, 0], 0);
  dv.setUint32(4, 7, true);
  dv.setUint32(8, minor, true);
  dv.setUint32(12, headerSize, true);
  dv.setUint16(16, opts.w, true);
  dv.setUint16(18, opts.h, true);
  dv.setUint32(20, opts.flags ?? 0, true);
  dv.setUint16(24, frames, true);
  dv.setUint32(52, opts.format, true);
  out[56] = opts.mips.length;
  dv.setUint32(57, opts.lowRes ? 13 : 0xFFFFFFFF, true);
  out[61] = opts.lowRes?.w ?? 0;
  out[62] = opts.lowRes?.h ?? 0;
  if (minor >= 2) dv.setUint16(63, 1, true);
  if (resources) {
    dv.setUint32(68, 2, true);
    out.set([0x01, 0, 0, 0], 80); dv.setUint32(84, headerSize, true);                 // low-res image
    out.set([0x30, 0, 0, 0], 88); dv.setUint32(92, headerSize + low.length, true);    // high-res image
  }
  out.set(body, headerSize);
  return out;
}

/** 565 colour words, and the pure colours they stand for. */
const RED = 0xF800, BLUE = 0x001F;
const u16le = (n: number) => [n & 0xff, n >> 8];

describe('decodeVTF', () => {
  it('decodes this project\'s own BGRA8888 texture to the RGBA it was made from', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]);
    expect(decodeVTF(encodeVTF(2, 2, rgba))).toEqual({ w: 2, h: 2, rgba });
  });

  it('decodes each uncompressed layout real crosshair addons use', () => {
    // One pixel, r 10 g 20 b 30 a 40, in each format's own byte order.
    const want = new Uint8ClampedArray([10, 20, 30, 40]);
    const opaque = new Uint8ClampedArray([10, 20, 30, 255]);
    const cases: [string, number, number[], Uint8ClampedArray][] = [
      ['RGBA8888', 0, [10, 20, 30, 40], want],
      ['ABGR8888', 1, [40, 30, 20, 10], want],
      ['RGB888', 2, [10, 20, 30], opaque],
      ['BGR888', 3, [30, 20, 10], opaque],
      ['ARGB8888', 11, [40, 10, 20, 30], want],
      ['BGRA8888', 12, [30, 20, 10, 40], want],
      ['BGRX8888', 16, [30, 20, 10, 99], opaque],
    ];
    for (const [name, format, px, rgba] of cases) {
      expect(decodeVTF(vtf({ format, w: 1, h: 1, mips: [new Uint8Array(px)] })).rgba, name).toEqual(rgba);
    }
  });

  it('decodes a DXT1 block, all four colours, pixel 0 in the low bits', () => {
    // c0 red > c1 blue: the four-colour mode. Row 0 uses indices 0, 1, 2, 3; the rest index 0.
    const block = new Uint8Array([...u16le(RED), ...u16le(BLUE), 0b11100100, 0, 0, 0]);
    const { w, h, rgba } = decodeVTF(vtf({ format: 13, w: 4, h: 4, mips: [block] }));
    expect([w, h]).toEqual([4, 4]);
    expect([...rgba.slice(0, 16)]).toEqual([255, 0, 0, 255, 0, 0, 255, 255, 170, 0, 85, 255, 85, 0, 170, 255]);
    expect([...rgba.slice(16, 20)]).toEqual([255, 0, 0, 255]);
  });

  it('decodes DXT1\'s three-colour mode, where index 3 is see-through', () => {
    // c0 blue <= c1 red: index 2 is the midpoint and index 3 transparent black.
    const block = new Uint8Array([...u16le(BLUE), ...u16le(RED), 0b11100100, 0, 0, 0]);
    const { rgba } = decodeVTF(vtf({ format: 20, w: 4, h: 4, mips: [block] }));
    expect([...rgba.slice(8, 16)]).toEqual([127, 0, 127, 255, 0, 0, 0, 0]);
  });

  it('decodes a DXT5 block\'s interpolated alpha', () => {
    // a0 0 <= a1 255: the six-alpha mode, where index 6 is 0 and 7 is 255.
    // Pixel indices, 3 bits each from bit 0: 0, 1, 6, 7, then 0 for the rest.
    const bits = 0 | (1 << 3) | (6 << 6) | (7 << 9);
    const alpha = [0, 255, bits & 0xff, (bits >> 8) & 0xff, 0, 0, 0, 0];
    const colour = [...u16le(RED), ...u16le(BLUE), 0, 0, 0, 0];
    const { rgba } = decodeVTF(vtf({ format: 15, w: 4, h: 4, mips: [new Uint8Array([...alpha, ...colour])] }));
    expect([3, 7, 11, 15].map((i) => rgba[i])).toEqual([0, 255, 0, 255]);
    expect([...rgba.slice(0, 3)]).toEqual([255, 0, 0]);
  });

  it('decodes a DXT5 block in its eight-alpha mode', () => {
    // a0 255 > a1 0: index 0 is 255, 1 is 0, and 7 is 255 * 1/7 rounded.
    const bits = 0 | (1 << 3) | (7 << 6);
    const alpha = [255, 0, bits & 0xff, (bits >> 8) & 0xff, 0, 0, 0, 0];
    const colour = [...u16le(RED), ...u16le(BLUE), 0, 0, 0, 0];
    const { rgba } = decodeVTF(vtf({ format: 15, w: 4, h: 4, mips: [new Uint8Array([...alpha, ...colour])] }));
    expect([3, 7, 11].map((i) => rgba[i])).toEqual([255, 0, 36]);
  });

  it('decodes a DXT3 block\'s 4-bit alpha', () => {
    const alpha = [0xF0, 0, 0, 0, 0, 0, 0, 0];     // pixel 0 alpha 0, pixel 1 alpha 15 (255)
    const colour = [...u16le(RED), ...u16le(BLUE), 0, 0, 0, 0];
    const { rgba } = decodeVTF(vtf({ format: 14, w: 4, h: 4, mips: [new Uint8Array([...alpha, ...colour])] }));
    expect([rgba[3], rgba[7]]).toEqual([0, 255]);
  });

  it('crops blocks to a texture smaller than one block', () => {
    const block = new Uint8Array([...u16le(RED), ...u16le(BLUE), 0b00000100, 0, 0, 0]);
    const { w, h, rgba } = decodeVTF(vtf({ format: 13, w: 2, h: 1, mips: [block] }));
    expect([w, h, rgba.length]).toEqual([2, 1, 8]);
    expect([...rgba]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it('takes the largest mip and the first frame, past a low-res thumbnail', () => {
    const big = new Uint8Array(4 * 4 * 4).fill(200);
    const small = [new Uint8Array(2 * 2 * 4).fill(1), new Uint8Array(4).fill(2)];
    const got = decodeVTF(vtf({ format: 0, w: 4, h: 4, mips: [big, ...small], frames: 2, lowRes: { w: 4, h: 4 } }));
    expect([...got.rgba]).toEqual([...big]);
  });

  it('finds the image through the resource list in 7.3 and later', () => {
    const big = new Uint8Array(2 * 2 * 4).fill(77);
    const got = decodeVTF(vtf({ minor: 4, format: 0, w: 2, h: 2, mips: [big, new Uint8Array(4)], lowRes: { w: 4, h: 4 } }));
    expect([...got.rgba]).toEqual([...big]);
  });

  it('refuses what it cannot read, saying why', () => {
    expect(() => decodeVTF(new Uint8Array(100))).toThrow(/not a texture/);
    expect(() => decodeVTF(vtf({ format: 4, w: 1, h: 1, mips: [new Uint8Array(2)] }))).toThrow(/format/);
    expect(() => decodeVTF(vtf({ format: 0, w: 1, h: 1, mips: [new Uint8Array(4)], flags: 0x4000 }))).toThrow(/not a texture/);
    const whole = vtf({ format: 0, w: 4, h: 4, mips: [new Uint8Array(64)] });
    expect(() => decodeVTF(whole.slice(0, whole.length - 1))).toThrow(/not a texture/);
  });
});
