import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { Client as FtpClient } from 'basic-ftp';
import type { ServerRow } from './serverPool.js';

/**
 * Reading a game server's managed files for the fleet view. Read-only by
 * construction: nothing here writes, renames or deletes on a box. See
 * docs/superpowers/specs/2026-09-24-fleet-view-design.md.
 */

export const MANAGED_ROOTS = ['left4dead/addons', 'left4dead/cfg', 'left4dead_dlc4/missions'] as const;
export const SIZE_CAP = 20 * 1024 * 1024;
/** Managed files the site itself writes (the balance writers), which a
 *  release must never ship, overwrite or remove. */
export const SITE_OWNED = new Set(['left4dead/cfg/pug_balance.cfg', 'left4dead/addons/sourcemod/data/pug_balance_watch.txt']);
/** Single files directly in left4dead/ that the deploy repo ships. */
export const MANAGED_FILES = ['left4dead/mymotd.txt', 'left4dead/myhost.txt'] as const;
const SKIP_EXT = /\.(log|dem|rip|sq3|sqlite|db)$/i;
/** Never run, or written by the server itself, so they differ by nature:
 *  SourceMod's source tree (Chicago's NFO install has none), tickstats output,
 *  the admin cache dump, the per-port log auth file and the ban lists. */
const SKIP_PREFIX = ['left4dead/addons/sourcemod/scripting/', 'left4dead/addons/sourcemod/data/tickstats/'];
const SKIP_FILE = /^(admin_cache_dump\.txt|pug_logauth_\d+\.txt|banned_user\.cfg|banned_ip\.cfg)$/;

/** Under a managed root, not on the skip list, and a plain relative path. */
export function isManaged(path: string): boolean {
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if ((MANAGED_FILES as readonly string[]).includes(path)) return true;
  if (!MANAGED_ROOTS.some((r) => path.startsWith(`${r}/`))) return false;
  if (parts.includes('logs') || parts.includes('replays')) return false;
  if (SKIP_EXT.test(path)) return false;
  if (SKIP_PREFIX.some((pre) => path.startsWith(pre)) || SKIP_FILE.test(parts[parts.length - 1])) return false;
  // Campaign VPKs sit directly in addons/ and are the campaign installer's.
  if (/^left4dead\/addons\/[^/]+\.vpk$/i.test(path)) return false;
  return true;
}

export interface TreeFile { path: string; size: number; sha256: string | null }
export interface TreeReader { kind: 'local' | 'sftp' | 'ftp'; read(): Promise<TreeFile[]> }

export function gameDirOf(server: ServerRow): string | null {
  const dir = (server as ServerRow & { addons_dir?: string | null }).addons_dir;
  if (!dir) return null;
  const m = /^(.*)\/left4dead\/addons\/?$/.exec(dir);
  return m ? m[1] : null;
}

const sha = () => createHash('sha256');

