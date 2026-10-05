import { describe, it, expect } from 'vitest';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import * as T from '../src/teams/teams.js';
import { NOW } from './eventFixture.js';
import { A, B, OUTSIDER, entryFixture, rosterA, rosterB } from './entryFixture.js';

const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const status = (db: Parameters<typeof E.getEvent>[0], id: number) => E.getEvent(db, id)!.status;
const rate = (db: Parameters<typeof E.getEvent>[0], steamid: string, mu: number) =>
  db.prepare('INSERT OR REPLACE INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, (SELECT id FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1), ?, 1)').run(steamid, mu);

describe('openCheckin', () => {
  it('moves registration to check-in, only with check-in on', () => {
    const f = entryFixture();
    must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW }));
    expect(status(f.db, f.eventId)).toBe('checkin');
    expect(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW })).toEqual({ ok: false, error: 'wrong_status' });
    const off = entryFixture({ checkin: false });
    expect(E.openCheckin(off.db, { eventId: off.eventId, by: null, now: NOW })).toEqual({ ok: false, error: 'no_checkin' });
  });
});

describe('checkInEntry', () => {
  it('checks in a full eligible roster during check-in, once', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(N.checkInEntry(f.db, { entryId: entry.id, by: A[0], now: NOW })).toEqual({ ok: false, error: 'not_checkin' });
    must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW }));
    expect(N.checkInEntry(f.db, { entryId: entry.id, by: A[3], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    expect(must(N.checkInEntry(f.db, { entryId: entry.id, by: A[1], now: NOW }))).toMatchObject({ status: 'checked_in', checked_in_by: A[1] });
    const logs = (f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'entry_checked_in'").get() as { n: number }).n;
    must(N.checkInEntry(f.db, { entryId: entry.id, by: A[0], now: NOW }));
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'entry_checked_in'").get() as { n: number }).n).toBe(logs);
  });

  it('refuses a short roster and a player who became ineligible, naming them', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW }));
    f.db.prepare('UPDATE players SET discord_id = NULL WHERE steamid = ?').run(A[2]);
    const r = N.checkInEntry(f.db, { entryId: entry.id, by: A[0], now: NOW });
    expect(r).toEqual({ ok: false, error: 'player_ineligible', detail: [{ steamid: A[2], problems: ['Discord is not linked'] }] });
    must(N.leaveEntry(f.db, { entryId: entry.id, steamid: A[2], now: NOW }));
    expect(N.checkInEntry(f.db, { entryId: entry.id, by: A[0], now: NOW })).toEqual({ ok: false, error: 'need_starters' });
  });
});

describe('lockEntries', () => {
  it('drops teams that did not check in, fills from the waitlist in registration order, and seeds by SR', () => {
    const f = entryFixture({ teamCap: 1 });
    const ea = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    const eb = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: at(1) })).entry;
    must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: at(2) }));
    must(N.checkInEntry(f.db, { entryId: eb.id, by: B[0], now: at(3) })); // waitlisted, but it shows up
    const r = must(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: at(4) }));
    expect(r).toEqual({ kept: [eb.id], dropped: [{ entryId: ea.id, reason: 'no_checkin' }] });
    expect(N.getEntry(f.db, eb.id)).toMatchObject({ seed: 1, status: 'checked_in' });
    expect(N.getEntry(f.db, ea.id)).toMatchObject({ status: 'dropped', drop_reason: 'no_checkin', dropped_at: at(4).toISOString() });
    expect(E.getEvent(f.db, f.eventId)!.locked_at).toBe(at(4).toISOString());
    expect(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: at(5) })).toEqual({ ok: false, error: 'wrong_status' });
  });

  it('drops checked-in teams past the cap, and seeds the rest highest SR first', () => {
    const f = entryFixture({ teamCap: 1 });
    const ea = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    const eb = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: at(1) })).entry;
    must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: at(2) }));
    for (const id of [ea.id, eb.id]) must(N.checkInEntry(f.db, { entryId: id, by: id === ea.id ? A[0] : B[0], now: at(3) }));
    const r = must(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: at(4) }));
    expect(r).toEqual({ kept: [ea.id], dropped: [{ entryId: eb.id, reason: 'over_cap' }] });
  });

  it('with check-in off, drops entries without 4 starters, refreshes snapshots and seeds by SR', () => {
    const f = entryFixture({ checkin: false });
    const ea = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    const eb = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: at(1) })).entry;
    for (const s of B.slice(0, 4)) rate(f.db, s, 40);
    must(T.renameTeam(f.db, { teamId: f.teamA, by: A[0], name: 'Rats Two', tag: 'RAT2' }));
    let r = must(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: at(4) }));
    expect(r.kept).toEqual([eb.id, ea.id]);
    expect(N.getEntry(f.db, ea.id)).toMatchObject({ name: 'Rats Two', tag: 'RAT2', seed: 2 });
    expect(N.getEntry(f.db, eb.id)!.seed).toBe(1);

    const g = entryFixture({ checkin: false });
    const ga = must(N.registerEntry(g.db, { eventId: g.eventId, teamId: g.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    must(N.leaveEntry(g.db, { entryId: ga.id, steamid: A[0], now: NOW }));
    r = must(N.lockEntries(g.db, { eventId: g.eventId, by: null, now: at(4) }));
    expect(r).toEqual({ kept: [], dropped: [{ entryId: ga.id, reason: 'incomplete' }] });
  });
});

