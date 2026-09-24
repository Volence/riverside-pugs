import { describe, it, expect, beforeEach } from 'vitest';
import { FakeTransport } from './fakes/fakeTransport.js';
import type { InboundMessage } from '../src/discord/transport.js';

const card = (content: string) => ({ content, embeds: [], components: [] });
let t: FakeTransport;
let thread: string;
let heard: string[];
let created: InboundMessage[];

beforeEach(async () => {
  t = new FakeTransport();
  thread = (await t.threads.createForumPost('forum1', { name: 'x', message: card('the card'), tags: [] })).threadId;
  heard = [];
  created = [];
  t.watchMessages({
    watches: (id) => id === thread,
    create: (m) => { created.push(m); heard.push(`create${m.authorIsBot ? ' (bot)' : ''} ${m.content}`); },
    update: (m) => heard.push(`update ${m.content}`),
    remove: (_thread, id) => heard.push(`remove ${id}`),
  });
});

describe('FakeTransport messages', () => {
  it('delivers create, update and delete for a watched thread, and nothing at all for any other', () => {
    const m = t.userPost(thread, { authorId: '901', content: 'hello' });
    t.userEdit(m.id, 'hello again');
    t.userDelete(m.id);
    const other = t.userPost('general', { authorId: '901', content: 'not a ticket' });
    t.userEdit(other.id, 'still not');
    t.userDelete(other.id);
    expect(heard).toEqual(['create hello', 'update hello again', `remove ${m.id}`]);
  });

  it('history comes back oldest first, a page at a time, bot messages included, deleted ones not', async () => {
    t.fetchPageSize = 2;
    const a = t.userPost(thread, { authorId: '901', content: 'one' }, false);
    const b = t.userPost(thread, { authorId: '902', content: 'two' }, false);
    const c = t.userPost(thread, { authorId: '901', content: 'three' }, false);
    t.userDelete(b.id, false);
    await t.send(thread, card('a line from the bot'));
    // Nothing the bot was offline for was delivered. Its own send is, which
    // is the next test.
    expect(heard).toEqual(['create (bot) a line from the bot']);
    const first = await t.threads.fetchAfter(thread, null);
    // The card has the thread's own id, the smallest there is.
    expect(first.map((m: InboundMessage) => [m.content, m.authorIsBot])).toEqual([['the card', true], ['one', false]]);
    const second = await t.threads.fetchAfter(thread, first[1].id);
    expect(second.map((m) => m.content)).toEqual(['three', 'a line from the bot']);
    expect(await t.threads.fetchAfter(thread, second[1].id)).toEqual([]);
    expect((await t.threads.fetchMessage(thread, a.id))?.content).toBe('one');
    expect(await t.threads.fetchMessage(thread, b.id)).toBeNull();
    expect(c.id > a.id).toBe(true);
  });

  it('echoes the bot\'s own send and its own delete back through the hooks, as Discord does', async () => {
    const id = await t.send(thread, card('a line from the bot'));
    expect(heard).toEqual(['create (bot) a line from the bot']);
    expect(created[0]).toMatchObject({ id, threadId: thread, authorId: t.botUserId, authorIsBot: true, attachments: [] });
    await t.remove(thread, id);
    expect(heard).toEqual(['create (bot) a line from the bot', `remove ${id}`]);
    // Nothing left to announce the second time, as Discord has nothing to
    // delete: the mirror still has to survive hearing its own Remove once.
    await t.remove(thread, id);
    expect(heard).toHaveLength(2);
    // And nothing at all in a channel the hooks do not watch.
    const elsewhere = await t.send('general', card('not a ticket'));
    await t.remove('general', elsewhere);
    expect(heard).toHaveLength(2);
  });

  it('contains a throwing hook instead of failing the write that triggered it', async () => {
    t.watchMessages({
      watches: () => true,
      create: () => { throw new Error('mirror is down'); },
      update: () => { throw new Error('mirror is down'); },
      remove: () => { throw new Error('mirror is down'); },
    });
    const m = t.userPost(thread, { authorId: '901', content: 'hello' });
    expect(() => t.userEdit(m.id, 'hello again')).not.toThrow();
    expect(() => t.userDelete(m.id)).not.toThrow();
    const id = await t.send(thread, card('a line from the bot'));
    await t.remove(thread, id);
    // Everything the hooks could not take is still recorded.
    expect(t.inbox[0]).toMatchObject({ content: 'hello again', deleted: true });
    expect(t.byId(id)?.deleted).toBe(true);
    expect(t.hookErrors).toHaveLength(5);
    // A watches() that throws is contained the same way: it is a database
    // read, and a locked database must not stop the bot.
    t.watchMessages({ watches: () => { throw new Error('database is locked'); }, create: () => {}, update: () => {}, remove: () => {} });
    expect(() => t.userPost(thread, { authorId: '901', content: 'later' })).not.toThrow();
    expect(t.hookErrors).toHaveLength(6);
  });

  it('remove deletes a person\'s message, and an archived thread refuses it', async () => {
    const m = t.userPost(thread, { authorId: '901', content: 'gone soon' });
    await t.threads.setArchived(thread, true);
    await expect(t.remove(thread, m.id)).rejects.toThrow(/archived/i);
    await t.threads.setArchived(thread, false);
    await t.remove(thread, m.id);
    await t.remove(thread, m.id);
    expect(await t.threads.fetchMessage(thread, m.id)).toBeNull();
  });
});
