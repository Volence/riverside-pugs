import type { DB } from '../src/db.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import * as P from '../src/events/play.js';
import { startEventFlow } from '../src/events/flow.js';
import type { RoomTimers } from '../src/events/room.js';
import { ADMIN, NOW } from './eventFixture.js';
import { entryFixture, rosterA, rosterB } from './entryFixture.js';

/** Rats (A) and Bats (B) entered in a live one-stage Swiss event played
 *  rolling, with their round 1 match waiting (plan T3a). Rats is seed 1 and
 *  entry_a. pool and veto overwrite the stage before it starts (test setup
 *  only; the stage editor is tested elsewhere). HTTP tests pass a startsAt
 *  relative to Date.now() and now = new Date(), as entryFixture explains. */
export interface RoomFixture { db: DB; eventId: number; stageId: number; matchId: number; entryA: number; entryB: number; slug: string }
export const TIMERS: RoomTimers = { readyMinutes: 10, stepSeconds: 60, lineupMinutes: 5 };
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
