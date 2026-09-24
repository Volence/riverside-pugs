# Fleet View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Admin > Setup > Fleet page showing, per file in the managed game tree, what each of the four boxes has against the deploy repo and the Rotoblin-AZMod v8.6.4 base.

**Architecture:** `fleetTree.ts` walks and hashes a box's managed roots over its transport (local fs, one ssh `find`/`sha256sum`, or FTP LIST + download). `FleetReader` queues reads one box at a time, refuses busy boxes, keeps the last good reading on failure and runs a daily idle check. `fleetCompare.ts` is a pure function of two reference manifests (JSON files in the site's data dir) and the stored readings. `scripts/push-manifest.ts`, run on the owner's machine, builds the manifests from the deploy repo and the release ZIP and copies them to the site over ssh.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, basic-ftp, ssh/sha256sum on Riverside, Preact, vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-fleet-view-design.md`

## Global Constraints

- Read-only against every game server: no call in this plan writes, renames or deletes on a box.
- Managed roots (relative to the game dir): `left4dead/addons`, `left4dead/cfg`, `left4dead_dlc4/missions`.
- Skipped: any `logs` path segment, any `replays` segment, extensions `.log .dem .rip .sq3 .sqlite .db`, `left4dead/addons/*.vpk` (direct children only). Symlinks never followed or listed.
- Size cap 20 MB (20 * 1024 * 1024): larger files store `sha256 = NULL`.
- Only hashes stored, never contents.
- Time limits: local 60 s, sftp 180 s, FTP 600 s.
- Busy = `status` not in (`idle`, `offline`) or `enabled = 0`.
- Daily: hourly tick, reads enabled idle boxes whose `read_at` is NULL or over 24 h old; not in dev mode.
- Admin only; `POST /api/admin/fleet/check` audited as `fleet_check`.
- Deviation from the spec, recorded: `push-manifest` lives in this repo as `scripts/push-manifest.ts` (so it is tested with the site's test suite) and takes the deploy repo path as an argument, instead of living in the deploy repo's `tools/`.

---

### Task 1: Schema and the fleet data dir

**Files:**
- Modify: `src/db.ts` (after the triage block), `src/config.ts`
- Test: `tests/fleetSchema.test.ts` (new), `tests/db.test.ts` (table list)

**Interfaces:**
- Produces: tables `fleet_readings(server_id INTEGER PRIMARY KEY, read_at TEXT, attempt_at TEXT NOT NULL, error TEXT)`, `fleet_files(server_id, path, size, sha256, PRIMARY KEY(server_id, path))`; `config.fleetDir: string` (env `FLEET_DIR`, default `<dirname(dbPath)>/fleet`).

- [ ] **Step 1: Failing test**

```ts
// tests/fleetSchema.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

describe('fleet schema', () => {
  it('has the reading tables', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO fleet_readings (server_id, attempt_at) VALUES (1, 'x')").run();
    db.prepare("INSERT INTO fleet_files (server_id, path, size, sha256) VALUES (1, 'left4dead/cfg/a.cfg', 3, NULL)").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM fleet_files').get()).toEqual({ n: 1 });
  });
  it('puts the fleet dir beside the database unless FLEET_DIR is set', () => {
    expect(loadConfig({ DB_PATH: '/srv/data/pug.db' }).fleetDir).toBe('/srv/data/fleet');
    expect(loadConfig({ DB_PATH: '/srv/data/pug.db', FLEET_DIR: '/tmp/f' }).fleetDir).toBe('/tmp/f');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run tests/fleetSchema.test.ts`

- [ ] **Step 3: Implement.** In `src/db.ts` after the triage block:

```ts
  // Fleet view: the latest reading of each game server's managed files.
  // docs/superpowers/specs/2026-09-24-fleet-view-design.md
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_readings (
      server_id  INTEGER PRIMARY KEY,
      read_at    TEXT,
      attempt_at TEXT NOT NULL,
      error      TEXT
    );
    CREATE TABLE IF NOT EXISTS fleet_files (
      server_id INTEGER NOT NULL,
      path      TEXT NOT NULL,
      size      INTEGER NOT NULL,
      sha256    TEXT,
      PRIMARY KEY (server_id, path)
    );
  `);
```

In `src/config.ts`: add `fleetDir: string;` to the config interface (beside `replayLiveDir`, with the doc comment "Where scripts/push-manifest.ts drops repo.json and base.json.") and in `loadConfig`:

```ts
    fleetDir: env.FLEET_DIR?.trim() || join(dirname(dbPath), 'fleet'),
```

Add `'fleet_files', 'fleet_readings'` to the sorted table list in `tests/db.test.ts`.

- [ ] **Step 4: Run** `npx vitest run tests/fleetSchema.test.ts tests/db.test.ts tests/config*.test.ts`, expect PASS.

- [ ] **Step 5: Commit** `git commit -m "fleet view: schema and data dir"`

---

### Task 2: Tree readers (`src/fleetTree.ts`)

**Files:**
- Create: `src/fleetTree.ts`
- Test: `tests/fleetTree.test.ts`

**Interfaces:**
- Produces:
  - `MANAGED_ROOTS = ['left4dead/addons', 'left4dead/cfg', 'left4dead_dlc4/missions'] as const`
  - `SIZE_CAP = 20 * 1024 * 1024`
  - `isManaged(path: string): boolean` (under a root and not skipped)
  - `interface TreeFile { path: string; size: number; sha256: string | null }`
  - `interface TreeReader { kind: 'local' | 'sftp' | 'ftp'; read(): Promise<TreeFile[]> }` (lists every managed root, hashes files up to the cap)
  - `gameDirOf(server): string | null` (`addons_dir` minus `/left4dead/addons`; `''` for Chicago's FTP root)
  - `localTreeReader(gameDir)`, `sftpTreeReader(cfg)`, `ftpTreeReader(cfg)`, `treeReaderFor(server): TreeReader | null`

- [ ] **Step 1: Failing test**

```ts
// tests/fleetTree.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ftpTreeReader, gameDirOf, isManaged, localTreeReader, sftpTreeReader, treeReaderFor } from '../src/fleetTree.js';
import type { ServerRow } from '../src/serverPool.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('isManaged', () => {
  it('keeps managed files and drops the skip list', () => {
    expect(isManaged('left4dead/addons/sourcemod/plugins/a.smx')).toBe(true);
    expect(isManaged('left4dead/cfg/server.cfg')).toBe(true);
    expect(isManaged('left4dead_dlc4/missions/x.txt')).toBe(true);
    expect(isManaged('left4dead/maps/c1m1.bsp')).toBe(false);
    expect(isManaged('left4dead/addons/sourcemod/logs/L1.log')).toBe(false);
    expect(isManaged('left4dead/addons/sourcemod/data/x.sq3')).toBe(false);
    expect(isManaged('left4dead/addons/dbd.vpk')).toBe(false);
    expect(isManaged('left4dead/addons/sub/x.vpk')).toBe(true);
    expect(isManaged('left4dead/addons/sourcemod/data/replays/r.rip')).toBe(false);
    expect(isManaged('left4dead/cfg/../../etc/passwd')).toBe(false);
  });
});

describe('gameDirOf', () => {
  it('strips /left4dead/addons', () => {
    expect(gameDirOf({ addons_dir: '/home/l4d/l4d1-a/left4dead/addons' } as never)).toBe('/home/l4d/l4d1-a');
    expect(gameDirOf({ addons_dir: '/left4dead/addons' } as never)).toBe('');
    expect(gameDirOf({ addons_dir: '/srv/other' } as never)).toBeNull();
    expect(gameDirOf({ addons_dir: null } as never)).toBeNull();
  });
});