describe('staff fixes and the tick helpers', () => {
  it('drops a disbanded team before the list is final', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: NOW }));
    expect(N.dropDisbandedEntry(f.db, { entryId: entry.id, now: NOW })).toEqual({ ok: false, error: 'wrong_status' });
    must(T.disbandTeam(f.db, { teamId: f.teamB, by: B[0], now: NOW }));
    expect(must(N.dropDisbandedEntry(f.db, { entryId: entry.id, now: NOW }))).toMatchObject({ status: 'dropped', drop_reason: 'team_disbanded' });
  });

  it('disqualifies with a reason and restores before the list is final', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(must(N.disqualifyEntry(f.db, { entryId: entry.id, by: 'staff', reason: 'Ringer', now: NOW })).status).toBe('disqualified');
    expect(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).toEqual({ ok: false, error: 'already_entered' });
    expect(must(N.restoreEntry(f.db, { entryId: entry.id, by: 'staff', now: NOW }))).toMatchObject({ status: 'registered', drop_reason: null, dropped_at: null });
    expect(N.restoreEntry(f.db, { entryId: entry.id, by: 'staff', now: NOW })).toEqual({ ok: false, error: 'not_restorable' });
  });

  it('refuses to restore an entry whose players are now on another entry', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    must(N.withdrawEntry(f.db, { entryId: entry.id, by: A[0], now: NOW }));
    const again = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: at(1) })).entry;
    expect(N.restoreEntry(f.db, { entryId: entry.id, by: 'staff', now: at(2) }).ok).toBe(false);
    expect(N.getEntry(f.db, again.id)!.status).toBe('registered');
  });

  it('reorders seeds only once the list is final and before the event is live', () => {
    const f = entryFixture({ checkin: false });
    const ea = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    const eb = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: at(1) })).entry;
    expect(N.reorderSeeds(f.db, { eventId: f.eventId, by: 'staff', order: [eb.id, ea.id], now: NOW })).toEqual({ ok: false, error: 'seeds_locked' });
    must(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: at(4) }));
    expect(N.reorderSeeds(f.db, { eventId: f.eventId, by: 'staff', order: [eb.id], now: at(5) })).toEqual({ ok: false, error: 'bad_seed_order' });
    expect(must(N.reorderSeeds(f.db, { eventId: f.eventId, by: 'staff', order: [eb.id, ea.id], now: at(5) }))).toEqual([eb.id, ea.id]);
    expect([N.getEntry(f.db, eb.id)!.seed, N.getEntry(f.db, ea.id)!.seed]).toEqual([1, 2]);
  });

  it('lets staff put any eligible active player on a roster', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: 'staff', staff: true, roster: rosterA({ subs: [OUTSIDER] }), now: NOW }).ok).toBe(true);
  });
});
