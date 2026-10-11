import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  createTeam, createBlocker, disbandTeam, getTeamBySlug, invitePlayer, kickMember, leaveTeam, normalizeName,
  respondInvite, roleOf, setRole, teamBusy, transferCaptain, pendingInvitesFor,
} from '../src/teams/teams.js';
import { findSlurs } from '../src/slurs.js';

const P = Array.from({ length: 8 }, (_, i) => `765611990000002${String(i).padStart(2, '0')}`);
let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
});
const t0 = new Date('2026-10-01T12:00:00.000Z');

function team(creator: string, members: string[], name = 'Riverside Rats', tag = 'RAT'): number {
  const r = createTeam(db, { creator, name, tag, now: t0 });
  if (!r.ok) throw new Error(r.error);
  for (const m of members) {
    const inv = invitePlayer(db, { teamId: r.value.id, by: creator, target: m, now: t0 });
    if (!inv.ok) throw new Error(inv.error);
    const acc = respondInvite(db, { inviteId: inv.value.inviteId, steamid: m, accept: true, now: t0 });
    if (!acc.ok) throw new Error(acc.error);
  }
  return r.value.id;
}

function booking(teamId: number, captain: string, people: string[], state = 'scheduled', purpose = 'scrim'): number {
  const id = Number(db.prepare(
    `INSERT INTO bookings (purpose, starts_at, ends_at, state, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES (?, '2026-10-02T20:00:00.000Z', '2026-10-02T22:00:00.000Z', ?, 'pw', 'tv', 'pug_match', '{}', '[]', ?, ?)`,
  ).run(purpose, state, captain, t0.toISOString()).lastInsertRowid);
  db.prepare("INSERT INTO booking_sides (booking_id, side, team_id, captain_steamid, confirmed_at) VALUES (?, 'a', ?, ?, ?)")
    .run(id, teamId, captain, t0.toISOString());
  for (const p of people) {
    db.prepare("INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, 'a', ?, 'player', 'accepted', ?, ?)")
      .run(id, p, captain, t0.toISOString());
  }
  return id;
}
const onBooking = (id: number, steamid: string) =>
  db.prepare('SELECT 1 FROM booking_people WHERE booking_id = ? AND steamid = ?').get(id, steamid) !== undefined;
const ban = (steamid: string) => db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(steamid);

describe('lookalike letters', () => {
  it('a Cyrillic letter inside a slur no longer hides it', () => {
    expect(findSlurs('nіgga squad')).toContain('n-word'); // Cyrillic і
    expect(findSlurs('fаggot crew')).toContain('f-slur'); // Cyrillic а
    expect(normalizeName('nіgga squad')).toEqual({ ok: false, error: 'name_not_allowed' });
  });

  it('ordinary Russian chat is not read as a slur', () => {
    expect(findSlurs('привет как дела')).toEqual([]);
    expect(findSlurs('сок рак мех кот')).toEqual([]);
  });

  it('a lookalike name keys the same as the Latin one', () => {
    team(P[0], [], 'Riverside', 'RIV');
    const r = createTeam(db, { creator: P[1], name: 'Rіverside', tag: 'RV2', now: t0 });
    expect(r).toEqual({ ok: false, error: 'name_taken' });
  });
});

describe('a banned captain', () => {
  it('captaincy passes over a banned member when the captain leaves', () => {
    const id = team(P[0], [P[1], P[2]]);
    setRole(db, { teamId: id, by: P[0], target: P[1], role: 'cocaptain' });
    ban(P[1]);
    expect(leaveTeam(db, { teamId: id, steamid: P[0], now: t0 })).toEqual({ ok: true, value: { disbanded: false, captain: P[2] } });
  });

  it('cannot be handed the captaincy', () => {
    const id = team(P[0], [P[1]]);
    ban(P[1]);
    expect(transferCaptain(db, { teamId: id, by: P[0], target: P[1] })).toEqual({ ok: false, error: 'not_eligible' });
  });

  it('a co-captain may take over from a banned captain, a member may not', () => {
    const id = team(P[0], [P[1], P[2]]);
    setRole(db, { teamId: id, by: P[0], target: P[1], role: 'cocaptain' });
    expect(transferCaptain(db, { teamId: id, by: P[1], target: P[1] })).toEqual({ ok: false, error: 'not_allowed' });
    ban(P[0]);
    expect(transferCaptain(db, { teamId: id, by: P[2], target: P[2] })).toEqual({ ok: false, error: 'not_allowed' });
    expect(transferCaptain(db, { teamId: id, by: P[1], target: P[1] })).toEqual({ ok: true, value: null });
    expect(roleOf(db, id, P[1])).toBe('captain');
  });
});

