import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTransport, transportFor } from '../src/addonsTransport.js';
import type { ServerRow } from '../src/serverPool.js';

let dir: string;
let src: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addons-'));
  src = join(dir, 'source.vpk');
  writeFileSync(src, 'vpk bytes');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const server = (over: Partial<ServerRow> = {}): ServerRow => ({
  id: 1, name: 'Dallas', host: '127.0.0.1', port: 27015, rcon_port: 27015,
  rcon_password: 'x', status: 'idle', tv_port: null, tv_password: null,
  tv_enabled: 0, enabled: 1, ...over,
} as ServerRow);

describe('localTransport', () => {
  it('puts a file and reports its size', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'dest-'));
    const t = localTransport(dest);
    await t.put(src, 'dbd.vpk');
    expect(readFileSync(join(dest, 'dbd.vpk'), 'utf8')).toBe('vpk bytes');
    expect(await t.size('dbd.vpk')).toBe('vpk bytes'.length);
    rmSync(dest, { recursive: true, force: true });
  });

  it('reports null for a file that is not there', async () => {
    expect(await localTransport(dir).size('absent.vpk')).toBeNull();
  });

  it('removes a file', async () => {
    const t = localTransport(dir);
    await t.put(src, 'gone.vpk');
    await t.remove('gone.vpk');
    expect(existsSync(join(dir, 'gone.vpk'))).toBe(false);
  });

  // The remote name is ours, from the DB, never from a request. Rejecting
  // separators anyway is cheap and means one mistake upstream cannot write
  // outside the addons directory.
  it('refuses a remote name containing a path separator', async () => {
    await expect(localTransport(dir).put(src, '../escape.vpk')).rejects.toThrow(/name/i);
  });
});

describe('transportFor', () => {
  it('is null when a local server has no addons dir configured', () => {
    expect(transportFor(server({ addons_transport: 'local', addons_dir: null } as never))).toBeNull();
  });

  it('is null when an ftp server is missing credentials', () => {
    expect(transportFor(server({
      addons_transport: 'ftp', addons_dir: '/addons', ftp_host: null,
    } as never))).toBeNull();
  });

  it('builds a local transport when the dir is set', () => {
    expect(transportFor(server({ addons_transport: 'local', addons_dir: dir } as never))).not.toBeNull();
  });
});
