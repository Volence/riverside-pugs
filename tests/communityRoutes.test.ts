import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { setSetting } from '../src/settings.js';
import { mineEntries } from '../src/community/entries.js';
import { encodeVPK } from '../src/vpkWrite.js';
import { hudId } from '../src/hudFiles.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const GiB = 1024 ** 3;
const A = '76561199000000101';
const B = '76561199000000102';
const MOD = '76561199000000103';
const P = '76561199000000104';

let db: DB;
let app: FastifyInstance;
let dir: string;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'community-'));
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: dir }, db, orchestrator: stubOrchestrator(),
    serverCleaner: async () => {}, serverExec: async () => {}, communityFreeBytes: async () => 100 * GiB,
  });
  for (const id of [A, B, MOD]) cookie[id] = authedCookie(app, db, id);
  cookie[P] = authedCookie(app, db, P, { active: false });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const built = (color = '#39ff5a') => ({
  kind: 'built',
  state: {
    shape: 'cross', len: 7, thick: 2, gap: 3, dot: 2, radius: 8, round: false,
    color, alpha: 100, outline: 1, oalpha: 80, backdrop: 'scene', res: '1080',
  },
});
const body = (title = 'Green cross', extra: object = {}) =>
  ({ title, description: 'Small and bright.', art: built(), permission: true, ...extra });

const inject = (as: string | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, ...(as ? { cookies: cookie[as] } : {}), ...(payload ? { payload } : {}) });
const share = (as: string | null, payload: object = body()) => inject(as, 'POST', '/api/community/crosshairs', payload);
const shareId = async (as: string, title = 'Green cross') => {
  const res = await share(as, body(title));
  expect(res.statusCode).toBe(200);
  return res.json().id as number;
};
const list = (as: string | null, qs = 'kind=crosshair') => inject(as, 'GET', `/api/community?${qs}`);
/** Moves every entry back so the next shares are outside the 24 hour window. */
const ageEntries = () => db.prepare("UPDATE community_entries SET created_at = '2020-01-01T00:00:00.000Z'").run();

describe('sharing a crosshair', () => {
  it('needs an active player', async () => {
    expect((await share(null)).statusCode).toBe(401);
    expect((await share(P)).statusCode).toBe(403);
  });

  it('shares, lists and fetches it', async () => {
    const res = await share(A);
    expect(res.statusCode).toBe(200);
    const { id } = res.json();
    expect(typeof id).toBe('number');

    const page = (await list(null)).json();
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      id, kind: 'crosshair', title: 'Green cross', description: 'Small and bright.',
      author: { steamid: A }, likes: 0, likedByMe: false, art: built(),
    });
    expect((await list(null, 'kind=hud')).json().entries).toHaveLength(0);

    const one = await inject(null, 'GET', `/api/community/${id}`);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id, art: built(), author: { steamid: A } });
    expect((await inject(null, 'GET', '/api/community/9999')).statusCode).toBe(404);
    expect((await inject(null, 'GET', '/api/community/abc')).statusCode).toBe(404);
  });

  it('refuses a bad kind in the list', async () => {
    expect((await list(null, 'kind=skin')).statusCode).toBe(400);
  });

  it('holds to the per-player cap and the daily cap', async () => {
    const first = await shareId(A, 'One cross');
    await shareId(A, 'Two cross');
    const third = await share(A, body('Three cross'));
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toBe('You are sharing 2 crosshairs already. Delete one to share another.');

    expect((await inject(A, 'DELETE', `/api/community/${first}`)).statusCode).toBe(200);
    const again = await shareId(A, 'Three cross');
    expect((await inject(A, 'DELETE', `/api/community/${again}`)).statusCode).toBe(200);
    const fourth = await shareId(A, 'Four cross');
    expect((await inject(A, 'DELETE', `/api/community/${fourth}`)).statusCode).toBe(200);
    await shareId(A, 'Five cross');
    const five = (await list(A)).json().entries.map((e: { id: number }) => e.id);
    for (const id of five) expect((await inject(A, 'DELETE', `/api/community/${id}`)).statusCode).toBe(200);
    await shareId(A, 'Six cross');
    // Six shares in 24 hours, with only one live: the seventh is over the day.
    const seventh = await share(A, body('Seven cross'));
    expect(seventh.statusCode).toBe(429);
    expect(seventh.json().error).toBe('You can share 6 times a day; try again tomorrow.');

    ageEntries();
    expect((await share(A, body('Seven cross'))).statusCode).toBe(200);
  });

  it('refuses every share while sharing is switched off', async () => {
    setSetting(db, 'community_uploads', '0');
    const res = await share(A);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Sharing is switched off right now.');
  });

  it('passes validation refusals through', async () => {
    const slur = await share(A, body('my n1gga hud'));
    expect(slur.statusCode).toBe(400);
    expect(slur.json().error).toBe('That title is not allowed here.');
    expect((await share(A, body('Fine title', { art: built('red') }))).statusCode).toBe(400);
    expect((await share(A, body('Fine title', { description: 'see twitch.tv/x' }))).statusCode).toBe(400);
    const perm = await share(A, body('Fine title', { permission: 'yes' }));
    expect(perm.statusCode).toBe(400);
    expect(perm.json().error).toBe('Tick the box to confirm you may share this.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM community_entries').get()).toEqual({ n: 0 });
  });
});

