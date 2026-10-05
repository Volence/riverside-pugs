import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as E from '../src/events/events.js';
import * as P from '../src/events/play.js';
import { ADMIN } from './eventFixture.js';
import { startEventFlow } from '../src/events/flow.js';
import { stagePlayViews } from '../src/events/playViews.js';
import { LEAGUE, SE, SWISS, playFixture, type PlayFixture } from './playFixture.js';

const MOD = '76561199000000830';
let f: PlayFixture;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
  upsertPlayer(f.db, { steamid: MOD, name: 'mod', avatar: null }, []);
  f.db.prepare("UPDATE players SET is_mod = 1, status = 'active' WHERE steamid = ?").run(MOD);
  f.db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'event-play-')) },
    db: f.db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const s of [ADMIN, MOD]) cookies[s] = authedCookie(app, f.db, s);
});
afterEach(async () => { await app.close(); });

const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });
const get = (url: string, as?: string) => app.inject({ method: 'GET', url, ...(as ? { cookies: cookies[as] } : {}) });
const firstOpen = () => P.matchesOf(f.db, E.stagesOf(f.db, f.eventId)[0]!.id).find((m) => m.status === 'waiting')!;

describe('event play routes', () => {
  it('a mod reads the desk play view but cannot start or report', async () => {
    const view = await get(`/api/admin/events/${f.eventId}/play`, MOD);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ status: 'checkin', seeded: 4, stages: [] });
    expect((await post(`/api/admin/events/${f.eventId}/start`, MOD)).statusCode).toBe(403);
  });

  it('an admin starts the event; the public page then shows Swiss standings and round 1', async () => {
    const r = await post(`/api/admin/events/${f.eventId}/start`, ADMIN);
    expect(r.statusCode).toBe(200);
    const ev = E.getEvent(f.db, f.eventId)!;
    const page = (await get(`/api/events/${ev.slug}`)).json();
    expect(page.status).toBe('live');
    expect(page.play).toHaveLength(1);
    expect(page.play[0]).toMatchObject({ ordinal: 1, layout: 'table', status: 'live' });
    expect(page.play[0].rounds[0]).toMatchObject({ label: 'Round 1' });
    expect(page.play[0].rounds[0].matches).toHaveLength(2);
    expect(page.play[0].standings).toHaveLength(4);
    expect(JSON.stringify(page)).not.toMatch(/"sr"/i);
    expect((await post(`/api/admin/events/${f.eventId}/start`, ADMIN)).statusCode).toBe(409);
  });

  it('an admin reports a result; bad bodies get the sentence; a mod gets 403', async () => {
    await post(`/api/admin/events/${f.eventId}/start`, ADMIN);
    const m = firstOpen();
    const url = `/api/admin/events/${f.eventId}/matches/${m.id}/result`;
    expect((await post(url, MOD, { winner: 'a', scoreA: 2, scoreB: 1 })).statusCode).toBe(403);
    const bad = await post(url, ADMIN, { winner: 'a', scoreA: 1, scoreB: 2 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/winner/);
    expect((await post(url, ADMIN, { winner: 'a', scoreA: 2, scoreB: 1 })).statusCode).toBe(200);
    expect(P.getMatch(f.db, m.id)).toMatchObject({ status: 'done', result_source: 'admin' });
    expect((await post(`/api/admin/events/${f.eventId}/matches/99999/result`, ADMIN, { winner: 'a', forfeit: true })).statusCode).toBe(404);
    const audit = f.db.prepare("SELECT action FROM admin_actions WHERE action IN ('event_start','event_result') ORDER BY id").all();
    expect(audit).toEqual([{ action: 'event_start' }, { action: 'event_result' }]);
  });

  it('disqualifying a team in a live event forfeits its open match before the reply', async () => {
    await post(`/api/admin/events/${f.eventId}/start`, ADMIN);
    const m = firstOpen();
    const r = await post(`/api/admin/events/${f.eventId}/entries/${m.entry_a}/disqualify`, ADMIN, { reason: 'left' });
    expect(r.statusCode).toBe(200);
    expect(P.getMatch(f.db, m.id)).toMatchObject({ status: 'forfeit', winner_entry: m.entry_b });
  });

  it('a league round carries its week\'s dates from the season start', async () => {
    const g = playFixture({ stages: [LEAGUE(4, 2, 'round_robin', null, '2026-10-12')], entries: 4 });
    const r = await startEventFlow(g.db, { eventId: g.eventId, by: ADMIN });
    expect(r.ok).toBe(true);
    const rounds = stagePlayViews(g.db, E.getEvent(g.db, g.eventId)!)[0]!.rounds;
    expect(rounds.map((x) => [x.label, x.dates])).toEqual([
      ['Week 1, match 1', { from: '2026-10-12', to: '2026-10-18' }], ['Week 1, match 2', { from: '2026-10-12', to: '2026-10-18' }],
      ['Week 2, match 1', { from: '2026-10-19', to: '2026-10-25' }], ['Week 2, match 2', { from: '2026-10-19', to: '2026-10-25' }],
    ]);
  });

  it('the public page is a 404 while the switch is closed to the viewer, as before', async () => {
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    const ev = E.getEvent(f.db, f.eventId)!;
    expect((await get(`/api/events/${ev.slug}`)).statusCode).toBe(404);
  });
});