describe('a team with a booked scrim or event entry', () => {
  it('cannot be disbanded, or closed by its last member leaving', () => {
    const id = team(P[0], []);
    const b = booking(id, P[0], [P[0]]);
    expect(teamBusy(db, id)).toBe(true);
    expect(disbandTeam(db, { teamId: id, by: P[0], now: t0 })).toEqual({ ok: false, error: 'team_busy' });
    expect(leaveTeam(db, { teamId: id, steamid: P[0], now: t0 })).toEqual({ ok: false, error: 'team_busy' });
    db.prepare("UPDATE bookings SET state = 'ended', ended_at = ? WHERE id = ?").run(t0.toISOString(), b);
    expect(teamBusy(db, id)).toBe(false);
    expect(disbandTeam(db, { teamId: id, by: P[0], now: t0 })).toEqual({ ok: true, value: null });
  });

  it('tournament bookings do not count, live event entries do', () => {
    const id = team(P[0], []);
    booking(id, P[0], [P[0]], 'scheduled', 'tournament');
    expect(teamBusy(db, id)).toBe(false);
    const ev = Number(db.prepare(
      `INSERT INTO events (slug, name, organizer_steamid, entry_kind, status, starts_at, eligibility_json, checkin_json, roster_json, created_at, updated_at)
       VALUES ('cup', 'Cup', ?, 'team', 'registration', '2026-10-05T20:00:00.000Z', '{}', '{}', '{}', ?, ?)`,
    ).run(P[0], t0.toISOString(), t0.toISOString()).lastInsertRowid);
    db.prepare("INSERT INTO event_entries (event_id, team_id, name, registered_by, created_at) VALUES (?, ?, 'Riverside Rats', ?, ?)")
      .run(ev, id, P[0], t0.toISOString());
    expect(teamBusy(db, id)).toBe(true);
    db.prepare("UPDATE events SET status = 'finished' WHERE id = ?").run(ev);
    expect(teamBusy(db, id)).toBe(false);
  });

  it('a kicked or departing player comes off scrims not yet started, not ones under way', () => {
    const id = team(P[0], [P[1], P[2]]);
    const later = booking(id, P[0], [P[0], P[1], P[2]]);
    const running = booking(id, P[0], [P[0], P[1], P[2]], 'active');
    expect(kickMember(db, { teamId: id, by: P[0], target: P[1], now: t0 }).ok).toBe(true);
    expect(onBooking(later, P[1])).toBe(false);
    expect(onBooking(running, P[1])).toBe(true);
    const ev = db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'person_removed'").get(later) as { detail: string };
    expect(JSON.parse(ev.detail)).toEqual({ steamid: P[1], why: 'kicked from team' });
    expect(leaveTeam(db, { teamId: id, steamid: P[2], now: t0 }).ok).toBe(true);
    expect(onBooking(later, P[2])).toBe(false);
    expect(onBooking(later, P[0])).toBe(true);
  });
});

describe('create blocker', () => {
  it('says why a player who left every team they made still cannot make one', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('team_membership_cap', '1')").run();
    const id = team(P[0], [P[1]]);
    transferCaptain(db, { teamId: id, by: P[0], target: P[1] });
    leaveTeam(db, { teamId: id, steamid: P[0], now: t0 });
    expect(getTeamBySlug(db, 'riverside-rats')?.disbanded_at).toBeNull();
    expect(createBlocker(db, P[0])).toBe('created_cap');
    expect(pendingInvitesFor(db, P[0])).toEqual([]);
  });
});
