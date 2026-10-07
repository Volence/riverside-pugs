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
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const MOD = P[20];
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};

/** 21 signups a second apart in P order (P[0..2] want captaincy, P[3] says
 *  no, the rest willing), with signups closed: the default cut. */
function signAllAndClose(): void {
  const t = Date.now() - 60_000;
  P.forEach((s, i) => must(D.signUp(f.db, {
    eventId: f.eventId, steamid: s, captainPref: i < 3 ? 'want' : i === 3 ? 'no' : 'willing', note: `note ${i}`, now: new Date(t + i * 1000),
  })));
  must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date() }));
}

beforeEach(() => {
  f = draftFixture({ startsAt: days(9) });
  f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});

describe('the draft desk over HTTP', () => {
  let app: FastifyInstance;
  const cookies: Record<string, Record<string, string>> = {};
  beforeEach(async () => {
    app = await buildServer({
      config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'draft-desk-')) },
      db: f.db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    });
    for (const s of [P[0], P[5], P[10], MOD, ADMIN]) cookies[s] = authedCookie(app, f.db, s);
    signAllAndClose();
  });
  afterEach(async () => { await app.close(); });
  const get = (url: string, as?: string) => app.inject({ method: 'GET', url, cookies: as ? cookies[as] : undefined });
  const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });
  const base = () => `/api/admin/events/${f.eventId}/draft`;

  it('the event detail carries cutAt and teamsMadeAt for the desk panels', async () => {
    const res = await get(`/api/admin/events/${f.eventId}`, MOD);
    expect(res.json()).toMatchObject({ cutAt: null, teamsMadeAt: null });
  });

  it('lets a mod read the desk and refuses a mod every write', async () => {
    const res = await get(base(), MOD);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ cutAt: null, teams: 5, maxTeams: 5, offersOn: false, openOffer: null, problems: ['too_few_captains'] });
    expect(body.lockedAt).not.toBeNull();
    expect(body.signups).toHaveLength(21);
    // Pool first (no captains yet): the want volunteers by SR, then signup order.
    expect(body.signups.slice(0, 4).map((s: { steamid: string }) => s.steamid)).toEqual([P[2], P[1], P[0], P[3]]);
    expect(body.signups[0]).toMatchObject({ steamid: P[2], sr: 1050, captainPref: 'want', note: 'note 2', role: 'pool', manual: false, abandons30d: 0, noShows30d: 0, problems: [] });
    expect(body.signups.slice(-6).map((s: { role: string }) => s.role)).toEqual(Array(6).fill('bench'));
    expect((await get(base(), P[5])).statusCode).toBe(403);
    for (const [path, b] of [['teams', { teams: 4 }], ['captain', { steamid: P[0], captain: true }], ['swap', { pool: P[5], bench: P[20] }], ['pick-captains', {}], ['publish', {}]] as const) {
      expect((await post(`${base()}/${path}`, MOD, b)).statusCode, path).toBe(403);
    }
    expect(E.getEvent(f.db, f.eventId)!.draft_teams).toBe(5);
  });

  it('picks captains for an admin only, audited', async () => {
    const r = await post(`${base()}/pick-captains`, ADMIN);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, captains: [P[20], P[19], P[18], P[17], P[16]], short: 0 });
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event_draft_pick_captains'").get() as { n: number }).n).toBe(1);
    expect((await get(base(), ADMIN)).json().signups.filter((s: { role: string }) => s.role === 'captain')).toHaveLength(5);
  });

  it('runs the cut as an admin, audited, and refuses what the writer refuses', async () => {
    expect((await post(`${base()}/teams`, ADMIN, { teams: 6 })).statusCode).toBe(409);
    expect((await post(`${base()}/teams`, ADMIN, { teams: 'x' })).statusCode).toBe(400);
    expect((await post(`${base()}/teams`, ADMIN, { teams: 4 })).statusCode).toBe(200);
    for (const s of [P[0], P[1], P[2], P[4]]) expect((await post(`${base()}/captain`, ADMIN, { steamid: s, captain: true })).statusCode).toBe(200);
    expect((await post(`${base()}/captain`, ADMIN, { steamid: P[0], captain: 'yes' })).statusCode).toBe(400);
    expect((await post(`${base()}/swap`, ADMIN, { pool: P[5], bench: P[20] })).statusCode).toBe(200);
    expect((await post(`${base()}/swap`, ADMIN, { pool: P[5], bench: P[20] })).statusCode).toBe(409);
    const desk = (await get(base(), ADMIN)).json();
    expect(desk.problems).toEqual([]);
    expect(desk.signups.slice(0, 4).map((s: { steamid: string; role: string }) => [s.steamid, s.role]))
      .toEqual([[P[4], 'captain'], [P[2], 'captain'], [P[1], 'captain'], [P[0], 'captain']]);
    expect(desk.signups.find((s: { steamid: string }) => s.steamid === P[20])).toMatchObject({ role: 'pool', manual: true });
    const actions = (f.db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_draft%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['event_draft_teams', 'event_draft_captain', 'event_draft_captain', 'event_draft_captain', 'event_draft_captain', 'event_draft_swap']);
  });

  it('refuses a stale publish with the problems and counts', async () => {
    for (const s of P.slice(0, 5)) must(D.setCaptain(f.db, { eventId: f.eventId, steamid: s, captain: true, actor: ADMIN, now: new Date() }));
    // A captain removed: nobody is promoted, so the cut is short a captain.
    must(D.removeSignup(f.db, { eventId: f.eventId, steamid: P[0], reason: 'removed', actor: ADMIN, now: new Date() }));
    const res = await post(`${base()}/publish`, ADMIN);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ problems: ['too_few_captains'], cut: { captains: 4, pool: 15, poolNeeded: 15, active: 20 } });
    expect(E.getEvent(f.db, f.eventId)!.cut_at).toBeNull();
  });

  it('after publish shows the public the cut as names only, and the player their own role', async () => {
    for (const s of P.slice(0, 5)) must(D.setCaptain(f.db, { eventId: f.eventId, steamid: s, captain: true, actor: ADMIN, now: new Date() }));
    const before = await get(`/api/events/${f.slug}`, P[5]);
    expect(before.json().draft.cut).toBeNull();
    expect((await get(`/api/events/${f.slug}/mine`, P[5])).json().signup.role).toBeNull();
    expect((await post(`${base()}/publish`, ADMIN)).statusCode).toBe(200);
    const name = (i: number) => (i === 0 || i === 5 || i === 10 ? `p9${String(i).padStart(2, '0')}` : i === 20 ? 'p920' : `d${i}`);
    for (const as of [P[5], undefined]) {
      const pub = await get(`/api/events/${f.slug}`, as);
      expect(pub.statusCode).toBe(200);
      expect(pub.json().draft.cut).toEqual({
        captains: [0, 1, 2, 3, 4].map(name),
        pool: Array.from({ length: 15 }, (_, k) => name(k + 5)),
        bench: [name(20)],
      });
      for (const key of ['"sr"', '"note"', '"captainPref"', 'note 1', '"abandons30d"', '"noShows30d"']) expect(pub.body).not.toContain(key);
    }
    expect((await get(`/api/events/${f.slug}/mine`, P[0])).json().signup.role).toBe('captain');
    expect((await get(`/api/events/${f.slug}/mine`, P[5])).json().signup.role).toBe('pool');
    expect((await get(`/api/events/${f.slug}/mine`, MOD)).json().signup.role).toBe('bench');
    const mine = await get(`/api/events/${f.slug}/mine`, P[10]);
    expect(mine.body).not.toContain('note 1"');
    expect(mine.body).not.toContain('"sr"');
    expect((await post(`${base()}/teams`, ADMIN, { teams: 4 })).statusCode).toBe(409);
    expect((await get(base(), ADMIN)).json().cutAt).not.toBeNull();
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event_draft_publish'").get() as { n: number }).n).toBe(1);
  });
});

