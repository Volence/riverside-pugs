import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ftpTreeReader, gameDirOf, isManaged, localTreeReader, sftpTreeReader, treeReaderFor } from '../src/fleetTree.js';
import type { ServerRow } from '../src/serverPool.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('isManaged', () => {
  it('keeps managed files and drops the skip list', () => {
    expect(isManaged('left4dead/addons/sourcemod/plugins/a.smx')).toBe(true);
    expect(isManaged('left4dead/cfg/server.cfg')).toBe(true);
    expect(isManaged('left4dead_dlc4/missions/x.txt')).toBe(true);
    expect(isManaged('left4dead/maps/c1m1.bsp')).toBe(false);
    expect(isManaged('left4dead/addons/sourcemod/logs/L1.log')).toBe(false);
    expect(isManaged('left4dead/addons/sourcemod/data/x.sq3')).toBe(false);
    expect(isManaged('left4dead/addons/dbd.vpk')).toBe(false);
    expect(isManaged('left4dead/addons/sub/x.vpk')).toBe(true);
    expect(isManaged('left4dead/addons/sourcemod/data/replays/r.rip')).toBe(false);
    expect(isManaged('left4dead/cfg/../../etc/passwd')).toBe(false);
    expect(isManaged('left4dead/addons/sourcemod/scripting/include/sourcemod.inc')).toBe(false);
    expect(isManaged('left4dead/addons/sourcemod/data/tickstats/clients-2026-09-20.csv')).toBe(false);
    expect(isManaged('left4dead/addons/sourcemod/data/admin_cache_dump.txt')).toBe(false);
    expect(isManaged('left4dead/addons/sourcemod/data/pug_logauth_27015.txt')).toBe(false);
    expect(isManaged('left4dead/cfg/banned_user.cfg')).toBe(false);
    expect(isManaged('left4dead/cfg/banned_user.cfg.bak-20260920T224515Z')).toBe(true);
  });
});

describe('gameDirOf', () => {
  it('strips /left4dead/addons', () => {
    expect(gameDirOf({ addons_dir: '/home/l4d/l4d1-a/left4dead/addons' } as never)).toBe('/home/l4d/l4d1-a');
    expect(gameDirOf({ addons_dir: '/left4dead/addons' } as never)).toBe('');
    expect(gameDirOf({ addons_dir: '/srv/other' } as never)).toBeNull();
    expect(gameDirOf({ addons_dir: null } as never)).toBeNull();
  });
});

describe('localTreeReader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-'));
    mkdirSync(join(dir, 'left4dead/addons/sourcemod/plugins'), { recursive: true });
    mkdirSync(join(dir, 'left4dead/addons/sourcemod/logs'), { recursive: true });
    mkdirSync(join(dir, 'left4dead/cfg'), { recursive: true });
    writeFileSync(join(dir, 'left4dead/addons/sourcemod/plugins/a.smx'), 'aaa');
    writeFileSync(join(dir, 'left4dead/addons/sourcemod/logs/L1.log'), 'log');
    writeFileSync(join(dir, 'left4dead/addons/big.vpk'), 'vpk');
    writeFileSync(join(dir, 'left4dead/cfg/server.cfg'), 'cfg');
    symlinkSync(join(dir, 'left4dead/cfg/server.cfg'), join(dir, 'left4dead/cfg/link.cfg'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists and hashes managed files, skipping logs, campaign vpks, symlinks and missing roots', async () => {
    const files = await localTreeReader(dir).read();
    expect(files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'left4dead/addons/sourcemod/plugins/a.smx', size: 3, sha256: sha('aaa') },
      { path: 'left4dead/cfg/server.cfg', size: 3, sha256: sha('cfg') },
    ]);
  });

  it('fails when the game dir itself is missing, rather than reading an empty box', async () => {
    await expect(localTreeReader(join(dir, 'nope')).read()).rejects.toThrow(/not found/);
  });

  it('records size only over the cap', async () => {
    const files = await localTreeReader(dir, { sizeCap: 2 }).read();
    expect(files.every((f) => f.sha256 === null)).toBe(true);
  });
});

