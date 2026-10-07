import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { adminEventRoutes } from '../src/routes/adminEvents.js';
import type { Notifier } from '../src/notify/notify.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as D from '../src/events/drafts.js';
import * as E from '../src/events/events.js';
import { ADMIN } from './eventFixture.js';
import { P, draftFixture, type DraftFixture } from './draftFixture.js';

let f: DraftFixture;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(async () => {
  f = draftFixture({ startsAt: days(9) });
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'draft-signups-')) },
    db: f.db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const s of [...P.slice(0, 8), ADMIN]) cookies[s] = authedCookie(app, f.db, s);
});
afterEach(async () => { await app.close(); });

const get = (url: string, as?: string) => app.inject({ method: 'GET', url, cookies: as ? cookies[as] : undefined });
const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });

describe('draft signups over HTTP', () => {
  it('signs up and withdraws, and refuses what the writer refuses', async () => {
    const res = await post(`/api/events/${f.slug}/signup`, P[0], { captainPref: 'want', note: 'prefer infected' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, signup: { captainPref: 'want', note: 'prefer infected', role: null } });
    expect((await post(`/api/events/${f.slug}/signup`, P[0], { captainPref: 'want' })).json())
      .toEqual({ error: 'You are already signed up for this draft.' });
    expect((await post(`/api/events/${f.slug}/signup`, P[1], { captainPref: 'maybe' })).statusCode).toBe(400);
    expect((await post(`/api/events/${f.slug}/signup`, P[1], { captainPref: 'no', note: 'x'.repeat(81) })).statusCode).toBe(400);
    expect((await get(`/api/events/${f.slug}/mine`, P[0])).json().signup).toEqual({ captainPref: 'want', note: 'prefer infected', role: null });
    expect((await post(`/api/events/${f.slug}/withdraw-signup`, P[0])).statusCode).toBe(200);
    expect((await get(`/api/events/${f.slug}/mine`, P[0])).json().signup).toBeNull();
    expect((await post(`/api/events/${f.slug}/withdraw-signup`, P[0])).statusCode).toBe(409);
  });

  it('names the problems of an ineligible signup', async () => {
    f.db.prepare('UPDATE players SET discord_id = NULL WHERE steamid = ?').run(P[2]);
    const res = await post(`/api/events/${f.slug}/signup`, P[2], { captainPref: 'no' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'You do not meet the entry rules for this event.',
      problems: [{ steamid: P[2], name: 'p902', problems: ['Discord is not linked'] }],
    });
  });

  it('refuses a team event in registration with not_draft, and hides an unpublished draft', async () => {
    const ev = E.createEvent(f.db, { by: ADMIN, fields: { name: 'Team Cup', startsAt: f.startsAt, entryKind: 'team' } });
    if (!ev.ok) throw new Error(ev.error);
    f.db.prepare("UPDATE events SET status = 'registration' WHERE id = ?").run(ev.value.id);
    const r = await post(`/api/events/${ev.value.slug}/signup`, P[0], { captainPref: 'want' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('This event takes team entries, not draft signups.');
    const hidden = E.createEvent(f.db, { by: ADMIN, fields: { name: 'Hidden Night', startsAt: f.startsAt, entryKind: 'draft', draft: { signupsCloseAt: f.closeAt, draftAt: f.draftAt } } });
    if (!hidden.ok) throw new Error(hidden.error);
    expect((await post(`/api/events/${hidden.value.slug}/signup`, P[0], { captainPref: 'want' })).statusCode).toBe(404);
  });

  it('answers 404 with the switch closed', async () => {
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await post(`/api/events/${f.slug}/signup`, P[0], { captainPref: 'want' })).statusCode).toBe(404);
    expect((await post(`/api/events/${f.slug}/withdraw-signup`, P[0])).statusCode).toBe(404);
    expect((await get(`/api/events/${f.slug}`)).statusCode).toBe(404);
  });

  it('shows the public the count and names only; the viewer sees only their own preference and note', async () => {
    await post(`/api/events/${f.slug}/signup`, P[0], { captainPref: 'want', note: 'prefer infected' });
    await post(`/api/events/${f.slug}/signup`, P[1], { captainPref: 'willing', note: 'flex' });
    const pub = await get(`/api/events/${f.slug}`, P[2]);
    expect(pub.statusCode).toBe(200);
    expect(pub.json().draft).toEqual({ signupsCloseAt: f.closeAt, draftAt: f.draftAt, signups: 2, names: ['p900', 'p901'], cut: null });
    for (const key of ['"sr"', '"note"', '"captainPref"', 'prefer infected', 'flex']) expect(pub.body).not.toContain(key);
    const anon = await get(`/api/events/${f.slug}`);
    expect(anon.json().draft.names).toEqual(['p900', 'p901']);
    const mine = await get(`/api/events/${f.slug}/mine`, P[1]);
    expect(mine.json().signup).toEqual({ captainPref: 'willing', note: 'flex', role: null });
    expect(mine.body).not.toContain('prefer infected');
    expect(mine.body).not.toContain('"sr"');
    const other = await get(`/api/events/${f.slug}/mine`, P[2]);
    expect(other.json().signup).toBeNull();
  });

  it('closes signups and removes one from the desk, admin only, audited', async () => {
    D.signUp(f.db, { eventId: f.eventId, steamid: P[0], captainPref: 'want', note: null, now: new Date() });
    const MOD = P[3];
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    expect((await post(`/api/admin/events/${f.eventId}/close-signups`, MOD)).statusCode).toBe(403);
    expect((await post(`/api/admin/events/${f.eventId}/close-signups`, ADMIN)).statusCode).toBe(200);
    expect(E.getEvent(f.db, f.eventId)!.locked_at).not.toBeNull();
    expect((await post(`/api/admin/events/${f.eventId}/signups/${P[0]}/remove`, ADMIN, { reason: 'banned' })).statusCode).toBe(400);
    expect((await post(`/api/admin/events/${f.eventId}/signups/${P[0]}/remove`, ADMIN, { reason: 'removed' })).statusCode).toBe(200);
    expect(D.signupOf(f.db, f.eventId, P[0])).toBeNull();
    const actions = (f.db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['event_close_signups', 'event_signup_remove']);
  });
});

