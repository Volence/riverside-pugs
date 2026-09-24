import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, type DB } from '../src/db.js';
import { CommunityStore, FLOOR_BYTES } from '../src/community/store.js';
import { sweepCommunity } from '../src/community/sweep.js';

const GiB = 1024 ** 3;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const hex = (c: string) => c.repeat(64);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'community-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const make = (o: Partial<ConstructorParameters<typeof CommunityStore>[0]> = {}) =>
  new CommunityStore({ dir, freeBytes: async () => 100 * GiB, maxBytes: () => 1024 * 2 ** 20, ...o });

describe('CommunityStore', () => {
  it('creates its two folders', () => {
    make();
    expect(existsSync(join(dir, 'imports'))).toBe(true);
    expect(existsSync(join(dir, 'previews'))).toBe(true);
  });

  it('writes a preview under its own hash, once', () => {
    const s = make();
    const bytes = Buffer.from('preview-bytes');
    const first = s.putPreview(bytes);
    expect(first).toEqual({ name: sha(bytes), wrote: true });
    const path = join(dir, 'previews', `${sha(bytes)}.png`);
    const past = new Date(Date.now() - 60_000);
    utimesSync(path, past, past);
    const before = statSync(path).mtimeMs;
    expect(s.putPreview(bytes)).toEqual({ name: sha(bytes), wrote: false });
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('writes an import under its id, once, and refuses a bad id', () => {
    const s = make();
    expect(s.putImport(hex('a'), Buffer.from('vpk'))).toEqual({ wrote: true });
    expect(existsSync(join(dir, 'imports', `${hex('a')}.vpk`))).toBe(true);
    expect(s.putImport(hex('a'), Buffer.from('other'))).toEqual({ wrote: false });
    expect(() => s.putImport('../x', Buffer.from('v'))).toThrow();
  });

  it('writes atomically: a failed rename leaves nothing behind', () => {
    const s = make({ rename: () => { throw new Error('disk gone'); } });
    expect(() => s.putPreview(Buffer.from('x'))).toThrow('disk gone');
    expect(readdirSync(join(dir, 'previews'))).toEqual([]);
  });

  it('sums both folders', () => {
    const s = make();
    s.putPreview(Buffer.alloc(100, 1));
    s.putImport(hex('b'), Buffer.alloc(250, 2));
    expect(s.usedBytes()).toBe(350);
  });

  it('canTake checks the budget and the disk floor', async () => {
    const s = make({ maxBytes: () => 1000 });
    s.putPreview(Buffer.alloc(400, 1));
    expect(await s.canTake(600)).toBe(true);
    expect(await s.canTake(601)).toBe(false);
    const low = make({ maxBytes: () => 10 * GiB, freeBytes: async () => FLOOR_BYTES + 1024 });
    expect(await low.canTake(1024)).toBe(true);
    expect(await low.canTake(2048)).toBe(false);
    expect(FLOOR_BYTES).toBe(12 * GiB);
  });

  it('reads only 64-hex names, and null when missing', () => {
    const s = make();
    const bytes = Buffer.from('p');
    const { name } = s.putPreview(bytes);
    expect(s.readPreview(name)?.equals(bytes)).toBe(true);
    expect(s.readPreview(hex('c'))).toBeNull();
    expect(s.readPreview('../../etc/passwd')).toBeNull();
    expect(s.readPreview(name.toUpperCase())).toBeNull();
    s.putImport(hex('d'), Buffer.from('v'));
    expect(s.readImport(hex('d'))?.toString()).toBe('v');
    expect(s.readImport('d')).toBeNull();
  });

  it('remove is idempotent', () => {
    const s = make();
    const { name } = s.putPreview(Buffer.from('q'));
    s.remove('preview', name);
    s.remove('preview', name);
    expect(s.readPreview(name)).toBeNull();
    s.remove('import', hex('e'));
  });
});

describe('sweepCommunity', () => {
  let db: DB;
  const A = '76561199000000001';
  const NOW = new Date('2026-10-30T12:00:00Z');
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'a', 'active')").run(A);
  });

  const insert = (o: { preview?: string | null; infected?: string | null; importId?: string | null; deletedDaysAgo?: number }) =>
    Number(db.prepare(
      `INSERT INTO community_entries (kind, author_id, title, payload, preview, preview_infected, import_id, created_at, deleted_at, deleted_by)
       VALUES ('hud', ?, 't', '{"v":1}', ?, ?, ?, ?, ?, ?)`,
    ).run(A, o.preview ?? null, o.infected ?? null, o.importId ?? null, daysAgo(60),
      o.deletedDaysAgo === undefined ? null : daysAgo(o.deletedDaysAgo),
      o.deletedDaysAgo === undefined ? null : A).lastInsertRowid);
  const row = (id: number) => db.prepare('SELECT payload, purged_at FROM community_entries WHERE id = ?').get(id) as { payload: string; purged_at: string | null };
  const age = (path: string, ms: number) => { const t = new Date(NOW.getTime() - ms); utimesSync(path, t, t); };

  it('purges a tombstone past 30 days, its preview, and an unshared blob', () => {
    const s = make();
    const p = s.putPreview(Buffer.from('old')).name;
    s.putImport(hex('1'), Buffer.from('blob'));
    const id = insert({ preview: p, importId: hex('1'), deletedDaysAgo: 31 });
    sweepCommunity(db, s, NOW);
    expect(row(id)).toEqual({ payload: '', purged_at: NOW.toISOString() });
    expect(s.readPreview(p)).toBeNull();
    expect(s.readImport(hex('1'))).toBeNull();
  });

  it('keeps a blob a live entry still uses', () => {
    const s = make();
    s.putImport(hex('2'), Buffer.from('blob'));
    const p1 = s.putPreview(Buffer.from('one')).name;
    const p2 = s.putPreview(Buffer.from('two')).name;
    const dead = insert({ preview: p1, importId: hex('2'), deletedDaysAgo: 40 });
    insert({ preview: p2, importId: hex('2') });
    sweepCommunity(db, s, NOW);
    expect(row(dead).purged_at).not.toBeNull();
    expect(s.readImport(hex('2'))).not.toBeNull();
    expect(s.readPreview(p1)).toBeNull();
    expect(s.readPreview(p2)).not.toBeNull();
  });

  it('purges a tombstone\'s infected preview with it', () => {
    const s = make();
    const p = s.putPreview(Buffer.from('surv')).name;
    const q = s.putPreview(Buffer.from('inf')).name;
    insert({ preview: p, infected: q, deletedDaysAgo: 31 });
    sweepCommunity(db, s, NOW);
    expect(s.readPreview(p)).toBeNull();
    expect(s.readPreview(q)).toBeNull();
  });

  it('keeps an infected preview a live entry uses, however old the file', () => {
    const s = make();
    const p = s.putPreview(Buffer.from('surv-live')).name;
    const q = s.putPreview(Buffer.from('inf-live')).name;
    const shared = s.putPreview(Buffer.from('both')).name;
    for (const n of [p, q, shared]) age(join(dir, 'previews', `${n}.png`), 5 * 86_400_000);
    insert({ preview: p, infected: q });
    // One entry's survivor shot is another's infected one: a purge of the
    // first must not take it from the second.
    insert({ preview: shared, deletedDaysAgo: 40 });
    insert({ preview: p, infected: shared });
    sweepCommunity(db, s, NOW);
    expect(s.readPreview(p)).not.toBeNull();
    expect(s.readPreview(q)).not.toBeNull();
    expect(s.readPreview(shared)).not.toBeNull();
  });

  it('leaves a tombstone younger than 30 days alone', () => {
    const s = make();
    const p = s.putPreview(Buffer.from('young')).name;
    const id = insert({ preview: p, deletedDaysAgo: 29 });
    sweepCommunity(db, s, NOW);
    expect(row(id)).toEqual({ payload: '{"v":1}', purged_at: null });
    expect(s.readPreview(p)).not.toBeNull();
  });

  it('deletes an orphan file older than an hour and keeps a younger one', () => {
    const s = make();
    const old = s.putPreview(Buffer.from('orphan-old')).name;
    const young = s.putPreview(Buffer.from('orphan-young')).name;
    s.putImport(hex('3'), Buffer.from('orphan-blob'));
    age(join(dir, 'previews', `${old}.png`), 61 * 60_000);
    age(join(dir, 'previews', `${young}.png`), 59 * 60_000);
    age(join(dir, 'imports', `${hex('3')}.vpk`), 2 * 3_600_000);
    const stray = join(dir, 'previews', '.tmp-abandoned');
    writeFileSync(stray, 'x');
    age(stray, 2 * 3_600_000);
    sweepCommunity(db, s, NOW);
    expect(s.readPreview(old)).toBeNull();
    expect(s.readPreview(young)).not.toBeNull();
    expect(s.readImport(hex('3'))).toBeNull();
    expect(existsSync(stray)).toBe(false);
  });
});
