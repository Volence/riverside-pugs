import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import * as E from '../src/events/events.js';
import { ADMIN, NOW, START, must, stageBody } from './eventFixture.js';

/** A published team event whose entry list is final (status checkin,
 *  locked_at set) with `entries` checked-in entries seeded 1..N in id order.
 *  Entries are inserted directly: these tests are about play, not
 *  registration (tests/entries.test.ts covers that). Stage bodies are passed
 *  through stageBody, so each needs only what differs from a Swiss stage. */
export interface PlayFixture { db: DB; eventId: number; stages: number[]; entries: number[] }

export function playFixture(o: { stages: Record<string, unknown>[]; entries: number }): PlayFixture {
  const db = openDb(':memory:');
  upsertPlayer(db, { steamid: ADMIN, name: 'boss', avatar: null }, []);
  db.prepare("UPDATE players SET is_admin = 1, status = 'active' WHERE steamid = ?").run(ADMIN);
  const ev = must(E.createEvent(db, { by: ADMIN, fields: { name: 'Play Cup', startsAt: START, entryKind: 'team' }, now: NOW }));
  for (const s of o.stages) must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: stageBody(db, s), now: NOW }));
  must(E.publishEvent(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  must(E.openRegistration(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  db.prepare("UPDATE events SET status = 'checkin', locked_at = ? WHERE id = ?").run(NOW.toISOString(), ev.id);
  const ins = db.prepare(
    "INSERT INTO event_entries (event_id, name, tag, seed, status, registered_by, created_at) VALUES (?, ?, ?, ?, 'checked_in', ?, ?)",
  );
  const entries = Array.from({ length: o.entries }, (_, i) =>
    Number(ins.run(ev.id, `Team ${i + 1}`, `T${i + 1}`, i + 1, ADMIN, NOW.toISOString()).lastInsertRowid));
  return { db, eventId: ev.id, stages: E.stagesOf(db, ev.id).map((s) => s.id), entries };
}

export const SWISS = (rounds: number, advanceCount: number | null) => ({ type: 'swiss', config: { rounds }, advanceCount });
export const SE = (thirdPlace = false) => ({ type: 'single_elim', config: { thirdPlace }, advanceCount: null });
export const DE = (grandFinalReset = true) => ({ type: 'double_elim', config: { grandFinalReset }, advanceCount: null });
export const RR = (groups: number, advanceCount: number | null) => ({ type: 'round_robin', config: { groups }, advanceCount });
export const LEAGUE = (matches: number, matchesPerWeek: number, pairing: 'swiss' | 'round_robin', advanceCount: number | null, seasonStart: string | null = null) =>
  ({ type: 'league', config: { matches, matchesPerWeek, pairing, seasonStart }, scheduling: 'window', advanceCount });
