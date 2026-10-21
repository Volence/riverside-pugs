import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import {
  duoQueueLive, partnerOf, createDuoInvite, acceptDuoInvite, declineDuoInvite, cancelDuoInvite,
  endDuo, openDuoInvites, getDuoInvite, pairsAmong, DUO_INVITE_MS,
} from '../src/duos.js';

const [A, B, C] = ['76561198000000001', '76561198000000002', '76561198000000003'];
let db: DB;
const T0 = new Date('2026-11-03T20:00:00Z');

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [A, B, C]) { upsertPlayer(db, { steamid: id, name: `n${id.slice(-1)}`, avatar: null }, []); activatePlayer(db, id); }
  db.prepare('UPDATE seasons SET ranks = 1').run();
});

const invite = (from: string, to: string, now = T0) => {
  const r = createDuoInvite(db, from, to, 'site', now);
  if (!r.ok) throw new Error(r.error);
  return r.inviteId;
};

describe('duoQueueLive', () => {
  it('is on with Season 1 and the switch, off without either', () => {
    expect(duoQueueLive(db)).toBe(true);
    setSetting(db, 'duo_queue_enabled', '0');
    expect(duoQueueLive(db)).toBe(false);
    setSetting(db, 'duo_queue_enabled', '1');
    db.prepare('UPDATE seasons SET ranks = 0').run();
    expect(duoQueueLive(db)).toBe(false);
  });
});

describe('invites and duos', () => {
  it('accepting forms the duo both ways and closes every other open invite of either player', () => {
    const ab = invite(A, B);
    const cb = invite(C, B);
    expect(acceptDuoInvite(db, ab, B, T0)).toEqual({ ok: true });
    expect(partnerOf(db, A)).toBe(B);
    expect(partnerOf(db, B)).toBe(A);
    expect(getDuoInvite(db, ab)!.outcome).toBe('accepted');
    expect(getDuoInvite(db, cb)!.outcome).toBe('void');
  });

  it('only the invitee may accept or decline, only the sender may cancel', () => {
    const ab = invite(A, B);
    expect(acceptDuoInvite(db, ab, C, T0).ok).toBe(false);
    expect(declineDuoInvite(db, ab, A, T0).ok).toBe(false);
    expect(cancelDuoInvite(db, ab, B, T0).ok).toBe(false);
    expect(cancelDuoInvite(db, ab, A, T0)).toEqual({ ok: true });
    expect(acceptDuoInvite(db, ab, B, T0).ok).toBe(false);
  });

  it('an invite expires after 10 minutes', () => {
    const ab = invite(A, B);
    const late = new Date(T0.getTime() + DUO_INVITE_MS + 1);
    expect(acceptDuoInvite(db, ab, B, late)).toEqual({ ok: false, error: 'that invite is no longer open' });
    expect(openDuoInvites(db, B, late).incoming).toEqual([]);
  });

  it('a second invite from the same sender replaces the first', () => {
    const ab = invite(A, B);
    invite(A, C);
    expect(getDuoInvite(db, ab)!.outcome).toBe('replaced');
    expect(openDuoInvites(db, A, T0).outgoing!.toId).toBe(C);
  });

  it('refuses yourself, a player already in a duo, and an unknown player', () => {
    expect(createDuoInvite(db, A, A, 'site', T0)).toEqual({ ok: false, error: 'you cannot duo with yourself' });
    acceptDuoInvite(db, invite(A, B), B, T0);
    expect(createDuoInvite(db, C, A, 'site', T0)).toEqual({ ok: false, error: 'that player is already in a duo' });
    expect(createDuoInvite(db, A, C, 'site', T0)).toEqual({ ok: false, error: 'you are already in a duo; end it first' });
    expect(createDuoInvite(db, C, '76561198000000099', 'site', T0)).toEqual({ ok: false, error: 'that player cannot queue' });
  });

  it('endDuo ends it for both', () => {
    acceptDuoInvite(db, invite(A, B), B, T0);
    expect(endDuo(db, B, B, T0)).toEqual({ ok: true });
    expect(partnerOf(db, A)).toBeNull();
    expect(endDuo(db, B, B, T0)).toEqual({ ok: false, error: 'you are not in a duo' });
  });
});

describe('pairsAmong', () => {
  it('lists each pair once, only when both are present', () => {
    const p = (id: string) => ({ a: 'b', b: 'a', c: 'x' } as Record<string, string>)[id] ?? null;
    expect(pairsAmong(['a', 'c', 'b', 'd'], p)).toEqual([['a', 'b']]);
  });
});