describe('localTreeReader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-'));
    mkdirSync(join(dir, 'left4dead/addons/sourcemod/plugins'), { recursive: true });
    mkdirSync(join(dir, 'left4dead/addons/sourcemod/logs'), { recursive: true });
    mkdirSync(join(dir, 'left4dead/cfg'), { recursive: true });
    writeFileSync(join(dir, 'left4dead/addons/sourcemod/plugins/a.smx'), 'aaa');
    writeFileSync(join(dir, 'left4dead/addons/sourcemod/logs/L1.log'), 'log');
    writeFileSync(join(dir, 'left4dead/addons/big.vpk'), 'vpk');
    writeFileSync(join(dir, 'left4dead/cfg/server.cfg'), 'cfg');
    symlinkSync(join(dir, 'left4dead/cfg/server.cfg'), join(dir, 'left4dead/cfg/link.cfg'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists and hashes managed files, skipping logs, campaign vpks, symlinks and missing roots', async () => {
    const files = await localTreeReader(dir).read();
    expect(files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'left4dead/addons/sourcemod/plugins/a.smx', size: 3, sha256: sha('aaa') },
      { path: 'left4dead/cfg/server.cfg', size: 3, sha256: sha('cfg') },
    ]);
  });

  it('records size only over the cap', async () => {
    const files = await localTreeReader(dir, { sizeCap: 2 }).read();
    expect(files.every((f) => f.sha256 === null)).toBe(true);
  });
});

describe('sftpTreeReader', () => {
  it('lists with one find and hashes with sha256sum, never downloading', async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const script = args[args.length - 1];
      if (script.includes('find')) {
        return { stdout: `3\tleft4dead/cfg/server.cfg\n9\tleft4dead/addons/sourcemod/logs/L.log\n30000000\tleft4dead/addons/sourcemod/x.bin\n` };
      }
      return { stdout: `${sha('cfg')}  left4dead/cfg/server.cfg\n` };
    };
    const files = await sftpTreeReader({ host: 'h', port: 22, user: 'u', keyPath: '/k', gameDir: '/home/l4d/l4d1-a', run }).read();
    expect(files).toEqual([
      { path: 'left4dead/cfg/server.cfg', size: 3, sha256: sha('cfg') },
      { path: 'left4dead/addons/sourcemod/x.bin', size: 30000000, sha256: null },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c[0] === 'ssh')).toBe(true);
    expect(calls[1][calls[1].length - 1]).toContain("'left4dead/cfg/server.cfg'");
    expect(calls[1][calls[1].length - 1]).not.toContain('x.bin');
  });
});

describe('ftpTreeReader', () => {
  it('walks with LIST, skips symlinks and unmanaged dirs, and hashes by download', async () => {
    const tree: Record<string, { name: string; size: number; type: 1 | 2 | 3 }[]> = {
      '/left4dead/addons': [{ name: 'sourcemod', size: 0, type: 2 }, { name: 'dbd.vpk', size: 5, type: 1 }],
      '/left4dead/addons/sourcemod': [{ name: 'a.smx', size: 3, type: 1 }, { name: 'l.smx', size: 3, type: 3 }],
      '/left4dead/cfg': [{ name: 'server.cfg', size: 3, type: 1 }],
    };
    const content: Record<string, string> = { '/left4dead/addons/sourcemod/a.smx': 'aaa', '/left4dead/cfg/server.cfg': 'cfg' };
    const client = {
      access: async () => ({}), close: () => {},
      list: async (p: string) => {
        if (!tree[p]) throw Object.assign(new Error('550'), { code: 550 });
        return tree[p].map((e) => ({ ...e, isFile: e.type === 1, isDirectory: e.type === 2, isSymbolicLink: e.type === 3 }));
      },
      downloadTo: async (sink: NodeJS.WritableStream, p: string) => { sink.write(Buffer.from(content[p])); },
    };
    const files = await ftpTreeReader({ host: 'h', port: 21, user: 'u', password: 'p', gameDir: '', client: () => client as never }).read();
    expect(files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'left4dead/addons/sourcemod/a.smx', size: 3, sha256: sha('aaa') },
      { path: 'left4dead/cfg/server.cfg', size: 3, sha256: sha('cfg') },
    ]);
  });
});

