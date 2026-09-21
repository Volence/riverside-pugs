import { describe, it, expect, beforeEach } from 'vitest';
import { FakeTransport } from './fakes/fakeTransport.js';

const card = (content: string) => ({ content, embeds: [], components: [] });
let t: FakeTransport;
beforeEach(() => { t = new FakeTransport(); });

describe('FakeTransport threads', () => {
  it('a forum post starts with a message whose id is the thread id, and that message can be edited', async () => {
    const made = await t.threads.createForumPost('forum1', { name: '#1 Walls (cheating)', message: card('card v1'), tags: ['open', 'cheating'] });
    expect(made.messageId).toBe(made.threadId);
    expect(/^\d+$/.test(made.threadId)).toBe(true);
    expect(t.threadsIn('forum1').map((th) => [th.name, th.tags])).toEqual([['#1 Walls (cheating)', ['open', 'cheating']]]);
    expect(await t.edit(made.threadId, made.messageId, card('card v2'))).toBe(true);
    expect(t.byId(made.messageId)?.payload.content).toBe('card v2');
  });

  it('an archived thread refuses a send and an edit until it is unarchived', async () => {
    const { threadId } = await t.threads.createPrivateThread('chan1', { name: 'Ticket #2' });
    await t.threads.setLocked(threadId, true);
    await t.threads.setArchived(threadId, true);
    await expect(t.send(threadId, card('late'))).rejects.toThrow(/archived/i);
    await t.threads.setArchived(threadId, false);
    await expect(t.send(threadId, card('now'))).resolves.toBeTruthy();
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: true, archived: false, surface: 'private' });
  });

  it('members are explicit, and someone outside the server cannot be added', async () => {
    const { threadId } = await t.threads.createPrivateThread('chan1', { name: 'Ticket #3' });
    t.notInGuild.add('999');
    await t.threads.addMember(threadId, '901');
    await expect(t.threads.addMember(threadId, '999')).rejects.toThrow();
    await t.threads.addMember(threadId, '902');
    await t.threads.removeMember(threadId, '901');
    expect(await t.threads.memberIds(threadId)).toEqual(['902']);
  });

  it('a deleted thread is gone for every question asked of it', async () => {
    const { threadId } = await t.threads.createPrivateThread('chan1', { name: 'Ticket #4' });
    expect(await t.threads.exists(threadId)).toBe(true);
    await t.threads.deleteThread(threadId);
    await t.threads.deleteThread(threadId);
    expect(await t.threads.exists(threadId)).toBe(false);
    expect(await t.threads.memberIds(threadId)).toBeNull();
    await expect(t.send(threadId, card('x'))).rejects.toThrow();
  });

  it('channel access converges on the wanted set and reports who could not be added', async () => {
    t.notInGuild.add('999');
    expect(await t.threads.syncMemberAccess('forum1', ['901', '902', '999'])).toEqual({ added: ['901', '902'], removed: [], failed: ['999'] });
    expect(await t.threads.syncMemberAccess('forum1', ['902', '903'])).toEqual({ added: ['903'], removed: ['901'], failed: [] });
    expect([...t.channelAccess.get('forum1')!].sort()).toEqual(['902', '903']);
  });

  it('failThreadOps makes the next thread calls throw, as an outage would', async () => {
    t.failThreadOps = 1;
    await expect(t.threads.createForumPost('forum1', { name: 'x', message: card('x'), tags: [] })).rejects.toThrow(/discord down/);
    await expect(t.threads.createForumPost('forum1', { name: 'x', message: card('x'), tags: [] })).resolves.toBeTruthy();
  });
});
