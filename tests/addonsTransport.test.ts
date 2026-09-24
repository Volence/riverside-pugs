import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTransport, sftpTransport, ftpTransport, transportFor } from '../src/addonsTransport.js';
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

// Riverside is a third box: the web app cannot reach it by filesystem the way
// it reaches Dallas, and it speaks no FTP. It does accept ssh, so the third
// transport shells out to scp/ssh with a dedicated key.
describe('sftpTransport', () => {
  it('refuses a remote name containing a path separator', async () => {
    const t = sftpTransport({
      host: 'h', port: 22, user: 'l4d', keyPath: '/k', dir: '/addons',
    });
    await expect(t.put(src, '../escape.vpk')).rejects.toThrow(/name/i);
  });

  it('uploads to a .part name and renames it into place', async () => {
    const calls: string[][] = [];
    const t = sftpTransport({
      host: 'h', port: 22, user: 'l4d', keyPath: '/k', dir: '/addons',
      run: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '' }; },
    });
    await t.put(src, 'dbd.vpk');
    const scp = calls.find((c) => c[0] === 'scp');
    expect(scp?.join(' ')).toContain('/addons/dbd.vpk.part');
    const mv = calls.find((c) => c[0] === 'ssh');
    expect(mv?.join(' ')).toContain("mv -- '/addons/dbd.vpk.part' '/addons/dbd.vpk'");
  });

  it('reports the remote size, and null when the file is absent', async () => {
    const present = sftpTransport({
      host: 'h', port: 22, user: 'l4d', keyPath: '/k', dir: '/addons',
      run: async () => ({ stdout: '12345\n' }),
    });
    expect(await present.size('dbd.vpk')).toBe(12345);
    const absent = sftpTransport({
      host: 'h', port: 22, user: 'l4d', keyPath: '/k', dir: '/addons',
      run: async () => { throw new Error('stat: No such file or directory'); },
    });
    expect(await absent.size('dbd.vpk')).toBeNull();
  });
});

describe('readText', () => {
  it('local: reads a file, null when absent', async () => {
    const t = localTransport(dir);
    await t.put(src, 'pug_balance.cfg');
    expect(await t.readText('pug_balance.cfg')).toBe('vpk bytes');
    expect(await t.readText('absent.cfg')).toBeNull();
  });

  it('sftp: cats the file; exit 3 (absent) is null, anything else throws', async () => {
    const calls: string[][] = [];
    const t = sftpTransport({
      host: 'h', port: 22, user: 'l4d', keyPath: '/k', dir: '/cfg',
      run: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: 'sm_cvar a "1"\n' }; },
    });
    expect(await t.readText('pug_balance.cfg')).toBe('sm_cvar a "1"\n');
    expect(calls[0].join(' ')).toContain("test -e '/cfg/pug_balance.cfg' || exit 3; cat -- '/cfg/pug_balance.cfg'");
    const absent = sftpTransport({ host: 'h', port: 22, user: 'l4d', keyPath: '/k', dir: '/cfg',
      run: async () => { throw Object.assign(new Error('exit 3'), { code: 3 }); } });
    expect(await absent.readText('pug_balance.cfg')).toBeNull();
    const down = sftpTransport({ host: 'h', port: 22, user: 'l4d', keyPath: '/k', dir: '/cfg',
      run: async () => { throw Object.assign(new Error('ssh: connect refused'), { code: 255 }); } });
    await expect(down.readText('pug_balance.cfg')).rejects.toThrow(/refused/);
  });

  it('ftp: downloads the file; 550 is null', async () => {
    const files = new Map([['/cfg/pug_balance.cfg', 'sm_cvar a "1"\n']]);
    let cwd = '/';
    const client = () => ({
      access: async () => ({}), close: () => {}, ensureDir: async () => {}, uploadFrom: async () => ({}),
      rename: async () => ({}), size: async () => 0, remove: async () => ({}),
      cd: async (d: string) => { cwd = d; return {}; },
      downloadTo: async (sink: NodeJS.WritableStream, name: string) => {
        const body = files.get(`${cwd}/${name}`);
        if (body === undefined) throw Object.assign(new Error('550 No such file'), { code: 550 });
        await new Promise<void>((r) => sink.write(Buffer.from(body), () => r()));
        return {};
      },
    });
    const t = ftpTransport({ host: 'h', port: 21, user: 'u', password: 'p', dir: '/cfg', client: client as never });
    expect(await t.readText('pug_balance.cfg')).toBe('sm_cvar a "1"\n');
    expect(await t.readText('absent.cfg')).toBeNull();
  });

  it('refuses an unsafe name', async () => {
    await expect(localTransport(dir).readText('../x')).rejects.toThrow(/name/i);
  });
});

describe('transportFor, sftp', () => {
  it('is null when an sftp server has no key path', () => {
    expect(transportFor(server({
      addons_transport: 'sftp', addons_dir: '/addons',
      ftp_host: 'h', ftp_user: 'l4d', ssh_key_path: null,
    } as never))).toBeNull();
  });

  it('builds an sftp transport when host, user, key and dir are all set', () => {
    expect(transportFor(server({
      addons_transport: 'sftp', addons_dir: '/addons',
      ftp_host: 'h', ftp_port: 22, ftp_user: 'l4d', ssh_key_path: '/k',
    } as never))).not.toBeNull();
  });
});

describe('ftpTransport put', () => {
  /** A client whose renames fail in the order given (an Error) or succeed (null). */
  function fakeFtp(renames: (Error | null)[]) {
    const calls: string[] = [];
    const client = () => ({
      access: async () => ({}), close: () => {}, ensureDir: async () => {}, cd: async () => ({}), size: async () => 0,
      downloadTo: async () => ({}),
      uploadFrom: async (_l: string, name: string) => { calls.push(`upload ${name}`); return {}; },
      remove: async (name: string) => { calls.push(`remove ${name}`); throw new Error('550 not there'); },
      rename: async (from: string, to: string) => {
        calls.push(`rename ${from} ${to}`);
        const next = renames.shift();
        if (next) throw next;
        return {};
      },
    });
    return { calls, t: ftpTransport({ host: 'h', port: 21, user: 'u', password: 'p', dir: '/cfg', client: client as never }) };
  }
  const refused = (msg: string) => Object.assign(new Error(msg), { code: 553 });

  it('uploads to .part and renames into place', async () => {
    const f = fakeFtp([null]);
    await f.t.put('/tmp/x', 'pug_balance.cfg');
    expect(f.calls).toEqual(['upload pug_balance.cfg.part', 'rename pug_balance.cfg.part pug_balance.cfg']);
  });

  it('when the rename over an existing file is refused, removes the target (ignoring errors) and renames again', async () => {
    const f = fakeFtp([refused('553 file exists'), null]);
    await f.t.put('/tmp/x', 'pug_balance.cfg');
    expect(f.calls).toEqual([
      'upload pug_balance.cfg.part', 'rename pug_balance.cfg.part pug_balance.cfg',
      'remove pug_balance.cfg', 'rename pug_balance.cfg.part pug_balance.cfg',
    ]);
  });

  it('rejects with the retry\'s error when the second rename fails too', async () => {
    const f = fakeFtp([refused('553 first'), refused('553 second')]);
    await expect(f.t.put('/tmp/x', 'pug_balance.cfg')).rejects.toThrow('553 second');
    expect(f.calls.filter((c) => c.startsWith('rename')).length).toBe(2);
  });
});
