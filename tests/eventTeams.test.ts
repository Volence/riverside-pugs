import { describe, it, expect } from 'vitest';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import * as T from '../src/teams/teams.js';
import { scrimSideAllowed, scrimsAccess } from '../src/teams/access.js';
import { createPost, acceptPost } from '../src/scrims/scrims.js';
import { createBooking } from '../src/bookings/bookings.js';
import * as N from '../src/events/entries.js';
import * as D from '../src/events/drafts.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, cutDraft, draftFixture, type DraftFixture } from './draftFixture.js';

/**
 * Draft tourney 2 plan (owner 2026-11-08): a draft event's teams are site
 * teams from publish until the event ends, so they scrim as teams, and
 * `scrims_enabled = event` opens scrims to that event's teams alone.
 */

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }): string => (r.ok ? 'ok' : r.error!);
const LATER = new Date(NOW.getTime() + 3_600_000);

function published(): DraftFixture & { entries: number[] } {
  const f = cutDraft({ balance: true });
  const { entries } = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  return { ...f, entries };
}
const teamOf = (f: DraftFixture, entryId: number) =>
  f.db.prepare('SELECT * FROM teams WHERE event_entry_id = ? AND disbanded_at IS NULL').get(entryId) as T.TeamRow | undefined;
const members = (f: DraftFixture, teamId: number) =>
  T.activeMembers(f.db, teamId).map((m) => ({ steamid: m.steamid, role: m.role })).sort((a, b) => a.steamid.localeCompare(b.steamid));
const expected = (f: DraftFixture, entryId: number) => {
  const e = N.getEntry(f.db, entryId)!;
  return N.rosterOf(f.db, entryId).starters.map((s) => ({ steamid: s, role: s === e.captain_steamid ? 'captain' : 'member' }))
    .sort((a, b) => a.steamid.localeCompare(b.steamid));
};

