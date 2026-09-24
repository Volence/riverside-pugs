import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { setSetting } from '../src/settings.js';
import { mineEntries } from '../src/community/entries.js';
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