export function localTreeReader(gameDir: string, opts: { sizeCap?: number } = {}): TreeReader {
  const cap = opts.sizeCap ?? SIZE_CAP;
  const hashFile = (abs: string) => new Promise<string>((resolve, reject) => {
    const h = sha();
    createReadStream(abs).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
  async function walk(rel: string, out: TreeFile[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(gameDir, rel), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // a root this box does not have
      throw err;
    }
    for (const e of entries) {
      const p = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { await walk(p, out); continue; }
      if (!e.isFile() || !isManaged(p)) continue;
      const abs = join(gameDir, p);
      const size = (await lstat(abs)).size;
      out.push({ path: p, size, sha256: size > cap ? null : await hashFile(abs) });
    }
  }
  return {
    kind: 'local',
    async read() {
      // A missing game dir is an error, not an empty box: a copy of the site
      // running anywhere but Dallas would otherwise record every file missing.
      const st = await lstat(gameDir).catch(() => null);
      if (!st?.isDirectory()) throw new Error(`game dir ${gameDir} not found on this machine`);
      const out: TreeFile[] = [];
      for (const r of MANAGED_ROOTS) await walk(r, out);
      for (const f of MANAGED_FILES) {
        const abs = join(gameDir, f);
        const fst = await lstat(abs).catch(() => null);
        if (fst?.isFile()) out.push({ path: f, size: fst.size, sha256: fst.size > cap ? null : await hashFile(abs) });
      }
      return out;
    },
  };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const execFileAsync = promisify(execFile);

export function sftpTreeReader(cfg: {
  host: string; port: number; user: string; keyPath: string; gameDir: string;
  run?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
}): TreeReader {
  const common = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', '-i', cfg.keyPath];
  const run = cfg.run ?? (async (cmd: string, args: string[]) => {
    const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 32 << 20 });
    return { stdout };
  });
  const ssh = (script: string) => run('ssh', [...common, '-p', String(cfg.port), `${cfg.user}@${cfg.host}`, script]);
  return {
    kind: 'sftp',
    async read() {
      // -type f lists regular files only: find does not follow symlinks by
      // default and a symlink is not type f. A root the box lacks is skipped.
      const roots = MANAGED_ROOTS.map(shq).join(' ');
      const listing = await ssh(`cd ${shq(cfg.gameDir)} && for r in ${roots}; do [ -d "$r" ] && find "$r" -type f -printf '%s\\t%p\\n'; done; for f in ${MANAGED_FILES.map(shq).join(' ')}; do [ -f "$f" ] && [ ! -L "$f" ] && printf '%s\\t%s\\n' "$(stat -c %s "$f")" "$f"; done; true`);
      const files: TreeFile[] = [];
      for (const line of listing.stdout.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const path = line.slice(tab + 1);
        if (!isManaged(path)) continue;
        files.push({ path, size: Number(line.slice(0, tab)), sha256: null });
      }
      const toHash = files.filter((f) => f.size <= SIZE_CAP);
      const hashes = new Map<string, string>();
      for (let i = 0; i < toHash.length; i += 200) {
        const batch = toHash.slice(i, i + 200).map((f) => shq(f.path)).join(' ');
        const out = await ssh(`cd ${shq(cfg.gameDir)} && sha256sum -- ${batch}`);
        for (const line of out.stdout.split('\n')) {
          const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
          if (m) hashes.set(m[2], m[1]);
        }
      }
      return files.map((f) => ({ ...f, sha256: f.size <= SIZE_CAP ? hashes.get(f.path) ?? null : null }));
    },
  };
}

export type FtpTreeClient = Pick<FtpClient, 'access' | 'close' | 'list' | 'downloadTo'>;

export function ftpTreeReader(cfg: {
  host: string; port: number; user: string; password: string; gameDir: string;
  client?: () => FtpTreeClient;
}): TreeReader {
  return {
    kind: 'ftp',
    async read() {
      const client = cfg.client ? cfg.client() : new FtpClient(60_000);
      try {
        await client.access({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
        const out: TreeFile[] = [];
        const walk = async (rel: string): Promise<void> => {
          let entries;
          try {
            entries = await client.list(`${cfg.gameDir}/${rel}`);
          } catch (err) {
            if ((err as { code?: number }).code === 550) return; // a root this box does not have
            throw err;
          }
          for (const e of entries) {
            const p = `${rel}/${e.name}`;
            if (e.isSymbolicLink) continue;
            if (e.isDirectory) { await walk(p); continue; }
            if (!e.isFile || !isManaged(p)) continue;
            let sha256: string | null = null;
            if (e.size <= SIZE_CAP) {
              const h = sha();
              const sink = new Writable({ write(chunk, _enc, cb) { h.update(chunk); cb(); } });
              await client.downloadTo(sink, `${cfg.gameDir}/${p}`);
              sha256 = h.digest('hex');
            }
            out.push({ path: p, size: e.size, sha256 });
          }
        };
        for (const r of MANAGED_ROOTS) await walk(r);
        let top: Awaited<ReturnType<FtpTreeClient['list']>> = [];
        try { top = await client.list(`${cfg.gameDir}/left4dead`); } catch (err) {
          if ((err as { code?: number }).code !== 550) throw err;
        }
        for (const e of top) {
          const p = `left4dead/${e.name}`;
          if (!e.isFile || !(MANAGED_FILES as readonly string[]).includes(p)) continue;
          let sha256: string | null = null;
          if (e.size <= SIZE_CAP) {
            const h = sha();
            const sink = new Writable({ write(chunk, _enc, cb) { h.update(chunk); cb(); } });
            await client.downloadTo(sink, `${cfg.gameDir}/${p}`);
            sha256 = h.digest('hex');
          }
          out.push({ path: p, size: e.size, sha256 });
        }
        return out;
      } finally {
        client.close();
      }
    },
  };
}

/** Same fields and the same "null, never a guess" rule as transportFor. */
export function treeReaderFor(server: ServerRow): TreeReader | null {
  const row = server as ServerRow & {
    addons_transport?: string | null; ftp_host?: string | null; ftp_port?: number | null;
    ftp_user?: string | null; ftp_password?: string | null; ssh_key_path?: string | null;
  };
  const gameDir = gameDirOf(server);
  if (gameDir === null) return null;
  if (row.addons_transport === 'sftp') {
    if (!row.ftp_host || !row.ftp_user || !row.ssh_key_path) return null;
    return sftpTreeReader({ host: row.ftp_host, port: row.ftp_port ?? 22, user: row.ftp_user, keyPath: row.ssh_key_path, gameDir });
  }
  if (row.addons_transport === 'ftp') {
    if (!row.ftp_host || !row.ftp_user || !row.ftp_password) return null;
    return ftpTreeReader({ host: row.ftp_host, port: row.ftp_port ?? 21, user: row.ftp_user, password: row.ftp_password, gameDir });
  }
  return localTreeReader(gameDir);
}
