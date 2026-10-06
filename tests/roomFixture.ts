import type { DB } from '../src/db.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import * as P from '../src/events/play.js';
import { startEventFlow } from '../src/events/flow.js';
import * as R from '../src/events/room.js';
import type { RoomTimers } from '../src/events/room.js';
import { currentSeasonId } from '../src/players.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B, entryFixture, rosterA, rosterB } from './entryFixture.js';

/** Rats (A) and Bats (B) entered in a live one-stage Swiss event played
 *  rolling, with their round 1 match waiting (plan T3a). Rats is seed 1 and
 *  entry_a. pool and veto overwrite the stage before it starts (test setup
 *  only; the stage editor is tested elsewhere). HTTP tests pass a startsAt
 *  relative to Date.now() and now = new Date(), as entryFixture explains. */
export interface RoomFixture { db: DB; eventId: number; stageId: number; matchId: number; entryA: number; entryB: number; slug: string }
export const TIMERS: RoomTimers = { readyMinutes: 10, stepSeconds: 60, lineupMinutes: 5, confirmMinutes: 15 };
/** Seven campaigns poolable in a fresh database (checked with
 *  poolableCampaigns(openDb(':memory:')) on 2026-10-06). */
export const POOL7 = ['no_mercy', 'dead_air', 'death_toll', 'blood_harvest', 'dead_center', 'dark_carnival', 'swamp_fever'];

export async function roomFixture(o: { veto?: object; pool?: string[]; startsAt?: string; now?: Date } = {}): Promise<RoomFixture> {
  const now = o.now ?? NOW;
  const f = entryFixture({ checkin: false, startsAt: o.startsAt });
  const reg = (teamId: number, by: string, roster: object) => {
    const r = N.registerEntry(f.db, { eventId: f.eventId, teamId, by, roster, now });
    if (!r.ok) throw new Error(r.error);
    return r.value.entry.id;
  };
  const entryA = reg(f.teamA, '76561199000000801', rosterA());
  reg(f.teamB, '76561199000000811', rosterB());
  const stageId = E.stagesOf(f.db, f.eventId)[0]!.id;
  if (o.pool) f.db.prepare('UPDATE event_stages SET campaign_pool_json = ? WHERE id = ?').run(JSON.stringify(o.pool), stageId);
  if (o.veto) f.db.prepare('UPDATE event_stages SET veto_json = ? WHERE id = ?').run(JSON.stringify(o.veto), stageId);
  const lock = N.lockEntries(f.db, { eventId: f.eventId, by: ADMIN, now });
  if (!lock.ok) throw new Error(lock.error);
  // lockEntries seeds by SR; pin Rats as seed 1 (test setup only).
  f.db.prepare('UPDATE event_entries SET seed = CASE id WHEN ? THEN 1 ELSE 2 END WHERE event_id = ?').run(entryA, f.eventId);
  const started = await startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now });
  if (!started.ok) throw new Error(started.error);
  const m = P.matchesOf(f.db, stageId).find((x) => x.status === 'waiting')!;
  return { db: f.db, eventId: f.eventId, stageId, matchId: m.id, entryA: m.entry_a!, entryB: m.entry_b!, slug: E.getEvent(f.db, f.eventId)!.slug };
}

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };

/** The default ban to one driven to both lineups locked (plan T3b): status
 *  booking, game 1 no_mercy, Rats (a) survive first. openRoom at NOW, both
 *  Ready at + 1 min, the veto at + 2, both lineups at + 4. */
export function driveToBooking(f: RoomFixture): void {
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
  must(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
  for (const steamid of [A[0]!, B[0]!]) must(R.readyUp(f.db, { matchId: f.matchId, steamid, timers: TIMERS, now: at(1) }));
  const steps: [string, number, string, string | null][] = [[A[0]!, 0, 'first', null], [A[0]!, 1, 'ban', 'dead_air'], [B[0]!, 2, 'survivors', null]];
  for (const [steamid, step, action, campaign] of steps) {
    must(R.actVeto(f.db, { matchId: f.matchId, steamid, step, action, campaign, timers: TIMERS, now: at(2) }));
  }
  must(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0]!, steamids: A.slice(0, 4), timers: TIMERS, now: at(4) }));
  must(R.lockLineup(f.db, { matchId: f.matchId, steamid: B[0]!, steamids: B.slice(0, 4), timers: TIMERS, now: at(4) }));
}

/** A minimal tournament booking row (event_matches.booking_id is a foreign key). Test setup only. */
export function fakeBooking(f: RoomFixture, at: Date): number {
  return Number(f.db.prepare(
    `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES ('tournament', 'na', ?, ?, 'p', 't', 'standard', '{}', '["no_mercy"]', ?, ?)`,
  ).run(at.toISOString(), new Date(at.getTime() + 90 * 60_000).toISOString(), ADMIN, at.toISOString()).lastInsertRowid);
}

/** A minimal live matches row (event_games.match_id is a foreign key). Test setup only. */
export function fakeMatch(f: RoomFixture): number {
  return Number(f.db.prepare("INSERT INTO matches (season_id, state, campaign, kind) VALUES (?, 'live', 'no_mercy', 'tournament')").run(currentSeasonId(f.db)).lastInsertRowid);
}

/** The same room in a window stage (plan T4): the match waits with a
 *  window of a week from NOW and no time yet, so captains may propose. */
export async function windowFixture(o: Parameters<typeof roomFixture>[0] & { from?: Date; to?: Date } = {}): Promise<RoomFixture> {
  const f = await roomFixture(o);
  const from = o.from ?? o.now ?? NOW;
  const to = o.to ?? new Date(from.getTime() + 7 * 86_400_000);
  f.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(f.stageId);
  f.db.prepare('UPDATE event_matches SET window_start = ?, window_end = ? WHERE stage_id = ?').run(from.toISOString(), to.toISOString(), f.stageId);
  return f;
}
