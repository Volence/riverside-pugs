import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { TEMPLATES } from '../src/rulesets.js';
import { RULESET_ERRORS } from '../src/rulesetStore.js';
import { GAME_CONFIG_ERRORS } from '../src/gameConfigStore.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const ADMIN = '76561199000000720';
const MOD = '76561199000000721';
const P = ['76561199000000722', '76561199000000723'];
const START = new Date(Date.now() + 3 * 24 * 3_600_000);
START.setUTCMinutes(0, 0, 0);

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'adminrulesets-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    bookingRcon: async () => { throw new Error('no rcon in route tests'); },
  });
  cookies = {};
  for (const id of [ADMIN, MOD, ...P]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'map_pool'").run(JSON.stringify(['no_mercy', 'death_toll']));
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: 'h', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });
const idOf = (name: string) => (db.prepare('SELECT id FROM rulesets WHERE name = ?').get(name) as { id: number }).id;
const { rated: _rated, penalties: _penalties, ...scrimRules } = TEMPLATES['Casual Scrim'];
const copy = async (name: string, from = idOf('Casual Scrim')) => {
  const r = await call('POST', '/api/admin/rulesets', ADMIN, { copyFrom: from, name });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as number;
};
const pickerNames = async () => ({
  bookings: (await call('GET', '/api/bookings/options', P[0])).json().rulesets.map((r: { name: string }) => r.name),
  events: (await call('GET', '/api/admin/events/options', ADMIN)).json().rulesets.map((r: { name: string }) => r.name),
});
const configKeys = async () => ({
  bookings: (await call('GET', '/api/bookings/options', P[0])).json().gameConfigs.map((g: { key: string }) => g.key),
  events: (await call('GET', '/api/admin/events/options', ADMIN)).json().gameConfigs.map((g: { key: string }) => g.key),
});