describe('likes', () => {
  it('are idempotent, never on your own entry, and show as likedByMe', async () => {
    const id = await shareId(A);
    const put = (as: string) => inject(as, 'PUT', `/api/community/${id}/like`);
    expect((await put(B)).json()).toEqual({ likes: 1, likedByMe: true });
    expect((await put(B)).json()).toEqual({ likes: 1, likedByMe: true });
    expect((await put(A)).statusCode).toBe(400);
    expect((await put(P)).statusCode).toBe(403);
    expect((await inject(null, 'PUT', `/api/community/${id}/like`)).statusCode).toBe(401);

    expect((await list(B)).json().entries[0]).toMatchObject({ likes: 1, likedByMe: true });
    expect((await list(A)).json().entries[0]).toMatchObject({ likes: 1, likedByMe: false });
    expect((await list(null)).json().entries[0]).toMatchObject({ likes: 1, likedByMe: false });

    expect((await inject(B, 'DELETE', `/api/community/${id}/like`)).json()).toEqual({ likes: 0, likedByMe: false });
    expect((await inject(B, 'DELETE', `/api/community/${id}/like`)).json()).toEqual({ likes: 0, likedByMe: false });
    expect((await inject(B, 'PUT', '/api/community/9999/like')).statusCode).toBe(404);
  });
});

describe('listing', () => {
  it('sorts top by likes, newest first on a tie', async () => {
    const liked = await shareId(A, 'Old but liked');
    const tieOld = await shareId(B, 'Tie old');
    const tieNew = await shareId(B, 'Tie new');
    await inject(B, 'PUT', `/api/community/${liked}/like`);
    await inject(MOD, 'PUT', `/api/community/${liked}/like`);
    const top = (await list(null, 'kind=crosshair&sort=top')).json().entries.map((e: { id: number }) => e.id);
    expect(top).toEqual([liked, tieNew, tieOld]);
    const recent = (await list(null, 'kind=crosshair&sort=new')).json().entries.map((e: { id: number }) => e.id);
    expect(recent).toEqual([tieNew, tieOld, liked]);
  });

  it('pages by 24, clamps the page, and filters by author', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `765611990000010${String(i + 10)}`);
    const ins = db.prepare(
      `INSERT INTO community_entries (kind, author_id, title, payload, created_at)
       VALUES ('crosshair', ?, ?, ?, ?)`,
    );
    for (const id of ids) {
      authedCookie(app, db, id);
      for (let k = 0; k < 2; k++) ins.run(id, `Cross ${id} ${k}`, JSON.stringify(built()), new Date().toISOString());
    }
    const p0 = (await list(null, 'kind=crosshair&page=0')).json();
    expect(p0.entries).toHaveLength(24);
    expect(p0.total).toBe(30);
    expect((await list(null, 'kind=crosshair&page=1')).json().entries).toHaveLength(6);
    expect((await list(null, 'kind=crosshair&page=-3')).json().page).toBe(0);
    expect((await list(null, 'kind=crosshair&page=9999')).json().page).toBe(100);
    expect((await list(null, 'kind=crosshair&page=nope')).json().page).toBe(0);
    const mine = (await list(null, `kind=crosshair&author=${ids[3]}`)).json();
    expect(mine.entries).toHaveLength(2);
    expect(mine.entries.every((e: { author: { steamid: string } }) => e.author.steamid === ids[3])).toBe(true);
  });

  it('leaves out a banned author, who still sees their own', async () => {
    const id = await shareId(A);
    await shareId(B, 'Stays up');
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(A);
    const titles = (await list(null)).json().entries.map((e: { title: string }) => e.title);
    expect(titles).toEqual(['Stays up']);
    expect((await inject(null, 'GET', `/api/community/${id}`)).statusCode).toBe(404);
    expect(mineEntries(db, A).map((e) => e.id)).toEqual([id]);
  });
});

