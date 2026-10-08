import { describe, it, expect, vi, afterEach } from 'vitest';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import * as N from '../src/events/entries.js';
import * as ST from '../src/events/standins.js';
import * as V from '../src/events/validate.js';
import { Standins, type StandinDeps } from '../src/events/standinFlow.js';
import type { Notifier } from '../src/notify/notify.js';
import type { MessagePayload } from '../src/discord/transport.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P } from './draftFixture.js';
import { BENCH, entryOf, liveStandins, standinFixture, type StandinFixture } from './standinFixture.js';

const MIN = 60_000;
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
let unsub: (() => void) | null = null;
afterEach(() => { unsub?.(); unsub = null; });

function harness(f: StandinFixture, o: { series?: StandinDeps['series']; t?: { t: number } } = {}) {
  const t = o.t ?? { t: NOW.getTime() };
  const dms: { to: string[]; type: string; payload: MessagePayload }[] = [];
  const send = vi.fn((to: Iterable<string>, type: string, payload: MessagePayload) => { dms.push({ to: [...to], type, payload }); return 1; });
  const alerts: AdminEvent[] = [];
  unsub = subscribeAdminEvents((e) => { alerts.push(e); });
  const pushes: number[] = [];
  const standins = new Standins({
    db: f.db, notifier: { send } as unknown as Notifier, publicUrl: 'https://x', now: () => t.t,
    rooms: { pushChange: (id) => { pushes.push(id); } }, ...(o.series ? { series: o.series } : {}),
  });
  return { t, dms, alerts, pushes, standins, last: (type: string) => dms.filter((d) => d.type === type).at(-1) };
}
const askEvent = (h: ReturnType<typeof harness>, f: StandinFixture, out: string) => {
  const e = entryOf(f, out);
  return h.standins.request({ eventId: f.eventId, entryId: e.id, out, scope: 'event', by: e.captain_steamid!, staff: false });
};
const otherStarter = (f: StandinFixture, notOn: number) => {
  const other = f.entries.find((id) => id !== notOn)!;
  return { other, out: N.rosterOf(f.db, other).starters.find((s) => s !== N.getEntry(f.db, other)!.captain_steamid)! };
};

