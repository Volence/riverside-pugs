import { describe, it, expect, vi, afterEach } from 'vitest';
import { readZip, ZipTooBig } from './unzip';
import { encodeZip } from './zip';
import { zipOf } from './fixtures';

const enc = new TextEncoder();
const NOT_ZIP = 'Could not read this file as a VPK or zip';

describe('readZip', () => {
  it('reads the stored entries encodeZip writes', async () => {
    const files = [{ path: 'riversidehud/pak01_dir.vpk', data: new Uint8Array([1, 2, 3]) }, { path: 'README.txt', data: enc.encode('hi') }];
    const got = await readZip(encodeZip(files), 1000);
    expect([...got.keys()]).toEqual(['riversidehud/pak01_dir.vpk', 'README.txt']);
    expect(got.get('README.txt')).toEqual(enc.encode('hi'));
  });

  it('inflates deflated entries, turns backslashes into slashes and skips folders', async () => {
    const text = enc.encode('"Resource/HudLayout.res" { }'.repeat(20));
    const zip = await zipOf([
      { path: 'EdgeHUD/', data: new Uint8Array(0) },
      { path: 'EdgeHUD\\scripts\\HudLayout.res', data: text, deflate: true },
    ]);
    const got = await readZip(zip, 10_000);
    expect([...got.keys()]).toEqual(['EdgeHUD/scripts/HudLayout.res']);
    expect(got.get('EdgeHUD/scripts/HudLayout.res')).toEqual(text);
  });

  it('finds the end record behind a zip comment', async () => {
    const zip = encodeZip([{ path: 'a.txt', data: enc.encode('a') }]);
    const out = new Uint8Array(zip.length + 5);
    out.set(zip);
    new DataView(out.buffer).setUint16(zip.length - 22 + 20, 5, true);
    out.set(enc.encode('hello'), zip.length);
    expect((await readZip(out, 100)).get('a.txt')).toEqual(enc.encode('a'));
  });

  it('refuses what it cannot read in one sentence', async () => {
    await expect(readZip(enc.encode('hello, not a zip'), 100)).rejects.toThrow(NOT_ZIP);
    await expect(readZip(await zipOf([{ path: 'a.txt', data: enc.encode('a'), flags: 1 }]), 100)).rejects.toThrow(NOT_ZIP);
    const broken = await zipOf([{ path: 'a.txt', data: enc.encode('aaaaaaaaaa'), deflate: true }]);
    broken[30 + 'a.txt'.length] = 0xff;            // BFINAL 1, BTYPE 11: a reserved block type
    await expect(readZip(broken, 100)).rejects.toThrow(NOT_ZIP);
  });

  it('stops on the declared sizes, before inflating anything, when they pass the cap', async () => {
    const zip = await zipOf([{ path: 'a.txt', data: new Uint8Array(10), deflate: true }]);
    await expect(readZip(zip, 3)).rejects.toBeInstanceOf(ZipTooBig);
  });

  describe('an entry that inflates past its declared size', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    // Counts every byte the browser's inflater hands on, to show the reader
    // stops early rather than inflating the whole entry and checking after.
    function countInflated() {
      const Real = DecompressionStream;
      const seen = { bytes: 0 };
      vi.stubGlobal('DecompressionStream', class {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<BufferSource>;
        constructor(format: CompressionFormat) {
          const inner = new Real(format);
          this.writable = inner.writable;
          this.readable = inner.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, c) { seen.bytes += chunk.length; c.enqueue(chunk); },
          }));
        }
      });
      return seen;
    }

    it('is refused, and inflating stops soon after the declared size is passed', async () => {
      const zip = await zipOf([{ path: 'scripts/hudlayout.res', data: new Uint8Array(32 * 1024 * 1024), deflate: true, usize: 10 }]);
      const seen = countInflated();
      await expect(readZip(zip, 1000)).rejects.toThrow(NOT_ZIP);
      expect(seen.bytes).toBeLessThan(4 * 1024 * 1024);
    });

    it('is refused when it inflates to less than it declared', async () => {
      const zip = await zipOf([{ path: 'a.txt', data: new Uint8Array(100), deflate: true, usize: 200 }]);
      await expect(readZip(zip, 1000)).rejects.toThrow(NOT_ZIP);
    });
  });
});