describe('the cut DMs', () => {
  let desk: FastifyInstance;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    send = vi.fn(() => 1);
    desk = Fastify();
    await desk.register(cookie, { secret: 'x'.repeat(32) });
    await desk.register(adminEventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' });
    await desk.ready();
    signAllAndClose();
  });
  afterEach(async () => { await desk.close(); });
  const deskPost = (url: string, body: object = {}) => desk.inject({ method: 'POST', url, cookies: authedCookie(desk, f.db, ADMIN), payload: body });

  it('tells every active signup their role and the draft time once the cut is published', async () => {
    for (const s of P.slice(0, 5)) must(D.setCaptain(f.db, { eventId: f.eventId, steamid: s, captain: true, actor: ADMIN, now: new Date() }));
    expect((await deskPost(`/api/admin/events/${f.eventId}/draft/publish`)).statusCode).toBe(200);
    const when = `<t:${Math.floor(Date.parse(f.draftAt) / 1000)}:F>`;
    const calls = send.mock.calls.map(([to, type, payload]) => ({ to: [...(to as string[])], type, content: (payload as { content: string }).content }));
    expect(calls).toEqual([
      { to: P.slice(0, 5), type: 'draft_cut_role', content: `You are a captain in Draft Night. Teams are made ${when}: staff either balance them by SR or you pick your players live, and you will hear which. Keep the time free: https://x/event/${f.slug}` },
      { to: P.slice(5, 20), type: 'draft_cut_role', content: `You are in the player pool for Draft Night. Teams are made ${when}, by SR balance or a live captains' draft; you will get a DM with your team: https://x/event/${f.slug}` },
      { to: [P[20]], type: 'draft_cut_role', content: `You are on the free-agent bench for Draft Night. Teams are made ${when}; captains can call on you as a stand-in, so keep the night free if you can: https://x/event/${f.slug}` },
    ]);
  });

  it('sends nothing when publish is refused', async () => {
    expect((await deskPost(`/api/admin/events/${f.eventId}/draft/publish`)).statusCode).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });
});
