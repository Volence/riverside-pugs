import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  activeMembers, canCreate, createTeam, getTeamBySlug, myTeams, normalizeName, normalizeTag, roleOf,
  invitePlayer, respondInvite, cancelInvite, openInvitesOf, pendingInvitesFor, setJoinLink, teamByJoinToken, joinByLink,
} from '../src/teams/teams.js';

export const P = Array.from({ length: 12 }, (_, i) => `765611990000001${String(i).padStart(2, '0')}`);

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
});
const t0 = new Date('2026-10-01T12:00:00.000Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const make = (creator: string, name: string, tag: string, now = t0) => {
  const r = createTeam(db, { creator, name, tag, now });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('names and tags', () => {
  it('trims and collapses spaces, keys case-insensitively', () => {
    expect(normalizeName('  Riverside   Rats ')).toEqual({ ok: true, name: 'Riverside Rats', key: 'riverside rats' });
    expect(normalizeName('ab')).toEqual({ ok: false, error: 'bad_name' });
    expect(normalizeName('x'.repeat(25))).toEqual({ ok: false, error: 'bad_name' });
    expect(normalizeName(42)).toEqual({ ok: false, error: 'bad_name' });
  });

  it('refuses a slur in a name or a tag', () => {
    expect(normalizeName('team faggot')).toEqual({ ok: false, error: 'name_not_allowed' });
    expect(normalizeTag('NIGGA'.slice(0, 5))).toEqual({ ok: false, error: 'tag_not_allowed' });
  });

  it('a tag is 2 to 5 letters or digits, keyed upper case', () => {
    expect(normalizeTag(' rR1 ')).toEqual({ ok: true, tag: 'rR1', key: 'RR1' });
    expect(normalizeTag('R')).toEqual({ ok: false, error: 'bad_tag' });
    expect(normalizeTag('RRRRRR')).toEqual({ ok: false, error: 'bad_tag' });
    expect(normalizeTag('R R')).toEqual({ ok: false, error: 'bad_tag' });
  });
});

describe('createTeam', () => {
  it('creates the team with its creator as captain and a slug from the name', () => {
    const { slug } = make(P[0], 'Riverside Rats', 'RR');
    expect(slug).toBe('riverside-rats');
    const team = getTeamBySlug(db, slug)!;
    expect(team).toMatchObject({ name: 'Riverside Rats', tag: 'RR', captain_steamid: P[0], created_by: P[0], region: 'na', origin: 'site' });
    expect(activeMembers(db, team.id).map((m) => [m.steamid, m.role])).toEqual([[P[0], 'captain']]);
    expect(roleOf(db, team.id, P[0])).toBe('captain');
  });

  it('refuses a name or tag another live team holds, in any case or spacing', () => {
    make(P[0], 'Riverside Rats', 'RR');
    expect(createTeam(db, { creator: P[1], name: 'riverside  RATS', tag: 'XX' })).toEqual({ ok: false, error: 'name_taken' });
    expect(createTeam(db, { creator: P[1], name: 'Other', tag: 'rr' })).toEqual({ ok: false, error: 'tag_taken' });
  });

  it('a disbanded team frees its name and tag, but never its slug', () => {
    const { slug } = make(P[0], 'Riverside Rats', 'RR');
    db.prepare("UPDATE teams SET disbanded_at = '2026-10-01T13:00:00.000Z' WHERE slug = ?").run(slug);
    expect(make(P[1], 'Riverside Rats', 'RR').slug).toBe('riverside-rats-2');
  });

  it('a name that slugs to nothing or to a reserved word gets a usable slug', () => {
    expect(make(P[0], '!!!', 'AA').slug).toBe('team');
    expect(make(P[1], 'Mine', 'BB').slug).toBe('mine-2');
  });

  it('stops at the membership cap and the created-teams cap', () => {
    make(P[0], 'One', 'O1'); make(P[0], 'Two', 'O2'); make(P[0], 'Three', 'O3');
    expect(canCreate(db, P[0])).toBe(false);
    expect(createTeam(db, { creator: P[0], name: 'Four', tag: 'O4' })).toEqual({ ok: false, error: 'your_cap' });
    // Leaving all three frees the membership cap but not the created cap.
    db.prepare("UPDATE team_members SET left_at = '2026-10-01T13:00:00.000Z' WHERE steamid = ?").run(P[0]);
    expect(createTeam(db, { creator: P[0], name: 'Four', tag: 'O4' })).toEqual({ ok: false, error: 'created_cap' });
    db.prepare("UPDATE settings SET value = '4' WHERE key = 'team_membership_cap'").run();
    expect(createTeam(db, { creator: P[0], name: 'Four', tag: 'O4' }).ok).toBe(true);
  });

  it('myTeams lists live teams the player is on, with their role', () => {
    make(P[0], 'Alpha', 'AA');
    const b = make(P[1], 'Bravo', 'BB');
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES ((SELECT id FROM teams WHERE slug = ?), ?, 'member', ?)")
      .run(b.slug, P[0], at(1).toISOString());
    expect(myTeams(db, P[0]).map((t) => [t.slug, t.role])).toEqual([['alpha', 'captain'], ['bravo', 'member']]);
  });
});

describe('invites', () => {
  const invite = (teamId: number, by: string, target: string) => {
    const r = invitePlayer(db, { teamId, by, target, now: at(1) });
    if (!r.ok) throw new Error(r.error);
    return r.value.inviteId;
  };

  it('captain and co-captains invite; the player accepts and joins as a member', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const inv = invite(id, P[0], P[1]);
    expect(pendingInvitesFor(db, P[1]).map((i) => [i.id, i.slug])).toEqual([[inv, 'rats']]);
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: true, now: at(2) })).toEqual({ ok: true, value: { teamId: id, slug: 'rats' } });
    expect(roleOf(db, id, P[1])).toBe('member');
    expect(pendingInvitesFor(db, P[1])).toEqual([]);
    expect(invitePlayer(db, { teamId: id, by: P[1], target: P[2] })).toEqual({ ok: false, error: 'not_manager' });
    db.prepare("UPDATE team_members SET role = 'cocaptain' WHERE steamid = ?").run(P[1]);
    expect(invitePlayer(db, { teamId: id, by: P[1], target: P[2] }).ok).toBe(true);
  });

  it('refuses a duplicate invite, a member, and a player who is not active', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    invite(id, P[0], P[1]);
    expect(invitePlayer(db, { teamId: id, by: P[0], target: P[1] })).toEqual({ ok: false, error: 'already_invited' });
    expect(invitePlayer(db, { teamId: id, by: P[0], target: P[0] })).toEqual({ ok: false, error: 'already_member' });
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[2]);
    expect(invitePlayer(db, { teamId: id, by: P[0], target: P[2] })).toEqual({ ok: false, error: 'not_player' });
    expect(invitePlayer(db, { teamId: id, by: P[0], target: '76561199999999999' })).toEqual({ ok: false, error: 'not_player' });
  });

  it('only the invited player can answer, and only once', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const inv = invite(id, P[0], P[1]);
    expect(respondInvite(db, { inviteId: inv, steamid: P[2], accept: true })).toEqual({ ok: false, error: 'not_found' });
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: false }).ok).toBe(true);
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: true })).toEqual({ ok: false, error: 'invite_closed' });
    expect(roleOf(db, id, P[1])).toBeNull();
  });

  it('re-checks the cap and the roster at accept time', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const inv = invite(id, P[0], P[1]);
    // P[1] fills their cap after the invite was sent.
    make(P[1], 'Alpha One', 'A1'); make(P[1], 'Alpha Two', 'A2'); make(P[1], 'Alpha Three', 'A3');
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: true })).toEqual({ ok: false, error: 'your_cap' });
    // The invite stays open, so freeing a slot lets them accept later.
    expect(openInvitesOf(db, id).map((i) => i.id)).toEqual([inv]);

    const inv2 = invite(id, P[0], P[2]);
    // P[3]..P[9] join: with the captain that is 8, a full roster.
    for (let i = 3; i <= 9; i++) respondInvite(db, { inviteId: invite(id, P[0], P[i]), steamid: P[i], accept: true });
    expect(rosterCount(id)).toBe(8);
    expect(respondInvite(db, { inviteId: inv2, steamid: P[2], accept: true })).toEqual({ ok: false, error: 'roster_full' });
    expect(invitePlayer(db, { teamId: id, by: P[0], target: P[10] })).toEqual({ ok: false, error: 'roster_full' });
  });

  it('an invite to a disbanded team is closed', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const inv = invite(id, P[0], P[1]);
    db.prepare("UPDATE teams SET disbanded_at = '2026-10-01T13:00:00.000Z' WHERE id = ?").run(id);
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: true })).toEqual({ ok: false, error: 'invite_closed' });
  });

  it('managers cancel invites', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const inv = invite(id, P[0], P[1]);
    expect(cancelInvite(db, { inviteId: inv, by: P[1] })).toEqual({ ok: false, error: 'not_manager' });
    expect(cancelInvite(db, { inviteId: inv, by: P[0] })).toEqual({ ok: true, value: null });
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: true })).toEqual({ ok: false, error: 'invite_closed' });
  });
});

