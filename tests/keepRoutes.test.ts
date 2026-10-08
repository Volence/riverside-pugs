// tests/keepRoutes.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { keepRoutes } from '../src/routes/keepTeam.js';
import { teamRoutes } from '../src/routes/teams.js';
import * as K from '../src/events/keepTeam.js';
import { EVENT_ERRORS, type EventError } from '../src/events/validate.js';
import type { CommunityStore } from '../src/community/store.js';
import { authedCookie } from './helpers.js';
import { BENCH, FINISHED, finishedDraft, type StandinFixture } from './standinFixture.js';

const H = 3_600_000;
let f: StandinFixture;
let app: FastifyInstance;
let t = FINISHED.getTime() + H;

async function build(): Promise<{ keepId: number; four: string[] }> {
  f = finishedDraft();
  t = FINISHED.getTime() + H;
  const offered = K.offerKeep(f.db, { entryId: f.entries[0]!, now: new Date(t) }) as { ok: true; value: { keepId: number } };
  const keepId = offered.value.keepId;
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(keepRoutes, { db: f.db, publicUrl: 'https://x', now: () => t });
  await app.register(teamRoutes, { db: f.db, store: () => ({}) as CommunityStore, publicUrl: 'https://x' });
  await app.ready();
  return { keepId, four: K.playersOf(K.keepOf(f.db, keepId)!) };
}
afterEach(async () => { await app?.close(); });
const as = (s: string) => authedCookie(app, f.db, s);
const get = (url: string, who: string) => app.inject({ method: 'GET', url, cookies: as(who) });
const post = (url: string, who: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: as(who), payload: body });
const keep = (p = '') => `/api/events/${f.slug}/keep${p}`;
const text = (k: EventError) => ({ error: EVENT_ERRORS[k].text });

describe('Keep this team on the event page', () => {
  it('the captain keeps the team, two accept, and the new team page says where it was formed', async () => {
    const { four } = await build();
    expect((await get(keep(), four[0]!)).json().keep).toMatchObject({ status: 'offered', captain: true, myAnswer: null });
    expect((await post(keep('/start'), four[1]!, { name: 'Night Owls', tag: 'OWL' })).json()).toEqual(text('not_captain'));
    expect((await post(keep('/start'), four[0]!, { name: 'Night Owls', tag: 'OWL' })).statusCode).toBe(200);
    expect((await get(keep(), four[1]!)).json().keep).toMatchObject({ status: 'voting', captain: false, name: 'Night Owls', tag: 'OWL', myAnswer: null });
    expect((await post(keep('/answer'), four[1]!, { accept: true })).json()).toEqual({ joined: false, teamSlug: null, closed: false });
    expect((await post(keep('/answer'), four[2]!, { accept: true })).json()).toEqual({ joined: true, teamSlug: 'night-owls', closed: false });
    const team = (await get('/api/teams/night-owls', four[3]!)).json();
    expect(team.origin).toEqual({ eventSlug: f.slug, eventName: 'Draft Night', placement: null });
    expect(team.members).toHaveLength(3);
  });

  it('a player outside the four sees nothing and cannot answer; a bad tag is refused', async () => {
    const { four } = await build();
    expect((await get(keep(), BENCH[0]!)).json()).toEqual({ keep: null });
    expect((await post(keep('/answer'), BENCH[0]!, { accept: true })).json()).toEqual(text('keep_not_player'));
    expect((await post(keep('/start'), BENCH[0]!, { name: 'X Team', tag: 'XT' })).json()).toEqual(text('keep_not_open'));
    expect((await post(keep('/start'), four[0]!, { name: 'Night Owls', tag: '' })).json()).toEqual(text('bad_tag'));
    expect((await post(keep('/answer'), four[1]!, { accept: 'yes' })).json()).toEqual(text('bad_request'));
  });

  it('a site team that was not kept from a draft has no origin', async () => {
    const { four } = await build();
    await post('/api/teams', four[3]!, { name: 'Site Rats', tag: 'SRAT' });
    expect((await get('/api/teams/site-rats', four[3]!)).json().origin).toBeNull();
  });

  it('the competitive switch off hides all three routes, and a signed-out visitor gets the same 404 as the event routes', async () => {
    const { four } = await build();
    const out = (method: 'GET' | 'POST', url: string) => app.inject({ method, url, payload: method === 'POST' ? { accept: true } : undefined });
    for (const [method, url] of [['GET', keep()], ['POST', keep('/start')], ['POST', keep('/answer')]] as const) {
      const r = await out(method, url);
      expect([r.statusCode, r.json()]).toEqual([404, { error: 'not found' }]);
    }
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    for (const r of [await get(keep(), four[0]!), await post(keep('/start'), four[0]!, { name: 'Night Owls', tag: 'OWL' }), await post(keep('/answer'), four[1]!, { accept: true })]) {
      expect([r.statusCode, r.json()]).toEqual([404, { error: 'not found' }]);
    }
    expect(K.keepOf(f.db, K.keepsOf(f.db, f.eventId)[0]!.id)?.status).toBe('offered');
  });
});
