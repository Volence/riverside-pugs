import { describe, it, expect } from 'vitest';
import * as N from '../src/events/entries.js';
import * as ST from '../src/events/standins.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P } from './draftFixture.js';
import { BENCH, entryOf, liveStandins, offeredFor, standinFixture, type StandinFixture } from './standinFixture.js';

const MIN = 60_000;
const at = (min: number) => new Date(NOW.getTime() + min * MIN);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
const captainOf = (f: StandinFixture, steamid: string) => entryOf(f, steamid).captain_steamid!;
const ask = (f: StandinFixture, out: string, over: Partial<Parameters<typeof ST.requestStandin>[1]> = {}) => {
  const entry = entryOf(f, out);
  return ST.requestStandin(f.db, { eventId: f.eventId, entryId: entry.id, out, scope: 'event', by: entry.captain_steamid!, staff: false, now: NOW, ...over });
};
const next = (f: StandinFixture, requestId: number, now = NOW) => must(ST.offerNextStandin(f.db, { requestId, now, minutes: 10 }));
const logs = (f: StandinFixture, action: string) => (f.db.prepare('SELECT detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { detail: string }[]).map((r) => JSON.parse(r.detail));

describe('requestStandin', () => {
  it('opens a request for a starter of the captain\'s team with the event margin, and logs it', () => {
    const f = standinFixture();
    const out = P[11]!;
    const { requestId } = must(ask(f, out));
    expect(ST.requestOf(f.db, requestId)).toMatchObject({ entry_id: entryOf(f, out).id, out_steamid: out, scope: 'event', match_id: null, margin: 100, margin_off: 0, status: 'open' });
    expect(logs(f, 'standin_requested')).toEqual([{ requestId, entryId: entryOf(f, out).id, out, scope: 'event', matchId: null, staff: false }]);
  });

  it('refuses a non-captain, a non-starter, the captain for the rest of the event, a second request, a bad scope, and a match before the event is live', () => {
    const f = standinFixture();
    const out = P[11]!;
    expect(err(ask(f, out, { by: P[0]! === captainOf(f, out) ? P[1]! : P[0]! }))).toBe('not_manager');
    expect(err(ask(f, out, { out: BENCH[0]! }))).toBe('replace_not_starter');
    expect(err(ask(f, out, { out: captainOf(f, out) }))).toBe('standin_captain');
    expect(EVENT_ERRORS.standin_captain.text).toContain('ask staff to make another player captain');
    expect(err(ask(f, out, { scope: 'week' }))).toBe('standin_scope');
    expect(err(ask(f, out, { scope: 'match' }))).toBe('standin_no_match');
    must(ask(f, out));
    expect(err(ask(f, out))).toBe('standin_open');
    f.db.prepare("UPDATE events SET status = 'finished' WHERE id = ?").run(f.eventId);
    expect(err(ask(f, P[10]!))).toBe('standins_closed');
  });

  it('a match stand-in targets the team\'s next unfinished match once the event is live, and the captain may ask for themselves', async () => {
    const f = await liveStandins();
    const entry = entryOf(f, P[11]!);
    const m = f.db.prepare("SELECT id FROM event_matches WHERE (entry_a = ? OR entry_b = ?) AND status NOT IN ('done','forfeit','bye') ORDER BY round, id LIMIT 1").get(entry.id, entry.id) as { id: number };
    const { requestId } = must(ask(f, entry.captain_steamid!, { scope: 'match' }));
    expect(ST.requestOf(f.db, requestId)).toMatchObject({ scope: 'match', match_id: m.id });
    expect(ST.nextMatchOf(f.db, f.eventId, entry.id)).toBe(m.id);
  });
});

describe('the offer chain (Rulings 3 and 5)', () => {
  it('offers the bench closest SR first within the margin: P[12], P[13], P[14], P[15], then unfilled', () => {
    const f = standinFixture();
    const { requestId } = must(ask(f, P[11]!));
    const order: string[] = [];
    for (let k = 0; k < 4; k++) {
      const step = next(f, requestId, at(k * 11));
      order.push(step.offered!);
      // Every other one declines, the rest run out.
      if (k % 2 === 0) must(ST.declineStandinOffer(f.db, { offerId: step.offerId!, steamid: step.offered!, now: at(k * 11 + 1) }));
      else must(ST.expireStandinOffer(f.db, { requestId, now: at(k * 11 + 10) }));
    }
    expect(order).toEqual(BENCH.slice(0, 4));
    // P[16] is 125 above P[11]: never asked.
    expect(next(f, requestId, at(60))).toEqual({ offerId: null, offered: null, unfilled: true, cancelled: null });
    expect(ST.requestOf(f.db, requestId)?.status).toBe('unfilled');
    expect(ST.unfilledCount(f.db, requestId)).toBe(1);
  });

  it('a request nobody is close enough for goes unfilled at once; lifting the limit reopens it and asks the closest', () => {
    const f = standinFixture();
    const { requestId } = must(ask(f, P[0]!));
    expect(next(f, requestId).unfilled).toBe(true);
    expect(must(ST.setStandinMarginOff(f.db, { requestId, actor: ADMIN, now: at(1) }))).toEqual({ reopened: true });
    expect(ST.requestOf(f.db, requestId)).toMatchObject({ status: 'open', margin_off: 1, closed_at: null });
    expect(next(f, requestId, at(1)).offered).toBe(BENCH[0]);
    expect(err(ST.setStandinMarginOff(f.db, { requestId, actor: ADMIN, now: at(2) }))).toBe('standin_margin_off');
  });

  it('Review Focus 2: a bench player with an open offer elsewhere, or a place on a team, is skipped', () => {
    const f = standinFixture();
    const a = must(ask(f, P[11]!)).requestId;
    const b = must(ask(f, P[10]!)).requestId;
    expect(next(f, a).offered).toBe(BENCH[0]);
    // P[10] (1250): P[12] is busy with a's offer, so P[13] (75 above) is next.
    expect(next(f, b).offered).toBe(BENCH[1]);
    expect(err(ST.offerNextStandin(f.db, { requestId: a, now: NOW, minutes: 10 }))).toBe('standin_offer_open');
  });

  it('a decline after the window is refused, and records the expiry', () => {
    const f = standinFixture();
    const { requestId } = must(ask(f, P[11]!));
    const step = next(f, requestId);
    expect(err(ST.declineStandinOffer(f.db, { offerId: step.offerId!, steamid: step.offered!, now: at(10) }))).toBe('standin_offer_expired');
    expect(ST.offerOf(f.db, step.offerId!)?.answer).toBe('expired');
    expect(err(ST.declineStandinOffer(f.db, { offerId: step.offerId!, steamid: step.offered!, now: at(10) }))).toBe('standin_offer_gone');
    expect(err(ST.expireStandinOffer(f.db, { requestId, now: at(11) }))).toBe('standin_offer_gone');
  });

  it('only the offered player declines, and an offer not yet due does not expire', () => {
    const f = standinFixture();
    const { requestId } = must(ask(f, P[11]!));
    const step = next(f, requestId);
    expect(err(ST.declineStandinOffer(f.db, { offerId: step.offerId!, steamid: BENCH[3]!, now: at(1) }))).toBe('standin_offer_gone');
    expect(err(ST.expireStandinOffer(f.db, { requestId, now: at(9) }))).toBe('standin_offer_gone');
  });

  it('closes a request whose player is no longer a starter (staff replaced them) instead of offering', () => {
    const f = standinFixture();
    const out = P[11]!;
    const entry = entryOf(f, out);
    const { requestId } = must(ask(f, out));
    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: entry.id, out, in: BENCH[4]!, reason: 'left', note: null, actor: ADMIN, now: at(1) }));
    expect(next(f, requestId, at(2))).toEqual({ offerId: null, offered: null, unfilled: false, cancelled: 'replace_not_starter' });
    expect(ST.requestOf(f.db, requestId)?.status).toBe('cancelled');
  });
});

