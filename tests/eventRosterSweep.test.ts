import { describe, it, expect } from 'vitest';
import * as N from '../src/events/entries.js';
import * as T from '../src/teams/teams.js';
import { NOW } from './eventFixture.js';
import { A, B, rosterB } from './entryFixture.js';
import { driveToBooking, roomFixture } from './roomFixture.js';

describe('one player, one entry, for the whole event (2026-10-11 sweep)', () => {
  it('a player who was in one entry\'s lineup cannot be added to another entry mid-event', async () => {
    const f = await roomFixture();
    driveToBooking(f); // Rats' lineup is A[0..3]
    const later = new Date(NOW.getTime() + 30 * 60_000);
    // Staff take A[3] off the Rats roster, and A[3] joins the Bats team.
    const ratsTeam = N.getEntry(f.db, f.entryA)!.team_id!;
    const batsTeam = N.getEntry(f.db, f.entryB)!.team_id!;
    expect(T.leaveTeam(f.db, { teamId: ratsTeam, steamid: A[3]!, now: later }).ok).toBe(true);
    const inv = T.invitePlayer(f.db, { teamId: batsTeam, by: B[0]!, target: A[3]!, now: later });
    if (!inv.ok) throw new Error(inv.error);
    expect(T.respondInvite(f.db, { inviteId: inv.value.inviteId, steamid: A[3]!, accept: true, now: later }).ok).toBe(true);
    const off = N.setEntryRoster(f.db, {
      entryId: f.entryA, by: 'staff', staff: true, now: later,
      roster: { starters: [A[0], A[1], A[2], A[4]], subs: [], coach: null },
    });
    expect(off.ok).toBe(true);
    const r = N.setEntryRoster(f.db, { entryId: f.entryB, by: B[0]!, roster: rosterB({ subs: [A[3]] }), now: later });
    expect(r).toMatchObject({ ok: false, error: 'player_entered' });
    if (!r.ok) expect(r.detail?.[0]?.problems[0]).toMatch(/Already played for Rats/);
  });
});
