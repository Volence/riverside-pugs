# Releases (Stage and Deploy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins stage a deploy-repo commit on the site, review what it changes on each box against the fleet readings, and deploy it (all boxes or picked ones, optional canary) with backups, verification, restart when empty, a balance decision, and per-box undo.

**Architecture:** `DeployRepo` keeps a bare clone of `Volence/l4d-deploy` and reads trees and blobs at a commit. `releaseStage.ts` (pure) turns a tree into each box's wanted files (shared `overrides/` plus `boxes/<slug>/`), validates them and plans adds/updates/deletes against the latest fleet reading. `fleetWrite.ts` gives read/write/remove/hash on a box for local, sftp and FTP. `ReleaseEngine` runs one box at a time: wait for idle, hold, back up, write, verify, restart when empty, with restore on any failure, canary, continue and undo. `releaseBalance.ts` applies the release's balance decision to the first new fingerprint a written box reports. Routes and an Admin > Setup > Deploy page drive it.

**Tech Stack:** TypeScript, git CLI, Fastify, better-sqlite3, basic-ftp, ssh, Preact, vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-release-deploy-design.md`

## Global Constraints

- **Nothing in this plan touches a live server** until Task 10, which needs the owner's go-ahead per step. All tests use fakes, temp dirs and a local git fixture.
- **Dev mode refuses every deploy and undo** (409 `deploys are disabled in dev mode`).
- **Writes only to paths passing `isManaged`**, never a basename `secrets.cfg`, never outside the game dir. Checked in `fleetWrite.ts` on every call, and again at staging.
- **One release in flight** (state `deploying` or `canary_wait`) at a time.
- **Backups kept 30 days**, then removed by a daily sweep (`backups_expired = 1`).
- Names up to 60 characters, notes up to 2000 (same as patches).
- Everything admin-only and audited with `logAdmin` (`release_stage`, `release_deploy`, `release_continue`, `release_undo`); failures and canary waits also post a `problem` event with a link to `/admin/setup/deploy`.
- **Deviations from the spec, recorded:**
  1. The box slug is derived from the server name (`Riverside #3` → `riverside-3`, `deploySlug()`), not a new `servers.deploy_slug` column: no hand step, and the new Chicago box keeps its name.
  2. The Patches tab does not get a separate "announced by release N" row; a pending card from a release says "from release N", and a balance decision names the patch when its fingerprint first appears.
  3. `left4dead/mymotd.txt` and `left4dead/myhost.txt` join the managed paths (the deploy repo ships `mymotd.txt`); the fleet view reads them too.

---

### Task 1: Schema, config, managed single files

**Files:**
- Modify: `src/db.ts`, `src/config.ts`, `src/fleetTree.ts`
- Test: `tests/releaseSchema.test.ts` (new), `tests/fleetTree.test.ts`, `tests/db.test.ts`

**Interfaces:**
- Produces: tables `releases`, `release_boxes` (spec "Storage", plus `release_boxes.shipped_json TEXT` and nullable `plan_json`); `balance_patches.release_id`; config `deployRepoUrl` (env `DEPLOY_REPO_URL`, default `git@github.com:Volence/l4d-deploy.git`), `deployRepoKey: string | null` (`DEPLOY_REPO_KEY`), `deployRepoDir` (`<dirname(dbPath)>/deploy-repo.git`), `releasesDir` (`<dirname(dbPath)>/releases`); `MANAGED_FILES` exported from `fleetTree.ts`.

- [ ] **Step 1: Failing tests**

```ts
// tests/releaseSchema.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

describe('release schema', () => {
  it('has releases, release_boxes and balance_patches.release_id', () => {
    const db = openDb(':memory:');
    const id = Number(db.prepare(`INSERT INTO releases (kind, sources_json, state, created_by, created_at)
      VALUES ('deploy', '[]', 'staged', '1', 'x')`).run().lastInsertRowid);
    db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, 1, 'staged', NULL, '{}', 'x')").run(id);
    db.prepare("INSERT INTO balance_patches (source, first_seen_at, release_id) VALUES ('detected', 'x', ?)").run(id);
    expect(() => db.prepare("INSERT INTO releases (kind, sources_json, state, created_by, created_at) VALUES ('deploy', '[]', 'nope', '1', 'x')").run()).toThrow();
  });
  it('puts the repo clone and backups beside the database', () => {
    const c = loadConfig({ DB_PATH: '/srv/data/pug.db' });
    expect(c.deployRepoDir).toBe('/srv/data/deploy-repo.git');
    expect(c.releasesDir).toBe('/srv/data/releases');
    expect(c.deployRepoUrl).toBe('git@github.com:Volence/l4d-deploy.git');
    expect(c.deployRepoKey).toBeNull();
    expect(loadConfig({ DEPLOY_REPO_KEY: '/k' }).deployRepoKey).toBe('/k');
  });
});
```

Add to `tests/fleetTree.test.ts` `isManaged`: `expect(isManaged('left4dead/mymotd.txt')).toBe(true); expect(isManaged('left4dead/myhost.txt')).toBe(true); expect(isManaged('left4dead/motd.txt')).toBe(false);` and in the local reader `beforeEach` write `left4dead/mymotd.txt` = `'motd'`, expecting it in the sorted list (between the plugin and `server.cfg`... sorted: `left4dead/addons/...`, `left4dead/cfg/server.cfg`, `left4dead/mymotd.txt`).

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`src/db.ts`, after the fleet tables:

