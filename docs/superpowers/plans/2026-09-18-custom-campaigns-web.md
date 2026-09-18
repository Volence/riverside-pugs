# Custom Campaigns (Web Side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin uploads a custom campaign VPK in the panel; it installs to every enabled server, joins the vote pool, attributes stats like any stock campaign, and appears on a public page with install instructions and a download link.

**Architecture:** A DB-backed campaign registry replaces the two hardcoded campaign tables. Uploads stream into the game server's `addons/` directory (one copy, so the file players download is the file the server runs), install to remote servers over FTP behind a transport interface, and the public download route resolves paths from the DB rather than from the URL. Chapter selection is deliberately **not** here — it needs a mission-file precedence spike and a plugin change, and lives in plan 2.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Preact (preact-iso), Vitest. New dependencies: `@fastify/multipart`, `basic-ftp`.

**Spec:** `docs/superpowers/specs/2026-09-18-custom-campaigns-design.md`

**Scope note — this is plan 1 of 2.** Plan 1 delivers working software: custom campaigns are uploadable, installable, downloadable, poolable, votable and correctly attributed, playing their **native** chapter list and ending on their own finale exactly as stock campaigns do today. Plan 2 (`docs/superpowers/specs/…` sections 4, 4b) adds per-chapter include/exclude and reorder, which requires the mission-precedence spike and the plugin's last-map rule. Do not start plan 2 work here; the `included` / `play_order` columns exist from task 1 so plan 2 is an additive change.

## Global Constraints

- **No migration framework.** `src/db.ts` uses `CREATE TABLE IF NOT EXISTS` in `SCHEMA` plus the `ensureColumn(db, table, column, ddl)` helper. Follow that exactly. Do not introduce a migration library.
- **`src/campaigns.ts` stays pure.** `CAMPAIGNS` keeps no DB dependency — `tests/config.test.ts:40` asserts its exact keys and `src/discord/commands.ts` reads it at module scope. New DB-aware code goes in a new file.
- **Never fail a match.** Install and upload errors are recorded and retried, never fatal to a match. Same rule `src/r2.ts` already follows for demos.
- **Never resolve a served path from user input.** Download routes take a campaign slug, look the filename up in the DB, and join it to the configured addons directory. The addons directory also holds metamod, stripper and l4dtoolz; it is never listed and never indexed.
- **No em dashes** in code, comments, commits or docs.
- Comments explain *why*, not *what*. Match the density of surrounding code.

---

### Task 1: Schema and store

**Files:**
- Modify: `src/db.ts` (append to `SCHEMA`; add `ensureColumn` calls in `openDb`)
- Create: `src/customCampaigns.ts`
- Test: `tests/customCampaigns.test.ts`

**Interfaces:**
- Consumes: `DB` from `src/db.js`
- Produces:
  - `type CampaignState = 'draft' | 'published'`
  - `type InstallState = 'pending' | 'installed' | 'failed'`
  - `interface CustomCampaignRow { slug: string; name: string; vpk_filename: string; size_bytes: number; sha256: string; state: CampaignState; enabled: number; uploaded_by: string | null; uploaded_at: number; notes: string | null }`
  - `interface ChapterRow { slug: string; ordinal: number; map: string; display: string | null; is_finale: number; included: number; play_order: number | null }`
  - `interface InstallRow { slug: string; server_id: number; state: InstallState; sha256: string | null; error: string | null; updated_at: number }`
  - `insertDraft(db, c: { slug: string; name: string; vpkFilename: string; sizeBytes: number; sha256: string; uploadedBy: string | null }, chapters: { map: string; display: string | null; isFinale: boolean }[]): void`
  - `getCampaign(db, slug: string): CustomCampaignRow | undefined`
  - `listCampaigns(db, opts?: { state?: CampaignState; enabledOnly?: boolean }): CustomCampaignRow[]`
  - `chaptersOf(db, slug: string): ChapterRow[]`
  - `publishCampaign(db, slug: string, name: string): void`
  - `setEnabled(db, slug: string, enabled: boolean): void`
  - `deleteCampaign(db, slug: string): void`
  - `installsOf(db, slug: string): InstallRow[]`
  - `setInstall(db, slug: string, serverId: number, state: InstallState, extra?: { sha256?: string | null; error?: string | null }): void`

- [ ] **Step 1: Write the failing test**

Create `tests/customCampaigns.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  insertDraft, getCampaign, listCampaigns, chaptersOf, publishCampaign,
  setEnabled, deleteCampaign, installsOf, setInstall,
} from '../src/customCampaigns.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const draft = (slug = 'dbd') =>
  insertDraft(db, {
    slug, name: 'Dead Before Dawn', vpkFilename: `${slug}.vpk`,
    sizeBytes: 1234, sha256: 'a'.repeat(64), uploadedBy: '76561198000000001',
  }, [
    { map: 'dbd1_alley', display: 'Alley', isFinale: false },
    { map: 'dbd2_mall', display: 'Mall', isFinale: false },
    { map: 'dbd3_roof', display: 'Roof', isFinale: true },
  ]);

describe('custom campaign store', () => {
  it('stores a draft with its chapters in file order', () => {
    draft();
    const c = getCampaign(db, 'dbd')!;
    expect(c.state).toBe('draft');
    expect(c.enabled).toBe(0);
    expect(chaptersOf(db, 'dbd').map((ch) => ch.map))
      .toEqual(['dbd1_alley', 'dbd2_mall', 'dbd3_roof']);
  });

  // Every chapter starts included and in file order, so a campaign that is
  // never touched on the confirm screen still plays exactly as it shipped.
  it('defaults every chapter to included, in file order', () => {
    draft();
    for (const ch of chaptersOf(db, 'dbd')) {
      expect(ch.included).toBe(1);
      expect(ch.play_order).toBe(ch.ordinal);
    }
  });

  it('marks the last chapter as the finale', () => {
    draft();
    expect(chaptersOf(db, 'dbd').map((c) => c.is_finale)).toEqual([0, 0, 1]);
  });

  // A draft is half-uploaded and must never reach the pool or the public page.
  it('lists only published campaigns when asked', () => {
    draft('dbd');
    draft('other');
    publishCampaign(db, 'dbd', 'Dead Before Dawn');
    expect(listCampaigns(db, { state: 'published' }).map((c) => c.slug)).toEqual(['dbd']);
  });

  // Publishing and enabling are separate acts: a published campaign can sit
  // out of the pool indefinitely without being re-uploaded.
  it('keeps enabled separate from published', () => {
    draft();
    publishCampaign(db, 'dbd', 'Dead Before Dawn');
    expect(getCampaign(db, 'dbd')!.enabled).toBe(0);
    setEnabled(db, 'dbd', true);
    expect(listCampaigns(db, { state: 'published', enabledOnly: true }).map((c) => c.slug))
      .toEqual(['dbd']);
  });

  it('records install state per server', () => {
    draft();
    setInstall(db, 'dbd', 1, 'installed', { sha256: 'b'.repeat(64) });
    setInstall(db, 'dbd', 2, 'failed', { error: 'connection refused' });
    const rows = installsOf(db, 'dbd');
    expect(rows.find((r) => r.server_id === 1)!.state).toBe('installed');
    expect(rows.find((r) => r.server_id === 2)!.error).toBe('connection refused');
  });

  // setInstall is called on every retry, so it must update rather than throw.
  it('overwrites an install row on retry', () => {
    draft();
    setInstall(db, 'dbd', 1, 'failed', { error: 'timeout' });
    setInstall(db, 'dbd', 1, 'installed', { sha256: 'c'.repeat(64), error: null });
    const row = installsOf(db, 'dbd')[0];
    expect(row.state).toBe('installed');
    expect(row.error).toBeNull();
  });

  it('deletes chapters and installs along with the campaign', () => {
    draft();
    setInstall(db, 'dbd', 1, 'installed');
    deleteCampaign(db, 'dbd');
    expect(getCampaign(db, 'dbd')).toBeUndefined();
    expect(chaptersOf(db, 'dbd')).toEqual([]);
    expect(installsOf(db, 'dbd')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/customCampaigns.test.ts`
Expected: FAIL, cannot resolve `../src/customCampaigns.js`.

- [ ] **Step 3: Add the schema**

In `src/db.ts`, append to the `SCHEMA` template string (after the `settings` table):

```sql
CREATE TABLE IF NOT EXISTS custom_campaigns (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vpk_filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','published')),
  enabled INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  uploaded_at INTEGER NOT NULL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS custom_campaign_chapters (
  slug TEXT NOT NULL REFERENCES custom_campaigns(slug) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  map TEXT NOT NULL,
  display TEXT,
  is_finale INTEGER NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 1,
  play_order INTEGER,
  PRIMARY KEY (slug, ordinal)
);
CREATE TABLE IF NOT EXISTS custom_campaign_installs (
  slug TEXT NOT NULL REFERENCES custom_campaigns(slug) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES servers(id),
  state TEXT NOT NULL CHECK (state IN ('pending','installed','failed')),
  sha256 TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (slug, server_id)
);
CREATE INDEX IF NOT EXISTS custom_chapter_map ON custom_campaign_chapters(map);
```

The index on `map` is what makes `resolveCampaignForMap` in task 3 a lookup rather than a scan.

In `openDb`, alongside the existing `ensureColumn` calls, add the addons transport columns:

```ts
  // How a campaign VPK reaches this box. 'local' is a filesystem copy, which
  // is only correct when the web app runs on the same machine as the game
  // server; anything else needs 'ftp'. Defaulted to 'local' with a NULL
  // addons_dir so an existing row is inert until an admin configures it:
  // a half-configured transport must no-op, never write to a guessed path.
  ensureColumn(db, 'servers', 'addons_transport', "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, 'servers', 'addons_dir', 'TEXT');
  ensureColumn(db, 'servers', 'ftp_host', 'TEXT');
  ensureColumn(db, 'servers', 'ftp_port', 'INTEGER');
  ensureColumn(db, 'servers', 'ftp_user', 'TEXT');
  ensureColumn(db, 'servers', 'ftp_password', 'TEXT');
```

- [ ] **Step 4: Write the store**

Create `src/customCampaigns.ts`:

