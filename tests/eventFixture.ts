import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import * as E from '../src/events/events.js';

/** Shared by the event tests: a fixed clock, one admin, and a two-stage team
 *  event (Swiss top 8, then single elimination) starting nine days later. */
export const NOW = new Date('2026-10-01T12:00:00.000Z');
export const START = '2026-10-10T20:00:00.000Z';
export const ADMIN = '76561199000000700';

export function cupId(db: DB): number {
  return (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;
}

export function stageBody(db: DB, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'swiss', config: { rounds: 4 }, rulesetId: cupId(db), campaignPool: ['no_mercy', 'dead_air'], advanceCount: 8, ...over };
}

export function must<T>(r: E.EventResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
}

export interface Fixture { db: DB; eventId: number; s1: number; s2: number }

export function eventFixture(status: 'draft' | 'announced' = 'draft'): Fixture {
  const db = openDb(':memory:');
  upsertPlayer(db, { steamid: ADMIN, name: 'boss', avatar: null }, []);
  const ev = must(E.createEvent(db, { by: ADMIN, fields: { name: 'Riverside Cup', startsAt: START, entryKind: 'team' }, now: NOW }));
  const s1 = must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: stageBody(db), now: NOW }));
  const s2 = must(E.addStage(db, {
    eventId: ev.id, by: ADMIN, stage: stageBody(db, { type: 'single_elim', config: { thirdPlace: true }, advanceCount: null }), now: NOW,
  }));
  if (status === 'announced') must(E.publishEvent(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  return { db, eventId: ev.id, s1: s1.id, s2: s2.id };
}
