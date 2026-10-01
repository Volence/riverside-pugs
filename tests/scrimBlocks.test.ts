import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { createTeam, invitePlayer, leaveTeam, respondInvite, setRole } from '../src/teams/teams.js';
import { confirmBooking, createBooking, getBooking } from '../src/bookings/bookings.js';
import { acceptPost, createPost } from '../src/scrims/scrims.js';
import { BLOCK_MAX, blocked, blocksOf, blockTarget, scrimBlocksOf, unblock, type BlockResult } from '../src/scrims/blocks.js';
import { mergePlayers } from '../src/mergePlayers.js';

const P = Array.from({ length: 12 }, (_, i) => `765611990000011${String(i).padStart(2, '0')}`);
const MIN = 60_000;
const NOW = new Date('2026-10-01T12:00:00.000Z');
const START = '2026-10-02T20:00:00.000Z';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll', 'dead_air']));
  for (const n of ['a', 'bb', 'ccc', 'dddd']) {
    const id = addServer(db, { name: n, host: 'h', port: 27000 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});

const team = (captain: string, name: string, tag: string, members: string[] = []): number => {
  const t = createTeam(db, { creator: captain, name, tag, now: NOW });
  if (!t.ok) throw new Error(t.error);
  for (const m of members) {
    const inv = invitePlayer(db, { teamId: t.value.id, by: captain, target: m, now: NOW });
    if (!inv.ok) throw new Error(inv.error);
    respondInvite(db, { inviteId: inv.value.inviteId, steamid: m, accept: true, now: NOW });
  }
  return t.value.id;
};
const value = <T>(r: BlockResult<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const err = <T>(r: BlockResult<T>): string => (r.ok ? 'ok' : r.error);
const block = (by: string, party: { teamId: number } | { captain: string }, target: unknown, now = NOW) =>
  value(blockTarget(db, { by, party, target, now }));
const post = (by: string, over: Record<string, unknown> = {}): number => {
  const r = createPost(db, { by, startsAt: START, minutes: 120, campaigns: ['no_mercy'], srRange: null, note: '', now: NOW, ...over });
  if (!r.ok) throw new Error(r.error);
  return r.value.id;
};
const accept = (postId: number, by: string, over: Record<string, unknown> = {}): number => {
  const r = acceptPost(db, { postId, by, now: NOW, ...over });
  if (!r.ok) throw new Error(r.error);
  return r.value.id;
};
const status = (table: 'scrim_posts' | 'scrim_accepts', id: number) =>
  (db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string }).status;

describe('the table', () => {
  it('holds exactly one blocker and one target, and a pair once per blocker', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const ins = db.prepare(`INSERT INTO scrim_blocks (blocker_team_id, blocker_steamid, target_team_id, target_steamid, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const t = NOW.toISOString();
    expect(() => ins.run(rats, P[0], null, P[1], P[0], t)).toThrow();
    expect(() => ins.run(null, null, null, P[1], P[0], t)).toThrow();
    expect(() => ins.run(rats, null, rats, P[1], P[0], t)).toThrow();
    expect(() => ins.run(rats, null, null, null, P[0], t)).toThrow();
    ins.run(rats, null, null, P[1], P[0], t);
    expect(() => ins.run(rats, null, null, P[1], P[0], t)).toThrow(/UNIQUE/);
    ins.run(null, P[0], null, P[1], P[0], t);
    expect(() => ins.run(null, P[0], null, P[1], P[0], t)).toThrow(/UNIQUE/);
  });
});

describe('blocked', () => {
  it('a team block on a team works in both directions', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const cats = team(P[1], 'Cats', 'CC');
    const dogs = team(P[2], 'Dogs', 'DD');
    expect(blocked(db, { teamId: rats }, { teamId: cats })).toBe(false);
    block(P[0], { teamId: rats }, { teamId: cats });
    expect(blocked(db, { teamId: rats }, { teamId: cats })).toBe(true);
    expect(blocked(db, { teamId: cats }, { teamId: rats })).toBe(true);
    expect(blocked(db, { teamId: rats }, { teamId: dogs })).toBe(false);
    expect(blocked(db, { teamId: cats }, { teamId: dogs })).toBe(false);
  });

  it('a pickup captain blocking a team works in both directions', () => {
    const cats = team(P[1], 'Cats', 'CC');
    block(P[0], { captain: P[0] }, { teamId: cats });
    expect(blocked(db, { captain: P[0] }, { teamId: cats })).toBe(true);
    expect(blocked(db, { teamId: cats }, { captain: P[0] })).toBe(true);
    expect(blocked(db, { captain: P[3] }, { teamId: cats })).toBe(false);
  });

  it('a player block matches a pickup they captain and a team they captain or co-captain', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const capt = team(P[5], 'Capt', 'CP');
    const co = team(P[6], 'CoCo', 'CO', [P[5]]);
    setRole(db, { teamId: co, by: P[6], target: P[5], role: 'cocaptain' });
    block(P[0], { teamId: rats }, { steamid: P[5] });
    expect(blocked(db, { teamId: rats }, { captain: P[5] })).toBe(true);
    expect(blocked(db, { captain: P[5] }, { teamId: rats })).toBe(true);
    expect(blocked(db, { teamId: rats }, { teamId: capt })).toBe(true);
    expect(blocked(db, { teamId: co }, { teamId: rats })).toBe(true);
    expect(blocked(db, { teamId: rats }, { captain: P[6] })).toBe(false);
  });

  it('a player block does not match a team where they are a plain member', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const cats = team(P[1], 'Cats', 'CC', [P[5]]);
    block(P[0], { captain: P[0] }, { steamid: P[5] });
    expect(blocked(db, { captain: P[0] }, { teamId: cats })).toBe(false);
    block(P[0], { teamId: rats }, { steamid: P[5] });
    expect(blocked(db, { teamId: rats }, { teamId: cats })).toBe(false);
  });

  it('once they leave the team, a player block no longer matches it', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const cats = team(P[1], 'Cats', 'CC', [P[5], P[6]]);
    setRole(db, { teamId: cats, by: P[1], target: P[5], role: 'cocaptain' });
    block(P[0], { teamId: rats }, { steamid: P[5] });
    expect(blocked(db, { teamId: rats }, { teamId: cats })).toBe(true);
    leaveTeam(db, { teamId: cats, steamid: P[5], now: NOW });
    expect(blocked(db, { teamId: rats }, { teamId: cats })).toBe(false);
  });

  it('a player block on a captain is not a team block on their team after a new captain takes over', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const cats = team(P[1], 'Cats', 'CC', [P[5]]);
    block(P[0], { teamId: rats }, { steamid: P[1] });
    expect(blocked(db, { teamId: rats }, { teamId: cats })).toBe(true);
    leaveTeam(db, { teamId: cats, steamid: P[1], now: NOW });
    expect(blocked(db, { teamId: rats }, { teamId: cats })).toBe(false);
  });
});

describe('blockTarget and unblock', () => {
  it('only a manager of the party blocks: a team\'s captain or co-captain, a pickup captain for themselves', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[1], P[2]]);
    const cats = team(P[3], 'Cats', 'CC');
    setRole(db, { teamId: rats, by: P[0], target: P[1], role: 'cocaptain' });
    expect(err(blockTarget(db, { by: P[2], party: { teamId: rats }, target: { teamId: cats }, now: NOW }))).toBe('not_manager');
    expect(err(blockTarget(db, { by: P[2], party: { captain: P[0] }, target: { teamId: cats }, now: NOW }))).toBe('not_manager');
    expect(err(blockTarget(db, { by: P[2], party: { teamId: 999 }, target: { teamId: cats }, now: NOW }))).toBe('not_found');
    expect(block(P[1], { teamId: rats }, { teamId: cats })).toEqual({ added: true, declinedAcceptIds: [] });
    expect(err(unblock(db, { by: P[2], party: { teamId: rats }, target: { teamId: cats } }))).toBe('not_manager');
    expect(value(unblock(db, { by: P[0], party: { teamId: rats }, target: { teamId: cats } }))).toEqual({ removed: true });
    expect(value(unblock(db, { by: P[0], party: { teamId: rats }, target: { teamId: cats } }))).toEqual({ removed: false });
    expect(blocked(db, { teamId: rats }, { teamId: cats })).toBe(false);
  });

  it('the target is a team that exists or a player that exists', () => {
    const r = (target: unknown) => err(blockTarget(db, { by: P[0], party: { captain: P[0] }, target, now: NOW }));
    expect(r(undefined)).toBe('bad_target');
    expect(r({ teamId: 'x' })).toBe('bad_target');
    expect(r({ steamid: 'abc' })).toBe('bad_target');
    expect(r({ teamId: 999 })).toBe('not_found');
    expect(r({ steamid: '76561199999999999' })).toBe('not_found');
    expect(r({ steamid: P[4] })).toBe('ok');
    // A target carrying both a team and a player is refused, not read as a team.
    expect(r({ teamId: 999, steamid: P[4] })).toBe('bad_target');
  });

  it('Ruling 6: twice is a no-op success; never itself or a team it belongs to; at most 100', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    const cats = team(P[1], 'Cats', 'CC');
    expect(block(P[0], { teamId: rats }, { teamId: cats }).added).toBe(true);
    expect(block(P[0], { teamId: rats }, { teamId: cats }).added).toBe(false);
    expect(blocksOf(db, { teamId: rats })).toHaveLength(1);
    const r = (by: string, party: { teamId: number } | { captain: string }, target: unknown) =>
      err(blockTarget(db, { by, party, target, now: NOW }));
    expect(r(P[0], { teamId: rats }, { teamId: rats })).toBe('bad_block');
    expect(r(P[0], { captain: P[0] }, { steamid: P[0] })).toBe('bad_block');
    expect(r(P[0], { captain: P[0] }, { teamId: rats })).toBe('bad_block');
    expect(r(P[2], { captain: P[2] }, { teamId: rats })).toBe('bad_block');
    // A team blocking its own member would block itself through them.
    expect(r(P[0], { teamId: rats }, { steamid: P[2] })).toBe('bad_block');

    const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
    for (let i = 0; i < BLOCK_MAX; i++) ins.run(`7656119900009${String(i).padStart(4, '0')}`, `x${i}`);
    for (let i = 0; i < BLOCK_MAX - 1; i++) block(P[3], { captain: P[3] }, { steamid: `7656119900009${String(i).padStart(4, '0')}` });
    expect(blocksOf(db, { captain: P[3] })).toHaveLength(BLOCK_MAX - 1);
    block(P[3], { captain: P[3] }, { teamId: cats });
    expect(r(P[3], { captain: P[3] }, { steamid: `7656119900009${String(BLOCK_MAX - 1).padStart(4, '0')}` })).toBe('too_many_blocks');
    // Re-blocking one already there is still the no-op success at the cap.
    expect(block(P[3], { captain: P[3] }, { teamId: cats }).added).toBe(false);
  });

  it('blocksOf lists a party\'s blocks newest first, with names', () => {
    const cats = team(P[1], 'Cats', 'CC');
    block(P[0], { captain: P[0] }, { teamId: cats }, NOW);
    block(P[0], { captain: P[0] }, { steamid: P[4] }, new Date(NOW.getTime() + MIN));
    expect(blocksOf(db, { captain: P[0] })).toEqual([
      { target: { kind: 'player', steamid: P[4], name: 'p4' }, createdAt: new Date(NOW.getTime() + MIN).toISOString() },
      { target: { kind: 'team', id: cats, name: 'Cats', tag: 'CC' }, createdAt: NOW.toISOString() },
    ]);
    expect(blocksOf(db, { captain: P[1] })).toEqual([]);
  });

  it('scrimBlocksOf gives staff a player\'s pickup blocks and each current team\'s', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const cats = team(P[1], 'Cats', 'CC');
    block(P[0], { captain: P[0] }, { steamid: P[4] });
    block(P[0], { teamId: rats }, { teamId: cats });
    const s = scrimBlocksOf(db, P[0]);
    expect(s.pickup.map((b) => b.target)).toEqual([{ kind: 'player', steamid: P[4], name: 'p4' }]);
    expect(s.teams).toEqual([{
      teamId: rats, slug: expect.any(String), name: 'Rats', tag: 'RR',
      blocks: [{ target: { kind: 'team', id: cats, name: 'Cats', tag: 'CC' }, createdAt: NOW.toISOString() }],
    }]);
  });
});

describe('Ruling 5: blocking withdraws pending acceptances between the pair', () => {
  it('on the blocker\'s open posts the blocked side\'s acceptances are declined; its own on theirs are withdrawn', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const cats = team(P[1], 'Cats', 'CC');
    const ratsPost = post(P[0], { teamId: rats });
    const catsPost = post(P[1], { teamId: cats });
    const otherPost = post(P[3]);
    const catsOnRats = accept(ratsPost, P[1], { teamId: cats });
    const pickupOnRats = accept(ratsPost, P[4]);
    const ratsOnCats = accept(catsPost, P[0], { teamId: rats });
    const ratsOnOther = accept(otherPost, P[0], { teamId: rats });

    const r = block(P[0], { teamId: rats }, { teamId: cats });
    expect(r).toEqual({ added: true, declinedAcceptIds: [catsOnRats] });
    expect(status('scrim_accepts', catsOnRats)).toBe('declined');
    expect(status('scrim_accepts', pickupOnRats)).toBe('pending');
    expect(status('scrim_posts', ratsPost)).toBe('pending');
    expect(status('scrim_accepts', ratsOnCats)).toBe('withdrawn');
    expect(status('scrim_posts', catsPost)).toBe('open');
    expect(status('scrim_accepts', ratsOnOther)).toBe('pending');
  });

  it('a player block reaches the sides that player captains, and reopens an idle post', () => {
    const cats = team(P[1], 'Cats', 'CC');
    const mine = post(P[0]);
    const catsOnMine = accept(mine, P[1], { teamId: cats });
    const catsPost = post(P[1], { teamId: cats });
    const mineOnCats = accept(catsPost, P[0]);
    const r = block(P[0], { captain: P[0] }, { steamid: P[1] });
    expect(r.declinedAcceptIds).toEqual([catsOnMine]);
    expect(status('scrim_posts', mine)).toBe('open');
    expect(status('scrim_accepts', mineOnCats)).toBe('withdrawn');
    expect(status('scrim_posts', catsPost)).toBe('open');
  });

  it('a second block of the same target changes nothing', () => {
    const cats = team(P[1], 'Cats', 'CC');
    block(P[0], { captain: P[0] }, { teamId: cats });
    const mine = post(P[0]);
    const pickup = accept(mine, P[4]);
    expect(block(P[0], { captain: P[0] }, { teamId: cats })).toEqual({ added: false, declinedAcceptIds: [] });
    expect(status('scrim_accepts', pickup)).toBe('pending');
  });

  it('a confirmed booking between the pair is untouched', () => {
    const b = createBooking(db, { by: P[0], opponent: { steamid: P[1] }, startsAt: START, minutes: 120, playlist: ['no_mercy'], now: NOW });
    if (!b.ok) throw new Error(b.error);
    expect(confirmBooking(db, { bookingId: b.value.id, by: P[1], now: NOW }).ok).toBe(true);
    block(P[0], { captain: P[0] }, { steamid: P[1] });
    expect(getBooking(db, b.value.id)!.state).toBe('scheduled');
    expect(getBooking(db, b.value.id)!.ending_at).toBeNull();
  });
});

describe('merging players', () => {
  it('blocks follow the surviving account; a duplicate or a block on oneself is dropped', () => {
    const cats = team(P[1], 'Cats', 'CC');
    block(P[0], { captain: P[0] }, { teamId: cats });
    block(P[2], { captain: P[2] }, { teamId: cats });
    block(P[2], { captain: P[2] }, { steamid: P[0] });
    block(P[3], { captain: P[3] }, { steamid: P[2] });
    mergePlayers(db, { from: P[2], into: P[0] });
    expect(blocksOf(db, { captain: P[0] }).map((b) => b.target)).toEqual([{ kind: 'team', id: cats, name: 'Cats', tag: 'CC' }]);
    expect(blocksOf(db, { captain: P[2] })).toEqual([]);
    expect(blocksOf(db, { captain: P[3] }).map((b) => b.target)).toEqual([{ kind: 'player', steamid: P[0], name: 'p0' }]);
  });
});