```ts
import type { DB } from './db.js';

export type CampaignState = 'draft' | 'published';
export type InstallState = 'pending' | 'installed' | 'failed';

export interface CustomCampaignRow {
  slug: string;
  name: string;
  vpk_filename: string;
  size_bytes: number;
  sha256: string;
  state: CampaignState;
  enabled: number;
  uploaded_by: string | null;
  uploaded_at: number;
  notes: string | null;
}

export interface ChapterRow {
  slug: string;
  ordinal: number;
  map: string;
  display: string | null;
  is_finale: number;
  included: number;
  /** Position in the generated mission. NULL when excluded. Always agrees with
   *  `included`: the two are written together and never independently. */
  play_order: number | null;
}

export interface InstallRow {
  slug: string;
  server_id: number;
  state: InstallState;
  sha256: string | null;
  error: string | null;
  updated_at: number;
}

/**
 * Write a freshly parsed upload as a draft, with its chapters in file order.
 *
 * Every chapter starts included and in file order, so a campaign nobody edits
 * on the confirm screen plays exactly as its author shipped it. The last
 * chapter is marked the finale: L4D1 mission files do not reliably say which
 * one is, and the last one always is in practice. The admin can correct it.
 */
export function insertDraft(
  db: DB,
  c: {
    slug: string; name: string; vpkFilename: string;
    sizeBytes: number; sha256: string; uploadedBy: string | null;
  },
  chapters: { map: string; display: string | null; isFinale: boolean }[],
): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO custom_campaigns
         (slug, name, vpk_filename, size_bytes, sha256, state, enabled, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?)`,
    ).run(c.slug, c.name, c.vpkFilename, c.sizeBytes, c.sha256, c.uploadedBy, Date.now());

    const ins = db.prepare(
      `INSERT INTO custom_campaign_chapters
         (slug, ordinal, map, display, is_finale, included, play_order)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    );
    chapters.forEach((ch, i) => {
      const ordinal = i + 1;
      const isFinale = ch.isFinale || i === chapters.length - 1;
      ins.run(c.slug, ordinal, ch.map, ch.display, isFinale ? 1 : 0, ordinal);
    });
  })();
}

export function getCampaign(db: DB, slug: string): CustomCampaignRow | undefined {
  return db.prepare('SELECT * FROM custom_campaigns WHERE slug = ?').get(slug) as
    CustomCampaignRow | undefined;
}

export function listCampaigns(
  db: DB, opts: { state?: CampaignState; enabledOnly?: boolean } = {},
): CustomCampaignRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.state) { where.push('state = ?'); args.push(opts.state); }
  if (opts.enabledOnly) where.push('enabled = 1');
  const sql = `SELECT * FROM custom_campaigns${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name`;
  return db.prepare(sql).all(...args) as CustomCampaignRow[];
}

export function chaptersOf(db: DB, slug: string): ChapterRow[] {
  return db.prepare(
    'SELECT * FROM custom_campaign_chapters WHERE slug = ? ORDER BY ordinal',
  ).all(slug) as ChapterRow[];
}

export function publishCampaign(db: DB, slug: string, name: string): void {
  db.prepare("UPDATE custom_campaigns SET state = 'published', name = ? WHERE slug = ?")
    .run(name, slug);
}

export function setEnabled(db: DB, slug: string, enabled: boolean): void {
  db.prepare('UPDATE custom_campaigns SET enabled = ? WHERE slug = ?').run(enabled ? 1 : 0, slug);
}

export function deleteCampaign(db: DB, slug: string): void {
  // Explicit child deletes rather than relying on ON DELETE CASCADE: the
  // pragma is on in openDb, but this module is also exercised against
  // databases opened elsewhere and the cost of being explicit is two lines.
  db.transaction(() => {
    db.prepare('DELETE FROM custom_campaign_installs WHERE slug = ?').run(slug);
    db.prepare('DELETE FROM custom_campaign_chapters WHERE slug = ?').run(slug);
    db.prepare('DELETE FROM custom_campaigns WHERE slug = ?').run(slug);
  })();
}

export function installsOf(db: DB, slug: string): InstallRow[] {
  return db.prepare(
    'SELECT * FROM custom_campaign_installs WHERE slug = ? ORDER BY server_id',
  ).all(slug) as InstallRow[];
}

/** Upsert, because this is called on every retry of a failing install. */
export function setInstall(
  db: DB, slug: string, serverId: number, state: InstallState,
  extra: { sha256?: string | null; error?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO custom_campaign_installs (slug, server_id, state, sha256, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug, server_id) DO UPDATE SET
       state = excluded.state, sha256 = excluded.sha256,
       error = excluded.error, updated_at = excluded.updated_at`,
  ).run(slug, serverId, state, extra.sha256 ?? null, extra.error ?? null, Date.now());
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/customCampaigns.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the full suite (schema changes touch every test that opens a DB)**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/customCampaigns.ts tests/customCampaigns.test.ts
git commit -m "Custom campaigns get tables and a store"
```

---

### Task 2: VPK reader and mission parser

**Files:**
- Create: `src/vpk.ts`
- Create: `tests/fixtures/makeVpk.ts`
- Test: `tests/vpk.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `interface MissionChapter { map: string; display: string | null }`
  - `interface Mission { name: string; displayTitle: string; chapters: MissionChapter[] }`
  - `parseKeyValues(text: string): KvNode` where `type KvNode = { [key: string]: string | KvNode }`
  - `parseMission(text: string): Mission | null`
  - `readMissionFromVpk(vpkPath: string): { file: string; text: string } | null`
  - `missionFromVpk(vpkPath: string): Mission | null`

**Background the implementer needs.** A VPK is Valve's archive format. A `_dir.vpk` begins with a header: magic `0x55aa1234` (uint32 LE), version (uint32), directory tree length (uint32). Version 2 adds four more uint32 fields, so the tree starts at byte 28 rather than 12. The tree is nested NUL-terminated strings: extension, then path, then filename, each level ending with an empty string. Each file entry carries CRC (uint32), preload bytes (uint16), archive index (uint16), offset (uint32), length (uint32), then terminator `0xffff`. When archive index is `0x7fff` the data lives in this same file, immediately after the tree, at the recorded offset; preload bytes sit inline right after the entry. Mission files are small and almost always preload or live in the dir file, which is why this reader does not open the numbered archives.

- [ ] **Step 1: Write the fixture builder**

Create `tests/fixtures/makeVpk.ts`. A real campaign VPK is too large to commit, so tests build a minimal valid v1 VPK in memory:

```ts
import { writeFileSync } from 'node:fs';

/** Write a minimal, valid VPK v1 containing one file, for parser tests.
 *  Only the shape src/vpk.ts reads is produced: one extension, one path, one
 *  filename, data stored inline in the dir file. */
export function makeVpk(path: string, entry: { ext: string; dir: string; name: string; body: string }): void {
  const body = Buffer.from(entry.body, 'utf8');
  const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

  const meta = Buffer.alloc(18);
  meta.writeUInt32LE(0, 0);          // CRC, unchecked by the reader
  meta.writeUInt16LE(0, 4);          // preload bytes
  meta.writeUInt16LE(0x7fff, 6);     // archive index: this file
  meta.writeUInt32LE(0, 8);          // offset, from the end of the tree
  meta.writeUInt32LE(body.length, 12);
  meta.writeUInt16LE(0xffff, 16);    // entry terminator

  const tree = Buffer.concat([
    cstr(entry.ext), cstr(entry.dir), cstr(entry.name), meta,
    Buffer.from([0]), // end of filenames
    Buffer.from([0]), // end of paths
    Buffer.from([0]), // end of extensions
  ]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(tree.length, 8);

  writeFileSync(path, Buffer.concat([header, tree, body]));
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/vpk.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVpk } from './fixtures/makeVpk.js';
import { parseKeyValues, parseMission, missionFromVpk } from '../src/vpk.js';

const MISSION = `
"mission"
{
  "Name" "dbd"
  "DisplayTitle" "Dead Before Dawn"
  "modes"
  {
    "coop"
    {
      "1" { "Map" "dbd1_alley" "DisplayName" "Alley" }
    }
    "versus"
    {
      "1" { "Map" "dbd1_alley" "DisplayName" "Alley (VS)" "VersusModifier" "1.0" }
      "2" { "Map" "dbd2_mall" "DisplayName" "Mall" }
      "10" { "Map" "dbd10_roof" "DisplayName" "Roof" }
    }
  }
}
`;

describe('parseKeyValues', () => {
  it('reads nested blocks and quoted values', () => {
    const kv = parseKeyValues('"a" { "b" "1" "c" { "d" "2" } }') as Record<string, never>;
    expect(kv).toEqual({ a: { b: '1', c: { d: '2' } } });
  });

  // Mission files in the wild are full of // comments, including on the same
  // line as a value. A parser that chokes on them rejects real campaigns.
  it('ignores line comments', () => {
    expect(parseKeyValues('// lead\n"a" "1" // trailing\n')).toEqual({ a: '1' });
  });
});

describe('parseMission', () => {
  it('reads the title and the versus chapters', () => {
    const m = parseMission(MISSION)!;
    expect(m.name).toBe('dbd');
    expect(m.displayTitle).toBe('Dead Before Dawn');
    expect(m.chapters.map((c) => c.map)).toEqual(['dbd1_alley', 'dbd2_mall', 'dbd10_roof']);
  });

  // Chapter keys are strings, so a naive sort puts "10" before "2" and the
  // campaign plays out of order. They must be ordered numerically.
  it('orders chapters numerically, not lexically', () => {
    expect(parseMission(MISSION)!.chapters[2].map).toBe('dbd10_roof');
  });

  it('takes versus, never coop', () => {
    expect(parseMission(MISSION)!.chapters[0].display).toBe('Alley (VS)');
  });

  // Returning null rather than a guess: a campaign with no versus chapters
  // cannot be played here, and an empty campaign row is worse than a refusal.
  it('returns null when there are no versus chapters', () => {
    expect(parseMission('"mission" { "Name" "x" "modes" { "coop" { } } }')).toBeNull();
  });
});

describe('missionFromVpk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vpk-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('finds and parses missions/*.txt inside a VPK', () => {
    const p = join(dir, 'dbd.vpk');
    makeVpk(p, { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION });
    expect(missionFromVpk(p)!.displayTitle).toBe('Dead Before Dawn');
  });

  it('returns null for a VPK with no mission file', () => {
    const p = join(dir, 'skin.vpk');
    makeVpk(p, { ext: 'vmt', dir: 'materials', name: 'hunter', body: 'x' });
    expect(missionFromVpk(p)).toBeNull();
  });

  it('returns null for a file that is not a VPK at all', () => {
    const p = join(dir, 'notavpk.vpk');
    makeVpk(p, { ext: 'txt', dir: 'missions', name: 'x', body: MISSION });
    require('node:fs').writeFileSync(p, Buffer.from('this is not a vpk'));
    expect(missionFromVpk(p)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/vpk.test.ts`
Expected: FAIL, cannot resolve `../src/vpk.js`.

- [ ] **Step 4: Write the parser**

Create `src/vpk.ts`:

```ts
import { readFileSync } from 'node:fs';

/**
 * Just enough VPK to find a campaign's mission file, and just enough
 * KeyValues to read it.
 *
 * Hand-rolled for the same reason src/rconPacket.ts is: the surface actually
 * used is one archive layout and one text format, read once at upload time,
 * against files that are never written back. A general VPK library would be a
 * large dependency for a header, a string tree and a struct.
 *
 * Deliberately does NOT open the numbered archive files (pak01_001.vpk and
 * friends). Mission files are a few kilobytes and live in the directory file
 * or its preload area in every campaign seen so far. A campaign that hides its
 * mission in an archive parses as "no mission", which the upload path reports
 * as a rejection rather than a crash.
 */

export type KvNode = { [key: string]: string | KvNode };

const VPK_MAGIC = 0x55aa1234;

/** Tokenise KeyValues: quoted strings, bare tokens, braces, // comments. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < text.length && text[i] !== '"') { s += text[i]; i++; }
      i++;
      out.push(s);
      continue;
    }
    if (c === '{' || c === '}') { out.push(c); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    let s = '';
    while (i < text.length && !/[\s{}"]/.test(text[i])) { s += text[i]; i++; }
    out.push(s);
  }
  return out;
}

export function parseKeyValues(text: string): KvNode {
  const tokens = tokenize(text);
  let i = 0;

  const block = (): KvNode => {
    const node: KvNode = {};
    while (i < tokens.length && tokens[i] !== '}') {
      const key = tokens[i++];
      if (i >= tokens.length) break;
      if (tokens[i] === '{') { i++; node[key] = block(); i++; }
      else node[key] = tokens[i++];
    }
    return node;
  };

  const root: KvNode = {};
  while (i < tokens.length) {
    const key = tokens[i++];
    if (i >= tokens.length) break;
    if (tokens[i] === '{') { i++; root[key] = block(); i++; }
    else root[key] = tokens[i++];
  }
  return root;
}

export interface MissionChapter { map: string; display: string | null }
export interface Mission { name: string; displayTitle: string; chapters: MissionChapter[] }

const isNode = (v: string | KvNode | undefined): v is KvNode =>
  typeof v === 'object' && v !== null;

/** Read a mission file's versus chapter list, in play order. */
export function parseMission(text: string): Mission | null {
  const root = parseKeyValues(text);
  const mission = Object.entries(root).find(([k]) => k.toLowerCase() === 'mission')?.[1];
  if (!isNode(mission)) return null;

  const modes = mission['modes'];
  if (!isNode(modes)) return null;
  const versus = Object.entries(modes).find(([k]) => k.toLowerCase() === 'versus')?.[1];
  if (!isNode(versus)) return null;

  // Chapter keys are "1", "2", ... "10". String order puts 10 before 2, which
  // would play the campaign out of sequence, so sort numerically.
  const chapters = Object.entries(versus)
    .filter((e): e is [string, KvNode] => isNode(e[1]) && /^\d+$/.test(e[0]))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, ch]) => {
      const map = typeof ch['Map'] === 'string' ? ch['Map'] : null;
      const display = typeof ch['DisplayName'] === 'string' ? ch['DisplayName'] : null;
      return map ? { map, display } : null;
    })
    .filter((c): c is MissionChapter => c !== null);

  if (chapters.length === 0) return null;

  const name = typeof mission['Name'] === 'string' ? mission['Name'] : '';
  const displayTitle = typeof mission['DisplayTitle'] === 'string'
    ? mission['DisplayTitle'] : name;
  return { name, displayTitle, chapters };
}

/** Locate `missions/<something>.txt` in a VPK and return its text. */
export function readMissionFromVpk(vpkPath: string): { file: string; text: string } | null {
  const buf = readFileSync(vpkPath);
  if (buf.length < 12 || buf.readUInt32LE(0) !== VPK_MAGIC) return null;

  const version = buf.readUInt32LE(4);
  const treeLength = buf.readUInt32LE(8);
  // v2 adds four uint32 fields after the common header.
  const treeStart = version === 2 ? 28 : 12;
  if (treeStart + treeLength > buf.length) return null;
  const dataStart = treeStart + treeLength;

  let p = treeStart;
  const readCString = (): string => {
    let s = '';
    while (p < buf.length && buf[p] !== 0) { s += String.fromCharCode(buf[p]); p++; }
    p++;
    return s;
  };

  for (;;) {
    const ext = readCString();
    if (ext === '') break;
    for (;;) {
      const dir = readCString();
      if (dir === '') break;
      for (;;) {
        const name = readCString();
        if (name === '') break;
        const preloadBytes = buf.readUInt16LE(p + 4);
        const archiveIndex = buf.readUInt16LE(p + 6);
        const offset = buf.readUInt32LE(p + 8);
        const length = buf.readUInt32LE(p + 12);
        p += 18;
        const preload = buf.subarray(p, p + preloadBytes);
        p += preloadBytes;

        if (ext === 'txt' && dir.toLowerCase() === 'missions') {
          // 0x7fff means the bytes are in this file, after the tree. Anything
          // else is a numbered archive this reader deliberately does not open.
          if (archiveIndex !== 0x7fff && preloadBytes === 0) return null;
          const body = archiveIndex === 0x7fff
            ? Buffer.concat([preload, buf.subarray(dataStart + offset, dataStart + offset + length)])
            : preload;
          return { file: `${dir}/${name}.${ext}`, text: body.toString('utf8') };
        }
      }
    }
  }
  return null;
}

export function missionFromVpk(vpkPath: string): Mission | null {
  let found: { file: string; text: string } | null;
  try {
    found = readMissionFromVpk(vpkPath);
  } catch {
    // A truncated or malformed VPK reads past its own buffer. That is a
    // rejected upload, not a crashed request.
    return null;
  }
  return found ? parseMission(found.text) : null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/vpk.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Verify against a real campaign VPK**

The spec requires this parser be exercised against real files, not only the synthetic fixture. Download any L4D1 custom campaign VPK and check it parses:

```bash
npx tsx -e "import{missionFromVpk}from'./src/vpk.js';console.log(JSON.stringify(missionFromVpk(process.argv[1]),null,2))" /path/to/campaign.vpk
```

Expected: a display title and an ordered chapter list matching what the campaign actually plays. If it returns null, fix the reader before continuing; do not proceed on the fixture alone. Record which campaign you tested in the commit message.

- [ ] **Step 7: Commit**

```bash
git add src/vpk.ts tests/vpk.test.ts tests/fixtures/makeVpk.ts
git commit -m "Read a campaign's mission file out of its VPK"
```

---

### Task 3: Campaign registry

**Files:**
- Create: `src/campaignRegistry.ts`
- Modify: `src/orchestrator.ts:302-309` (`firstMapOf`)
- Test: `tests/campaignRegistry.test.ts`

**Interfaces:**
- Consumes: `listCampaigns`, `chaptersOf` from `src/customCampaigns.js`; `CAMPAIGNS`, `campaignForMap` from `src/campaigns.js`
- Produces:
  - `interface CampaignEntry { slug: string; name: string; firstMap: string; maps: string[]; custom: boolean }`
  - `campaignRegistry(db: DB): Map<string, CampaignEntry>`
  - `resolveCampaignForMap(db: DB, map: string): string | null`
  - `invalidateCampaignCache(): void`
  - `firstMapOf(db: DB, campaign: string): string` (moved from orchestrator, now db-aware)

- [ ] **Step 1: Write the failing test**

Create `tests/campaignRegistry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { insertDraft, publishCampaign, deleteCampaign } from '../src/customCampaigns.js';
import {
  campaignRegistry, resolveCampaignForMap, invalidateCampaignCache, firstMapOf,
} from '../src/campaignRegistry.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  invalidateCampaignCache();
});

