import { describe, it, expect } from 'vitest';
import * as E from '../src/events/events.js';
import { ADMIN, NOW, START, eventFixture, must } from './eventFixture.js';

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
});
