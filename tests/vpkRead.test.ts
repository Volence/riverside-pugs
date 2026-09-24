import { describe, it, expect } from 'vitest';
import { readVPK } from '../src/vpkRead.js';
import { encodeVPK } from '../src/vpkWrite.js';
import { checkImport } from '../src/community/validate.js';

const MB = 2 ** 20;

interface RawEntry { name: string; offset: number; length: number; preload?: Uint8Array }

/**
 * A hand-laid v1 VPK: every entry under ext "res", dir "scripts", with the
 * offsets and lengths given, however they overlap, then `data` after the tree.
 */
function rawVpk(entries: RawEntry[], data: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  const str = (s: string) => { parts.push(...enc.encode(s), 0); };
  str('res');
  str('scripts');
  const tree: Uint8Array[] = [];
  const head = new Uint8Array(parts);
  tree.push(head);
  for (const e of entries) {
    const name = enc.encode(e.name + '\0');
    const pre = e.preload ?? new Uint8Array(0);
    const rec = new Uint8Array(18 + pre.length);
    const dv = new DataView(rec.buffer);
    dv.setUint32(0, 0, true);
    dv.setUint16(4, pre.length, true);
    dv.setUint16(6, 0x7FFF, true);
    dv.setUint32(8, e.offset, true);
    dv.setUint32(12, e.length, true);
    dv.setUint16(16, 0xFFFF, true);
    rec.set(pre, 18);
    tree.push(name, rec);
  }
  tree.push(new Uint8Array([0, 0, 0]));
  const treeSize = tree.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + treeSize + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x55AA1234, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, treeSize, true);
  let o = 12;
  for (const p of tree) { out.set(p, o); o += p.length; }
  out.set(data, o);
  return out;
}

/** n entries that all read the same `size` bytes at offset 0. */
const overlapping = (n: number, size: number, preload?: Uint8Array) =>
  rawVpk(Array.from({ length: n }, (_, i) => ({ name: `f${i}`, offset: 0, length: size, preload })), new Uint8Array(size));

describe('readVPK memory', () => {
  it('returns views into the upload, not copies, for entries with no preload', () => {
    const vpk = encodeVPK([{ path: 'scripts/hudlayout.res', data: new Uint8Array([1, 2, 3]) }]);
    const got = readVPK(vpk).get('scripts/hudlayout.res')!;
    expect([...got]).toEqual([1, 2, 3]);
    expect(got.buffer).toBe(vpk.buffer);
  });

  it('refuses an entry past the end before allocating anything for it', () => {
    const vpk = rawVpk([{ name: 'big', offset: 0, length: 0xFFFFFFF0, preload: new Uint8Array([1]) }], new Uint8Array(4));
    expect(() => readVPK(vpk)).toThrow(/not a \.vpk/);
  });

  it('refuses preloaded entries whose copies would add up to more than the file', () => {
    const vpk = overlapping(64, MB, new Uint8Array([7]));
    expect(() => readVPK(vpk)).toThrow(/not a \.vpk/);
  });

  it('still reads overlapping views by default, as a hand-packed addon may', () => {
    const got = readVPK(overlapping(3, 16));
    expect(got.size).toBe(3);
  });

  it('refuses more entries than the cap', () => {
    const vpk = overlapping(11, 1);
    expect(() => readVPK(vpk, undefined, { maxEntries: 10 })).toThrow(/not a \.vpk/);
    expect(readVPK(vpk, undefined, { maxEntries: 11 }).size).toBe(11);
  });

  it('in contiguous mode refuses overlap, gaps and preload, and accepts encodeVPK output', () => {
    const contiguous = { contiguous: true };
    expect(() => readVPK(overlapping(2, 4), undefined, contiguous)).toThrow(/not laid out as the editor writes/);
    const gap = rawVpk([{ name: 'a', offset: 0, length: 2 }, { name: 'b', offset: 3, length: 1 }], new Uint8Array(4));
    expect(() => readVPK(gap, undefined, contiguous)).toThrow(/not laid out as the editor writes/);
    const pre = rawVpk([{ name: 'a', offset: 0, length: 2, preload: new Uint8Array([1]) }], new Uint8Array(2));
    expect(() => readVPK(pre, undefined, contiguous)).toThrow(/not laid out as the editor writes/);
    const ok = encodeVPK([
      { path: 'scripts/hudlayout.res', data: new Uint8Array([1, 2]) },
      { path: 'resource/clientscheme.res', data: new Uint8Array([3]) },
      { path: 'resource/ui/a.res', data: new Uint8Array(0) },
    ]);
    expect(readVPK(ok, undefined, contiguous).size).toBe(3);
  });
});

describe('checkImport against an overlapping-entries VPK', () => {
  it('refuses it fast, with memory bounded by the upload', async () => {
    // 400 entries of the same 16 MB: 6.4 GB if each entry were copied or re-encoded.
    const vpk = overlapping(400, 16 * MB);
    const before = process.memoryUsage().arrayBuffers;
    const t0 = performance.now();
    const r = await checkImport(vpk, 'x', 'x');
    const ms = performance.now() - t0;
    const grew = process.memoryUsage().arrayBuffers - before;
    expect(r).toMatchObject({ ok: false, status: 400, error: 'The imported HUD is not laid out as the editor writes it.' });
    expect(ms).toBeLessThan(500);
    expect(grew).toBeLessThan(8 * MB);
  });

  it('refuses one with more entries than a shared HUD may hold, without reading them', async () => {
    const r = await checkImport(overlapping(5000, 0), 'x', 'x');
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});
