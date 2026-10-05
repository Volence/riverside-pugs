import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import * as P from '../src/events/play.js';
import * as V from '../src/events/validate.js';
import { createBracket } from '../src/events/bracket.js';
import { ADMIN, NOW, START, eventFixture, stageBody, type Fixture } from './eventFixture.js';
import { A, entryFixture, rosterA, type EntryFixture } from './entryFixture.js';
import { SE, SWISS, playFixture, type PlayFixture } from './playFixture.js';

/**
 * Spec, Error handling: every event state change is one transaction with an
 * audit row. Three guards hold that:
 *  1. only src/events/events.ts writes events, event_stages or event_log;
 *  2. each exported mutation, on success, adds exactly one event_log row
 *     with its action, and when that row cannot be written nothing else is
 *     written either (an event_log trigger that always fails);
 *  3. every exported function of events.ts is either a known read, listed
 *     in MUTATIONS here, or one of the SPECIAL cases below with its own
 *     test, so a new mutation cannot skip guard 2.
 *
 * deleteDraftEvent is the one special case: it removes a draft's event_log
 * rows along with the draft, so it cannot add one. Its guard instead is that
 * it leaves no row of the event behind in any table, touches no other event,
 * and writes nothing at all when any of its deletes fails.
 */

const WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:events|event_stages|event_log)\b/gi;
const ENTRY_WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:event_entries|event_entry_players)\b/gi;
const ENGINE = new Set(['src/events/events.ts', 'src/events/entries.ts', 'src/events/play.ts']);
const READS = new Set(['getEvent', 'getEventBySlug', 'getStage', 'stagesOf', 'eventLog', 'fieldsOf', 'stageSettingsOf', 'stageContext']);
/** Exported for entries.ts to write its own audit row; never a mutation itself. */
const HELPERS = new Set(['logEvent']);

const MUTATIONS: Record<string, { from: 'draft' | 'announced' | 'registration'; action: string; run: (f: Fixture) => E.EventResult<unknown> }> = {
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
  cancelEvent: { from: 'announced', action: 'cancelled', run: ({ db, eventId }) => E.cancelEvent(db, { eventId, by: ADMIN, reason: 'Not enough teams', now: NOW }) },
  setEventBanner: { from: 'announced', action: 'banner_set', run: ({ db, eventId }) => E.setEventBanner(db, { eventId, by: ADMIN, bannerKey: 'a'.repeat(64), now: NOW }) },
  openCheckin: { from: 'registration', action: 'checkin_opened', run: ({ db, eventId }) => E.openCheckin(db, { eventId, by: ADMIN, now: NOW }) },
};

const SPECIAL = new Set(['deleteDraftEvent']);

const logCount = (f: { db: Fixture['db'] }) => (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
const actionCount = (f: { db: Fixture['db'] }, action: string) =>
  (f.db.prepare('SELECT COUNT(*) AS n FROM event_log WHERE action = ?').get(action) as { n: number }).n;
const snapshot = (f: Fixture) => JSON.stringify([
  f.db.prepare('SELECT * FROM events ORDER BY id').all(),
  f.db.prepare('SELECT * FROM event_stages ORDER BY id').all(),
]);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));

