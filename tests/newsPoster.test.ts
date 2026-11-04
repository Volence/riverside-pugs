import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { createNews, deleteNews, plainExcerpt, publishNews, unpublishNews, updateNews } from '../src/news.js';
import { NewsPoster } from '../src/discord/newsPoster.js';
import { discordBody, newsPayloads, splitMessages } from '../src/discord/newsCard.js';
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
    expect(t.live().map((m) => m.payload.content!.split('\n')[0])).toEqual(['# A']);

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
    expect(t.live().map((m) => m.payload.content!.split('\n')[0])).toEqual(['# A2']);
    expect(t.sends).toBe(1);
  });
});

describe('NewsPoster with a split post', () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => `- line ${i} of the long post`).join('\n');
  const ids = (id: number) => db.prepare('SELECT discord_message_id, discord_extra_ids FROM news_posts WHERE id = ?').get(id) as { discord_message_id: string; discord_extra_ids: string | null };

  it('sends every part in order, edits them in place, and takes them all down', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const a = createNews(db, ADMIN, { kind: 'news', title: 'A', body: long(150) });
    publishNews(db, a.id);
    await poster.sync(a.id);
    const n = t.live().length;
    expect(n).toBeGreaterThan(1);
    expect(JSON.parse(ids(a.id).discord_extra_ids!)).toHaveLength(n - 1);
    const sends = t.sends;

    updateNews(db, a.id, { kind: 'news', title: 'A2', body: long(150) });
    await poster.sync(a.id);
    expect(t.sends).toBe(sends);
    expect(t.live()[0]!.payload.content!.startsWith('# A2')).toBe(true);

    updateNews(db, a.id, { kind: 'news', title: 'A3', body: 'short now' });
    await poster.sync(a.id);
    expect(t.sends).toBe(sends);
    expect(t.live()).toHaveLength(1);
    expect(ids(a.id).discord_extra_ids).toBeNull();

    updateNews(db, a.id, { kind: 'news', title: 'A4', body: long(150) });
    await poster.sync(a.id);
    expect(t.live()).toHaveLength(n);
    expect(t.live()[0]!.payload.content!.startsWith('# A4')).toBe(true);

    deleteNews(db, a.id);
    await poster.sync(a.id);
    expect(t.live()).toHaveLength(0);
  });

  it('takes down the parts already sent when a later one fails, and sends it whole next pass', async () => {
    setSetting(db, 'discord_news_channel_id', CHANNEL);
    const a = createNews(db, ADMIN, { kind: 'news', title: 'A', body: long(150) });
    publishNews(db, a.id);
    const realSend = t.send.bind(t);
    let calls = 0;
    t.send = async (c, p) => { if (++calls === 2) throw new Error('discord down'); return realSend(c, p); };
    await poster.sync(a.id);
    expect(t.live()).toHaveLength(0);
    expect(state(a.id)).toMatchObject({ discord_state: 'pending' });
    t.send = realSend;
    await poster.sync();
    expect(t.live().length).toBeGreaterThan(1);
    expect(state(a.id)).toMatchObject({ discord_state: null });
  });
});

describe('the news card', () => {
  it('posts a plain message with the title as a heading, links the post, and pings nobody', () => {
    const [p, more] = newsPayloads({ id: 7, kind: 'patch', title: 'Patch notes Oct 21', body: '## Fixes\n- one' }, 'https://pug.test');
    expect(more).toBeUndefined();
    expect(p!.content).toBe('# Patch notes Oct 21\n-# Patch notes\n\n## Fixes\n- one');
    expect(p!.embeds).toEqual([]);
    expect(p!.components[0]![0]).toEqual({ kind: 'link', url: 'https://pug.test/news/7', label: 'Read on the site' });
    expect(p!.mentionUserIds).toEqual([]);
    expect(p!.mentionRoleIds).toEqual([]);
    expect(newsPayloads({ id: 1, kind: 'news', title: 'x', body: '' }, 'https://pug.test')[0]!.content).toBe('# x\n-# News');
  });

  it('splits a long post over several messages, a section at a time, with the button on the last', () => {
    const section = (n: number) => `## Part ${n}\n${Array.from({ length: 40 }, (_, i) => `- point ${n}.${i}`).join('\n')}`;
    const body = [1, 2, 3, 4].map(section).join('\n\n');
    const ps = newsPayloads({ id: 1, kind: 'news', title: 'Season', body }, 'https://pug.test');
    expect(ps.length).toBeGreaterThan(1);
    for (const p of ps) expect(p.content!.length).toBeLessThanOrEqual(2000);
    expect(ps.slice(1).every((p) => p.content!.startsWith('## Part'))).toBe(true);
    expect(ps.map((p) => p.components.length)).toEqual([...ps.slice(1).map(() => 0), 1]);
    expect(ps.map((p) => p.content).join('\n\n')).toBe(`# Season\n-# News\n\n${body}`);
  });

  it('stops at five messages and points to the site', () => {
    const body = Array.from({ length: 2000 }, (_, i) => `- line ${i}`).join('\n');
    const ps = newsPayloads({ id: 1, kind: 'news', title: 'T', body }, 'https://pug.test');
    expect(ps).toHaveLength(5);
    expect(ps[4]!.content!.length).toBeLessThanOrEqual(2000);
    expect(ps[4]!.content!.endsWith('*Read the rest on the site.*')).toBe(true);
  });

  it('keeps headings with nothing between them in the same message', () => {
    const text = `${'a '.repeat(700)}\n\n## Other updates\n\n## Finales\n\n${'b '.repeat(400)}`;
    const [first, second] = splitMessages(text);
    expect(first!.endsWith('a')).toBe(true);
    expect(second!.startsWith('## Other updates\n\n## Finales')).toBe(true);
  });

  it('splitMessages never loses text and cuts a run with no break at the limit', () => {
    const run = 'x'.repeat(4500);
    expect(splitMessages(run).map((p) => p.length)).toEqual([2000, 2000, 500]);
  });

  it('wraps link targets so Discord shows no preview', () => {
    expect(discordBody('from https://a.com/x#pack. Then [here](https://b.com) and <https://c.com>'))
      .toBe('from <https://a.com/x#pack>. Then [here](<https://b.com/>) and <https://c.com>');
  });

  it('drops links that are not http or https and keeps their text', () => {
    expect(discordBody('[ok](https://a.com/x) [bad](javascript:void) [ftp](ftp://x)')).toBe('[ok](<https://a.com/x>) bad ftp');
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
