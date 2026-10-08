import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as E from '../src/events/events.js';
import { roomSettingsOf } from '../src/events/draftRules.js';
import {
  STANDIN_MARGIN_DEFAULT, STANDIN_MARGIN_MAX, parseStandinMargin, standinMarginOf, standinOrder, type BenchCandidate,
} from '../src/events/draftRules.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { ADMIN, NOW } from './eventFixture.js';
import { cutDraft, draftFixture } from './draftFixture.js';

const c = (steamid: string, sr: number, order: number, over: Partial<BenchCandidate> = {}): BenchCandidate =>
  ({ steamid, sr, order, eligible: true, busy: false, ...over });

describe('standinOrder (Ruling 3)', () => {
  it('offers the closest SR first, never more than the margin above, any amount below, ties by signup order', () => {
    const bench = [c('far', 1400, 0), c('up100', 1375, 1), c('down50', 1225, 2), c('up50', 1325, 3), c('low', 900, 4)];
    expect(standinOrder(bench, 1275, 100, new Set())).toEqual(['down50', 'up50', 'up100', 'low']);
  });

  it('skips ineligible players, busy players and players already offered this request', () => {
    const bench = [c('a', 1280, 0, { eligible: false }), c('b', 1281, 1, { busy: true }), c('d', 1282, 2), c('e', 1290, 3)];
    expect(standinOrder(bench, 1275, 100, new Set(['d']))).toEqual(['e']);
  });

  it('with the limit off (margin null) takes everyone eligible, still closest first', () => {
    const bench = [c('far', 1400, 0), c('near', 1290, 1)];
    expect(standinOrder(bench, 1000, null, new Set())).toEqual(['near', 'far']);
    expect(standinOrder(bench, 1000, 100, new Set())).toEqual([]);
  });

  it('a margin of 0 takes players at the same SR or below only', () => {
    expect(standinOrder([c('same', 1275, 0), c('above', 1276, 1), c('below', 1200, 2)], 1275, 0, new Set())).toEqual(['same', 'below']);
  });
});

describe('the stand-in margin setting', () => {
  it('reads the stored margin, and falls back to 100 for anything missing or out of range', () => {
    expect(standinMarginOf(null)).toBe(STANDIN_MARGIN_DEFAULT);
    expect(standinMarginOf(JSON.stringify({ standinSrMargin: 150 }))).toBe(150);
    for (const bad of [-1, STANDIN_MARGIN_MAX + 1, 1.5, '100', null]) {
      expect(standinMarginOf(JSON.stringify({ standinSrMargin: bad }))).toBe(STANDIN_MARGIN_DEFAULT);
    }
  });

  it('parses a desk body: whole numbers 0 to 2000 only', () => {
    expect(parseStandinMargin(0)).toBe(0);
    expect(parseStandinMargin(2000)).toBe(2000);
    for (const bad of [-1, 2001, 1.5, '100', null, undefined]) expect(parseStandinMargin(bad)).toBeNull();
  });

  it('setStandinMargin stores it next to the room settings once the cut is published, with one log row', () => {
    const f = cutDraft();
    D.setRoomSettings(f.db, { eventId: f.eventId, settings: { firstPick: 'random', pickSeconds: 60 }, actor: ADMIN, now: NOW });
    expect(D.setStandinMargin(f.db, { eventId: f.eventId, margin: 150, actor: ADMIN, now: NOW })).toEqual({ ok: true, value: { margin: 150 } });
    const ev = E.getEvent(f.db, f.eventId)!;
    expect(standinMarginOf(ev.draft_json)).toBe(150);
    expect(roomSettingsOf(ev.draft_json)).toEqual({ firstPick: 'random', pickSeconds: 60 });
    expect(f.db.prepare("SELECT detail FROM event_log WHERE action = 'draft_standin_margin'").get()).toEqual({ detail: JSON.stringify({ margin: 150, from: 100 }) });
  });

  it('refuses a bad margin, and before the cut is published, and writes nothing', () => {
    const f = cutDraft({ publish: false });
    const go = (margin: unknown) => D.setStandinMargin(f.db, { eventId: f.eventId, margin, actor: ADMIN, now: NOW });
    expect(go(-5)).toEqual({ ok: false, error: 'bad_standin_margin' });
    expect(EVENT_ERRORS.bad_standin_margin.text).toBe('The stand-in SR margin is a whole number from 0 to 2000.');
    expect(go(100)).toEqual({ ok: false, error: 'wrong_status' });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'draft_standin_margin'").get()).toEqual({ n: 0 });
  });
});

describe('the stand-in tables', () => {
  it('allow one open request per missing player of a team and one open offer per request', () => {
    const { db, eventId } = draftFixture();
    const req = db.prepare(
      "INSERT INTO draft_standins (event_id, entry_id, out_steamid, scope, match_id, margin, status, requested_by, requested_at) VALUES (?, 7, 'p', 'event', NULL, 100, ?, '1', 'x')",
    );
    const id = Number(req.run(eventId, 'open').lastInsertRowid);
    expect(() => req.run(eventId, 'open')).toThrow(/UNIQUE/);
    req.run(eventId, 'filled');
    const offer = db.prepare("INSERT INTO draft_standin_offers (request_id, steamid, offered_at, expires_at) VALUES (?, ?, 'x', 'y')");
    offer.run(id, 'b1');
    expect(() => offer.run(id, 'b2')).toThrow(/UNIQUE/);
    expect(() => req.run(eventId, 'maybe')).toThrow(/CHECK/);
  });
});