describe('Standins', () => {
  it('asks the bench one at a time by DM: a decline moves on at once, an expiry at the next tick, and an accept places the stand-in and tells everyone', async () => {
    const f = standinFixture();
    const h = harness(f);
    const out = P[11]!;
    const captain = entryOf(f, out).captain_steamid!;
    const { requestId } = must(askEvent(h, f, out));
    const first = h.last('draft_standin_offer')!;
    const offer1 = ST.openOfferOf(f.db, requestId)!;
    expect(first.to).toEqual([BENCH[0]]);
    expect(first.payload.components[0]!.map((b) => ('customId' in b ? b.customId : b.url))).toEqual([`ds:a:${offer1.id}`, `ds:d:${offer1.id}`, `https://x/event/${f.slug}`]);
    expect(first.payload.content).toContain('for the rest of the event');
    must(h.standins.decline({ offerId: offer1.id, steamid: BENCH[0]! }));
    expect(h.last('draft_standin_offer')!.to).toEqual([BENCH[1]]);
    h.t.t += 9 * MIN;
    h.standins.tick();
    expect(ST.openOfferOf(f.db, requestId)!.steamid).toBe(BENCH[1]);
    h.t.t += MIN;
    h.standins.tick();
    const offer3 = ST.openOfferOf(f.db, requestId)!;
    expect(offer3.steamid).toBe(BENCH[2]);
    expect((await h.standins.accept({ offerId: offer3.id, steamid: BENCH[2]! })).ok).toBe(true);
    expect(entryOf(f, BENCH[2]!).captain_steamid).toBe(captain);
    expect(h.last('draft_standin_placed')!.to).toEqual([BENCH[2]]);
    expect(h.last('draft_standin_placed')!.payload.content).toContain('for the rest of the event');
    expect(h.last('draft_standin_filled')!.to.sort()).toEqual([captain, out].sort());
  });

  it('no takers: staff are alerted with a desk link, the captain is told, and the dropout gets one staff note; lifting the limit asks again', () => {
    const f = standinFixture();
    const h = harness(f);
    const out = P[0]!;
    const captain = entryOf(f, out).captain_steamid!;
    const { requestId } = must(askEvent(h, f, out));
    expect(ST.requestOf(f.db, requestId)?.status).toBe('unfilled');
    const alert = h.alerts.find((a): a is Extract<AdminEvent, { kind: 'problem' }> => a.kind === 'problem')!;
    expect(alert.text).toContain('nobody on the bench took the stand-in');
    expect(alert.link).toEqual({ label: 'Open the Events desk', path: `/admin/events/${f.eventId}` });
    expect(h.last('draft_standin_none')!.to).toEqual([captain]);
    const notes = () => f.db.prepare('SELECT author_id, text FROM player_notes WHERE player_id = ?').all(out) as { author_id: string; text: string }[];
    expect(notes()).toEqual([{ author_id: 'system', text: expect.stringContaining('no stand-in was found on the bench') }]);
    expect(must(h.standins.marginOff({ requestId, by: ADMIN }))).toEqual({ reopened: true });
    for (const s of BENCH) {
      const o = ST.openOfferOf(f.db, requestId)!;
      expect(o.steamid).toBe(s);
      must(h.standins.decline({ offerId: o.id, steamid: s! }));
    }
    expect(ST.requestOf(f.db, requestId)?.status).toBe('unfilled');
    expect(notes()).toHaveLength(1);
  });

  it('a match request that goes unfilled writes no note', async () => {
    const f = await liveStandins();
    const h = harness(f);
    const out = P[0]!;
    const e = entryOf(f, out);
    must(h.standins.request({ eventId: f.eventId, entryId: e.id, out, scope: 'match', by: e.captain_steamid!, staff: false }));
    expect(h.last('draft_standin_none')).toBeDefined();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM player_notes').get()).toEqual({ n: 0 });
  });

  it('Review Focus 1: a tick while an accept is with the game server never expires that offer, and the press time decides', async () => {
    const f = standinFixture();
    const t = { t: NOW.getTime() };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const series = { standinPlace: vi.fn(async (o: Parameters<NonNullable<StandinDeps['series']>['standinPlace']>[0]) => { await gate; return N.placeStandin(f.db, { ...o, now: new Date(t.t) }); }) };
    const h = harness(f, { series, t });
    const { requestId } = must(askEvent(h, f, P[11]!));
    const offer = ST.openOfferOf(f.db, requestId)!;
    // Pressed one second before the window ends.
    t.t += 10 * MIN - 1000;
    const pending = h.standins.accept({ offerId: offer.id, steamid: BENCH[0]! });
    // The game server is slow: the window has passed and the real tick runs.
    t.t += 5000;
    expect(Date.parse(offer.expires_at)).toBeLessThan(t.t);
    h.standins.tick();
    expect(ST.offerOf(f.db, offer.id)?.answer).toBeNull();
    expect(ST.offersOf(f.db, requestId)).toHaveLength(1);
    // A second press while the first is in flight does nothing.
    expect((await h.standins.accept({ offerId: offer.id, steamid: BENCH[0]! })).ok).toBe(false);
    release();
    expect((await pending).ok).toBe(true);
    expect(series.standinPlace).toHaveBeenCalledTimes(1);
    expect(ST.requestOf(f.db, requestId)).toMatchObject({ status: 'filled', filled_by: BENCH[0] });
    // Placed once, answered once: one accepted offer, one log row each, and the next tick changes nothing.
    h.standins.tick();
    expect(ST.offersOf(f.db, requestId).map((o) => o.answer)).toEqual(['accept']);
    const actions = (f.db.prepare("SELECT action FROM event_log WHERE action LIKE 'standin_%' AND json_extract(detail, '$.requestId') = ? ORDER BY id").all(requestId) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['standin_requested', 'standin_offered', 'standin_placed']);
    expect(N.placesOf(f.db, entryOf(f, BENCH[0]!).id).filter((p) => p.steamid === BENCH[0])).toHaveLength(1);
    expect(h.dms.filter((d) => d.type === 'draft_standin_placed')).toHaveLength(1);
  });

  it('Review Focus 1: an accept pressed after the window, before the tick got to it, is refused and the next player is asked', async () => {
    const f = standinFixture();
    const h = harness(f);
    const { requestId } = must(askEvent(h, f, P[11]!));
    const offer = ST.openOfferOf(f.db, requestId)!;
    h.t.t += 10 * MIN;
    const r = await h.standins.accept({ offerId: offer.id, steamid: BENCH[0]! });
    expect(!r.ok && r.error).toBe('standin_offer_expired');
    expect(ST.offerOf(f.db, offer.id)?.answer).toBe('expired');
    expect(h.last('draft_standin_offer')!.to).toEqual([BENCH[1]]);
    expect(N.entryOfPlayer(f.db, f.eventId, BENCH[0]!)).toBeUndefined();
  });

  it('an accept by a player placed elsewhere since fails that offer and asks the next', async () => {
    const f = standinFixture();
    const h = harness(f);
    const { requestId } = must(askEvent(h, f, P[11]!));
    const o1 = ST.openOfferOf(f.db, requestId)!;
    const x = otherStarter(f, entryOf(f, P[11]!).id);
    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: x.other, out: x.out, in: BENCH[0]!, reason: 'other', note: null, actor: ADMIN, now: NOW }));
    const r = await h.standins.accept({ offerId: o1.id, steamid: BENCH[0]! });
    expect(!r.ok && r.error).toBe('player_entered');
    expect(ST.offerOf(f.db, o1.id)?.answer).toBe('failed');
    expect(h.last('draft_standin_offer')!.to).toEqual([BENCH[1]]);
  });

  it('Ruling 12: an accept after the missing player was replaced fails the offer, closes the request, places nothing and tells the bench player plainly', async () => {
    const f = standinFixture();
    const h = harness(f);
    const out = P[11]!;
    const entry = entryOf(f, out);
    const { requestId } = must(askEvent(h, f, out));
    const o1 = ST.openOfferOf(f.db, requestId)!;
    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: entry.id, out, in: BENCH[4]!, reason: 'left', note: null, actor: ADMIN, now: NOW }));
    const r = await h.standins.accept({ offerId: o1.id, steamid: BENCH[0]! });
    expect(!r.ok && r.error).toBe('standin_closed');
    expect(!r.ok && V.EVENT_ERRORS[r.error].text).toBe('That stand-in request is no longer open.');
    expect(ST.offerOf(f.db, o1.id)?.answer).toBe('failed');
    expect(ST.requestOf(f.db, requestId)?.status).toBe('cancelled');
    expect(N.entryOfPlayer(f.db, f.eventId, BENCH[0]!)).toBeUndefined();
    expect(h.dms.filter((d) => d.type === 'draft_standin_offer')).toHaveLength(1);
    expect(h.last('draft_standin_placed')).toBeUndefined();
    expect(f.db.prepare("SELECT json_extract(detail, '$.why') AS why, json_extract(detail, '$.cancelled') AS cancelled FROM event_log WHERE action = 'standin_offer_failed'").all())
      .toEqual([{ why: 'replace_not_starter', cancelled: 1 }]);
  });

  it('Ruling 12: an accept for a match that has ended closes the request and places nothing', async () => {
    const f = await liveStandins();
    const h = harness(f);
    const out = P[11]!;
    const entry = entryOf(f, out);
    must(h.standins.request({ eventId: f.eventId, entryId: entry.id, out, scope: 'match', by: entry.captain_steamid!, staff: false }));
    const req = ST.requestsOf(f.db, f.eventId)[0]!;
    const offer = ST.openOfferOf(f.db, req.id)!;
    // Test setup only: the match is over.
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(req.match_id);
    const r = await h.standins.accept({ offerId: offer.id, steamid: offer.steamid });
    expect(!r.ok && r.error).toBe('standin_closed');
    expect(ST.offerOf(f.db, offer.id)?.answer).toBe('failed');
    expect(ST.requestOf(f.db, req.id)?.status).toBe('cancelled');
    expect(N.rosterOf(f.db, entry.id).subs).toEqual([]);
  });

  it('Ruling 12: the series engine finding the request gone fails the offer with the request closed', async () => {
    const f = standinFixture();
    const series = { standinPlace: vi.fn(async () => V.fail('standin_offer_gone') as V.Checked<N.StandinPlaced>) };
    const h = harness(f, { series });
    const { requestId } = must(askEvent(h, f, P[11]!));
    const o1 = ST.openOfferOf(f.db, requestId)!;
    const r = await h.standins.accept({ offerId: o1.id, steamid: BENCH[0]! });
    expect(!r.ok && r.error).toBe('standin_closed');
    expect(ST.offerOf(f.db, o1.id)?.answer).toBe('failed');
    expect(ST.requestOf(f.db, requestId)?.status).toBe('cancelled');
    expect(h.dms.filter((d) => d.type === 'draft_standin_offer')).toHaveLength(1);
  });

  it('a game server that refuses the sub mid-chapter leaves the offer open for another press', async () => {
    const f = standinFixture();
    const series = { standinPlace: vi.fn(async () => V.fail('replace_in_game', [{ steamid: P[11]!, problems: ['The server said: mid chapter.'] }]) as V.Checked<N.StandinPlaced>) };
    const h = harness(f, { series });
    const { requestId } = must(askEvent(h, f, P[11]!));
    const o1 = ST.openOfferOf(f.db, requestId)!;
    const r = await h.standins.accept({ offerId: o1.id, steamid: BENCH[0]! });
    expect(!r.ok && r.error).toBe('replace_in_game');
    expect(ST.offerOf(f.db, o1.id)?.answer).toBeNull();
    expect(ST.requestOf(f.db, requestId)?.status).toBe('open');
  });

  it('Review Focus 5: a match stand-in leaves the roster once the match is over and is back on the bench for the next request', async () => {
    const f = await liveStandins();
    const h = harness(f);
    const out = P[11]!;
    const entry = entryOf(f, out);
    must(h.standins.request({ eventId: f.eventId, entryId: entry.id, out, scope: 'match', by: entry.captain_steamid!, staff: false }));
    const req = ST.requestsOf(f.db, f.eventId)[0]!;
    const offer = ST.openOfferOf(f.db, req.id)!;
    expect(h.last('draft_standin_offer')!.payload.content).toContain('for their next match, against');
    must(await h.standins.accept({ offerId: offer.id, steamid: BENCH[0]! }));
    expect(N.rosterOf(f.db, entry.id).subs).toEqual([BENCH[0]]);
    h.standins.tick();
    expect(N.rosterOf(f.db, entry.id).subs).toEqual([BENCH[0]]);
    // Test setup only: the match is over.
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(req.match_id);
    h.standins.tick();
    expect(N.rosterOf(f.db, entry.id).subs).toEqual([]);
    expect(ST.requestOf(f.db, req.id)?.status).toBe('ended');
    expect(h.pushes).toContain(req.match_id);
    must(askEvent(h, f, P[10]!));
    expect(h.last('draft_standin_offer')!.to).toEqual([BENCH[0]]);
  });
});