const publish = (slug = 'dbd') => {
  insertDraft(db, {
    slug, name: 'Dead Before Dawn', vpkFilename: `${slug}.vpk`,
    sizeBytes: 1, sha256: 'a'.repeat(64), uploadedBy: null,
  }, [
    { map: 'dbd1_alley', display: 'Alley', isFinale: false },
    { map: 'dbd2_mall', display: 'Mall', isFinale: true },
  ]);
  publishCampaign(db, slug, 'Dead Before Dawn');
  invalidateCampaignCache();
};

describe('campaignRegistry', () => {
  it('contains the four stock campaigns with no custom ones present', () => {
    expect([...campaignRegistry(db).keys()])
      .toEqual(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']);
  });

  it('merges a published custom campaign in', () => {
    publish();
    expect(campaignRegistry(db).get('dbd')!.name).toBe('Dead Before Dawn');
  });

  // A draft is a half-finished upload. It must not be votable.
  it('leaves drafts out', () => {
    insertDraft(db, {
      slug: 'wip', name: 'WIP', vpkFilename: 'wip.vpk',
      sizeBytes: 1, sha256: 'b'.repeat(64), uploadedBy: null,
    }, [{ map: 'wip1', display: null, isFinale: true }]);
    invalidateCampaignCache();
    expect(campaignRegistry(db).has('wip')).toBe(false);
  });

  it('reports a custom campaign first map from its chapters', () => {
    publish();
    expect(firstMapOf(db, 'dbd')).toBe('dbd1_alley');
  });

  it('still reports the stock first maps as versus BSPs', () => {
    for (const slug of ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']) {
      expect(firstMapOf(db, slug)).toMatch(/^l4d_vs_/);
    }
  });
});

describe('resolveCampaignForMap', () => {
  it('resolves stock maps by prefix, with no DB lookup needed', () => {
    expect(resolveCampaignForMap(db, 'l4d_vs_farm01_hilltop')).toBe('blood_harvest');
  });

  it('resolves a custom map through its chapters', () => {
    publish();
    expect(resolveCampaignForMap(db, 'dbd2_mall')).toBe('dbd');
  });

  // Guessing is what campaignForMap was written to avoid: an unknown map must
  // stay unattributed rather than land under someone else's campaign.
  it('returns null for a map nothing claims', () => {
    expect(resolveCampaignForMap(db, 'some_random_map')).toBeNull();
  });

  // The parser is called per round by the log listener, so the lookup is
  // cached. A campaign removed after the cache warmed must stop resolving.
  it('stops resolving a deleted campaign once the cache is invalidated', () => {
    publish();
    expect(resolveCampaignForMap(db, 'dbd1_alley')).toBe('dbd');
    deleteCampaign(db, 'dbd');
    invalidateCampaignCache();
    expect(resolveCampaignForMap(db, 'dbd1_alley')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/campaignRegistry.test.ts`
Expected: FAIL, cannot resolve `../src/campaignRegistry.js`.

- [ ] **Step 3: Write the registry**

Create `src/campaignRegistry.ts`:

```ts
import type { DB } from './db.js';
import { CAMPAIGNS, campaignForMap } from './campaigns.js';
import { chaptersOf, listCampaigns } from './customCampaigns.js';

/**
 * Every campaign the site can run: the stock four, plus published custom ones.
 *
 * `src/campaigns.ts` stays a pure const with no database dependency, because
 * the Discord command module reads it at import time and a test asserts its
 * exact keys. Everything that needs to know about custom campaigns comes here
 * instead.
 *
 * Cached, because resolveCampaignForMap is called once per round by the log
 * listener and the answer only changes when an admin publishes, edits or
 * deletes a campaign. Every one of those paths calls invalidateCampaignCache.
 */

export interface CampaignEntry {
  slug: string;
  name: string;
  /** The map a match changelevels into. */
  firstMap: string;
  /** Every map in the campaign, in play order. */
  maps: string[];
  custom: boolean;
}

/** These MUST be the l4d_vs_ BSPs. The plain l4d_ names are the coop maps,
 *  which load a coop mission and cannot be played versus. */
const STOCK_FIRST: Record<string, string> = {
  no_mercy: 'l4d_vs_hospital01_apartment',
  death_toll: 'l4d_vs_smalltown01_caves',
  dead_air: 'l4d_vs_airport01_greenhouse',
  blood_harvest: 'l4d_vs_farm01_hilltop',
};

let cache: { registry: Map<string, CampaignEntry>; byMap: Map<string, string> } | null = null;

export function invalidateCampaignCache(): void {
  cache = null;
}

function build(db: DB): NonNullable<typeof cache> {
  const registry = new Map<string, CampaignEntry>();
  for (const [slug, c] of Object.entries(CAMPAIGNS)) {
    registry.set(slug, {
      slug, name: c.name, firstMap: STOCK_FIRST[slug], maps: [], custom: false,
    });
  }

  const byMap = new Map<string, string>();
  for (const row of listCampaigns(db, { state: 'published' })) {
    const chapters = chaptersOf(db, row.slug);
    // Only included chapters are playable. Plan 2 lets an admin change which
    // those are; until then every chapter is included, so this is the whole
    // list and the ordering is the file's own.
    const played = chapters
      .filter((c) => c.included === 1)
      .sort((a, b) => (a.play_order ?? a.ordinal) - (b.play_order ?? b.ordinal));
    if (played.length === 0) continue;

    registry.set(row.slug, {
      slug: row.slug, name: row.name, firstMap: played[0].map,
      maps: played.map((c) => c.map), custom: true,
    });
    // Every chapter claims its map, included or not: a match standing on an
    // excluded chapter is still that campaign for attribution purposes.
    for (const c of chapters) byMap.set(c.map.toLowerCase(), row.slug);
  }

  return { registry, byMap };
}

function warm(db: DB): NonNullable<typeof cache> {
  if (!cache) cache = build(db);
  return cache;
}

export function campaignRegistry(db: DB): Map<string, CampaignEntry> {
  return warm(db).registry;
}

/** The campaign a map belongs to: stock by name prefix, custom by lookup.
 *  Null rather than a default for anything unrecognised. */
export function resolveCampaignForMap(db: DB, map: string): string | null {
  const stock = campaignForMap(map);
  if (stock) return stock;
  return warm(db).byMap.get(map.toLowerCase()) ?? null;
}

/** First playable map of a campaign, which is what a match changelevels into. */
export function firstMapOf(db: DB, campaign: string): string {
  const entry = campaignRegistry(db).get(campaign);
  return entry?.firstMap ?? STOCK_FIRST.no_mercy;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/campaignRegistry.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Point the orchestrator at the registry**

In `src/orchestrator.ts`, delete the local `firstMapOf` (lines 296-309 including its doc comment) and import the registry version. At the call site (line 139) it becomes:

```ts
      await rcon.exec(`changelevel ${firstMapOf(this.deps.db, match.campaign)}`);
```

Add the import:

```ts
import { firstMapOf } from './campaignRegistry.js';
```

Check whether `this.deps.db` is the right accessor for the orchestrator's database handle; if the orchestrator does not already hold one, thread it in from `buildServer` in `src/server.ts:680` the same way `db` is passed to the other route registrations.

`tests/orchestrator.test.ts:346` imports `firstMapOf` from the orchestrator. Update that import to `../src/campaignRegistry.js` and pass a `db` built with `openDb(':memory:')`.

- [ ] **Step 6: Switch the three stats call sites to the registry**

This is what delivers the spec's stats parity, and it is easy to miss: `campaignForMap` has
three live callers that would otherwise keep returning `null` for every custom map, leaving
custom campaigns unattributed everywhere they matter.

`src/playerStats.ts:390` (inside `mapDetail(db, map)`) and `src/playerStats.ts:444` (inside
`mapIndex(db)`) both already have a `db` in scope. Change the import and both calls:

```ts
import { resolveCampaignForMap } from './campaignRegistry.js';
// ...
    campaign: resolveCampaignForMap(db, map),
```

`src/selfStarted.ts:136` is in a class whose `SelfStartedDeps` already carries `db`:

```ts
    const campaign = resolveCampaignForMap(this.deps.db, p.map);
```

The comment below that line stays true and stays put: refusing to adopt a match on an unknown
map is still correct, there are simply fewer unknown maps now.

`src/replaySessions.ts:110` is inside `listSessions(dir, nowMs)`, which has **no** database. Do
not thread one through every caller: nine tests call it with two arguments and none of them care
about campaigns. Make it optional instead:

```ts
export function listSessions(dir: string, nowMs: number, db?: DB): ReplaySession[] {
```

```ts
      // Without a db this falls back to stock-only resolution, which is what
      // every caller that does not have one actually wants.
      campaign: db ? resolveCampaignForMap(db, files[0].map) : campaignForMap(files[0].map),
```

Pass `db` from the replay routes in `src/routes/replays.ts`, which already holds one, and from
the internal call at `src/replaySessions.ts:148` by forwarding the new parameter.

`mapName()` in `web/src/format.ts:473` needs **no** change: its comment at line 481 already
documents that a custom name like `deadbeforedawn` is deliberately not mistaken for a campaign
prefix. Verify that by reading it; do not edit it.

- [ ] **Step 7: Write the attribution test**

Append to `tests/campaignRegistry.test.ts`:

```ts
describe('stats attribute custom maps', () => {
  it('gives mapIndex a campaign for a custom map', async () => {
    publish();
    const { mapIndex } = await import('../src/playerStats.js');
    // Record one completed match on a custom map, following the fixture
    // pattern in tests/playerStats.test.ts, then assert the row is attributed.
    const row = mapIndex(db).find((r) => r.map === 'dbd1_alley');
    expect(row?.campaign).toBe('dbd');
  });
});
```

Fill the middle of that test using the existing match fixture helper in
`tests/playerStats.test.ts`; do not invent a new way to insert a match.

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 9: Commit**

```bash
git add src/campaignRegistry.ts src/orchestrator.ts src/playerStats.ts src/selfStarted.ts src/replaySessions.ts src/routes/replays.ts tests/campaignRegistry.test.ts tests/orchestrator.test.ts
git commit -m "One campaign registry replaces two hardcoded tables"
```

---

### Task 4: Pool validation accepts custom campaigns

**Files:**
- Modify: `src/settingsSchema.ts:71-99` (`validateSetting`)
- Modify: `src/routes/admin.ts:242` and the settings PUT handler
- Test: `tests/adminSettings.test.ts` (extend)

**Interfaces:**
- Consumes: `campaignRegistry` from `src/campaignRegistry.js`
- Produces: `validateSetting(key: string, raw: unknown, opts?: { campaignSlugs?: Set<string> }): Validated`

- [ ] **Step 1: Write the failing test**

Append to `tests/adminSettings.test.ts`:

```ts
describe('map_pool with custom campaigns', () => {
  it('rejects a slug no campaign claims', () => {
    const v = validateSetting('map_pool', ['no_mercy', 'not_a_campaign']);
    expect(v).toEqual({ ok: false, error: 'unknown campaign: not_a_campaign' });
  });

  // The pool is validated against the registry, not the stock const, or a
  // custom campaign could never be put in it.
  it('accepts a custom slug when it is passed as known', () => {
    const v = validateSetting('map_pool', ['no_mercy', 'dbd'], {
      campaignSlugs: new Set(['no_mercy', 'dbd']),
    });
    expect(v).toEqual({ ok: true, value: JSON.stringify(['no_mercy', 'dbd']) });
  });

  // Default behaviour is unchanged for every caller that does not care.
  it('falls back to the stock campaigns when given no set', () => {
    expect(validateSetting('map_pool', ['dbd']).ok).toBe(false);
  });
});
```

Add `validateSetting` to that file's imports if it is not already imported.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adminSettings.test.ts`
Expected: FAIL, the custom slug is rejected because the third argument is ignored.

- [ ] **Step 3: Thread the known slugs through**

In `src/settingsSchema.ts`, change the signature and the `campaigns` case:

```ts
/** Turn a submitted value into the stored string, or say why not.
 *
 *  `campaignSlugs` is how a custom campaign becomes selectable: the pool is
 *  validated against whatever the registry currently holds, not against the
 *  stock four. Callers without a registry to hand get the stock four, which is
 *  the correct answer for every caller that predates custom campaigns. */
export function validateSetting(
  key: string, raw: unknown, opts: { campaignSlugs?: Set<string> } = {},
): Validated {
```

and inside the `case 'campaigns'` block:

```ts
    case 'campaigns': {
      if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'pick at least one campaign' };
      const known = opts.campaignSlugs ?? new Set(Object.keys(CAMPAIGNS));
      const unknown = raw.filter((c) => typeof c !== 'string' || !known.has(c));
      if (unknown.length) return { ok: false, error: `unknown campaign: ${unknown.join(', ')}` };
      return { ok: true, value: JSON.stringify([...new Set(raw as string[])]) };
    }
```

- [ ] **Step 4: Pass the registry from the admin routes**

In `src/routes/admin.ts`, replace the hardcoded campaign list at line 242 and pass the slugs when validating. Add the import:

```ts
import { campaignRegistry } from '../campaignRegistry.js';
```

The settings GET becomes:

```ts
      campaigns: [...campaignRegistry(db).values()]
        .map((c) => ({ slug: c.slug, name: c.name, custom: c.custom })),
```

and the settings PUT validation call becomes:

```ts
    const v = validateSetting(key, (req.body as { value?: unknown } | undefined)?.value, {
      campaignSlugs: new Set(campaignRegistry(db).keys()),
    });
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add src/settingsSchema.ts src/routes/admin.ts tests/adminSettings.test.ts
git commit -m "The campaign pool is validated against the registry"
```

---

### Task 5: Addons transports

**Files:**
- Create: `src/addonsTransport.ts`
- Create: `tests/fakes/fakeAddonsTransport.ts`
- Test: `tests/addonsTransport.test.ts`
- Modify: `package.json` (add `basic-ftp`)

**Interfaces:**
- Consumes: `ServerRow` from `src/serverPool.js`
- Produces:
  - `interface AddonsTransport { put(localPath: string, remoteName: string): Promise<void>; size(remoteName: string): Promise<number | null>; remove(remoteName: string): Promise<void> }`
  - `localTransport(dir: string): AddonsTransport`
  - `ftpTransport(cfg: { host: string; port: number; user: string; password: string; dir: string }): AddonsTransport`
  - `transportFor(server: ServerRow): AddonsTransport | null`

- [ ] **Step 1: Add the dependency**

```bash
npm install basic-ftp
```

- [ ] **Step 2: Write the failing test**

Create `tests/addonsTransport.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTransport, transportFor } from '../src/addonsTransport.js';
import type { ServerRow } from '../src/serverPool.js';

let dir: string;
let src: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addons-'));
  src = join(dir, 'source.vpk');
  writeFileSync(src, 'vpk bytes');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const server = (over: Partial<ServerRow> = {}): ServerRow => ({
  id: 1, name: 'Dallas', host: '127.0.0.1', port: 27015, rcon_port: 27015,
  rcon_password: 'x', status: 'idle', tv_port: null, tv_password: null,
  tv_enabled: 0, enabled: 1, ...over,
} as ServerRow);

describe('localTransport', () => {
  it('puts a file and reports its size', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'dest-'));
    const t = localTransport(dest);
    await t.put(src, 'dbd.vpk');
    expect(readFileSync(join(dest, 'dbd.vpk'), 'utf8')).toBe('vpk bytes');
    expect(await t.size('dbd.vpk')).toBe('vpk bytes'.length);
    rmSync(dest, { recursive: true, force: true });
  });

  it('reports null for a file that is not there', async () => {
    expect(await localTransport(dir).size('absent.vpk')).toBeNull();
  });

  it('removes a file', async () => {
    const t = localTransport(dir);
    await t.put(src, 'gone.vpk');
    await t.remove('gone.vpk');
    expect(existsSync(join(dir, 'gone.vpk'))).toBe(false);
  });

  // The remote name is ours, from the DB, never from a request. Rejecting
  // separators anyway is cheap and means one mistake upstream cannot write
  // outside the addons directory.
  it('refuses a remote name containing a path separator', async () => {
    await expect(localTransport(dir).put(src, '../escape.vpk')).rejects.toThrow(/name/i);
  });
});

describe('transportFor', () => {
  it('is null when a local server has no addons dir configured', () => {
    expect(transportFor(server({ addons_transport: 'local', addons_dir: null } as never))).toBeNull();
  });

  it('is null when an ftp server is missing credentials', () => {
    expect(transportFor(server({
      addons_transport: 'ftp', addons_dir: '/addons', ftp_host: null,
    } as never))).toBeNull();
  });

  it('builds a local transport when the dir is set', () => {
    expect(transportFor(server({ addons_transport: 'local', addons_dir: dir } as never))).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/addonsTransport.test.ts`
Expected: FAIL, cannot resolve `../src/addonsTransport.js`.

- [ ] **Step 4: Write the transports**

Create `src/addonsTransport.ts`:

```ts
import { copyFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Client as FtpClient } from 'basic-ftp';
import type { ServerRow } from './serverPool.js';

/**
 * Putting a campaign VPK into a game server's addons directory.
 *
 * Two implementations because the two boxes differ in reach and nothing else:
 * Dallas runs the web app itself, so a file copy is the whole job; Chicago is
 * an NFO box we can only speak FTP to, which is the same protocol
 * ops/pull-chicago-files.py already uses in the other direction.
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
 *  anyway: this is the last point before a path is joined to a directory that
 *  also holds metamod, stripper and l4dtoolz. */
function assertPlainName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`unsafe addon name: ${name}`);
  }
}

export function localTransport(dir: string): AddonsTransport {
  return {
    async put(localPath, remoteName) {
      assertPlainName(remoteName);
      // Copy beside the target and rename, so a reader never sees a partial
      // file under the real name. Same filesystem, so the rename is atomic.
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
```

- [ ] **Step 5: Write the fake for later tasks**

Create `tests/fakes/fakeAddonsTransport.ts`:

```ts
import type { AddonsTransport } from '../../src/addonsTransport.js';

/** An in-memory addons directory, plus a way to make any call fail.
 *  Install is a retrying background job, so its tests need a transport that
 *  fails on demand and then stops failing. */
export function fakeAddonsTransport(opts: { failPut?: boolean } = {}) {
  const files = new Map<string, number>();
  const state = { failPut: opts.failPut ?? false, puts: 0 };
  const transport: AddonsTransport = {
    async put(_localPath, remoteName) {
      state.puts++;
      if (state.failPut) throw new Error('connection refused');
      files.set(remoteName, 9);
    },
    async size(remoteName) { return files.get(remoteName) ?? null; },
    async remove(remoteName) { files.delete(remoteName); },
  };
  return { transport, files, state };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/addonsTransport.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add src/addonsTransport.ts tests/addonsTransport.test.ts tests/fakes/fakeAddonsTransport.ts package.json package-lock.json
git commit -m "Two ways to put a VPK in an addons directory"
```

---

### Task 6: Install job

**Files:**
- Create: `src/campaignInstall.ts`
- Test: `tests/campaignInstall.test.ts`

**Interfaces:**
- Consumes: `setInstall`, `installsOf`, `getCampaign` from `src/customCampaigns.js`; `AddonsTransport` from `src/addonsTransport.js`
- Produces:
  - `installCampaign(db: DB, slug: string, opts: { sourcePath: string; servers: { id: number; transport: AddonsTransport | null }[] }): Promise<void>`
  - `uninstallCampaign(db: DB, slug: string, opts: { servers: { id: number; transport: AddonsTransport | null }[] }): Promise<void>`
  - `isInstalledEverywhere(db: DB, slug: string, serverIds: number[]): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/campaignInstall.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { insertDraft, installsOf } from '../src/customCampaigns.js';
import { fakeAddonsTransport } from './fakes/fakeAddonsTransport.js';
import { installCampaign, uninstallCampaign, isInstalledEverywhere } from '../src/campaignInstall.js';

let db: DB;
let dir: string;
let src: string;

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'inst-'));
  src = join(dir, 'dbd.vpk');
  writeFileSync(src, 'vpk bytes');
  db.prepare(
    "INSERT INTO servers (id, name, host, port, rcon_port, rcon_password, status) VALUES (1,'A','h',1,1,'p','idle'),(2,'B','h',2,2,'p','idle')",
  ).run();
  insertDraft(db, {
    slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
    sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
  }, [{ map: 'dbd1', display: null, isFinale: true }]);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('installCampaign', () => {
  it('installs to every server and records it', async () => {
    const a = fakeAddonsTransport();
    const b = fakeAddonsTransport();
    await installCampaign(db, 'dbd', {
      sourcePath: src,
      servers: [{ id: 1, transport: a.transport }, { id: 2, transport: b.transport }],
    });
    expect(installsOf(db, 'dbd').map((r) => r.state)).toEqual(['installed', 'installed']);
    expect(a.files.has('dbd.vpk')).toBe(true);
    expect(b.files.has('dbd.vpk')).toBe(true);
  });

  // One unreachable box must not stop the other from being installed, or a
  // single flaky server keeps every campaign out of the pool.
  it('records a failure per server without abandoning the rest', async () => {
    const good = fakeAddonsTransport();
    const bad = fakeAddonsTransport({ failPut: true });
    await installCampaign(db, 'dbd', {
      sourcePath: src,
      servers: [{ id: 1, transport: bad.transport }, { id: 2, transport: good.transport }],
    });
    const rows = installsOf(db, 'dbd');
    expect(rows.find((r) => r.server_id === 1)!.state).toBe('failed');
    expect(rows.find((r) => r.server_id === 1)!.error).toMatch(/connection refused/);
    expect(rows.find((r) => r.server_id === 2)!.state).toBe('installed');
  });

  // A server with no transport configured is a configuration gap, not an
  // outage. It is recorded as failed so the panel says so out loud.
  it('records an unconfigured server as failed', async () => {
    await installCampaign(db, 'dbd', {
      sourcePath: src, servers: [{ id: 1, transport: null }],
    });
    expect(installsOf(db, 'dbd')[0].error).toMatch(/not configured/i);
  });

  // The size check is the whole verification: a truncated upload that the
  // transport did not throw on must not be recorded as installed.
  it('fails when the landed size does not match', async () => {
    const t = fakeAddonsTransport();
    db.prepare('UPDATE custom_campaigns SET size_bytes = 999 WHERE slug = ?').run('dbd');
    await installCampaign(db, 'dbd', {
      sourcePath: src, servers: [{ id: 1, transport: t.transport }],
    });
    expect(installsOf(db, 'dbd')[0].state).toBe('failed');
    expect(installsOf(db, 'dbd')[0].error).toMatch(/size/i);
  });

  it('retries a previously failed server and succeeds', async () => {
    const t = fakeAddonsTransport({ failPut: true });
    await installCampaign(db, 'dbd', { sourcePath: src, servers: [{ id: 1, transport: t.transport }] });
    expect(installsOf(db, 'dbd')[0].state).toBe('failed');
    t.state.failPut = false;
    await installCampaign(db, 'dbd', { sourcePath: src, servers: [{ id: 1, transport: t.transport }] });
    expect(installsOf(db, 'dbd')[0].state).toBe('installed');
  });
});

describe('isInstalledEverywhere', () => {
  it('is false while any server is not installed', async () => {
    const good = fakeAddonsTransport();
    const bad = fakeAddonsTransport({ failPut: true });
    await installCampaign(db, 'dbd', {
      sourcePath: src,
      servers: [{ id: 1, transport: good.transport }, { id: 2, transport: bad.transport }],
    });
    expect(isInstalledEverywhere(db, 'dbd', [1, 2])).toBe(false);
    expect(isInstalledEverywhere(db, 'dbd', [1])).toBe(true);
  });
});

describe('uninstallCampaign', () => {
  it('removes the file and the install rows', async () => {
    const t = fakeAddonsTransport();
    await installCampaign(db, 'dbd', { sourcePath: src, servers: [{ id: 1, transport: t.transport }] });
    await uninstallCampaign(db, 'dbd', { servers: [{ id: 1, transport: t.transport }] });
    expect(t.files.has('dbd.vpk')).toBe(false);
    expect(installsOf(db, 'dbd')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/campaignInstall.test.ts`
Expected: FAIL, cannot resolve `../src/campaignInstall.js`.

- [ ] **Step 3: Write the installer**

Create `src/campaignInstall.ts`:

```ts
import type { DB } from './db.js';
import type { AddonsTransport } from './addonsTransport.js';
import { getCampaign, installsOf, setInstall } from './customCampaigns.js';

/**
 * Putting a campaign onto every server, and recording what actually happened.
 *
 * Per server, never all-or-nothing: one unreachable box must not keep a
 * campaign off the others, and the panel shows which server is behind. Every
 * call is a retry of whatever is not yet installed, so this is safe to run
 * again at any time.
 *
 * Nothing here is allowed to throw. An install failure is a row, never an
 * exception that reaches a request handler or a match.
 */

export interface InstallTarget { id: number; transport: AddonsTransport | null }

export async function installCampaign(
  db: DB, slug: string, opts: { sourcePath: string; servers: InstallTarget[] },
): Promise<void> {
  const campaign = getCampaign(db, slug);
  if (!campaign) return;

  for (const server of opts.servers) {
    setInstall(db, slug, server.id, 'pending');
    if (!server.transport) {
      setInstall(db, slug, server.id, 'failed', {
        error: 'server has no addons directory configured',
      });
      continue;
    }
    try {
      await server.transport.put(opts.sourcePath, campaign.vpk_filename);
      const landed = await server.transport.size(campaign.vpk_filename);
      if (landed !== campaign.size_bytes) {
        setInstall(db, slug, server.id, 'failed', {
          error: `size mismatch: ${landed ?? 'absent'} on the server, ${campaign.size_bytes} expected`,
        });
        continue;
      }
      setInstall(db, slug, server.id, 'installed', { sha256: campaign.sha256, error: null });
    } catch (err) {
      setInstall(db, slug, server.id, 'failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function uninstallCampaign(
  db: DB, slug: string, opts: { servers: InstallTarget[] },
): Promise<void> {
  const campaign = getCampaign(db, slug);
  if (!campaign) return;
  for (const server of opts.servers) {
    if (!server.transport) continue;
    try {
      await server.transport.remove(campaign.vpk_filename);
    } catch {
      // A file we cannot delete is not a reason to keep the row: the admin
      // asked for this campaign to go away, and a stale VPK on a box is inert.
    }
  }
  db.prepare('DELETE FROM custom_campaign_installs WHERE slug = ?').run(slug);
}

/** Whether every server named has this campaign. The pool gate, and the
 *  orchestrator's re-check at match start. */
export function isInstalledEverywhere(db: DB, slug: string, serverIds: number[]): boolean {
  const installed = new Set(
    installsOf(db, slug).filter((r) => r.state === 'installed').map((r) => r.server_id),
  );
  return serverIds.every((id) => installed.has(id));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/campaignInstall.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/campaignInstall.ts tests/campaignInstall.test.ts
git commit -m "Install a campaign to every server, one row per server"
```

---

### Task 7: Upload, publish and admin routes

**Files:**
- Create: `src/routes/campaigns.ts`
- Modify: `src/config.ts` (add `addonsDir`)
- Modify: `src/server.ts:679-682` (register the routes)
- Modify: `package.json` (add `@fastify/multipart`)
- Test: `tests/campaignRoutes.test.ts`

**Interfaces:**
- Consumes: everything from tasks 1, 2, 3, 5, 6
- Produces these HTTP routes:
  - `POST /api/admin/campaigns` multipart, field `file`. Returns `{ slug, name, chapters, sizeBytes, sha256 }`
  - `GET /api/admin/campaigns` returns `{ campaigns: [{ ...CustomCampaignRow, chapters, installs }] }`
  - `POST /api/admin/campaigns/:slug/publish` body `{ name }`
  - `POST /api/admin/campaigns/:slug/enabled` body `{ enabled }`
  - `POST /api/admin/campaigns/:slug/reinstall`
  - `DELETE /api/admin/campaigns/:slug`
  - `GET /api/campaigns/custom` public
  - `GET /download/campaign/:slug` public

- [ ] **Step 1: Add the dependency and config**

```bash
npm install @fastify/multipart
```

In `src/config.ts`, alongside `demoDir`:

```ts
  /** The game server's addons directory. Empty turns campaign upload off
   *  entirely, the same default and for the same reason as demoDir: a path
   *  guessed from another path is how you write a 300 MB file somewhere
   *  nothing reads it. */
  addonsDir: string;
```

and in the loader: `addonsDir: env.ADDONS_DIR ?? '',`

- [ ] **Step 2: Write the failing test**

Create `tests/campaignRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, type DB } from '../src/db.js';
import { insertDraft, publishCampaign, setEnabled, getCampaign } from '../src/customCampaigns.js';
import { setInstall } from '../src/customCampaigns.js';
import { authedCookie } from './helpers.js';
import { makeVpk } from './fixtures/makeVpk.js';

// buildTestApp is the local helper other route tests use; follow whichever
// pattern tests/adminMatches.test.ts already uses to stand up a server with a
// DB and an admin session, and pass config.addonsDir pointing at a temp dir.

let db: DB;
let addons: string;

beforeEach(() => {
  db = openDb(':memory:');
  addons = mkdtempSync(join(tmpdir(), 'addons-'));
});
afterEach(() => { rmSync(addons, { recursive: true, force: true }); });

describe('GET /api/campaigns/custom', () => {
  it('lists only published, enabled campaigns', async () => {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1', display: 'One', isFinale: true }]);
    insertDraft(db, {
      slug: 'wip', name: 'WIP', vpkFilename: 'wip.vpk',
      sizeBytes: 9, sha256: 'b'.repeat(64), uploadedBy: null,
    }, [{ map: 'wip1', display: null, isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');
    setEnabled(db, 'dbd', true);

    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/custom' });
    expect(res.statusCode).toBe(200);
    expect(res.json().campaigns.map((c: { slug: string }) => c.slug)).toEqual(['dbd']);
  });
});

describe('GET /download/campaign/:slug', () => {
  const publishOne = (body = 'vpk bytes') => {
    writeFileSync(join(addons, 'dbd.vpk'), body);
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      uploadedBy: null,
    }, [{ map: 'dbd1', display: null, isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');
    setEnabled(db, 'dbd', true);
  };

  it('streams the VPK', async () => {
    publishOne();
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/download/campaign/dbd' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('vpk bytes');
  });

  // A file edited by hand on the box must not be served as if it were the one
  // the site vouched for.
  it('404s when the file on disk has drifted from its recorded size', async () => {
    publishOne();
    writeFileSync(join(addons, 'dbd.vpk'), 'different bytes entirely');
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/download/campaign/dbd' });
    expect(res.statusCode).toBe(404);
  });

  it('404s for an unpublished campaign', async () => {
    writeFileSync(join(addons, 'wip.vpk'), 'x');
    insertDraft(db, {
      slug: 'wip', name: 'WIP', vpkFilename: 'wip.vpk',
      sizeBytes: 1, sha256: 'c'.repeat(64), uploadedBy: null,
    }, [{ map: 'wip1', display: null, isFinale: true }]);
    const app = await buildTestApp({ db, addonsDir: addons });
    expect((await app.inject({ method: 'GET', url: '/download/campaign/wip' })).statusCode).toBe(404);
  });

  // The slug indexes the database; it never becomes part of a path.
  it('404s on a traversal attempt rather than reading outside addons', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/download/campaign/..%2F..%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/admin/campaigns', () => {
  it('rejects a file that is not a campaign VPK', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const notVpk = join(addons, 'x.vpk');
    makeVpk(notVpk, { ext: 'vmt', dir: 'materials', name: 'hunter', body: 'x' });
    const form = new FormData();
    form.set('file', new Blob([readFileSync(notVpk)]), 'skin.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: authedCookie(app, db, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/mission/i);
  });

  it('refuses when free disk is below the floor', async () => {
    const app = await buildTestApp({ db, addonsDir: addons, freeBytes: 1 });
    const form = new FormData();
    form.set('file', new Blob(['x']), 'c.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: authedCookie(app, db, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(507);
  });

  it('refuses a non-admin', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const form = new FormData();
    form.set('file', new Blob(['x']), 'c.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: authedCookie(app, db, '76561198000000009'),
      payload: form,
    });
    expect(res.statusCode).toBe(403);
  });
});
```

`buildTestApp` is not a new helper: it is the existing `buildServer` call that
`tests/adminMatches.test.ts:37` already uses, with the addons directory injected through config
and free space injected so the disk-floor test does not depend on the machine running it.

```ts
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { stubOrchestrator } from './helpers.js';

const buildTestApp = (o: { db: DB; addonsDir: string; freeBytes?: number }) =>
  buildServer({
    config: loadConfig({ ADDONS_DIR: o.addonsDir }),
    db: o.db,
    orchestrator: stubOrchestrator(),
    serverCleaner: async () => {},
    // Injected for the same reason orchestrator and serverCleaner are: the
    // real one calls statfs, so the disk-floor test would pass or fail based
    // on how full the developer's laptop happens to be.
    freeBytes: o.freeBytes === undefined ? undefined : async () => o.freeBytes!,
  });
```

This requires `buildServer` in `src/server.ts` to accept an optional `freeBytes` dep and forward
it to `campaignRoutes`, alongside the existing `orchestrator` and `serverCleaner` injections.
Add it to the `BuildServerDeps` interface as `freeBytes?: () => Promise<number>`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/campaignRoutes.test.ts`
Expected: FAIL, the routes do not exist.

- [ ] **Step 4: Write the routes**

Create `src/routes/campaigns.ts`. Key decisions the implementer must not change:

- The upload streams to `<addonsDir>/.upload-<random>.part` and is hashed while streaming, so a 300 MB file is never held in memory.
- Free space is checked with `statfs` before the stream is consumed, and again is not trusted afterwards; the floor is 2 GB plus the declared file size.
- The slug is derived from the mission's `Name`, lowercased, non-alphanumerics collapsed to `_`. A slug already in `CAMPAIGNS` or already in `custom_campaigns` is rejected rather than silently overwriting.
- The download route looks up the row, requires `state = 'published'`, stats the file, and compares size against `size_bytes` before streaming. A mismatch is a 404 and an error logged, never a served file.
- Every mutation ends with `logAdmin` exactly as the other admin routes do, and every one calls `invalidateCampaignCache()`.
- Publish and reinstall kick `installCampaign` without awaiting it in the request, matching the spec's "never blocking the request".

```ts
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { CAMPAIGNS } from '../campaigns.js';
import { invalidateCampaignCache } from '../campaignRegistry.js';
import { transportFor } from '../addonsTransport.js';
import { installCampaign, uninstallCampaign } from '../campaignInstall.js';
import {
  chaptersOf, deleteCampaign, getCampaign, insertDraft, installsOf,
  listCampaigns, publishCampaign, setEnabled,
} from '../customCampaigns.js';
import { missionFromVpk } from '../vpk.js';

/** Headroom the box must keep after an upload lands, on top of the file
 *  itself. A game server that fills its partition stops serving; a refused
 *  upload is a message. */
const DISK_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;

export interface CampaignRouteOpts {
  db: DB;
  addonsDir: string;
  /** Injectable for tests. Defaults to a real statfs on the addons directory. */
  freeBytes?: () => Promise<number>;
}

export async function campaignRoutes(
  app: FastifyInstance, opts: CampaignRouteOpts,
): Promise<void> {
  const { db, addonsDir } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const freeBytes = opts.freeBytes
    ?? (async () => { const s = await statfs(addonsDir); return s.bsize * s.bavail; });

  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } });

  const targets = () =>
    (db.prepare('SELECT * FROM servers WHERE enabled = 1').all() as never[])
      .map((s: { id: number }) => ({ id: s.id, transport: transportFor(s as never) }));

  app.get('/api/campaigns/custom', async () => ({
    campaigns: listCampaigns(db, { state: 'published', enabledOnly: true }).map((c) => ({
      slug: c.slug, name: c.name, sizeBytes: c.size_bytes, sha256: c.sha256,
      filename: c.vpk_filename, notes: c.notes,
      chapters: chaptersOf(db, c.slug).map((ch) => ({
        map: ch.map, display: ch.display, included: ch.included === 1,
      })),
    })),
  }));

  app.get('/download/campaign/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c || c.state !== 'published') return reply.code(404).send({ error: 'no such campaign' });
    // The path comes from the row, never from the URL. The slug only indexes.
    const path = join(addonsDir, c.vpk_filename);
    let onDisk: Awaited<ReturnType<typeof stat>>;
    try {
      onDisk = await stat(path);
    } catch {
      return reply.code(404).send({ error: 'file missing' });
    }
    if (onDisk.size !== c.size_bytes) {
      req.log.error({ slug, expected: c.size_bytes, actual: onDisk.size },
        'campaign VPK on disk no longer matches its recorded size, refusing to serve');
      return reply.code(404).send({ error: 'file changed' });
    }
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${c.vpk_filename}"`)
      .header('content-length', String(c.size_bytes))
      .send(createReadStream(path));
  });

  app.get('/api/admin/campaigns', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return {
      free: await freeBytes(),
      campaigns: listCampaigns(db).map((c) => ({
        ...c, chapters: chaptersOf(db, c.slug), installs: installsOf(db, c.slug),
      })),
    };
  });

  app.post('/api/admin/campaigns', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    if (!addonsDir) return reply.code(503).send({ error: 'no addons directory configured' });

    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'no file' });

    const free = await freeBytes();
    if (free < DISK_FLOOR_BYTES) {
      return reply.code(507).send({ error: 'not enough free disk space on the server' });
    }

    const tmp = join(addonsDir, `.upload-${randomUUID()}.part`);
    const hash = createHash('sha256');
    let size = 0;
    part.file.on('data', (chunk: Buffer) => { hash.update(chunk); size += chunk.length; });
    try {
      await pipeline(part.file, createWriteStream(tmp));
      if (part.file.truncated) throw new Error('file too large');

      const mission = missionFromVpk(tmp);
      if (!mission) {
        return reply.code(400).send({ error: 'no versus mission found in that VPK' });
      }

      const slug = mission.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (!slug) return reply.code(400).send({ error: 'mission has no usable name' });
      if (CAMPAIGNS[slug] || getCampaign(db, slug)) {
        return reply.code(409).send({ error: `a campaign named ${slug} already exists` });
      }

      const filename = `${slug}.vpk`;
      await rename(tmp, join(addonsDir, filename));
      insertDraft(db, {
        slug, name: mission.displayTitle, vpkFilename: filename,
        sizeBytes: size, sha256: hash.digest('hex'), uploadedBy: adminId,
      }, mission.chapters.map((c) => ({ map: c.map, display: c.display, isFinale: false })));
      logAdmin(db, adminId, 'campaign.upload', slug, '', mission.displayTitle);
      invalidateCampaignCache();

      return { slug, name: mission.displayTitle, sizeBytes: size, chapters: chaptersOf(db, slug) };
    } finally {
      await rm(tmp, { force: true });
    }
  });

  app.post('/api/admin/campaigns/:slug/publish', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c) return reply.code(404).send({ error: 'no such campaign' });
    const name = String((req.body as { name?: string } | undefined)?.name ?? c.name).trim().slice(0, 80);
    if (!name) return reply.code(400).send({ error: 'name cannot be empty' });
    publishCampaign(db, slug, name);
    invalidateCampaignCache();
    logAdmin(db, adminId, 'campaign.publish', slug, c.name, name);
    // Not awaited: a 300 MB FTP upload must not hold the request open, and
    // every result is recorded per server for the panel to show.
    void installCampaign(db, slug, {
      sourcePath: join(addonsDir, c.vpk_filename), servers: targets(),
    });
    return { ok: true };
  });

  app.post('/api/admin/campaigns/:slug/enabled', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c) return reply.code(404).send({ error: 'no such campaign' });
    const enabled = (req.body as { enabled?: boolean } | undefined)?.enabled === true;
    setEnabled(db, slug, enabled);
    invalidateCampaignCache();
    logAdmin(db, adminId, 'campaign.enabled', slug, String(c.enabled), enabled ? '1' : '0');
    return { ok: true };
  });

  app.post('/api/admin/campaigns/:slug/reinstall', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c) return reply.code(404).send({ error: 'no such campaign' });
    logAdmin(db, adminId, 'campaign.reinstall', slug, '', '');
    void installCampaign(db, slug, {
      sourcePath: join(addonsDir, c.vpk_filename), servers: targets(),
    });
    return { ok: true };
  });

  app.delete('/api/admin/campaigns/:slug', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c) return reply.code(404).send({ error: 'no such campaign' });
    await uninstallCampaign(db, slug, { servers: targets() });
    await rm(join(addonsDir, c.vpk_filename), { force: true });
    deleteCampaign(db, slug);
    invalidateCampaignCache();
    logAdmin(db, adminId, 'campaign.delete', slug, c.name, '');
    return { ok: true };
  });
}
```

- [ ] **Step 5: Register the routes**

In `src/server.ts`, beside the other registrations around line 681:

```ts
  await app.register(campaignRoutes, { db: deps.db, addonsDir: deps.config.addonsDir });
