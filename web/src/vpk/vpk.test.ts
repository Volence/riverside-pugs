import { describe, it, expect } from 'vitest';
import { crc32, encodeVTF, encodeVPK } from './index';
import { readVPK } from './read';

/** Read a little-endian uint32 at `off`. */
const u32 = (b: Uint8Array, off: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, true);
const u16 = (b: Uint8Array, off: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(off, true);

describe('crc32', () => {
  it('matches the known CRC-32 of "123456789"', () => {
    // The standard check value for CRC-32/ISO-HDLC. Without a fixed vector,
    // a subtly wrong table would still produce stable, plausible numbers and
    // every VPK entry would carry a checksum the game rejects.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926);
  });

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('encodeVTF', () => {
  const pixels = (n: number) => new Uint8ClampedArray(n * 4);

  it('writes the VTF magic, version 7.2 and an 80-byte header', () => {
    const out = encodeVTF(2, 2, pixels(4));
    expect([...out.slice(0, 4)]).toEqual([0x56, 0x54, 0x46, 0x00]);
    expect(u32(out, 4)).toBe(7);
    expect(u32(out, 8)).toBe(2);
    expect(u32(out, 12)).toBe(80);
  });

  it('records the dimensions and BGRA8888 as the image format', () => {
    const out = encodeVTF(128, 64, pixels(128 * 64));
    expect(u16(out, 16)).toBe(128);
    expect(u16(out, 18)).toBe(64);
    expect(u32(out, 52)).toBe(12);
  });

  it('swaps red and blue, because the canvas is RGBA and Source wants BGRA', () => {
    // One opaque pure-red pixel. Getting this backwards yields a blue
    // crosshair, which looks like a colour-picker bug rather than an
    // encoder bug and would be chased in the wrong file.
    const rgba = new Uint8ClampedArray([255, 0, 0, 255]);
    const out = encodeVTF(1, 1, rgba);
    expect([...out.slice(80, 84)]).toEqual([0, 0, 255, 255]);
  });

  it('preserves alpha, which is what makes the crosshair see-through', () => {
    const out = encodeVTF(1, 1, new Uint8ClampedArray([10, 20, 30, 128]));
    expect(out[83]).toBe(128);
  });

  it('is header plus exactly one uncompressed mip', () => {
    expect(encodeVTF(16, 8, pixels(16 * 8)).length).toBe(80 + 16 * 8 * 4);
    expect(encodeVTF(16, 8, pixels(16 * 8))[56]).toBe(1);
  });
});

describe('encodeVPK', () => {
  const file = (path: string, body: string) =>
    ({ path, data: new TextEncoder().encode(body) });

  it('writes the v1 signature and a tree size that matches the payload', () => {
    const out = encodeVPK([file('addoninfo.txt', 'hello')]);
    expect(u32(out, 0)).toBe(0x55AA1234);
    expect(u32(out, 4)).toBe(1);
    // 12-byte header + tree + inline data accounts for every byte.
    expect(out.length).toBe(12 + u32(out, 8) + 5);
  });

  it('stores each file inline with its own CRC', () => {
    const body = 'hello';
    const out = encodeVPK([file('addoninfo.txt', body)]);
    const expected = crc32(new TextEncoder().encode(body));
    // The entry sits after "txt\0" + " \0" + "addoninfo\0" in the tree.
    const entryAt = 12 + 4 + 2 + 10;
    expect(u32(out, entryAt)).toBe(expected);
    expect(u16(out, entryAt + 6)).toBe(0x7FFF);   // data is in this file
    expect(u32(out, entryAt + 12)).toBe(body.length);
  });

  it('round-trips the bytes of every file it was given', () => {
    const out = encodeVPK([
      file('addoninfo.txt', 'AAA'),
      file('scripts/hudlayout.res', 'BBBB'),
    ]);
    const text = new TextDecoder().decode(out);
    expect(text).toContain('AAA');
    expect(text).toContain('BBBB');
  });

  it('groups by extension and directory, which is the format, not a detail', () => {
    const out = encodeVPK([
      file('materials/vgui/hud/x.vmt', 'M'),
      file('scripts/hudlayout.res', 'R'),
    ]);
    const text = new TextDecoder().decode(out.slice(12));
    // Extensions sorted: res before vmt.
    expect(text.indexOf('res\0')).toBeLessThan(text.indexOf('vmt\0'));
    expect(text).toContain('materials/vgui/hud\0');
  });

  it('packs a file with no extension under a blank extension, as Valve does, and reads it back', () => {
    const got = readVPK(encodeVPK([{ path: 'docs/LICENSE', data: new Uint8Array([7]) }, { path: 'README', data: new Uint8Array([8]) }]));
    expect(got.get('docs/license')).toEqual(new Uint8Array([7]));
    expect(got.get('readme')).toEqual(new Uint8Array([8]));
  });
});
