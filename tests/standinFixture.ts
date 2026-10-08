import type { DB } from '../src/db.js';
import * as D from '../src/events/drafts.js';
import * as N from '../src/events/entries.js';
import * as ST from '../src/events/standins.js';
import { startEventFlow } from '../src/events/flow.js';
import { ADMIN, NOW, must } from './eventFixture.js';
import { P, draftFixture, type DraftFixture } from './draftFixture.js';
import { A, B as BATS } from './entryFixture.js';
import type { RoomFixture } from './roomFixture.js';

/** Plan D3a: 21 signups a second apart in P order, 4 teams. Captains are the
 *  top four by SR (P[17..20]), the pool P[0..11] is auto-balanced onto them
 *  and published, and the bench is P[12..16] (SR 1300, 1325, 1350, 1375,
 *  1400). The event stays in registration with its teams made. */
export interface StandinFixture extends DraftFixture { entries: number[] }
export const BENCH = P.slice(12, 17);

export function standinFixture(): StandinFixture {
  const f = draftFixture();
  P.forEach((s, i) => must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now: new Date(NOW.getTime() + i * 1000) })));
  must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  must(D.setDraftTeams(f.db, { eventId: f.eventId, teams: 4, actor: ADMIN, now: NOW }));
  must(D.pickCaptains(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  must(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'auto', actor: ADMIN, now: NOW }));
  must(D.autoBalance(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  const { entries } = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  return { ...f, entries };
}

/** standinFixture with the event started by staff: round 1 matches waiting. */
export async function liveStandins(): Promise<StandinFixture> {
  const f = standinFixture();
  must(await startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
  return f;
}

/** The active entry this player is a starter or sub of. */
export const entryOf = (f: { db: DB; eventId: number }, steamid: string): N.EntryRow => N.entryOfPlayer(f.db, f.eventId, steamid)!;

/** The room fixture's two team entries made into draft entries (test setup
 *  only, as tests/draftReplace.test.ts does): no site team, a captain each,
 *  A[4] (a team sub) off the roster, the event a draft with teams made. */
export function asDraft(f: RoomFixture): void {
  f.db.prepare("UPDATE events SET entry_kind = 'draft', teams_made_at = ? WHERE id = ?").run(NOW.toISOString(), f.eventId);
  f.db.prepare('UPDATE event_entries SET team_id = NULL, captain_steamid = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)')
    .run(f.entryA, A[0], BATS[0], f.entryA, f.entryB);
  f.db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE entry_id = ? AND steamid = ?').run(NOW.toISOString(), f.entryA, A[4]);
}

/** A bench signup (test setup only: the room fixture's event had no signups). */
export function benchOn(db: DB, eventId: number, steamid: string): void {
  db.prepare("INSERT INTO draft_signups (event_id, steamid, captain_pref, created_at, role) VALUES (?, ?, 'no', ?, 'bench')").run(eventId, steamid, NOW.toISOString());
}

/** A staff request for `out` with the SR limit off and its first offer made,
 *  as the flow would. */
export function offeredFor(f: { db: DB; eventId: number }, entryId: number, out: string, scope: ST.StandinScope = 'match', now: Date = NOW): { requestId: number; offerId: number; steamid: string } {
  const { requestId } = must(ST.requestStandin(f.db, { eventId: f.eventId, entryId, out, scope, by: ADMIN, staff: true, now }));
  must(ST.setStandinMarginOff(f.db, { requestId, actor: ADMIN, now }));
  const step = must(ST.offerNextStandin(f.db, { requestId, now, minutes: 10 }));
  return { requestId, offerId: step.offerId!, steamid: step.offered! };
}