describe('treeReaderFor', () => {
  const s = (over: object) => ({ id: 1, name: 'x', status: 'idle', enabled: 1, ...over }) as unknown as ServerRow;
  it('picks by transport and refuses half-configured rows', () => {
    expect(treeReaderFor(s({ addons_transport: 'local', addons_dir: '/g/left4dead/addons' }))?.kind).toBe('local');
    expect(treeReaderFor(s({ addons_transport: 'sftp', addons_dir: '/g/left4dead/addons', ftp_host: 'h', ftp_user: 'u', ssh_key_path: '/k' }))?.kind).toBe('sftp');
    expect(treeReaderFor(s({ addons_transport: 'ftp', addons_dir: '/left4dead/addons', ftp_host: 'h', ftp_user: 'u', ftp_password: 'p' }))?.kind).toBe('ftp');
    expect(treeReaderFor(s({ addons_transport: 'ftp', addons_dir: '/left4dead/addons', ftp_host: 'h' }))).toBeNull();
    expect(treeReaderFor(s({ addons_transport: 'local', addons_dir: null }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run tests/fleetTree.test.ts`

- [ ] **Step 3: Implement `src/fleetTree.ts`**

```ts
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
const SKIP_EXT = /\.(log|dem|rip|sq3|sqlite|db)$/i;

/** Under a managed root, not on the skip list, and a plain relative path. */
export function isManaged(path: string): boolean {
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (!MANAGED_ROOTS.some((r) => path.startsWith(`${r}/`))) return false;
  if (parts.includes('logs') || parts.includes('replays')) return false;
  if (SKIP_EXT.test(path)) return false;
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
      const out: TreeFile[] = [];
      for (const r of MANAGED_ROOTS) await walk(r, out);
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
  const common = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', cfg.keyPath];
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
      const listing = await ssh(`cd ${shq(cfg.gameDir)} && for r in ${roots}; do [ -d "$r" ] && find "$r" -type f -printf '%s\\t%p\\n'; done; true`);
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
```

- [ ] **Step 4: Run, expect PASS.** `npx vitest run tests/fleetTree.test.ts`

- [ ] **Step 5: Commit** `git commit -m "fleet view: read-only tree readers for local, sftp and FTP boxes"`

---

### Task 3: Manifests and comparison (`src/fleetCompare.ts`)

**Files:**
- Create: `src/fleetCompare.ts`
- Test: `tests/fleetCompare.test.ts`

**Interfaces:**
- Produces:
  - `interface FileSig { size: number; sha256: string | null }`
  - `interface Manifest { kind: 'repo' | 'base'; label: string; at: string; files: Record<string, FileSig> }`
  - `loadManifest(dir: string, kind: 'repo' | 'base'): Manifest | null` (reads `<dir>/<kind>.json`; null when missing or malformed)
  - `type Area = 'plugins' | 'configs' | 'data' | 'gamedata' | 'extensions' | 'stripper' | 'other'`; `areaOf(path): Area`
  - `type CellLabel = 'repo' | 'base' | 'neither' | 'missing' | 'unread'`
  - `interface FleetCell { sig: FileSig | null; label: CellLabel; highlight: boolean; sizeOnly: boolean }`
  - `interface FleetRow { path: string; area: Area; repo: FileSig | null; base: FileSig | null; cells: Record<number, FleetCell>; patchedEverywhere: boolean; differs: boolean }`
  - `compareFleet(repo: Manifest | null, base: Manifest | null, boxes: { serverId: number; files: Map<string, FileSig> | null }[]): FleetRow[]` (sorted by area then path; only managed paths)

- [ ] **Step 1: Failing test**

```ts
// tests/fleetCompare.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { areaOf, compareFleet, loadManifest, type FileSig, type Manifest } from '../src/fleetCompare.js';

const sig = (h: string, size = 1): FileSig => ({ size, sha256: h });
const man = (kind: 'repo' | 'base', files: Record<string, FileSig>): Manifest => ({ kind, label: kind, at: 't', files });
const box = (serverId: number, files: Record<string, FileSig> | null) => ({ serverId, files: files ? new Map(Object.entries(files)) : null });
const P = 'left4dead/addons/sourcemod/plugins/pug-match.smx';
const C = 'left4dead/cfg/server.cfg';
const X = 'left4dead/addons/sourcemod/plugins/extra.smx';

describe('compareFleet', () => {
  it('repo is the reference: a box that differs or lacks the file is highlighted', () => {
    const rows = compareFleet(man('repo', { [P]: sig('r') }), man('base', { [P]: sig('b') }),
      [box(1, { [P]: sig('d') }), box(2, { [P]: sig('r') }), box(3, {})]);
    const r = rows.find((x) => x.path === P)!;
    expect(r.cells[1]).toMatchObject({ label: 'neither', highlight: true });
    expect(r.cells[2]).toMatchObject({ label: 'repo', highlight: false });
    expect(r.cells[3]).toMatchObject({ label: 'missing', highlight: true });
    expect(r.differs).toBe(true);
  });

  it('base patched the same way on every box is not highlighted', () => {
    const rows = compareFleet(null, man('base', { [C]: sig('b') }), [box(1, { [C]: sig('p') }), box(2, { [C]: sig('p') })]);
    expect(rows[0]).toMatchObject({ patchedEverywhere: true, differs: false });
    expect(rows[0].cells[1]).toMatchObject({ label: 'neither', highlight: false });
  });

  it('without a reference the minority is highlighted; a tie highlights everyone', () => {
    const rows = compareFleet(null, null, [box(1, { [X]: sig('a') }), box(2, {}), box(3, {}), box(4, {})]);
    expect(rows[0].cells[1]).toMatchObject({ label: 'neither', highlight: true });
    expect(rows[0].cells[2]).toMatchObject({ label: 'missing', highlight: false });
    const tie = compareFleet(null, null, [box(1, { [X]: sig('a') }), box(2, { [X]: sig('b') })]);
    expect(Object.values(tie[0].cells).every((c) => c.highlight)).toBe(true);
  });

  it('an unread box takes no part and shows unread; size-only compares by size', () => {
    const rows = compareFleet(man('repo', { [C]: { size: 5, sha256: null } }), null,
      [box(1, null), box(2, { [C]: { size: 5, sha256: null } })]);
    expect(rows[0].cells[1]).toMatchObject({ label: 'unread', highlight: false });
    expect(rows[0].cells[2]).toMatchObject({ label: 'repo', highlight: false, sizeOnly: true });
  });

  it('ignores unmanaged paths in the manifests and sorts by area then path', () => {
    const rows = compareFleet(man('repo', { 'left4dead/maps/x.bsp': sig('m'), [C]: sig('c'), [P]: sig('p') }), null, []);
    expect(rows.map((r) => r.path)).toEqual([P, C]);
  });
});

describe('areaOf', () => {
  it('groups by folder', () => {
    expect(areaOf(P)).toBe('plugins');
    expect(areaOf('left4dead/addons/sourcemod/plugins/disabled/a.smx')).toBe('plugins');
    expect(areaOf(C)).toBe('configs');
    expect(areaOf('left4dead/addons/sourcemod/configs/admins.cfg')).toBe('configs');
    expect(areaOf('left4dead/addons/sourcemod/data/a.txt')).toBe('data');
    expect(areaOf('left4dead/addons/sourcemod/gamedata/a.txt')).toBe('gamedata');
    expect(areaOf('left4dead/addons/sourcemod/extensions/a.so')).toBe('extensions');
    expect(areaOf('left4dead/addons/stripper/maps/c1m1.cfg')).toBe('stripper');
    expect(areaOf('left4dead/addons/metamod.vdf')).toBe('other');
  });
});

describe('loadManifest', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it('reads a manifest and answers null for missing or broken files', () => {
    dir = mkdtempSync(join(tmpdir(), 'man-'));
    expect(loadManifest(dir, 'repo')).toBeNull();
    writeFileSync(join(dir, 'repo.json'), JSON.stringify(man('repo', { [C]: sig('c') })));
    expect(loadManifest(dir, 'repo')?.files[C]).toEqual(sig('c'));
    writeFileSync(join(dir, 'base.json'), '{nope');
    expect(loadManifest(dir, 'base')).toBeNull();
    writeFileSync(join(dir, 'base.json'), JSON.stringify({ ...man('repo', {}) }));
    expect(loadManifest(dir, 'base')).toBeNull(); // kind must match the file
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run tests/fleetCompare.test.ts`

- [ ] **Step 3: Implement `src/fleetCompare.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isManaged } from './fleetTree.js';

/** The fleet view's comparison: pure, from two reference manifests and the
 *  stored readings. Rules in docs/superpowers/specs/2026-09-24-fleet-view-design.md. */

export interface FileSig { size: number; sha256: string | null }
export interface Manifest { kind: 'repo' | 'base'; label: string; at: string; files: Record<string, FileSig> }

export function loadManifest(dir: string, kind: 'repo' | 'base'): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, `${kind}.json`), 'utf8')) as Manifest;
    if (m.kind !== kind || typeof m.label !== 'string' || typeof m.files !== 'object' || m.files === null) return null;
    return m;
  } catch {
    return null;
  }
}

export type Area = 'plugins' | 'configs' | 'data' | 'gamedata' | 'extensions' | 'stripper' | 'other';
const AREA_ORDER: Area[] = ['plugins', 'configs', 'data', 'gamedata', 'extensions', 'stripper', 'other'];

export function areaOf(path: string): Area {
  const sm = 'left4dead/addons/sourcemod/';
  if (path.startsWith(`${sm}plugins/`)) return 'plugins';
  if (path.startsWith('left4dead/cfg/') || path.startsWith(`${sm}configs/`)) return 'configs';
  if (path.startsWith(`${sm}data/`)) return 'data';
  if (path.startsWith(`${sm}gamedata/`)) return 'gamedata';
  if (path.startsWith(`${sm}extensions/`)) return 'extensions';
  if (path.startsWith('left4dead/addons/stripper/')) return 'stripper';
  return 'other';
}

export type CellLabel = 'repo' | 'base' | 'neither' | 'missing' | 'unread';
export interface FleetCell { sig: FileSig | null; label: CellLabel; highlight: boolean; sizeOnly: boolean }
export interface FleetRow {
  path: string; area: Area; repo: FileSig | null; base: FileSig | null;
  cells: Record<number, FleetCell>;
  /** Differs from the base (no repo entry) the same way on every read box: a
   *  post-install patch such as the local.cfg hooks, not drift. */
  patchedEverywhere: boolean;
  differs: boolean;
}

/** Same file: by hash when both sides have one, else by size. */
const same = (a: FileSig, b: FileSig) => (a.sha256 !== null && b.sha256 !== null ? a.sha256 === b.sha256 : a.size === b.size);
const key = (s: FileSig | null) => (s === null ? 'missing' : `${s.size}:${s.sha256 ?? ''}`);

export function compareFleet(repo: Manifest | null, base: Manifest | null,
  boxes: { serverId: number; files: Map<string, FileSig> | null }[]): FleetRow[] {
  const paths = new Set<string>();
  for (const m of [repo, base]) if (m) for (const p of Object.keys(m.files)) paths.add(p);
  for (const b of boxes) if (b.files) for (const p of b.files.keys()) paths.add(p);

  const rows: FleetRow[] = [];
  for (const path of paths) {
    if (!isManaged(path)) continue;
    const r = repo?.files[path] ?? null;
    const bs = base?.files[path] ?? null;
    const ref = r ?? bs;
    const read = boxes.filter((b) => b.files !== null);
    const sigOf = (b: { files: Map<string, FileSig> | null }) => b.files!.get(path) ?? null;
    const labelOf = (s: FileSig | null): CellLabel =>
      s === null ? 'missing' : r && same(s, r) ? 'repo' : bs && same(s, bs) ? 'base' : 'neither';

    // Majority among read boxes, for rows with no reference.
    const counts = new Map<string, number>();
    for (const b of read) counts.set(key(sigOf(b)), (counts.get(key(sigOf(b))) ?? 0) + 1);
    const top = Math.max(0, ...counts.values());
    const leaders = [...counts].filter(([, n]) => n === top).map(([k]) => k);
    const allAgree = counts.size === 1;
    const patchedEverywhere = !r && bs !== null && read.length > 0 && allAgree && sigOf(read[0]) !== null && !same(sigOf(read[0])!, bs);

    const cells: Record<number, FleetCell> = {};
    for (const b of boxes) {
      if (b.files === null) { cells[b.serverId] = { sig: null, label: 'unread', highlight: false, sizeOnly: false }; continue; }
      const s = sigOf(b);
      let highlight: boolean;
      if (ref) highlight = patchedEverywhere ? false : s === null || !same(s, ref);
      else highlight = !allAgree && (leaders.length > 1 || key(s) !== leaders[0]);
      const sizeOnly = s !== null && (s.sha256 === null || (ref !== null && ref.sha256 === null));
      cells[b.serverId] = { sig: s, label: labelOf(s), highlight, sizeOnly };
    }
    rows.push({ path, area: areaOf(path), repo: r, base: bs, cells, patchedEverywhere,
      differs: Object.values(cells).some((c) => c.highlight) });
  }
  return rows.sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area) || a.path.localeCompare(b.path));
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** `git commit -m "fleet view: manifests and comparison rules"`

---

### Task 4: FleetReader (queue, busy check, time limits, daily tick)

**Files:**
- Create: `src/fleetReader.ts`
- Test: `tests/fleetReader.test.ts`

**Interfaces:**
- Consumes: `TreeReader`, `treeReaderFor` (Task 2); `getServer`, `listServers` (`src/serverPool.ts`).
- Produces:
  - `type CheckState = 'queued' | 'busy' | 'disabled' | 'no_transport' | 'unknown'`
  - `class FleetReader` with `constructor(deps: { db: DB; reader?: (s: ServerRow) => TreeReader | null; limits?: Partial<Record<TreeReader['kind'], number>>; now?: () => string; tickMs?: number })`, `request(serverIds: number[]): Record<number, CheckState>`, `pending(serverId): boolean`, `idle(): Promise<void>` (for tests), `tick(): number[]` (ids queued), `start()`, `stop()`
  - `readingsOf(db): Map<number, Map<string, FileSig> | null>` and `readingStates(db): { serverId: number; readAt: string | null; attemptAt: string | null; error: string | null }[]`

- [ ] **Step 1: Failing test**

```ts
// tests/fleetReader.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { FleetReader, readingStates, readingsOf } from '../src/fleetReader.js';
import type { TreeFile, TreeReader } from '../src/fleetTree.js';

type DB = ReturnType<typeof openDb>;
const F = (path: string, h = 'a'): TreeFile => ({ path, size: 1, sha256: h });
const fake = (out: TreeFile[] | Error | (() => Promise<TreeFile[]>), kind: TreeReader['kind'] = 'local'): TreeReader => ({
  kind, read: typeof out === 'function' ? out : async () => { if (out instanceof Error) throw out; return out; },
});

describe('FleetReader', () => {
  let db: DB;
  let s1: number, s2: number;
  let t = 0;
  const now = () => `2026-09-24 10:00:${String(t++ % 60).padStart(2, '0')}`;
  beforeEach(() => {
    db = openDb(':memory:');
    s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
  });

  it('reads a box and stores its files, replacing the previous reading', async () => {
    let files = [F('left4dead/cfg/a.cfg'), F('left4dead/cfg/b.cfg')];
    const r = new FleetReader({ db, reader: () => fake(async () => files), now });
    expect(r.request([s1])).toEqual({ [s1]: 'queued' });
    await r.idle();
    files = [F('left4dead/cfg/a.cfg', 'z')];
    r.request([s1]);
    await r.idle();
    expect([...readingsOf(db).get(s1)!.entries()]).toEqual([['left4dead/cfg/a.cfg', { size: 1, sha256: 'z' }]]);
    expect(readingStates(db).find((x) => x.serverId === s1)).toMatchObject({ error: null });
  });

  it('refuses a busy or disabled box and one with no transport', () => {
    db.prepare("UPDATE servers SET status = 'live' WHERE id = ?").run(s1);
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    const r = new FleetReader({ db, reader: () => fake([]), now });
    expect(r.request([s1, s2, 99])).toEqual({ [s1]: 'busy', [s2]: 'disabled', 99: 'unknown' });
    const db2 = openDb(':memory:');
    const id = addServer(db2, { name: 'x', host: 'h', port: 1, rconPort: 1, rconPassword: 'x' });
    expect(new FleetReader({ db: db2, reader: () => null, now }).request([id])).toEqual({ [id]: 'no_transport' });
  });

  it('a box that turns busy before its read starts is skipped, keeping the old reading', async () => {
    const r = new FleetReader({ db, reader: () => fake([F('left4dead/cfg/a.cfg')]), now });
    r.request([s1]); await r.idle();
    const r2 = new FleetReader({ db, reader: () => fake([]), now });
    r2.request([s1]);
    db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(s1);
    await r2.idle();
    expect(readingsOf(db).get(s1)!.size).toBe(1);
    expect(readingStates(db).find((x) => x.serverId === s1)!.error).toMatch(/busy/);
  });

  it('a failure or a time-out keeps the old reading and records the error; other boxes go on', async () => {
    let fail = false;
    const r = new FleetReader({ db, now, limits: { local: 20 },
      reader: (s) => fake(s.id === s1 && fail ? () => new Promise<TreeFile[]>(() => {}) : async () => [F('left4dead/cfg/a.cfg')]) });
    r.request([s1, s2]); await r.idle();
    fail = true;
    r.request([s1, s2]); await r.idle();
    const st = readingStates(db);
    expect(st.find((x) => x.serverId === s1)!.error).toMatch(/timed out/);
    expect(readingsOf(db).get(s1)!.size).toBe(1);
    expect(st.find((x) => x.serverId === s2)!.error).toBeNull();
  });

  it('a second request for a queued box joins it', async () => {
    let reads = 0;
    const r = new FleetReader({ db, now, reader: () => fake(async () => { reads++; return []; }) });
    r.request([s1]); r.request([s1]);
    expect(r.pending(s1)).toBe(true);
    await r.idle();
    expect(reads).toBe(1);
  });

  it('the daily tick queues enabled idle boxes never read or read over 24 h ago', () => {
    db.prepare("INSERT INTO fleet_readings (server_id, read_at, attempt_at) VALUES (?, datetime('now', '-2 hours'), datetime('now'))").run(s1);
    const r = new FleetReader({ db, reader: () => fake([]), now });
    expect(r.tick()).toEqual([s2]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/fleetReader.ts`**

```ts
import type { DB } from './db.js';
import { getServer, listServers, type ServerRow } from './serverPool.js';
import { treeReaderFor, type TreeFile, type TreeReader } from './fleetTree.js';
import type { FileSig } from './fleetCompare.js';

/**
 * Reads each game server's managed files for the fleet view, one box at a
 * time, only while the box is idle. Read-only. A failed or timed-out read keeps
 * the previous reading and records why. See
 * docs/superpowers/specs/2026-09-24-fleet-view-design.md.
 */

export type CheckState = 'queued' | 'busy' | 'disabled' | 'no_transport' | 'unknown';

const LIMITS: Record<TreeReader['kind'], number> = { local: 60_000, sftp: 180_000, ftp: 600_000 };
const HOUR = 3_600_000;
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const busyStatus = (s: ServerRow) => s.status !== 'idle' && s.status !== 'offline';

export class FleetReader {
  private chain: Promise<void> = Promise.resolve();
  private queued = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: {
    db: DB;
    reader?: (s: ServerRow) => TreeReader | null;
    limits?: Partial<Record<TreeReader['kind'], number>>;
    now?: () => string;
    tickMs?: number;
  }) {}

  private readerFor(s: ServerRow) { return (this.deps.reader ?? treeReaderFor)(s); }
  private now() { return (this.deps.now ?? sqlNow)(); }

  request(serverIds: number[]): Record<number, CheckState> {
    const out: Record<number, CheckState> = {};
    for (const id of serverIds) {
      const s = getServer(this.deps.db, id);
      if (!s) out[id] = 'unknown';
      else if (s.enabled !== 1) out[id] = 'disabled';
      else if (busyStatus(s)) out[id] = 'busy';
      else if (!this.readerFor(s)) out[id] = 'no_transport';
      else { out[id] = 'queued'; this.enqueue(id); }
    }
    return out;
  }

  pending(serverId: number): boolean { return this.queued.has(serverId); }
  idle(): Promise<void> { return this.chain; }

  private enqueue(id: number): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.chain = this.chain.then(() => this.readOne(id)).catch((err) => console.error('[fleet] read failed:', err))
      .finally(() => this.queued.delete(id));
  }

  private async readOne(id: number): Promise<void> {
    const db = this.deps.db;
    const s = getServer(db, id);
    const fail = (error: string) => db.prepare(`INSERT INTO fleet_readings (server_id, attempt_at, error) VALUES (?, ?, ?)
      ON CONFLICT (server_id) DO UPDATE SET attempt_at = excluded.attempt_at, error = excluded.error`).run(id, this.now(), error);
    // Rechecked here: the box may have been claimed since the request.
    if (!s || s.enabled !== 1 || busyStatus(s)) { fail('busy when its turn came; try after the match'); return; }
    const reader = this.readerFor(s);
    if (!reader) { fail('no transport configured'); return; }
    const limit = this.deps.limits?.[reader.kind] ?? LIMITS[reader.kind];
    let files: TreeFile[];
    try {
      let t: ReturnType<typeof setTimeout> | undefined;
      files = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`timed out after ${Math.round(limit / 1000)} s`)), limit); }),
      ]).finally(() => clearTimeout(t));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    const at = this.now();
    db.transaction(() => {
      db.prepare('DELETE FROM fleet_files WHERE server_id = ?').run(id);
      const ins = db.prepare('INSERT OR REPLACE INTO fleet_files (server_id, path, size, sha256) VALUES (?, ?, ?, ?)');
      for (const f of files) ins.run(id, f.path, f.size, f.sha256);
      db.prepare(`INSERT INTO fleet_readings (server_id, read_at, attempt_at, error) VALUES (?, ?, ?, NULL)
        ON CONFLICT (server_id) DO UPDATE SET read_at = excluded.read_at, attempt_at = excluded.attempt_at, error = NULL`).run(id, at, at);
    })();
  }

  /** Queues every enabled idle box never read, or last read over 24 h ago. */
  tick(): number[] {
    const stale = new Set((this.deps.db.prepare(`SELECT s.id FROM servers s LEFT JOIN fleet_readings f ON f.server_id = s.id
      WHERE f.read_at IS NULL OR f.read_at < datetime('now', '-24 hours')`).all() as { id: number }[]).map((r) => r.id));
    const picked = listServers(this.deps.db).filter((s) => stale.has(s.id) && s.enabled === 1 && !busyStatus(s) && this.readerFor(s));
    for (const s of picked) this.enqueue(s.id);
    return picked.map((s) => s.id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? HOUR);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function readingsOf(db: DB): Map<number, Map<string, FileSig> | null> {
  const out = new Map<number, Map<string, FileSig> | null>();
  for (const s of listServers(db)) out.set(s.id, null);
  const read = new Set((db.prepare('SELECT server_id FROM fleet_readings WHERE read_at IS NOT NULL').all() as { server_id: number }[]).map((r) => r.server_id));
  for (const id of read) out.set(id, new Map());
  for (const f of db.prepare('SELECT server_id, path, size, sha256 FROM fleet_files').all() as { server_id: number; path: string; size: number; sha256: string | null }[]) {
    out.get(f.server_id)?.set(f.path, { size: f.size, sha256: f.sha256 });
  }
  return out;
}

export function readingStates(db: DB): { serverId: number; readAt: string | null; attemptAt: string | null; error: string | null }[] {
  return (db.prepare(`SELECT s.id AS serverId, f.read_at AS readAt, f.attempt_at AS attemptAt, f.error AS error
    FROM servers s LEFT JOIN fleet_readings f ON f.server_id = s.id ORDER BY s.id`).all() as
    { serverId: number; readAt: string | null; attemptAt: string | null; error: string | null }[]);
}
```

- [ ] **Step 4: Run, expect PASS.** `npx vitest run tests/fleetReader.test.ts`

- [ ] **Step 5: Commit** `git commit -m "fleet view: reader queue, busy checks, time limits and the daily tick"`

---

### Task 5: API routes and server wiring

**Files:**
- Create: `src/routes/adminFleet.ts`
- Modify: `src/server.ts` (construct `FleetReader`, start/stop outside dev mode, register routes)
- Test: `tests/fleetRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4; `config.fleetDir`.
- Produces:
  - `GET /api/admin/fleet` → `{ repo: { label: string; at: string } | null; base: { label: string; at: string } | null; boxes: { serverId: number; name: string; enabled: boolean; readAt: string | null; attemptAt: string | null; error: string | null; pending: boolean }[]; rows: FleetRow[] }`
  - `POST /api/admin/fleet/check` body `{ serverId: number } | { all: true }` → `{ states: Record<number, CheckState> }`, audited `fleet_check`.
  - `BuildDeps` gains `fleetReader?: FleetReader` (tests inject a reader with a fake tree).

- [ ] **Step 1: Failing test**

```ts
// tests/fleetRoutes.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { FleetReader } from '../src/fleetReader.js';

const ADMIN = '76561198000000009';
const P = 'left4dead/addons/sourcemod/plugins/pug-match.smx';

describe('fleet routes', () => {
  let db: ReturnType<typeof openDb>;
  let fleetDir: string;
  beforeEach(() => {
    db = openDb(':memory:');
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    fleetDir = mkdtempSync(join(tmpdir(), 'fleet-'));
    writeFileSync(join(fleetDir, 'repo.json'), JSON.stringify({ kind: 'repo', label: '57add2c', at: '2026-09-24T14:00:00Z', files: { [P]: { size: 81241, sha256: 'r' } } }));
  });

  async function app(admin = true) {
    const fleetReader = new FleetReader({ db, reader: (s) => ({ kind: 'local', read: async () => [{ path: P, size: s.id === 1 ? 81639 : 81241, sha256: s.id === 1 ? 'd' : 'r' }] }) });
    const a = await buildServer({ config: loadConfig({ FLEET_DIR: fleetDir }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {}, fleetReader });
    const cookies = await authedCookie(a, db, admin ? ADMIN : '76561198000000010');
    if (admin) db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies, fleetReader };
  }

  it('checks all boxes, audits, and shows the difference against the repo', async () => {
    const { a, cookies, fleetReader } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/fleet/check', cookies, payload: { all: true } });
    expect(res.json()).toEqual({ states: { 1: 'queued', 2: 'queued' } });
    await fleetReader.idle();
    const body = (await a.inject({ method: 'GET', url: '/api/admin/fleet', cookies })).json() as {
      repo: { label: string }; base: null; boxes: { name: string; readAt: string | null }[];
      rows: { path: string; cells: Record<string, { label: string; highlight: boolean }> }[] };
    expect(body.repo.label).toBe('57add2c');
    expect(body.base).toBeNull();
    expect(body.boxes.every((b) => b.readAt !== null)).toBe(true);
    expect(body.rows[0].cells['1']).toMatchObject({ label: 'neither', highlight: true });
    expect(body.rows[0].cells['2']).toMatchObject({ label: 'repo', highlight: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'fleet_check'").get()).toEqual({ n: 1 });
  });

  it('answers busy for a box in a match and refuses a bad body', async () => {
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
    const { a, cookies } = await app();
    expect((await a.inject({ method: 'POST', url: '/api/admin/fleet/check', cookies, payload: { serverId: 1 } })).json())
      .toEqual({ states: { 1: 'busy' } });
    expect((await a.inject({ method: 'POST', url: '/api/admin/fleet/check', cookies, payload: {} })).statusCode).toBe(400);
  });

  it('refuses a non-admin', async () => {
    const { a, cookies } = await app(false);
    expect((await a.inject({ method: 'GET', url: '/api/admin/fleet', cookies })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/admin/fleet/check', cookies, payload: { all: true } })).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/routes/adminFleet.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { listServers } from '../serverPool.js';
import { compareFleet, loadManifest } from '../fleetCompare.js';
import { readingStates, readingsOf, type FleetReader } from '../fleetReader.js';

export interface FleetRouteOpts { db: DB; fleetDir: string; reader: FleetReader }

/** Admin > Setup > Fleet: read-only file view of every game server. */
export async function adminFleetRoutes(app: FastifyInstance, opts: FleetRouteOpts): Promise<void> {
  const { db, fleetDir, reader } = opts;
  const requireAdmin = makeRequireAdmin(db);

  app.get('/api/admin/fleet', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const repo = loadManifest(fleetDir, 'repo'), base = loadManifest(fleetDir, 'base');
    const servers = listServers(db);
    const readings = readingsOf(db);
    const states = new Map(readingStates(db).map((s) => [s.serverId, s]));
    return {
      repo: repo && { label: repo.label, at: repo.at },
      base: base && { label: base.label, at: base.at },
      boxes: servers.map((s) => ({
        serverId: s.id, name: s.name, enabled: s.enabled === 1,
        readAt: states.get(s.id)?.readAt ?? null, attemptAt: states.get(s.id)?.attemptAt ?? null,
        error: states.get(s.id)?.error ?? null, pending: reader.pending(s.id),
      })),
      rows: compareFleet(repo, base, servers.map((s) => ({ serverId: s.id, files: readings.get(s.id) ?? null }))),
    };
  });

  app.post('/api/admin/fleet/check', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const b = (req.body ?? {}) as { serverId?: unknown; all?: unknown };
    let ids: number[];
    if (b.all === true) ids = listServers(db).filter((s) => s.enabled === 1).map((s) => s.id);
    else if (typeof b.serverId === 'number' && Number.isInteger(b.serverId)) ids = [b.serverId];
    else return reply.code(400).send({ error: 'send { serverId } or { all: true }' });
    const states = reader.request(ids);
    logAdmin(db, adminId, 'fleet_check', b.all === true ? 'all' : ids[0], { states });
    return { states };
  });
}
```

`src/server.ts`:
- `BuildDeps` gains `/** Injected by tests; built from the servers table otherwise. */ fleetReader?: FleetReader;`
- Near the balance writer: `const fleetReader = deps.fleetReader ?? new FleetReader({ db: deps.db });`
- In the `if (!deps.config.devMode) { ... }` start block: `fleetReader.start();` and `fleetReader.tick();` (a boot tick picks up boxes never read).
- In shutdown beside `balanceWriter.stop()`: `fleetReader.stop();`
- Register beside the balance routes: `await app.register(adminFleetRoutes, { db: deps.db, fleetDir: deps.config.fleetDir, reader: fleetReader });`
- Imports: `import { FleetReader } from './fleetReader.js';`, `import { adminFleetRoutes } from './routes/adminFleet.js';`

- [ ] **Step 4: Run, expect PASS.** `npx vitest run tests/fleetRoutes.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit** `git commit -m "fleet view: admin routes and wiring"`

---

### Task 6: `push-manifest` (repo and base manifests)

**Files:**
- Create: `src/fleetManifest.ts` (pure builders), `scripts/push-manifest.ts` (CLI)
- Test: `tests/fleetManifest.test.ts`

**Interfaces:**
- Produces:
  - `hashTree(root: string, mapTo: string): Promise<Record<string, FileSig>>` (every regular file under `root`, keyed `mapTo + '/' + relative path`; symlinks skipped)
  - `repoManifest(deployDir: string, run?: Runner): Promise<Manifest>`: refuses (throws) when `git status --porcelain -- overrides` is not empty; keys from `git ls-files -z -- overrides`, `overrides/<x>` → `<x>`; label = short commit, at = commit time (ISO)
  - `BASE_LAYERS`, `BASE_DROPPED`; `baseManifest(extractedRoot: string, label: string): Promise<Manifest>` (layers in order, second wins; drops the 64-bit binary dirs)
  - CLI: `npx tsx scripts/push-manifest.ts <deployDir> [--host root@45.32.199.85] [--remote-dir /home/pug/app/data/fleet] [--out <localDir>]` (`--out` writes locally instead of over ssh)

- [ ] **Step 1: Failing test**

```ts
// tests/fleetManifest.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseManifest, repoManifest } from '../src/fleetManifest.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'man-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
function repo() {
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(dir, 'overrides/left4dead/cfg'), { recursive: true });
  mkdirSync(join(dir, 'overrides/left4dead_dlc4/missions'), { recursive: true });
  writeFileSync(join(dir, 'overrides/left4dead/cfg/pug_match.cfg'), 'pm');
  writeFileSync(join(dir, 'overrides/left4dead_dlc4/missions/m.txt'), 'm');
  writeFileSync(join(dir, '.gitignore'), 'secrets.cfg\n');
  writeFileSync(join(dir, 'overrides/left4dead/cfg/secrets.cfg'), 'rcon_password "x"');
  git('add', '-A'); git('commit', '-qm', 'x');
}

describe('repoManifest', () => {
  it('maps overrides to game dir paths, never includes ignored files, labels by commit', async () => {
    repo();
    const m = await repoManifest(dir);
    expect(m.kind).toBe('repo');
    expect(m.label).toMatch(/^[0-9a-f]{7,}$/);
    expect(m.files).toEqual({
      'left4dead/cfg/pug_match.cfg': { size: 2, sha256: sha('pm') },
      'left4dead_dlc4/missions/m.txt': { size: 1, sha256: sha('m') },
    });
  });
  it('refuses uncommitted changes and untracked files under overrides', async () => {
    repo();
    writeFileSync(join(dir, 'overrides/left4dead/cfg/pug_match.cfg'), 'changed');
    await expect(repoManifest(dir)).rejects.toThrow(/uncommitted/);
    git('checkout', '--', '.');
    writeFileSync(join(dir, 'overrides/left4dead/cfg/new.cfg'), 'n');
    await expect(repoManifest(dir)).rejects.toThrow(/uncommitted/);
  });
});

describe('baseManifest', () => {
  it('layers the two install folders, second wins, and drops 64-bit binaries', async () => {
    const top = join(dir, 'l4d1_Roto-AZMod/Files Here');
    const a = join(top, 'Linux Server Files/left4dead'), b = join(top, 'Roto-AZMod Main files/left4dead');
    mkdirSync(join(a, 'addons/sourcemod/bin/linux64'), { recursive: true });
    mkdirSync(join(a, 'cfg'), { recursive: true });
    mkdirSync(join(b, 'cfg'), { recursive: true });
    writeFileSync(join(a, 'addons/sourcemod/bin/linux64/x.so'), 'x');
    writeFileSync(join(a, 'cfg/server.cfg'), 'first');
    writeFileSync(join(b, 'cfg/server.cfg'), 'second');
    writeFileSync(join(b, 'cfg/rotoblin.cfg'), 'r');
    const m = await baseManifest(dir, 'Rotoblin-AZMod v8.6.4');
    expect(m).toMatchObject({ kind: 'base', label: 'Rotoblin-AZMod v8.6.4' });
    expect(m.files).toEqual({
      'left4dead/cfg/server.cfg': { size: 6, sha256: sha('second') },
      'left4dead/cfg/rotoblin.cfg': { size: 1, sha256: sha('r') },
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/fleetManifest.ts`**

```ts
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FileSig, Manifest } from './fleetCompare.js';

/** Builders for the fleet view's reference manifests. Run on the owner's
 *  machine by scripts/push-manifest.ts; nothing here touches a server. */

type Runner = (cmd: string, args: string[]) => Promise<string>;
const execFileAsync = promisify(execFile);
const defaultRun: Runner = async (cmd, args) => (await execFileAsync(cmd, args, { maxBuffer: 32 << 20 })).stdout;
const sha = async (abs: string) => createHash('sha256').update(await readFile(abs)).digest('hex');

export async function hashTree(root: string, mapTo: string): Promise<Record<string, FileSig>> {
  const out: Record<string, FileSig> = {};
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out[`${mapTo}/${p}`] = { size: (await stat(join(root, p))).size, sha256: await sha(join(root, p)) };
    }
  };
  await walk('');
  return out;
}

export async function repoManifest(deployDir: string, run: Runner = defaultRun): Promise<Manifest> {
  const git = (...a: string[]) => run('git', ['-C', deployDir, ...a]);
  if ((await git('status', '--porcelain', '--', 'overrides')).trim() !== '') {
    throw new Error('overrides/ has uncommitted changes or untracked files; commit first so the manifest names a real commit');
  }
  const [hash, at] = (await git('log', '-1', '--format=%h%x09%cI')).trim().split('\t');
  const files: Record<string, FileSig> = {};
  // ls-files, not the directory: git-ignored files such as secrets.cfg never leave the machine.
  for (const p of (await git('ls-files', '-z', '--', 'overrides')).split('\0').filter(Boolean)) {
    const abs = join(deployDir, p);
    files[p.replace(/^overrides\//, '')] = { size: (await stat(abs)).size, sha256: await sha(abs) };
  }
  return { kind: 'repo', label: hash, at, files };
}

/** The two layers install-server.sh copies, in its order. */
export const BASE_LAYERS = [
  'l4d1_Roto-AZMod/Files Here/Linux Server Files/left4dead',
  'l4d1_Roto-AZMod/Files Here/Roto-AZMod Main files/left4dead',
];
/** What install-server.sh deletes after copying. */
export const BASE_DROPPED = [
  'left4dead/addons/metamod/bin/linux64/', 'left4dead/addons/metamod/bin/win64/',
  'left4dead/addons/sourcemod/bin/linux64/', 'left4dead/addons/stripper/bin/linux64/',
];

export async function baseManifest(extractedRoot: string, label: string): Promise<Manifest> {
  const files: Record<string, FileSig> = {};
  for (const layer of BASE_LAYERS) Object.assign(files, await hashTree(join(extractedRoot, layer), 'left4dead'));
  for (const p of Object.keys(files)) if (BASE_DROPPED.some((d) => p.startsWith(d))) delete files[p];
  return { kind: 'base', label, at: new Date().toISOString(), files };
}
```

`scripts/push-manifest.ts`:

```ts
/**
 * Build the fleet view's reference manifests and put them on the site.
 *
 *   npx tsx scripts/push-manifest.ts ~/l4d/deploy                  # to the site over ssh
 *   npx tsx scripts/push-manifest.ts ~/l4d/deploy --out /tmp/fleet # to a local dir
 *
 * repo.json: the deploy repo's overrides/ at HEAD (refuses uncommitted changes).
 * base.json: the Rotoblin-AZMod release the boxes were installed from, the
 * same ZIP install-server.sh downloads, cached in ~/.cache/pug-fleet.
 * Only paths, sizes and hashes leave this machine.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseManifest, repoManifest } from '../src/fleetManifest.js';

const args = process.argv.slice(2);
const deployDir = args[0];
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
if (!deployDir || deployDir.startsWith('--')) {
  console.error('usage: push-manifest.ts <deployDir> [--host root@45.32.199.85] [--remote-dir /home/pug/app/data/fleet] [--out <dir>]');
  process.exit(2);
}
const host = opt('--host', 'root@45.32.199.85');
const remoteDir = opt('--remote-dir', '/home/pug/app/data/fleet');
const out = opt('--out', '');

const install = readFileSync(join(deployDir, 'install-server.sh'), 'utf8');
const version = /^ROTO_VERSION=(\S+)/m.exec(install)?.[1];
if (!version) throw new Error('ROTO_VERSION not found in install-server.sh');
const url = `https://github.com/fbef0102/Rotoblin-AZMod/releases/download/${version}/l4d1_Roto-AZMod.zip`;

const cache = join(homedir(), '.cache', 'pug-fleet');
mkdirSync(cache, { recursive: true });
const zip = join(cache, `l4d1_Roto-AZMod-${version}.zip`);
if (!existsSync(zip)) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(`${zip}.part`, Buffer.from(await res.arrayBuffer()));
  renameSync(`${zip}.part`, zip);
}
const x = mkdtempSync(join(tmpdir(), 'roto-'));
try {
  execFileSync('unzip', ['-q', zip, '-d', x]);
  const repo = await repoManifest(deployDir);
  const base = await baseManifest(x, `Rotoblin-AZMod ${version}`);
  console.log(`repo ${repo.label}: ${Object.keys(repo.files).length} files; base ${base.label}: ${Object.keys(base.files).length} files`);
  for (const m of [repo, base]) {
    const body = JSON.stringify(m);
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${m.kind}.json.part`), body);
      renameSync(join(out, `${m.kind}.json.part`), join(out, `${m.kind}.json`));
    } else {
      const f = `${remoteDir}/${m.kind}.json`;
      const r = spawnSync('ssh', [host, `mkdir -p '${remoteDir}' && cat > '${f}.part' && chown pug:pug '${f}.part' && mv '${f}.part' '${f}'`], { input: body });
      if (r.status !== 0) throw new Error(`ssh write failed: ${r.stderr.toString()}`);
    }
  }
  console.log(out ? `written to ${out}` : `pushed to ${host}:${remoteDir}`);
} finally {
  rmSync(x, { recursive: true, force: true });
}
```

(The remote `chown` assumes the `pug` user exists; the fleet dir must be readable by the site, which runs as `pug`.)

- [ ] **Step 4: Run, expect PASS.** `npx vitest run tests/fleetManifest.test.ts`

- [ ] **Step 5: Run the CLI locally** against the real deploy repo into the scratchpad: `npx tsx scripts/push-manifest.ts /home/volence/l4d/deploy --out "$SCRATCH/fleet"`. Expect about 150 repo files and a base count in the hundreds, and no `secrets.cfg` key (`grep -c secrets "$SCRATCH/fleet/repo.json"` prints 0).

- [ ] **Step 6: Commit** `git commit -m "fleet view: push-manifest builds the repo and base references"`

---

### Task 7: The Fleet page

**Files:**
- Modify: `web/src/api.ts`, `web/src/routes/admin/adminRoutes.ts` (`SETUP_TABS`), `web/src/routes/Admin.tsx`, `web/src/styles/app.css`
- Create: `web/src/routes/admin/AdminFleet.tsx`
- Test: `web/src/routes/admin/AdminFleet.test.tsx`, `web/src/routes/admin/adminRoutes.test.ts` (tab list, if it asserts one)

**Interfaces:**
- Consumes: Task 5 routes.
- Produces: `adminApi.fleet(signal?)`, `adminApi.fleetCheck(body)`; types `FleetState`, `FleetRowView`, `FleetCellView`, `FleetBox`.

- [ ] **Step 1: Failing test**

```tsx
// web/src/routes/admin/AdminFleet.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { FleetState } from '../../api';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { fleet: vi.fn(), fleetCheck: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { AdminFleet } = await import('./AdminFleet');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const P = 'left4dead/addons/sourcemod/plugins/pug-match.smx';
const C = 'left4dead/cfg/server.cfg';
const cell = (label: string, highlight: boolean, size = 81241, sha = 'a3e924c6aaaa') => ({ sig: { size, sha256: sha }, label, highlight, sizeOnly: false });
const state: FleetState = {
  repo: { label: '57add2c', at: '2026-09-24T12:00:00Z' },
  base: { label: 'Rotoblin-AZMod v8.6.4', at: '2026-09-24T12:00:00Z' },
  boxes: [
    { serverId: 1, name: 'Dallas', enabled: true, readAt: '2026-09-24 11:00:00', attemptAt: '2026-09-24 11:00:00', error: null, pending: false },
    { serverId: 2, name: 'Chicago', enabled: true, readAt: '2026-09-23 11:00:00', attemptAt: '2026-09-24 11:00:00', error: 'timed out after 600 s', pending: false },
  ],
  rows: [
    { path: P, area: 'plugins', repo: { size: 81241, sha256: 'a3e924c6aaaa' }, base: null, patchedEverywhere: false, differs: true,
      cells: { 1: cell('neither', true, 81639, 'f7ee35c3bbbb'), 2: cell('repo', false) } },
    { path: C, area: 'configs', repo: null, base: { size: 5, sha256: 'b' }, patchedEverywhere: true, differs: false,
      cells: { 1: cell('neither', false, 6, 'c'), 2: cell('neither', false, 6, 'c') } },
  ],
};

describe('AdminFleet', () => {
  beforeEach(() => { mockAdmin.fleet.mockResolvedValue(state); mockAdmin.fleetCheck.mockResolvedValue({ states: { 1: 'queued' } }); });

  it('shows the references, box chips with errors, and a summary of differences', async () => {
    render(<AdminFleet />);
    expect(await screen.findByText(/Repo: 57add2c/)).toBeTruthy();
    expect(screen.getByText(/Rotoblin-AZMod v8.6.4/)).toBeTruthy();
    expect(screen.getByText(/timed out after 600 s/)).toBeTruthy();
    expect(screen.getByText(/1 difference: pug-match.smx \(Dallas\)/)).toBeTruthy();
  });

  it('shows differences only by default and everything on request', async () => {
    render(<AdminFleet />);
    await screen.findByText(P);
    expect(screen.queryByText(C)).toBeNull();
    fireEvent.click(screen.getByLabelText('Differences only'));
    expect(screen.getByText(C)).toBeTruthy();
    expect(screen.getAllByText(/patched on all boxes/).length).toBeGreaterThan(0);
  });

  it('marks a highlighted cell and checks a box or all', async () => {
    render(<AdminFleet />);
    const hi = await screen.findByText(/81639 · f7ee35c3/);
    expect(hi.closest('td')!.className).toContain('admin-warn');
    fireEvent.click(screen.getByRole('button', { name: 'Check Dallas now' }));
    await waitFor(() => expect(mockAdmin.fleetCheck).toHaveBeenCalledWith({ serverId: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Check all' }));
    await waitFor(() => expect(mockAdmin.fleetCheck).toHaveBeenCalledWith({ all: true }));
  });

  it('filters by area', async () => {
    render(<AdminFleet />);
    await screen.findByText(P);
    fireEvent.click(screen.getByLabelText('Differences only'));
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'configs' } });
    expect(screen.queryByText(P)).toBeNull();
    expect(screen.getByText(C)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`web/src/api.ts` (types beside the balance ones, calls in `adminApi`):

```ts
export interface FleetSig { size: number; sha256: string | null }
export interface FleetCellView { sig: FleetSig | null; label: 'repo' | 'base' | 'neither' | 'missing' | 'unread'; highlight: boolean; sizeOnly: boolean }
export interface FleetRowView {
  path: string; area: 'plugins' | 'configs' | 'data' | 'gamedata' | 'extensions' | 'stripper' | 'other';
  repo: FleetSig | null; base: FleetSig | null; cells: Record<number, FleetCellView>; patchedEverywhere: boolean; differs: boolean;
}
export interface FleetBox { serverId: number; name: string; enabled: boolean; readAt: string | null; attemptAt: string | null; error: string | null; pending: boolean }
export interface FleetState { repo: { label: string; at: string } | null; base: { label: string; at: string } | null; boxes: FleetBox[]; rows: FleetRowView[] }
```

```ts
  fleet: (signal?: AbortSignal) => get<FleetState>('/api/admin/fleet', signal),
  fleetCheck: (body: { serverId: number } | { all: true }) => post<{ states: Record<number, string> }>('/api/admin/fleet/check', body),
```

`adminRoutes.ts` `SETUP_TABS`: add `{ key: 'fleet', label: 'Fleet', path: '/admin/setup/fleet' }` after campaigns. `Admin.tsx`: `{r.desk === 'setup' && r.section === 'fleet' && <AdminFleet />}` and the import.

`web/src/routes/admin/AdminFleet.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type FleetCellView, type FleetRowView, type FleetSig } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

const AREAS = [['all', 'Everything'], ['plugins', 'Plugins'], ['configs', 'Configs'], ['data', 'Data'], ['gamedata', 'Gamedata'],
  ['extensions', 'Extensions'], ['stripper', 'Stripper'], ['other', 'Everything else']] as const;
const short = (s: FleetSig | null) => (s ? `${s.size} · ${s.sha256 ? s.sha256.slice(0, 8) : 'too large'}` : '');
const fileName = (p: string) => p.split('/').pop() ?? p;
const LABEL: Record<FleetCellView['label'], string> = { repo: 'repo', base: 'base', neither: 'neither', missing: 'missing', unread: 'not read yet' };

/** Admin > Setup > Fleet: what every game server has, file by file, against
 *  the deploy repo and the Rotoblin base. Read-only. */
export function AdminFleet() {
  const fleet = useFetch((s) => adminApi.fleet(s), []);
  const { busy, error, run } = useAction(fleet.reload);
  const [diffOnly, setDiffOnly] = useState(true);
  const [area, setArea] = useState<string>('all');
  if (fleet.error) return <Empty>Could not load the fleet view.</Empty>;
  const d = fleet.data;
  if (!d) return <p class="muted">Loading...</p>;

  const differing = d.rows.filter((r) => r.differs);
  const summary = differing.length === 0
    ? 'No differences.'
    : `${differing.length} difference${differing.length === 1 ? '' : 's'}: ${differing.slice(0, 5).map((r) =>
      `${fileName(r.path)} (${d.boxes.filter((b) => r.cells[b.serverId]?.highlight).map((b) => b.name).join(', ')})`).join('; ')}${differing.length > 5 ? '; ...' : ''}`;
  const rows = d.rows.filter((r) => (!diffOnly || r.differs) && (area === 'all' || r.area === area));

  const cellText = (r: FleetRowView, c: FleetCellView | undefined) => {
    if (!c) return '';
    if (c.label === 'unread' || c.label === 'missing') return LABEL[c.label];
    const tag = r.patchedEverywhere ? 'base, patched on all boxes' : LABEL[c.label];
    return `${short(c.sig)} (${tag}${c.sizeOnly ? ', size only' : ''})`;
  };

  return (
    <div class="stack">
      <Panel>
        <h3>Fleet</h3>
        <p class="muted">
          Repo: {d.repo ? `${d.repo.label}, pushed ${fmtTime(d.repo.at)}` : 'no repo manifest yet (run scripts/push-manifest.ts)'}
          {' · '}Base: {d.base ? d.base.label : 'no base manifest yet'}
        </p>
        {error && <p class="error">{error}</p>}
        <div class="fleet-boxes">
          {d.boxes.map((b) => (
            <div key={b.serverId} class="fleet-box">
              <strong>{b.name}</strong>{' '}
              <span class="muted">{b.readAt ? `read ${fmtTime(b.readAt)}` : 'never read'}</span>
              {b.error && <span class="error"> · last attempt failed: {b.error}</span>}
              {' '}
              <button class="btn btn--ghost btn--sm" type="button" disabled={busy || b.pending || !b.enabled}
                aria-label={`Check ${b.name} now`} onClick={() => void run(() => adminApi.fleetCheck({ serverId: b.serverId }))}>
                {b.pending ? 'Queued' : 'Check now'}
              </button>
            </div>
          ))}
          <button class="btn" type="button" disabled={busy} onClick={() => void run(() => adminApi.fleetCheck({ all: true }))}>Check all</button>
        </div>
        <p>{summary}</p>
      </Panel>
      <Panel class="panel--table">
        <div class="admin-form">
          <label><input type="checkbox" checked={diffOnly} aria-label="Differences only"
            onChange={() => setDiffOnly(!diffOnly)} /> Differences only</label>
          <label>Area{' '}
            <select value={area} aria-label="Area" onChange={(e) => setArea((e.target as HTMLSelectElement).value)}>
              {AREAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
        {rows.length === 0 ? <p class="muted">Nothing to show.</p> : (
          <div class="table-wrap">
            <table class="admin-table fleet-table">
              <thead><tr><th>File</th><th>Repo</th><th>Base</th>{d.boxes.map((b) => <th key={b.serverId}>{b.name}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.path}>
                    <td><code>{r.path}</code></td>
                    <td>{short(r.repo)}</td>
                    <td>{short(r.base)}</td>
                    {d.boxes.map((b) => {
                      const c = r.cells[b.serverId];
                      return <td key={b.serverId} class={c?.highlight ? 'admin-warn' : ''}>{cellText(r, c)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
```

`app.css` (beside the balance styles):

```css
/* Fleet view: box chips wrap; the file column keeps long paths breakable. */
.fleet-boxes { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); align-items: center; margin: var(--sp-2) 0; }
.fleet-table code { overflow-wrap: anywhere; font-size: var(--fs-dense); }
.fleet-table td { white-space: nowrap; }
.fleet-table td:first-child { white-space: normal; min-width: 16rem; }
```

- [ ] **Step 4: Run** `npx vitest run web/src/routes/admin web/src/routes/admin.test.tsx && npm run typecheck`, expect PASS. (Add `fleet: vi.fn()` to `admin.test.tsx`'s `mockAdmin` only if a test there renders the Fleet tab.)

- [ ] **Step 5: Commit** `git commit -m "fleet view: Admin > Setup > Fleet page"`

---

### Task 8: Full suite, then a read-only look at the real boxes

- [ ] **Step 1:** `npx vitest run && npm run typecheck`: all green.
- [ ] **Step 2 (only with the owner's go-ahead: it connects to production game servers, read-only):** on a copy of the production database, run the reader against the four real boxes from this machine and print the difference summary. Dallas is reached as sftp (`root@45.32.199.85`, its game dir) for this check, since the local transport only works on the box itself. Expect: Dallas's pug-match build differs; Riverside #4 gets a reading.
- [ ] **Step 3:** Owner runbook in the commit message or the plan footer: after deploy, run `npx tsx scripts/push-manifest.ts ~/l4d/deploy`, then Check all on the page.