describe('the Rulesets desk routes', () => {
  it('answer admins only: a mod and a player get 403 on every read and write, a stranger 401', async () => {
    for (const as of [MOD, P[0]]) {
      for (const [method, url] of [
        ['GET', '/api/admin/rulesets'], ['POST', '/api/admin/rulesets'], ['POST', `/api/admin/rulesets/${idOf('Casual Scrim')}`],
        ['POST', `/api/admin/rulesets/${idOf('Casual Scrim')}/archive`], ['POST', `/api/admin/rulesets/${idOf('Casual Scrim')}/unarchive`],
        ['GET', '/api/admin/game-configs'], ['POST', '/api/admin/game-configs'], ['POST', '/api/admin/game-configs/standard'],
        ['POST', '/api/admin/game-configs/standard/delete'],
      ] as ['GET' | 'POST', string][]) {
        expect((await call(method, url, as, { copyFrom: idOf('PUG'), name: 'Sneaky' })).statusCode, `${as} ${url}`).toBe(403);
      }
    }
    expect((await call('GET', '/api/admin/rulesets')).statusCode).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM rulesets').get()).toEqual({ n: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()).toEqual({ n: 0 });
  });

  it('lists, copies, edits, archives and unarchives, each with one audit row', async () => {
    const listed = (await call('GET', '/api/admin/rulesets', ADMIN)).json().rulesets;
    expect(listed.map((r: { name: string; readOnly: boolean }) => [r.name, r.readOnly])).toEqual([['PUG', true], ['Standard Cup', false], ['Casual Scrim', false]]);
    const id = await copy('Thursday Scrim');
    const edited = await call('POST', `/api/admin/rulesets/${id}`, ADMIN, { name: 'Thursday Scrims', rules: { ...scrimRules, noShowGraceMinutes: 20 } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await call('POST', `/api/admin/rulesets/${id}/archive`, ADMIN)).statusCode).toBe(200);
    expect((await call('POST', `/api/admin/rulesets/${id}/unarchive`, ADMIN)).statusCode).toBe(200);
    const mine = (await call('GET', '/api/admin/rulesets', ADMIN)).json().rulesets.find((r: { id: number }) => r.id === id);
    expect(mine).toMatchObject({ name: 'Thursday Scrims', basedOn: 'Casual Scrim', archived: false, summary: 'Unlimited pauses · non-picker picks sides · 20 min no-show grace' });
    expect((db.prepare('SELECT action FROM admin_actions ORDER BY id').all() as { action: string }[]).map((a) => a.action))
      .toEqual(['ruleset_create', 'ruleset_update', 'ruleset_archive', 'ruleset_unarchive']);
  });

  it('refuses with the sentence for each reason, writing nothing', async () => {
    const pug = await call('POST', `/api/admin/rulesets/${idOf('PUG')}`, ADMIN, { name: 'PUG', rules: scrimRules });
    expect(pug.statusCode).toBe(409);
    expect(pug.json()).toEqual({ error: RULESET_ERRORS.read_only.text });
    const bad = await call('POST', `/api/admin/rulesets/${idOf('Casual Scrim')}`, ADMIN, { name: 'Casual Scrim', rules: { ...scrimRules, noShowGraceMinutes: 90 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: RULESET_ERRORS.bad_grace.text });
    expect((await call('POST', '/api/admin/rulesets', ADMIN, { copyFrom: idOf('PUG'), name: 'pug' })).json()).toEqual({ error: RULESET_ERRORS.name_taken.text });
    expect((await call('POST', `/api/admin/rulesets/${idOf('Standard Cup')}/archive`, ADMIN)).statusCode).toBe(409);
    expect((await call('POST', '/api/admin/rulesets/abc', ADMIN, { name: 'Whatever', rules: scrimRules })).statusCode).toBe(404);
    expect(JSON.parse((db.prepare("SELECT rules_json FROM rulesets WHERE name = 'PUG'").get() as { rules_json: string }).rules_json)).toEqual(TEMPLATES.PUG);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()).toEqual({ n: 0 });
  });

  it('an archived ruleset leaves the booking and event pickers; a booking or stage cannot pick it; publish refuses a draft on it', async () => {
    const id = await copy('Old Rules');
    expect(await pickerNames()).toEqual({ bookings: ['PUG', 'Standard Cup', 'Casual Scrim', 'Old Rules'], events: ['PUG', 'Standard Cup', 'Casual Scrim', 'Old Rules'] });
    const ev = (await call('POST', '/api/admin/events', ADMIN, { name: 'Old Cup', startsAt: START.toISOString(), entryKind: 'team' })).json().id;
    expect((await call('POST', `/api/admin/events/${ev}/stages`, ADMIN, { type: 'single_elim', config: { thirdPlace: false }, rulesetId: id })).statusCode).toBe(200);
    await call('POST', `/api/admin/rulesets/${id}/archive`, ADMIN);
    expect(await pickerNames()).toEqual({ bookings: ['PUG', 'Standard Cup', 'Casual Scrim'], events: ['PUG', 'Standard Cup', 'Casual Scrim'] });
    const booking = await call('POST', '/api/bookings', P[0], { opponent: { steamid: P[1] }, startsAt: START.toISOString(), playlist: ['no_mercy'], rulesetId: id });
    expect(booking.statusCode).toBe(400);
    expect((await call('POST', `/api/admin/events/${ev}/stages`, ADMIN, { type: 'swiss', config: { rounds: 4 }, rulesetId: id })).statusCode).toBe(400);
    expect((await call('POST', `/api/admin/events/${ev}/publish`, ADMIN)).statusCode).toBe(400);
    expect((await call('GET', `/api/admin/events/${ev}`, ADMIN)).json().status).toBe('draft');
  });

  it('editing a ruleset leaves a booking and a published stage on the rules they took', async () => {
    const id = await copy('Snap Rules');
    const booked = await call('POST', '/api/bookings', P[0], { opponent: { steamid: P[1] }, startsAt: START.toISOString(), playlist: ['no_mercy'], rulesetId: id });
    expect(booked.statusCode, booked.body).toBe(201);
    const ev = (await call('POST', '/api/admin/events', ADMIN, { name: 'Snap Cup', startsAt: START.toISOString(), entryKind: 'team' })).json().id;
    await call('POST', `/api/admin/events/${ev}/stages`, ADMIN, { type: 'single_elim', config: { thirdPlace: false }, rulesetId: id });
    expect((await call('POST', `/api/admin/events/${ev}/publish`, ADMIN)).statusCode).toBe(200);
    const bookingBefore = db.prepare('SELECT rules_json, ruleset_id FROM bookings WHERE id = ?').get(booked.json().id);
    const stageBefore = db.prepare('SELECT rules_json FROM event_stages WHERE event_id = ?').get(ev);
    expect((await call('GET', '/api/admin/rulesets', ADMIN)).json().rulesets.find((r: { id: number }) => r.id === id).inUse).toEqual({ bookings: 1, events: 1 });

    const r = await call('POST', `/api/admin/rulesets/${id}`, ADMIN, {
      name: 'Snap Rules', rules: { ...scrimRules, pause: { limit: 1, seconds: 60, mutualUnpause: false, techPauses: 0 }, noShowGraceMinutes: 5 },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(db.prepare('SELECT rules_json, ruleset_id FROM bookings WHERE id = ?').get(booked.json().id)).toEqual(bookingBefore);
    expect(db.prepare('SELECT rules_json FROM event_stages WHERE event_id = ?').get(ev)).toEqual(stageBefore);
    expect((await call('GET', `/api/bookings/${booked.json().id}`, P[0])).json().rules.noShowGraceMinutes).toBe(15);
  });
});

describe('the Game configs desk routes', () => {
  it('adds, renames, turns off and deletes a config; off leaves both pickers, standard stays', async () => {
    const add = await call('POST', '/api/admin/game-configs', ADMIN, { key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4' });
    expect(add.statusCode, add.body).toBe(201);
    expect(await configKeys()).toEqual({ bookings: ['standard', 'zonemod'], events: ['standard', 'zonemod'] });
    expect((await call('POST', '/api/admin/game-configs/zonemod', ADMIN, { label: 'ZoneMod', enabled: false })).statusCode).toBe(200);
    expect(await configKeys()).toEqual({ bookings: ['standard'], events: ['standard'] });
    const list = (await call('GET', '/api/admin/game-configs', ADMIN)).json().gameConfigs;
    expect(list.map((g: { key: string; label: string; enabled: boolean; locked: boolean }) => [g.key, g.label, g.enabled, g.locked]))
      .toEqual([['standard', 'Standard (Rotoblin PUG 4v4)', true, true], ['zonemod', 'ZoneMod', false, false]]);
    expect((await call('POST', '/api/admin/game-configs/zonemod/delete', ADMIN)).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/game-configs', ADMIN)).json().gameConfigs).toHaveLength(1);
    expect((db.prepare('SELECT action FROM admin_actions ORDER BY id').all() as { action: string }[]).map((a) => a.action))
      .toEqual(['game_config_create', 'game_config_update', 'game_config_delete']);
  });

  it('refuses a cfg that could be more than one console word, turning standard off, and deleting one in use', async () => {
    const bad = await call('POST', '/api/admin/game-configs', ADMIN, { key: 'evil', label: 'Evil config', cfg: 'pug_match; quit' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: GAME_CONFIG_ERRORS.bad_cfg.text });
    const off = await call('POST', '/api/admin/game-configs/standard', ADMIN, { label: 'Standard', enabled: false });
    expect(off.statusCode).toBe(409);
    expect((await call('POST', '/api/admin/game-configs/standard/delete', ADMIN)).statusCode).toBe(409);
    await call('POST', '/api/admin/game-configs', ADMIN, { key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4' });
    const booked = await call('POST', '/api/bookings', P[0], { opponent: { steamid: P[1] }, startsAt: START.toISOString(), playlist: ['no_mercy'], gameConfig: 'zonemod' });
    expect(booked.statusCode, booked.body).toBe(201);
    const del = await call('POST', '/api/admin/game-configs/zonemod/delete', ADMIN);
    expect(del.statusCode).toBe(409);
    expect(del.json()).toEqual({ error: GAME_CONFIG_ERRORS.in_use.text });
    expect((await call('POST', '/api/admin/game-configs/nope', ADMIN, { label: 'Nope config', enabled: true })).statusCode).toBe(404);
  });
});
