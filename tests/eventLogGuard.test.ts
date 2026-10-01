import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../src/events/events.js';
import { ADMIN, NOW, START, eventFixture, stageBody, type Fixture } from './eventFixture.js';

/**
 * Spec, Error handling: every event state change is one transaction with an
 * audit row. Three guards hold that:
 *  1. only src/events/events.ts writes events, event_stages or event_log;
 *  2. each exported mutation, on success, adds exactly one event_log row
 *     with its action, and when that row cannot be written nothing else is
 *     written either (an event_log trigger that always fails);
 *  3. every exported function of events.ts is either a known read or listed
 *     in MUTATIONS here, so a new mutation cannot skip guard 2.
 */

const WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:events|event_stages|event_log)\b/g;
const READS = new Set(['getEvent', 'getEventBySlug', 'getStage', 'stagesOf', 'eventLog', 'fieldsOf', 'stageSettingsOf', 'stageContext']);

const MUTATIONS: Record<string, { from: 'draft' | 'announced'; action: string; run: (f: Fixture) => E.EventResult<unknown> }> = {
  createEvent: { from: 'draft', action: 'created', run: ({ db }) => E.createEvent(db, { by: ADMIN, fields: { name: 'Second Cup', startsAt: START, entryKind: 'team' }, now: NOW }) },
  updateEvent: { from: 'draft', action: 'edited', run: ({ db, eventId }) => E.updateEvent(db, { eventId, by: ADMIN, fields: { name: 'Renamed Cup' }, now: NOW }) },
  addStage: { from: 'draft', action: 'stage_added', run: ({ db, eventId }) => E.addStage(db, { eventId, by: ADMIN, stage: stageBody(db), now: NOW }) },
  updateStage: {
    from: 'draft', action: 'stage_edited',
    run: ({ db, eventId, s2 }) => E.updateStage(db, { eventId, stageId: s2, by: ADMIN, stage: stageBody(db, { type: 'double_elim', config: {}, advanceCount: null }), now: NOW }),
  },
  removeStage: { from: 'draft', action: 'stage_removed', run: ({ db, eventId, s2 }) => E.removeStage(db, { eventId, stageId: s2, by: ADMIN, now: NOW }) },
  reorderStages: { from: 'draft', action: 'stages_reordered', run: ({ db, eventId, s1, s2 }) => E.reorderStages(db, { eventId, by: ADMIN, order: [s2, s1], now: NOW }) },
  publishEvent: { from: 'draft', action: 'published', run: ({ db, eventId }) => E.publishEvent(db, { eventId, by: ADMIN, now: NOW }) },
  openRegistration: { from: 'announced', action: 'registration_opened', run: ({ db, eventId }) => E.openRegistration(db, { eventId, by: ADMIN, now: NOW }) },
  cancelEvent: { from: 'draft', action: 'cancelled', run: ({ db, eventId }) => E.cancelEvent(db, { eventId, by: ADMIN, reason: 'Not enough teams', now: NOW }) },
};

const logCount = (f: Fixture) => (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
const snapshot = (f: Fixture) => JSON.stringify([
  f.db.prepare('SELECT * FROM events ORDER BY id').all(),
  f.db.prepare('SELECT * FROM event_stages ORDER BY id').all(),
]);

describe('event_log guard', () => {
  it('only src/events/events.ts writes the event tables', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));
    const offenders = walk('src')
      .filter((f) => f !== 'src/events/events.ts')
      .filter((f) => (readFileSync(join(root, f), 'utf8').match(WRITERS) ?? []).length > 0);
    expect(offenders).toEqual([]);
  });

  it('every exported function of events.ts is a known read or a guarded mutation', () => {
    const fns = Object.entries(E).filter(([, v]) => typeof v === 'function').map(([k]) => k);
    expect(fns.filter((k) => !READS.has(k)).sort()).toEqual(Object.keys(MUTATIONS).sort());
  });

  for (const [name, m] of Object.entries(MUTATIONS)) {
    it(`${name} writes exactly one event_log row, ${m.action}`, () => {
      const f = eventFixture(m.from);
      const before = logCount(f);
      const r = m.run(f);
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      expect(logCount(f)).toBe(before + 1);
      expect(f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action, actor: ADMIN });
    });

    it(`${name} writes nothing when its event_log row cannot be written`, () => {
      const f = eventFixture(m.from);
      const before = snapshot(f);
      const logs = logCount(f);
      f.db.exec("CREATE TRIGGER event_log_down BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'event_log down'); END");
      expect(() => m.run(f)).toThrow(/event_log down/);
      expect(snapshot(f)).toBe(before);
      expect(logCount(f)).toBe(logs);
    });
  }
});