```

with the matching import at the top.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/campaignRoutes.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 8: Commit**

```bash
git add src/routes/campaigns.ts src/config.ts src/server.ts tests/campaignRoutes.test.ts package.json package-lock.json
git commit -m "Upload, publish and download a custom campaign"
```

---

### Task 8: Orchestrator re-checks installation at match start

**Files:**
- Modify: `src/orchestrator.ts` (around the `changelevel` at line 139)
- Test: `tests/orchestrator.test.ts` (extend)

**Interfaces:**
- Consumes: `isInstalledEverywhere` from `src/campaignInstall.js`, `campaignRegistry` from `src/campaignRegistry.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestrator.test.ts`:

```ts
import { insertDraft, publishCampaign, setInstall } from '../src/customCampaigns.js';
import { invalidateCampaignCache } from '../src/campaignRegistry.js';

describe('custom campaign availability', () => {
  const publishCustom = (db: DB, installed: boolean) => {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1_alley', display: null, isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');
    if (installed) setInstall(db, 'dbd', 1, 'installed');
    invalidateCampaignCache();
  };

  // The pool flag can be stale by exactly the window that matters: a server
  // rebuilt between the vote and the changelevel has no VPK, and changelevel
  // into a map it does not have strands the match on a black screen with no
  // error anyone sees. Refusing the setup is the visible failure.
  it('refuses a custom campaign the claimed server does not have', async () => {
    const sent: string[] = [];
    const { db, orchestrator, server } = harness((cmd) => { sent.push(cmd); });
    publishCustom(db, false);
    await expect(orchestrator.setupMatch(matchOn(db, 'dbd', server.id)))
      .rejects.toThrow(/not installed/i);
    expect(sent.some((c) => c.startsWith('changelevel'))).toBe(false);
  });

  it('allows it once that server reports installed', async () => {
    const sent: string[] = [];
    const { db, orchestrator, server } = harness((cmd) => { sent.push(cmd); });
    publishCustom(db, true);
    await orchestrator.setupMatch(matchOn(db, 'dbd', server.id));
    expect(sent).toContain('changelevel dbd1_alley');
  });

  // Stock campaigns have no VPK to install, so they must not be gated by a
  // table that will never have a row for them.
  it('never gates a stock campaign on an install row', async () => {
    const sent: string[] = [];
    const { db, orchestrator, server } = harness((cmd) => { sent.push(cmd); });
    await orchestrator.setupMatch(matchOn(db, 'dead_air', server.id));
    expect(sent).toContain('changelevel l4d_vs_airport01_greenhouse');
  });
});
```

`harness(onCmd)` and `matchOn(db, campaign, serverId)` are the existing setup this file already
uses for `setupMatch`: reuse the rcon fake and match-row builder that the current tests in
`tests/orchestrator.test.ts` use rather than writing new ones, renaming these two references to
whatever those helpers are actually called in the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: FAIL, `changelevel` is issued regardless.

- [ ] **Step 3: Add the guard**

In `src/orchestrator.ts`, immediately before the `changelevel`:

```ts
      // A custom campaign lives in a VPK that must actually be on this box.
      // The pool gate already checks this when the campaign is enabled, but
      // that answer can be stale: a server rebuilt or re-imaged between the
      // vote and now has no addon, and changelevel into a map it does not have
      // strands the match on a black screen with no error anyone sees.
      const entry = campaignRegistry(this.deps.db).get(match.campaign);
      if (entry?.custom && !isInstalledEverywhere(this.deps.db, match.campaign, [server.id])) {
        throw new Error(`${entry.name} is not installed on ${server.name}`);
      }
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "A match refuses a campaign its server does not have"
```

---

### Task 9: Public Custom campaigns page

**Files:**
- Create: `web/src/routes/CustomCampaigns.tsx`
- Modify: `web/src/components/Nav.tsx` (`NAV_LINKS`)
- Modify: `web/src/main.tsx` (add the route)
- Modify: `web/src/api.ts` (add the client call and type)
- Modify: `web/src/styles/app.css` (page styles)
- Test: `web/src/routes/routes.test.tsx` (extend), `web/src/components/Nav.test.tsx` (extend)

**Interfaces:**
- Consumes: `GET /api/campaigns/custom` from task 7
- Produces:
  - `interface CustomCampaignRow { slug: string; name: string; sizeBytes: number; sha256: string; filename: string; notes: string | null; chapters: { map: string; display: string | null; included: boolean }[] }`
  - `api.customCampaigns(signal?: AbortSignal)`

- [ ] **Step 1: Write the failing test**

Append to `web/src/components/Nav.test.tsx`:

```tsx
it('offers Custom alongside Campaigns, at its own path', () => {
  const paths = NAV_LINKS.map(([href]) => href);
  expect(paths).toContain('/maps');
  expect(paths).toContain('/custom-campaigns');
  // /maps is stats about maps played; this is how to install one. Merging the
  // two would break bookmarks and muddle both jobs.
  expect(NAV_LINKS.find(([href]) => href === '/custom-campaigns')![1]).toBe('Custom');
});
```

Append to `web/src/routes/routes.test.tsx`, following that file's existing `mockApi` pattern:

```tsx
describe('CustomCampaigns', () => {
  const campaign = {
    slug: 'dbd', name: 'Dead Before Dawn', sizeBytes: 314572800,
    sha256: 'a'.repeat(64), filename: 'dbd.vpk', notes: null,
    chapters: [
      { map: 'dbd1_alley', display: 'Alley', included: true },
      { map: 'dbd2_mall', display: 'Mall', included: true },
    ],
  };

  it('renders a campaign with a download link to the file route', async () => {
    mockApi.customCampaigns.mockResolvedValue({ campaigns: [campaign] });
    render(<CustomCampaigns />);
    expect(await waitFor(() => screen.getByText('Dead Before Dawn'))).toBeTruthy();
    const link = screen.getByRole('link', { name: /download/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/download/campaign/dbd');
  });

  // preact-iso intercepts same-origin clicks whose target is absent or _self
  // (router.js:45). The download is a real file, not a route, so without a
  // target the click lands on the SPA's not-found instead of downloading.
  it('opts the download link out of the SPA router', async () => {
    mockApi.customCampaigns.mockResolvedValue({ campaigns: [campaign] });
    render(<CustomCampaigns />);
    const link = await waitFor(() => screen.getByRole('link', { name: /download/i }));
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('shows the file size in a human unit', async () => {
    mockApi.customCampaigns.mockResolvedValue({ campaigns: [campaign] });
    render(<CustomCampaigns />);
    expect(await waitFor(() => screen.getByText(/300 MB/i))).toBeTruthy();
  });

  // A player arriving before any campaign is published must be told that,
  // not shown a blank page they assume is broken.
  it('renders an empty state when nothing is published', async () => {
    mockApi.customCampaigns.mockResolvedValue({ campaigns: [] });
    render(<CustomCampaigns />);
    expect(await waitFor(() => screen.getByText(/no custom campaigns/i))).toBeTruthy();
  });
});
```

Add `customCampaigns: vi.fn()` to that file's `mockApi` object.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/components/Nav.test.tsx web/src/routes/routes.test.tsx`
Expected: FAIL, `/custom-campaigns` is not in `NAV_LINKS`.

- [ ] **Step 3: Add the API client call**

In `web/src/api.ts`, beside `maps`:

```ts
export interface CustomCampaignChapter { map: string; display: string | null; included: boolean }
export interface CustomCampaignRow {
  slug: string; name: string; sizeBytes: number; sha256: string;
  filename: string; notes: string | null; chapters: CustomCampaignChapter[];
}
```

and in the `api` object:

```ts
  customCampaigns: (signal?: AbortSignal) =>
    get<{ campaigns: CustomCampaignRow[] }>('/api/campaigns/custom', signal),
```

- [ ] **Step 4: Write the page**

Create `web/src/routes/CustomCampaigns.tsx`:

```tsx
import { api, type CustomCampaignRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignTint } from '../format';
import { Empty, Panel, PageSkeleton } from '../components/bits';
import { PageHeader } from '../components/PageHeader';

/** 300 MB, not 314572800. Nobody installing a campaign cares about bytes. */
function fileSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * How to install the campaigns this server runs beyond the stock four.
 *
 * Separate from /maps, which is stats about maps that have been played. This
 * page exists to answer one question: I could not join, what do I need? So the
 * instructions come first and the download is the most prominent control.
 */
export function CustomCampaigns() {
  const { data, error } = useFetch((s) => api.customCampaigns(s), []);

  if (error) {
    return (
      <div class="page page--list">
        <Panel><Empty>Couldn't load custom campaigns.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <PageSkeleton variant="list" panels={2} />;

  const campaigns = data.campaigns;

  return (
    <div class="page page--list">
      <PageHeader title="Custom campaigns" />

      <Panel>
        <h3>Installing one</h3>
        <ol class="steps">
          <li>Download the <code>.vpk</code> below.</li>
          <li>
            Put it in your <code>left4dead/addons</code> folder. On Windows that is usually
            <code>C:\Program Files (x86)\Steam\steamapps\common\left 4 dead\left4dead\addons</code>.
          </li>
          <li>Restart Left 4 Dead. The campaign loads when a match starts on it.</li>
        </ol>
        <p class="muted">
          Everyone in the match needs the same file, and so does the server. If you join a match
          and the map never loads, this is almost always why.
        </p>
      </Panel>

      {campaigns.length === 0 ? (
        <Panel><Empty>No custom campaigns are installed yet.</Empty></Panel>
      ) : (
        <div class="stack">
          {campaigns.map((c: CustomCampaignRow) => (
            <Panel key={c.slug} style={{ '--campaign': campaignTint(c.slug) } as Record<string, string>}>
              <div class="ccamp__head">
                <h3>{c.name}</h3>
                <a class="btn" href={`/download/campaign/${encodeURIComponent(c.slug)}`}
                   target="_blank" rel="noopener">
                  Download {fileSize(c.sizeBytes)}
                </a>
              </div>
              <ol class="ccamp__chapters">
                {c.chapters.filter((ch) => ch.included).map((ch) => (
                  <li key={ch.map}>{ch.display ?? ch.map}</li>
                ))}
              </ol>
              {c.notes && <p>{c.notes}</p>}
              <p class="muted mono ccamp__hash">{c.filename} · sha256 {c.sha256.slice(0, 16)}...</p>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
```

The `target="_blank"` on the download is load bearing, not decoration. The `NAV_LINKS` comment in
`web/src/components/Nav.tsx` records the rule: preact-iso only intercepts same-origin clicks
whose target is absent or `_self` (router.js:45), so a link to a real file needs one. Without it
the click is swallowed by the router and lands on the SPA's not-found instead of downloading.

Add `.ccamp__head`, `.ccamp__chapters` and `.ccamp__hash` to `web/src/styles/app.css`. Check
first whether `.btn`, `.steps`, `.muted` and `.mono` already exist in that file and reuse them if
so. Do **not** name any new class `.key`: `app.css:1192` is the replay viewer's absolutely
positioned legend, and a second component sharing that name is how the integrity column key
shipped live and invisible.

- [ ] **Step 5: Register the route and nav entry**

`web/src/main.tsx`, beside the `/maps` route:

```tsx
          <Route path="/custom-campaigns" component={CustomCampaigns} />
```

`web/src/components/Nav.tsx`, in `NAV_LINKS` after the maps entry:

```ts
  ['/custom-campaigns', 'Custom'],
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run web/src`
Expected: PASS.

- [ ] **Step 7: Verify it renders**

Start the preview and open `/custom-campaigns`. Confirm the empty state renders when no campaigns are published, and that the page is readable at a mobile width. Take a screenshot for the commit.

- [ ] **Step 8: Commit**

```bash
git add web/src/routes/CustomCampaigns.tsx web/src/components/Nav.tsx web/src/main.tsx web/src/api.ts web/src/styles/app.css web/src/routes/routes.test.tsx web/src/components/Nav.test.tsx
git commit -m "A public page for installing custom campaigns"
```

---

### Task 10: Admin campaigns tab

**Files:**
- Create: `web/src/routes/admin/AdminCampaigns.tsx`
- Modify: `web/src/routes/Admin.tsx` (add the tab)
- Modify: `web/src/api.ts` (admin client calls)
- Test: `web/src/routes/admin.test.tsx` (extend)

**Interfaces:**
- Consumes: the admin routes from task 7
- Produces: `adminApi.campaigns`, `adminApi.uploadCampaign`, `adminApi.publishCampaign`, `adminApi.setCampaignEnabled`, `adminApi.reinstallCampaign`, `adminApi.deleteCampaign`

- [ ] **Step 1: Write the failing test**

Append to `web/src/routes/admin.test.tsx`, following the file's existing mocking and tab-opening patterns:

```tsx
describe('AdminCampaigns', () => {
  it('shows free disk space so an admin sees headroom before uploading', async () => {
    mockAdmin.campaigns.mockResolvedValue({ free: 11 * 1024 ** 3, campaigns: [] });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    expect(await waitFor(() => screen.getByText(/11(\.0)? GB free/i))).toBeTruthy();
  });

  it('shows a per-server install state, and the error when one failed', async () => {
    mockAdmin.campaigns.mockResolvedValue({
      free: 11 * 1024 ** 3,
      campaigns: [{
        slug: 'dbd', name: 'DBD', state: 'published', enabled: 1,
        size_bytes: 9, sha256: 'a'.repeat(64), vpk_filename: 'dbd.vpk',
        uploaded_by: null, uploaded_at: 0, notes: null,
        chapters: [{ slug: 'dbd', ordinal: 1, map: 'dbd1', display: 'One', is_finale: 1, included: 1, play_order: 1 }],
        installs: [
          { slug: 'dbd', server_id: 1, state: 'installed', sha256: null, error: null, updated_at: 0 },
          { slug: 'dbd', server_id: 2, state: 'failed', sha256: null, error: 'connection refused', updated_at: 0 },
        ],
      }],
    });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    expect(await waitFor(() => screen.getByText(/connection refused/))).toBeTruthy();
  });

  // Enabling a campaign that is not on every server is how a match ends up
  // voting for a map a box cannot load.
  it('will not let a campaign with a failed install be enabled', async () => {
    mockAdmin.campaigns.mockResolvedValue({
      free: 11 * 1024 ** 3,
      campaigns: [{
        slug: 'dbd', name: 'DBD', state: 'published', enabled: 0,
        size_bytes: 9, sha256: 'a'.repeat(64), vpk_filename: 'dbd.vpk',
        uploaded_by: null, uploaded_at: 0, notes: null, chapters: [],
        installs: [{ slug: 'dbd', server_id: 2, state: 'failed', sha256: null, error: 'x', updated_at: 0 }],
      }],
    });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }));
    const toggle = await waitFor(() => screen.getByRole('checkbox', { name: /in the pool/i }));
    expect(toggle).toBeDisabled();
  });
});
```

Add `campaigns`, `uploadCampaign`, `publishCampaign`, `setCampaignEnabled`, `reinstallCampaign`, `deleteCampaign` to the `mockAdmin` object at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/src/routes/admin.test.tsx`
Expected: FAIL, there is no Campaigns tab.

- [ ] **Step 3: Add the admin API calls**

In `web/src/api.ts`, first the types the admin tab consumes. These mirror the DB rows exactly,
because the admin route returns them unshaped:

```ts
export interface AdminChapter {
  slug: string; ordinal: number; map: string; display: string | null;
  is_finale: number; included: number; play_order: number | null;
}
export interface AdminInstall {
  slug: string; server_id: number; state: 'pending' | 'installed' | 'failed';
  sha256: string | null; error: string | null; updated_at: number;
}
export interface AdminCampaign {
  slug: string; name: string; vpk_filename: string; size_bytes: number;
  sha256: string; state: 'draft' | 'published'; enabled: number;
  uploaded_by: string | null; uploaded_at: number; notes: string | null;
  chapters: AdminChapter[];
  installs: AdminInstall[];
}
```

then, in the `adminApi` object:

```ts
  campaigns: (signal?: AbortSignal) =>
    get<{ free: number; campaigns: AdminCampaign[] }>('/api/admin/campaigns', signal),
  uploadCampaign: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return post<{ slug: string; name: string; sizeBytes: number; chapters: AdminChapter[] }>(
      '/api/admin/campaigns', form,
    );
  },
  publishCampaign: (slug: string, name: string) =>
    post<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}/publish`, { name }),
  setCampaignEnabled: (slug: string, enabled: boolean) =>
    post<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}/enabled`, { enabled }),
  reinstallCampaign: (slug: string) =>
    post<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}/reinstall`, {}),
  deleteCampaign: (slug: string) =>
    del<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}`),
