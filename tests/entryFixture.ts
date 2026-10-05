import { openDb, type DB } from '../src/db.js';
import { activatePlayer, upsertPlayer } from '../src/players.js';
import * as T from '../src/teams/teams.js';
import * as E from '../src/events/events.js';
import { ADMIN, NOW, START, must, stageBody } from './eventFixture.js';

/** Two teams of eligible players and an event in registration (plan T1b).
 *  Team A: captain a[0], co-captain a[1], members a[2..5]. Team B: captain
 *  b[0], members b[1..4]. OUTSIDER is active and eligible but on no team.
 *  Everyone has Discord linked; the event asks for no PUGs so nobody needs a
 *  match history unless a test gives eligibility rules of its own. */
export const A = ['801', '802', '803', '804', '805', '806'].map((n) => `76561199000000${n}`);
export const B = ['811', '812', '813', '814', '815'].map((n) => `76561199000000${n}`);
export const OUTSIDER = '76561199000000820';

export interface EntryFixture { db: DB; eventId: number; teamA: number; teamB: number }

/** startsAt defaults to the fixed START. Tests that go through HTTP run on the
 *  wall clock (the routes pass no `now`), so they must pass a start relative
 *  to Date.now(): a fixed date would make them fail once it passes, as the
 *  scrim and booking route tests did on 2026-10-02. */
export function entryFixture(o: { checkin?: boolean; teamCap?: number | null; eligibility?: object; roster?: object; startsAt?: string } = {}): EntryFixture {
  const db = openDb(':memory:');
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  upsertPlayer(db, { steamid: ADMIN, name: 'boss', avatar: null }, [ADMIN]);
  [...A, ...B, OUTSIDER].forEach((s, i) => {
    upsertPlayer(db, { steamid: s, name: `p${i}`, avatar: null }, []);
    activatePlayer(db, s);
    db.prepare('UPDATE players SET discord_id = ? WHERE steamid = ?').run(`d${i}`, s);
  });
  const team = (members: string[], name: string, tag: string): number => {
    const t = T.createTeam(db, { creator: members[0], name, tag, now: NOW });
    if (!t.ok) throw new Error(t.error);
    const link = T.setJoinLink(db, { teamId: t.value.id, by: members[0], on: true });
    if (!link.ok || !link.value.token) throw new Error('no join link');
    for (const m of members.slice(1)) {
      const j = T.joinByLink(db, { token: link.value.token, steamid: m, now: NOW });
      if (!j.ok) throw new Error(j.error);
    }
    return t.value.id;
  };
  const teamA = team(A, 'Rats', 'RAT');
  const teamB = team(B, 'Bats', 'BAT');
  const r = T.setRole(db, { teamId: teamA, by: A[0], target: A[1], role: 'cocaptain' });
  if (!r.ok) throw new Error(r.error);

  const ev = must(E.createEvent(db, {
    by: ADMIN, now: NOW,
    fields: {
      name: 'Riverside Cup', startsAt: o.startsAt ?? START, entryKind: 'team', teamCap: null,
      eligibility: o.eligibility ?? { minPugs: 0, requireDiscord: true },
      checkin: { enabled: o.checkin ?? true, opensMinutes: 60, closesMinutes: 15 },
      roster: o.roster ?? { maxSubs: 2 },
    },
  }));
  // createEvent validates teamCap at 2..256 (a real event always has room to
  // wait-list someone); a few lockEntries tests want a cap of 1 to see the
  // waitlist with just two entries, so it is set directly here, past that
  // user-facing rule, for test setup only.
  if (o.teamCap !== undefined && o.teamCap !== null) db.prepare('UPDATE events SET team_cap = ? WHERE id = ?').run(o.teamCap, ev.id);
  must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: stageBody(db, { advanceCount: null }), now: NOW }));
  must(E.publishEvent(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  must(E.openRegistration(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  return { db, eventId: ev.id, teamA, teamB };
}

export const rosterA = (over: object = {}) => ({ starters: A.slice(0, 4), subs: [A[4]], coach: null, ...over });
export const rosterB = (over: object = {}) => ({ starters: B.slice(0, 4), subs: [], coach: null, ...over });

/** A third team of four fresh eligible players (captain first), for tests
 *  that need more than two entries. */
export const C = ['821', '822', '823', '824'].map((n) => `76561199000000${n}`);
export function addTeamC(f: EntryFixture): number {
  C.forEach((s, i) => {
    upsertPlayer(f.db, { steamid: s, name: `c${i}`, avatar: null }, []);
    activatePlayer(f.db, s);
    f.db.prepare('UPDATE players SET discord_id = ? WHERE steamid = ?').run(`dc${i}`, s);
  });
  const t = T.createTeam(f.db, { creator: C[0], name: 'Cats', tag: 'CAT', now: NOW });
  if (!t.ok) throw new Error(t.error);
  const link = T.setJoinLink(f.db, { teamId: t.value.id, by: C[0], on: true });
  if (!link.ok || !link.value.token) throw new Error('no join link');
  for (const m of C.slice(1)) {
    const j = T.joinByLink(f.db, { token: link.value.token, steamid: m, now: NOW });
    if (!j.ok) throw new Error(j.error);
  }
  return t.value.id;
}
export const rosterC = () => ({ starters: [...C], subs: [], coach: null });