describe('a banned author', () => {
  /** A ban row only, as in the minute before the reaper sets status. */
  const banRow = (id: string, expires: string | null = null) => db.prepare(
    `INSERT INTO bans (player_id, reason, created_by, created_at, expires_at) VALUES (?, 'x', ?, ?, ?)`,
  ).run(id, MOD, new Date().toISOString(), expires);

  it('cannot have their entries liked, by status or by the bans table', async () => {
    const id = await shareId(A);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(A);
    expect((await inject(B, 'PUT', `/api/community/${id}/like`)).statusCode).toBe(404);
    db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(A);
    banRow(A);
    expect((await inject(B, 'PUT', `/api/community/${id}/like`)).statusCode).toBe(404);
    expect((await inject(B, 'DELETE', `/api/community/${id}/like`)).statusCode).toBe(404);
  });

  it('is hidden from the gallery, the entry and the files by an active ban row alone', async () => {
    const id = await shareId(A);
    const preview = png(960, 540, 3);
    expect((await shareHud(A, { preview })).statusCode).toBe(200);
    banRow(A, '2000-01-01T00:00:00.000Z');
    expect((await list(null)).json().entries).toHaveLength(1);
    banRow(A);
    expect((await list(null)).json()).toMatchObject({ entries: [], total: 0 });
    expect((await list(null, 'kind=hud')).json().entries).toHaveLength(0);
    expect((await inject(null, 'GET', `/api/community/${id}`)).statusCode).toBe(404);
    expect((await inject(MOD, 'GET', `/api/community/${id}`)).statusCode).toBe(200);
    expect((await inject(null, 'GET', `/api/community/files/previews/${sha(preview)}.png`)).statusCode).toBe(404);
  });
});

describe('delete', () => {
  it('is the author only, and staff still see the tombstone', async () => {
    const id = await shareId(A);
    expect((await inject(B, 'DELETE', `/api/community/${id}`)).statusCode).toBe(403);
    expect((await inject(MOD, 'DELETE', `/api/community/${id}`)).statusCode).toBe(403);
    expect((await inject(A, 'DELETE', `/api/community/${id}`)).statusCode).toBe(200);
    expect((await inject(A, 'DELETE', `/api/community/${id}`)).statusCode).toBe(404);
    expect((await inject(null, 'GET', `/api/community/${id}`)).statusCode).toBe(404);
    expect((await inject(B, 'GET', `/api/community/${id}`)).statusCode).toBe(404);
    const staff = await inject(MOD, 'GET', `/api/community/${id}`);
    expect(staff.statusCode).toBe(200);
    expect(staff.json()).toMatchObject({ id, removed: { by: A, reason: null } });
    expect((await list(null)).json().entries).toHaveLength(0);
  });
});

describe('mine', () => {
  it('lists live entries and staff removals with the caps', async () => {
    expect((await inject(null, 'GET', '/api/community/mine')).statusCode).toBe(401);
    expect((await inject(P, 'GET', '/api/community/mine')).statusCode).toBe(403);
    const live = await shareId(A, 'Live one');
    const gone = await shareId(A, 'Deleted one');
    await inject(A, 'DELETE', `/api/community/${gone}`);
    const removed = await shareId(A, 'Removed one');
    db.prepare("UPDATE community_entries SET deleted_at = ?, deleted_by = ?, delete_reason = 'offensive' WHERE id = ?")
      .run(new Date().toISOString(), MOD, removed);

    const res = (await inject(A, 'GET', '/api/community/mine')).json();
    expect(res.caps).toEqual({ huds: 2, crosshairs: 2, perDay: 6, sharedToday: 3 });
    expect(res.entries.map((e: { id: number }) => e.id)).toEqual([removed, live]);
    expect(res.entries[0]).toMatchObject({ removedByStaff: 'offensive' });
    expect(res.entries[1]).toMatchObject({ removedByStaff: null, title: 'Live one' });
  });
});

// ---- HUD shares (Task 7) ----------------------------------------------------

const MB = 1024 * 1024;
const STOCK = join(import.meta.dirname, '..', 'web', 'src', 'hud', 'base', 'stock');

