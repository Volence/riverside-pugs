import { describe, it, expect } from 'vitest';
import * as E from '../src/events/events.js';
import { TEMPLATES, rulesForKind } from '../src/rulesets.js';
import { ADMIN, NOW, START, cupId, eventFixture, must, pugId, stageBody } from './eventFixture.js';

const err = (r: E.EventResult<unknown>) => (r.ok ? null : r.error);
const LATER = new Date('2026-10-11T00:00:00.000Z');
const actions = (f: { db: import('../src/db.js').DB; eventId: number }) => E.eventLog(f.db, f.eventId).map((l) => l.action);

describe('createEvent', () => {
  it('makes an official draft with a slug from the name, unique over every event and never a reserved word', () => {
    const f = eventFixture();
    const ev = E.getEvent(f.db, f.eventId)!;
    expect(ev).toMatchObject({ slug: 'riverside-cup', status: 'draft', official: 1, organizer_steamid: ADMIN, starts_at: START, team_cap: null });
    expect(E.fieldsOf(ev).checkin).toEqual({ enabled: true, opensMinutes: 60, closesMinutes: 15 });
    const again = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'riverside cup', startsAt: START, entryKind: 'team' }, now: NOW }));
    expect(again.slug).toBe('riverside-cup-2');
    const reserved = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'New', startsAt: START, entryKind: 'draft', draft: { signupsCloseAt: '2026-10-09T20:00:00.000Z', draftAt: '2026-10-10T18:00:00.000Z' } }, now: NOW }));
    expect(reserved.slug).toBe('new-2');
    expect(E.eventLog(f.db, again.id).map((l) => [l.action, l.actor])).toEqual([['created', ADMIN]]);
  });

  it('refuses a start time that has passed, and writes nothing', () => {
    const f = eventFixture();
    const before = f.db.prepare('SELECT COUNT(*) AS n FROM events').get();
    expect(err(E.createEvent(f.db, { by: ADMIN, fields: { name: 'Late Cup', startsAt: START, entryKind: 'team' }, now: LATER }))).toBe('start_passed');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(before);
  });
});

describe('updateEvent', () => {
  it('edits fields, keeps the slug, and logs which fields changed', () => {
    const f = eventFixture();
    const ev = must(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { name: 'Riverside Spring Cup', teamCap: 16 }, now: NOW }));
    expect(ev).toMatchObject({ name: 'Riverside Spring Cup', slug: 'riverside-cup', team_cap: 16 });
    const last = E.eventLog(f.db, f.eventId).at(-1)!;
    expect([last.action, JSON.parse(last.detail)]).toEqual(['edited', { changed: ['name', 'teamCap'] }]);
  });

  it('an edit that changes nothing writes nothing', () => {
    const f = eventFixture();
    const n = E.eventLog(f.db, f.eventId).length;
    expect(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { name: 'Riverside Cup' }, now: NOW }).ok).toBe(true);
    expect(E.eventLog(f.db, f.eventId)).toHaveLength(n);
  });

  it('moves the start only into the future, and the entry kind only while a draft', () => {
    const f = eventFixture();
    expect(err(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { startsAt: '2026-09-30T00:00:00.000Z' }, now: NOW }))).toBe('start_passed');
    must(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    expect(err(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { entryKind: 'draft', draft: { signupsCloseAt: '2026-10-09T20:00:00.000Z', draftAt: '2026-10-10T18:00:00.000Z' } }, now: NOW }))).toBe('kind_locked');
    expect(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { description: 'Bring snacks.' }, now: NOW }).ok).toBe(true);
  });

  it('refuses edits once the event is past registration, and an unknown event', () => {
    const f = eventFixture();
    for (const status of ['checkin', 'live', 'finished', 'cancelled']) {
      f.db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, f.eventId);
      expect(err(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { name: 'Other Cup' }, now: NOW }))).toBe('wrong_status');
    }
    expect(err(E.updateEvent(f.db, { eventId: 999, by: ADMIN, fields: { name: 'Other Cup' }, now: NOW }))).toBe('not_found');
  });
});

