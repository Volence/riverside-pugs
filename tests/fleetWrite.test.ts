import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWritable, defaultRunIn, ftpTreeWriter, localTreeWriter, sftpTreeWriter } from '../src/fleetWrite.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const P = 'left4dead/cfg/new/a.cfg';

describe('assertWritable', () => {
  it('allows managed paths only, never secrets.cfg', () => {
    expect(() => assertWritable(P)).not.toThrow();
    expect(() => assertWritable('left4dead/cfg/secrets.cfg')).toThrow();
    expect(() => assertWritable('left4dead/maps/x.bsp')).toThrow();
    expect(() => assertWritable('left4dead/cfg/../../etc/passwd')).toThrow();
    // The site's balance writers own these; a release never touches them.
    expect(() => assertWritable('left4dead/cfg/pug_balance.cfg')).toThrow(/site/);
    expect(() => assertWritable('left4dead/addons/sourcemod/data/pug_balance_watch.txt')).toThrow(/site/);
    expect(() => assertWritable('left4dead/addons/sourcemod/data/l4d_info_editor_weapons.cfg')).not.toThrow();
  });
});

describe('localTreeWriter', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'w-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('writes atomically into new dirs, reads, hashes and removes', async () => {
    const w = localTreeWriter(dir);
    expect(await w.read(P)).toBeNull();
    await w.write(P, Buffer.from('abc'));
    expect(readFileSync(join(dir, P), 'utf8')).toBe('abc');
    expect(existsSync(join(dir, `${P}.part`))).toBe(false);
    expect((await w.read(P))!.toString()).toBe('abc');
    expect(await w.hash([P, 'left4dead/cfg/none.cfg'])).toEqual(new Map([[P, sha('abc')], ['left4dead/cfg/none.cfg', null]]));
    await w.remove(P);
    await w.remove(P); // absent is fine
    expect(existsSync(join(dir, P))).toBe(false);
    await expect(w.write('left4dead/cfg/secrets.cfg', Buffer.from('x'))).rejects.toThrow();
  });
});

describe('sftpTreeWriter', () => {
  it('writes through .part and mv with the bytes on stdin; hashes with sha256sum', async () => {
    const calls: { script: string; input?: string }[] = [];
    const runIn = async (_cmd: string, args: string[], input?: Buffer) => {
      const script = args[args.length - 1];
      calls.push({ script, input: input?.toString() });
      if (script.includes('sha256sum')) return Buffer.from(`${sha('abc')}  ${P}\n`);
      if (script.includes('exit 3')) throw Object.assign(new Error('x'), { code: 3 });
      return Buffer.alloc(0);
    };
    const w = sftpTreeWriter({ host: 'h', port: 22, user: 'u', keyPath: '/k', gameDir: '/g', runIn });
    await w.write(P, Buffer.from('abc'));
    expect(calls[0].script).toContain("mkdir -p '/g/left4dead/cfg/new'");
    expect(calls[0].script).toContain("cat > '/g/left4dead/cfg/new/a.cfg.part' && mv -f '/g/left4dead/cfg/new/a.cfg.part' '/g/left4dead/cfg/new/a.cfg'");
    expect(calls[0].input).toBe('abc');
    expect(await w.read(P)).toBeNull();
    expect(await w.hash([P, 'left4dead/cfg/b.cfg'])).toEqual(new Map([[P, sha('abc')], ['left4dead/cfg/b.cfg', null]]));
    await w.remove(P);
    expect(calls.at(-1)!.script).toBe("rm -f -- '/g/left4dead/cfg/new/a.cfg'");
  });
});

describe('ftpTreeWriter', () => {
  it('uploads to .part and renames, reads 550 as absent, hashes by download', async () => {
    const files = new Map<string, Buffer>();
    const client = {
      access: async () => ({}), close: () => {},
      ensureDir: async () => {},
      uploadFrom: async (src: Readable, p: string) => { const chunks: Buffer[] = []; for await (const c of src) chunks.push(Buffer.from(c)); files.set(p, Buffer.concat(chunks)); },
      rename: async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); },
      remove: async (p: string) => { if (!files.delete(p)) throw Object.assign(new Error('550'), { code: 550 }); },
      downloadTo: async (sink: NodeJS.WritableStream, p: string) => { const b = files.get(p); if (!b) throw Object.assign(new Error('550'), { code: 550 }); sink.write(b); },
    };
    const w = ftpTreeWriter({ host: 'h', port: 21, user: 'u', password: 'p', gameDir: '', client: () => client as never });
    await w.write(P, Buffer.from('abc'));
    expect(files.get(`/${P}`)!.toString()).toBe('abc');
    expect(files.has(`/${P}.part`)).toBe(false);
    expect(await w.read('left4dead/cfg/none.cfg')).toBeNull();
    expect((await w.hash([P])).get(P)).toBe(sha('abc'));
    await w.remove(P);
    await w.remove(P);
    expect(files.size).toBe(0);
  });
});

describe('cancelling a box call', () => {
  it('kills the ssh child when the signal aborts', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = defaultRunIn('sleep', ['5'], undefined, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('hands the signal to every ssh call', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const runIn = async (_c: string, args: string[], _i?: Buffer, signal?: AbortSignal) => {
      seen.push(signal);
      return args[args.length - 1].includes('sha256sum') ? Buffer.alloc(0) : Buffer.from('x');
    };
    const w = sftpTreeWriter({ host: 'h', port: 22, user: 'u', keyPath: '/k', gameDir: '/g', runIn });
    const { signal } = new AbortController();
    await w.read(P, signal); await w.write(P, Buffer.from('a'), signal); await w.remove(P, signal); await w.hash([P], signal);
    expect(seen).toEqual([signal, signal, signal, signal]);
  });

  it('closes the FTP client when the signal aborts', async () => {
    let closed = false;
    let hang!: (e: Error) => void;
    const client = {
      access: async () => ({}), close: () => { closed = true; hang(new Error('closed')); },
      ensureDir: async () => {}, uploadFrom: async () => ({}), rename: async () => ({}), remove: async () => ({}),
      downloadTo: () => new Promise((_r, rej) => { hang = rej; }),
    };
    const w = ftpTreeWriter({ host: 'h', port: 21, user: 'u', password: 'p', gameDir: '', client: () => client as never });
    const ac = new AbortController();
    const p = w.read(P, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(closed).toBe(true);
  });
});