function stockFiles(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(STOCK, full).split('\\').join('/'), new Uint8Array(readFileSync(full)));
    }
  };
  walk(STOCK);
  return out;
}
const vpkOf = (files: Map<string, Uint8Array>) => encodeVPK([...files].map(([path, data]) => ({ path, data })));
const text = (s: string) => new TextEncoder().encode(s);

/**
 * A v1 archive written entry by entry, as web/src/vpk/fixtures.ts's handMade
 * (which the node typecheck cannot import): for layouts encodeVPK never
 * writes, such as two entries over the same bytes. Every entry is in the
 * _dir file (0x7FFF) with no preload bytes.
 */
function handMade(entries: { path: string; offset: number; length: number; data?: Uint8Array }[]): Uint8Array {
  const tree: number[] = [];
  const data: number[] = [];
  for (const e of entries) {
    const slash = e.path.lastIndexOf('/');
    const base = e.path.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    tree.push(...text(`${base.slice(dot + 1)}\0${e.path.slice(0, slash)}\0${base.slice(0, dot)}\0`));
    const entry = new Uint8Array(18);
    const dv = new DataView(entry.buffer);
    dv.setUint16(6, 0x7FFF, true);
    dv.setUint32(8, e.offset, true);
    dv.setUint32(12, e.length, true);
    dv.setUint16(16, 0xFFFF, true);
    tree.push(...entry, 0, 0);
    if (e.data) data.push(...e.data);
  }
  tree.push(0);
  const out = new Uint8Array(12 + tree.length + data.length);
  const h = new DataView(out.buffer);
  h.setUint32(0, 0x55AA1234, true);
  h.setUint32(4, 1, true);
  h.setUint32(8, tree.length, true);
  out.set(tree, 12);
  out.set(data, 12 + tree.length);
  return out;
}

/** A PNG header only: signature, then an IHDR chunk saying w x h, then `pad`
 *  bytes (a different pad is a different preview hash). Enough for pngSize. */
function png(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(24 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  for (let i = 24; i < b.length; i++) b[i] = i & 0xff;
  return b;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const modern = (extra: object = {}) => ({ v: 1, name: 'x', preset: 'modern', aspect: '16:9', advanced: false, ...extra });
const onImport = (id: string) =>
  ({ v: 1, name: 'x', preset: 'imported', aspect: '16:9', advanced: false, imported: { id, name: 'My Base' } });

interface HudShare {
  title?: string;
  permission?: unknown;
  design?: object;
  importId?: string;
  preview?: Uint8Array | null;
  vpk?: Uint8Array | null;
}
function hudForm(o: HudShare = {}): FormData {
  const form = new FormData();
  const meta: Record<string, unknown> = {
    title: o.title ?? 'Clean HUD', description: 'Tidy.', permission: o.permission ?? true,
    design: JSON.stringify(o.design ?? modern()),
  };
  if (o.importId !== undefined) meta.importId = o.importId;
  form.set('meta', JSON.stringify(meta));
  const preview = o.preview === undefined ? png(960, 540) : o.preview;
  if (preview) form.set('preview', new Blob([preview as BlobPart], { type: 'image/png' }), 'preview.png');
  if (o.vpk) form.set('import', new Blob([o.vpk as BlobPart]), 'base.vpk');
  return form;
}
const shareHud = (as: string | null, o: HudShare = {}) =>
  app.inject({ method: 'POST', url: '/api/community/huds', ...(as ? { cookies: cookie[as] } : {}), payload: hudForm(o) });
const get = (as: string | null, url: string) => inject(as, 'GET', url);
const filesIn = (sub: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)) : []);