describe('cancel and fail', () => {
  it('the captain cancels an open request, and its open offer stops', () => {
    const f = standinFixture();
    const out = P[11]!;
    const { requestId } = must(ask(f, out));
    const step = next(f, requestId);
    expect(err(ST.cancelStandin(f.db, { requestId, by: P[0]! === captainOf(f, out) ? P[1]! : P[0]!, staff: false, now: at(1) }))).toBe('not_manager');
    must(ST.cancelStandin(f.db, { requestId, by: captainOf(f, out), staff: false, now: at(1) }));
    expect(ST.requestOf(f.db, requestId)?.status).toBe('cancelled');
    expect(ST.offerOf(f.db, step.offerId!)?.answer).toBe('stopped');
    expect(err(ST.cancelStandin(f.db, { requestId, by: ADMIN, staff: true, now: at(2) }))).toBe('standin_closed');
  });

  it('a failed offer moves on, or with cancel closes the request', () => {
    const f = standinFixture();
    const { requestId } = must(ask(f, P[11]!));
    const s1 = next(f, requestId);
    must(ST.failStandinOffer(f.db, { offerId: s1.offerId!, why: 'player_entered', cancel: false, now: at(1) }));
    expect(ST.requestOf(f.db, requestId)?.status).toBe('open');
    const s2 = next(f, requestId, at(1));
    expect(s2.offered).toBe(BENCH[1]);
    must(ST.failStandinOffer(f.db, { offerId: s2.offerId!, why: 'standin_match_over', cancel: true, now: at(2) }));
    expect(ST.requestOf(f.db, requestId)?.status).toBe('cancelled');
    expect(logs(f, 'standin_offer_failed').map((d) => d.why)).toEqual(['player_entered', 'standin_match_over']);
  });
});

