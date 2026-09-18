import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { getSetting, setSetting } from '../src/settings.js';
import { SETTINGS_SCHEMA, validateSetting } from '../src/settingsSchema.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { insertDraft, publishCampaign, setInstall } from '../src/customCampaigns.js';
import { invalidateCampaignCache } from '../src/campaignRegistry.js';
import { addServer } from '../src/serverPool.js';

const ADMIN = '76561198000000001';
let db: DB;
let app: FastifyInstance;
let admin: Record<string, string>;

beforeEach(async () => {
  db = openDb(':memory:');
  // campaignRegistry's cache is module-level and keyed on nothing but "has
  // anyone invalidated it since", so a previous test's warm cache would
  // otherwise leak into this one's fresh, unrelated db. Same guard
  // tests/campaignRoutes.test.ts uses.
  invalidateCampaignCache();
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

// "enabled" on a custom campaign used to mean only one thing (whether it
// shows up on the public download page). GET /api/admin/settings pulled
// the raw registry for its campaign list instead, so an admin could pool an
// uninstalled campaign through the ordinary Settings UI with no gate at
// all. These exercise the real routes end to end, not validateSetting in
// isolation, since the bug was specifically that the route ignored it.
describe('the settings pool candidate list is gated the same as the panel', () => {
  const publishDbd = (serverId: number, { installed }: { installed: boolean }) => {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1', display: null, isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');
    if (installed) setInstall(db, 'dbd', serverId, 'installed');
    invalidateCampaignCache();
  };

  const poolSlugs = async (): Promise<string[]> => {
    const res = (await app.inject({ method: 'GET', url: '/api/admin/settings', cookies: admin })).json();
    return res.campaigns.map((c: { slug: string }) => c.slug);
  };

  it('always offers the stock four, which have no install to gate on', async () => {
    expect(await poolSlugs()).toEqual(
      expect.arrayContaining(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']),
    );
  });

  it('withholds an uninstalled custom campaign even though it is enabled', async () => {
    const serverId = addServer(db, { name: 's', host: 'h', port: 1, rconPort: 1, rconPassword: 'p' });
    publishDbd(serverId, { installed: false });
    expect(await poolSlugs()).not.toContain('dbd');
    // The direct PUT is refused the same way, not just the candidate list.
    expect((await put('map_pool', ['no_mercy', 'dbd'])).statusCode).toBe(400);
  });

  it('offers it once it is installed everywhere, and the PUT accepts it', async () => {
    const serverId = addServer(db, { name: 's', host: 'h', port: 1, rconPort: 1, rconPassword: 'p' });
    publishDbd(serverId, { installed: true });
    expect(await poolSlugs()).toContain('dbd');
    expect((await put('map_pool', ['no_mercy', 'dbd'])).statusCode).toBe(200);
  });

  // Judgement call: an admin should not be locked out of their own settings
  // page by a campaign that was fine when it was pooled and has since gone
  // stale (a server re-imaged, or someone flipped it back off on the
  // Campaigns tab). It stays offered, and a save that still includes it
  // keeps working, until someone deliberately removes it from the pool.
  it('keeps an already-pooled campaign selectable after it stops qualifying', async () => {
    const serverId = addServer(db, { name: 's', host: 'h', port: 1, rconPort: 1, rconPassword: 'p' });
    publishDbd(serverId, { installed: true });
    setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'dbd']));

    // Now it goes stale: disabled on the Campaigns tab.
    invalidateCampaignCache();

    expect(await poolSlugs()).toContain('dbd');
    // Saving the pool as it stands, dbd included, must not be rejected by
    // the very setting it is already the value of.
    expect((await put('map_pool', ['no_mercy', 'dbd'])).statusCode).toBe(200);
    // But it is not a backdoor to add anything else uninstalled or
    // disabled: only the slug already in the pool gets the pass.
    expect((await put('map_pool', ['dbd', 'not_a_campaign'])).statusCode).toBe(400);
  });
});