const rosterCount = (teamId: number) =>
  (db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND left_at IS NULL').get(teamId) as { n: number }).n;

describe('join link', () => {
  it('only the captain turns it on; a new token replaces the old one; off kills it', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'cocaptain', ?)").run(id, P[1], at(1).toISOString());
    expect(setJoinLink(db, { teamId: id, by: P[1], on: true })).toEqual({ ok: false, error: 'not_allowed' });
    const first = setJoinLink(db, { teamId: id, by: P[0], on: true });
    const second = setJoinLink(db, { teamId: id, by: P[0], on: true });
    if (!first.ok || !second.ok) throw new Error('link');
    expect(first.value.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second.value.token).not.toBe(first.value.token);
    expect(joinByLink(db, { token: first.value.token!, steamid: P[2] })).toEqual({ ok: false, error: 'link_off' });
    expect(teamByJoinToken(db, second.value.token!)?.id).toBe(id);
    expect(joinByLink(db, { token: second.value.token!, steamid: P[2] })).toEqual({ ok: true, value: { slug: 'rats' } });
    expect(roleOf(db, id, P[2])).toBe('member');
    expect(joinByLink(db, { token: second.value.token!, steamid: P[2] })).toEqual({ ok: false, error: 'already_member' });
    setJoinLink(db, { teamId: id, by: P[0], on: false });
    expect(joinByLink(db, { token: second.value.token!, steamid: P[3] })).toEqual({ ok: false, error: 'link_off' });
  });

  it('joining by link closes an open invite to the same team', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    invitePlayer(db, { teamId: id, by: P[0], target: P[1] });
    const link = setJoinLink(db, { teamId: id, by: P[0], on: true });
    if (!link.ok) throw new Error('link');
    joinByLink(db, { token: link.value.token!, steamid: P[1] });
    expect(openInvitesOf(db, id)).toEqual([]);
  });
});