describe('sharing a HUD', () => {
  it('needs an active player', async () => {
    expect((await shareHud(null)).statusCode).toBe(401);
    expect((await shareHud(P)).statusCode).toBe(403);
  });

  it('shares a Modern design with its preview, and serves the preview safely', async () => {
    const preview = png(960, 540, 10);
    const res = await shareHud(A, { preview });
    expect(res.statusCode).toBe(200);
    const { id } = res.json();

    const entry = (await list(null, 'kind=hud')).json().entries[0];
    expect(entry).toMatchObject({
      id, kind: 'hud', title: 'Clean HUD', preset: 'modern', aspect: '16:9', advanced: false,
      importName: null, previewUrl: `/api/community/files/previews/${sha(preview)}.png`,
    });
    const one = (await get(null, `/api/community/${id}`)).json();
    // The design is stored under the title, not the name the browser sent.
    expect(one.design).toMatchObject({ preset: 'modern', name: 'Clean HUD' });

    const file = await get(null, entry.previewUrl);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(file.headers['cache-control']).toBe('public, max-age=3600');
    expect(new Uint8Array(file.rawPayload)).toEqual(preview);
  });

  it('shares a design on an imported HUD, and stores a shared import once', async () => {
    const files = stockFiles();
    const id = await hudId(files);
    const vpk = vpkOf(files);
    const res = await shareHud(A, { design: onImport(id), importId: id, vpk });
    expect(res.statusCode).toBe(200);
    expect((await list(null, 'kind=hud')).json().entries[0]).toMatchObject({ preset: 'imported', importName: 'My Base' });

    const blob = await get(null, `/api/community/files/imports/${id}.vpk`);
    expect(blob.statusCode).toBe(200);
    expect(blob.headers['content-type']).toBe('application/octet-stream');
    expect(blob.headers['content-disposition']).toMatch(/^attachment/);
    expect(blob.headers['x-content-type-options']).toBe('nosniff');
    expect(blob.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(blob.rawPayload)).toEqual(vpk);
    const before = statSync(join(dir, 'imports', `${id}.vpk`)).mtimeMs;

    const second = await shareHud(B, {
      title: 'Other take', design: { ...onImport(id), aspect: '4:3' }, importId: id, vpk, preview: png(720, 540),
    });
    expect(second.statusCode).toBe(200);
    expect(filesIn('imports')).toEqual([`${id}.vpk`]);
    expect(statSync(join(dir, 'imports', `${id}.vpk`)).mtimeMs).toBe(before);
  });

  it('refuses a bad import, naming what is wrong', async () => {
    const files = stockFiles();
    const id = await hudId(files);

    const bad = new Map(files);
    bad.set('cfg/autoexec.cfg', text('bind w kill\n'));
    const badId = await hudId(bad);
    const cfg = await shareHud(A, { design: onImport(badId), importId: badId, vpk: vpkOf(bad) });
    expect(cfg.statusCode).toBe(400);
    expect(cfg.json().error).toContain('cfg/autoexec.cfg');

    const vpk = vpkOf(files);
    const padded = new Uint8Array(vpk.length + 3);
    padded.set(vpk);
    expect((await shareHud(A, { design: onImport(id), importId: id, vpk: padded })).statusCode).toBe(400);

    // Two entries over the same bytes: the old length rule passed this one.
    const overlap = handMade([
      { path: 'scripts/hudlayout.res', offset: 0, length: 6, data: text('"a"{}hidden!') },
      { path: 'resource/ui/hud/p.res', offset: 0, length: 6 },
    ]);
    const overlapId = await hudId(new Map([['scripts/hudlayout.res', text('"a"{}h')], ['resource/ui/hud/p.res', text('"a"{}h')]]));
    const o = await shareHud(A, { design: onImport(overlapId), importId: overlapId, vpk: overlap });
    expect(o.statusCode).toBe(400);
    expect(o.json().error).toMatch(/not laid out as the editor writes/);

    const clash = handMade([
      { path: 'scripts/hudlayout.res', offset: 0, length: 6, data: text('"a"{}\n') },
      { path: 'SCRIPTS/HUDLAYOUT.res', offset: 6, length: 6, data: text('"b"{}\n') },
    ]);
    const clashId = await hudId(new Map([['scripts/hudlayout.res', text('"b"{}\n')]]));
    const c = await shareHud(A, { design: onImport(clashId), importId: clashId, vpk: clash });
    expect(c.statusCode).toBe(400);
    expect(c.json().error).toMatch(/differ only in case/);

    // The claimed id is not the files' own.
    const other = 'f'.repeat(64);
    expect((await shareHud(A, { design: onImport(other), importId: other, vpk })).statusCode).toBe(400);
    // An import part on a design that uses none.
    expect((await shareHud(A, { importId: id, vpk })).statusCode).toBe(400);
    // An imported design with no import part.
    expect((await shareHud(A, { design: onImport(id), importId: id })).statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM community_entries').get()).toEqual({ n: 0 });
    expect(filesIn('imports')).toEqual([]);
    expect(filesIn('previews')).toEqual([]);
  });

  it('refuses a bad preview, a missing one, an oversized import and a missing permission', async () => {
    const wrongAspect = await shareHud(A, { preview: png(720, 540) });
    expect(wrongAspect.statusCode).toBe(400);
    expect((await shareHud(A, { preview: text('not a png at all, no') })).statusCode).toBe(400);
    expect((await shareHud(A, { preview: null })).statusCode).toBe(400);

    const huge = new Uint8Array(20 * MB + 1);
    expect((await shareHud(A, { design: onImport('a'.repeat(64)), importId: 'a'.repeat(64), vpk: huge })).statusCode).toBe(413);

    const perm = await shareHud(A, { permission: 'yes' });
    expect(perm.statusCode).toBe(400);
    expect(perm.json().error).toBe('Tick the box to confirm you may share this.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM community_entries').get()).toEqual({ n: 0 });
  });

  it('refuses a request that is not the three expected parts', async () => {
    const form = hudForm();
    form.set('extra', new Blob([png(960, 540) as BlobPart]), 'x.png');
    const res = await app.inject({ method: 'POST', url: '/api/community/huds', cookies: cookie[A], payload: form });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const noMeta = new FormData();
    noMeta.set('preview', new Blob([png(960, 540) as BlobPart]), 'p.png');
    expect((await app.inject({ method: 'POST', url: '/api/community/huds', cookies: cookie[A], payload: noMeta })).statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM community_entries').get()).toEqual({ n: 0 });
  });

  it('holds to the HUD cap', async () => {
    expect((await shareHud(A, { title: 'One HUD', preview: png(960, 540, 1) })).statusCode).toBe(200);
    expect((await shareHud(A, { title: 'Two HUD', preview: png(960, 540, 2) })).statusCode).toBe(200);
    const third = await shareHud(A, { title: 'Three HUD', preview: png(960, 540, 3) });
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toBe('You are sharing 2 HUDs already. Delete one to share another.');
    // Refused before anything was written.
    expect(filesIn('previews')).toHaveLength(2);
  });

  it('refuses a share while sharing is switched off', async () => {
    setSetting(db, 'community_uploads', '0');
    expect((await shareHud(A)).statusCode).toBe(403);
  });

  it('refuses a share the budget cannot take', async () => {
    setSetting(db, 'community_store_mb', '100');
    mkdirSync(join(dir, 'previews'), { recursive: true });
    const filler = join(dir, 'previews', 'filler.bin');
    writeFileSync(filler, '');
    truncateSync(filler, 100 * MB - 1024);
    const res = await shareHud(A, { preview: png(960, 540, 2048) });
    expect(res.statusCode).toBe(507);
    expect(res.json().error).toBe('The community shelf is full right now.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM community_entries').get()).toEqual({ n: 0 });
  });

  it('takes a share that adds no new bytes, even with the shelf over budget', async () => {
    const preview = png(960, 540, 9);
    expect((await shareHud(A, { preview })).statusCode).toBe(200);
    setSetting(db, 'community_store_mb', '100');
    const filler = join(dir, 'previews', 'filler.bin');
    writeFileSync(filler, '');
    truncateSync(filler, 100 * MB + 1024);
    expect((await shareHud(B, { title: 'Same shot', preview })).statusCode).toBe(200);
    expect((await shareHud(B, { title: 'New shot', preview: png(960, 540, 10) })).statusCode).toBe(507);
  });

  it('refuses a share that would cross the disk floor', async () => {
    await app.close();
    app = await buildServer({
      config: { ...loadConfig({}), communityDir: dir }, db, orchestrator: stubOrchestrator(),
      serverCleaner: async () => {}, serverExec: async () => {},
      communityFreeBytes: async () => 12 * GiB + 1024,
    });
    cookie[A] = authedCookie(app, db, A);
    const res = await shareHud(A, { preview: png(960, 540, 2048) });
    expect(res.statusCode).toBe(507);
    expect(res.json().error).toBe('The community shelf is full right now.');
  });

  it('removes only what the request wrote when the insert fails', async () => {
    const files = stockFiles();
    const id = await hudId(files);
    const vpk = vpkOf(files);
    expect((await shareHud(B, { design: onImport(id), importId: id, vpk, preview: png(960, 540, 1) })).statusCode).toBe(200);
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON community_entries WHEN NEW.title = 'Boom HUD'
             BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const fresh = png(960, 540, 7);
    const res = await shareHud(A, { title: 'Boom HUD', design: onImport(id), importId: id, vpk, preview: fresh });
    expect(res.statusCode).toBe(500);
    expect(filesIn('previews')).not.toContain(`${sha(fresh)}.png`);
    expect(filesIn('previews')).toHaveLength(1);
    // The import was already there for B's entry, so it stays.
    expect(filesIn('imports')).toEqual([`${id}.vpk`]);
  });

  it('serves a tombstone\'s files to staff only, and never caches them', async () => {
    const files = stockFiles();
    const id = await hudId(files);
    const preview = png(960, 540, 5);
    const res = await shareHud(A, { design: onImport(id), importId: id, vpk: vpkOf(files), preview });
    const entryId = res.json().id;
    await inject(A, 'DELETE', `/api/community/${entryId}`);
    const urls = [`/api/community/files/previews/${sha(preview)}.png`, `/api/community/files/imports/${id}.vpk`];
    for (const url of urls) {
      expect((await get(null, url)).statusCode).toBe(404);
      expect((await get(B, url)).statusCode).toBe(404);
      const staff = await get(MOD, url);
      expect(staff.statusCode).toBe(200);
      expect(staff.headers['cache-control']).toBe('no-store');
      expect(staff.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('refuses a file name that is not a hash', async () => {
    expect((await get(MOD, '/api/community/files/previews/..%2F..%2Fpug.db')).statusCode).toBe(404);
    expect((await get(MOD, `/api/community/files/previews/${'A'.repeat(64)}.png`)).statusCode).toBe(404);
    expect((await get(MOD, `/api/community/files/imports/${'a'.repeat(64)}.png`)).statusCode).toBe(404);
    expect((await get(MOD, `/api/community/files/previews/${'a'.repeat(64)}.png`)).statusCode).toBe(404);
  });
});

describe('HUD share limits before the body is read', () => {
  /** A share whose body stops after its first bytes until `release`, so the handler stays in flight. */
  async function held(as: string, o: HudShare = {}) {
    const res = new Response(hudForm(o));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const stream = new PassThrough();
    stream.write(bytes.subarray(0, 16));
    const pending = app.inject({
      method: 'POST', url: '/api/community/huds', cookies: cookie[as],
      headers: { 'content-type': res.headers.get('content-type')! }, payload: stream,
    });
    await new Promise((r) => setTimeout(r, 50));
    return { pending, release: () => stream.end(bytes.subarray(16)) };
  }

  it('refuses a player at the HUD cap before parsing anything', async () => {
    expect((await shareHud(A, { title: 'One HUD', preview: png(960, 540, 1) })).statusCode).toBe(200);
    expect((await shareHud(A, { title: 'Two HUD', preview: png(960, 540, 2) })).statusCode).toBe(200);
    const res = await app.inject({
      method: 'POST', url: '/api/community/huds', cookies: cookie[A],
      headers: { 'content-type': 'multipart/form-data; boundary=zz' }, payload: 'not multipart at all',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('You are sharing 2 HUDs already. Delete one to share another.');
  });

  it('refuses a body cut off mid-part as not the form the site sends, not a 500', async () => {
    const res = new Response(hudForm({ title: 'Cut short', preview: png(960, 540, 1) }));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const cut = await app.inject({
      method: 'POST', url: '/api/community/huds', cookies: cookie[A],
      headers: { 'content-type': res.headers.get('content-type')! },
      payload: Buffer.from(bytes.subarray(0, Math.floor(bytes.length / 2))),
    });
    expect(cut.statusCode).toBe(400);
    expect(cut.json().error).toBe('The share is not in the form the site sends.');
    // Nothing was kept, and the player's upload slot is free again.
    expect((await shareHud(A, { title: 'Whole one', preview: png(960, 540, 2) })).statusCode).toBe(200);
  });

  it('allows one HUD upload in flight per player, and two across the site', async () => {
    const a = await held(A, { title: 'Held A', preview: png(960, 540, 1) });
    const again = await shareHud(A, { title: 'Second A', preview: png(960, 540, 2) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('Your last HUD share is still uploading; wait for it to finish.');

    const b = await held(B, { title: 'Held B', preview: png(960, 540, 3) });
    const third = await shareHud(MOD, { title: 'Mod HUD', preview: png(960, 540, 4) });
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toBe('Other HUD shares are uploading right now; try again in a moment.');

    a.release();
    b.release();
    expect((await a.pending).statusCode).toBe(200);
    expect((await b.pending).statusCode).toBe(200);
    // Both slots are free again, refusals included.
    expect((await shareHud(MOD, { title: 'Mod HUD', preview: png(960, 540, 4) })).statusCode).toBe(200);
    expect((await shareHud(A, { title: 'x' })).statusCode).toBe(400);
    expect((await shareHud(A, { title: 'Second A', preview: png(960, 540, 2) })).statusCode).toBe(200);
  });

  it('refuses an oversized preview as it streams, before the details are read', async () => {
    const res = await shareHud(A, { title: 'x', preview: png(960, 540, 2 * MB) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('The preview is over 1.5 MB.');
  });
});

describe('the sweep at server start', () => {
  const oldTombstone = (preview: string | null) => {
    db.prepare("INSERT INTO players (steamid, name) VALUES (?, 'old')").run('76561199000000999');
    return Number(db.prepare(
      `INSERT INTO community_entries (kind, author_id, title, payload, preview, created_at, deleted_at, deleted_by)
       VALUES ('hud', '76561199000000999', 'Old one', '{"v":1}', ?, '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z', '76561199000000999')`,
    ).run(preview).lastInsertRowid);
  };
  const row = (id: number) => db.prepare('SELECT payload, purged_at FROM community_entries WHERE id = ?').get(id) as
    { payload: string; purged_at: string | null };

  it('purges an old tombstone and its preview', async () => {
    await app.close();
    db = openDb(':memory:');
    const name = 'c'.repeat(64);
    mkdirSync(join(dir, 'previews'), { recursive: true });
    writeFileSync(join(dir, 'previews', `${name}.png`), png(960, 540));
    const id = oldTombstone(name);
    app = await buildServer({
      config: { ...loadConfig({}), communityDir: dir }, db, orchestrator: stubOrchestrator(),
      serverCleaner: async () => {}, serverExec: async () => {}, communityFreeBytes: async () => 100 * GiB,
    });
    expect(row(id).payload).toBe('');
    expect(row(id).purged_at).not.toBeNull();
    expect(filesIn('previews')).toEqual([]);
  });

  it('purges rows but creates no folder when the store was never used', async () => {
    await app.close();
    db = openDb(':memory:');
    const id = oldTombstone(null);
    const never = join(dir, 'never');
    app = await buildServer({
      config: { ...loadConfig({}), communityDir: never }, db, orchestrator: stubOrchestrator(),
      serverCleaner: async () => {}, serverExec: async () => {}, communityFreeBytes: async () => 100 * GiB,
    });
    expect(row(id).payload).toBe('');
    expect(existsSync(never)).toBe(false);
  });
});

// ---- Staff removal (Task 8) ---------------------------------------------------

describe('staff remove', () => {
  it('is staff only, needs a reason, logs it, and tells the author', async () => {
    const id = await shareId(A);
    const remove = (as: string | null, payload?: object) => inject(as, 'POST', `/api/community/${id}/remove`, payload);
    expect((await remove(null, { reason: 'x' })).statusCode).toBe(401);
    expect((await remove(B, { reason: 'offensive preview' })).statusCode).toBe(403);
    expect((await remove(MOD)).statusCode).toBe(400);
    expect((await remove(MOD, { reason: '   ' })).statusCode).toBe(400);
    expect((await remove(MOD, { reason: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await list(null)).json().entries).toHaveLength(1);

    const res = await remove(MOD, { reason: 'offensive preview' });
    expect(res.statusCode).toBe(200);
    expect((await list(null)).json().entries).toHaveLength(0);

    const audit = db.prepare("SELECT admin_id, target, detail FROM admin_actions WHERE action = 'community_remove'").all() as
      { admin_id: string; target: string; detail: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.admin_id).toBe(MOD);
    expect(audit[0]!.target).toBe(A);
    expect(JSON.parse(audit[0]!.detail)).toEqual({ entryId: id, kind: 'crosshair', title: 'Green cross', reason: 'offensive preview' });

    const mine = (await inject(A, 'GET', '/api/community/mine')).json();
    expect(mine.entries[0]).toMatchObject({ id, removedByStaff: 'offensive preview' });
    expect((await inject(MOD, 'GET', `/api/community/${id}`)).json()).toMatchObject({ removed: { by: MOD, reason: 'offensive preview' } });

    expect((await remove(MOD, { reason: 'again' })).statusCode).toBe(404);
    expect((await inject(MOD, 'POST', '/api/community/9999/remove', { reason: 'x' })).statusCode).toBe(404);
  });

  it('refuses a removal of an entry the author already deleted', async () => {
    const id = await shareId(A);
    await inject(A, 'DELETE', `/api/community/${id}`);
    expect((await inject(MOD, 'POST', `/api/community/${id}/remove`, { reason: 'late' })).statusCode).toBe(404);
  });
});