```

Two helpers this needs do not exist yet, and both must be added before the calls above compile.

**`post` cannot send FormData as written.** At `web/src/api.ts:361` it unconditionally sets
`content-type: application/json` and `JSON.stringify`s the body, which would serialise a
`FormData` to `{}` and send the wrong content type. The browser must set this header itself,
because only it knows the multipart boundary. Make the JSON branch conditional:

```ts
async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    // FormData sets its own content-type, including the multipart boundary
    // that the browser generates. Setting it by hand produces a request the
    // server cannot parse.
    ...(body === undefined
      ? {}
      : body instanceof FormData
        ? { body }
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  // ... unchanged from here
}
```

**There is no `del` helper.** Add one beside `put`, following its shape exactly:

```ts
async function del<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'DELETE' });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (parsed as { error?: string }).error ?? `DELETE ${path} → ${res.status}`);
  return parsed as T;
}
```

- [ ] **Step 4: Write the tab**

Create `web/src/routes/admin/AdminCampaigns.tsx`, using `useAction` from `./useAction.ts` exactly
as the other admin tabs do. It shows:

- Free disk space, in GB, at the top beside the upload control, so headroom is visible before an
  upload rather than discovered by a 507.
- An upload input accepting `.vpk`, disabled while a request is in flight, since these are large
  files and a double submit wastes a few hundred megabytes of transfer.
- For a draft: the parsed name (editable) and its chapter list, with a Publish button.
- For a published campaign: chapters, size, per-server install state with any error shown in
  full, a Reinstall button, an "In the pool" toggle, and a Delete button behind a confirmation.

The pool gate is the one piece of logic here worth writing out, because it is what the tests
assert and what stops a vote landing on a map a box cannot load:

```tsx
/** Every enabled server must have the VPK before a campaign can be voted for.
 *  The orchestrator re-checks this at match start too, because this answer can
 *  go stale, but refusing here is what keeps it out of the vote in the first
 *  place. */
