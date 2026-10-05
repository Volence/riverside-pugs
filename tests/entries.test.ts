import { describe, it, expect } from 'vitest';
import * as N from '../src/events/entries.js';
import * as T from '../src/teams/teams.js';
import { NOW } from './eventFixture.js';
import { A, B, OUTSIDER, entryFixture, rosterA, rosterB } from './entryFixture.js';

const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};

describe('registerEntry', () => {
  it('registers a team with its roster, name, tag and logo snapshot', () => {
    const f = entryFixture();
    f.db.prepare("UPDATE teams SET logo_key = ? WHERE id = ?").run('c'.repeat(64), f.teamA);
    const { entry, added } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[1], roster: rosterA(), now: NOW }));
    expect(entry).toMatchObject({ team_id: f.teamA, name: 'Rats', tag: 'RAT', logo_key: 'c'.repeat(64), status: 'registered', registered_by: A[1], additions: 0 });
    expect(N.rosterOf(f.db, entry.id)).toEqual({ starters: A.slice(0, 4), subs: [A[4]], coach: null });
    expect(added.map((p) => p.steamid)).toEqual(A.slice(0, 5));
  });

  it('refuses a plain member, a second entry for the team, and a closed registration', () => {
    const f = entryFixture();
    expect(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[3], roster: rosterA(), now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[1], roster: rosterA(), now: NOW })).toEqual({ ok: false, error: 'already_entered' });
    f.db.prepare("UPDATE events SET status = 'checkin' WHERE id = ?").run(f.eventId);
    expect(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: NOW })).toEqual({ ok: false, error: 'not_registration' });
  });

  it('refuses a roster player who is not on the team', () => {
    const f = entryFixture();
    const r = N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA({ subs: [OUTSIDER] }), now: NOW });
    expect(r).toEqual({ ok: false, error: 'not_on_team' });
  });

  it('names every ineligible player and why', () => {
    const f = entryFixture({ eligibility: { minPugs: 1, requireDiscord: true } });
    f.db.prepare('UPDATE players SET discord_id = NULL WHERE steamid = ?').run(A[2]);
    const r = N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA({ subs: [] }), now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('player_ineligible');
    expect(r.detail).toContainEqual({ steamid: A[2], problems: ['0 of 1 completed PUGs', 'Discord is not linked'] });
    expect(r.detail).toHaveLength(4);
  });

  it('keeps a player to one entry per event, whichever team registers first', () => {
    const f = entryFixture();
    const link = must(T.setJoinLink(f.db, { teamId: f.teamB, by: B[0], on: true }));
    must(T.joinByLink(f.db, { token: link.token!, steamid: A[3], now: NOW }));
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB({ subs: [A[3]] }), now: NOW }));
    const r = N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('player_entered');
    expect(r.detail).toEqual([{ steamid: A[3], problems: ["Already on Bats's roster"] }]);
  });

  it('lets a withdrawn team register again', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    must(N.withdrawEntry(f.db, { entryId: entry.id, by: A[0], now: NOW }));
    expect(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: later(1) }).ok).toBe(true);
  });
});