describe('stages', () => {
  it('numbers stages in order, and renumbers after a reorder and a remove', () => {
    const f = eventFixture();
    const s3 = must(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db, { advanceCount: 16 }), now: NOW }));
    expect(s3.ordinal).toBe(3);
    // Twice, so the rows' insertion order no longer matches their ordinals:
    // the unique (event_id, ordinal) index must never trip mid-renumber.
    must(E.reorderStages(f.db, { eventId: f.eventId, by: ADMIN, order: [s3.id, f.s2, f.s1], now: NOW }));
    must(E.reorderStages(f.db, { eventId: f.eventId, by: ADMIN, order: [s3.id, f.s1, f.s2], now: NOW }));
    must(E.removeStage(f.db, { eventId: f.eventId, stageId: s3.id, by: ADMIN, now: NOW }));
    expect(E.stagesOf(f.db, f.eventId).map((s) => [s.id, s.ordinal])).toEqual([[f.s1, 1], [f.s2, 2]]);
    expect(actions(f).slice(-3)).toEqual(['stages_reordered', 'stages_reordered', 'stage_removed']);
  });

  it('refuses an order that is not every stage once', () => {
    const f = eventFixture();
    for (const order of [[f.s1], [f.s1, f.s1], [f.s1, 999], 'x', [String(f.s1), String(f.s2)]]) {
      expect(err(E.reorderStages(f.db, { eventId: f.eventId, by: ADMIN, order, now: NOW }))).toBe('bad_order');
    }
  });

  it('holds an event to five stages, and a stage of another event is not found', () => {
    const f = eventFixture();
    for (let i = 0; i < 3; i++) must(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db), now: NOW }));
    expect(err(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db), now: NOW }))).toBe('too_many_stages');
    const other = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'Other Cup', startsAt: START, entryKind: 'team' }, now: NOW }));
    expect(err(E.updateStage(f.db, { eventId: other.id, stageId: f.s1, by: ADMIN, stage: stageBody(f.db), now: NOW }))).toBe('stage_not_found');
    expect(err(E.removeStage(f.db, { eventId: other.id, stageId: f.s1, by: ADMIN, now: NOW }))).toBe('stage_not_found');
  });

  it('takes the site pool when the form sends none, and refuses a bad stage with its own rule', () => {
    const f = eventFixture();
    const s = must(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: { type: 'swiss', rulesetId: cupId(f.db) }, now: NOW }));
    expect(E.stageSettingsOf(s).campaignPool).toEqual(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']);
    expect(err(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db, { vetoType: 'pick_ban' }), now: NOW }))).toBe('bad_pool_for_veto');
  });

  it('refuses a stage on the PUG ruleset: PUG is for PUGs, not events', () => {
    const f = eventFixture();
    expect(err(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db, { rulesetId: pugId(f.db) }), now: NOW }))).toBe('pug_ruleset');
  });

  it('reads a league stage stored with weeks as matches = weeks x matches a week (plan T2)', () => {
    const f = eventFixture('draft');
    f.db.prepare("UPDATE event_stages SET type = 'league', config_json = ? WHERE id = ?")
      .run(JSON.stringify({ weeks: 6, matchesPerWeek: 2, pairing: 'swiss' }), f.s1);
    expect(E.stageSettingsOf(E.getStage(f.db, f.s1)!).config).toEqual({ matches: 12, matchesPerWeek: 2, pairing: 'swiss', seasonStart: null });
  });

  it('stores a stage veto and reads an older stage (no veto_json) from its veto_type (plan T3a)', () => {
    const f = eventFixture();
    const knobs = { games: 1, banTo: 2, firstBan: 'coin', firstPick: 'lower', laterPicks: 'alternate', lateBans: 0, sides: 'higher' };
    must(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, stage: stageBody(f.db, { veto: knobs }), now: NOW }));
    const s = E.getStage(f.db, f.s1)!;
    expect(JSON.parse(s.veto_json!)).toEqual(knobs);
    expect(s.veto_type).toBe('ban_to_one');
    expect(E.stageSettingsOf(s).veto).toEqual(knobs);
    f.db.prepare("UPDATE event_stages SET veto_json = NULL, veto_type = 'home_away' WHERE id = ?").run(f.s1);
    expect(E.stageSettingsOf(E.getStage(f.db, f.s1)!).veto).toMatchObject({ games: 2, banTo: 2 });
  });

  it('locks every stage change once the event is live', () => {
    const f = eventFixture();
    for (const status of ['live', 'finished', 'cancelled']) {
      f.db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, f.eventId);
      expect(err(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db), now: NOW }))).toBe('stages_locked');
      expect(err(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, stage: stageBody(f.db), now: NOW }))).toBe('stages_locked');
      expect(err(E.removeStage(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, now: NOW }))).toBe('stages_locked');
      expect(err(E.reorderStages(f.db, { eventId: f.eventId, by: ADMIN, order: [f.s2, f.s1], now: NOW }))).toBe('stages_locked');
    }
  });

  it('stores a round schedule on a stage at any status but finished or cancelled, sorted, and logs it (plan T4)', () => {
    const f = eventFixture('draft');
    const rows = [{ round: 2, at: '2026-10-21T21:00:00Z', from: '2026-10-19T00:00:00Z', to: '2026-10-25T23:59:59Z' }, { round: 1, at: '2026-10-14T21:00:00Z', from: '2026-10-12T00:00:00Z', to: '2026-10-18T23:59:59Z' }];
    f.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(f.s1);
    const r = E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, rounds: rows, now: NOW });
    expect(r.ok).toBe(true);
    expect(E.scheduleOf(E.getStage(f.db, f.s1)!).map((x) => x.round)).toEqual([1, 2]);
    expect(f.db.prepare('SELECT action, actor, detail FROM event_log ORDER BY id DESC LIMIT 1').get()).toMatchObject({ action: 'schedule_set', actor: ADMIN });
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, rounds: rows, now: NOW })).toEqual({ ok: false, error: 'bad_schedule' });
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, rounds: [{ round: 1, at: '2026-10-24T21:00:00Z' }], now: NOW }).ok).toBe(true);
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: 999, by: ADMIN, rounds: [], now: NOW })).toEqual({ ok: false, error: 'stage_not_found' });
    f.db.prepare("UPDATE event_stages SET status = 'finished' WHERE id = ?").run(f.s1);
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, rounds: [], now: NOW })).toEqual({ ok: false, error: 'schedule_locked' });
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, rounds: [], now: NOW })).toEqual({ ok: false, error: 'schedule_locked' });
  });
});

