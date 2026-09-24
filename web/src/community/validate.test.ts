/**
 * The server's community checks against the web code they must agree with.
 * Here rather than in tests/ because readArt, safeName and encodeVPK are web
 * modules with extensionless imports, which the server project's NodeNext
 * typecheck refuses; this project resolves them the way Vite does.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkCrosshairArt, checkImport, safeName as serverSafeName, COMMUNITY_XHAIR_CAPS } from '../../../src/community/validate';
import { hudId } from '../../../src/hudFiles';
import { readArt } from '../crosshair/model';
import { safeName } from '../hud/design';
import { encodeVPK } from '../vpk';
import { handMade } from '../vpk/fixtures';

describe('crosshair parity with readArt', () => {
  const CASES: unknown[] = [
    { kind: 'built', state: {} },
    { kind: 'built', state: { shape: 'circledot', round: true, color: '#ABCDEF' } },
    { kind: 'built', state: { shape: 'image' } },
    { kind: 'built', state: { shape: 'star' } },
    { kind: 'built', state: { len: Number.NaN } },
    { kind: 'built', state: { len: Number.POSITIVE_INFINITY } },
    { kind: 'built', state: { len: '7' } },
    { kind: 'built', state: { color: 'red' } },
    { kind: 'built', state: { color: '#12345' } },
    { kind: 'built', state: { round: 'yes' } },
    { kind: 'built', state: { len: 999, thick: -5, gap: 31, dot: 0, radius: 0, alpha: 0, outline: 9, oalpha: 101 } },
    { kind: 'built', state: { len: 0.25, alpha: 55.5 } },
    { kind: 'built', state: { backdrop: 'moon', res: '4320' } },
    { kind: 'built', state: { backdrop: 'shot', res: '2160', extra: 'dropped' } },
    { kind: 'built', state: null },
    { kind: 'built', state: [] },
    { kind: 'built' },
  ];
  for (const raw of CASES) {
    it(`agrees on ${JSON.stringify(raw)}`, () => {
      const web = readArt(raw);
      const server = checkCrosshairArt(raw, COMMUNITY_XHAIR_CAPS);
      expect(server.ok).toBe(web !== null);
      if (server.ok) expect(server.value).toEqual(web);
    });
  }
});

describe('safeName parity with the editor', () => {
  for (const name of ['Clean HUD', '  lots   of   space  ', 'My <b>Clean</b> HUD!', '', 'x'.repeat(60), 'ünïcödé_name-1']) {
    it(`agrees on ${JSON.stringify(name)}`, () => {
      expect(serverSafeName(name)).toBe(safeName(name));
    });
  }
});

const BASE = join(import.meta.dirname, '..', 'hud', 'base', 'stock');

function stockFiles(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(BASE, full).split('\\').join('/'), new Uint8Array(readFileSync(full)));
    }
  };
  walk(BASE);
  return out;
}
const vpkOf = (files: Map<string, Uint8Array>) => encodeVPK([...files].map(([path, data]) => ({ path, data })));
const text = (s: string) => new TextEncoder().encode(s);

describe('checkImport', () => {
  it('passes the stock files and returns their id and files', async () => {
    const files = stockFiles();
    const id = await hudId(files);
    const r = await checkImport(vpkOf(files), id, id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe(id);
    expect([...r.value.files.keys()].sort()).toEqual([...files.keys()].sort());
  });

  it('refuses bytes after the files', async () => {
    const files = stockFiles();
    const id = await hudId(files);
    const vpk = vpkOf(files);
    const padded = new Uint8Array(vpk.length + 3);
    padded.set(vpk);
    const r = await checkImport(padded, id, id);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.ok ? '' : r.error).toMatch(/not laid out as the editor writes/);
  });

  it('refuses a file outside the allowlist, naming it', async () => {
    const files = stockFiles();
    files.set('cfg/autoexec.cfg', text('bind w kill\n'));
    const id = await hudId(files);
    const r = await checkImport(vpkOf(files), id, id);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.ok ? '' : r.error).toContain('cfg/autoexec.cfg');
  });

  it('refuses an id that is not the files\' own, claimed or in the design', async () => {
    const files = stockFiles();
    const id = await hudId(files);
    const other = 'f'.repeat(64);
    expect(await checkImport(vpkOf(files), other, id)).toMatchObject({ ok: false, status: 400 });
    expect(await checkImport(vpkOf(files), id, other)).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a version 2 archive', async () => {
    const files = stockFiles();
    const id = await hudId(files);
    const vpk = vpkOf(files);
    new DataView(vpk.buffer).setUint32(4, 2, true);
    expect(await checkImport(vpk, id, id)).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses over 20 MB before reading it', async () => {
    expect(await checkImport(new Uint8Array(20 * 1024 * 1024 + 1), 'a'.repeat(64), 'a'.repeat(64)))
      .toMatchObject({ ok: false, status: 413 });
  });

  it('refuses a split archive', async () => {
    const files = new Map([['scripts/hudlayout.res', text('"Resource/HudLayout.res"\n{\n}\n')]]);
    const id = await hudId(files);
    const vpk = vpkOf(files);
    // header 12, "res\0" 4, "scripts\0" 8, "hudlayout\0" 10: the entry starts
    // at 34 and its archive index is 6 bytes in.
    const dv = new DataView(vpk.buffer);
    expect(dv.getUint16(40, true)).toBe(0x7FFF);
    dv.setUint16(40, 0, true);
    const r = await checkImport(vpk, id, id);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.ok ? '' : r.error).toMatch(/split/i);
  });

  it('refuses a VPK that is not byte-identical to its canonical encoding', async () => {
    // Two entries over the same bytes, and bytes after them nothing reads.
    // 12 + tree + the files' lengths is the archive's length, so the old
    // length rule passed it.
    const vpk = handMade([
      { path: 'scripts/hudlayout.res', archive: 0x7FFF, offset: 0, length: 6, preload: new Uint8Array(0), data: text('"a"{}hidden!') },
      { path: 'resource/ui/hud/p.res', archive: 0x7FFF, offset: 0, length: 6, preload: new Uint8Array(0) },
    ]);
    const files = new Map([['scripts/hudlayout.res', text('"a"{}h')], ['resource/ui/hud/p.res', text('"a"{}h')]]);
    const id = await hudId(files);
    const r = await checkImport(vpk, id, id);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.ok ? '' : r.error).toMatch(/not laid out as the editor writes/);
  });

  it('refuses a VPK with two entries that differ only by case', async () => {
    const vpk = handMade([
      { path: 'scripts/hudlayout.res', archive: 0x7FFF, offset: 0, length: 6, preload: new Uint8Array(0), data: text('"a"{}\n') },
      { path: 'SCRIPTS/HUDLAYOUT.res', archive: 0x7FFF, offset: 6, length: 6, preload: new Uint8Array(0), data: text('"b"{}\n') },
    ]);
    const id = await hudId(new Map([['scripts/hudlayout.res', text('"b"{}\n')]]));
    const r = await checkImport(vpk, id, id);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.ok ? '' : r.error).toMatch(/differ only in case/);
  });

  it('refuses what is not a VPK at all', async () => {
    expect(await checkImport(text('PK\u0003\u0004 a zip'), 'a'.repeat(64), 'a'.repeat(64)))
      .toMatchObject({ ok: false, status: 400 });
  });
});
