import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { EVENT_ERRORS } from '../src/events/validate.js';

const ADMIN = '76561199000000710';
const MOD = '76561199000000711';
const PLAYER = '76561199000000712';

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
const start = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'adminevents-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookies = {};
  for (const id of [ADMIN, MOD, PLAYER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });
const cup = () => (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;

describe('the Events desk routes', () => {
  it('are read by staff and written by admins only, whatever the competitive switch says', async () => {
    expect((db.prepare("SELECT value FROM settings WHERE key = 'competitive_enabled'").get() as { value: string }).value).toBe('off');
    expect((await call('GET', '/api/admin/events', ADMIN)).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/events', MOD)).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/events', PLAYER)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/events')).statusCode).toBe(401);
    expect((await call('POST', '/api/admin/events', MOD, { name: 'Cup', startsAt: start(), entryKind: 'team' })).statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
  });

  it('a mod reads an event, its stages and its history, and every write answers 403', async () => {
    const { id } = (await call('POST', '/api/admin/events', ADMIN, { name: 'Riverside Cup', startsAt: start(), entryKind: 'team' })).json();
    await call('POST', `/api/admin/events/${id}/stages`, ADMIN, { type: 'single_elim', rulesetId: cup() });
    const seen = await call('GET', `/api/admin/events/${id}`, MOD);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().stages).toHaveLength(1);
    expect(seen.json().log.map((l: { action: string }) => l.action)).toEqual(['created', 'stage_added']);
    expect((await call('GET', '/api/admin/events/options', MOD)).statusCode).toBe(200);
    const stageId = seen.json().stages[0].id;
    for (const [url, body] of [
      [`/api/admin/events/${id}`, { name: 'Mod Cup' }], [`/api/admin/events/${id}/stages`, { type: 'swiss', rulesetId: cup() }],
      [`/api/admin/events/${id}/stages/order`, { order: [stageId] }], [`/api/admin/events/${id}/stages/${stageId}`, { type: 'swiss', rulesetId: cup() }],
      [`/api/admin/events/${id}/stages/${stageId}/remove`, {}], [`/api/admin/events/${id}/publish`, {}],
      [`/api/admin/events/${id}/open-registration`, {}], [`/api/admin/events/${id}/cancel`, {}],
    ] as [string, object][]) {
      expect((await call('POST', url, MOD, body)).statusCode, url).toBe(403);
    }
    expect((await call('GET', `/api/admin/events/${id}`, ADMIN)).json().log).toHaveLength(2);
  });

  it('offers the poolable campaigns, the site pool, live rulesets with Standard Cup first choice, and the defaults', async () => {
    const r = await call('GET', '/api/admin/events/options', ADMIN);
    expect(r.statusCode).toBe(200);
    const o = r.json();
    expect(o.campaigns).toContainEqual({ slug: 'no_mercy', name: 'No Mercy' });
    expect(o.defaultPool).toEqual(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']);
    expect(o.rulesets.map((x: { name: string }) => x.name)).toEqual(['PUG', 'Standard Cup', 'Casual Scrim']);
    expect(o.defaultRulesetId).toBe(cup());
    expect(o.gameConfigs.map((g: { key: string }) => g.key)).toContain('standard');
    expect(o.defaults.checkin).toEqual({ enabled: true, opensMinutes: 60, closesMinutes: 15 });
  });

  it('runs create, edit, stages, publish, open registration and cancel, each audited twice', async () => {
    const created = await call('POST', '/api/admin/events', ADMIN, { name: 'Riverside Cup', startsAt: start(), entryKind: 'team' });
    expect(created.statusCode).toBe(201);
    const { id, slug } = created.json();
    expect(slug).toBe('riverside-cup');
    const ok = async (url: string, payload?: object) => {
      const r = await call('POST', url, ADMIN, payload);
      expect(r.statusCode, `${url} ${r.body}`).toBe(200);
    };
    await ok(`/api/admin/events/${id}`, { teamCap: 16, description: 'One night.\nBe on time.' });
    await ok(`/api/admin/events/${id}/stages`, { type: 'swiss', config: { rounds: 4 }, rulesetId: cup(), advanceCount: 8 });
    await ok(`/api/admin/events/${id}/stages`, { type: 'single_elim', config: { thirdPlace: false }, rulesetId: cup() });
    const stages = (await call('GET', `/api/admin/events/${id}`, ADMIN)).json().stages as { id: number }[];
    await ok(`/api/admin/events/${id}/stages/order`, { order: [stages[1].id, stages[0].id] });
    await ok(`/api/admin/events/${id}/stages/order`, { order: [stages[0].id, stages[1].id] });
    await ok(`/api/admin/events/${id}/stages/${stages[1].id}`, { type: 'single_elim', config: { thirdPlace: true }, rulesetId: cup() });
    await ok(`/api/admin/events/${id}/publish`);
    await ok(`/api/admin/events/${id}/open-registration`);
    await ok(`/api/admin/events/${id}/cancel`, { reason: 'Testing' });

    const detail = (await call('GET', `/api/admin/events/${id}`, ADMIN)).json();
    expect(detail).toMatchObject({ id, slug, status: 'cancelled', cancelReason: 'Testing' });
    expect(detail.fields.description).toBe('One night.\nBe on time.');
    expect(detail.stages.map((s: { summary: string; rulesSnapshotted: boolean }) => [s.summary, s.rulesSnapshotted]))
      .toEqual([['Swiss, 4 rounds, top 8 advance', true], ['Single elimination, third-place match', true]]);
    expect(detail.log.map((l: { action: string }) => l.action)).toEqual([
      'created', 'edited', 'stage_added', 'stage_added', 'stages_reordered', 'stages_reordered', 'stage_edited',
      'published', 'registration_opened', 'cancelled',
    ]);
    expect(detail.log[0].actorName).toBe(`p${ADMIN.slice(-3)}`);
    const audited = (db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_%' ORDER BY id").all() as { action: string }[]).map((a) => a.action);
    expect(audited).toEqual([
      'event_create', 'event_edit', 'event_stage_add', 'event_stage_add', 'event_stages_reorder', 'event_stages_reorder',
      'event_stage_edit', 'event_publish', 'event_open_registration', 'event_cancel',
    ]);
  });

  it('answers a refusal with its rule sentence and status, and audits nothing for it', async () => {
    const past = await call('POST', '/api/admin/events', ADMIN, { name: 'Late Cup', startsAt: '2020-01-01T00:00:00.000Z', entryKind: 'team' });
    expect([past.statusCode, past.json()]).toEqual([EVENT_ERRORS.start_passed.status, { error: EVENT_ERRORS.start_passed.text }]);
    const { id } = (await call('POST', '/api/admin/events', ADMIN, { name: 'Bare Cup', startsAt: start(), entryKind: 'team' })).json();
    const bare = await call('POST', `/api/admin/events/${id}/publish`, ADMIN);
    expect([bare.statusCode, bare.json()]).toEqual([EVENT_ERRORS.no_stages.status, { error: EVENT_ERRORS.no_stages.text }]);
    expect((await call('GET', '/api/admin/events/999', ADMIN)).statusCode).toBe(404);
    expect((await call('GET', '/api/admin/events/abc', ADMIN)).statusCode).toBe(404);
    expect((await call('POST', `/api/admin/events/${id}/stages/abc`, ADMIN, {})).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event_publish'").get()).toEqual({ n: 0 });
  });

  it('lists every event, drafts included, newest start first', async () => {
    await call('POST', '/api/admin/events', ADMIN, { name: 'First Cup', startsAt: start(), entryKind: 'team' });
    await call('POST', '/api/admin/events', ADMIN, { name: 'Later Cup', startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), entryKind: 'draft' });
    const list = (await call('GET', '/api/admin/events', ADMIN)).json().events;
    expect(list.map((e: { name: string; status: string; stages: number }) => [e.name, e.status, e.stages]))
      .toEqual([['Later Cup', 'draft', 0], ['First Cup', 'draft', 0]]);
  });
});
