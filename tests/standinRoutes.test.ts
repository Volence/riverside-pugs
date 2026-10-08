// tests/standinRoutes.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { standinRoutes } from '../src/routes/standins.js';
import { Standins } from '../src/events/standinFlow.js';
import * as S from '../src/events/standins.js';
import { EVENT_ERRORS, type EventError } from '../src/events/validate.js';
import { getPlayer } from '../src/players.js';
import { authedCookie } from './helpers.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P } from './draftFixture.js';
import { BENCH, entryOf, standinFixture, type StandinFixture } from './standinFixture.js';

const MOD = '76561199000000777';
let f: StandinFixture;
let app: FastifyInstance;

async function build(fx: StandinFixture): Promise<void> {
  f = fx;
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(standinRoutes, { db: f.db, standins: new Standins({ db: f.db, now: () => NOW.getTime() }) });
  await app.ready();
  authedCookie(app, f.db, MOD);
  f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
}
afterEach(async () => { await app?.close(); });
const as = (s: string) => authedCookie(app, f.db, s);
const get = (url: string, who: string) => app.inject({ method: 'GET', url, cookies: as(who) });
const post = (url: string, who: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: as(who), payload: body });
const pub = (p = '') => `/api/events/${f.slug}${p}`;
const desk = (p: string) => `/api/admin/events/${f.eventId}${p}`;
const text = (k: EventError) => ({ error: EVENT_ERRORS[k].text });

describe('the event page routes', () => {
  it('a captain sees their four, asks for a stand-in, and sees its status but never who was asked or any SR', async () => {
    await build(standinFixture());
    const out = P[11]!;
    const e = entryOf(f, out);
    const captain = e.captain_steamid!;
    const v0 = (await get(pub('/standins'), captain)).json();
    expect(v0.offer).toBeNull();
    expect(v0.captain).toMatchObject({ entryId: e.id, open: true, canMatch: false, requests: [] });
    expect(v0.captain.starters).toHaveLength(4);
    const res = await post(pub('/standins'), captain, { entryId: e.id, out, scope: 'event' });
    expect(res.statusCode).toBe(200);
    const { requestId } = res.json();
    const v1 = (await get(pub('/standins'), captain)).json();
    expect(v1.captain.requests).toEqual([{
      id: requestId, out: { steamid: out, name: getPlayer(f.db, out)!.name }, scope: 'event', status: 'open', asked: 1, standin: null,
      requestedAt: NOW.toISOString(), marginOff: false,
    }]);
    const body = JSON.stringify(v1);
    expect(body).not.toContain(BENCH[0]!);
    expect(body).not.toContain('"sr"');
  });

  it('the bench player sees their offer, declines it, and the next player accepts; the captain then sees the stand-in', async () => {
    await build(standinFixture());
    const out = P[11]!;
    const e = entryOf(f, out);
    const { requestId } = (await post(pub('/standins'), e.captain_steamid!, { entryId: e.id, out, scope: 'event' })).json();
    const mine = (await get(pub('/standins'), BENCH[0]!)).json();
    expect(mine.captain).toBeNull();
    expect(mine.offer).toMatchObject({ team: e.name, out: getPlayer(f.db, out)!.name, scope: 'event', expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString() });
    expect((await post(pub(`/standin-offers/${mine.offer.offerId}`), BENCH[0]!, { accept: false })).statusCode).toBe(200);
    const next = (await get(pub('/standins'), BENCH[1]!)).json();
    expect((await post(pub(`/standin-offers/${next.offer.offerId}`), BENCH[0]!, { accept: true })).json()).toEqual(text('standin_offer_gone'));
    expect((await post(pub(`/standin-offers/${next.offer.offerId}`), BENCH[1]!, { accept: true })).statusCode).toBe(200);
    const v = (await get(pub('/standins'), e.captain_steamid!)).json();
    expect(v.captain.requests[0]).toMatchObject({ id: requestId, status: 'filled', standin: getPlayer(f.db, BENCH[1]!)!.name });
  });

  it('refuses a player who is not the captain, a bad body, a team event, and a closed switch', async () => {
    await build(standinFixture());
    const out = P[11]!;
    const e = entryOf(f, out);
    const notCaptain = e.captain_steamid === P[0] ? P[1]! : P[0]!;
    const r = await post(pub('/standins'), notCaptain, { entryId: e.id, out, scope: 'event' });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual(text('not_manager'));
    expect((await post(pub('/standins'), e.captain_steamid!, { out })).json()).toEqual(text('bad_request'));
    expect((await post(pub(`/standins/999/cancel`), e.captain_steamid!)).json()).toEqual(text('standin_closed'));
    // Test setup only: the same event read as a team event.
    f.db.prepare("UPDATE events SET entry_kind = 'team' WHERE id = ?").run(f.eventId);
    expect((await get(pub('/standins'), e.captain_steamid!)).json()).toEqual(text('not_draft'));
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await get(pub('/standins'), e.captain_steamid!)).statusCode).toBe(404);
  });

  it('a captain cancels their open request', async () => {
    await build(standinFixture());
    const e = entryOf(f, P[11]!);
    const { requestId } = (await post(pub('/standins'), e.captain_steamid!, { entryId: e.id, out: P[11], scope: 'event' })).json();
    expect((await post(pub(`/standins/${requestId}/cancel`), e.captain_steamid!)).statusCode).toBe(200);
    expect(S.requestOf(f.db, requestId)?.status).toBe('cancelled');
  });
});

describe('the desk routes', () => {
  it('mods read every request with each offer, SR and answer; admins ask, lift the limit, cancel and set the margin, each audited', async () => {
    await build(standinFixture());
    const e = entryOf(f, P[0]!);
    expect((await post(desk('/standins'), MOD, { entryId: e.id, out: P[0], scope: 'event' })).statusCode).toBe(403);
    const { requestId } = (await post(desk('/standins'), ADMIN, { entryId: e.id, out: P[0], scope: 'event' })).json();
    let v = (await get(desk('/standins'), MOD)).json();
    expect(v).toMatchObject({ margin: 100, open: true });
    expect(v.teams).toHaveLength(4);
    expect(v.teams.find((t: { entryId: number }) => t.entryId === e.id).starters).toHaveLength(4);
    expect(v.requests[0]).toMatchObject({ id: requestId, entryId: e.id, team: e.name, status: 'unfilled', margin: 100, offers: [] });
    expect((await post(desk(`/standins/${requestId}/margin-off`), ADMIN)).json()).toEqual({ reopened: true });
    v = (await get(desk('/standins'), MOD)).json();
    expect(v.requests[0].offers).toEqual([expect.objectContaining({ steamid: BENCH[0], sr: 1300, answer: null })]);
    expect((await post(desk(`/standins/${requestId}/cancel`), ADMIN)).statusCode).toBe(200);
    expect((await post(desk('/standin-margin'), ADMIN, { margin: 150 })).json()).toEqual({ margin: 150 });
    expect((await post(desk('/standin-margin'), ADMIN, { margin: -1 })).json()).toEqual(text('bad_standin_margin'));
    const audit = (f.db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_standin%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(audit).toEqual(['event_standin_request', 'event_standin_margin_off', 'event_standin_cancel', 'event_standin_margin']);
  });
});