describe('event teams', () => {
  it('publishing the teams makes one site team per entry: the captain and starters, origin draft, bound to the entry', () => {
    const f = published();
    expect(f.entries).toHaveLength(5);
    for (const id of f.entries) {
      const t = teamOf(f, id)!;
      const e = N.getEntry(f.db, id)!;
      expect(t).toMatchObject({ origin: 'draft', origin_ref: String(f.eventId), captain_steamid: e.captain_steamid, name: e.name });
      expect(t.tag).toMatch(/^[A-Z0-9]{2,5}$/);
      expect(members(f, t.id)).toEqual(expected(f, id));
    }
  });

  it('never counts toward the membership cap', () => {
    const f = published();
    setSetting(f.db, 'team_membership_cap', '1');
    const s = N.rosterOf(f.db, f.entries[0]!).starters[1]!;
    expect(T.activeMembershipCount(f.db, s)).toBe(0);
    expect(T.canCreate(f.db, s)).toBe(true);
  });

  it('refuses every hand edit on the team page, staff included', () => {
    const f = published();
    const t = teamOf(f, f.entries[0]!)!;
    const cap = t.captain_steamid;
    const member = N.rosterOf(f.db, f.entries[0]!).starters.find((s) => s !== cap)!;
    const outsider = P[15]!; // the bench
    expect(err(T.invitePlayer(f.db, { teamId: t.id, by: cap, target: outsider, now: NOW }))).toBe('event_team');
    expect(err(T.setJoinLink(f.db, { teamId: t.id, by: cap, on: true }))).toBe('event_team');
    expect(err(T.leaveTeam(f.db, { teamId: t.id, steamid: member, now: NOW }))).toBe('event_team');
    expect(err(T.kickMember(f.db, { teamId: t.id, by: cap, target: member, now: NOW }))).toBe('event_team');
    expect(err(T.setRole(f.db, { teamId: t.id, by: cap, target: member, role: 'cocaptain' }))).toBe('event_team');
    expect(err(T.transferCaptain(f.db, { teamId: t.id, by: cap, target: member, staff: true }))).toBe('event_team');
    expect(err(T.renameTeam(f.db, { teamId: t.id, by: ADMIN, staff: true, name: 'New name' }))).toBe('event_team');
    expect(err(T.disbandTeam(f.db, { teamId: t.id, by: ADMIN, staff: true, now: NOW }))).toBe('event_team');
    expect(err(T.setLogoKey(f.db, { teamId: t.id, by: cap, logoKey: null }))).toBe('event_team');
  });

  it('follows the desk: a swap, a replace, a new captain and a rename', () => {
    const f = published();
    const [e1, e2] = f.entries as [number, number];
    const cap1 = N.getEntry(f.db, e1)!.captain_steamid!;
    const x = N.rosterOf(f.db, e1).starters.find((s) => s !== cap1)!;
    const cap2 = N.getEntry(f.db, e2)!.captain_steamid!;
    const y = N.rosterOf(f.db, e2).starters.find((s) => s !== cap2)!;
    must(N.swapDraftPlayers(f.db, { eventId: f.eventId, a: { entryId: e1, steamid: x }, b: { entryId: e2, steamid: y }, actor: ADMIN, now: LATER }));
    expect(members(f, teamOf(f, e1)!.id)).toEqual(expected(f, e1));
    expect(members(f, teamOf(f, e2)!.id)).toEqual(expected(f, e2));

    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: e1, out: y, in: P[15]!, reason: 'left', note: null, actor: ADMIN, now: LATER }));
    expect(members(f, teamOf(f, e1)!.id)).toEqual(expected(f, e1));
    expect(T.roleOf(f.db, teamOf(f, e1)!.id, y)).toBeNull();

    must(N.setDraftCaptain(f.db, { eventId: f.eventId, entryId: e1, steamid: P[15]!, actor: ADMIN, now: LATER }));
    expect(teamOf(f, e1)!.captain_steamid).toBe(P[15]);
    expect(members(f, teamOf(f, e1)!.id)).toEqual(expected(f, e1));

    must(N.setEntryIdentity(f.db, { eventId: f.eventId, entryId: e1, steamid: ADMIN, staff: true, name: 'Night Owls', tag: 'OWL', now: LATER }));
    expect(teamOf(f, e1)).toMatchObject({ name: 'Night Owls', tag: 'OWL' });
  });

  it('takes the next free name when a site team already has the entry name', () => {
    const f = cutDraft({ balance: true });
    // P[20] is a captain (top SR); a site team called "Team d20" exists before publish.
    must(T.createTeam(f.db, { creator: P[0]!, name: 'Team d20', tag: 'TD', now: NOW }));
    const { entries } = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    const names = entries.map((id) => teamOf(f, id)!.name);
    expect(names).toContain('Team d20 2');
  });

  it('closes once the event is finished or cancelled, and not before', () => {
    const f = published();
    expect(T.closeEndedEventTeams(f.db, LATER)).toEqual([]);
    f.db.prepare("UPDATE events SET status = 'finished' WHERE id = ?").run(f.eventId);
    expect(T.closeEndedEventTeams(f.db, LATER)).toHaveLength(5);
    for (const id of f.entries) expect(teamOf(f, id)).toBeUndefined();
    expect(T.closeEndedEventTeams(f.db, LATER)).toEqual([]);
  });
});

