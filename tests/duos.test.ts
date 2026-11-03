import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import {
  duoQueueLive, partnerOf, createDuoInvite, acceptDuoInvite, declineDuoInvite, cancelDuoInvite,
  endDuo, openDuoInvites, getDuoInvite, pairsAmong, DUO_INVITE_MS,
  blockFromDuo, liftDuoBlock, activeDuoBlock,
} from '../src/duos.js';

const [A, B, C] = ['76561198000000001', '76561198000000002', '76561198000000003'];
const STAFF = '76561198000000009';
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

const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

describe('decline cooldown (owner 2026-11-03)', () => {
  it('stops the inviter asking again for an hour, one way only', () => {
    declineDuoInvite(db, invite(A, B), B, T0);
    expect(createDuoInvite(db, A, B, 'site', at(1))).toEqual({
      ok: false, error: 'that player declined your last invite; try again in 60 minutes',
    });
    expect(createDuoInvite(db, A, B, 'site', at(59 * MIN + 30_000))).toEqual({
      ok: false, error: 'that player declined your last invite; try again in 1 minute',
    });
    // The one who declined may ask back at once, in case it was a slip.
    expect(createDuoInvite(db, B, A, 'site', at(1)).ok).toBe(true);
  });

  it('lifts after the hour', () => {
    declineDuoInvite(db, invite(A, B), B, T0);
    expect(createDuoInvite(db, A, B, 'site', at(60 * MIN)).ok).toBe(true);
  });

  it('does not stop the inviter asking someone else', () => {
    declineDuoInvite(db, invite(A, B), B, T0);
    expect(createDuoInvite(db, A, C, 'site', at(1)).ok).toBe(true);
  });

  it('is over once the decliner has asked back', () => {
    declineDuoInvite(db, invite(A, B), B, T0);
    cancelDuoInvite(db, invite(B, A, at(MIN)), B, at(MIN));
    expect(createDuoInvite(db, A, B, 'site', at(2 * MIN)).ok).toBe(true);
  });
});

describe('invite cap (owner 2026-11-03)', () => {
  it('refuses a sixth invite in a rolling hour, whatever became of the five', () => {
    for (let i = 0; i < 5; i++) invite(A, i % 2 ? B : C, at(i * MIN));
    expect(createDuoInvite(db, A, B, 'site', at(10 * MIN))).toEqual({
      ok: false, error: 'you have sent 5 duo invites in the last hour; try again in 50 minutes',
    });
    // The first ages out at T0 + 60 min, making room for one more.
    expect(createDuoInvite(db, A, B, 'site', at(60 * MIN - 1)).ok).toBe(false);
    expect(createDuoInvite(db, A, B, 'site', at(60 * MIN)).ok).toBe(true);
    expect(createDuoInvite(db, A, B, 'site', at(60 * MIN + 1)).ok).toBe(false);
  });

  it('counts only the sender', () => {
    for (let i = 0; i < 5; i++) invite(A, B, at(i));
    expect(createDuoInvite(db, B, A, 'site', at(10)).ok).toBe(true);
  });
});

describe('duo blocks (owner 2026-11-03)', () => {
  it('refuses the blocked player sending, being invited and accepting, naming the block only to them', () => {
    const open = invite(B, A);
    blockFromDuo(db, A, STAFF, 'griefing duos', 60, T0);
    expect(getDuoInvite(db, open)!.outcome).toBe('void');
    expect(createDuoInvite(db, A, B, 'site', at(1))).toEqual({ ok: false, error: 'you are blocked from duo queue until 2026-11-03 21:00 UTC' });
    expect(createDuoInvite(db, B, A, 'site', at(1))).toEqual({ ok: false, error: 'that player cannot duo right now' });
    // An invite sent before the block, made after it by the database alone.
    const id = Number(db.prepare("INSERT INTO duo_invites (from_id, to_id, source, created_at) VALUES (?, ?, 'site', ?)")
      .run(C, A, at(1).toISOString()).lastInsertRowid);
    expect(acceptDuoInvite(db, id, A, at(2))).toEqual({ ok: false, error: 'you are blocked from duo queue until 2026-11-03 21:00 UTC' });
    const fromA = Number(db.prepare("INSERT INTO duo_invites (from_id, to_id, source, created_at) VALUES (?, ?, 'site', ?)")
      .run(A, C, at(1).toISOString()).lastInsertRowid);
    expect(acceptDuoInvite(db, fromA, C, at(2))).toEqual({ ok: false, error: 'that player cannot duo right now' });
  });

  it('a permanent block says so', () => {
    blockFromDuo(db, A, STAFF, 'x', null, T0);
    expect(createDuoInvite(db, A, B, 'site', at(1))).toEqual({ ok: false, error: 'you are blocked from duo queue permanently' });
    expect(activeDuoBlock(db, A, at(365 * 24 * 60 * MIN))?.expiresAt).toBeNull();
  });

  it('ends when lifted or when it runs out', () => {
    blockFromDuo(db, A, STAFF, 'x', 60, T0);
    expect(activeDuoBlock(db, A, at(1))).toMatchObject({ reason: 'x', createdBy: STAFF });
    expect(activeDuoBlock(db, A, at(60 * MIN))).toBeNull();
    expect(createDuoInvite(db, A, B, 'site', at(60 * MIN)).ok).toBe(true);

    blockFromDuo(db, C, STAFF, 'y', null, T0);
    expect(liftDuoBlock(db, C, STAFF, at(1))).toBe(true);
    expect(liftDuoBlock(db, C, STAFF, at(2))).toBe(false);
    expect(activeDuoBlock(db, C, at(2))).toBeNull();
    expect(createDuoInvite(db, C, B, 'site', at(2)).ok).toBe(true);
  });
});

describe('pairsAmong', () => {
  it('lists each pair once, only when both are present', () => {
    const p = (id: string) => ({ a: 'b', b: 'a', c: 'x' } as Record<string, string>)[id] ?? null;
    expect(pairsAmong(['a', 'c', 'b', 'd'], p)).toEqual([['a', 'b']]);
  });
});