describe('setEntryRoster', () => {
  it('adds, removes and moves players, counting only additions', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const { entry: after, added } = must(N.setEntryRoster(f.db, {
      entryId: entry.id, by: A[1], now: later(5),
      roster: { starters: [A[0], A[1], A[2], A[4]], subs: [A[5]], coach: null },
    }));
    expect(N.rosterOf(f.db, entry.id)).toEqual({ starters: [A[0], A[1], A[2], A[4]], subs: [A[5]], coach: null });
    expect(added).toEqual([{ steamid: A[5], role: 'sub' }]);
    expect(after.additions).toBe(1);
    expect(f.db.prepare('SELECT removed_at FROM event_entry_players WHERE entry_id = ? AND steamid = ?').get(entry.id, A[3])).toEqual({ removed_at: later(5).toISOString() });
  });

  it('writes nothing for an unchanged roster', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const logs = () => (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const before = logs();
    must(N.setEntryRoster(f.db, { entryId: entry.id, by: A[0], roster: rosterA(), now: NOW }));
    expect(logs()).toBe(before);
  });

  it('honours the addition limit and the roster lock, and staff ignore both', () => {
    const f = entryFixture({ roster: { maxSubs: 2, maxAdditions: 0, lock: { kind: 'at', at: later(60).toISOString() } } });
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const withSixth = rosterA({ subs: [A[4], A[5]] });
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: A[0], roster: withSixth, now: later(1) })).toEqual({ ok: false, error: 'additions_used' });
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: A[0], roster: rosterA({ subs: [] }), now: later(61) })).toEqual({ ok: false, error: 'roster_locked' });
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: 'staff', staff: true, roster: withSixth, now: later(61) }).ok).toBe(true);
  });

  it('lets staff add a player from outside the team', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: A[0], roster: rosterA({ coach: OUTSIDER }), now: NOW })).toEqual({ ok: false, error: 'not_on_team' });
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: 'staff', staff: true, roster: rosterA({ coach: OUTSIDER }), now: NOW }).ok).toBe(true);
  });
});

describe('leaveEntry and withdrawEntry', () => {
  it('lets a player leave, and undoes a check-in when a starter leaves', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    f.db.prepare("UPDATE events SET status = 'checkin' WHERE id = ?").run(f.eventId);
    f.db.prepare("UPDATE event_entries SET status = 'checked_in', checked_in_at = 'x', checked_in_by = ? WHERE id = ?").run(A[0], entry.id);
    expect(must(N.leaveEntry(f.db, { entryId: entry.id, steamid: A[4], now: NOW })).status).toBe('checked_in');
    const after = must(N.leaveEntry(f.db, { entryId: entry.id, steamid: A[2], now: NOW }));
    expect(after).toMatchObject({ status: 'registered', checked_in_at: null, checked_in_by: null });
    expect(N.leaveEntry(f.db, { entryId: entry.id, steamid: A[2], now: NOW })).toEqual({ ok: false, error: 'not_on_entry' });
  });

  it('withdraws until the list is final, managers only', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(N.withdrawEntry(f.db, { entryId: entry.id, by: A[3], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    f.db.prepare('UPDATE events SET locked_at = ? WHERE id = ?').run(NOW.toISOString(), f.eventId);
    expect(N.withdrawEntry(f.db, { entryId: entry.id, by: A[0], now: NOW })).toEqual({ ok: false, error: 'entries_locked' });
    f.db.prepare('UPDATE events SET locked_at = NULL WHERE id = ?').run(f.eventId);
    expect(must(N.withdrawEntry(f.db, { entryId: entry.id, by: A[0], now: NOW }))).toMatchObject({ status: 'dropped', drop_reason: 'withdrawn' });
  });
});

describe('placementOf', () => {
  it('waitlists past the cap and moves the next team up after a withdrawal', () => {
    const f = entryFixture({ teamCap: 2 });
    const ea = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    const eb = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: later(1) })).entry;
    const ev = () => f.db.prepare('SELECT * FROM events WHERE id = ?').get(f.eventId) as Parameters<typeof N.placementOf>[1];
    expect(N.placementOf(f.db, ev())).toEqual({ placed: [ea.id, eb.id], waitlist: [] });
    f.db.prepare('UPDATE events SET team_cap = 1 WHERE id = ?').run(f.eventId);
    expect(N.placementOf(f.db, ev())).toEqual({ placed: [ea.id], waitlist: [eb.id] });
    must(N.withdrawEntry(f.db, { entryId: ea.id, by: A[0], now: later(2) }));
    expect(N.placementOf(f.db, ev())).toEqual({ placed: [eb.id], waitlist: [] });
  });
});
