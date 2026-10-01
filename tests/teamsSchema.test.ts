import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { competitiveAccess } from '../src/teams/access.js';
import { getSetting } from '../src/settings.js';

const A = '76561199000000001';
const ADMIN = '76561199000000002';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'a', 'active'), (?, 'admin', 'active')").run(A, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

const team = (name: string, extra: { disbanded?: boolean } = {}) => Number(db.prepare(
  `INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by, disbanded_at)
   VALUES (?, ?, 'RR', 'RR', ?, ?, ?, ?)`,
).run(name, name.toLowerCase(), `${name.toLowerCase()}-${Math.random()}`, A, A, extra.disbanded ? '2026-09-30T00:00:00.000Z' : null).lastInsertRowid);

describe('team tables', () => {
  it('two live teams cannot share a name key, a disbanded one does not count', () => {
    team('Rats', { disbanded: true });
    team('Rats');
    expect(() => team('Rats')).toThrow(/UNIQUE/);
  });

  it('one active membership per player per team, history rows allowed', () => {
    const t = team('Rats');
    const ins = db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at, left_at) VALUES (?, ?, 'member', '2026-09-30', ?)");
    ins.run(t, A, '2026-09-30T01:00:00.000Z');
    ins.run(t, A, null);
    expect(() => ins.run(t, A, null)).toThrow(/UNIQUE/);
  });

  it('one open invite per player per team', () => {
    const t = team('Rats');
    const ins = db.prepare("INSERT INTO team_invites (team_id, steamid, invited_by, created_at) VALUES (?, ?, ?, '2026-09-30')");
    ins.run(t, ADMIN, A);
    expect(() => ins.run(t, ADMIN, A)).toThrow(/UNIQUE/);
  });

  it('region defaults to na and origin to site', () => {
    const t = team('Rats');
    expect(db.prepare('SELECT region, origin FROM teams WHERE id = ?').get(t)).toEqual({ region: 'na', origin: 'site' });
  });
});

describe('competitive switch', () => {
  it('defaults to off for everyone', () => {
    expect(getSetting(db, 'competitive_enabled')).toBe('off');
    expect(getSetting(db, 'team_membership_cap')).toBe('3');
    expect(competitiveAccess(db, ADMIN)).toBe(false);
  });

  it('admins only lets admins in, everyone lets active players in, nobody signed out', () => {
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect(competitiveAccess(db, ADMIN)).toBe(true);
    expect(competitiveAccess(db, A)).toBe(false);
    db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
    expect(competitiveAccess(db, A)).toBe(true);
    expect(competitiveAccess(db, null)).toBe(false);
  });
});