/** P[0..7] signed up willing, closed: 2 teams, nobody captain yet. The
 *  highest SR is P[7], then P[6]. */
function eightClosed(): void {
  for (const s of P.slice(0, 8)) {
    const r = D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now: new Date() });
    if (!r.ok) throw new Error(r.error);
  }
  const c = D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date() });
  if (!c.ok) throw new Error(c.error);
}

describe('captaincy offers over HTTP', () => {
  it('staff start offers; only the offered player sees and answers theirs, accept and decline', async () => {
    eightClosed();
    const MOD = P[3];
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    const desk = `/api/admin/events/${f.eventId}/draft/offers`;
    expect((await post(desk, MOD, { on: true })).statusCode).toBe(403);
    expect((await post(desk, ADMIN, { on: 'yes' })).statusCode).toBe(400);
    const started = await post(desk, ADMIN, { on: true });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({ offered: P[7] });
    expect((await post(desk, ADMIN, { on: true })).json()).toEqual({ error: 'Captaincy offers are already running.' });

    const mine = await get(`/api/events/${f.slug}/mine`, P[7]);
    const expiresAt = (f.db.prepare('SELECT expires_at FROM draft_captain_offers WHERE answer IS NULL').get() as { expires_at: string }).expires_at;
    expect(mine.json().offer).toEqual({ expiresAt });
    const other = await get(`/api/events/${f.slug}/mine`, P[6]);
    expect(other.json().offer).toBeNull();
    expect(other.body).not.toContain(P[7]);
    const pub = await get(`/api/events/${f.slug}`, P[6]);
    expect(pub.body).not.toContain('expiresAt');
    expect(pub.body).not.toContain('offer');

    const url = `/api/events/${f.slug}/captain-offer`;
    expect((await post(url, P[6], { accept: true })).json()).toEqual({ error: 'You have no open captaincy offer for this draft.' });
    expect((await post(url, P[7], { accept: 'no' })).statusCode).toBe(400);
    expect((await post(url, P[7], { accept: false })).statusCode).toBe(200);
    expect((await get(`/api/events/${f.slug}/mine`, P[7])).json().offer).toBeNull();

    const next = D.offerNext(f.db, { eventId: f.eventId, now: new Date(), minutes: 30 });
    expect(next).toEqual({ ok: true, value: { offered: P[6] } });
    expect((await post(url, P[6], { accept: true })).statusCode).toBe(200);
    expect(D.signupOf(f.db, f.eventId, P[6])!.role).toBe('captain');
    expect((await post(url, P[6], { accept: true })).statusCode).toBe(409);

    expect((await post(desk, ADMIN, { on: false })).statusCode).toBe(200);
    expect(E.getEvent(f.db, f.eventId)!.offers_on).toBe(0);
    const actions = (f.db.prepare("SELECT action, detail FROM admin_actions WHERE action = 'event_draft_offers' ORDER BY id").all() as { action: string; detail: string }[])
      .map((r) => JSON.parse(r.detail));
    expect(actions).toEqual([{ slug: f.slug, on: true }, { slug: f.slug, on: false }]);
  });

  it('answers 404 for the switch closed and an unknown event', async () => {
    eightClosed();
    expect((await post(`/api/events/nope/captain-offer`, P[7], { accept: true })).statusCode).toBe(404);
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await post(`/api/events/${f.slug}/captain-offer`, P[7], { accept: true })).statusCode).toBe(404);
  });
});

