import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { getSetting } from '../src/settings.js';
import { SETTINGS_SCHEMA, validateSetting } from '../src/settingsSchema.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const ADMIN = '76561198000000001';
let db: DB;
let app: FastifyInstance;
let admin: Record<string, string>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {} });
  admin = authedCookie(app, db, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});
afterEach(async () => { await app.close(); });

const put = (key: string, value: unknown, cookies = admin) =>
  app.inject({ method: 'PUT', url: `/api/admin/settings/${key}`, cookies, payload: { value } });

describe('settings schema', () => {
  it('every schema key has a seeded default', () => {
    for (const def of SETTINGS_SCHEMA) expect(getSetting(db, def.key), def.key).toBeDefined();
  });

  it('validates by type', () => {
    expect(validateSetting('ready_seconds', '90')).toEqual({ ok: true, value: '90' });
    expect(validateSetting('ready_seconds', '5').ok).toBe(false);
    expect(validateSetting('ready_seconds', 'abc').ok).toBe(false);
    expect(validateSetting('map_pool', ['dead_air', 'no_mercy'])).toEqual({ ok: true, value: '["dead_air","no_mercy"]' });
    expect(validateSetting('map_pool', ['dead_air', 'nope']).ok).toBe(false);
    expect(validateSetting('map_pool', []).ok).toBe(false);
    expect(validateSetting('discord_voice_enabled', true)).toEqual({ ok: true, value: '1' });
    expect(validateSetting('discord_queue_thresholds', [4, 6])).toEqual({ ok: true, value: '[4,6]' });
    expect(validateSetting('discord_queue_thresholds', [0]).ok).toBe(false);
    expect(validateSetting('not_a_setting', '1').ok).toBe(false);
  });
});

describe('settings routes', () => {
  it('lists registered settings with values, masking secrets', async () => {
    const res = (await app.inject({ method: 'GET', url: '/api/admin/settings', cookies: admin })).json();
    const invite = res.settings.find((s: { key: string }) => s.key === 'invite_code');
    expect(invite.secret).toBe(true);
    expect(res.settings.find((s: { key: string }) => s.key === 'ready_seconds').value).toBe('120');
  });

  it('saves a valid value and audits it; rejects invalid with the reason; 404s unknown', async () => {
    expect((await put('ready_seconds', '90')).statusCode).toBe(200);
    expect(getSetting(db, 'ready_seconds')).toBe('90');
    const bad = await put('ready_seconds', '1');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/between/);
    expect((await put('nope', '1')).statusCode).toBe(404);
    const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: admin })).json();
    expect(audit.actions[0]).toMatchObject({ action: 'setting', target: 'ready_seconds', detail: { from: '120', to: '90' } });
  });

  it('never writes a secret value into the audit log', async () => {
    await put('invite_code', 'newcode123');
    const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: admin })).json();
    expect(JSON.stringify(audit)).not.toContain('newcode123');
    expect(JSON.stringify(audit)).not.toContain('change-me');
  });

  it('non-admins are refused', async () => {
    const user = authedCookie(app, db, '76561198000000002');
    expect((await app.inject({ method: 'GET', url: '/api/admin/settings', cookies: user })).statusCode).toBe(403);
    expect((await put('ready_seconds', '90', user)).statusCode).toBe(403);
  });
});

describe('map_pool with custom campaigns', () => {
  it('rejects a slug no campaign claims', () => {
    const v = validateSetting('map_pool', ['no_mercy', 'not_a_campaign']);
    expect(v).toEqual({ ok: false, error: 'unknown campaign: not_a_campaign' });
  });

  // The pool is validated against the registry, not the stock const, or a
  // custom campaign could never be put in it.
  it('accepts a custom slug when it is passed as known', () => {
    const v = validateSetting('map_pool', ['no_mercy', 'dbd'], {
      campaignSlugs: new Set(['no_mercy', 'dbd']),
    });
    expect(v).toEqual({ ok: true, value: JSON.stringify(['no_mercy', 'dbd']) });
  });

  // Default behaviour is unchanged for every caller that does not care.
  it('falls back to the stock campaigns when given no set', () => {
    expect(validateSetting('map_pool', ['dbd']).ok).toBe(false);
  });
});
