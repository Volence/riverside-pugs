import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import * as P from '../src/events/play.js';
import * as V from '../src/events/validate.js';
import * as R from '../src/events/room.js';
import * as S from '../src/events/schedule.js';
import { createBracket, reportResult } from '../src/events/bracket.js';
import { ADMIN, NOW, START, eventFixture, stageBody, type Fixture } from './eventFixture.js';
import { A, B, entryFixture, rosterA, type EntryFixture } from './entryFixture.js';
import { SE, SWISS, playFixture, type PlayFixture } from './playFixture.js';
import { POOL7, TIMERS, driveToBooking, fakeBooking, fakeMatch, roomFixture, windowFixture, type RoomFixture } from './roomFixture.js';
import { presetConfig } from '../src/events/vetoConfig.js';
import * as D from '../src/events/drafts.js';
import { P as DP, draftFixture, type DraftFixture } from './draftFixture.js';

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
const DRAFT_WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:draft_signups|draft_captain_offers)\b|\bUPDATE\s+events\s+SET\b[^'"`;]*\bteam_mode\s*=/gi;
/** events.teams_made_at is stamped by entries.ts alone (plan D2a Ruling 12),
 *  in the same transaction that creates the draft's entries. */
const TEAMS_MADE_WRITERS = /\bUPDATE\s+events\s+SET\b[^'"`;]*\bteams_made_at\s*=/gi;
const ENGINE = new Set(['src/events/events.ts', 'src/events/entries.ts', 'src/events/play.ts', 'src/events/drafts.ts']);
const READS = new Set(['getEvent', 'getEventBySlug', 'getStage', 'stagesOf', 'eventLog', 'fieldsOf', 'stageSettingsOf', 'stageContext', 'chainOf', 'scheduleOf']);
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
  setRoundSchedule: {
    from: 'draft', action: 'schedule_set',
    run: ({ db, eventId, s2 }) => E.setRoundSchedule(db, { eventId, stageId: s2, by: ADMIN, rounds: [{ round: 1, at: START }], now: NOW }),
  },
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
  it('only src/events/events.ts, entries.ts, play.ts and drafts.ts write the event tables', () => {
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
      'getEntry', 'identityOpen', 'identityRefusal', 'entriesOf', 'placesOf', 'rosterOf', 'entryOfTeam', 'entryOfPlayer',
      'placementOf', 'capOf', 'managersOf', 'entryManagers', 'playerFacts', 'entrySr', 'isActive', 'disqualifiedSlotHeld',
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

    /** Plan D2a: the mutations that run on a draft-kind event, each with its
     *  own setup over draftFixture. */
    const balancedDraft = (f: DraftFixture) => {
      for (const s of DP.slice(0, 8)) must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now: NOW }));
      must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
      for (const s of DP.slice(0, 2)) must(D.setCaptain(f.db, { eventId: f.eventId, steamid: s, captain: true, actor: ADMIN, now: NOW }));
      must(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
      must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'auto', actor: ADMIN, now: NOW }));
      must(D.autoBalance(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    };
    const DRAFT_ENTRY_MUTATIONS: Record<string, { action: string; setup: (f: DraftFixture) => void; run: (f: DraftFixture) => V.Checked<unknown> }> = {
      createDraftEntries: { action: 'draft_teams_published', setup: balancedDraft, run: (f) => N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }) },
      setEntryIdentity: {
        action: 'entry_identity_set',
        setup: (f) => { balancedDraft(f); must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW })); },
        run: (f) => N.setEntryIdentity(f.db, { eventId: f.eventId, entryId: (f.db.prepare('SELECT id FROM event_entries ORDER BY id LIMIT 1').get() as { id: number }).id, steamid: ADMIN, staff: true, name: 'Night Owls', tag: 'OWL', now: NOW }),
      },
    };

    it('every exported function of entries.ts is a known read or a guarded mutation', () => {
      const fns = Object.entries(N).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !ENTRY_READS.has(k)).sort()).toEqual([...Object.keys(ENTRY_MUTATIONS), ...Object.keys(DRAFT_ENTRY_MUTATIONS)].sort());
    });

    it('only src/events/entries.ts stamps events.teams_made_at', () => {
      const offenders = walk('src')
        .filter((f) => f !== 'src/events/entries.ts')
        .filter((f) => (readFileSync(join(root, f), 'utf8').match(TEAMS_MADE_WRITERS) ?? []).length > 0);
      expect(offenders).toEqual([]);
      expect((readFileSync(join(root, 'src/events/entries.ts'), 'utf8').match(TEAMS_MADE_WRITERS) ?? []).length).toBeGreaterThan(0);
      expect('update events set locked_at = ?, teams_made_at = ? where id = ?'.match(TEAMS_MADE_WRITERS)).toHaveLength(1);
      expect('SELECT teams_made_at FROM events WHERE teams_made_at IS NULL'.match(TEAMS_MADE_WRITERS)).toBeNull();
    });

    for (const [name, m] of Object.entries(DRAFT_ENTRY_MUTATIONS)) {
      const rows = (f: DraftFixture) => JSON.stringify([
        f.db.prepare('SELECT * FROM event_entries ORDER BY id').all(),
        f.db.prepare('SELECT * FROM event_entry_players ORDER BY id').all(),
        f.db.prepare('SELECT * FROM events ORDER BY id').all(),
      ]);
      it(`${name} writes exactly one event_log row, ${m.action}`, () => {
        const f = draftFixture();
        m.setup(f);
        const before = logCount(f);
        const r = m.run(f);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(logCount(f)).toBe(before + 1);
        expect(f.db.prepare('SELECT action FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action });
      });

      it(`${name} writes nothing when its event_log row cannot be written`, () => {
        const f = draftFixture();
        m.setup(f);
        const before = rows(f);
        const logs = logCount(f);
        f.db.exec(`CREATE TRIGGER entry_log_down_${name} BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
        expect(() => m.run(f)).toThrow(/audit down/);
        expect(rows(f)).toBe(before);
        expect(logCount(f)).toBe(logs);
      });
    }

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

  /** Drafts plan D1: src/events/drafts.ts is the only writer of the two
   *  draft tables (the account merge aside), and each of its mutations adds
   *  one event_log row or, when that row cannot be written, nothing. */
  describe('drafts guard (src/events/drafts.ts)', () => {
    const must = <T>(r: V.Checked<T>): T => {
      if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
      return r.value;
    };
    const DRAFT_READS = new Set(['activeSignups', 'signupOf', 'cutState', 'draftOfferMinutes', 'openOffer', 'draftTeamsOf']);
    const signed = (f: DraftFixture) => must(D.signUp(f.db, { eventId: f.eventId, steamid: DP[0], captainPref: 'want', note: 'n', now: NOW }));
    /** 12 signups, closed: 3 teams, 9 pool (DP[0..8]) and 3 bench (DP[9..11]). */
    const cut = (f: DraftFixture) => {
      for (const s of DP.slice(0, 12)) must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now: NOW }));
      must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    };
    /** 8 signups, 2 teams, both captains chosen: a publishable cut. */
    const publishable = (f: DraftFixture) => {
      for (const s of DP.slice(0, 8)) must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now: NOW }));
      must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
      for (const s of DP.slice(0, 2)) must(D.setCaptain(f.db, { eventId: f.eventId, steamid: s, captain: true, actor: ADMIN, now: NOW }));
    };
    /** D2a Task 3: the cut published (DP[0], DP[1] captains), then Auto-balance
     *  chosen, then the teams balanced. */
    const published = (f: DraftFixture) => { publishable(f); must(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW })); };
    const auto = (f: DraftFixture) => { published(f); must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'auto', actor: ADMIN, now: NOW })); };
    const balanced = (f: DraftFixture) => { auto(f); must(D.autoBalance(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW })); };
    const crossPair = (f: DraftFixture) => { const [t0, t1] = D.draftTeamsOf(f.db, f.eventId)!; return { a: t0!.players[0]!.steamid, b: t1!.players[0]!.steamid }; };
    /** Offers on, with DP[11]'s offer open until NOW + 30 minutes. */
    const offering = (f: DraftFixture) => { cut(f); must(D.startOffers(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW, minutes: 30 })); };
    const declined = (f: DraftFixture) => { offering(f); must(D.answerOffer(f.db, { eventId: f.eventId, steamid: DP[11], accept: false, now: NOW })); };
    const LATE = new Date(NOW.getTime() + 31 * 60_000);
    /** The two second paths of an offer mutation, each one row or nothing:
     *  an answer after expires_at records the expiry (and refuses the
     *  answer), and offerNext with nobody left turns offers off. */
    const SECOND_PATHS: Record<string, { action: string; setup: (f: DraftFixture) => void; run: (f: DraftFixture) => V.Checked<unknown>; ok: boolean }> = {
      'answerOffer after expires_at': {
        action: 'draft_offer_expired', setup: offering, ok: false,
        run: (f) => D.answerOffer(f.db, { eventId: f.eventId, steamid: DP[11], accept: true, now: LATE }),
      },
      'offerNext with the count met': {
        action: 'draft_offers_met', ok: true,
        setup: (f) => { offering(f); for (const s of [DP[0], DP[1], DP[2]]) must(D.setCaptain(f.db, { eventId: f.eventId, steamid: s, captain: true, actor: ADMIN, now: NOW })); must(D.stopOffers(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW })); f.db.prepare('UPDATE events SET offers_on = 1').run(); },
        run: (f) => D.offerNext(f.db, { eventId: f.eventId, now: NOW, minutes: 30 }),
      },
      'offerNext with nobody left': {
        action: 'draft_offers_exhausted', ok: true,
        setup: (f) => { declined(f); f.db.prepare("UPDATE draft_signups SET captain_pref = 'no'").run(); },
        run: (f) => D.offerNext(f.db, { eventId: f.eventId, now: NOW, minutes: 30 }),
      },
    };
    const DRAFT_MUTATIONS: Record<string, { action: string; setup?: (f: DraftFixture) => void; run: (f: DraftFixture) => V.Checked<unknown> }> = {
      signUp: { action: 'draft_signup', run: (f) => D.signUp(f.db, { eventId: f.eventId, steamid: DP[0], captainPref: 'want', note: 'n', now: NOW }) },
      withdrawSignup: { action: 'draft_withdraw', setup: signed, run: (f) => D.withdrawSignup(f.db, { eventId: f.eventId, steamid: DP[0], now: NOW }) },
      removeSignup: {
        action: 'draft_signup_removed', setup: signed,
        run: (f) => D.removeSignup(f.db, { eventId: f.eventId, steamid: DP[0], reason: 'removed', actor: ADMIN, now: NOW }),
      },
      closeSignups: { action: 'draft_signups_closed', setup: signed, run: (f) => D.closeSignups(f.db, { eventId: f.eventId, actor: null, now: NOW }) },
      setDraftTeams: { action: 'draft_teams_set', setup: cut, run: (f) => D.setDraftTeams(f.db, { eventId: f.eventId, teams: 2, actor: ADMIN, now: NOW }) },
      setCaptain: { action: 'draft_captain_set', setup: cut, run: (f) => D.setCaptain(f.db, { eventId: f.eventId, steamid: DP[0], captain: true, actor: ADMIN, now: NOW }) },
      pickCaptains: { action: 'draft_captains_picked', setup: cut, run: (f) => D.pickCaptains(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }) },
      swapPoolBench: { action: 'draft_swap', setup: cut, run: (f) => D.swapPoolBench(f.db, { eventId: f.eventId, poolSteamid: DP[0], benchSteamid: DP[11], actor: ADMIN, now: NOW }) },
      publishCut: { action: 'draft_cut_published', setup: publishable, run: (f) => D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }) },
      // Captaincy offers (Task 4). cut gives 12 willing signups, 3 teams and
      // no captains, so the first offer goes to the highest SR, DP[11].
      startOffers: { action: 'draft_offers_started', setup: cut, run: (f) => D.startOffers(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW, minutes: 30 }) },
      stopOffers: { action: 'draft_offers_stopped', setup: offering, run: (f) => D.stopOffers(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }) },
      answerOffer: { action: 'draft_offer_answered', setup: offering, run: (f) => D.answerOffer(f.db, { eventId: f.eventId, steamid: DP[11], accept: true, now: NOW }) },
      expireDueOffer: { action: 'draft_offer_expired', setup: offering, run: (f) => D.expireDueOffer(f.db, { eventId: f.eventId, now: LATE }) },
      offerNext: { action: 'draft_offer_made', setup: declined, run: (f) => D.offerNext(f.db, { eventId: f.eventId, now: NOW, minutes: 30 }) },
      // Make teams (D2a Task 3).
      chooseTeamMode: { action: 'draft_team_mode', setup: published, run: (f) => D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'auto', actor: ADMIN, now: NOW }) },
      autoBalance: { action: 'draft_teams_balanced', setup: auto, run: (f) => D.autoBalance(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }) },
      moveDraftPlayers: { action: 'draft_teams_swapped', setup: balanced, run: (f) => D.moveDraftPlayers(f.db, { eventId: f.eventId, ...crossPair(f), actor: ADMIN, now: NOW }) },
    };
    const draftRows = (f: DraftFixture) => JSON.stringify([
      f.db.prepare('SELECT * FROM draft_signups ORDER BY id').all(),
      f.db.prepare('SELECT * FROM draft_captain_offers ORDER BY id').all(),
      f.db.prepare('SELECT * FROM events ORDER BY id').all(),
    ]);

    it('only src/events/drafts.ts (and the account merge) writes the draft tables', () => {
      const offenders = walk('src')
        .filter((f) => f !== 'src/events/drafts.ts' && f !== 'src/mergePlayers.ts')
        .filter((f) => (readFileSync(join(root, f), 'utf8').match(DRAFT_WRITERS) ?? []).length > 0);
      expect(offenders).toEqual([]);
      expect('update draft_signups set x = 1'.match(DRAFT_WRITERS)).toHaveLength(1);
      expect('UPDATE events SET team_mode = ?, updated_at = ? WHERE id = ?'.match(DRAFT_WRITERS)).toHaveLength(1);
      expect("SELECT team_mode FROM events WHERE team_mode = 'auto'".match(DRAFT_WRITERS)).toBeNull();
    });

    it('every exported function of drafts.ts is a known read or a guarded mutation', () => {
      const fns = Object.entries(D).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !DRAFT_READS.has(k)).sort()).toEqual(Object.keys(DRAFT_MUTATIONS).sort());
    });

    for (const [name, m] of Object.entries(DRAFT_MUTATIONS)) {
      it(`${name} writes exactly one event_log row, ${m.action}`, () => {
        const f = draftFixture();
        m.setup?.(f);
        const before = logCount(f);
        const r = m.run(f);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(logCount(f)).toBe(before + 1);
        expect(f.db.prepare('SELECT action FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action });
      });

      it(`${name} writes nothing when its event_log row cannot be written`, () => {
        const f = draftFixture();
        m.setup?.(f);
        const before = draftRows(f);
        const logs = logCount(f);
        f.db.exec("CREATE TRIGGER draft_log_down BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
        expect(() => m.run(f)).toThrow(/audit down/);
        expect(draftRows(f)).toBe(before);
        expect(logCount(f)).toBe(logs);
      });
    }

    for (const [name, m] of Object.entries(SECOND_PATHS)) {
      it(`${name} writes exactly one event_log row, ${m.action}, or nothing`, () => {
        const f = draftFixture();
        m.setup(f);
        const before = logCount(f);
        expect(m.run(f).ok).toBe(m.ok);
        expect(logCount(f)).toBe(before + 1);
        expect(f.db.prepare('SELECT action FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action });
        const g = draftFixture();
        m.setup(g);
        const rows = draftRows(g);
        g.db.exec("CREATE TRIGGER draft_log_down BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
        expect(() => m.run(g)).toThrow(/audit down/);
        expect(draftRows(g)).toBe(rows);
      });
    }
  });

  /** Plan T2: src/events/play.ts is the only writer of event_matches, and
   *  its mutations follow the same one-row rule. */
  describe('play guard (src/events/play.ts)', () => {
    const MATCH_WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+event_matches\b/gi;
    const PLAY_READS = new Set(['getMatch', 'matchesOf', 'stageEntrants', 'stageBracket', 'activeSeeded', 'totalRounds', 'roundTimes']);
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
      applySchedule: {
        action: 'schedule_applied', actor: ADMIN, setup: started,
        run: (f) => P.applySchedule(f.db, { stageId: f.stages[0]!, by: ADMIN, now: NOW }),
      },
    };
    const fixture = () => playFixture({ stages: [SWISS(2, null)], entries: 4 });
    const rows = (f: PlayFixture) => JSON.stringify(['events', 'event_stages', 'event_entries', 'event_matches']
      .map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));

    it('only src/events/play.ts, room.ts and schedule.ts write event_matches', () => {
      const offenders = walk('src').filter((f) => f !== 'src/events/play.ts' && f !== 'src/events/room.ts' && f !== 'src/events/schedule.ts')
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

      // Same for recordResult's bracket branch: start for real (no trigger),
      // report one ready match's result through the library, then let the
      // audit row fail and check that the write (match row, bracket_json and
      // bracket_rev on event_stages included) never lands.
      const g = playFixture({ stages: [SE()], entries: 4 });
      const gBracket = await createBracket('single_elim', { thirdPlace: false }, g.entries);
      ok(P.startEvent(g.db, { eventId: g.eventId, by: ADMIN, plan: { stageId: g.stages[0]!, entrants: g.entries, bracket: gBracket, rounds: [] }, now: NOW }));
      const ready = P.matchesOf(g.db, g.stages[0]!).find((m) => m.status === 'waiting')!;
      const reported = await reportResult(gBracket, ready.bm_match_id!, aWins);
      const baseRev = E.getStage(g.db, g.stages[0]!)!.bracket_rev;
      const beforeResult = rows(g);
      g.db.exec("CREATE TRIGGER bracket_result_log_down BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
      expect(() => P.recordResult(g.db, { matchId: ready.id, by: ADMIN, result: aWins, bracket: { data: reported, baseRev }, now: NOW })).toThrow(/audit down/);
      expect(rows(g)).toBe(beforeResult);
    });
  });

  /** Plan T3a: src/events/room.ts is the only writer of the room tables,
   *  and its mutations follow the same one-row rule. Task 4 adds actVeto,
   *  lockLineup and savePrefs to ROOM_MUTATIONS and its reads to ROOM_READS. */
  describe('room guard (src/events/room.ts)', () => {
    const ROOM_TABLES = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:event_vetoes|event_games|event_lineups|event_entry_prefs|event_campaign_prefs)\b/gi;
    const ROOM_READS = new Set([
      'roomTimers', 'vetoActions', 'vetoInput', 'roomState', 'gamesOf', 'lineupsOf', 'sideOf', 'entryOn', 'playableOf', 'busyEntries', 'isParticipant',
      'entryPrefs', 'campaignPrefs', 'lastFour', 'autoFour', 'seriesGames', 'lineupFour', 'matchOfBooking', 'subsUsed', 'hasDeadGame', 'techPausesOf',
    ]);
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    const open = (f: RoomFixture) => {
      const r = R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
      if (!r.ok) throw new Error(r.error);
    };
    const bothReady = (f: RoomFixture) => {
      open(f);
      for (const steamid of [A[0]!, B[0]!]) {
        const r = R.readyUp(f.db, { matchId: f.matchId, steamid, timers: TIMERS, now: at(1) });
        if (!r.ok) throw new Error(r.error);
      }
    };
    // The same ban-to-one veto as room.test.ts's actVeto tests, to reach lineups.
    const toLineups = (f: RoomFixture) => {
      bothReady(f);
      const steps: [string, number, string, string | null][] = [[A[0]!, 0, 'first', null], [A[0]!, 1, 'ban', 'dead_air'], [B[0]!, 2, 'survivors', null]];
      for (const [steamid, step, action, campaign] of steps) {
        const r = R.actVeto(f.db, { matchId: f.matchId, steamid, step, action, campaign, timers: TIMERS, now: at(2) });
        if (!r.ok) throw new Error(r.error);
      }
    };
    // Plan T3b: the series. Every step past lockLineup, from the booking on.
    const must = <T>(r: V.Checked<T>): T => { if (!r.ok) throw new Error(r.error); return r.value; };
    const game1 = (f: RoomFixture) => R.gamesOf(f.db, f.matchId).find((g) => g.ordinal === 1)!;
    const booked = (f: RoomFixture) => {
      driveToBooking(f);
      must(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    };
    const connecting = (f: RoomFixture) => {
      booked(f);
      must(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    };
    const playing = (f: RoomFixture) => {
      connecting(f);
      must(R.startLive(f.db, { matchId: f.matchId, now: at(6) }));
    };
    const linked = (f: RoomFixture) => {
      playing(f);
      must(R.linkGame(f.db, { matchId: f.matchId, gameId: game1(f).id, gameMatchId: fakeMatch(f), now: at(6) }));
    };
    // Game 1 recorded: the Bo1 is over, so the confirm window may open.
    const recorded = (f: RoomFixture) => {
      linked(f);
      must(R.recordGame(f.db, { matchId: f.matchId, gameId: game1(f).id, scoreA: 300, scoreB: 700, forfeit: null, now: at(30) }));
    };
    const confirming = (f: RoomFixture) => {
      recorded(f);
      must(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) }));
    };
    // room.test.ts's loser picks opening, driven to a recorded game 1 (the
    // stage is rewritten before the room opens: test setup only).
    const pickDue = (f: RoomFixture) => {
      f.db.prepare('UPDATE event_stages SET campaign_pool_json = ?, veto_json = ? WHERE id = ?')
        .run(JSON.stringify(POOL7), JSON.stringify(presetConfig('loser_picks', 7)), f.stageId);
      bothReady(f);
      const opening: [string, number, string, string | null][] = [[A[0]!, 0, 'first', null], [A[0]!, 1, 'ban', POOL7[0]!], [B[0]!, 2, 'ban', POOL7[1]!],
        [A[0]!, 3, 'ban', POOL7[2]!], [B[0]!, 4, 'ban', POOL7[3]!], [A[0]!, 5, 'pick', POOL7[5]!], [B[0]!, 6, 'survivors', null]];
      for (const [steamid, step, action, campaign] of opening) {
        must(R.actVeto(f.db, { matchId: f.matchId, steamid, step, action, campaign, timers: TIMERS, now: at(2) }));
      }
      must(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0]!, steamids: A.slice(0, 4), timers: TIMERS, now: at(4) }));
      must(R.lockLineup(f.db, { matchId: f.matchId, steamid: B[0]!, steamids: B.slice(0, 4), timers: TIMERS, now: at(4) }));
      must(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
      must(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
      must(R.startLive(f.db, { matchId: f.matchId, now: at(6) }));
      must(R.linkGame(f.db, { matchId: f.matchId, gameId: game1(f).id, gameMatchId: fakeMatch(f), now: at(6) }));
      must(R.recordGame(f.db, { matchId: f.matchId, gameId: game1(f).id, scoreA: 300, scoreB: 700, forfeit: null, now: at(30) }));
    };
    const ROOM_MUTATIONS: Record<string, { action: string; actor: string | null; setup: (f: RoomFixture) => void; run: (f: RoomFixture) => V.Checked<unknown> }> = {
      openRoom: { action: 'room_opened', actor: null, setup: () => {}, run: (f) => R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }) },
      readyUp: { action: 'room_ready', actor: A[0]!, setup: open, run: (f) => R.readyUp(f.db, { matchId: f.matchId, steamid: A[0]!, timers: TIMERS, now: at(1) }) },
      holdMatch: { action: 'match_held', actor: null, setup: open, run: (f) => R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'nobody_ready', now: at(10) }) },
      resetRoom: { action: 'room_reset', actor: ADMIN, setup: open, run: (f) => R.resetRoom(f.db, { matchId: f.matchId, by: ADMIN, now: at(1) }) },
      resumeDeadline: { action: 'room_resumed', actor: null, setup: open, run: (f) => R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(30) }) },
      actVeto: {
        action: 'veto_action', actor: A[0]!, setup: bothReady,
        run: (f) => R.actVeto(f.db, { matchId: f.matchId, steamid: A[0]!, step: 0, action: 'first', campaign: null, timers: TIMERS, now: at(2) }),
      },
      lockLineup: {
        action: 'lineup_locked', actor: A[0]!, setup: toLineups,
        run: (f) => R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0]!, steamids: [A[1]!, A[2]!, A[3]!, A[4]!], timers: TIMERS, now: at(4) }),
      },
      savePrefs: {
        action: 'prefs_saved', actor: A[0]!, setup: () => {},
        run: (f) => R.savePrefs(f.db, { entryId: f.entryA, by: A[0]!, staff: false, prefs: { defaultFour: null, side: 'survivors', campaigns: {} }, now: at(0) }),
      },
      attachBooking: {
        action: 'match_booked', actor: null, setup: driveToBooking,
        run: (f) => R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }),
      },
      noteServerAlert: { action: 'server_wait_alerted', actor: null, setup: booked, run: (f) => R.noteServerAlert(f.db, { matchId: f.matchId, now: at(15) }) },
      startConnect: { action: 'match_connect', actor: null, setup: booked, run: (f) => R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }) },
      startLive: { action: 'match_live', actor: null, setup: connecting, run: (f) => R.startLive(f.db, { matchId: f.matchId, now: at(6) }) },
      linkGame: {
        action: 'game_started', actor: null, setup: connecting,
        run: (f) => R.linkGame(f.db, { matchId: f.matchId, gameId: game1(f).id, gameMatchId: fakeMatch(f), now: at(6) }),
      },
      recordGame: {
        action: 'game_recorded', actor: null, setup: linked,
        run: (f) => R.recordGame(f.db, { matchId: f.matchId, gameId: game1(f).id, scoreA: 1, scoreB: 2, forfeit: null, now: at(30) }),
      },
      addTiebreak: {
        action: 'tiebreak_added', actor: null, setup: playing,
        run: (f) => R.addTiebreak(f.db, { matchId: f.matchId, ofGameId: game1(f).id, map: 'l4d_vs_hospital05_rooftop', firstSurvivors: 'a', now: at(30) }),
      },
      openPick: { action: 'pick_opened', actor: null, setup: pickDue, run: (f) => R.openPick(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) }) },
      startConfirm: { action: 'match_confirming', actor: null, setup: recorded, run: (f) => R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) }) },
      confirmResult: { action: 'result_confirmed', actor: A[0]!, setup: confirming, run: (f) => R.confirmResult(f.db, { matchId: f.matchId, steamid: A[0]!, now: at(61) }) },
      disputeMatch: {
        action: 'match_disputed', actor: B[0]!, setup: confirming,
        run: (f) => R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[0]!, reason: 'They had five', now: at(61) }),
      },
      subPlayer: {
        action: 'player_subbed', actor: A[0]!, setup: playing,
        run: (f) => R.subPlayer(f.db, { matchId: f.matchId, by: A[0]!, outId: A[3]!, inId: A[4]!, limit: 2, gameId: game1(f).id, now: at(20) }),
      },
      revertSub: {
        action: 'sub_reverted', actor: null,
        setup: (f) => { playing(f); must(R.subPlayer(f.db, { matchId: f.matchId, by: A[0]!, outId: A[3]!, inId: A[4]!, limit: 2, gameId: game1(f).id, now: at(20) })); },
        run: (f) => R.revertSub(f.db, { matchId: f.matchId, outId: A[3]!, inId: A[4]!, now: at(21) }),
      },
      setAdminPause: { action: 'match_frozen', actor: ADMIN, setup: playing, run: (f) => R.setAdminPause(f.db, { matchId: f.matchId, on: true, by: ADMIN, cause: 'staff', now: at(20) }) },
      reopenVeto: { action: 'veto_reopened', actor: ADMIN, setup: toLineups, run: (f) => R.reopenVeto(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, now: at(5) }) },
      extendGrace: { action: 'grace_extended', actor: ADMIN, setup: connecting, run: (f) => R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: 5, now: at(6) }) },
      releaseHold: {
        action: 'hold_released', actor: ADMIN,
        setup: (f) => { open(f); must(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(3) })); },
        run: (f) => R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(4) }),
      },
      noteReplay: {
        action: 'chapter_replayed', actor: ADMIN, setup: playing,
        run: (f) => R.noteReplay(f.db, { matchId: f.matchId, by: ADMIN, gameId: game1(f).id, ordinal: 1, map: 'l4d_vs_hospital02_subway', now: at(20) }),
      },
      noteTech: {
        action: 'tech_pause', actor: A[0]!, setup: linked,
        run: (f) => R.noteTech(f.db, { matchId: f.matchId, gameMatchId: game1(f).match_id!, event: 'start', techId: 1_791_000_000, side: 'a', cause: 'call', by: A[0]!, used: 0, budget: 300, tactical: null, text: 'router', now: at(20) }),
      },
      techPenalty: {
        action: 'tech_penalty', actor: ADMIN,
        setup: (f) => { linked(f); must(R.noteTech(f.db, { matchId: f.matchId, gameMatchId: game1(f).match_id!, event: 'start', techId: 1_791_000_000, side: 'a', cause: 'call', by: A[0]!, used: 0, budget: 300, tactical: null, text: 'router', now: at(20) })); },
        run: (f) => R.techPenalty(f.db, { matchId: f.matchId, pauseId: R.techPausesOf(f.db, P.getMatch(f.db, f.matchId)!)[0]!.id, by: ADMIN, penalty: 'warning', note: null, now: at(21) }),
      },
      noteMove: { action: 'server_moved', actor: ADMIN, setup: connecting, run: (f) => R.noteMove(f.db, { matchId: f.matchId, by: ADMIN, fromServerId: 1, now: at(6) }) },
    };
    const rows = (f: RoomFixture) => JSON.stringify(['event_matches', 'event_vetoes', 'event_games', 'event_lineups', 'event_entry_prefs', 'event_campaign_prefs']
      .map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

    it('only src/events/room.ts writes the room tables', () => {
      const offenders = walk('src').filter((f) => f !== 'src/events/room.ts')
        .filter((f) => (readFileSync(join(root, f), 'utf8').match(ROOM_TABLES) ?? []).length > 0);
      expect(offenders).toEqual([]);
      // room.ts itself is seen by the scan (its writes are spelled out, not built).
      expect((readFileSync(join(root, 'src/events/room.ts'), 'utf8').match(ROOM_TABLES) ?? []).length).toBeGreaterThan(0);
    });

    it('every exported function of room.ts is a known read or a guarded mutation', () => {
      const fns = Object.entries(R).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !ROOM_READS.has(k)).sort()).toEqual(Object.keys(ROOM_MUTATIONS).sort());
    });

    for (const [name, m] of Object.entries(ROOM_MUTATIONS)) {
      it(`${name} writes exactly one event_log row, ${m.action}`, async () => {
        const f = await roomFixture();
        m.setup(f);
        const before = logCount(f);
        const r = m.run(f);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(logCount(f)).toBe(before + 1);
        expect(f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action, actor: m.actor });
      });

      it(`${name} writes nothing when its event_log row cannot be written`, async () => {
        const f = await roomFixture();
        m.setup(f);
        const before = rows(f);
        f.db.exec(`CREATE TRIGGER room_log_down_${name} BEFORE INSERT ON event_log WHEN NEW.action = '${m.action}' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
        expect(() => m.run(f)).toThrow(/audit down/);
        expect(rows(f)).toBe(before);
      });
    }

    // readyUp's own case above is the first Ready, which only sets a column
    // and never reaches advance(). This second case is the Ready that makes
    // both sides ready, so readyUp also runs advance() (an event_games
    // upsert and the status/deadline change) before its audit row; proves
    // that path writes nothing either when the audit row fails.
    it('readyUp (the second ready, which also runs advance) writes nothing when its event_log row cannot be written', async () => {
      const f = await roomFixture();
      open(f);
      const first = R.readyUp(f.db, { matchId: f.matchId, steamid: B[0]!, timers: TIMERS, now: at(1) });
      if (!first.ok) throw new Error(first.error);
      const before = rows(f);
      f.db.exec("CREATE TRIGGER room_log_down_readyUp2 BEFORE INSERT ON event_log WHEN NEW.action = 'room_ready' BEGIN SELECT RAISE(ABORT, 'audit down'); END");
      expect(() => R.readyUp(f.db, { matchId: f.matchId, steamid: A[0]!, timers: TIMERS, now: at(1) })).toThrow(/audit down/);
      expect(rows(f)).toBe(before);
    });

    // The veto step that finishes the veto: advance() updates event_games and
    // moves the match to lineup before the audit row (final review).
    it('actVeto (the last step, which moves the match to lineup) writes nothing when its event_log row cannot be written', async () => {
      const f = await roomFixture();
      bothReady(f);
      for (const [step, action, campaign] of [[0, 'first', null], [1, 'ban', 'dead_air']] as const) {
        const r = R.actVeto(f.db, { matchId: f.matchId, steamid: A[0]!, step, action, campaign, timers: TIMERS, now: at(2) });
        if (!r.ok) throw new Error(r.error);
      }
      expect(R.gamesOf(f.db, f.matchId)).toHaveLength(1);
      const before = rows(f);
      f.db.exec("CREATE TRIGGER room_log_down_lastVeto BEFORE INSERT ON event_log WHEN NEW.action = 'veto_action' BEGIN SELECT RAISE(ABORT, 'audit down'); END");
      const last = () => R.actVeto(f.db, { matchId: f.matchId, steamid: B[0]!, step: 2, action: 'survivors', campaign: null, timers: TIMERS, now: at(3) });
      expect(last).toThrow(/audit down/);
      expect(rows(f)).toBe(before);
      f.db.exec('DROP TRIGGER room_log_down_lastVeto');
      expect(last().ok).toBe(true);
      expect(P.getMatch(f.db, f.matchId)!.status).toBe('lineup');
      expect(rows(f)).not.toBe(before);
    });
  });

  /** Plan T4: src/events/schedule.ts is the only writer of event_reschedules,
   *  and its mutations follow the same one-row rule. */
  describe('schedule guard (src/events/schedule.ts)', () => {
    const SCHEDULE_TABLE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+event_reschedules\b/gi;
    const SCHEDULE_READS = new Set([
      'scheduleRules', 'proposalsOf', 'openProposal', 'getProposal', 'autoAcceptAt', 'reminderAt', 'silentSide', 'schedulable',
      'autoAcceptDue', 'remindersDue', 'staleProposals', 'expiredWindows',
    ]);
    const RULES: S.ScheduleRules = { autoAcceptHours: 24, leadMinutes: 20 };
    const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
    const must = <T>(r: V.Checked<T>): T => { if (!r.ok) throw new Error(r.error); return r.value; };
    const proposed = (f: RoomFixture) => must(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(72).toISOString(), rules: RULES, now: NOW }));
    const SCHEDULE_MUTATIONS: Record<string, { action: string; actor: string | null; setup: (f: RoomFixture) => void; run: (f: RoomFixture) => V.Checked<unknown> }> = {
      proposeTime: { action: 'reschedule_proposed', actor: A[0]!, setup: () => {}, run: (f) => S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(72).toISOString(), rules: RULES, now: NOW }) },
      respondProposal: { action: 'reschedule_accepted', actor: B[0]!, setup: proposed, run: (f) => S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: true, now: at(1) }) },
      counterProposal: { action: 'reschedule_countered', actor: B[0]!, setup: proposed, run: (f) => S.counterProposal(f.db, { matchId: f.matchId, by: B[0]!, time: at(80).toISOString(), rules: RULES, now: at(1) }) },
      withdrawProposal: { action: 'reschedule_withdrawn', actor: A[0]!, setup: proposed, run: (f) => S.withdrawProposal(f.db, { matchId: f.matchId, by: A[0]!, now: at(1) }) },
      staffSetTime: { action: 'match_time_set', actor: ADMIN, setup: proposed, run: (f) => S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(90).toISOString(), now: at(1) }) },
      autoAccept: { action: 'reschedule_auto_accepted', actor: null, setup: proposed, run: (f) => S.autoAccept(f.db, { proposalId: S.openProposal(f.db, f.matchId)!.id, now: at(24) }) },
      noteReminded: {
        action: 'reschedule_reminded', actor: null,
        setup: (f) => must(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(100).toISOString(), rules: { autoAcceptHours: 48, leadMinutes: 20 }, now: NOW })),
        run: (f) => S.noteReminded(f.db, { proposalId: S.openProposal(f.db, f.matchId)!.id, now: at(24) }),
      },
      expireProposal: { action: 'reschedule_expired', actor: null, setup: proposed, run: (f) => S.expireProposal(f.db, { proposalId: S.openProposal(f.db, f.matchId)!.id, reason: 'time_passed', now: at(72) }) },
    };
    const rows = (f: RoomFixture) => JSON.stringify(['event_matches', 'event_reschedules'].map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));

    it('only src/events/schedule.ts (and the account merge) writes event_reschedules', () => {
      const offenders = walk('src').filter((f) => f !== 'src/events/schedule.ts' && f !== 'src/mergePlayers.ts')
        .filter((f) => (readFileSync(join(root, f), 'utf8').match(SCHEDULE_TABLE) ?? []).length > 0);
      expect(offenders).toEqual([]);
    });

    it('every exported function of schedule.ts is a known read or a guarded mutation', () => {
      const fns = Object.entries(S).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !SCHEDULE_READS.has(k)).sort()).toEqual(Object.keys(SCHEDULE_MUTATIONS).sort());
    });

    for (const [name, m] of Object.entries(SCHEDULE_MUTATIONS)) {
      it(`${name} writes exactly one event_log row, ${m.action}`, async () => {
        const f = await windowFixture();
        m.setup(f);
        const before = logCount(f);
        const r = m.run(f);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(logCount(f)).toBe(before + 1);
        expect(f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action, actor: m.actor });
      });

      it(`${name} writes nothing when its event_log row cannot be written`, async () => {
        const f = await windowFixture();
        m.setup(f);
        const before = rows(f);
        f.db.exec(`CREATE TRIGGER schedule_log_down_${name} BEFORE INSERT ON event_log WHEN NEW.action = '${m.action}' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
        expect(() => m.run(f)).toThrow(/audit down/);
        expect(rows(f)).toBe(before);
      });
    }
  });
});