describe('event_log guard', () => {
  it('only src/events/events.ts, entries.ts and play.ts write the event tables', () => {
    const offenders = walk('src')
      .filter((f) => !ENGINE.has(f))
      .filter((f) => (readFileSync(join(root, f), 'utf8').match(WRITERS) ?? []).length > 0);
    expect(offenders).toEqual([]);
    // Lower case SQL counts as a write too.
    expect('delete from event_log where 1'.match(WRITERS)).toHaveLength(1);
  });

  it('only src/events/entries.ts (and the account merge) writes the entry tables', () => {
    const offenders = walk('src')
      .filter((f) => f !== 'src/events/entries.ts' && f !== 'src/events/play.ts' && f !== 'src/mergePlayers.ts')
      .filter((f) => (readFileSync(join(root, f), 'utf8').match(ENTRY_WRITERS) ?? []).length > 0);
    expect(offenders).toEqual([]);
  });

  it('every exported function of events.ts is a known read, helper, or a guarded mutation', () => {
    const fns = Object.entries(E).filter(([, v]) => typeof v === 'function').map(([k]) => k);
    expect(fns.filter((k) => !READS.has(k) && !SPECIAL.has(k) && !HELPERS.has(k)).sort()).toEqual(Object.keys(MUTATIONS).sort());
    expect(fns.filter((k) => SPECIAL.has(k)).sort()).toEqual([...SPECIAL].sort());
    expect(fns.filter((k) => HELPERS.has(k)).sort()).toEqual([...HELPERS].sort());
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

  describe('deleteDraftEvent (special case)', () => {
    const allRows = (f: Fixture) => JSON.stringify([
      f.db.prepare('SELECT * FROM events ORDER BY id').all(),
      f.db.prepare('SELECT * FROM event_stages ORDER BY id').all(),
      f.db.prepare('SELECT * FROM event_log ORDER BY id').all(),
    ]);
    const withOther = () => {
      const f = eventFixture('draft');
      const other = E.createEvent(f.db, { by: ADMIN, fields: { name: 'Other Cup', startsAt: START, entryKind: 'team' }, now: NOW });
      if (!other.ok) throw new Error(other.error);
      return { f, otherId: other.value.id };
    };

    it('leaves no row of the draft in any event table, and no orphan anywhere', () => {
      const { f, otherId } = withOther();
      const otherLog = f.db.prepare('SELECT * FROM event_log WHERE event_id = ?').all(otherId);
      expect(E.deleteDraftEvent(f.db, { eventId: f.eventId, by: ADMIN }).ok).toBe(true);
      for (const t of ['event_stages', 'event_log', 'event_entries']) {
        const orphans = f.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE event_id NOT IN (SELECT id FROM events)`).get();
        expect(orphans, t).toEqual({ n: 0 });
      }
      expect(f.db.prepare('SELECT id FROM events').all()).toEqual([{ id: otherId }]);
      expect(f.db.prepare('SELECT * FROM event_log WHERE event_id = ?').all(otherId)).toEqual(otherLog);
    });

    for (const table of ['event_log', 'event_stages', 'events']) {
      it(`writes nothing when deleting from ${table} fails`, () => {
        const f = eventFixture('draft');
        const before = allRows(f);
        f.db.exec(`CREATE TRIGGER ${table}_down BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} down'); END`);
        expect(() => E.deleteDraftEvent(f.db, { eventId: f.eventId, by: ADMIN })).toThrow(new RegExp(`${table} down`));
        expect(allRows(f)).toBe(before);
      });
    }
  });

  /** Same two guards as above, over src/events/entries.ts (tournaments plan
   *  T1b). Task 4 adds openCheckin to the events table here and the rest of
   *  entries' mutations to ENTRY_MUTATIONS. */
  describe('entries guard (src/events/entries.ts)', () => {
    const must = <T>(r: V.Checked<T>): T => {
      if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
      return r.value;
    };
    const ENTRY_READS = new Set([
      'getEntry', 'entriesOf', 'placesOf', 'rosterOf', 'entryOfTeam', 'entryOfPlayer',
      'placementOf', 'managersOf', 'playerFacts', 'entrySr', 'isActive', 'disqualifiedSlotHeld',
    ]);
    // Cached per fixture so a test that pre-registers to snapshot "after
    // setup, before the mutation" does not make the mutation's own internal
    // registered(f) call register the team a second time.
    const registeredCache = new WeakMap<EntryFixture, number>();
    const registered = (f: EntryFixture): number => {
      const cached = registeredCache.get(f);
      if (cached !== undefined) return cached;
      const id = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry.id;
      registeredCache.set(f, id);
      return id;
    };
    // Same reasoning as registeredCache: restoreEntry's and reorderSeeds'
    // run() each do real, committing entries-table writes (disqualify; or
    // check-in + lock) beyond plain registration. Without memoizing those
    // too, the "writes nothing" test's needsEntry pre-step (which only
    // replays registered(f)) would leave the "before" snapshot stale, and
    // run()'s own replay of those steps would commit for real before the
    // final (blocked) call, so entryRows would no longer match "before".
    const disqualifiedCache = new WeakMap<EntryFixture, number>();
    const disqualified = (f: EntryFixture): number => {
      const cached = disqualifiedCache.get(f);
      if (cached !== undefined) return cached;
      const id = registered(f);
      must(N.disqualifyEntry(f.db, { entryId: id, by: A[0], reason: null, now: NOW }));
      disqualifiedCache.set(f, id);
      return id;
    };
    const lockedCache = new WeakMap<EntryFixture, number>();
    const lockedIn = (f: EntryFixture): number => {
      const cached = lockedCache.get(f);
      if (cached !== undefined) return cached;
      const id = registered(f);
      must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW }));
      must(N.checkInEntry(f.db, { entryId: id, by: A[0], now: NOW }));
      must(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: NOW }));
      lockedCache.set(f, id);
      return id;
    };
    const ENTRY_MUTATIONS: Record<string, { action: string; needsEntry: boolean; setup?: (f: EntryFixture) => void; run: (f: EntryFixture) => V.Checked<unknown> }> = {
      registerEntry: {
        action: 'entry_registered', needsEntry: false,
        run: (f) => N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }),
      },
      setEntryRoster: {
        action: 'roster_changed', needsEntry: true,
        run: (f) => N.setEntryRoster(f.db, { entryId: registered(f), by: A[0], roster: rosterA({ subs: [] }), now: NOW }),
      },
      leaveEntry: {
        action: 'roster_left', needsEntry: true,
        run: (f) => N.leaveEntry(f.db, { entryId: registered(f), steamid: A[4], now: NOW }),
      },
      withdrawEntry: {
        action: 'entry_withdrawn', needsEntry: true,
        run: (f) => N.withdrawEntry(f.db, { entryId: registered(f), by: A[0], now: NOW }),
      },
      checkInEntry: { action: 'entry_checked_in', needsEntry: true, run: (f) => { const id = registered(f); must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW })); return N.checkInEntry(f.db, { entryId: id, by: A[0], now: NOW }); } },
      lockEntries: { action: 'entries_locked', needsEntry: true, run: (f) => { registered(f); must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW })); return N.lockEntries(f.db, { eventId: f.eventId, by: null, now: NOW }); } },
      dropDisbandedEntry: { action: 'entry_dropped', needsEntry: true, run: (f) => { const id = registered(f); f.db.prepare('UPDATE teams SET disbanded_at = ? WHERE id = ?').run(NOW.toISOString(), f.teamA); return N.dropDisbandedEntry(f.db, { entryId: id, now: NOW }); } },
      disqualifyEntry: { action: 'entry_disqualified', needsEntry: true, run: (f) => N.disqualifyEntry(f.db, { entryId: registered(f), by: A[0], reason: 'x', now: NOW }) },
      restoreEntry: {
        action: 'entry_restored', needsEntry: true, setup: (f) => { disqualified(f); },
        run: (f) => { const id = disqualified(f); return N.restoreEntry(f.db, { entryId: id, by: A[0], now: NOW }); },
      },
      reorderSeeds: {
        action: 'seeds_reordered', needsEntry: true, setup: (f) => { lockedIn(f); },
        run: (f) => { const id = lockedIn(f); return N.reorderSeeds(f.db, { eventId: f.eventId, by: A[0], order: [id], now: NOW }); },
      },
    };
    const entryRows = (f: EntryFixture) => JSON.stringify([
      f.db.prepare('SELECT * FROM event_entries ORDER BY id').all(),
      f.db.prepare('SELECT * FROM event_entry_players ORDER BY id').all(),
    ]);

    it('every exported function of entries.ts is a known read or a guarded mutation', () => {
      const fns = Object.entries(N).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !ENTRY_READS.has(k)).sort()).toEqual(Object.keys(ENTRY_MUTATIONS).sort());
    });

    for (const [name, m] of Object.entries(ENTRY_MUTATIONS)) {
      it(`${name} writes exactly one event_log row, ${m.action}`, () => {
        const f = entryFixture();
        const beforeAction = actionCount(f, m.action);
        const beforeTotal = logCount(f);
        const r = m.run(f);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(actionCount(f, m.action)).toBe(beforeAction + 1);
        // registerEntry has no setup of its own; for the others, the setup
        // (registered(f)) also logs its own entry_registered row first.
        if (name === 'registerEntry') expect(logCount(f)).toBe(beforeTotal + 1);
      });

      it(`${name} writes nothing when its event_log row cannot be written`, () => {
        const f = entryFixture();
        if (m.needsEntry) registered(f);
        m.setup?.(f);
        const before = entryRows(f);
        f.db.exec(
          `CREATE TRIGGER entry_log_down_${name} BEFORE INSERT ON event_log WHEN NEW.action = '${m.action}'
           BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
        );
        expect(() => m.run(f)).toThrow(/audit down/);
        expect(entryRows(f)).toBe(before);
      });
    }
  });

  /** Plan T2: src/events/play.ts is the only writer of event_matches, and
   *  its mutations follow the same one-row rule. */
  describe('play guard (src/events/play.ts)', () => {
    const MATCH_WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+event_matches\b/gi;
    const PLAY_READS = new Set(['getMatch', 'matchesOf', 'stageEntrants', 'stageBracket', 'activeSeeded', 'totalRounds']);
    const aWins = { winner: 'a' as const, scoreA: 10, scoreB: 5, forfeit: false };
    const ok = <T>(r: V.Checked<T>): T => { if (!r.ok) throw new Error(r.error); return r.value; };
    const plan = (f: PlayFixture): P.StagePlan => ({
      stageId: f.stages[0]!, entrants: f.entries, bracket: null,
      rounds: [{ round: 1, pairs: [[f.entries[0]!, f.entries[2]!], [f.entries[1]!, f.entries[3]!]], bye: null }],
    });
    const started = (f: PlayFixture) => ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: plan(f), now: NOW }));
    const allPlayed = (f: PlayFixture) => {
      for (const m of P.matchesOf(f.db, f.stages[0]!)) if (m.status === 'waiting') ok(P.recordResult(f.db, { matchId: m.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    };
    const PLAY_MUTATIONS: Record<string, { action: string; actor: string | null; setup: (f: PlayFixture) => void; run: (f: PlayFixture) => V.Checked<unknown> }> = {
      startEvent: { action: 'event_started', actor: ADMIN, setup: () => {}, run: (f) => P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: plan(f), now: NOW }) },
      recordResult: {
        action: 'result_recorded', actor: ADMIN, setup: started,
        run: (f) => P.recordResult(f.db, { matchId: P.matchesOf(f.db, f.stages[0]!)[0]!.id, by: ADMIN, result: aWins, bracket: null, now: NOW }),
      },
      addRound: {
        action: 'round_paired', actor: null, setup: (f) => { started(f); allPlayed(f); },
        run: (f) => P.addRound(f.db, { stageId: f.stages[0]!, round: { round: 2, pairs: [[f.entries[0]!, f.entries[1]!], [f.entries[2]!, f.entries[3]!]], bye: null }, now: NOW }),
      },
      finishStage: {
        action: 'stage_finished', actor: null, setup: (f) => { started(f); allPlayed(f); },
        run: (f) => P.finishStage(f.db, { stageId: f.stages[0]!, outcome: { ranks: f.entries.map((entryId, i) => ({ entryId, rank: i + 1 })), advance: [] }, next: null, now: NOW }),
      },
    };
    const fixture = () => playFixture({ stages: [SWISS(2, null)], entries: 4 });
    const rows = (f: PlayFixture) => JSON.stringify(['events', 'event_stages', 'event_entries', 'event_matches']
      .map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));

    it('only src/events/play.ts writes event_matches', () => {
      const offenders = walk('src').filter((f) => f !== 'src/events/play.ts')
        .filter((f) => (readFileSync(join(root, f), 'utf8').match(MATCH_WRITERS) ?? []).length > 0);
      expect(offenders).toEqual([]);
    });

    it('every exported function of play.ts is a known read or a guarded mutation', () => {
      const fns = Object.entries(P).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !PLAY_READS.has(k)).sort()).toEqual(Object.keys(PLAY_MUTATIONS).sort());
    });

    for (const [name, m] of Object.entries(PLAY_MUTATIONS)) {
      it(`${name} writes exactly one event_log row, ${m.action}`, () => {
        const f = fixture();
        m.setup(f);
        const before = logCount(f);
        const r = m.run(f);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(logCount(f)).toBe(before + 1);
        expect(f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action, actor: m.actor });
      });

      it(`${name} writes nothing when its event_log row cannot be written`, () => {
        const f = fixture();
        m.setup(f);
        const before = rows(f);
        f.db.exec(`CREATE TRIGGER play_log_down_${name} BEFORE INSERT ON event_log WHEN NEW.action = '${m.action}' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
        expect(() => m.run(f)).toThrow(/audit down/);
        expect(rows(f)).toBe(before);
      });
    }

    it('a bracket start and result write nothing either when the audit row fails', async () => {
      const f = playFixture({ stages: [SE()], entries: 4 });
      const bracket = await createBracket('single_elim', { thirdPlace: false }, f.entries);
      const before = rows(f);
      f.db.exec("CREATE TRIGGER bracket_log_down BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
      expect(() => P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: { stageId: f.stages[0]!, entrants: f.entries, bracket, rounds: [] }, now: NOW })).toThrow(/audit down/);
      expect(rows(f)).toBe(before);
    });
  });
});