describe('desk removal DM', () => {
  let desk: FastifyInstance;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    send = vi.fn(() => 1);
    desk = Fastify();
    await desk.register(cookie, { secret: 'x'.repeat(32) });
    await desk.register(adminEventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' });
    await desk.ready();
  });
  afterEach(async () => { await desk.close(); });
  const deskPost = (url: string, body: object = {}) => desk.inject({ method: 'POST', url, cookies: authedCookie(desk, f.db, ADMIN), payload: body });

  it('DMs the first offeree when staff start offers', async () => {
    eightClosed();
    expect((await deskPost(`/api/admin/events/${f.eventId}/draft/offers`, { on: true })).statusCode).toBe(200);
    const expiresAt = (f.db.prepare('SELECT expires_at FROM draft_captain_offers WHERE answer IS NULL').get() as { expires_at: string }).expires_at;
    const calls = send.mock.calls.map(([to, type, payload]) => ({ to: [...(to as string[])], type, content: (payload as { content: string }).content }));
    expect(calls).toEqual([{
      to: [P[7]], type: 'draft_captain_offer',
      content: `Draft Night needs another captain and you said you were willing. Accept or decline on the event page by <t:${Math.floor(Date.parse(expiresAt) / 1000)}:F>: https://x/event/${f.slug}`,
    }]);
  });

  it('tells the removed player why', async () => {
    D.signUp(f.db, { eventId: f.eventId, steamid: P[0], captainPref: 'want', note: null, now: new Date() });
    D.signUp(f.db, { eventId: f.eventId, steamid: P[1], captainPref: 'no', note: null, now: new Date() });
    expect((await deskPost(`/api/admin/events/${f.eventId}/signups/${P[0]}/remove`, { reason: 'removed' })).statusCode).toBe(200);
    expect((await deskPost(`/api/admin/events/${f.eventId}/signups/${P[1]}/remove`, { reason: 'ineligible' })).statusCode).toBe(200);
    const calls = send.mock.calls.map(([to, type, payload]) => ({ to: [...(to as string[])], type, content: (payload as { content: string }).content }));
    expect(calls).toEqual([
      { to: [P[0]], type: 'draft_signup_removed', content: 'Staff removed your signup for Draft Night: an organizer removed it.' },
      { to: [P[1]], type: 'draft_signup_removed', content: 'Staff removed your signup for Draft Night: you are not eligible for this event.' },
    ]);
    expect((await deskPost(`/api/admin/events/${f.eventId}/signups/${P[0]}/remove`, { reason: 'removed' })).statusCode).toBe(409);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
