import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { setSetting } from '../src/settings.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const ADMIN = '76561199000000820';
const MOD = '76561199000000821';
const PLAYER = '76561199000000822';
const CHANNEL = 'news-channel';

let db: DB;
let app: FastifyInstance;
let t: FakeTransport;
let cookies: Record<string, Record<string, string>>;

async function boot(withTransport = true) {
  db = openDb(':memory:');
  t = new FakeTransport();
  app = await buildServer({
    config: { ...loadConfig({}), publicUrl: 'https://pug.test', communityDir: mkdtempSync(join(tmpdir(), 'news-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    newsTransport: withTransport ? t : undefined,
  });
  cookies = {};
  for (const id of [ADMIN, MOD, PLAYER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
}

beforeEach(async () => { await boot(); });
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });

async function draft(over: Partial<{ kind: string; title: string; body: string }> = {}): Promise<number> {
  const r = await call('POST', '/api/admin/news', ADMIN, { kind: 'news', title: 'Season 1', body: 'Hello **all**', ...over });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().post.id as number;
}
const row = (id: number) => db.prepare('SELECT * FROM news_posts WHERE id = ?').get(id) as Record<string, unknown> | undefined;

describe('news routes: permissions', () => {
  it('lets only admins into the editor: a mod and a player get 403, a stranger 401', async () => {
    const id = await draft();
    for (const as of [MOD, PLAYER]) {
      for (const [method, url] of [
        ['GET', '/api/admin/news'], ['POST', '/api/admin/news'], ['POST', `/api/admin/news/${id}`],
        ['POST', `/api/admin/news/${id}/publish`], ['POST', `/api/admin/news/${id}/unpublish`], ['POST', `/api/admin/news/${id}/delete`],
      ] as ['GET' | 'POST', string][]) {
        expect((await call(method, url, as, { kind: 'news', title: 'x', body: 'y' })).statusCode, `${as} ${url}`).toBe(403);
      }
    }
    expect((await call('GET', '/api/admin/news')).statusCode).toBe(401);
    expect((await call('POST', `/api/admin/news/${id}/publish`)).statusCode).toBe(401);
    expect(row(id)!.published_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action LIKE 'news_%'").get()).toEqual({ n: 1 });
  });

  it('checks the fields', async () => {
    for (const bad of [
      { kind: 'blog', title: 'x', body: '' }, { kind: 'news', title: '  ', body: '' }, { kind: 'news', title: 'x'.repeat(121), body: '' },
      { kind: 'news', title: 'x', body: 'y'.repeat(20_001) }, { kind: 'news', title: 'x' },
    ]) {
      expect((await call('POST', '/api/admin/news', ADMIN, bad)).statusCode, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await call('POST', '/api/admin/news/99/publish', ADMIN)).statusCode).toBe(404);
  });
});

describe('news routes: public reads', () => {
  it('hides drafts from the list and from the single read', async () => {
    const id = await draft({ title: 'Secret draft' });
    expect((await call('GET', '/api/news')).json()).toMatchObject({ posts: [], total: 0, page: 1, pages: 1 });
    expect((await call('GET', `/api/news/${id}`)).statusCode).toBe(404);
    expect((await call('GET', '/api/news/abc')).statusCode).toBe(404);
    expect((await call('POST', `/api/admin/news/${id}/publish`, ADMIN)).statusCode).toBe(200);
    const got = (await call('GET', `/api/news/${id}`)).json().post;
    expect(got).toMatchObject({ id, kind: 'news', title: 'Secret draft', body: 'Hello **all**', excerpt: 'Hello all' });
    expect(got.author.steamid).toBe(ADMIN);
    // Unpublished again: gone from public view.
    expect((await call('POST', `/api/admin/news/${id}/unpublish`, ADMIN)).statusCode).toBe(200);
    expect((await call('GET', `/api/news/${id}`)).statusCode).toBe(404);
  });

  it('lists newest first, a page at a time', async () => {
    for (let i = 1; i <= 12; i++) {
      const id = await draft({ title: `Post ${i}` });
      db.prepare('UPDATE news_posts SET published_at = ? WHERE id = ?').run(`2026-10-${String(i).padStart(2, '0')}T12:00:00.000Z`, id);
    }
    const p1 = (await call('GET', '/api/news')).json();
    expect(p1.total).toBe(12);
    expect(p1.pages).toBe(2);
    expect(p1.posts.map((p: { title: string }) => p.title).slice(0, 2)).toEqual(['Post 12', 'Post 11']);
    const p2 = (await call('GET', '/api/news?page=2')).json();
    expect(p2.posts.map((p: { title: string }) => p.title)).toEqual(['Post 2', 'Post 1']);
    const latest = (await call('GET', '/api/news?limit=1')).json();
    expect(latest.posts).toHaveLength(1);
    expect(latest.posts[0].title).toBe('Post 12');
  });

  it('narrows the list to one kind for /patch-notes, and ignores an unknown kind', async () => {
    for (const [kind, title] of [['news', 'Launch'], ['patch', 'Patch notes Oct 21'], ['patch', 'Patch notes Oct 22']] as const) {
      const id = await draft({ kind, title });
      db.prepare('UPDATE news_posts SET published_at = ? WHERE id = ?').run('2026-10-21T12:00:00.000Z', id);
    }
    const patch = (await call('GET', '/api/news?kind=patch')).json();
    expect(patch.total).toBe(2);
    expect(patch.posts.every((p: { kind: string }) => p.kind === 'patch')).toBe(true);
    expect((await call('GET', '/api/news?kind=bogus')).json().total).toBe(3);
  });

  it('stores the body as written and never turns it into HTML', async () => {
    const body = '<script>alert(1)</script>\n[x](javascript:alert(1))';
    const id = await draft({ body });
    await call('POST', `/api/admin/news/${id}/publish`, ADMIN);
    const got = (await call('GET', `/api/news/${id}`)).json().post;
    expect(got.body).toBe(body);
    // The excerpt is plain text: link markup taken out, the href gone with it.
    expect(got.excerpt).not.toContain('javascript:');
  });
});

describe('news routes: Discord', () => {
  it('posts on publish, edits on edit, removes on unpublish, and logs each step', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const id = await draft({ kind: 'patch', title: 'Patch notes Oct 21', body: '- Uzi back to 20 damage' });
    expect(t.live()).toHaveLength(0);

    const pub = (await call('POST', `/api/admin/news/${id}/publish`, ADMIN)).json();
    expect(pub.post.discord).toBe('posted');
    expect(pub.channelSet).toBe(true);
    const [msg] = t.live();
    expect(msg.channelId).toBe(CHANNEL);
    expect(msg.payload.embeds[0]).toMatchObject({ title: 'Patch notes Oct 21', url: `https://pug.test/news/${id}`, footer: 'Patch notes' });
    expect(row(id)).toMatchObject({ discord_message_id: msg.id, discord_channel_id: CHANNEL, discord_state: null });

    const ed = await call('POST', `/api/admin/news/${id}`, ADMIN, { kind: 'patch', title: 'Patch notes Oct 21', body: '- Uzi back to 20 damage\n- Tank punch fix' });
    expect(ed.json().post.discord).toBe('posted');
    expect(t.live()).toHaveLength(1);
    expect(t.live()[0].payload.embeds[0].description).toContain('Tank punch fix');

    const un = (await call('POST', `/api/admin/news/${id}/unpublish`, ADMIN)).json();
    expect(un.post.discord).toBe('none');
    expect(t.live()).toHaveLength(0);
    expect(row(id)).toMatchObject({ discord_message_id: null, discord_state: null });

    const actions = (db.prepare("SELECT action FROM admin_actions WHERE target = ? ORDER BY id").all(String(id)) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['news_create', 'news_publish', 'news_update', 'news_unpublish']);
  });

  it('deleting a posted post takes the message down and then the row', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const id = await draft();
    await call('POST', `/api/admin/news/${id}/publish`, ADMIN);
    expect(t.live()).toHaveLength(1);
    const del = await call('POST', `/api/admin/news/${id}/delete`, ADMIN);
    expect(del.statusCode).toBe(200);
    expect(t.live()).toHaveLength(0);
    expect(row(id)).toBeUndefined();
    expect(del.json().posts).toEqual([]);
  });

  it('publishes without a channel, skips Discord for good, and says so', async () => {
    const id = await draft();
    const pub = (await call('POST', `/api/admin/news/${id}/publish`, ADMIN)).json();
    expect(pub.channelSet).toBe(false);
    expect(pub.post.discord).toBe('skipped');
    expect(pub.post.publishedAt).not.toBeNull();
    // Setting a channel later never floods it with old posts, edits included.
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    await call('POST', `/api/admin/news/${id}`, ADMIN, { kind: 'news', title: 'Edited', body: 'x' });
    expect(t.sends).toBe(0);
  });

  it('never fails the publish when Discord does, and the next edit retries', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const id = await draft();
    t.failSends = 1;
    const pub = await call('POST', `/api/admin/news/${id}/publish`, ADMIN);
    expect(pub.statusCode).toBe(200);
    expect(pub.json().post).toMatchObject({ discord: 'pending', discordError: 'discord down' });
    expect((await call('GET', `/api/news/${id}`)).statusCode).toBe(200);
    const ed = await call('POST', `/api/admin/news/${id}`, ADMIN, { kind: 'news', title: 'Season 1', body: 'again' });
    expect(ed.json().post).toMatchObject({ discord: 'posted', discordError: null });
    expect(t.live()).toHaveLength(1);
  });

  it('a message deleted by hand goes back up on the next edit', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const id = await draft();
    await call('POST', `/api/admin/news/${id}/publish`, ADMIN);
    const first = t.live()[0];
    await t.remove(first.channelId, first.id);
    await call('POST', `/api/admin/news/${id}`, ADMIN, { kind: 'news', title: 'Season 1', body: 'v2' });
    expect(t.live()).toHaveLength(1);
    expect(t.live()[0].id).not.toBe(first.id);
    expect(row(id)!.discord_message_id).toBe(t.live()[0].id);
  });
});

describe('news routes without a bot', () => {
  beforeEach(async () => { await app.close(); await boot(false); });

  it('publishes and leaves the post queued for when the bot connects', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const id = await draft();
    const pub = (await call('POST', `/api/admin/news/${id}/publish`, ADMIN)).json();
    expect(pub.botConnected).toBe(false);
    expect(pub.post.discord).toBe('pending');
    expect((await call('GET', `/api/news/${id}`)).statusCode).toBe(200);
  });
});
