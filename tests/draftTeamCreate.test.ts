import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import * as T from '../src/teams/teams.js';

const CAP = '76561199000000401';
const M = ['76561199000000402', '76561199000000403', '76561199000000404'] as const;
const OTHER = '76561199000000405';
const NOW = new Date('2026-10-12T12:00:00.000Z');

function fresh(): DB {
  const db = openDb(':memory:');
  for (const [i, s] of [CAP, ...M, OTHER].entries()) db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')").run(s, `p${i}`);
  return db;
}
const base = (over: Partial<Parameters<typeof T.createDraftTeam>[1]> = {}): Parameters<typeof T.createDraftTeam>[1] =>
  ({ captain: CAP, members: [CAP, M[0], M[1]], name: 'Night Owls', tag: 'OWL', logoKey: 'a'.repeat(64), eventId: 5, min: 3, now: NOW, ...over });
const must = <X>(r: T.Result<X>): X => { if (!r.ok) throw new Error(r.error); return r.value; };
/** Three site teams created by this player: the membership cap. */
const capped = (db: DB, steamid: string, prefix: string) => {
  for (let i = 1; i <= 3; i++) must(T.createTeam(db, { creator: steamid, name: `${prefix} Squad ${i}`, tag: `${prefix}${i}`, now: NOW }));
};

describe('createDraftTeam (plan D3b Rulings 4 to 7)', () => {
  it('makes a draft-origin team: the captain as captain, the accepters as members, the entry logo, origin_ref the event', () => {
    const db = fresh();
    const r = must(T.createDraftTeam(db, base()));
    expect(r).toMatchObject({ name: 'Night Owls', tag: 'OWL', joined: [CAP, M[0], M[1]], left: [] });
    expect(T.getTeam(db, r.id)).toMatchObject({ origin: 'draft', origin_ref: '5', logo_key: 'a'.repeat(64), captain_steamid: CAP, created_by: CAP, slug: 'night-owls' });
    expect(T.activeMembers(db, r.id).map((m) => [m.steamid, m.role])).toEqual([[CAP, 'captain'], [M[0], 'member'], [M[1], 'member']]);
  });

  it('Review Focus 3: a taken name gets " 2" (cut to fit 24 characters) and a taken tag a digit', () => {
    const db = fresh();
    must(T.createTeam(db, { creator: OTHER, name: 'Night Owls', tag: 'OWL', now: NOW }));
    expect(must(T.createDraftTeam(db, base()))).toMatchObject({ name: 'Night Owls 2', tag: 'OWL2' });
    const long = 'Abcdefghijklmnopqrstuvwx';
    must(T.createTeam(db, { creator: OTHER, name: long, tag: 'LONG5', now: NOW }));
    expect(must(T.createDraftTeam(db, base({ captain: M[2], members: [M[2], CAP, M[0]], name: long, tag: 'LONG5' })))).toMatchObject({ name: 'Abcdefghijklmnopqrstuv 2', tag: 'LONG2' });
  });

  it('leaves out an accepter at the membership cap, and refuses when fewer than min can join', () => {
    const db = fresh();
    capped(db, M[0], 'AA');
    const r = must(T.createDraftTeam(db, base({ members: [CAP, M[0], M[1], M[2]] })));
    expect(r).toMatchObject({ joined: [CAP, M[1], M[2]], left: [M[0]] });
    expect(T.roleOf(db, r.id, M[0])).toBeNull();
    const db2 = fresh();
    capped(db2, M[0], 'AA');
    expect(T.createDraftTeam(db2, base())).toEqual({ ok: false, error: 'keep_short' });
    expect(db2.prepare("SELECT COUNT(*) AS n FROM teams WHERE origin = 'draft'").get()).toEqual({ n: 0 });
  });

  it('leaves out a banned accepter (ruling G4)', () => {
    const db = fresh();
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(M[0]);
    const r = must(T.createDraftTeam(db, base({ members: [CAP, M[0], M[1], M[2]] })));
    expect(r).toMatchObject({ joined: [CAP, M[1], M[2]], left: [M[0]] });
    expect(T.roleOf(db, r.id, M[0])).toBeNull();
  });

  it('refuses a captain at the membership cap', () => {
    const db = fresh();
    capped(db, CAP, 'CC');
    expect(T.createDraftTeam(db, base())).toEqual({ ok: false, error: 'your_cap' });
  });
});

describe('addDraftMember', () => {
  it('adds a late accepter once, never past the cap, and only to a draft team', () => {
    const db = fresh();
    const team = must(T.createDraftTeam(db, base()));
    expect(T.addDraftMember(db, { teamId: team.id, steamid: M[2], now: NOW })).toEqual({ ok: true, value: null });
    expect(T.roleOf(db, team.id, M[2])).toBe('member');
    expect(T.addDraftMember(db, { teamId: team.id, steamid: M[2], now: NOW })).toEqual({ ok: false, error: 'already_member' });
    capped(db, OTHER, 'OO');
    expect(T.addDraftMember(db, { teamId: team.id, steamid: OTHER, now: NOW })).toEqual({ ok: false, error: 'their_cap' });
    const site = must(T.createTeam(db, { creator: M[2], name: 'Site Team', tag: 'SITE', now: NOW }));
    expect(T.addDraftMember(db, { teamId: site.id, steamid: CAP, now: NOW })).toEqual({ ok: false, error: 'not_found' });
  });

  it('does not add a banned late accepter (ruling G4)', () => {
    const db = fresh();
    const team = must(T.createDraftTeam(db, base()));
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(M[2]);
    expect(T.addDraftMember(db, { teamId: team.id, steamid: M[2], now: NOW })).toEqual({ ok: false, error: 'not_player' });
    expect(T.roleOf(db, team.id, M[2])).toBeNull();
  });
});