```ts
  // Releases (sub-project 2b): commits of the deploy repo sent to the boxes.
  // docs/superpowers/specs/2026-09-24-release-deploy-design.md
  db.exec(`
    CREATE TABLE IF NOT EXISTS releases (
      id               INTEGER PRIMARY KEY,
      kind             TEXT NOT NULL CHECK (kind IN ('deploy','undo')),
      undo_of          INTEGER REFERENCES releases(id),
      sources_json     TEXT NOT NULL,
      state            TEXT NOT NULL CHECK (state IN ('staged','invalid','deploying','canary_wait','done','halted')),
      invalid_json     TEXT,
      canary_server_id INTEGER,
      balance_decision TEXT CHECK (balance_decision IN ('balance','not_balance','later')),
      balance_name     TEXT,
      balance_notes    TEXT,
      created_by       TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      deployed_by      TEXT,
      deployed_at      TEXT,
      backups_expired  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS release_boxes (
      release_id   INTEGER NOT NULL REFERENCES releases(id),
      server_id    INTEGER NOT NULL,
      state        TEXT NOT NULL,
      error        TEXT,
      plan_json    TEXT,
      shipped_json TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (release_id, server_id)
    );
  `);
  ensureColumn(db, 'balance_patches', 'release_id', 'INTEGER REFERENCES releases(id)');
```

`src/config.ts` interface fields (with one-line doc comments) and in `loadConfig`:

```ts
    deployRepoUrl: env.DEPLOY_REPO_URL?.trim() || 'git@github.com:Volence/l4d-deploy.git',
    deployRepoKey: env.DEPLOY_REPO_KEY?.trim() || null,
    deployRepoDir: join(dirname(dbPath), 'deploy-repo.git'),
    releasesDir: join(dirname(dbPath), 'releases'),
```

`src/fleetTree.ts`:

```ts
/** Single files directly in left4dead/ that the deploy repo ships. */
export const MANAGED_FILES = ['left4dead/mymotd.txt', 'left4dead/myhost.txt'] as const;
```

In `isManaged`, before the roots check: `if ((MANAGED_FILES as readonly string[]).includes(path)) return true;` (after the `..` check). Readers:
- local `read()`: after the roots, `for (const f of MANAGED_FILES) { const st = await lstat(join(gameDir, f)).catch(() => null); if (st?.isFile()) out.push({ path: f, size: st.size, sha256: st.size > cap ? null : await hashFile(join(gameDir, f)) }); }`
- sftp: append to the listing script `for f in ${MANAGED_FILES.map(shq).join(' ')}; do [ -f "$f" ] && [ ! -L "$f" ] && printf '%s\\t%s\\n' "$(stat -c %s "$f")" "$f"; done;` before the final `true`.
- FTP: after the roots, list `${cfg.gameDir}/left4dead` (550 → skip) and push each `isFile` entry whose `left4dead/${name}` is in `MANAGED_FILES`, hashed like the others.

Add `'release_boxes', 'releases'` to `tests/db.test.ts`'s table list in order.

- [ ] **Step 4: Run** `npx vitest run tests/releaseSchema.test.ts tests/fleetTree.test.ts tests/db.test.ts`, expect PASS.
- [ ] **Step 5: Commit** `git commit -m "releases: schema, config, and mymotd/myhost as managed files"`

---

### Task 2: `DeployRepo` (bare clone, commits, trees, blobs)

**Files:**
- Create: `src/deployRepo.ts`
- Test: `tests/deployRepo.test.ts`

**Interfaces:**
- Produces:
  - `interface RepoFile { path: string; mode: string; blob: string; size: number; sha256: string }` (repo paths, e.g. `overrides/left4dead/cfg/x.cfg`)
  - `interface RepoCommit { hash: string; short: string; subject: string; author: string; at: string }`
  - `class DeployRepo` with `constructor(opts: { url: string; dir: string; keyPath?: string | null; now?: () => number })`, `fetch(force?: boolean): Promise<void>` (clone if missing, else fetch; throttled to once a minute unless forced), `commits(limit = 30): Promise<RepoCommit[]>` (branch `master`), `resolve(ref): Promise<string>` (full hash; throws on unknown), `parent(hash): Promise<string | null>`, `tree(hash): Promise<RepoFile[]>` (cached per hash), `blob(id): Promise<Buffer>`, `githubCommitUrl(hash): string | null`, `lastFetchAt(): number | null`

- [ ] **Step 1: Failing test**

```ts
// tests/deployRepo.test.ts
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
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/deployRepo.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS.** `npx vitest run tests/deployRepo.test.ts`
- [ ] **Step 5: Commit** `git commit -m "releases: DeployRepo, the site's read-only clone of the deploy repo"`

---

### Task 3: Staging (pure): wanted files, validation, box plans, wording, suggestion

**Files:**
- Create: `src/releaseStage.ts`
- Test: `tests/releaseStage.test.ts`

**Interfaces:**
- Consumes: `RepoFile` (Task 2), `FileSig`, `isManaged`, `SIZE_CAP`.
- Produces:
  - `deploySlug(name: string): string`
  - `interface WantedFile { path: string; size: number; sha256: string; blob: string; layer: 'shared' | 'box' }`
  - `wantedFor(files: RepoFile[], slug: string): Map<string, WantedFile>`
  - `validateTree(files: RepoFile[]): string[]`
  - `type Op = { path: string; op: 'write'; size: number; sha256: string; blob?: string; backupFrom?: { releaseId: number; serverId: number }; kind: 'add' | 'update' } | { path: string; op: 'remove' }`
  - `planBox(wanted: Map<string, WantedFile>, onBox: Map<string, FileSig>, shipped: Map<string, { sha256: string; blob: string }>): Op[]`
  - `describeOps(ops: Op[]): string[]`
  - `cvarDiff(oldText: string, newText: string): string[]`
  - `suggestBalance(ops: Op[][], changedCvars: string[], knobs: { cvars: { cvar: string }[]; files: { path: string }[]; dirs: { path: string }[]; versionless: string[]; ignored?: string[] } | null): 'not_balance' | 'possibly_balance'`

- [ ] **Step 1: Failing test**

```ts
// tests/releaseStage.test.ts
import { describe, expect, it } from 'vitest';
import type { RepoFile } from '../src/deployRepo.js';
import { cvarDiff, deploySlug, describeOps, planBox, suggestBalance, validateTree, wantedFor, type Op } from '../src/releaseStage.js';

const f = (path: string, sha = 'h', mode = '100644', size = 1): RepoFile => ({ path, mode, blob: `b-${sha}`.padEnd(40, '0'), size, sha256: sha });

describe('deploySlug', () => {
  it('derives from the server name', () => {
    expect(deploySlug('Dallas')).toBe('dallas');
    expect(deploySlug('Riverside #3')).toBe('riverside-3');
    expect(deploySlug(' Chicago ')).toBe('chicago');
  });
});

describe('wantedFor and validateTree', () => {
  const tree = [
    f('overrides/left4dead/cfg/pug_match.cfg', 's1'),
    f('overrides/left4dead/cfg/local.cfg', 'shared-local'),
    f('boxes/chicago/left4dead/cfg/local.cfg', 'chi-local'),
    f('boxes/dallas/left4dead/cfg/server.cfg', 'dal-server'),
    f('deploy.sh', 'x'),
  ];
  it('maps overrides and the box layer, box wins, other boxes and repo files ignored', () => {
    const chi = wantedFor(tree, 'chicago');
    expect([...chi.keys()].sort()).toEqual(['left4dead/cfg/local.cfg', 'left4dead/cfg/pug_match.cfg']);
    expect(chi.get('left4dead/cfg/local.cfg')).toMatchObject({ sha256: 'chi-local', layer: 'box' });
    expect(wantedFor(tree, 'dallas').get('left4dead/cfg/local.cfg')).toMatchObject({ sha256: 'shared-local', layer: 'shared' });
  });
  it('refuses secrets, symlinks, unmanaged paths and oversized files', () => {
    expect(validateTree(tree)).toEqual([]);
    expect(validateTree([
      f('overrides/left4dead/cfg/secrets.cfg'),
      f('boxes/dallas/left4dead/cfg/link.cfg', 'h', '120000'),
      f('overrides/left4dead/maps/x.bsp'),
      f('overrides/left4dead/addons/sourcemod/plugins/big.smx', 'h', '100644', 30 * 1024 * 1024),
    ])).toEqual([
      'secrets.cfg is never deployed: left4dead/cfg/secrets.cfg',
      'symlink: boxes/dallas/left4dead/cfg/link.cfg',
      'outside the managed folders: left4dead/maps/x.bsp',
      'over 20 MB: left4dead/addons/sourcemod/plugins/big.smx',
    ]);
  });
});

describe('planBox', () => {
  const W = (sha: string) => ({ path: '', size: 1, sha256: sha, blob: `blob-${sha}`, layer: 'shared' as const });
  it('adds, updates, and deletes only what was shipped before', () => {
    const wanted = new Map([['left4dead/cfg/a.cfg', { ...W('new'), path: 'left4dead/cfg/a.cfg' }], ['left4dead/cfg/b.cfg', { ...W('b'), path: 'left4dead/cfg/b.cfg' }]]);
    const onBox = new Map([
      ['left4dead/cfg/a.cfg', { size: 1, sha256: 'old' }],
      ['left4dead/cfg/gone.cfg', { size: 1, sha256: 'g' }],
      ['left4dead/cfg/handmade.cfg', { size: 1, sha256: 'hm' }],
    ]);
    const shipped = new Map([['left4dead/cfg/gone.cfg', { sha256: 'g', blob: 'x' }], ['left4dead/cfg/a.cfg', { sha256: 'old', blob: 'y' }]]);
    const ops = planBox(wanted, onBox, shipped);
    expect(ops).toEqual([
      { path: 'left4dead/cfg/b.cfg', op: 'write', kind: 'add', size: 1, sha256: 'b', blob: 'blob-b' },
      { path: 'left4dead/cfg/a.cfg', op: 'write', kind: 'update', size: 1, sha256: 'new', blob: 'blob-new' },
      { path: 'left4dead/cfg/gone.cfg', op: 'remove' },
    ]);
    expect(planBox(wanted, new Map([['left4dead/cfg/a.cfg', { size: 1, sha256: 'new' }], ['left4dead/cfg/b.cfg', { size: 1, sha256: 'b' }]]), new Map())).toEqual([]);
  });
});

describe('wording', () => {
  it('describes ops in plain words', () => {
    const ops: Op[] = [
      { path: 'left4dead/addons/sourcemod/plugins/l4d_skypounce.smx', op: 'write', kind: 'update', size: 1, sha256: 'x', blob: 'b' },
      { path: 'left4dead/addons/sourcemod/plugins/specrates.smx', op: 'remove' },
      { path: 'left4dead/cfg/local.cfg', op: 'write', kind: 'update', size: 1, sha256: 'x', blob: 'b' },
      { path: 'left4dead/addons/sourcemod/gamedata/x.txt', op: 'write', kind: 'add', size: 1, sha256: 'x', blob: 'b' },
    ];
    expect(describeOps(ops)).toEqual([
      'plugin updated: l4d_skypounce', 'plugin removed: specrates',
      'cfg changed: cfg/local.cfg', 'file added: addons/sourcemod/gamedata/x.txt',
    ]);
  });
  it('diffs cvar lines, ignoring comments and commands', () => {
    const old = '// c\nz_tank_health 8000\nsm_cvar z_witch_health "1000"\nexec other.cfg\nz_gone 1\n';
    const neu = 'z_tank_health "7500" // lower\nsm_cvar z_witch_health "1000"\nexec other.cfg\nz_new 5\n';
    expect(cvarDiff(old, neu)).toEqual(['z_tank_health 8000 → 7500', 'z_new set to 5', 'z_gone no longer set']);
  });
  it('suggests not balance only for non-balance plugins with no watched cvar or file', () => {
    const k = { cvars: [{ cvar: 'z_tank_health' }], files: [{ path: 'cfg/pug_match.cfg' }], dirs: [], versionless: ['pug-match.smx'], ignored: ['l4d_tvwatch.smx'] };
    const tv: Op = { path: 'left4dead/addons/sourcemod/plugins/l4d_tvwatch.smx', op: 'write', kind: 'update', size: 1, sha256: 'x', blob: 'b' };
    const pm: Op = { ...tv, path: 'left4dead/addons/sourcemod/plugins/pug-match.smx' };
    const sky: Op = { ...tv, path: 'left4dead/addons/sourcemod/plugins/l4d_skypounce.smx' };
    const cfg: Op = { ...tv, path: 'left4dead/cfg/pug_match.cfg' };
    expect(suggestBalance([[tv, pm]], [], k)).toBe('not_balance');
    expect(suggestBalance([[sky]], [], k)).toBe('possibly_balance');
    expect(suggestBalance([[cfg]], [], k)).toBe('possibly_balance');
    expect(suggestBalance([[tv]], ['z_tank_health'], k)).toBe('possibly_balance');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/releaseStage.ts`**

```ts
import type { RepoFile } from './deployRepo.js';
import type { FileSig } from './fleetCompare.js';
import { isManaged, SIZE_CAP } from './fleetTree.js';

/** Staging a release: pure functions from a repo tree and the fleet readings.
 *  docs/superpowers/specs/2026-09-24-release-deploy-design.md */

export function deploySlug(name: string): string {
  return name.trim().toLowerCase().replace(/#/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export interface WantedFile { path: string; size: number; sha256: string; blob: string; layer: 'shared' | 'box' }

/** Repo path to game-dir path and layer, or null for anything else in the repo. */
function mapPath(repoPath: string): { path: string; layer: 'shared' } | { path: string; layer: 'box'; slug: string } | null {
  if (repoPath.startsWith('overrides/')) return { path: repoPath.slice('overrides/'.length), layer: 'shared' };
  const m = /^boxes\/([^/]+)\/(.+)$/.exec(repoPath);
  return m ? { path: m[2], layer: 'box', slug: m[1] } : null;
}

export function wantedFor(files: RepoFile[], slug: string): Map<string, WantedFile> {
  const out = new Map<string, WantedFile>();
  for (const layer of ['shared', 'box'] as const) {
    for (const f of files) {
      const m = mapPath(f.path);
      if (!m || m.layer !== layer || (m.layer === 'box' && m.slug !== slug)) continue;
      out.set(m.path, { path: m.path, size: f.size, sha256: f.sha256, blob: f.blob, layer });
    }
  }
  return out;
}

export function validateTree(files: RepoFile[]): string[] {
  const reasons: string[] = [];
  for (const f of files) {
    const m = mapPath(f.path);
    if (!m) continue;
    const base = m.path.split('/').pop();
    if (base === 'secrets.cfg') reasons.push(`secrets.cfg is never deployed: ${m.path}`);
    else if (f.mode === '120000') reasons.push(`symlink: ${f.path}`);
    else if (!isManaged(m.path)) reasons.push(`outside the managed folders: ${m.path}`);
    else if (f.size > SIZE_CAP) reasons.push(`over 20 MB: ${m.path}`);
  }
  return reasons;
}

export type Op =
  | { path: string; op: 'write'; kind: 'add' | 'update'; size: number; sha256: string; blob?: string; backupFrom?: { releaseId: number; serverId: number } }
  | { path: string; op: 'remove' };

const same = (a: FileSig, sha: string, size: number) => (a.sha256 !== null ? a.sha256 === sha : a.size === size);

/** Adds first, then updates, then deletions; each group in path order. A
 *  deletion is only ever of a file the repo shipped to this box before. */
export function planBox(wanted: Map<string, WantedFile>, onBox: Map<string, FileSig>, shipped: Map<string, { sha256: string; blob: string }>): Op[] {
  const adds: Op[] = [], updates: Op[] = [], deletes: Op[] = [];
  for (const w of [...wanted.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const have = onBox.get(w.path);
    if (!have) adds.push({ path: w.path, op: 'write', kind: 'add', size: w.size, sha256: w.sha256, blob: w.blob });
    else if (!same(have, w.sha256, w.size)) updates.push({ path: w.path, op: 'write', kind: 'update', size: w.size, sha256: w.sha256, blob: w.blob });
  }
  for (const p of [...shipped.keys()].sort()) if (!wanted.has(p) && onBox.has(p)) deletes.push({ path: p, op: 'remove' });
  return [...adds, ...updates, ...deletes];
}

const PLUGIN_DIR = 'left4dead/addons/sourcemod/plugins/';

export function describeOps(ops: Op[]): string[] {
  return ops.map((o) => {
    const rel = o.path.replace(/^left4dead\//, '');
    const what = o.op === 'remove' ? 'removed' : o.kind === 'add' ? 'added' : 'updated';
    if (o.path.startsWith(PLUGIN_DIR) && o.path.endsWith('.smx')) {
      const name = o.path.slice(PLUGIN_DIR.length).replace(/\.smx$/, '');
      return `plugin ${what}: ${name}`;
    }
    if (o.path.endsWith('.cfg')) return o.op === 'remove' ? `cfg removed: ${rel}` : o.kind === 'add' ? `cfg added: ${rel}` : `cfg changed: ${rel}`;
    return `file ${what}: ${rel}`;
  });
}

const NOT_CVARS = new Set(['exec', 'echo', 'alias', 'say', 'sm', 'writeid', 'writeip', 'log', 'bind', 'wait']);
function cvarsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const m = /^(?:sm_cvar\s+)?([A-Za-z_][\w]*)\s+"?([^"\s]*)"?/.exec(line);
    if (m && !NOT_CVARS.has(m[1]) && m[2] !== '') out.set(m[1], m[2]);
  }
  return out;
}

export function cvarDiff(oldText: string, newText: string): string[] {
  const a = cvarsOf(oldText), b = cvarsOf(newText);
  const out: string[] = [];
  for (const [k, v] of b) {
    if (!a.has(k)) continue;
    if (a.get(k) !== v) out.push(`${k} ${a.get(k)} → ${v}`);
  }
  for (const [k, v] of b) if (!a.has(k)) out.push(`${k} set to ${v}`);
  for (const k of a.keys()) if (!b.has(k)) out.push(`${k} no longer set`);
  return out;
}

export function suggestBalance(ops: Op[][], changedCvars: string[], knobs: {
  cvars: { cvar: string }[]; files: { path: string }[]; dirs: { path: string }[]; versionless: string[]; ignored?: string[];
} | null): 'not_balance' | 'possibly_balance' {
  if (!knobs) return 'possibly_balance';
  const watched = new Set(knobs.cvars.map((c) => c.cvar));
  if (changedCvars.some((c) => watched.has(c))) return 'possibly_balance';
  const quiet = new Set([...knobs.versionless, ...(knobs.ignored ?? [])]);
  for (const o of ops.flat()) {
    const rel = o.path.replace(/^left4dead\//, '');
    if (knobs.files.some((f) => f.path === rel) || knobs.dirs.some((d) => rel.startsWith(`${d.path}/`))) return 'possibly_balance';
    if (o.path.startsWith(PLUGIN_DIR) && o.path.endsWith('.smx') && !quiet.has(o.path.slice(PLUGIN_DIR.length))) return 'possibly_balance';
  }
  return 'not_balance';
}
```

(`suggestBalance` treats any non-plugin, non-watched file as not balance-relevant; a changed `.cfg` counts through `changedCvars` or `knobs.files`.)

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `git commit -m "releases: staging, per-box plans, wording and the balance suggestion"`

---

### Task 4: Tree writers (`src/fleetWrite.ts`)

**Files:**
- Create: `src/fleetWrite.ts`
- Test: `tests/fleetWrite.test.ts`

**Interfaces:**
- Produces:
  - `interface TreeWriter { kind: 'local' | 'sftp' | 'ftp'; read(path): Promise<Buffer | null>; write(path, bytes: Buffer): Promise<void>; remove(path): Promise<void>; hash(paths: string[]): Promise<Map<string, string | null>> }`
  - `assertWritable(path)` (throws unless `isManaged(path)` and basename is not `secrets.cfg`)
  - `localTreeWriter(gameDir)`, `sftpTreeWriter(cfg & { runIn?: (cmd, args, input?: Buffer) => Promise<Buffer> })`, `ftpTreeWriter(cfg & { client?: () => FtpWriteClient })`, `treeWriterFor(server): TreeWriter | null`

- [ ] **Step 1: Failing test**

```ts
// tests/fleetWrite.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWritable, ftpTreeWriter, localTreeWriter, sftpTreeWriter } from '../src/fleetWrite.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const P = 'left4dead/cfg/new/a.cfg';

describe('assertWritable', () => {
  it('allows managed paths only, never secrets.cfg', () => {
    expect(() => assertWritable(P)).not.toThrow();
    expect(() => assertWritable('left4dead/cfg/secrets.cfg')).toThrow();
    expect(() => assertWritable('left4dead/maps/x.bsp')).toThrow();
    expect(() => assertWritable('left4dead/cfg/../../etc/passwd')).toThrow();
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
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/fleetWrite.ts`**

```ts
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
  const common = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', cfg.keyPath];
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
```



- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `git commit -m "releases: tree writers for local, sftp and FTP boxes"`

---

### Task 5: `ReleaseEngine`

**Files:**
- Create: `src/releaseEngine.ts`
- Test: `tests/releaseEngine.test.ts`

**Interfaces:**
- Consumes: `TreeWriter` (Task 4), `Op` (Task 3), `ServerRestarter`, `getServer`, `release` (`serverPool.ts`), `publishAdminEvent`.
- Produces:
  - `class ReleaseEngine` with
    - `constructor(deps: { db; blob: (id: string) => Promise<Buffer>; writer?: (s: ServerRow) => TreeWriter | null; restarter: ServerRestarter | null; humans?: (s: ServerRow) => Promise<number>; releasesDir: string; devMode: boolean; now?: () => string; sleep?: (ms: number) => Promise<void>; emptyWaitMs?: number; emptyPollMs?: number; tickMs?: number })`
    - `inFlight(): number | null`
    - `deploy(id, p: { targets: number[]; canary: number | null; balance: { decision: 'balance' | 'not_balance' | 'later'; name?: unknown; notes?: unknown }; adminId: string }): { ok: true } | { ok: false; status: 400 | 404 | 409; error: string }`
    - `continueRelease(id, adminId)`: same result type
    - `undo(id, serverIds: number[] | null, adminId): { ok: true; id: number } | { ok: false; status; error }`
    - `tick(): Promise<void>` (drives the in-flight release; serialised)
    - `forRelease(serverId): Promise<void>` (the ServerReleaser before-restart hook)
    - `recover(): void` (boot: interrupted `writing` boxes become `failed`, their hold is lifted when no match holds the box)
    - `expireBackups(nowMs?: number): number`
    - `start()`, `stop()`

- [ ] **Step 1: Failing test** (fake writer over an in-memory map per server; fake restarter)

```ts
// tests/releaseEngine.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { addServer, getServer } from '../src/serverPool.js';
import { ReleaseEngine } from '../src/releaseEngine.js';
import type { TreeWriter } from '../src/fleetWrite.js';
import type { Op } from '../src/releaseStage.js';

type DB = ReturnType<typeof openDb>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const A = 'left4dead/cfg/a.cfg', B = 'left4dead/cfg/b.cfg';

function box(files: Record<string, string>, fail: { on?: 'write' | 'hash'; path?: string } = {}) {
  const fs = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  const w: TreeWriter = {
    kind: 'local',
    read: async (p) => fs.get(p) ?? null,
    write: async (p, b) => { if (fail.on === 'write' && (!fail.path || fail.path === p)) throw new Error('disk full'); fs.set(p, b); },
    remove: async (p) => { fs.delete(p); },
    hash: async (ps) => new Map(ps.map((p) => [p, fail.on === 'hash' ? 'bad' : fs.has(p) ? sha(fs.get(p)!.toString()) : null])),
  };
  return { fs, w };
}

describe('ReleaseEngine', () => {
  let db: DB, dir: string, s1: number, s2: number;
  let boxes: Record<number, ReturnType<typeof box>>;
  let restarts: number[];
  const blobs: Record<string, string> = { ba: 'A2', bb: 'B1' };
  const plan: Op[] = [
    { path: A, op: 'write', kind: 'update', size: 2, sha256: sha('A2'), blob: 'ba' },
    { path: B, op: 'write', kind: 'add', size: 2, sha256: sha('B1'), blob: 'bb' },
  ];
  function stage(ops: Op[] = plan) {
    const id = Number(db.prepare("INSERT INTO releases (kind, sources_json, state, created_by, created_at) VALUES ('deploy', '[]', 'staged', '1', 'x')").run().lastInsertRowid);
    for (const s of [s1, s2]) db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, ?, 'staged', ?, '{}', 'x')").run(id, s, JSON.stringify(ops));
    return id;
  }
  const engine = (over: Partial<ConstructorParameters<typeof ReleaseEngine>[0]> = {}) => new ReleaseEngine({
    db, releasesDir: dir, devMode: false,
    blob: async (id) => Buffer.from(blobs[id]),
    writer: (s) => boxes[s.id].w,
    restarter: { restart: async (s) => { restarts.push(s.id); return true; } },
    humans: async () => 0, sleep: async () => {}, ...over,
  });
  const boxState = (id: number, s: number) => (db.prepare('SELECT state, error FROM release_boxes WHERE release_id = ? AND server_id = ?').get(id, s) as { state: string; error: string | null });
  const relState = (id: number) => (db.prepare('SELECT state FROM releases WHERE id = ?').get(id) as { state: string }).state;

  beforeEach(() => {
    db = openDb(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'rel-'));
    s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    boxes = { [s1]: box({ [A]: 'A1' }), [s2]: box({ [A]: 'A1' }) };
    restarts = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const later = { decision: 'later' as const };

  it('deploys to every target: backup, write, verify, restart, and the release is done', async () => {
    const e = engine();
    const id = stage();
    expect(e.deploy(id, { targets: [s1, s2], canary: null, balance: later, adminId: '1' })).toEqual({ ok: true });
    await e.tick();
    expect(boxes[s1].fs.get(A)!.toString()).toBe('A2');
    expect(boxes[s2].fs.get(B)!.toString()).toBe('B1');
    expect(boxState(id, s1).state).toBe('restarted');
    expect(restarts).toEqual([s1, s2]);
    expect(getServer(db, s1)!.status).toBe('idle');
    expect(relState(id)).toBe('done');
  });

  it('a failure restores the backup, marks the box failed without restart, and other boxes go on', async () => {
    boxes[s1] = box({ [A]: 'A1' }, { on: 'write', path: B });
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1, s2], canary: null, balance: later, adminId: '1' });
    await e.tick();
    expect(boxes[s1].fs.get(A)!.toString()).toBe('A1');
    expect(boxes[s1].fs.has(B)).toBe(false);
    expect(boxState(id, s1)).toEqual({ state: 'failed', error: expect.stringMatching(/disk full/) });
    expect(boxState(id, s2).state).toBe('restarted');
    expect(restarts).toEqual([s2]);
    expect(getServer(db, s1)!.status).toBe('idle');
  });

  it('a verify mismatch is a failure', async () => {
    boxes[s1] = box({ [A]: 'A1' }, { on: 'hash' });
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' });
    await e.tick();
    expect(boxState(id, s1).state).toBe('failed');
    expect(boxState(id, s2).state).toBe('skipped');
  });

  it('canary first: waits for continue; a failed canary halts the rest', async () => {
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1, s2], canary: s2, balance: later, adminId: '1' });
    await e.tick();
    expect(boxState(id, s2).state).toBe('restarted');
    expect(boxState(id, s1).state).toBe('pending');
    expect(relState(id)).toBe('canary_wait');
    await e.tick();
    expect(boxState(id, s1).state).toBe('pending');
    expect(e.continueRelease(id, '1')).toEqual({ ok: true });
    await e.tick();
    expect(boxState(id, s1).state).toBe('restarted');
    expect(relState(id)).toBe('done');

    boxes[s2] = box({ [A]: 'A2', [B]: 'B1' }, { on: 'write' });
    const id2 = stage([{ ...plan[0], sha256: sha('A2'), blob: 'ba' }]);
    boxes[s2].fs.set(A, Buffer.from('A1'));
    e.deploy(id2, { targets: [s1, s2], canary: s2, balance: later, adminId: '1' });
    await e.tick();
    expect(relState(id2)).toBe('halted');
    expect(boxState(id2, s1).state).toBe('skipped');
  });

  it('a busy box waits; its turn comes when idle, or through the release hook', async () => {
    db.prepare("UPDATE servers SET status = 'live' WHERE id = ?").run(s1);
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' });
    await e.tick();
    expect(boxState(id, s1).state).toBe('waiting');
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(s1); // the releaser is restarting it
    await e.forRelease(s1);
    expect(boxState(id, s1).state).toBe('restarted');
    expect(restarts).toEqual([]); // the releaser does the restart
  });

  it('waits for the box to empty, up to a limit, before restarting', async () => {
    let n = 2;
    const e = engine({ humans: async () => n--, emptyWaitMs: 10_000, emptyPollMs: 1 });
    const id = stage();
    e.deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' });
    await e.tick();
    expect(restarts).toEqual([s1]);
    expect(n).toBe(-1);
  });

  it('refuses in dev mode, a second in-flight release, bad targets and a nameless balance patch', () => {
    const id = stage();
    expect(engine({ devMode: true }).deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' })).toMatchObject({ ok: false, status: 409 });
    const e = engine();
    expect(e.deploy(id, { targets: [], canary: null, balance: later, adminId: '1' })).toMatchObject({ ok: false, status: 400 });
    expect(e.deploy(id, { targets: [99], canary: null, balance: later, adminId: '1' })).toMatchObject({ ok: false, status: 400 });
    expect(e.deploy(id, { targets: [s1], canary: null, balance: { decision: 'balance', name: ' ' }, adminId: '1' })).toMatchObject({ ok: false, status: 400 });
    expect(e.deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' })).toEqual({ ok: true });
    expect(e.deploy(stage(), { targets: [s1], canary: null, balance: later, adminId: '1' })).toMatchObject({ ok: false, status: 409 });
  });

  it('undo restores exactly: updated files back, added files removed', async () => {
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1, s2], canary: null, balance: later, adminId: '1' });
    await e.tick();
    const u = e.undo(id, [s1], '1');
    expect(u).toMatchObject({ ok: true });
    await e.tick();
    expect(boxes[s1].fs.get(A)!.toString()).toBe('A1');
    expect(boxes[s1].fs.has(B)).toBe(false);
    expect(boxes[s2].fs.get(A)!.toString()).toBe('A2'); // not undone
    expect(boxState(id, s1).state).toBe('undone');
    expect(e.expireBackups(Date.now() + 31 * 86_400_000)).toBe(2);
    expect(e.undo(id, [s2], '1')).toMatchObject({ ok: false, status: 409 });
  });

  it('recover marks an interrupted box failed and lifts its hold', () => {
    const id = stage();
    db.prepare("UPDATE releases SET state = 'deploying' WHERE id = ?").run(id);
    db.prepare("UPDATE release_boxes SET state = 'writing' WHERE release_id = ? AND server_id = ?").run(id, s1);
    db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(s1);
    engine().recover();
    expect(boxState(id, s1)).toEqual({ state: 'failed', error: expect.stringMatching(/interrupted/) });
    expect(getServer(db, s1)!.status).toBe('idle');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/releaseEngine.ts`**

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';
import { getServer, release as releaseServer, type ServerRow } from './serverPool.js';
import type { ServerRestarter } from './serverRestart.js';
import { treeWriterFor, type TreeWriter } from './fleetWrite.js';
import type { Op } from './releaseStage.js';

/**
 * Sends a staged release to the boxes, one box at a time: wait until idle,
 * hold, back up, write, verify, restart when empty. Any failure before the
 * restart puts the backups back and marks the box failed. See
 * docs/superpowers/specs/2026-09-24-release-deploy-design.md.
 */

type Result = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };
interface Row { id: number; kind: 'deploy' | 'undo'; undo_of: number | null; state: string; canary_server_id: number | null; deployed_at: string | null; backups_expired: number }
interface BoxRow { release_id: number; server_id: number; state: string; plan_json: string | null }

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const DONE = new Set(['written', 'restarted', 'confirmed', 'failed', 'skipped', 'undone']);
const OK = new Set(['written', 'restarted', 'confirmed']);
const LINK = { label: 'Deploy page', path: '/admin/setup/deploy' };
const BACKUP_DAYS = 30;

export class ReleaseEngine {
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: {
    db: DB;
    blob: (id: string) => Promise<Buffer>;
    writer?: (s: ServerRow) => TreeWriter | null;
    restarter: ServerRestarter | null;
    humans?: (s: ServerRow) => Promise<number>;
    releasesDir: string;
    devMode: boolean;
    now?: () => string;
    sleep?: (ms: number) => Promise<void>;
    emptyWaitMs?: number;
    emptyPollMs?: number;
    tickMs?: number;
  }) {}

  private now() { return (this.d.now ?? sqlNow)(); }
  private rel(id: number) { return this.d.db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as Row | undefined; }
  private boxes(id: number) {
    return this.d.db.prepare('SELECT release_id, server_id, state, plan_json FROM release_boxes WHERE release_id = ? ORDER BY server_id').all(id) as BoxRow[];
  }
  private setBox(id: number, sid: number, state: string, error: string | null = null) {
    this.d.db.prepare('UPDATE release_boxes SET state = ?, error = ?, updated_at = ? WHERE release_id = ? AND server_id = ?').run(state, error, this.now(), id, sid);
  }
  private setRel(id: number, state: string) { this.d.db.prepare('UPDATE releases SET state = ? WHERE id = ?').run(state, id); }

  inFlight(): number | null {
    return (this.d.db.prepare("SELECT id FROM releases WHERE state IN ('deploying','canary_wait') ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
  }

  deploy(id: number, p: { targets: number[]; canary: number | null; balance: { decision: string; name?: unknown; notes?: unknown }; adminId: string }): Result {
    if (this.d.devMode) return { ok: false, status: 409, error: 'deploys are disabled in dev mode' };
    const r = this.rel(id);
    if (!r) return { ok: false, status: 404, error: 'no such release' };
    if (r.state !== 'staged') return { ok: false, status: 409, error: `this release is ${r.state}` };
    if (this.inFlight() !== null) return { ok: false, status: 409, error: 'another release is still deploying' };
    const rows = this.boxes(id);
    const deployable = new Set(rows.filter((b) => b.plan_json !== null).map((b) => b.server_id));
    if (p.targets.length === 0 || p.targets.some((t) => !deployable.has(t))) return { ok: false, status: 400, error: 'pick at least one box that has a plan' };
    if (p.canary !== null && !p.targets.includes(p.canary)) return { ok: false, status: 400, error: 'the canary must be one of the targets' };
    const decision = p.balance.decision;
    if (!['balance', 'not_balance', 'later'].includes(decision)) return { ok: false, status: 400, error: 'balance decision is balance, not_balance or later' };
    const name = typeof p.balance.name === 'string' ? p.balance.name.trim() : '';
    const notes = typeof p.balance.notes === 'string' ? p.balance.notes.trim() : '';
    if (decision === 'balance' && !name) return { ok: false, status: 400, error: 'a balance patch needs a name' };
    if (name.length > 60) return { ok: false, status: 400, error: 'a patch name is up to 60 characters' };
    if (notes.length > 2000) return { ok: false, status: 400, error: 'notes are up to 2000 characters' };
    this.d.db.transaction(() => {
      this.d.db.prepare(`UPDATE releases SET state = 'deploying', canary_server_id = ?, balance_decision = ?, balance_name = ?, balance_notes = ?,
        deployed_by = ?, deployed_at = ? WHERE id = ?`).run(p.canary, decision, decision === 'balance' ? name : null, decision === 'balance' ? notes : null, p.adminId, this.now(), id);
      for (const b of rows) this.setBox(id, b.server_id, p.targets.includes(b.server_id) ? 'pending' : 'skipped');
    })();
    return { ok: true };
  }

  continueRelease(id: number, _adminId: string): Result {
    const r = this.rel(id);
    if (!r) return { ok: false, status: 404, error: 'no such release' };
    if (r.state !== 'canary_wait') return { ok: false, status: 409, error: 'this release is not waiting on its canary' };
    this.setRel(id, 'deploying');
    return { ok: true };
  }

  undo(id: number, serverIds: number[] | null, adminId: string): { ok: true; id: number } | { ok: false; status: 400 | 404 | 409; error: string } {
    if (this.d.devMode) return { ok: false, status: 409, error: 'undo is disabled in dev mode' };
    const r = this.rel(id);
    if (!r || r.kind !== 'deploy') return { ok: false, status: 404, error: 'no such release' };
    if (r.backups_expired) return { ok: false, status: 409, error: 'backups expired' };
    if (this.inFlight() !== null) return { ok: false, status: 409, error: 'another release is still deploying' };
    const reached = this.boxes(id).filter((b) => OK.has(b.state) && (serverIds === null || serverIds.includes(b.server_id)));
    if (reached.length === 0) return { ok: false, status: 400, error: 'none of those boxes has this release on it' };
    const uid = this.d.db.transaction(() => {
      const src = this.d.db.prepare('SELECT sources_json FROM releases WHERE id = ?').get(id) as { sources_json: string };
      const newId = Number(this.d.db.prepare(`INSERT INTO releases (kind, undo_of, sources_json, state, created_by, created_at, deployed_by, deployed_at)
        VALUES ('undo', ?, ?, 'deploying', ?, ?, ?, ?)`).run(id, src.sources_json, adminId, this.now(), adminId, this.now()).lastInsertRowid);
      for (const b of reached) {
        const manifest = JSON.parse(readFileSync(join(this.d.releasesDir, String(id), String(b.server_id), 'backup.json'), 'utf8')) as { path: string; existed: boolean }[];
        const ops: Op[] = manifest.map((m) => {
          if (!m.existed) return { path: m.path, op: 'remove' as const };
          const bytes = readFileSync(join(this.d.releasesDir, String(id), String(b.server_id), 'files', m.path));
          return { path: m.path, op: 'write' as const, kind: 'update' as const, size: bytes.length, sha256: sha256(bytes), backupFrom: { releaseId: id, serverId: b.server_id } };
        });
        this.d.db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, ?, 'pending', ?, '{}', ?)")
          .run(newId, b.server_id, JSON.stringify(ops), this.now());
      }
      return newId;
    })();
    return { ok: true, id: uid };
  }

  tick(): Promise<void> {
    this.chain = this.chain.then(() => this.drive(null)).catch((err) => console.error('[releases] tick failed:', err));
    return this.chain;
  }

  /** The ServerReleaser's before-restart hook: this box has just finished a
   *  match; give it its turn now, before the releaser restarts it. */
  forRelease(serverId: number): Promise<void> {
    this.chain = this.chain.then(() => this.drive(serverId)).catch((err) => console.error('[releases] release hook failed:', err));
    return this.chain;
  }

  private async drive(onlyServer: number | null): Promise<void> {
    const id = this.inFlight();
    if (id === null) return;
    const r = this.rel(id)!;
    if (r.state !== 'deploying') return;
    const rows = this.boxes(id);
    const canary = r.canary_server_id;
    const order = [...rows].sort((a, b) => Number(b.server_id === canary) - Number(a.server_id === canary) || a.server_id - b.server_id);
    const canaryRow = canary === null ? null : rows.find((b) => b.server_id === canary)!;
    for (const b of order) {
      if (canaryRow && b.server_id !== canary && !DONE.has(this.boxState(id, canary!))) break;
      if (onlyServer !== null && b.server_id !== onlyServer) continue;
      const st = this.boxState(id, b.server_id);
      if (st !== 'pending' && st !== 'waiting') continue;
      await this.runBox(r, b, onlyServer !== null);
      if (b.server_id === canary) {
        const cs = this.boxState(id, canary);
        if (cs === 'failed') {
          for (const o of rows) if (o.server_id !== canary && ['pending', 'waiting'].includes(this.boxState(id, o.server_id))) this.setBox(id, o.server_id, 'skipped');
          this.setRel(id, 'halted');
          publishAdminEvent({ kind: 'problem', text: `Release ${id}: the canary failed, so no other box got it.`, link: LINK });
          return;
        }
        if (OK.has(cs) && rows.some((o) => ['pending', 'waiting'].includes(this.boxState(id, o.server_id)))) {
          this.setRel(id, 'canary_wait');
          publishAdminEvent({ kind: 'problem', text: `Release ${id}: the canary box has it. Check it, then press Continue for the rest.`, link: LINK });
          return;
        }
      }
    }
    this.settle(id);
  }

  private boxState(id: number, sid: number): string {
    return (this.d.db.prepare('SELECT state FROM release_boxes WHERE release_id = ? AND server_id = ?').get(id, sid) as { state: string }).state;
  }

  private settle(id: number): void {
    const states = this.boxes(id).map((b) => b.state);
    if (!states.every((s) => DONE.has(s))) return;
    this.setRel(id, 'done');
    const r = this.rel(id)!;
    if (r.kind === 'undo' && r.undo_of !== null) {
      for (const b of this.boxes(id)) if (OK.has(b.state)) this.setBox(r.undo_of, b.server_id, 'undone');
    }
  }

  private async runBox(r: Row, b: BoxRow, viaRelease: boolean): Promise<void> {
    const db = this.d.db;
    const s = getServer(db, b.server_id);
    if (!s || s.enabled !== 1) { this.setBox(r.id, b.server_id, 'failed', 'the box is disabled'); return; }
    const releaserRestarting = viaRelease && s.status === 'offline';
    if (!releaserRestarting && s.status !== 'idle' && s.status !== 'offline') { this.setBox(r.id, b.server_id, 'waiting'); return; }
    const writer = (this.d.writer ?? treeWriterFor)(s);
    if (!writer) { this.setBox(r.id, b.server_id, 'failed', 'no transport configured'); return; }
    const held = s.status === 'idle';
    if (held) db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(s.id);
    const unhold = () => { if (held) releaseServer(db, s.id); };
    this.setBox(r.id, b.server_id, 'writing');

    const ops = JSON.parse(b.plan_json!) as Op[];
    const dir = join(this.d.releasesDir, String(r.id), String(s.id));
    const backup: { path: string; existed: boolean }[] = [];
    try {
      for (const o of ops) {
        const bytes = await writer.read(o.path);
        if (bytes) { mkdirSync(dirname(join(dir, 'files', o.path)), { recursive: true }); writeFileSync(join(dir, 'files', o.path), bytes); }
        backup.push({ path: o.path, existed: bytes !== null });
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'backup.json'), JSON.stringify(backup));
      for (const o of ops) {
        if (o.op === 'remove') { await writer.remove(o.path); continue; }
        const bytes = o.blob ? await this.d.blob(o.blob)
          : readFileSync(join(this.d.releasesDir, String(o.backupFrom!.releaseId), String(o.backupFrom!.serverId), 'files', o.path));
        if (sha256(bytes) !== o.sha256) throw new Error(`content for ${o.path} does not match its hash`);
        await writer.write(o.path, bytes);
      }
      const h = await writer.hash(ops.map((o) => o.path));
      for (const o of ops) {
        const got = h.get(o.path) ?? null;
        if (o.op === 'remove' ? got !== null : got !== o.sha256) throw new Error(`verify failed for ${o.path}`);
      }
    } catch (err) {
      let error = err instanceof Error ? err.message : String(err);
      try {
        for (const e of backup) {
          if (e.existed) await writer.write(e.path, readFileSync(join(dir, 'files', e.path)));
          else await writer.remove(e.path);
        }
      } catch (e2) {
        error += `; restoring the backup also failed: ${e2 instanceof Error ? e2.message : String(e2)}`;
      }
      this.setBox(r.id, s.id, 'failed', error);
      unhold();
      publishAdminEvent({ kind: 'problem', text: `Release ${r.id} failed on ${s.name}: ${error}. Its files were put back; it was not restarted.`, link: LINK });
      return;
    }
    this.setBox(r.id, s.id, 'written');
    if (releaserRestarting) { this.setBox(r.id, s.id, 'restarted'); return; }
    if (!this.d.restarter) { unhold(); return; }
    await this.waitEmpty(s);
    if (await this.d.restarter.restart(s)) {
      releaseServer(db, s.id);
      this.setBox(r.id, s.id, 'restarted');
    } else {
      // The restarter has already reported it and the box stays offline.
      this.setBox(r.id, s.id, 'written', 'written, but the box did not come back after the restart');
    }
  }

  private async waitEmpty(s: ServerRow): Promise<void> {
    if (!this.d.humans) return;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const limit = this.d.emptyWaitMs ?? 10 * 60_000, poll = this.d.emptyPollMs ?? 60_000;
    for (let waited = 0; waited < limit; waited += poll) {
      let n = 0;
      try { n = await this.d.humans(s); } catch { return; }
      if (n <= 0) return;
      await sleep(poll);
    }
  }

  recover(): void {
    const db = this.d.db;
    const stuck = db.prepare("SELECT release_id, server_id FROM release_boxes WHERE state = 'writing'").all() as { release_id: number; server_id: number }[];
    for (const b of stuck) {
      this.setBox(b.release_id, b.server_id, 'failed', 'interrupted by a site restart; check the box (its backup is on disk)');
      db.prepare(`UPDATE servers SET status = 'idle' WHERE id = ? AND status = 'reserved'
        AND NOT EXISTS (SELECT 1 FROM matches WHERE server_id = ? AND state IN ('configuring','live'))`).run(b.server_id, b.server_id);
    }
  }

  expireBackups(nowMs: number = Date.now()): number {
    const cutoff = new Date(nowMs - BACKUP_DAYS * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    const old = this.d.db.prepare("SELECT id FROM releases WHERE backups_expired = 0 AND deployed_at IS NOT NULL AND deployed_at < ? AND state NOT IN ('deploying','canary_wait')").all(cutoff) as { id: number }[];
    for (const r of old) {
      rmSync(join(this.d.releasesDir, String(r.id)), { recursive: true, force: true });
      this.d.db.prepare('UPDATE releases SET backups_expired = 1 WHERE id = ?').run(r.id);
    }
    return old.length;
  }

  start(): void {
    if (this.timer) return;
    this.recover();
    this.timer = setInterval(() => { void this.tick(); this.expireBackups(); }, this.d.tickMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
```

(The undo test's `expireBackups` expects 2: the deploy and the undo, both deployed "now", looked at 31 days later. The undo row then refuses with `backups expired`.)

- [ ] **Step 4: Run, expect PASS.** Fix only what the tests show; keep the order of operations above.
- [ ] **Step 5: Commit** `git commit -m "releases: the deploy engine (hold, backup, write, verify, restart, canary, undo)"`

---

### Task 6: Balance link

**Files:**
- Create: `src/releaseBalance.ts`
- Modify: `src/balancePatches.ts` (`recordBalanceSighting` returns `previousPatchId`; `PatchSummary.releaseId`), `src/server.ts` (call after each sighting), `web/src/api.ts`, `web/src/routes/admin/TriageCard.tsx`
- Test: `tests/releaseBalance.test.ts`, `web/src/routes/admin/AdminPatches.test.tsx`

**Interfaces:**
- Produces: `linkReleaseSighting(db, s: { serverId: number; patchId: number; previousPatchId: number | null }): void`; `recordBalanceSighting` result gains `previousPatchId: number | null` (the server's `balance_server_state.patch_id` before this sighting); `PatchSummary.releaseId: number | null`.

- [ ] **Step 1: Failing test**

```ts
// tests/releaseBalance.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { linkReleaseSighting } from '../src/releaseBalance.js';

type DB = ReturnType<typeof openDb>;
describe('linkReleaseSighting', () => {
  let db: DB, s1: number, rel: number, prev: number, next: number;
  const release = (decision: string, name: string | null = null) => {
    rel = Number(db.prepare(`INSERT INTO releases (kind, sources_json, state, created_by, created_at, balance_decision, balance_name, balance_notes)
      VALUES ('deploy', '[]', 'done', '1', 'x', ?, ?, 'why')`).run(decision, name).lastInsertRowid);
    db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, ?, 'restarted', '[]', '{}', 'x')").run(rel, s1);
  };
  beforeEach(() => {
    db = openDb(':memory:');
    s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    prev = Number(db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage, name) VALUES ('p', 'detected', '{}', 'a', 'balance', 'Base')").run().lastInsertRowid);
    next = Number(db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage) VALUES ('n', 'detected', '{}', 'b', 'pending')").run().lastInsertRowid);
  });
  const patch = (id: number) => db.prepare('SELECT name, triage, folded_into, release_id FROM balance_patches WHERE id = ?').get(id);
  const boxState = () => (db.prepare('SELECT state FROM release_boxes WHERE release_id = ?').get(rel) as { state: string }).state;

  it('balance names the new patch and confirms the box', () => {
    release('balance', 'Tank 7500');
    linkReleaseSighting(db, { serverId: s1, patchId: next, previousPatchId: prev });
    expect(patch(next)).toEqual({ name: 'Tank 7500', triage: 'balance', folded_into: null, release_id: rel });
    expect(boxState()).toBe('confirmed');
  });
  it('not balance folds it into the previous patch', () => {
    release('not_balance');
    linkReleaseSighting(db, { serverId: s1, patchId: next, previousPatchId: prev });
    expect(patch(next)).toMatchObject({ triage: 'folded', folded_into: prev, release_id: rel });
  });
  it('later leaves it pending but tagged', () => {
    release('later');
    linkReleaseSighting(db, { serverId: s1, patchId: next, previousPatchId: prev });
    expect(patch(next)).toMatchObject({ triage: 'pending', release_id: rel });
  });
  it('same fingerprint as before confirms the box and touches no patch', () => {
    release('balance', 'X');
    linkReleaseSighting(db, { serverId: s1, patchId: prev, previousPatchId: prev });
    expect(boxState()).toBe('confirmed');
    expect(patch(prev)).toMatchObject({ name: 'Base', release_id: null });
  });
  it('nothing to do without a written release on the box', () => {
    linkReleaseSighting(db, { serverId: s1, patchId: next, previousPatchId: prev });
    expect(patch(next)).toMatchObject({ triage: 'pending', release_id: null });
  });
});
```

Add to `AdminPatches.test.tsx` (triage describe): a pending patch with `releaseId: 7` shows `/from release 7/`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`src/releaseBalance.ts`:

```ts
import type { DB } from './db.js';
import { foldInto, resolvePatch } from './balanceFold.js';

/** A box written by a release reports its first match: confirm the box, and
 *  apply the release's balance decision to the new fingerprint, if any. */
export function linkReleaseSighting(db: DB, s: { serverId: number; patchId: number; previousPatchId: number | null }): void {
  const row = db.prepare(`SELECT rb.release_id, r.balance_decision, r.balance_name, r.balance_notes
    FROM release_boxes rb JOIN releases r ON r.id = rb.release_id
    WHERE rb.server_id = ? AND r.kind = 'deploy' AND rb.state IN ('written','restarted')
    ORDER BY rb.release_id DESC LIMIT 1`).get(s.serverId) as
    { release_id: number; balance_decision: string | null; balance_name: string | null; balance_notes: string | null } | undefined;
  if (!row) return;
  db.transaction(() => {
    db.prepare("UPDATE release_boxes SET state = 'confirmed' WHERE release_id = ? AND server_id = ?").run(row.release_id, s.serverId);
    if (s.previousPatchId === s.patchId) return;
    const p = db.prepare('SELECT triage, release_id FROM balance_patches WHERE id = ?').get(s.patchId) as { triage: string | null; release_id: number | null } | undefined;
    if (!p) return;
    if (p.release_id === null) db.prepare('UPDATE balance_patches SET release_id = ? WHERE id = ?').run(row.release_id, s.patchId);
    if (p.triage !== 'pending') return;
    if (row.balance_decision === 'balance') {
      db.prepare("UPDATE balance_patches SET triage = 'balance', name = ?, notes = ?, reviewed = 1 WHERE id = ?")
        .run(row.balance_name, row.balance_notes ?? '', s.patchId);
    } else if (row.balance_decision === 'not_balance' && s.previousPatchId !== null) {
      const target = resolvePatch(db, s.previousPatchId);
      if (target !== s.patchId) foldInto(db, s.patchId, target);
    }
  })();
}
```

`src/balancePatches.ts`: return `previousPatchId: prev?.patch_id ?? null` from `recordBalanceSighting` (add to the result type with a doc line); `listPatches` selects `p.release_id` and maps `releaseId: r.release_id`; `PatchSummary` gains `/** The release that produced this config, when one did. */ releaseId: number | null;`.

`src/server.ts`, in the `balance_end` handler after `confirmOnSighting(...)`:

```ts
            if (serverId !== null) linkReleaseSighting(deps.db, { serverId, patchId: r.patchId, previousPatchId: r.previousPatchId });
```

(import `linkReleaseSighting` from `./releaseBalance.js`).

Web: `PatchSummary.releaseId?: number | null` in `api.ts`; `TriageCard` adds after the "Compared with" paragraph: `{patch.releaseId != null && <p class="muted">From release {patch.releaseId}.</p>}`.

- [ ] **Step 4: Run** `npx vitest run tests/releaseBalance.test.ts tests/balance*.test.ts web/src/routes/admin/AdminPatches.test.tsx`, expect PASS.
- [ ] **Step 5: Commit** `git commit -m "releases: apply a release's balance decision to the first new fingerprint"`

---

### Task 7: Routes, wiring, player count

**Files:**
- Create: `src/routes/adminReleases.ts`, `src/releaseService.ts` (staging and review, used by the routes)
- Modify: `src/server.ts`, `src/serverRestart.ts` (`humansOn`)
- Test: `tests/releaseRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 6; `readingsOf`, `readingStates`; `loadBalanceKnobs`.
- Produces:
  - `parseHumans(statusText: string): number` and `humansOn(server): Promise<number>` in `serverRestart.ts` (rcon `status`, `players : N`).
  - `class ReleaseService` (`src/releaseService.ts`): `constructor(deps: { db; repo: DeployRepo; knobs: BalanceKnobs | null; now?: () => string })`, `stage(commit: string, adminId: string): Promise<{ ok: true; id: number } | { ok: false; status: 400 | 404; error: string }>`, `review(id): Promise<ReleaseReview | null>`, `list(): ReleaseSummary[]`, `lastShipped(serverId): { releaseId: number; files: Map<string, { sha256: string; blob: string }> } | null`
  - `ReleaseSummary = { id; kind; undoOf; commit: string; short: string; state; createdBy; createdAt; deployedBy; deployedAt; canaryServerId; balance: { decision; name; notes } | null; backupsExpired: boolean; boxes: { serverId; name; state; error; updatedAt }[] }`
  - `ReleaseReview = ReleaseSummary & { subject: string | null; github: string | null; invalid: string[]; suggestion: 'not_balance' | 'possibly_balance'; perBox: { serverId; name; lines: string[]; warnings: string[]; deployable: boolean }[]; groups: { servers: string[]; lines: string[] }[] }`
  - Routes (admin only):
    - `GET /api/admin/releases` → `{ commits: (RepoCommit & { releaseId: number | null })[]; releases: ReleaseSummary[]; inFlight: number | null; devMode: boolean; fetchError: string | null }`
    - `POST /api/admin/releases/refresh` → same as GET after a forced fetch
    - `POST /api/admin/releases/stage` `{ commit }` → `{ id }` (audit `release_stage`)
    - `GET /api/admin/releases/:id` → `ReleaseReview`
    - `POST /api/admin/releases/:id/deploy` `{ targets, canary, balance }` → `{ ok: true }` (audit `release_deploy`)
    - `POST /api/admin/releases/:id/continue` (audit `release_continue`)
    - `POST /api/admin/releases/:id/undo` `{ servers?: number[] }` → `{ id }` (audit `release_undo`)

- [ ] **Step 1: Failing test** (local git fixture as the "GitHub" repo; fake writers; `devMode: false` config via `loadConfig({ DEV_MODE: '0' })` or the project's equivalent, checked in `tests/helpers.ts`)

```ts
// tests/releaseRoutes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { parseHumans } from '../src/serverRestart.js';
import type { TreeWriter } from '../src/fleetWrite.js';

const ADMIN = '76561198000000009';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const CFG = 'left4dead/cfg/pug_match.cfg';

describe('parseHumans', () => {
  it('reads the player count from status', () => {
    expect(parseHumans('hostname: x\nplayers : 3 (8 max)\n')).toBe(3);
    expect(parseHumans('players : 0 humans, 4 bots (8 max)')).toBe(0);
    expect(parseHumans('nothing')).toBe(0);
  });
});

describe('release routes', () => {
  let root: string, work: string, db: ReturnType<typeof openDb>;
  const files = new Map<string, Buffer>();
  const writer: TreeWriter = {
    kind: 'local', read: async (p) => files.get(p) ?? null, write: async (p, b) => { files.set(p, b); },
    remove: async (p) => { files.delete(p); }, hash: async (ps) => new Map(ps.map((p) => [p, files.has(p) ? sha(files.get(p)!.toString()) : null])),
  };
  const git = (...a: string[]) => execFileSync('git', ['-C', work, ...a], { stdio: 'pipe' }).toString().trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rr-'));
    work = join(root, 'work');
    mkdirSync(join(work, 'overrides/left4dead/cfg'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'master', work]);
    git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
    writeFileSync(join(work, 'overrides/left4dead/cfg/pug_match.cfg'), 'z_tank_health 8000\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    writeFileSync(join(work, 'overrides/left4dead/cfg/pug_match.cfg'), 'z_tank_health 7500\n');
    git('add', '-A'); git('commit', '-qm', 'tank 7500');
    db = openDb(join(root, 'data', 'pug.db'));
    addServer(db, { name: 'Dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    files.clear();
    files.set(CFG, Buffer.from('z_tank_health 8000\n'));
    db.prepare("INSERT INTO fleet_readings (server_id, read_at, attempt_at) VALUES (1, datetime('now'), datetime('now'))").run();
    db.prepare('INSERT INTO fleet_files (server_id, path, size, sha256) VALUES (1, ?, 19, ?)').run(CFG, sha('z_tank_health 8000\n'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function app() {
    const config = { ...loadConfig({ DB_PATH: join(root, 'data', 'pug.db'), DEPLOY_REPO_URL: work }), devMode: false };
    const a = await buildServer({ config, db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
      releaseWriter: () => writer, serverRestarter: { restart: async () => true } });
    const cookies = await authedCookie(a, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies };
  }

  it('lists commits, stages one, reviews it per box with the cvar diff, deploys and undoes', async () => {
    const { a, cookies } = await app();
    const list = (await a.inject({ method: 'GET', url: '/api/admin/releases', cookies })).json() as { commits: { hash: string; subject: string }[] };
    expect(list.commits.map((c) => c.subject)).toEqual(['tank 7500', 'base']);
    const staged = (await a.inject({ method: 'POST', url: '/api/admin/releases/stage', cookies, payload: { commit: list.commits[0].hash } })).json() as { id: number };
    const review = (await a.inject({ method: 'GET', url: `/api/admin/releases/${staged.id}`, cookies })).json() as {
      state: string; invalid: string[]; perBox: { name: string; lines: string[]; deployable: boolean }[]; suggestion: string };
    expect(review.state).toBe('staged');
    expect(review.perBox[0]).toMatchObject({ name: 'Dallas', deployable: true });
    expect(review.perBox[0].lines).toEqual(['cfg changed: cfg/pug_match.cfg', '  z_tank_health 8000 → 7500']);
    const dep = await a.inject({ method: 'POST', url: `/api/admin/releases/${staged.id}/deploy`, cookies,
      payload: { targets: [1], canary: null, balance: { decision: 'balance', name: 'Tank 7500', notes: 'test' } } });
    expect(dep.json()).toEqual({ ok: true });
    await (a as unknown as { releaseEngine: { tick(): Promise<void> } }).releaseEngine.tick();
    expect(files.get(CFG)!.toString()).toBe('z_tank_health 7500\n');
    const undo = (await a.inject({ method: 'POST', url: `/api/admin/releases/${staged.id}/undo`, cookies, payload: {} })).json() as { id: number };
    await (a as unknown as { releaseEngine: { tick(): Promise<void> } }).releaseEngine.tick();
    expect(files.get(CFG)!.toString()).toBe('z_tank_health 8000\n');
    expect(undo.id).toBeGreaterThan(staged.id);
    const actions = (db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'release_%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['release_stage', 'release_deploy', 'release_undo']);
  });

  it('refuses a non-admin', async () => {
    const { a } = await app();
    const other = await authedCookie(a, db, '76561198000000010');
    expect((await a.inject({ method: 'GET', url: '/api/admin/releases', cookies: other })).statusCode).toBe(403);
  });
});
```

(`buildServer` exposes the engine for tests with `app.decorate('releaseEngine', engine)`; the cast above reads it. If the project's `loadConfig` has no way to turn dev mode off, the test overrides `devMode` on the returned config as shown.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`src/serverRestart.ts`:

```ts
/** Humans on a box, from the engine's `status` ("players : 3 (8 max)"). 0 when
 *  the line is missing: the caller only uses this to wait politely. */
export function parseHumans(status: string): number {
  const m = /players\s*:\s*(\d+)/.exec(status);
  return m ? Number(m[1]) : 0;
}
```

`humansOn` lives in `server.ts` beside the restarter (it needs `RealRcon`): connect, `exec('status')`, `parseHumans`, close.

`src/releaseService.ts`:

```ts
import type { DB } from './db.js';
import type { BalanceKnobs } from './balanceKnobs.js';
import type { DeployRepo, RepoFile } from './deployRepo.js';
import { listServers } from './serverPool.js';
import { readingStates, readingsOf } from './fleetReader.js';
import { treeReaderFor } from './fleetTree.js';
import { cvarDiff, deploySlug, describeOps, planBox, suggestBalance, validateTree, wantedFor, type Op, type WantedFile } from './releaseStage.js';

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const DAY_MS = 86_400_000;

export interface ReleaseSummary {
  id: number; kind: 'deploy' | 'undo'; undoOf: number | null; commit: string; short: string; state: string;
  createdBy: string; createdAt: string; deployedBy: string | null; deployedAt: string | null; canaryServerId: number | null;
  balance: { decision: string; name: string | null; notes: string | null } | null; backupsExpired: boolean;
  boxes: { serverId: number; name: string; state: string; error: string | null; updatedAt: string }[];
}
export interface ReleaseReview extends ReleaseSummary {
  subject: string | null; github: string | null; invalid: string[]; suggestion: 'not_balance' | 'possibly_balance';
  perBox: { serverId: number; name: string; lines: string[]; warnings: string[]; deployable: boolean }[];
  groups: { servers: string[]; lines: string[] }[];
}

export class ReleaseService {
  constructor(private d: { db: DB; repo: DeployRepo; knobs: BalanceKnobs | null; now?: () => string }) {}
  private now() { return (this.d.now ?? sqlNow)(); }

  /** What the last release that reached this box (and was not undone there) shipped to it. */
  lastShipped(serverId: number): { releaseId: number; files: Map<string, { sha256: string; blob: string }> } | null {
    const row = this.d.db.prepare(`SELECT rb.release_id, rb.shipped_json FROM release_boxes rb JOIN releases r ON r.id = rb.release_id
      WHERE rb.server_id = ? AND r.kind = 'deploy' AND rb.state IN ('written','restarted','confirmed')
      ORDER BY rb.release_id DESC LIMIT 1`).get(serverId) as { release_id: number; shipped_json: string } | undefined;
    if (!row) return null;
    return { releaseId: row.release_id, files: new Map(Object.entries(JSON.parse(row.shipped_json) as Record<string, { sha256: string; blob: string }>)) };
  }

  async stage(commit: string, adminId: string): Promise<{ ok: true; id: number } | { ok: false; status: 400 | 404; error: string }> {
    const { db, repo } = this.d;
    await repo.fetch();
    let hash: string;
    try { hash = await repo.resolve(commit); } catch { return { ok: false, status: 404, error: 'no such commit' }; }
    const files = await repo.tree(hash);
    const invalid = validateTree(files);
    const parent = await repo.parent(hash);
    const parentFiles: RepoFile[] = parent ? await repo.tree(parent) : [];
    const readings = readingsOf(db);
    const sources = [{ id: 'deploy', repo: 'Volence/l4d-deploy', commit: hash, layers: 'overrides+boxes', visibility: 'full' }];
    return db.transaction(() => {
      // Re-staging a commit replaces its earlier, never-deployed staging.
      for (const old of db.prepare("SELECT id FROM releases WHERE kind = 'deploy' AND state IN ('staged','invalid') AND json_extract(sources_json, '$[0].commit') = ?").all(hash) as { id: number }[]) {
        db.prepare('DELETE FROM release_boxes WHERE release_id = ?').run(old.id);
        db.prepare('DELETE FROM releases WHERE id = ?').run(old.id);
      }
      const id = Number(db.prepare(`INSERT INTO releases (kind, sources_json, state, invalid_json, created_by, created_at)
        VALUES ('deploy', ?, ?, ?, ?, ?)`).run(JSON.stringify(sources), invalid.length ? 'invalid' : 'staged', invalid.length ? JSON.stringify(invalid) : null, adminId, this.now()).lastInsertRowid);
      for (const s of listServers(db).filter((x) => x.enabled === 1)) {
        const slug = deploySlug(s.name);
        const wanted = wantedFor(files, slug);
        const shipped = this.lastShipped(s.id)?.files
          ?? new Map([...wantedFor(parentFiles, slug).values()].map((w) => [w.path, { sha256: w.sha256, blob: w.blob }]));
        const onBox = readings.get(s.id) ?? null;
        const ops = onBox && treeReaderFor(s) ? planBox(wanted, onBox, shipped) : null;
        const shippedJson = Object.fromEntries([...wanted.values()].map((w: WantedFile) => [w.path, { sha256: w.sha256, blob: w.blob }]));
        db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, ?, 'staged', ?, ?, ?)")
          .run(id, s.id, ops ? JSON.stringify(ops) : null, JSON.stringify(shippedJson), this.now());
      }
      return { ok: true as const, id };
    })();
  }

  list(limit = 20): ReleaseSummary[] {
    const ids = (this.d.db.prepare('SELECT id FROM releases ORDER BY id DESC LIMIT ?').all(limit) as { id: number }[]).map((r) => r.id);
    return ids.map((id) => this.summary(id)!);
  }

  summary(id: number): ReleaseSummary | null {
    const r = this.d.db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const commit = (JSON.parse(r.sources_json as string) as { commit: string }[])[0]?.commit ?? '';
    const boxes = this.d.db.prepare(`SELECT rb.server_id AS serverId, s.name, rb.state, rb.error, rb.updated_at AS updatedAt
      FROM release_boxes rb JOIN servers s ON s.id = rb.server_id WHERE rb.release_id = ? ORDER BY rb.server_id`).all(id) as ReleaseSummary['boxes'];
    return {
      id, kind: r.kind as 'deploy' | 'undo', undoOf: r.undo_of as number | null, commit, short: commit.slice(0, 7), state: r.state as string,
      createdBy: r.created_by as string, createdAt: r.created_at as string, deployedBy: r.deployed_by as string | null, deployedAt: r.deployed_at as string | null,
      canaryServerId: r.canary_server_id as number | null,
      balance: r.balance_decision ? { decision: r.balance_decision as string, name: r.balance_name as string | null, notes: r.balance_notes as string | null } : null,
      backupsExpired: r.backups_expired === 1, boxes,
    };
  }

  async review(id: number): Promise<ReleaseReview | null> {
    const sum = this.summary(id);
    if (!sum) return null;
    const { db, repo } = this.d;
    const rows = db.prepare(`SELECT rb.server_id, rb.plan_json FROM release_boxes rb WHERE rb.release_id = ? ORDER BY rb.server_id`).all(id) as { server_id: number; plan_json: string | null }[];
    const readings = readingsOf(db);
    const states = new Map(readingStates(db).map((s) => [s.serverId, s]));
    const servers = new Map(listServers(db).map((s) => [s.id, s]));
    const changedCvars: string[] = [];
    const perBox: ReleaseReview['perBox'] = [];
    for (const row of rows) {
      const s = servers.get(row.server_id)!;
      const warnings: string[] = [];
      const st = states.get(s.id);
      if (!st?.readAt) warnings.push('never read: check it on the Fleet page first');
      else if (Date.now() - Date.parse(`${st.readAt.replace(' ', 'T')}Z`) > DAY_MS) warnings.push('reading is over 24 hours old: check it now first');
      if (!treeReaderFor(s)) warnings.push('no transport configured');
      if (row.plan_json === null) { perBox.push({ serverId: s.id, name: s.name, lines: [], warnings, deployable: false }); continue; }
      const ops = JSON.parse(row.plan_json) as Op[];
      const prev = this.lastShipped(s.id)?.files;
      const onBox = readings.get(s.id);
      const lines: string[] = [];
      const words = describeOps(ops);
      for (let i = 0; i < ops.length; i++) {
        lines.push(words[i]);
        const o = ops[i];
        const shipped = prev?.get(o.path);
        const have = onBox?.get(o.path);
        if (shipped && have && have.sha256 !== shipped.sha256) warnings.push(`changed on the box since the last release: ${o.path.replace(/^left4dead\//, '')}`);
        if (o.op === 'write' && o.kind === 'update' && o.path.endsWith('.cfg') && o.blob) {
          const neu = (await repo.blob(o.blob)).toString('utf8');
          let old: string | null = null;
          if (shipped && have?.sha256 === shipped.sha256) old = (await repo.blob(shipped.blob)).toString('utf8');
          if (old === null) lines.push('  (changed on the box since; line diff unavailable)');
          else for (const d of cvarDiff(old, neu)) { lines.push(`  ${d}`); changedCvars.push(d.split(' ')[0]); }
        }
      }
      perBox.push({ serverId: s.id, name: s.name, lines: lines.length ? lines : ['no changes'], warnings, deployable: true });
    }
    const groups = new Map<string, { servers: string[]; lines: string[] }>();
    for (const b of perBox) {
      const key = JSON.stringify(b.lines);
      const g = groups.get(key) ?? { servers: [], lines: b.lines };
      g.servers.push(b.name);
      groups.set(key, g);
    }
    const commits = await repo.commits(100).catch(() => []);
    return {
      ...sum,
      subject: commits.find((c) => c.hash === sum.commit)?.subject ?? null,
      github: repo.githubCommitUrl(sum.commit),
      invalid: (db.prepare('SELECT invalid_json FROM releases WHERE id = ?').get(id) as { invalid_json: string | null }).invalid_json
        ? JSON.parse((db.prepare('SELECT invalid_json FROM releases WHERE id = ?').get(id) as { invalid_json: string }).invalid_json) : [],
      suggestion: suggestBalance(rows.filter((r) => r.plan_json).map((r) => JSON.parse(r.plan_json!) as Op[]), changedCvars, this.d.knobs),
      perBox, groups: [...groups.values()],
    };
  }
}
```

`src/routes/adminReleases.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import type { DeployRepo } from '../deployRepo.js';
import type { ReleaseEngine } from '../releaseEngine.js';
import type { ReleaseService } from '../releaseService.js';

export interface ReleaseRouteOpts { db: DB; repo: DeployRepo; service: ReleaseService; engine: ReleaseEngine; devMode: boolean }

const idOf = (req: { params: unknown }): number | null => {
  const raw = (req.params as { id: string }).id;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
};

/** Admin > Setup > Deploy. Admin only; every change audited. */
export async function adminReleaseRoutes(app: FastifyInstance, o: ReleaseRouteOpts): Promise<void> {
  const requireAdmin = makeRequireAdmin(o.db);

  const overview = async (force: boolean) => {
    let fetchError: string | null = null;
    try { await o.repo.fetch(force); } catch (err) { fetchError = err instanceof Error ? err.message : String(err); }
    const releases = o.service.list();
    const byCommit = new Map(releases.filter((r) => r.kind === 'deploy').map((r) => [r.commit, r.id]));
    const commits = fetchError && o.repo.lastFetchAt() === null ? [] : await o.repo.commits().catch(() => []);
    return {
      commits: commits.map((c) => ({ ...c, releaseId: byCommit.get(c.hash) ?? null })),
      releases, inFlight: o.engine.inFlight(), devMode: o.devMode, fetchError,
    };
  };

  app.get('/api/admin/releases', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return overview(false);
  });
  app.post('/api/admin/releases/refresh', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return overview(true);
  });
  app.post('/api/admin/releases/stage', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const commit = (req.body as { commit?: unknown } | undefined)?.commit;
    if (typeof commit !== 'string') return reply.code(400).send({ error: 'commit is required' });
    const r = await o.service.stage(commit, adminId);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(o.db, adminId, 'release_stage', r.id, { commit });
    return { id: r.id };
  });
  app.get('/api/admin/releases/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const id = idOf(req);
    const r = id === null ? null : await o.service.review(id);
    return r ?? reply.code(404).send({ error: 'no such release' });
  });
  app.post('/api/admin/releases/:id/deploy', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such release' });
    const b = (req.body ?? {}) as { targets?: unknown; canary?: unknown; balance?: { decision?: unknown; name?: unknown; notes?: unknown } };
    const targets = Array.isArray(b.targets) && b.targets.every((t) => Number.isInteger(t)) ? b.targets as number[] : [];
    const canary = Number.isInteger(b.canary) ? b.canary as number : null;
    const r = o.engine.deploy(id, { targets, canary, balance: { decision: String(b.balance?.decision ?? ''), name: b.balance?.name, notes: b.balance?.notes }, adminId });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(o.db, adminId, 'release_deploy', id, { targets, canary, balance: b.balance?.decision });
    void o.engine.tick();
    return { ok: true };
  });
  app.post('/api/admin/releases/:id/continue', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such release' });
    const r = o.engine.continueRelease(id, adminId);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(o.db, adminId, 'release_continue', id);
    void o.engine.tick();
    return { ok: true };
  });
  app.post('/api/admin/releases/:id/undo', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such release' });
    const servers = (req.body as { servers?: unknown } | undefined)?.servers;
    const list = Array.isArray(servers) && servers.every((s) => Number.isInteger(s)) ? servers as number[] : null;
    const r = o.engine.undo(id, list, adminId);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(o.db, adminId, 'release_undo', id, { servers: list ?? 'all', undoId: r.id });
    void o.engine.tick();
    return { id: r.id };
  });
}
```

`src/server.ts`:
- `BuildDeps` gains `/** Tests inject a fake box writer for releases. */ releaseWriter?: (s: ServerRow) => TreeWriter | null;`
- After the fleet reader: build `deployRepo = new DeployRepo({ url: deps.config.deployRepoUrl, dir: deps.config.deployRepoDir, keyPath: deps.config.deployRepoKey })`, `releaseEngine = new ReleaseEngine({ db: deps.db, blob: (id) => deployRepo.blob(id), writer: deps.releaseWriter, restarter, humans: humansOn, releasesDir: deps.config.releasesDir, devMode: deps.config.devMode })`. The engine must be constructed **before** the `ServerReleaser`; the releaser's hook becomes `async (server) => { await balanceWriter.writeForRelease(server.id); await releaseEngine.forRelease(server.id); }` (still `null` in dev mode).
- `humansOn(server)`: `RealRcon` connect, `exec('status')`, `parseHumans`, close.
- Start/stop with the others (`releaseEngine.start()` in the non-dev block, `stop()` at shutdown).
- `app.decorate('releaseEngine', releaseEngine)`.
- Register `adminReleaseRoutes` with `{ db, repo: deployRepo, service: new ReleaseService({ db, repo: deployRepo, knobs: panelKnobs }), engine: releaseEngine, devMode: deps.config.devMode }` after `panelKnobs` is loaded.

- [ ] **Step 4: Run** `npx vitest run tests/releaseRoutes.test.ts && npx tsc --noEmit`, then the whole server suite, expect PASS.
- [ ] **Step 5: Commit** `git commit -m "releases: routes, service and wiring"`

---

### Task 8: Fleet view reads the repo reference from the clone and names each file's release

**Files:**
- Modify: `src/fleetCompare.ts` (per-box references, origin), `src/routes/adminFleet.ts`, `web/src/api.ts`, `web/src/routes/admin/AdminFleet.tsx`
- Test: `tests/fleetCompare.test.ts`, `tests/fleetRoutes.test.ts`, `web/src/routes/admin/AdminFleet.test.tsx`

**Interfaces:**
- Produces: `compareFleet(repo, base, boxes, opts?: { boxRefs?: Map<number, Map<string, FileSig>>; origins?: Map<number, Map<string, { releaseId: number; sha256: string }>> })`; `FleetCell.origin?: number | null`. A box with a box-layer entry for a path compares against it and that row is not exempted by `PER_BOX`.

- [ ] **Step 1: Failing tests** (`tests/fleetCompare.test.ts`)

```ts
  it('a box layer is that box\'s reference and ends the per-box exemption; origins name the release', () => {
    const L = 'left4dead/cfg/local.cfg';
    const rows = compareFleet(man('repo', {}), null, [box(1, { [L]: sig('dal') }), box(2, { [L]: sig('chi-old') })], {
      boxRefs: new Map([[1, new Map([[L, sig('dal')]])], [2, new Map([[L, sig('chi')]])]]),
      origins: new Map([[1, new Map([[L, { releaseId: 12, sha256: 'dal' }]])]]),
    });
    expect(rows[0].perBox).toBe(false);
    expect(rows[0].cells[1]).toMatchObject({ label: 'repo', highlight: false, origin: 12 });
    expect(rows[0].cells[2]).toMatchObject({ label: 'neither', highlight: true, origin: null });
  });
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** In `compareFleet`, add the `opts` parameter. Per path: `const boxRef = (id: number) => opts?.boxRefs?.get(id)?.get(path) ?? null;` `const anyBoxRef = boxes.some((b) => boxRef(b.serverId) !== null);` `perBox = PER_BOX.has(path) && !anyBoxRef`. For each box cell: `const cellRef = boxRef(b.serverId) ?? ref;` highlight uses `cellRef`; label is `'repo'` when `s` matches `cellRef` and `cellRef` came from `boxRef` or `r`; `origin = opts?.origins?.get(b.serverId)?.get(path)?.sha256 === s?.sha256 ? releaseId : null`.

In `routes/adminFleet.ts`, take optional `repo?: DeployRepo` and `service?: ReleaseService` in the opts. When both are present and the clone has been fetched: the reference commit is the newest `deploy` release in state `done`/`deploying`/`canary_wait`/`halted`, else `master`; `repo` manifest = the shared `overrides/` files at that commit (label = short hash, at = commit time); `boxRefs` = per enabled box, the box-layer files of `wantedFor(tree, deploySlug(name))` with `layer === 'box'`; `origins` = per box, `service.lastShipped(id)`. Otherwise fall back to `repo.json` as today. Register with the new opts in `server.ts`.

Web: `FleetCellView.origin?: number | null`; `cellText` appends `, release ${c.origin}` when set.

- [ ] **Step 4: Run** the fleet tests and the web test, expect PASS.
- [ ] **Step 5: Commit** `git commit -m "fleet view: repo reference from the site's clone, box layers and release origins"`

---

### Task 9: The Deploy page

**Files:**
- Modify: `web/src/api.ts`, `web/src/routes/admin/adminRoutes.ts` (`SETUP_TABS`: `{ key: 'deploy', label: 'Deploy', path: '/admin/setup/deploy' }` after Fleet), `web/src/routes/Admin.tsx`, `web/src/styles/app.css`
- Create: `web/src/routes/admin/AdminDeploy.tsx`
- Test: `web/src/routes/admin/AdminDeploy.test.tsx`

**Interfaces:**
- Produces: `adminApi.releases(signal?)`, `adminApi.releasesRefresh()`, `adminApi.releaseStage(commit)`, `adminApi.release(id, signal?)`, `adminApi.releaseDeploy(id, body)`, `adminApi.releaseContinue(id)`, `adminApi.releaseUndo(id, servers?)`; types `ReleaseOverview`, `ReleaseSummaryView`, `ReleaseReviewView`.

- [ ] **Step 1: Failing test**

```tsx
// web/src/routes/admin/AdminDeploy.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ReleaseOverview, ReleaseReviewView } from '../../api';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: {
  releases: vi.fn(), releasesRefresh: vi.fn(), releaseStage: vi.fn(), release: vi.fn(),
  releaseDeploy: vi.fn(), releaseContinue: vi.fn(), releaseUndo: vi.fn(),
} }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../components/Confirm', () => ({ confirm: async () => true }));
const { AdminDeploy } = await import('./AdminDeploy');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const boxes = [{ serverId: 1, name: 'Dallas', state: 'staged', error: null, updatedAt: 'x' }, { serverId: 2, name: 'Chicago', state: 'staged', error: null, updatedAt: 'x' }];
const summary = { id: 5, kind: 'deploy' as const, undoOf: null, commit: 'abc1234def', short: 'abc1234', state: 'staged', createdBy: '1', createdAt: '2026-09-24 10:00:00',
  deployedBy: null, deployedAt: null, canaryServerId: null, balance: null, backupsExpired: false, boxes };
const overview: ReleaseOverview = {
  commits: [{ hash: 'abc1234def', short: 'abc1234', subject: 'Tank 7500', author: 'Volence', at: '2026-09-24T10:00:00Z', releaseId: null }],
  releases: [{ ...summary, id: 4, state: 'done', deployedAt: '2026-09-23 10:00:00', boxes: boxes.map((b) => ({ ...b, state: 'restarted' })) }],
  inFlight: null, devMode: false, fetchError: null,
};
const review: ReleaseReviewView = { ...summary, subject: 'Tank 7500', github: 'https://github.com/x/y/commit/abc', invalid: [], suggestion: 'possibly_balance',
  perBox: [
    { serverId: 1, name: 'Dallas', lines: ['cfg changed: cfg/pug_match.cfg', '  z_tank_health 8000 → 7500'], warnings: [], deployable: true },
    { serverId: 2, name: 'Chicago', lines: ['cfg changed: cfg/pug_match.cfg', '  z_tank_health 8000 → 7500'], warnings: ['reading is over 24 hours old: check it now first'], deployable: true },
  ],
  groups: [{ servers: ['Dallas', 'Chicago'], lines: ['cfg changed: cfg/pug_match.cfg', '  z_tank_health 8000 → 7500'] }] };

describe('AdminDeploy', () => {
  beforeEach(() => {
    mockAdmin.releases.mockResolvedValue(overview);
    mockAdmin.releaseStage.mockResolvedValue({ id: 5 });
    mockAdmin.release.mockResolvedValue(review);
    mockAdmin.releaseDeploy.mockResolvedValue({ ok: true });
    mockAdmin.releaseUndo.mockResolvedValue({ id: 6 });
  });

  it('stages a commit and shows the review grouped by box with warnings', async () => {
    render(<AdminDeploy />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review abc1234' }));
    await waitFor(() => expect(mockAdmin.releaseStage).toHaveBeenCalledWith('abc1234def'));
    expect(await screen.findByText('Dallas, Chicago')).toBeTruthy();
    expect(screen.getAllByText(/z_tank_health 8000 → 7500/).length).toBe(1);
    expect(screen.getByText(/Chicago: reading is over 24 hours old/)).toBeTruthy();
  });

  it('deploys to the picked boxes with a balance decision; balance needs a name', async () => {
    render(<AdminDeploy />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review abc1234' }));
    await screen.findByText('Dallas, Chicago');
    fireEvent.click(screen.getByLabelText('Chicago'));           // untick
    fireEvent.click(screen.getByLabelText('Balance patch'));
    const deploy = screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement;
    expect(deploy.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Patch name'), { target: { value: 'Tank 7500' } });
    fireEvent.click(deploy);
    await waitFor(() => expect(mockAdmin.releaseDeploy).toHaveBeenCalledWith(5, {
      targets: [1], canary: null, balance: { decision: 'balance', name: 'Tank 7500', notes: '' } }));
  });

  it('shows history with per-box states and undoes one box', async () => {
    render(<AdminDeploy />);
    expect(await screen.findByText(/Release 4/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo release 4 on Dallas' }));
    await waitFor(() => expect(mockAdmin.releaseUndo).toHaveBeenCalledWith(4, [1]));
  });

  it('says deploys are off in dev mode', async () => {
    mockAdmin.releases.mockResolvedValue({ ...overview, devMode: true });
    render(<AdminDeploy />);
    expect(await screen.findByText(/disabled in dev mode/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Types in `api.ts` mirroring `ReleaseSummary`/`ReleaseReview` and the overview; calls:

```ts
  releases: (signal?: AbortSignal) => get<ReleaseOverview>('/api/admin/releases', signal),
  releasesRefresh: () => post<ReleaseOverview>('/api/admin/releases/refresh', {}),
  releaseStage: (commit: string) => post<{ id: number }>('/api/admin/releases/stage', { commit }),
  release: (id: number, signal?: AbortSignal) => get<ReleaseReviewView>(`/api/admin/releases/${id}`, signal),
  releaseDeploy: (id: number, body: { targets: number[]; canary: number | null; balance: { decision: 'balance' | 'not_balance' | 'later'; name?: string; notes?: string } }) =>
    post<{ ok: true }>(`/api/admin/releases/${id}/deploy`, body),
  releaseContinue: (id: number) => post<{ ok: true }>(`/api/admin/releases/${id}/continue`, {}),
  releaseUndo: (id: number, servers?: number[]) => post<{ id: number }>(`/api/admin/releases/${id}/undo`, servers ? { servers } : {}),
```

`AdminDeploy.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type ReleaseReviewView, type ReleaseSummaryView } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

const STATE_LABEL: Record<string, string> = {
  staged: 'staged', pending: 'queued', waiting: 'waiting for the match to end', writing: 'writing', written: 'written',
  restarted: 'restarted', confirmed: 'confirmed', failed: 'failed', skipped: 'not targeted', undone: 'undone',
};

/** Admin > Setup > Deploy: commits of the deploy repo, the review of one
 *  against what each box has, the deploy form, and the history with undo. */
export function AdminDeploy() {
  const data = useFetch((s) => adminApi.releases(s), []);
  const [reviewId, setReviewId] = useState<number | null>(null);
  const review = useFetch((s) => (reviewId === null ? Promise.resolve(null) : adminApi.release(reviewId, s)), [reviewId]);
  const { busy, error, run } = useAction(() => { data.reload(); review.reload(); });
  if (data.error) return <Empty>Could not load the deploy page.</Empty>;
  const d = data.data;
  if (!d) return <p class="muted">Loading...</p>;

  const stage = (hash: string) => void run(async () => { const r = await adminApi.releaseStage(hash); setReviewId(r.id); });

  return (
    <div class="stack">
      {d.devMode && <p class="balance-banner">Deploys are disabled in dev mode. You can stage and review, but nothing is sent to a server.</p>}
      {error && <p class="error">{error}</p>}
      <Panel>
        <h3>Commits</h3>
        {d.fetchError && <p class="error">Could not fetch the deploy repo: {d.fetchError}</p>}
        <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => void run(() => adminApi.releasesRefresh())}>Refresh</button>
        <ul class="admin-list">
          {d.commits.map((c) => (
            <li key={c.hash} class="deploy-commit">
              <span><code>{c.short}</code> {c.subject} <span class="muted">{c.author}, {fmtTime(c.at)}</span></span>
              <button class="btn btn--sm" type="button" disabled={busy} aria-label={`Review ${c.short}`} onClick={() => stage(c.hash)}>Review</button>
            </li>
          ))}
        </ul>
      </Panel>
      {review.data && <ReviewPanel r={review.data} busy={busy} devMode={d.devMode} inFlight={d.inFlight} run={run} />}
      <Panel>
        <h3>History</h3>
        {d.releases.length === 0 ? <p class="muted">No releases yet.</p> : d.releases.map((r) => <HistoryRow key={r.id} r={r} busy={busy} run={run} />)}
      </Panel>
    </div>
  );
}

function ReviewPanel({ r, busy, devMode, inFlight, run }: { r: ReleaseReviewView; busy: boolean; devMode: boolean; inFlight: number | null; run: (f: () => Promise<unknown>) => Promise<void> }) {
  const deployable = r.perBox.filter((b) => b.deployable);
  const [targets, setTargets] = useState<number[]>(deployable.map((b) => b.serverId));
  const [canaryOn, setCanaryOn] = useState(false);
  const [canary, setCanary] = useState<number | null>(deployable[0]?.serverId ?? null);
  const [decision, setDecision] = useState<'balance' | 'not_balance' | 'later' | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const toggle = (id: number) => setTargets(targets.includes(id) ? targets.filter((t) => t !== id) : [...targets, id]);
  const ready = r.state === 'staged' && !devMode && inFlight === null && targets.length > 0 && decision !== null && (decision !== 'balance' || name.trim() !== '');
  return (
    <Panel>
      <h3>Release {r.id}: <code>{r.short}</code> {r.subject}</h3>
      {r.github && <p><a href={r.github} target="_blank" rel="noreferrer">Diff on GitHub</a></p>}
      {r.invalid.length > 0 && <div class="balance-banner"><strong>Cannot be deployed:</strong><ul>{r.invalid.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      {r.groups.map((g) => (
        <div key={g.servers.join()} class="deploy-group">
          <h4>{g.servers.join(', ')}</h4>
          <ul class="admin-list">{g.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
      ))}
      {r.perBox.flatMap((b) => b.warnings.map((w) => <p key={`${b.serverId}${w}`} class="balance-banner">{b.name}: {w}</p>))}
      {r.state === 'staged' && (
        <form class="admin-form admin-form--stack" onSubmit={(e) => {
          e.preventDefault();
          void run(() => adminApi.releaseDeploy(r.id, { targets, canary: canaryOn ? canary : null,
            balance: decision === 'balance' ? { decision, name: name.trim(), notes } : { decision: decision! } }));
        }}>
          <fieldset><legend>Send to</legend>
            {deployable.map((b) => <label key={b.serverId}><input type="checkbox" checked={targets.includes(b.serverId)} onChange={() => toggle(b.serverId)} /> {b.name}</label>)}
          </fieldset>
          <label><input type="checkbox" checked={canaryOn} onChange={() => setCanaryOn(!canaryOn)} /> Canary first</label>
          {canaryOn && (
            <select aria-label="Canary box" value={canary ?? ''} onChange={(e) => setCanary(Number((e.target as HTMLSelectElement).value))}>
              {deployable.filter((b) => targets.includes(b.serverId)).map((b) => <option key={b.serverId} value={b.serverId}>{b.name}</option>)}
            </select>
          )}
          <fieldset><legend>Balance</legend>
            <p class="muted">Suggestion: {r.suggestion === 'not_balance' ? 'probably not a balance change' : 'possibly a balance change'}.</p>
            {(['balance', 'not_balance', 'later'] as const).map((k) => (
              <label key={k}><input type="radio" name="decision" checked={decision === k} onChange={() => setDecision(k)} />
                {' '}{k === 'balance' ? 'Balance patch' : k === 'not_balance' ? 'Not balance' : 'Decide later'}</label>
            ))}
          </fieldset>
          {decision === 'balance' && <>
            <input value={name} maxLength={60} placeholder="Patch name" aria-label="Patch name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <textarea value={notes} maxLength={2000} placeholder="Notes" aria-label="Patch notes" onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
          </>}
          <button class="btn" type="submit" disabled={busy || !ready}>Deploy</button>
        </form>
      )}
    </Panel>
  );
}

function HistoryRow({ r, busy, run }: { r: ReleaseSummaryView; busy: boolean; run: (f: () => Promise<unknown>) => Promise<void> }) {
  const reached = r.boxes.filter((b) => ['written', 'restarted', 'confirmed'].includes(b.state));
  return (
    <div class="deploy-history">
      <p>
        <strong>{r.kind === 'undo' ? `Undo of release ${r.undoOf}` : `Release ${r.id}`}</strong> <code>{r.short}</code> · {r.state}
        {r.deployedAt && <span class="muted"> · {fmtTime(r.deployedAt)}</span>}
        {r.balance && <span class="muted"> · {r.balance.decision === 'balance' ? `balance: ${r.balance.name}` : r.balance.decision === 'not_balance' ? 'not balance' : 'balance: decide later'}</span>}
      </p>
      <ul class="admin-list">
        {r.boxes.map((b) => (
          <li key={b.serverId} class={b.state === 'failed' ? 'admin-warn' : ''}>
            {b.name}: {STATE_LABEL[b.state] ?? b.state}{b.error && <span class="error"> ({b.error})</span>}
            {r.kind === 'deploy' && !r.backupsExpired && reached.some((x) => x.serverId === b.serverId) && (
              <> <button class="btn btn--ghost btn--sm" type="button" disabled={busy} aria-label={`Undo release ${r.id} on ${b.name}`}
                onClick={() => void run(() => adminApi.releaseUndo(r.id, [b.serverId]))}>Undo</button></>
            )}
          </li>
        ))}
      </ul>
      {r.state === 'canary_wait' && <button class="btn" type="button" disabled={busy} onClick={() => void run(() => adminApi.releaseContinue(r.id))}>Continue to the rest</button>}
      {r.kind === 'deploy' && r.backupsExpired && <p class="muted">Backups expired.</p>}
    </div>
  );
}
```

`useAction`'s `run` signature is `Run` (`(fn, ask?) => Promise<void>`); type the props with `Run` from `./useAction`. The Deploy button asks for confirmation through `run(..., { title: 'Deploy release N?', ... })` if the project's `ConfirmOptions` allows; the test mocks `confirm` to true.

`app.css`:

```css
/* Deploy page: commit rows and review groups. */
.deploy-commit { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); }
.deploy-group h4 { margin: var(--sp-3) 0 var(--sp-1); }
.deploy-history { border-top: 1px solid var(--border); padding-top: var(--sp-2); margin-top: var(--sp-2); }
```

- [ ] **Step 4: Run** `npx vitest run web/src && npm run typecheck`, expect PASS.
- [ ] **Step 5: Commit** `git commit -m "releases: Admin > Setup > Deploy page"`

---

### Task 10: Full suite, then go-live steps (owner go-ahead for each)

- [ ] **Step 1:** `npx vitest run && npm run typecheck`, all green. Commit any fixes.
- [ ] **Step 2 (local, no server touched):** point a local site at a scratch copy of the production database, `DEPLOY_REPO_URL=/home/volence/l4d/deploy`, dev mode on; stage `master` and check the review renders (deploy is refused in dev mode by design).

**Go-live runbook (owner, after the branch is deployed):**
1. Deploy key: `ssh-keygen -t ed25519 -f /home/pug/.ssh/id_deploy_repo -N ''` on Dallas as `pug`; add the public key to `Volence/l4d-deploy` as a read-only deploy key; set `DEPLOY_REPO_KEY=/home/pug/.ssh/id_deploy_repo` in `/home/pug/app/.env`; restart the site.
2. **Seeding commit** in the deploy repo: create `boxes/{dallas,chicago,riverside-3,riverside-4}/left4dead/cfg/{local.cfg,server.cfg}` and `boxes/<slug>/left4dead/addons/sourcemod/configs/hostname/server_hostname.txt` from each box's live copy (read-only fetch as in the fleet check), `git mv overrides/left4dead/cfg/local.cfg boxes/dallas/left4dead/cfg/local.cfg` only if equal to Dallas's live copy, commit, push.
3. Stage the seeding commit on the Deploy page: every box should show **no changes** (it matches what they have). If not, stop and look.
4. First real deploy: a one-line comment change to `boxes/dallas/left4dead/cfg/local.cfg`, Dallas only, balance "not balance"; confirm in the Fleet page; then Undo on Dallas; confirm again.
5. Then: `deploy.sh` and `nfo/ftpsync.py` print "Deploy from the site (Admin > Setup > Deploy): this bypasses review, backups and undo" and exit unless `--bypass-site`; README and agent instructions say "push commits; never deploy to live servers".