function installedEverywhere(c: AdminCampaign, serverIds: number[]): boolean {
  const ok = new Set(c.installs.filter((i) => i.state === 'installed').map((i) => i.server_id));
  return serverIds.length > 0 && serverIds.every((id) => ok.has(id));
}
```

```tsx
<label>
  <input
    type="checkbox"
    aria-label="In the pool"
    checked={c.enabled === 1}
    disabled={!installedEverywhere(c, serverIds)}
    onChange={(e) => setEnabled(c.slug, (e.target as HTMLInputElement).checked)}
  />
  In the pool
</label>
{!installedEverywhere(c, serverIds) && (
  <p class="muted">Not on every server yet, so it cannot be voted for.</p>
)}
```

`serverIds` comes from the admin overview the panel already loads; take the enabled servers from
there rather than adding a second request.

Register the tab in `web/src/routes/Admin.tsx` beside the existing ones.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run web/src/routes/admin.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/admin/AdminCampaigns.tsx web/src/routes/Admin.tsx web/src/api.ts web/src/routes/admin.test.tsx
git commit -m "An admin tab for uploading and pooling custom campaigns"
```

---

### Task 11: Deployment configuration and runbook

**Files:**
- Modify: `README.md` or create `docs/CUSTOM_CAMPAIGNS.md`
- Modify: `ops/README.md`

