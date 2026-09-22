import { describe, it, expect, beforeEach } from 'vitest';
import { FakeTransport } from './fakes/fakeTransport.js';
import type { InboundMessage } from '../src/discord/transport.js';

const card = (content: string) => ({ content, embeds: [], components: [] });
let t: FakeTransport;
let thread: string;
let heard: string[];

beforeEach(async () => {
  t = new FakeTransport();
  thread = (await t.threads.createForumPost('forum1', { name: 'x', message: card('the card'), tags: [] })).threadId;
  heard = [];
  t.watchMessages({
    watches: (id) => id === thread,
    create: (m) => heard.push(`create ${m.content}`),
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
    expect(heard).toEqual([]);
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
