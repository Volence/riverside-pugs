import { describe, it, expect, vi, afterEach } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as E from '../src/events/events.js';
import { EventRunner } from '../src/events/runner.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import type { Notifier } from '../src/notify/notify.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, draftFixture, rate, type DraftFixture } from './draftFixture.js';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
const MIN = 60_000;
const at = (m: number) => new Date(NOW.getTime() + m * MIN);

/**
 * 21 signups a second apart in P order, closed at NOW: P[1], P[2] and P[3]
 * are willing with SR 1400, 1300 and 1200; P[20] says no and has SR 1500
 * (the highest); P[0] wants captaincy and is made captain; everyone else
 * says no. Teams 5, so four more captains are needed.
 */
function setup(): DraftFixture {
  const f = draftFixture();
  rate(f.db, P[1], 1400);
  rate(f.db, P[2], 1300);
  rate(f.db, P[3], 1200);
  P.forEach((s, i) => must(D.signUp(f.db, {
    eventId: f.eventId, steamid: s, captainPref: i === 0 ? 'want' : i <= 3 ? 'willing' : 'no', note: null, now: new Date(NOW.getTime() - 60_000 + i * 1000),
  })));
  must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  must(D.setCaptain(f.db, { eventId: f.eventId, steamid: P[0], captain: true, actor: ADMIN, now: NOW }));
  return f;
}
const start = (f: DraftFixture, now = NOW) => D.startOffers(f.db, { eventId: f.eventId, actor: ADMIN, now, minutes: 30 });
const answer = (f: DraftFixture, steamid: string, accept: boolean, now = at(1)) => D.answerOffer(f.db, { eventId: f.eventId, steamid, accept, now });
const offers = (f: DraftFixture) =>
  f.db.prepare('SELECT steamid, offered_at, expires_at, answer FROM draft_captain_offers WHERE event_id = ? ORDER BY id').all(f.eventId) as
    { steamid: string; offered_at: string; expires_at: string; answer: string | null }[];
