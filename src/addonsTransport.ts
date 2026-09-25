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

/** `signal` cancels the call for real: the FTP connection is closed and an
 *  scp/ssh child is killed, so a caller that gives up on a call (a timeout)
 *  is not left with it still landing on the box later. A local file copy is
 *  over in milliseconds and only checks the signal before it starts. */
export interface TransportOpts { signal?: AbortSignal }

export interface AddonsTransport {
  put(localPath: string, remoteName: string, opts?: TransportOpts): Promise<void>;
  /** Bytes on the far side, or null when the file is not there. */
  size(remoteName: string, opts?: TransportOpts): Promise<number | null>;
  remove(remoteName: string, opts?: TransportOpts): Promise<void>;
  /** The file as UTF-8 text, or null when it is not there. Any other failure
   *  throws, so "could not read" is never mistaken for "absent". Used to read
   *  back small config files after writing them. */
  readText(remoteName: string, opts?: TransportOpts): Promise<string | null>;
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

function throwIfAborted(opts?: TransportOpts): void {
  if (opts?.signal?.aborted) throw abortError();
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
    async put(localPath, remoteName, opts) {
      assertPlainName(remoteName);
      throwIfAborted(opts);
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
    async readText(remoteName, opts) {
      assertPlainName(remoteName);
      throwIfAborted(opts);
      try {
        return await readFile(join(dir, remoteName), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

/** 550 and 553 are how FTP servers that refuse RNTO onto an existing file
 *  say so (basic-ftp puts the reply code on the error). */
function renameRefusedAsExisting(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 550 || code === 553;
}

/** The files this is allowed to remove-then-rename: small text configs. */
function isSmallConfigName(name: string): boolean {
  return /\.(cfg|txt)$/i.test(name);
}

/** The part of basic-ftp's Client this file uses, so tests can fake it. */
export type FtpClientLike = Pick<FtpClient, 'access' | 'close' | 'ensureDir' | 'uploadFrom' | 'rename' | 'cd' | 'size' | 'remove' | 'downloadTo'>;

export function ftpTransport(cfg: {
  host: string; port: number; user: string; password: string; dir: string;
  client?: () => FtpClientLike;
}): AddonsTransport {
  // basic-ftp's own timeout (30 s) bounds a silent socket; the signal is
  // for the caller's overall deadline. Closing the client rejects whatever
  // task is pending on it, so an aborted put stops before its rename.
  const withClient = async <T>(fn: (c: FtpClientLike) => Promise<T>, opts?: TransportOpts): Promise<T> => {
    throwIfAborted(opts);
    const client = cfg.client ? cfg.client() : new FtpClient(30_000);
    let aborted = false;
    const onAbort = () => { aborted = true; client.close(); };
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await client.access({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
      });
      if (aborted) throw abortError();
      const out = await fn(client);
      if (aborted) throw abortError();
      return out;
    } catch (err) {
      throw aborted ? abortError() : err;
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort);
      client.close();
    }
  };

  return {
    async put(localPath, remoteName, opts) {
      assertPlainName(remoteName);
      await withClient(async (c) => {
        await c.ensureDir(cfg.dir);
        // Upload under a temp name and rename, for the same reason the local
        // transport does: srcds must never mount a half-transferred VPK.
        await c.uploadFrom(localPath, `${remoteName}.part`);
        try {
          await c.rename(`${remoteName}.part`, remoteName);
        } catch (err) {
          // Some FTP servers refuse RNTO onto an existing file (550 or 553).
          // Only then, and only for a small config file, is the target cleared
          // for a second try: between the remove and the rename the box has
          // no copy at all, which a campaign VPK (put by this same function)
          // must never risk, and any other error (a dropped connection, say)
          // says nothing about the target being in the way.
          if (!renameRefusedAsExisting(err) || !isSmallConfigName(remoteName)) throw err;
          await c.remove(remoteName).catch(() => {});
          try {
            await c.rename(`${remoteName}.part`, remoteName);
          } catch (err2) {
            const why = err2 instanceof Error ? err2.message : String(err2);
            throw new Error(`${why}; ${remoteName} was removed and the new copy is only at ${remoteName}.part on the box: put it in place by hand`);
          }
        }
      }, opts);
    },
    async size(remoteName, opts) {
      assertPlainName(remoteName);
      return withClient(async (c) => {
        await c.cd(cfg.dir);
        try {
          return await c.size(remoteName);
        } catch {
          return null;
        }
      }, opts);
    },
    async remove(remoteName, opts) {
      assertPlainName(remoteName);
      await withClient(async (c) => {
        await c.cd(cfg.dir);
        try {
          await c.remove(remoteName);
        } catch {
          // Already gone is the desired state.
        }
      }, opts);
    },
    async readText(remoteName, opts) {
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
      }, opts);
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
  run?: (cmd: string, args: string[], opts?: TransportOpts) => Promise<{ stdout: string }>;
}): AddonsTransport {
  // BatchMode so a missing key fails fast instead of hanging on a prompt, and
  // accept-new so first contact works without a manual known_hosts step while
  // still pinning the key after that. ConnectTimeout bounds an unreachable
  // box and the keepalives drop a connection that went silent, so a child
  // never hangs for ever on its own; the signal kills it sooner.
  const common = [
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-i', cfg.keyPath,
  ];
  const run = cfg.run ?? (async (cmd: string, args: string[], opts?: TransportOpts) => {
    const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 1 << 20, signal: opts?.signal });
    return { stdout };
  });
  const remote = (name: string) => `${cfg.dir}/${name}`;
  // scp spells the port -P, ssh spells it -p. Getting this backwards silently
  // talks to the wrong port, so keep the two arg builders separate.
  const ssh = (script: string, opts?: TransportOpts) => {
    throwIfAborted(opts);
    return run('ssh', [...common, '-p', String(cfg.port), `${cfg.user}@${cfg.host}`, script], opts);
  };
  return {
    async put(localPath, remoteName, opts) {
      assertPlainName(remoteName);
      throwIfAborted(opts);
      // Same reason as localTransport: srcds mounts whatever is in addons/ at
      // map load, so it must never see a partial file under the real name.
      const final = remote(remoteName);
      const tmp = `${final}.part`;
      await run('scp', [...common, '-P', String(cfg.port), localPath, `${cfg.user}@${cfg.host}:${tmp}`], opts);
      await ssh(`mv -- ${shq(tmp)} ${shq(final)}`, opts);
    },
    async size(remoteName, opts) {
      assertPlainName(remoteName);
      try {
        const { stdout } = await ssh(`stat -c %s -- ${shq(remote(remoteName))}`, opts);
        const n = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(n) ? n : null;
      } catch {
        // No such file is the common case and is not an error here.
        return null;
      }
    },
    async remove(remoteName, opts) {
      assertPlainName(remoteName);
      await ssh(`rm -f -- ${shq(remote(remoteName))}`, opts);
    },
    async readText(remoteName, opts) {
      assertPlainName(remoteName);
      const p = shq(remote(remoteName));
      try {
        // Exit 3 is ours and means absent; ssh itself fails with 255.
        return (await ssh(`test -e ${p} || exit 3; cat -- ${p}`, opts)).stdout;
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