describe('withStandins', () => {
  it('swaps each missing player for their stand-in, and never puts a player in twice', () => {
    expect(ST.withStandins(['a', 'b', 'c', 'd'], [{ out: 'd', in: 'x' }])).toEqual(['a', 'b', 'c', 'x']);
    expect(ST.withStandins(['a', 'b', 'c', 'x'], [{ out: 'a', in: 'x' }])).toEqual(['a', 'b', 'c', 'x']);
    expect(ST.withStandins(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('final review fixes (plan D3a)', () => {
  it('refuses a second match request for a player whose stand-in for that match is already found', async () => {
    const f = await liveStandins();
    const out = P[11]!;
    const entry = entryOf(f, out);
    const o = offeredFor(f, entry.id, out, 'match');
    must(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: o.steamid, acceptedAt: at(1), now: at(1) }));
    expect(ST.requestOf(f.db, o.requestId)?.status).toBe('filled');
    expect(err(ask(f, out, { scope: 'match', now: at(2) }))).toBe('standin_open');
    // Once that stand-in has ended, the next match may have one.
    f.db.prepare("UPDATE draft_standins SET status = 'ended' WHERE id = ?").run(o.requestId);
    expect(err(ask(f, out, { scope: 'match', now: at(3) }))).toBeNull();
  });

  it('a rest-of-event request whose missing player became captain since is closed standin_captain, and an accept of it refused', () => {
    const f = standinFixture();
    const out = P[11]!;
    const entry = entryOf(f, out);
    const { requestId } = must(ask(f, out));
    must(N.setDraftCaptain(f.db, { eventId: f.eventId, entryId: entry.id, steamid: out, actor: ADMIN, now: NOW }));
    expect(next(f, requestId)).toEqual({ offerId: null, offered: null, unfilled: false, cancelled: 'standin_captain' });
    expect(ST.requestOf(f.db, requestId)?.status).toBe('cancelled');

    const g = standinFixture();
    const gEntry = entryOf(g, out);
    const o = offeredFor(g, gEntry.id, out, 'event');
    must(N.setDraftCaptain(g.db, { eventId: g.eventId, entryId: gEntry.id, steamid: out, actor: ADMIN, now: NOW }));
    expect(err(N.placeStandin(g.db, { eventId: g.eventId, requestId: o.requestId, offerId: o.offerId, steamid: o.steamid, acceptedAt: at(1), now: at(1) }))).toBe('standin_captain');
    expect(N.entryOfPlayer(g.db, g.eventId, o.steamid)).toBeUndefined();
  });

  it('refuses a rest-of-event request for a team with no match left in a live event, but not between Swiss rounds', async () => {
    const f = await liveStandins();
    const out = P[11]!;
    const entry = entryOf(f, out);
    // Test setup only: the team's round 1 match is done.
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE entry_a = ? OR entry_b = ?").run(entry.id, entry.id);
    expect(ST.nextMatchOf(f.db, f.eventId, entry.id)).toBeNull();
    // Swiss rounds are still to come: the team plays on.
    expect(err(ask(f, out, { now: at(1) }))).toBeNull();
    const other = N.rosterOf(f.db, entry.id).starters.find((s) => s !== out && s !== entry.captain_steamid)!;
    // Test setup only: the stage has played its last round.
    f.db.prepare("UPDATE event_stages SET config_json = json_set(config_json, '$.rounds', 1) WHERE event_id = ?").run(f.eventId);
    expect(err(ask(f, other, { now: at(2) }))).toBe('standin_no_match');
    f.db.prepare("UPDATE event_stages SET config_json = json_set(config_json, '$.rounds', 4) WHERE event_id = ?").run(f.eventId);
    // Test setup only: the team is out of the event.
    f.db.prepare("UPDATE event_entries SET status = 'eliminated' WHERE id = ?").run(entry.id);
    expect(err(ask(f, other, { now: at(3) }))).toBe('standin_no_match');
  });
});