- [ ] **Step 1: Document the environment**

Record that `ADDONS_DIR` must be set in `/home/pug/app/.env` to the Dallas game server's `left4dead/addons` path, and that the `pug-web` unit already has the group membership and `ReadWritePaths` needed to write there (`ops/README.md:44`). If the addons directory is not inside an existing `ReadWritePaths` entry, the unit override needs extending, and an upload will fail with `EROFS` until it is.

- [ ] **Step 2: Document the per-server rows**

Both servers need their addons columns filled before any campaign can install. Record the exact statements, with the Chicago FTP credentials taken from `/etc/pug-chicago.env` rather than retyped:

```sql
UPDATE servers SET addons_transport = 'local',
  addons_dir = '/home/l4d/.../left4dead/addons' WHERE name = 'Dallas';
UPDATE servers SET addons_transport = 'ftp', addons_dir = '/left4dead/addons',
  ftp_host = ?, ftp_port = 21, ftp_user = ?, ftp_password = ? WHERE name = 'Chicago';
```

- [ ] **Step 3: Record the deploy order**

Web only, no plugin change in this plan, so the existing `./deploy-web.sh` is the whole deployment. Note that the first upload should be done with the servers empty, because a new VPK appearing in `addons/` changes what a running srcds will mount at its next map load.

- [ ] **Step 4: Commit**

```bash
git add docs/CUSTOM_CAMPAIGNS.md ops/README.md
git commit -m "How to configure custom campaign installs on the box"
```

---

## What plan 2 covers

Written separately once this is live and a real campaign has been uploaded:

- **Spike:** where a generated mission file must live to beat the VPK's own. Measure on `/home/volence/l4d1-ds`, never on Dallas. Passifice measured an addon VPK losing to a built-in mission, so precedence here is not intuitive.
- Mission generation from `included` / `play_order`, with per-chapter versus tuning copied verbatim.
- The plugin's last-included-map end rule, extending `sm_pug_match` with the ordered map list and firing the existing `EndMatchNow()` path.
- Admin UI for reordering and excluding chapters, which is why those columns exist from task 1.
