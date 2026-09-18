import { copyFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Client as FtpClient } from 'basic-ftp';
import type { ServerRow } from './serverPool.js';

/**
 * Putting a campaign VPK into a game server's addons directory.
 *
 * Two implementations because the two boxes differ in reach and nothing else:
 * Dallas runs the web app itself, so a file copy is the whole job; Chicago is
 * a rented box we can only speak FTP to.
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
  };
}

export function ftpTransport(cfg: {
  host: string; port: number; user: string; password: string; dir: string;
}): AddonsTransport {
  const withClient = async <T>(fn: (c: FtpClient) => Promise<T>): Promise<T> => {
    const client = new FtpClient(30_000);
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
  };
}

/** The transport for a server, or null when it is not configured for one.
 *
 *  Null, never a guess. A half-configured server must do nothing at all: a
 *  transport that wrote to a default path would put a campaign somewhere the
 *  game server does not read and report success. */
export function transportFor(server: ServerRow): AddonsTransport | null {
  const row = server as ServerRow & {
    addons_transport?: string | null; addons_dir?: string | null;
    ftp_host?: string | null; ftp_port?: number | null;
    ftp_user?: string | null; ftp_password?: string | null;
  };
  if (!row.addons_dir) return null;
  if (row.addons_transport === 'ftp') {
    if (!row.ftp_host || !row.ftp_user || !row.ftp_password) return null;
    return ftpTransport({
      host: row.ftp_host, port: row.ftp_port ?? 21, user: row.ftp_user,
      password: row.ftp_password, dir: row.addons_dir,
    });
  }
  return localTransport(row.addons_dir);
}
