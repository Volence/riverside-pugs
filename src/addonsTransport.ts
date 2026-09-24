import { execFile } from 'node:child_process';
import { copyFile, readFile, rename, stat, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import type { ServerRow } from './serverPool.js';

/**
 * Putting a campaign VPK into a game server's addons directory.
 *
 * Three implementations because the boxes differ in reach and nothing else:
 * Dallas runs the web app itself, so a file copy is the whole job; Chicago is
 * a rented box we can only speak FTP to; Riverside is our own second machine,
 * reachable only over ssh, so that one shells out to scp/ssh with a key.
 *
 * Verification is by size, not by hash. Hashing the remote copy would mean
 * downloading a 300 MB file back over FTP after every install, and a truncated
 * transfer is the failure this actually guards against.
 */

export interface AddonsTransport {
  put(localPath: string, remoteName: string): Promise<void>;
  /** Bytes on the far side, or null when the file is not there. */
  size(remoteName: string): Promise<number | null>;
  remove(remoteName: string): Promise<void>;
  /** The file as UTF-8 text, or null when it is not there. Any other failure
   *  throws, so "could not read" is never mistaken for "absent". Used to read
   *  back small config files after writing them. */
  readText(remoteName: string): Promise<string | null>;
}

/** Remote names come from our own database, never from a request. Checked
 *  anyway: this is the last point before a name is joined to a directory that
 *  also holds metamod, stripper, l4dtoolz and the Rotoblin mission bundle. */
function assertPlainName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`unsafe addon name: ${name}`);
  }
}

