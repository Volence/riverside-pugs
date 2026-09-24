import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import { gameDirOf, isManaged } from './fleetTree.js';
import type { ServerRow } from './serverPool.js';

/**
 * Writing a release onto a box. Every call checks the path first: managed
 * files only, never secrets.cfg. Writes go to `<path>.part` and are renamed
 * into place, so srcds never loads half a file.
 */

export interface TreeWriter {
  kind: 'local' | 'sftp' | 'ftp';
  read(path: string): Promise<Buffer | null>;
  write(path: string, bytes: Buffer): Promise<void>;
  remove(path: string): Promise<void>;
  hash(paths: string[]): Promise<Map<string, string | null>>;
}

export function assertWritable(path: string): void {
  if (!isManaged(path) || path.split('/').pop() === 'secrets.cfg') throw new Error(`refusing to touch ${path}`);
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function localTreeWriter(gameDir: string): TreeWriter {
  const abs = (p: string) => { assertWritable(p); return join(gameDir, p); };
  const read = async (p: string) => {
    try { return await readFile(abs(p)); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
  return {
    kind: 'local',
    read,
    async write(p, bytes) {
      const a = abs(p);
      await mkdir(dirname(a), { recursive: true });
      await writeFile(`${a}.part`, bytes);
      await rename(`${a}.part`, a);
    },
    async remove(p) { await rm(abs(p), { force: true }); },
    async hash(paths) {
      const out = new Map<string, string | null>();
      for (const p of paths) { const b = await read(p); out.set(p, b ? sha256(b) : null); }
      return out;
    },
  };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function defaultRunIn(cmd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(out))
      : reject(Object.assign(new Error(Buffer.concat(err).toString().trim() || `${cmd} exited ${code}`), { code })));
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

export function sftpTreeWriter(cfg: {
  host: string; port: number; user: string; keyPath: string; gameDir: string;
  runIn?: (cmd: string, args: string[], input?: Buffer) => Promise<Buffer>;
}): TreeWriter {
  const common = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', '-i', cfg.keyPath];
  const run = cfg.runIn ?? defaultRunIn;
  const ssh = (script: string, input?: Buffer) => run('ssh', [...common, '-p', String(cfg.port), `${cfg.user}@${cfg.host}`, script], input);
  const abs = (p: string) => { assertWritable(p); return posix.join(cfg.gameDir, p); };
  return {
    kind: 'sftp',
    async read(p) {
      const a = shq(abs(p));
      try { return await ssh(`test -e ${a} || exit 3; cat -- ${a}`); } catch (err) {
        if ((err as { code?: number }).code === 3) return null;
        throw err;
      }
    },
    async write(p, bytes) {
      const a = abs(p);
      await ssh(`mkdir -p ${shq(posix.dirname(a))} && cat > ${shq(`${a}.part`)} && mv -f ${shq(`${a}.part`)} ${shq(a)}`, bytes);
    },
    async remove(p) { await ssh(`rm -f -- ${shq(abs(p))}`); },
    async hash(paths) {
      const out = new Map<string, string | null>(paths.map((p) => [p, null]));
      if (paths.length === 0) return out;
      paths.forEach(assertWritable);
      const text = (await ssh(`cd ${shq(cfg.gameDir)} && sha256sum -- ${paths.map(shq).join(' ')} 2>/dev/null; true`)).toString();
      for (const line of text.split('\n')) {
        const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
        if (m && out.has(m[2])) out.set(m[2], m[1]);
      }
      return out;
    },
  };
}

export type FtpWriteClient = Pick<FtpClient, 'access' | 'close' | 'ensureDir' | 'uploadFrom' | 'rename' | 'remove' | 'downloadTo'>;

export function ftpTreeWriter(cfg: {
  host: string; port: number; user: string; password: string; gameDir: string;
  client?: () => FtpWriteClient;
}): TreeWriter {
  const abs = (p: string) => { assertWritable(p); return `${cfg.gameDir}/${p}`; };
  const withClient = async <T>(fn: (c: FtpWriteClient) => Promise<T>): Promise<T> => {
    const c = cfg.client ? cfg.client() : new FtpClient(60_000);
    try {
      await c.access({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
      return await fn(c);
    } finally { c.close(); }
  };
  const download = async (c: FtpWriteClient, a: string): Promise<Buffer | null> => {
    const chunks: Buffer[] = [];
    const sink = new Writable({ write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    try { await c.downloadTo(sink, a); } catch (err) {
      if ((err as { code?: number }).code === 550) return null;
      throw err;
    }
    return Buffer.concat(chunks);
  };
  return {
    kind: 'ftp',
    read: (p) => withClient((c) => download(c, abs(p))),
    async write(p, bytes) {
      const a = abs(p);
      await withClient(async (c) => {
        await c.ensureDir(posix.dirname(a));
        await c.uploadFrom(Readable.from(bytes), `${a}.part`);
        try { await c.rename(`${a}.part`, a); } catch {
          // Some FTP servers refuse RNTO onto an existing file (as ftpTransport.put).
          await c.remove(a).catch(() => {});
          await c.rename(`${a}.part`, a);
        }
      });
    },
    async remove(p) {
      await withClient(async (c) => { try { await c.remove(abs(p)); } catch { /* absent is fine */ } });
    },
    hash: (paths) => withClient(async (c) => {
      const out = new Map<string, string | null>();
      for (const p of paths) { const b = await download(c, abs(p)); out.set(p, b ? sha256(b) : null); }
      return out;
    }),
  };
}

/** Same fields and the same "null, never a guess" rule as treeReaderFor. */
export function treeWriterFor(server: ServerRow): TreeWriter | null {
  const row = server as ServerRow & {
    addons_transport?: string | null; ftp_host?: string | null; ftp_port?: number | null;
    ftp_user?: string | null; ftp_password?: string | null; ssh_key_path?: string | null;
  };
  const gameDir = gameDirOf(server);
  if (gameDir === null) return null;
  if (row.addons_transport === 'sftp') {
    if (!row.ftp_host || !row.ftp_user || !row.ssh_key_path) return null;
    return sftpTreeWriter({ host: row.ftp_host, port: row.ftp_port ?? 22, user: row.ftp_user, keyPath: row.ssh_key_path, gameDir });
  }
  if (row.addons_transport === 'ftp') {
    if (!row.ftp_host || !row.ftp_user || !row.ftp_password) return null;
    return ftpTreeWriter({ host: row.ftp_host, port: row.ftp_port ?? 21, user: row.ftp_user, password: row.ftp_password, gameDir });
  }
  return localTreeWriter(gameDir);
}