describe('publishEvent', () => {
  it('announces, snapshotting each stage ruleset as unrated tournament rules', () => {
    const f = eventFixture();
    expect(E.stagesOf(f.db, f.eventId).map((s) => s.rules_json)).toEqual([null, null]);
    expect(must(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW })).status).toBe('announced');
    const want = JSON.stringify(rulesForKind('tournament', TEMPLATES['Standard Cup']));
    expect(E.stagesOf(f.db, f.eventId).map((s) => s.rules_json)).toEqual([want, want]);
    expect(actions(f).at(-1)).toBe('published');
  });

  it('refuses without stages, with a broken chain, after the start, or twice', () => {
    const f = eventFixture();
    const bare = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'Bare Cup', startsAt: START, entryKind: 'team' }, now: NOW }));
    expect(err(E.publishEvent(f.db, { eventId: bare.id, by: ADMIN, now: NOW }))).toBe('no_stages');
    must(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, stage: stageBody(f.db, { type: 'single_elim', config: {}, advanceCount: 4 }), now: NOW }));
    expect(err(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('bad_chain');
    must(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, stage: stageBody(f.db, { type: 'single_elim', config: {}, advanceCount: null }), now: NOW }));
    expect(err(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: LATER }))).toBe('start_passed');
    must(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    expect(err(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('wrong_status');
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('announced');
  });

  it('re-checks stages against the lists of the moment: an archived ruleset, a campaign no longer poolable', () => {
    const f = eventFixture();
    f.db.prepare("UPDATE rulesets SET archived_at = '2026-10-01' WHERE id = ?").run(cupId(f.db));
    expect(err(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('bad_ruleset');
    f.db.prepare('UPDATE rulesets SET archived_at = NULL WHERE id = ?').run(cupId(f.db));
    // dead_center needs the dlc4 pack: poolable while no server lacks it.
    must(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, stage: stageBody(f.db, { type: 'single_elim', config: {}, advanceCount: null, campaignPool: ['dead_center'] }), now: NOW }));
    f.db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('s1', 'h', 27015, 27015, 'pw', 'idle')").run();
    expect(err(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('bad_pool');
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('draft');
    expect(E.stagesOf(f.db, f.eventId).map((s) => s.rules_json)).toEqual([null, null]);
  });

  it('after publishing, a stage edit takes a fresh snapshot of its new ruleset', () => {
    const f = eventFixture('announced');
    const casual = (f.db.prepare("SELECT id FROM rulesets WHERE name = 'Casual Scrim'").get() as { id: number }).id;
    const s = must(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, stage: stageBody(f.db, { rulesetId: casual }), now: NOW }));
    expect(s.rules_json).toBe(JSON.stringify(rulesForKind('tournament', TEMPLATES['Casual Scrim'])));
  });
});

describe('openRegistration', () => {
  it('opens a published team event, and nothing else', () => {
    const draft = eventFixture();
    expect(err(E.openRegistration(draft.db, { eventId: draft.eventId, by: ADMIN, now: NOW }))).toBe('wrong_status');
    const f = eventFixture('announced');
    expect(err(E.openRegistration(f.db, { eventId: f.eventId, by: ADMIN, now: LATER }))).toBe('start_passed');
    expect(must(E.openRegistration(f.db, { eventId: f.eventId, by: ADMIN, now: NOW })).status).toBe('registration');
    expect(actions(f).at(-1)).toBe('registration_opened');
  });

  it('opens signups for a draft-kind event', () => {
    const f = eventFixture();
    must(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { entryKind: 'draft', draft: { signupsCloseAt: '2026-10-09T20:00:00.000Z', draftAt: '2026-10-10T18:00:00.000Z' } }, now: NOW }));
    must(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    expect(must(E.openRegistration(f.db, { eventId: f.eventId, by: ADMIN, now: NOW })).status).toBe('registration');
  });
});