describe('sftpTreeReader', () => {
  it('lists with one find and hashes with sha256sum, never downloading', async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const script = args[args.length - 1];
      if (script.includes('find')) {
        return { stdout: `3\tleft4dead/cfg/server.cfg\n9\tleft4dead/addons/sourcemod/logs/L.log\n30000000\tleft4dead/addons/sourcemod/x.bin\n` };
      }
      return { stdout: `${sha('cfg')}  left4dead/cfg/server.cfg\n` };
    };
    const files = await sftpTreeReader({ host: 'h', port: 22, user: 'u', keyPath: '/k', gameDir: '/home/l4d/l4d1-a', run }).read();
    expect(files).toEqual([
      { path: 'left4dead/cfg/server.cfg', size: 3, sha256: sha('cfg') },
      { path: 'left4dead/addons/sourcemod/x.bin', size: 30000000, sha256: null },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c[0] === 'ssh')).toBe(true);
    expect(calls[1][calls[1].length - 1]).toContain("'left4dead/cfg/server.cfg'");
    expect(calls[1][calls[1].length - 1]).not.toContain('x.bin');
  });
});

describe('ftpTreeReader', () => {
  it('walks with LIST, skips symlinks and unmanaged dirs, and hashes by download', async () => {
    const tree: Record<string, { name: string; size: number; type: 1 | 2 | 3 }[]> = {
      '/left4dead/addons': [{ name: 'sourcemod', size: 0, type: 2 }, { name: 'dbd.vpk', size: 5, type: 1 }],
      '/left4dead/addons/sourcemod': [{ name: 'a.smx', size: 3, type: 1 }, { name: 'l.smx', size: 3, type: 3 }],
      '/left4dead/cfg': [{ name: 'server.cfg', size: 3, type: 1 }],
    };
    const content: Record<string, string> = { '/left4dead/addons/sourcemod/a.smx': 'aaa', '/left4dead/cfg/server.cfg': 'cfg' };
    const client = {
      access: async () => ({}), close: () => {},
      list: async (p: string) => {
        if (!tree[p]) throw Object.assign(new Error('550'), { code: 550 });
        return tree[p].map((e) => ({ ...e, isFile: e.type === 1, isDirectory: e.type === 2, isSymbolicLink: e.type === 3 }));
      },
      downloadTo: async (sink: NodeJS.WritableStream, p: string) => { sink.write(Buffer.from(content[p])); },
    };
    const files = await ftpTreeReader({ host: 'h', port: 21, user: 'u', password: 'p', gameDir: '', client: () => client as never }).read();
    expect(files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'left4dead/addons/sourcemod/a.smx', size: 3, sha256: sha('aaa') },
      { path: 'left4dead/cfg/server.cfg', size: 3, sha256: sha('cfg') },
    ]);
  });
});

describe('treeReaderFor', () => {
  const s = (over: object) => ({ id: 1, name: 'x', status: 'idle', enabled: 1, ...over }) as unknown as ServerRow;
  it('picks by transport and refuses half-configured rows', () => {
    expect(treeReaderFor(s({ addons_transport: 'local', addons_dir: '/g/left4dead/addons' }))?.kind).toBe('local');
    expect(treeReaderFor(s({ addons_transport: 'sftp', addons_dir: '/g/left4dead/addons', ftp_host: 'h', ftp_user: 'u', ssh_key_path: '/k' }))?.kind).toBe('sftp');
    expect(treeReaderFor(s({ addons_transport: 'ftp', addons_dir: '/left4dead/addons', ftp_host: 'h', ftp_user: 'u', ftp_password: 'p' }))?.kind).toBe('ftp');
    expect(treeReaderFor(s({ addons_transport: 'ftp', addons_dir: '/left4dead/addons', ftp_host: 'h' }))).toBeNull();
    expect(treeReaderFor(s({ addons_transport: 'local', addons_dir: null }))).toBeNull();
  });
});