describe('scrims for one event', () => {
  const setup = () => {
    const f = published();
    setSetting(f.db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'crash_course']));
    for (const n of ['a', 'bb', 'ccc', 'dddd']) {
      const id = addServer(f.db, { name: n, host: 'h', port: 27000 + n.length, rconPort: 1, rconPassword: 'x' });
      f.db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
    }
    setSetting(f.db, 'scrims_enabled', 'event');
    setSetting(f.db, 'scrims_event_id', String(f.eventId));
    return f;
  };
  const START = new Date(NOW.getTime() + 26 * 3_600_000).toISOString();
  const post = (f: DraftFixture, by: string, teamId?: number) =>
    createPost(f.db, { by, teamId, startsAt: START, minutes: 120, campaigns: ['no_mercy'], srRange: null, note: '', now: NOW });

  it('lets in the event teams\' players and admins, nobody else', () => {
    const f = setup();
    const onTeam = N.rosterOf(f.db, f.entries[0]!).starters[1]!;
    expect(scrimsAccess(f.db, onTeam)).toBe(true);
    expect(scrimsAccess(f.db, ADMIN)).toBe(true);
    expect(scrimsAccess(f.db, P[15]!)).toBe(false); // bench: on no team
    setSetting(f.db, 'scrims_event_id', '0');
    expect(scrimsAccess(f.db, onTeam)).toBe(false);
  });

  it('takes only that event\'s teams as sides: no pickup, no site team', () => {
    const f = setup();
    const t1 = teamOf(f, f.entries[0]!)!;
    const site = must(T.createTeam(f.db, { creator: P[15]!, name: 'Site Team', tag: 'SITE', now: NOW })).id;
    expect(scrimSideAllowed(f.db, { teamId: t1.id })).toBe(true);
    expect(scrimSideAllowed(f.db, { teamId: site })).toBe(false);
    expect(scrimSideAllowed(f.db, { captain: t1.captain_steamid })).toBe(false);
    expect(err(post(f, t1.captain_steamid))).toBe('event_only');
    expect(err(post(f, P[15]!, site))).toBe('event_only');
    // A disqualified entry's team is out too.
    f.db.prepare("UPDATE event_entries SET status = 'disqualified' WHERE id = ?").run(f.entries[0]);
    expect(scrimSideAllowed(f.db, { teamId: t1.id })).toBe(false);
  });

  it('an event team posts, another accepts; a pickup accept is refused', () => {
    const f = setup();
    const t1 = teamOf(f, f.entries[0]!)!;
    const t2 = teamOf(f, f.entries[1]!)!;
    const id = must(post(f, t1.captain_steamid, t1.id)).id;
    expect(err(acceptPost(f.db, { postId: id, by: t2.captain_steamid, now: NOW }))).toBe('event_only');
    expect(err(acceptPost(f.db, { postId: id, by: t2.captain_steamid, teamId: t2.id, now: NOW }))).toBe('ok');
  });

  it('a direct booking needs an event team on both sides', () => {
    const f = setup();
    const t1 = teamOf(f, f.entries[0]!)!;
    const t2 = teamOf(f, f.entries[1]!)!;
    const book = (opponent: unknown) => createBooking(f.db, {
      by: t1.captain_steamid, teamId: t1.id, opponent, startsAt: START, playlist: ['no_mercy'], now: NOW,
    });
    // Someone off the event teams cannot even open scrims; an event captain as a pickup side is still refused.
    expect(err(book({ steamid: P[15] }))).toBe('not_open');
    expect(err(book({ steamid: t2.captain_steamid }))).toBe('event_only');
    expect(err(book({ teamId: t2.id }))).not.toBe('event_only');
  });

  it('every other mode lets any side through, as before', () => {
    const f = setup();
    setSetting(f.db, 'scrims_enabled', 'everyone');
    expect(scrimSideAllowed(f.db, { captain: P[15]! })).toBe(true);
  });
});

describe('bookings follow the scrims switch (owner 2026-11-08)', () => {
  it('a direct scrim booking needs scrims open to the player, not just teams', () => {
    const f = published();
    setSetting(f.db, 'map_pool', JSON.stringify(['no_mercy']));
    const t1 = teamOf(f, f.entries[0]!)!;
    const t2 = teamOf(f, f.entries[1]!)!;
    const START = new Date(NOW.getTime() + 26 * 3_600_000).toISOString();
    setSetting(f.db, 'scrims_enabled', 'admins');
    expect(err(createBooking(f.db, { by: t1.captain_steamid, teamId: t1.id, opponent: { teamId: t2.id }, startsAt: START, playlist: ['no_mercy'], now: NOW }))).toBe('not_open');
  });
});

describe('late signup', () => {
  const closed = () => {
    const f = draftFixture();
    for (const s of P.slice(0, 12)) must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now: NOW }));
    must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    return f;
  };
  const roles = (f: DraftFixture) => f.db.prepare('SELECT steamid, role FROM draft_signups WHERE event_id = ? ORDER BY id').all(f.eventId);

  it('adds the player to the bench after the close and moves nobody else', () => {
    const f = closed();
    const before = roles(f);
    must(D.addLateSignup(f.db, { eventId: f.eventId, steamid: P[12]!, captainPref: 'no', actor: ADMIN, now: LATER }));
    expect(roles(f)).toEqual([...before, { steamid: P[12], role: 'bench' }]);
  });

  it('refuses before the close, after the cut is published, and twice', () => {
    const open = draftFixture();
    expect(err(D.addLateSignup(open.db, { eventId: open.eventId, steamid: P[0]!, captainPref: 'no', actor: ADMIN, now: NOW }))).toBe('not_closed');
    const f = closed();
    expect(err(D.addLateSignup(f.db, { eventId: f.eventId, steamid: P[0]!, captainPref: 'no', actor: ADMIN, now: NOW }))).toBe('already_signed_up');
    const g = cutDraft();
    expect(err(D.addLateSignup(g.db, { eventId: g.eventId, steamid: ADMIN, captainPref: 'no', actor: ADMIN, now: NOW }))).toBe('cut_published');
  });
});
