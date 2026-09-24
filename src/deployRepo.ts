import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The site's read-only copy of the deploy repo (Volence/l4d-deploy). A bare
 * clone in the data dir, fetched with a read-only deploy key; nothing here can
 * change the repo. See docs/superpowers/specs/2026-09-24-release-deploy-design.md.
 */

export interface RepoFile { path: string; mode: string; blob: string; size: number; sha256: string }
export interface RepoCommit { hash: string; short: string; subject: string; author: string; at: string }

const execFileAsync = promisify(execFile);
const FETCH_EVERY_MS = 60_000;

export class DeployRepo {
  private fetchedAt: number | null = null;
  private trees = new Map<string, RepoFile[]>();

  constructor(private opts: { url: string; dir: string; keyPath?: string | null; now?: () => number }) {}

  private async git(args: string[]): Promise<Buffer> {
    const env = { ...process.env };
    if (this.opts.keyPath) {
      env.GIT_SSH_COMMAND = `ssh -i ${this.opts.keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
    }
    const { stdout } = await execFileAsync('git', args, { encoding: 'buffer', maxBuffer: 256 << 20, env });
    return stdout;
  }
  private bare(args: string[]) { return this.git(['--git-dir', this.opts.dir, ...args]); }
  private now() { return (this.opts.now ?? Date.now)(); }

  lastFetchAt(): number | null { return this.fetchedAt; }

  async fetch(force = false): Promise<void> {
    const cloned = existsSync(join(this.opts.dir, 'HEAD'));
    if (cloned && !force && this.fetchedAt !== null && this.now() - this.fetchedAt < FETCH_EVERY_MS) return;
    if (!cloned) await this.git(['clone', '--bare', '--quiet', this.opts.url, this.opts.dir]);
    else await this.bare(['fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/heads/*']);
    this.fetchedAt = this.now();
  }

  async commits(limit = 30): Promise<RepoCommit[]> {
    const out = (await this.bare(['log', 'master', '-n', String(limit), '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1e'])).toString();
    return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
      const [hash, short, subject, author, at] = rec.split('\x1f');
      return { hash, short, subject, author, at };
    });
  }

  async resolve(ref: string): Promise<string> {
    if (!/^[0-9A-Za-z._/-]{1,100}$/.test(ref)) throw new Error('bad ref');
    return (await this.bare(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).toString().trim();
  }

  async parent(hash: string): Promise<string | null> {
    try {
      return (await this.bare(['rev-parse', '--verify', '--quiet', `${hash}^1`])).toString().trim() || null;
    } catch {
      return null;
    }
  }

  async tree(hash: string): Promise<RepoFile[]> {
    const hit = this.trees.get(hash);
    if (hit) return hit;
    const out = (await this.bare(['ls-tree', '-r', '-z', '-l', '--full-tree', hash])).toString();
    const files: RepoFile[] = [];
    for (const rec of out.split('\0').filter(Boolean)) {
      const tab = rec.indexOf('\t');
      const [mode, type, blob, size] = rec.slice(0, tab).split(/\s+/);
      if (type !== 'blob') continue;
      const bytes = await this.blob(blob);
      files.push({ path: rec.slice(tab + 1), mode, blob, size: Number(size), sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    this.trees.set(hash, files);
    return files;
  }

  async blob(id: string): Promise<Buffer> {
    if (!/^[0-9a-f]{40,64}$/.test(id)) throw new Error('bad blob id');
    return this.bare(['cat-file', 'blob', id]);
  }

  githubCommitUrl(hash: string): string | null {
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(this.opts.url);
    return m ? `https://github.com/${m[1]}/${m[2]}/commit/${hash}` : null;
  }
}
