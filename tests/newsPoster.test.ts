import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { createNews, deleteNews, plainExcerpt, publishNews, unpublishNews, updateNews } from '../src/news.js';
import { NewsPoster } from '../src/discord/newsPoster.js';
import { discordBody, newsPayload } from '../src/discord/newsCard.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const ADMIN = '76561199000000830';
const CHANNEL = 'news-channel';
let db: DB;
let t: FakeTransport;
let poster: NewsPoster;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO players (steamid, name, status, is_admin) VALUES (?, 'Boss', 'active', 1)").run(ADMIN);
  t = new FakeTransport();
  poster = new NewsPoster({ db, transport: t, publicUrl: 'https://pug.test', tickMs: 0 });
});

const state = (id: number) => db.prepare('SELECT discord_state, discord_message_id, deleted_at FROM news_posts WHERE id = ?').get(id);

describe('NewsPoster', () => {
  it('catches up on start: posts what was published while the bot was down, and removes what was deleted', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const a = createNews(db, ADMIN, { kind: 'news', title: 'A', body: 'a' });
    publishNews(db, a.id);
    poster.start();
    await poster.idle();
    expect(t.live().map((m) => m.payload.embeds[0].title)).toEqual(['A']);

    deleteNews(db, a.id);
    expect(state(a.id)).toMatchObject({ discord_state: 'remove' });
    await poster.sync();
    expect(t.live()).toHaveLength(0);
    expect(state(a.id)).toBeUndefined();
  });

  it('marks a pending post skipped when the channel was cleared before it went out', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const a = createNews(db, ADMIN, { kind: 'news', title: 'A', body: 'a' });
    publishNews(db, a.id);
    setSetting(db, 'discord_news_channel_id', '');
    await poster.sync(a.id);
    expect(state(a.id)).toMatchObject({ discord_state: 'skipped', discord_message_id: null });
    expect(t.sends).toBe(0);
  });

  it('keeps a failed removal queued and tries again', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const a = createNews(db, ADMIN, { kind: 'news', title: 'A', body: 'a' });
    publishNews(db, a.id);
    await poster.sync(a.id);
    unpublishNews(db, a.id);
    const realRemove = t.remove.bind(t);
    t.remove = async () => { throw new Error('missing permissions'); };
    await poster.sync(a.id);
    expect(state(a.id)).toMatchObject({ discord_state: 'remove' });
    expect(t.live()).toHaveLength(1);
    t.remove = realRemove;
    await poster.sync();
    expect(t.live()).toHaveLength(0);
    expect(state(a.id)).toMatchObject({ discord_state: null, discord_message_id: null });
  });

  it('republishing while the removal is still queued edits the message back instead of posting a second one', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const a = createNews(db, ADMIN, { kind: 'news', title: 'A', body: 'a' });
    publishNews(db, a.id);
    await poster.sync(a.id);
    unpublishNews(db, a.id);
    publishNews(db, a.id);
    updateNews(db, a.id, { kind: 'news', title: 'A2', body: 'a' });
    await poster.sync(a.id);
    expect(t.live().map((m) => m.payload.embeds[0].title)).toEqual(['A2']);
    expect(t.sends).toBe(1);
  });
});

describe('the news card', () => {
  it('labels patch notes, links the post, and pings nobody', () => {
    const p = newsPayload({ id: 7, kind: 'patch', title: 'Patch notes Oct 21', body: '## Fixes\n- one' }, 'https://pug.test');
    expect(p.embeds[0]).toMatchObject({ title: 'Patch notes Oct 21', url: 'https://pug.test/news/7', footer: 'Patch notes', description: '**Fixes**\n- one' });
    expect(p.components[0][0]).toEqual({ kind: 'link', url: 'https://pug.test/news/7', label: 'Read on the site' });
    expect(p.mentionUserIds).toEqual([]);
    expect(p.mentionRoleIds).toEqual([]);
    expect(p.content).toBeUndefined();
    expect(newsPayload({ id: 1, kind: 'news', title: 'x', body: '' }, 'https://pug.test').embeds[0].footer).toBe('News');
  });

  it('drops links that are not http or https and keeps their text', () => {
    expect(discordBody('[ok](https://a.com/x) [bad](javascript:void) [ftp](ftp://x)')).toBe('[ok](https://a.com/x) bad ftp');
    expect(discordBody('[bad](javascript:alert(1))')).not.toContain('javascript');
  });

  it('trims a long body at a line break with a pointer to the site', () => {
    const body = Array.from({ length: 200 }, (_, i) => `- line ${i}`).join('\n');
    const out = discordBody(body, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('*Read the rest on the site.*')).toBe(true);
    expect(out).toContain('- line 0');
  });
});

describe('plainExcerpt', () => {
  it('takes the markup out and cuts at a word', () => {
    expect(plainExcerpt('## Head\n**Bold** and *it* [link](https://x.com)\n- item')).toBe('Head Bold and it link item');
    const long = plainExcerpt('word '.repeat(100), 30);
    expect(long.endsWith('...')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(33);
  });
});
