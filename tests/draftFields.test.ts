import { describe, it, expect } from 'vitest';
import * as E from '../src/events/events.js';
import * as D from '../src/events/drafts.js';
import { ADMIN, NOW, START, eventFixture, must } from './eventFixture.js';
import { P, draftFixture } from './draftFixture.js';

const err = (r: E.EventResult<unknown>) => (r.ok ? null : r.error);
const CLOSE = '2026-10-09T20:00:00.000Z';
const NIGHT = '2026-10-10T18:00:00.000Z';
const draftEvent = (draft: unknown = { signupsCloseAt: CLOSE, draftAt: NIGHT }, omit = false) => {
  const f = eventFixture();
  const r = E.createEvent(f.db, { by: ADMIN, fields: { name: 'Draft Night', startsAt: START, entryKind: 'draft', ...(omit ? {} : { draft }) }, now: NOW });
  return { f, r };
};

describe('draft event fields', () => {
  it('refuses a draft-kind event without draft times', () => {
    expect(err(draftEvent(null, true).r)).toBe('bad_draft_times');
    expect(err(draftEvent({ signupsCloseAt: CLOSE }).r)).toBe('bad_draft_times');
    expect(err(draftEvent({ signupsCloseAt: 'nope', draftAt: NIGHT }).r)).toBe('bad_draft_times');
  });

  it('refuses times out of order', () => {
    expect(err(draftEvent({ signupsCloseAt: NIGHT, draftAt: CLOSE }).r)).toBe('draft_times_order');
    expect(err(draftEvent({ signupsCloseAt: CLOSE, draftAt: '2026-10-10T21:00:00.000Z' }).r)).toBe('draft_times_order');
  });

  it('stores draft_json and fieldsOf returns it', () => {
    const { r } = draftEvent();
    const ev = must(r);
    expect(JSON.parse(ev.draft_json!)).toEqual({ signupsCloseAt: CLOSE, draftAt: NIGHT });
    expect(E.fieldsOf(ev).draft).toEqual({ signupsCloseAt: CLOSE, draftAt: NIGHT });
  });

  it('ignores draft on a team event and stores NULL', () => {
    const f = eventFixture();
    const ev = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'Team Cup', startsAt: START, entryKind: 'team', draft: { signupsCloseAt: CLOSE, draftAt: NIGHT } }, now: NOW }));
    expect(ev.draft_json).toBeNull();
    expect(E.fieldsOf(ev).draft).toBeNull();
  });

  it('an edit keeps draft_json, including keys a later plan owns', () => {
    const { f, r } = draftEvent();
    const ev = must(r);
    f.db.prepare('UPDATE events SET draft_json = ? WHERE id = ?').run(JSON.stringify({ signupsCloseAt: CLOSE, draftAt: NIGHT, firstPick: 'lowest_sr' }), ev.id);
    must(E.updateEvent(f.db, { eventId: ev.id, by: ADMIN, fields: { name: 'Renamed Night' }, now: NOW }));
    expect(JSON.parse(E.getEvent(f.db, ev.id)!.draft_json!)).toEqual({ signupsCloseAt: CLOSE, draftAt: NIGHT, firstPick: 'lowest_sr' });
    must(E.updateEvent(f.db, { eventId: ev.id, by: ADMIN, fields: { draft: { signupsCloseAt: CLOSE, draftAt: '2026-10-10T19:00:00.000Z' } }, now: NOW }));
    expect(JSON.parse(E.getEvent(f.db, ev.id)!.draft_json!)).toEqual({ signupsCloseAt: CLOSE, draftAt: '2026-10-10T19:00:00.000Z', firstPick: 'lowest_sr' });
  });

  it('opens signups on an announced draft event, and a team event is unchanged', () => {
    const f = eventFixture();
    must(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { entryKind: 'draft', draft: { signupsCloseAt: CLOSE, draftAt: NIGHT } }, now: NOW }));
    must(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    expect(must(E.openRegistration(f.db, { eventId: f.eventId, by: ADMIN, now: NOW })).status).toBe('registration');
  });

  it('refuses to open signups without draft times, or once the close time has passed', () => {
    const f = eventFixture();
    must(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { entryKind: 'draft', draft: { signupsCloseAt: CLOSE, draftAt: NIGHT } }, now: NOW }));
    must(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const logs = () => (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const before = logs();
    expect(err(E.openRegistration(f.db, { eventId: f.eventId, by: ADMIN, now: new Date(CLOSE) }))).toBe('draft_close_passed');
    expect(err(E.openRegistration(f.db, { eventId: f.eventId, by: ADMIN, now: new Date(Date.parse(CLOSE) + 1000) }))).toBe('draft_close_passed');
    f.db.prepare('UPDATE events SET draft_json = NULL WHERE id = ?').run(f.eventId);
    expect(err(E.openRegistration(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('bad_draft_times');
    expect(logs()).toBe(before);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('announced');
  });

  it('openCheckin refuses a draft-kind event with team_only', () => {
    const f = draftFixture();
    const before = (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    expect(err(E.openCheckin(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('team_only');
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(before);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('registration');
  });

  it('after the cut is published the draft times are locked, and other fields still edit', () => {
    const f = draftFixture();
    P.slice(0, 8).forEach((s, i) => must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'want', note: null, now: new Date(NOW.getTime() + i * 1000) })));
    must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    // Closed but unpublished: the times may still move.
    const later = { signupsCloseAt: f.closeAt, draftAt: new Date(Date.parse(f.draftAt) + 600_000).toISOString() };
    must(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { draft: later }, now: NOW }));
    for (const s of P.slice(0, 2)) must(D.setCaptain(f.db, { eventId: f.eventId, steamid: s, captain: true, actor: ADMIN, now: NOW }));
    must(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    const logs = () => (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const before = logs();
    expect(err(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { draft: { ...later, draftAt: f.draftAt } }, now: NOW }))).toBe('draft_times_locked');
    expect(err(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { draft: { ...later, signupsCloseAt: new Date(Date.parse(f.closeAt) - 600_000).toISOString() } }, now: NOW }))).toBe('draft_times_locked');
    expect(logs()).toBe(before);
    expect(E.fieldsOf(E.getEvent(f.db, f.eventId)!).draft).toEqual(later);
    must(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { name: 'Renamed Night', draft: later }, now: NOW }));
    expect(E.getEvent(f.db, f.eventId)!.name).toBe('Renamed Night');
    expect(logs()).toBe(before + 1);
  });
});
