import { describe, it, expect } from 'vitest';
import { crc32 } from './index';
import { encodeZip } from './zip';

const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);
const enc = new TextEncoder();

describe('encodeZip', () => {
  const a = enc.encode('hello');
  const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  const zip = encodeZip([{ path: 'riversidehud/pak01_dir.vpk', data: b }, { path: 'README.txt', data: a }]);

  it('starts with a local file header and stores data uncompressed', () => {
    expect(u32(zip, 0)).toBe(0x04034b50);
    expect(u16(zip, 8)).toBe(0);                       // method: store
    expect(u32(zip, 14)).toBe(crc32(b));
    expect(u32(zip, 18)).toBe(b.length);               // compressed size
    expect(u32(zip, 22)).toBe(b.length);               // uncompressed size
    const nameLen = u16(zip, 26);
    expect(new TextDecoder().decode(zip.slice(30, 30 + nameLen))).toBe('riversidehud/pak01_dir.vpk');
    expect([...zip.slice(30 + nameLen, 30 + nameLen + b.length)]).toEqual([...b]);
  });

  it('ends with an end-of-central-directory record counting both entries', () => {
    const eocd = zip.length - 22;
    expect(u32(zip, eocd)).toBe(0x06054b50);
    expect(u16(zip, eocd + 8)).toBe(2);
    expect(u16(zip, eocd + 10)).toBe(2);
    const cdOffset = u32(zip, eocd + 16);
    expect(u32(zip, cdOffset)).toBe(0x02014b50);
  });

  it('records each local header offset in the central directory', () => {
    const eocd = zip.length - 22;
    let o = u32(zip, eocd + 16);
    const offsets: number[] = [];
    for (let i = 0; i < 2; i++) {
      offsets.push(u32(zip, o + 42));
      o += 46 + u16(zip, o + 28) + u16(zip, o + 30) + u16(zip, o + 32);
    }
    expect(offsets[0]).toBe(0);
    expect(u32(zip, offsets[1])).toBe(0x04034b50);
  });
});