export function localTransport(dir: string): AddonsTransport {
  return {
    async put(localPath, remoteName) {
      assertPlainName(remoteName);
      // Copy beside the target and rename, so srcds (which mounts whatever is
      // in addons/ at map load) never sees a partial file under the real name.
      // Same filesystem, so the rename is atomic.
      const final = join(dir, remoteName);
      const tmp = `${final}.part`;
      await copyFile(localPath, tmp);
      await rename(tmp, final);
    },
    async size(remoteName) {
      assertPlainName(remoteName);
      try {
        return (await stat(join(dir, remoteName))).size;
      } catch {
        return null;
      }
    },
    async remove(remoteName) {
      assertPlainName(remoteName);
      try {
        await unlink(join(dir, remoteName));
      } catch {
        // Already gone is the desired state.
      }
    },
    async readText(remoteName) {
      assertPlainName(remoteName);
      try {
        return await readFile(join(dir, remoteName), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

/** The part of basic-ftp's Client this file uses, so tests can fake it. */
export type FtpClientLike = Pick<FtpClient, 'access' | 'close' | 'ensureDir' | 'uploadFrom' | 'rename' | 'cd' | 'size' | 'remove' | 'downloadTo'>;

export function ftpTransport(cfg: {
  host: string; port: number; user: string; password: string; dir: string;
  client?: () => FtpClientLike;
}): AddonsTransport {
  const withClient = async <T>(fn: (c: FtpClientLike) => Promise<T>): Promise<T> => {
    const client = cfg.client ? cfg.client() : new FtpClient(30_000);
    try {
      await client.access({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
      });
      return await fn(client);
    } finally {
      client.close();
    }
  };

  return {
    async put(localPath, remoteName) {
      assertPlainName(remoteName);
      await withClient(async (c) => {
        await c.ensureDir(cfg.dir);
        // Upload under a temp name and rename, for the same reason the local
        // transport does: srcds must never mount a half-transferred VPK.
        await c.uploadFrom(localPath, `${remoteName}.part`);
        await c.rename(`${remoteName}.part`, remoteName);
      });
    },
    async size(remoteName) {
      assertPlainName(remoteName);
      return withClient(async (c) => {
        await c.cd(cfg.dir);
        try {
          return await c.size(remoteName);
        } catch {
          return null;
        }
      });
    },
    async remove(remoteName) {
      assertPlainName(remoteName);
      await withClient(async (c) => {
        await c.cd(cfg.dir);
        try {
          await c.remove(remoteName);
        } catch {
          // Already gone is the desired state.
        }
      });
    },
    async readText(remoteName) {
      assertPlainName(remoteName);
      return withClient(async (c) => {
        await c.cd(cfg.dir);
        const chunks: Buffer[] = [];
        const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
        try {
          await c.downloadTo(sink, remoteName);
        } catch (err) {
          // 550 is FTP's "no such file"; anything else is a real failure.
          if ((err as { code?: number }).code === 550) return null;
          throw err;
        }
        return Buffer.concat(chunks).toString('utf8');
      });
    },
  };
}

/** The transport for a server, or null when it is not configured for one.
 *
 *  Null, never a guess. A half-configured server must do nothing at all: a
 *  transport that wrote to a default path would put a campaign somewhere the
 *  game server does not read and report success. */

/** Single-quote a remote path for the shell on the far side. Names are already
 *  restricted by assertPlainName; the directory comes from our own database. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const execFileAsync = promisify(execFile);

export function sftpTransport(cfg: {
  host: string; port: number; user: string; keyPath: string; dir: string;
  run?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
}): AddonsTransport {
  // BatchMode so a missing key fails fast instead of hanging on a prompt, and
  // accept-new so first contact works without a manual known_hosts step while
  // still pinning the key after that.
  const common = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', cfg.keyPath];
  const run = cfg.run ?? (async (cmd: string, args: string[]) => {
    const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 1 << 20 });
    return { stdout };
  });
  const remote = (name: string) => `${cfg.dir}/${name}`;
  // scp spells the port -P, ssh spells it -p. Getting this backwards silently
  // talks to the wrong port, so keep the two arg builders separate.
  const ssh = (script: string) => run('ssh', [...common, '-p', String(cfg.port), `${cfg.user}@${cfg.host}`, script]);
  return {
    async put(localPath, remoteName) {
      assertPlainName(remoteName);
      // Same reason as localTransport: srcds mounts whatever is in addons/ at
      // map load, so it must never see a partial file under the real name.
      const final = remote(remoteName);
      const tmp = `${final}.part`;
      await run('scp', [...common, '-P', String(cfg.port), localPath, `${cfg.user}@${cfg.host}:${tmp}`]);
      await ssh(`mv -- ${shq(tmp)} ${shq(final)}`);
    },
    async size(remoteName) {
      assertPlainName(remoteName);
      try {
        const { stdout } = await ssh(`stat -c %s -- ${shq(remote(remoteName))}`);
        const n = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(n) ? n : null;
      } catch {
        // No such file is the common case and is not an error here.
        return null;
      }
    },
    async remove(remoteName) {
      assertPlainName(remoteName);
      await ssh(`rm -f -- ${shq(remote(remoteName))}`);
    },
    async readText(remoteName) {
      assertPlainName(remoteName);
      const p = shq(remote(remoteName));
      try {
        // Exit 3 is ours and means absent; ssh itself fails with 255.
        return (await ssh(`test -e ${p} || exit 3; cat -- ${p}`)).stdout;
      } catch (err) {
        if ((err as { code?: number }).code === 3) return null;
        throw err;
      }
    },
  };
}

/** @param dirOverride probe or write somewhere other than the addons directory,
 *  keeping this one function as the only place that knows how each box is
 *  reached. Used by the dlc4 probe, which must look at left4dead_dlc4/maps. */
export function transportFor(server: ServerRow, dirOverride?: string): AddonsTransport | null {
  const row = server as ServerRow & {
    addons_transport?: string | null; addons_dir?: string | null;
    ftp_host?: string | null; ftp_port?: number | null;
    ftp_user?: string | null; ftp_password?: string | null;
    ssh_key_path?: string | null;
  };
  const dir = dirOverride ?? row.addons_dir;
  if (!dir) return null;
  if (row.addons_transport === 'sftp') {
    if (!row.ftp_host || !row.ftp_user || !row.ssh_key_path) return null;
    return sftpTransport({
      host: row.ftp_host, port: row.ftp_port ?? 22, user: row.ftp_user,
      keyPath: row.ssh_key_path, dir,
    });
  }
  if (row.addons_transport === 'ftp') {
    if (!row.ftp_host || !row.ftp_user || !row.ftp_password) return null;
    return ftpTransport({
      host: row.ftp_host, port: row.ftp_port ?? 21, user: row.ftp_user,
      password: row.ftp_password, dir,
    });
  }
  return localTransport(dir);
}
