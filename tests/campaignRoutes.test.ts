import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { insertDraft, publishCampaign, setEnabled } from '../src/customCampaigns.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { makeVpk } from './fixtures/makeVpk.js';

const MISSION = `
"mission"
{
  "Name" "dbd"
  "DisplayTitle" "Dead Before Dawn"
  "modes"
  {
    "versus"
    {
      "1" { "Map" "dbd1_alley" "DisplayName" "Alley" }
      "2" { "Map" "dbd2_mall" "DisplayName" "Mall" }
    }
  }
}
`;

let db: DB;
let addons: string;

const buildTestApp = (o: { db: DB; addonsDir: string; freeBytes?: number }): Promise<FastifyInstance> =>
  buildServer({
    config: loadConfig({ ADDONS_DIR: o.addonsDir }),
    db: o.db,
    orchestrator: stubOrchestrator(),
    serverCleaner: async () => {},
    // Injected for the same reason orchestrator and serverCleaner are: the
    // real one calls statfs, so the disk-floor test would pass or fail based
    // on how full the machine running it happens to be.
    freeBytes: o.freeBytes === undefined ? undefined : async () => o.freeBytes!,
  });

beforeEach(() => {
  db = openDb(':memory:');
  addons = mkdtempSync(join(tmpdir(), 'addons-'));
});
afterEach(() => { rmSync(addons, { recursive: true, force: true }); });

/** authedCookie logs a player in but leaves is_admin at 0 (config.adminSteamIds
 *  is empty in these tests); promote explicitly, same as tests/adminMatches.test.ts. */
const adminCookie = (app: FastifyInstance, steamid: string): Record<string, string> => {
  const cookie = authedCookie(app, db, steamid);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(steamid);
  return cookie;
};

describe('GET /api/campaigns/custom', () => {
  it('lists only published, enabled campaigns', async () => {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1', display: 'One', isFinale: true }]);
    insertDraft(db, {
      slug: 'wip', name: 'WIP', vpkFilename: 'wip.vpk',
      sizeBytes: 9, sha256: 'b'.repeat(64), uploadedBy: null,
    }, [{ map: 'wip1', display: null, isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');
    setEnabled(db, 'dbd', true);

    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/custom' });
    expect(res.statusCode).toBe(200);
    expect(res.json().campaigns.map((c: { slug: string }) => c.slug)).toEqual(['dbd']);
  });
});

describe('GET /download/campaign/:slug', () => {
  const publishOne = (body = 'vpk bytes') => {
    writeFileSync(join(addons, 'dbd.vpk'), body);
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      uploadedBy: null,
    }, [{ map: 'dbd1', display: null, isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');
    setEnabled(db, 'dbd', true);
  };

  it('streams the VPK', async () => {
    publishOne();
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/download/campaign/dbd' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('vpk bytes');
  });

  // A file edited by hand on the box must not be served as if it were the one
  // the site vouched for.
  it('404s when the file on disk has drifted from its recorded size', async () => {
    publishOne();
    writeFileSync(join(addons, 'dbd.vpk'), 'different bytes entirely');
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/download/campaign/dbd' });
    expect(res.statusCode).toBe(404);
  });

  it('404s for an unpublished campaign', async () => {
    writeFileSync(join(addons, 'wip.vpk'), 'x');
    insertDraft(db, {
      slug: 'wip', name: 'WIP', vpkFilename: 'wip.vpk',
      sizeBytes: 1, sha256: 'c'.repeat(64), uploadedBy: null,
    }, [{ map: 'wip1', display: null, isFinale: true }]);
    const app = await buildTestApp({ db, addonsDir: addons });
    expect((await app.inject({ method: 'GET', url: '/download/campaign/wip' })).statusCode).toBe(404);
  });

  // The slug indexes the database; it never becomes part of a path.
  it('404s on a traversal attempt rather than reading outside addons', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/download/campaign/..%2F..%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/admin/campaigns', () => {
  it('uploads a valid campaign VPK as a draft, hashed correctly', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const vpkPath = join(addons, 'source.vpk');
    makeVpk(vpkPath, { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION });
    const bytes = readFileSync(vpkPath);
    const form = new FormData();
    form.set('file', new Blob([bytes]), 'dbd.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slug).toBe('dbd');
    expect(body.name).toBe('Dead Before Dawn');
    expect(body.sizeBytes).toBe(bytes.length);
    expect(body.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

    // The bytes landed on disk match the upload exactly: the streamed hash
    // was computed over what was actually written, not a race with it.
    const landed = readFileSync(join(addons, 'dbd.vpk'));
    expect(landed.equals(bytes)).toBe(true);
    expect(createHash('sha256').update(landed).digest('hex')).toBe(body.sha256);
  });

  it('rejects a slug that collides with an existing custom campaign', async () => {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1', display: null, isFinale: true }]);

    const app = await buildTestApp({ db, addonsDir: addons });
    const vpkPath = join(addons, 'source.vpk');
    makeVpk(vpkPath, { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION });
    const form = new FormData();
    form.set('file', new Blob([readFileSync(vpkPath)]), 'dbd.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a file that is not a campaign VPK', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const notVpk = join(addons, 'x.vpk');
    makeVpk(notVpk, { ext: 'vmt', dir: 'materials', name: 'hunter', body: 'x' });
    const form = new FormData();
    form.set('file', new Blob([readFileSync(notVpk)]), 'skin.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/mission/i);
  });

  it('refuses when free disk is below the floor', async () => {
    const app = await buildTestApp({ db, addonsDir: addons, freeBytes: 1 });
    const form = new FormData();
    form.set('file', new Blob(['x']), 'c.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(507);
  });

  it('refuses a non-admin', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const form = new FormData();
    form.set('file', new Blob(['x']), 'c.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: authedCookie(app, db, '76561198000000009'),
      payload: form,
    });
    expect(res.statusCode).toBe(403);
  });
});