const open = (f: DraftFixture) => offers(f).filter((o) => o.answer === null);
const logs = (f: DraftFixture, action: string) =>
  (f.db.prepare('SELECT actor, detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { actor: string | null; detail: string }[])
    .map((r) => ({ actor: r.actor, detail: JSON.parse(r.detail) as Record<string, unknown> }));
const offersOn = (f: DraftFixture) => E.getEvent(f.db, f.eventId)!.offers_on;
const captains = (f: DraftFixture) => D.activeSignups(f.db, f.eventId).filter((s) => s.role === 'captain').map((s) => s.steamid);

function runner(f: DraftFixture) {
  const send = vi.fn((..._args: unknown[]) => 1);
  const r = new EventRunner({ db: f.db, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' });
  return { r, send };
}
let unsubscribe: (() => void) | null = null;
afterEach(() => { unsubscribe?.(); unsubscribe = null; });
function feed(): AdminEvent[] {
  const out: AdminEvent[] = [];
  unsubscribe = subscribeAdminEvents((e) => out.push(e));
  return out;
}

describe('captaincy offers down the willing list by SR', () => {
  it('startOffers offers the 1400 player, never the higher no, with a 30 minute window', () => {
    const f = setup();
    expect(must(start(f))).toEqual({ offered: P[1] });
    expect(offersOn(f)).toBe(1);
    expect(offers(f)).toEqual([{ steamid: P[1], offered_at: NOW.toISOString(), expires_at: at(30).toISOString(), answer: null }]);
    expect(logs(f, 'draft_offers_started')).toEqual([{ actor: ADMIN, detail: { first: P[1] } }]);
    expect(err(start(f))).toBe('offers_on');
  });

  it('a decline goes to the next tick, which offers 1300', () => {
    const f = setup();
    must(start(f));
    must(answer(f, P[1], false));
    expect(offers(f)[0]!.answer).toBe('decline');
    expect(logs(f, 'draft_offer_answered')).toEqual([{ actor: P[1], detail: { steamid: P[1], accept: false } }]);
    const { r, send } = runner(f);
    r.step(at(2));
    expect(open(f).map((o) => o.steamid)).toEqual([P[2]]);
    expect(logs(f, 'draft_offer_made')).toEqual([{ actor: null, detail: { steamid: P[2] } }]);
    const expires = Math.floor(at(32).getTime() / 1000);
    expect(send.mock.calls.map(([to, type, payload]) => ({ to, type, content: (payload as { content: string }).content }))).toEqual([{
      to: [P[2]], type: 'draft_captain_offer',
      content: `Draft Night needs another captain and you said you were willing. Accept or decline on the event page by <t:${expires}:F>: https://x/event/${f.slug}`,
    }]);
  });

  it('an unanswered offer expires at +30 minutes and the same tick offers 1200 next', () => {
    const f = setup();
    must(start(f));
    must(answer(f, P[1], false));
    const { r } = runner(f);
    r.step(at(2));
    r.step(at(31));
    expect(open(f).map((o) => o.steamid)).toEqual([P[2]]);
    r.step(at(32));
    expect(offers(f).map((o) => [o.steamid, o.answer])).toEqual([[P[1], 'decline'], [P[2], 'expired'], [P[3], null]]);
    expect(logs(f, 'draft_offer_expired')).toEqual([{ actor: null, detail: { steamid: P[2] } }]);
  });

  it('an accept makes a captain and the next tick offers the next while captains are short', () => {
    const f = setup();
    must(start(f));
    must(answer(f, P[1], true));
    expect(captains(f)).toEqual([P[0], P[1]]);
    expect(D.activeSignups(f.db, f.eventId).filter((s) => s.role === 'pool')).toHaveLength(15);
    expect(offers(f)[0]!.answer).toBe('accept');
    runner(f).r.step(at(2));
    expect(open(f).map((o) => o.steamid)).toEqual([P[2]]);
  });

  it('runs out: offers off, one admin feed problem, and no more after', () => {
    const f = setup();
    const events = feed();
    must(start(f));
    must(answer(f, P[1], true));
    const { r } = runner(f);
    r.step(at(2));
    must(answer(f, P[2], false, at(3)));
    r.step(at(4));
    must(answer(f, P[3], false, at(5)));
    r.step(at(6));
    expect(offersOn(f)).toBe(0);
    expect(logs(f, 'draft_offers_exhausted')).toEqual([{ actor: null, detail: { captains: 2, teams: 5 } }]);
    r.step(at(7));
    r.step(at(8));
    expect(events).toEqual([{
      kind: 'problem', text: 'Draft Draft Night: no more signups willing to captain; 2 of 5 captains chosen.',
      link: { label: 'Open the draft desk', path: `/admin/events/${f.eventId}` },
    }]);
    expect(logs(f, 'draft_offers_exhausted')).toHaveLength(1);
  });

  it('never has two open offers: the unique index holds, and a double tick makes one offer', () => {
    const f = setup();
    must(start(f));
    expect(() => f.db.prepare("INSERT INTO draft_captain_offers (event_id, steamid, offered_at, expires_at) VALUES (?, ?, 'x', 'y')").run(f.eventId, P[2]))
      .toThrow(/UNIQUE/);
    must(answer(f, P[1], false));
    const { r, send } = runner(f);
    r.step(at(2));
    r.step(at(2));
    expect(open(f)).toHaveLength(1);
    expect(logs(f, 'draft_offer_made')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(err(D.offerNext(f.db, { eventId: f.eventId, now: at(2), minutes: 30 }))).toBe('offer_open');
    expect(err(D.expireDueOffer(f.db, { eventId: f.eventId, now: at(2) }))).toBe('no_offer');
  });

  it('publish stops an open offer, and the record reads stopped', () => {
    const f = setup();
    must(start(f));
    for (const s of [P[4], P[5], P[6], P[7]]) must(D.setCaptain(f.db, { eventId: f.eventId, steamid: s, captain: true, actor: ADMIN, now: at(1) }));
    must(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: at(2) }));
    expect(offers(f).map((o) => o.answer)).toEqual(['stopped']);
    expect(offersOn(f)).toBe(0);
    expect(err(answer(f, P[1], true, at(3)))).toBe('cut_published');
    runner(f).r.step(at(40));
    expect(offers(f)).toHaveLength(1);
  });

  it('an answer after expires_at and before the tick is offer_expired, recorded as expired', () => {
    const f = setup();
    must(start(f));
    expect(err(answer(f, P[1], true, at(30)))).toBe('offer_expired');
    expect(captains(f)).toEqual([P[0]]);
    expect(offers(f).map((o) => o.answer)).toEqual(['expired']);
    expect(logs(f, 'draft_offer_expired')).toEqual([{ actor: null, detail: { steamid: P[1], answered: true } }]);
    expect(err(answer(f, P[1], true, at(31)))).toBe('no_offer');
    runner(f).r.step(at(31));
    expect(open(f).map((o) => o.steamid)).toEqual([P[2]]);
  });

  it('an accept after staff lowered the team count still adds the captain; publish then refuses too_many_captains', () => {
    const f = setup();
    must(D.setCaptain(f.db, { eventId: f.eventId, steamid: P[4], captain: true, actor: ADMIN, now: NOW }));
    must(start(f));
    must(D.setDraftTeams(f.db, { eventId: f.eventId, teams: 2, actor: ADMIN, now: at(1) }));
    must(answer(f, P[1], true, at(2)));
    expect(captains(f)).toEqual([P[0], P[1], P[4]]);
    const r = D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: at(3) });
    expect(r.ok).toBe(false);
    expect(!r.ok && 'cut' in r ? r.cut.problems : null).toContain('too_many_captains');
    runner(f).r.step(at(4));
    expect(open(f)).toEqual([]);
  });

  it('refuses what it should', () => {
    const f = setup();
    expect(err(answer(f, P[1], true))).toBe('no_offer');
    expect(err(D.stopOffers(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }))).toBe('offers_off');
    expect(err(D.offerNext(f.db, { eventId: f.eventId, now: NOW, minutes: 30 }))).toBe('offers_off');
    must(start(f));
    expect(err(answer(f, P[2], true))).toBe('no_offer');
    must(D.stopOffers(f.db, { eventId: f.eventId, actor: ADMIN, now: at(1) }));
    expect(offers(f).map((o) => o.answer)).toEqual(['stopped']);
    expect(offersOn(f)).toBe(0);
    expect(logs(f, 'draft_offers_stopped')).toEqual([{ actor: ADMIN, detail: { stopped: P[1] } }]);
    for (const s of [P[4], P[5], P[6], P[7]]) must(D.setCaptain(f.db, { eventId: f.eventId, steamid: s, captain: true, actor: ADMIN, now: at(2) }));
    expect(err(start(f, at(3)))).toBe('offers_not_needed');
    const open2 = draftFixture();
    expect(err(D.startOffers(open2.db, { eventId: open2.eventId, actor: ADMIN, now: NOW, minutes: 30 }))).toBe('not_closed');
  });

  it('a restart never re-offers a player offered before in this event', () => {
    const f = setup();
    must(start(f));
    must(D.stopOffers(f.db, { eventId: f.eventId, actor: ADMIN, now: at(1) }));
    expect(must(start(f, at(2)))).toEqual({ offered: P[2] });
  });

  it('removing a signup stops their open offer, so the next tick moves on', () => {
    const f = setup();
    must(start(f));
    must(D.removeSignup(f.db, { eventId: f.eventId, steamid: P[1], reason: 'removed', actor: ADMIN, now: at(1) }));
    expect(offers(f).map((o) => o.answer)).toEqual(['stopped']);
    runner(f).r.step(at(2));
    expect(open(f).map((o) => o.steamid)).toEqual([P[2]]);
  });

  it('skips an ineligible willing player', () => {
    const f = setup();
    f.db.prepare('UPDATE players SET discord_id = NULL WHERE steamid = ?').run(P[1]);
    expect(must(start(f))).toEqual({ offered: P[2] });
  });

  it('a start with nobody willing left leaves the runner to report it', () => {
    const f = setup();
    f.db.prepare("UPDATE draft_signups SET captain_pref = 'no' WHERE event_id = ?").run(f.eventId);
    const events = feed();
    expect(must(start(f))).toEqual({ offered: null });
    expect(logs(f, 'draft_offers_started')).toEqual([{ actor: ADMIN, detail: { first: null } }]);
    runner(f).r.step(at(1));
    expect(offersOn(f)).toBe(0);
    expect(events).toHaveLength(1);
  });

  it('reads draft_offer_minutes for the window', () => {
    const f = setup();
    f.db.prepare("UPDATE settings SET value = '45' WHERE key = 'draft_offer_minutes'").run();
    expect(D.draftOfferMinutes(f.db)).toBe(45);
    f.db.prepare("UPDATE settings SET value = '' WHERE key = 'draft_offer_minutes'").run();
    expect(D.draftOfferMinutes(f.db)).toBe(30);
  });
});
