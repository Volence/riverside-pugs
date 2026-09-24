import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployRepo } from '../src/deployRepo.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let root: string, work: string;
const git = (...a: string[]) => execFileSync('git', ['-C', work, ...a], { stdio: 'pipe' }).toString().trim();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repo-'));
  work = join(root, 'work');
  mkdirSync(join(work, 'overrides/left4dead/cfg'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'master', work]);
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'Tester');
  writeFileSync(join(work, 'overrides/left4dead/cfg/a.cfg'), 'one');
  git('add', '-A'); git('commit', '-qm', 'first');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('DeployRepo', () => {
  it('clones, lists commits, reads trees with sha256 and blobs, and fetches new commits', async () => {
    let t = 0;
    const repo = new DeployRepo({ url: work, dir: join(root, 'clone.git'), now: () => t });
    await repo.fetch();
    const [c1] = await repo.commits();
    expect(c1).toMatchObject({ subject: 'first', author: 'Tester', short: c1.hash.slice(0, 7) });
    const tree = await repo.tree(c1.hash);
    expect(tree).toEqual([{ path: 'overrides/left4dead/cfg/a.cfg', mode: '100644', blob: expect.any(String), size: 3, sha256: sha('one') }]);
    expect((await repo.blob(tree[0].blob)).toString()).toBe('one');

    writeFileSync(join(work, 'overrides/left4dead/cfg/a.cfg'), 'two');
    symlinkSync('a.cfg', join(work, 'overrides/left4dead/cfg/link.cfg'));
    git('add', '-A'); git('commit', '-qm', 'second');
    await repo.fetch();                 // throttled: same minute, no fetch
    expect((await repo.commits()).length).toBe(1);
    t += 61_000;
    await repo.fetch();
    const [c2] = await repo.commits();
    expect(c2.subject).toBe('second');
    expect(await repo.parent(c2.hash)).toBe(c1.hash);
    expect(await repo.parent(c1.hash)).toBeNull();
    expect(await repo.resolve(c2.short)).toBe(c2.hash);
    await expect(repo.resolve('deadbeef')).rejects.toThrow();
    const t2 = await repo.tree(c2.hash);
    expect(t2.find((f) => f.path.endsWith('link.cfg'))!.mode).toBe('120000');
  });

  it('builds a GitHub commit link from ssh and https urls', () => {
    const r = (url: string) => new DeployRepo({ url, dir: '/x' }).githubCommitUrl('abc');
    expect(r('git@github.com:Volence/l4d-deploy.git')).toBe('https://github.com/Volence/l4d-deploy/commit/abc');
    expect(r('https://github.com/Volence/l4d-deploy.git')).toBe('https://github.com/Volence/l4d-deploy/commit/abc');
    expect(r('/local/path')).toBeNull();
  });
});
