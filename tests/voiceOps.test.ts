import { describe, it, expect } from 'vitest';
import { FakeTransport } from './fakes/fakeTransport.js';

/**
 * VoiceOps itself, direct against the fake: createMatchChannels' privateView
 * option and setMemberAccess. Plan 4c Task 1. No consumer calls either of
 * these yet (that lands in a later task), so there is nothing to test
 * through: this exercises the transport contract on its own.
 */
describe('VoiceOps: createMatchChannels privateView', () => {
  it('without opts, behaves exactly as today: @everyone can see in, only the roster connects', async () => {
    const t = new FakeTransport();
    const made = await t.voice.createMatchChannels('PUG #1', { label: 'Team A', userIds: ['1'] }, { label: 'Team B', userIds: ['2'] }, null);
    expect(t.channels.get(made.teamAId)!.privateView).toBe(false);
    expect(t.channels.get(made.teamBId)!.privateView).toBe(false);
    expect(t.channels.get(made.teamAId)!.allowed).toEqual(['1']);
  });

  it('privateView: false is the same as omitting it', async () => {
    const t = new FakeTransport();
    const made = await t.voice.createMatchChannels(
      'PUG #1', { label: 'Team A', userIds: ['1'] }, { label: 'Team B', userIds: ['2'] }, null, { privateView: false },
    );
    expect(t.channels.get(made.teamAId)!.privateView).toBe(false);
  });

  it('privateView: true records it on the created channels', async () => {
    const t = new FakeTransport();
    const made = await t.voice.createMatchChannels(
      'Booking #4', { label: 'Side A', userIds: ['1'] }, { label: 'Side B', userIds: ['2'] }, null, { privateView: true },
    );
    expect(t.channels.get(made.teamAId)!.privateView).toBe(true);
    expect(t.channels.get(made.teamBId)!.privateView).toBe(true);
    // The roster still gets in; privateView only changes who can SEE it.
    expect(t.channels.get(made.teamAId)!.allowed).toEqual(['1']);
    expect(t.channels.get(made.teamBId)!.allowed).toEqual(['2']);
  });
});

describe('VoiceOps: setMemberAccess', () => {
  it('allow: true adds the member to the channel', async () => {
    const t = new FakeTransport();
    const made = await t.voice.createMatchChannels(
      'Booking #4', { label: 'Side A', userIds: [] }, { label: 'Side B', userIds: [] }, null, { privateView: true },
    );
    await t.voice.setMemberAccess(made.teamAId, 'caster1', true);
    expect(t.channels.get(made.teamAId)!.allowed).toEqual(['caster1']);
  });

  it('allow: true is a no-op when the member already has access', async () => {
    const t = new FakeTransport();
    const made = await t.voice.createMatchChannels(
      'Booking #4', { label: 'Side A', userIds: ['1'] }, { label: 'Side B', userIds: [] }, null, { privateView: true },
    );
    await t.voice.setMemberAccess(made.teamAId, '1', true);
    expect(t.channels.get(made.teamAId)!.allowed).toEqual(['1']);
  });

  it('allow: false removes the member', async () => {
    const t = new FakeTransport();
    const made = await t.voice.createMatchChannels(
      'Booking #4', { label: 'Side A', userIds: ['1', '2'] }, { label: 'Side B', userIds: [] }, null, { privateView: true },
    );
    await t.voice.setMemberAccess(made.teamAId, '1', false);
    expect(t.channels.get(made.teamAId)!.allowed).toEqual(['2']);
  });

  it('allow: false on someone with no access is a no-op', async () => {
    const t = new FakeTransport();
    const made = await t.voice.createMatchChannels(
      'Booking #4', { label: 'Side A', userIds: [] }, { label: 'Side B', userIds: [] }, null, { privateView: true },
    );
    await expect(t.voice.setMemberAccess(made.teamAId, 'nobody', false)).resolves.toBeUndefined();
    expect(t.channels.get(made.teamAId)!.allowed).toEqual([]);
  });

  it('ignores an unknown channel rather than throwing', async () => {
    const t = new FakeTransport();
    await expect(t.voice.setMemberAccess('no-such-channel', '1', true)).resolves.toBeUndefined();
    await expect(t.voice.setMemberAccess('no-such-channel', '1', false)).resolves.toBeUndefined();
  });
});
