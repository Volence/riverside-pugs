import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  activeMembers, canCreate, createTeam, getTeamBySlug, myTeams, normalizeName, normalizeTag, roleOf,
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