describe('cancelEvent', () => {
  it('cancels from any open status with an optional reason, once', () => {
    const f = eventFixture('announced');
    const ev = must(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: ' Not enough teams ', now: NOW }));
    expect(ev).toMatchObject({ status: 'cancelled', cancel_reason: 'Not enough teams', cancelled_at: NOW.toISOString() });
    expect(JSON.parse(E.eventLog(f.db, f.eventId).at(-1)!.detail)).toEqual({ from: 'announced', reason: 'Not enough teams' });
    expect(err(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: null, now: NOW }))).toBe('wrong_status');
    const live = eventFixture();
    live.db.prepare("UPDATE events SET status = 'live' WHERE id = ?").run(live.eventId);
    expect(E.cancelEvent(live.db, { eventId: live.eventId, by: ADMIN, reason: undefined, now: NOW }).ok).toBe(true);
  });

  it('never cancels a finished event, and refuses an over-long reason', () => {
    const f = eventFixture();
    expect(err(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: 'x'.repeat(301), now: NOW }))).toBe('bad_reason');
    f.db.prepare("UPDATE events SET status = 'finished' WHERE id = ?").run(f.eventId);
    expect(err(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: null, now: NOW }))).toBe('wrong_status');
  });
});

describe('cancelling a draft', () => {
  it('is refused: a draft is deleted, never cancelled into the public Past list', () => {
    const f = eventFixture();
    const n = E.eventLog(f.db, f.eventId).length;
    expect(err(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: null, now: NOW }))).toBe('wrong_status');
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('draft');
    expect(E.eventLog(f.db, f.eventId)).toHaveLength(n);
  });
});

describe('deleteDraftEvent', () => {
  const count = (db: import('../src/db.js').DB, table: string, eventId: number) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE event_id = ?`).get(eventId) as { n: number }).n;

  it('deletes a draft with its stages and history, and leaves every other event alone', () => {
    const f = eventFixture();
    const other = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'Other Cup', startsAt: START, entryKind: 'team' }, now: NOW }));
    must(E.addStage(f.db, { eventId: other.id, by: ADMIN, stage: stageBody(f.db), now: NOW }));
    const gone = must(E.deleteDraftEvent(f.db, { eventId: f.eventId, by: ADMIN }));
    expect(gone).toMatchObject({ id: f.eventId, slug: 'riverside-cup', name: 'Riverside Cup' });
    expect(E.getEvent(f.db, f.eventId)).toBeUndefined();
    for (const t of ['event_stages', 'event_log']) expect(count(f.db, t, f.eventId), t).toBe(0);
    expect(E.getEvent(f.db, other.id)).toBeDefined();
    expect(E.stagesOf(f.db, other.id)).toHaveLength(1);
    expect(actions({ db: f.db, eventId: other.id })).toEqual(['created', 'stage_added']);
  });

  it('deletes only a draft, and only an existing one', () => {
    const f = eventFixture('announced');
    expect(err(E.deleteDraftEvent(f.db, { eventId: f.eventId, by: ADMIN }))).toBe('wrong_status');
    for (const status of ['registration', 'checkin', 'live', 'finished', 'cancelled']) {
      f.db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, f.eventId);
      expect(err(E.deleteDraftEvent(f.db, { eventId: f.eventId, by: ADMIN })), status).toBe('wrong_status');
    }
    expect(E.getEvent(f.db, f.eventId)).toBeDefined();
    expect(err(E.deleteDraftEvent(f.db, { eventId: 999, by: ADMIN }))).toBe('not_found');
  });

  it('refuses a draft that somehow has entries, and writes nothing', () => {
    const f = eventFixture();
    f.db.prepare("INSERT INTO event_entries (event_id, name, registered_by, created_at) VALUES (?, 'Rats', ?, 'x')").run(f.eventId, ADMIN);
    const n = E.eventLog(f.db, f.eventId).length;
    expect(err(E.deleteDraftEvent(f.db, { eventId: f.eventId, by: ADMIN }))).toBe('has_entries');
    expect(E.getEvent(f.db, f.eventId)).toBeDefined();
    expect(E.stagesOf(f.db, f.eventId)).toHaveLength(2);
    expect(E.eventLog(f.db, f.eventId)).toHaveLength(n);
  });
});
