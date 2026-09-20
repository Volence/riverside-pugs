import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import {
  getCampaign, insertDraft, installsOf, publishCampaign, setInstall,
} from '../src/customCampaigns.js';
import { campaignRegistry, invalidateCampaignCache } from '../src/campaignRegistry.js';
import type { InstallTarget } from '../src/campaignInstall.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { makeVpk, makeVpkMulti } from './fixtures/makeVpk.js';
import { fakeAddonsTransport } from './fakes/fakeAddonsTransport.js';
import { getJsonSetting, setSetting } from '../src/settings.js';

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

const buildTestApp = (o: {
  db: DB; addonsDir: string; freeBytes?: number;
  installTargets?: () => InstallTarget[]; maxUploadBytes?: number;
  consistencyListPath?: string;
}): Promise<FastifyInstance> =>
  buildServer({
    config: loadConfig({ ADDONS_DIR: o.addonsDir }),
    db: o.db,
    orchestrator: stubOrchestrator(),
    serverCleaner: async () => {},
    serverExec: async () => {},
    // Injected for the same reason orchestrator and serverCleaner are: the
    // real one calls statfs, so the disk-floor test would pass or fail based
    // on how full the machine running it happens to be.
    freeBytes: o.freeBytes === undefined ? undefined : async () => o.freeBytes!,
    installTargets: o.installTargets,
    maxUploadBytes: o.maxUploadBytes,
    consistencyListPath: o.consistencyListPath,
  });

beforeEach(() => {
  db = openDb(':memory:');
  addons = mkdtempSync(join(tmpdir(), 'addons-'));
  // campaignRegistry's cache is module-level and keyed on nothing but "has
  // anyone invalidated it since", so a previous test's warm cache would
  // otherwise leak into this one's fresh, unrelated db. Same guard
  // tests/campaignRegistry.test.ts uses.
  invalidateCampaignCache();
});
afterEach(() => { rmSync(addons, { recursive: true, force: true }); });

/** authedCookie logs a player in but leaves is_admin at 0 (config.adminSteamIds
 *  is empty in these tests); promote explicitly, same as tests/adminMatches.test.ts. */
const adminCookie = (app: FastifyInstance, steamid: string): Record<string, string> => {
  const cookie = authedCookie(app, db, steamid);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(steamid);
  return cookie;
};

/** custom_campaign_installs.server_id is a real foreign key into servers(id),
 *  so any test that writes an install row (directly, or indirectly through a
 *  route that fires installCampaign) needs a real server row to point at,
 *  even when installTargets bypasses the servers-table query that would
 *  otherwise have produced it. */
const seedServer1 = () => {
  db.prepare(
    "INSERT INTO servers (id, name, host, port, rcon_port, rcon_password, status) VALUES (1,'A','h',1,1,'p','idle')",
  ).run();
};

describe('GET /api/campaigns/custom', () => {
  it('lists published campaigns and hides drafts', async () => {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1', display: 'One', isFinale: true }]);
    insertDraft(db, {
      slug: 'wip', name: 'WIP', vpkFilename: 'wip.vpk',
      sizeBytes: 9, sha256: 'b'.repeat(64), uploadedBy: null,
    }, [{ map: 'wip1', display: null, isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');

    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/custom' });
    expect(res.statusCode).toBe(200);
    expect(res.json().campaigns.map((c: { slug: string }) => c.slug)).toEqual(['dbd']);
  });

  // Poolable and downloadable are different questions. If a campaign is
  // installed on the servers a player should be able to get it, and the inPool
  // badge is what says which ones they actually need. Filtering this list to
  // poolable campaigns would leave the badge nothing to distinguish, which is
  // how it shipped first: a published campaign was invisible until someone
  // ticked a box labelled for the vote.
  it('lists a published campaign with no install anywhere', async () => {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1', display: 'One', isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');

    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/custom' });
    const rows = res.json().campaigns;
    expect(rows.map((c: { slug: string }) => c.slug)).toEqual(['dbd']);
    expect(rows[0].inPool).toBe(false);
  });

  // The badge on the public page is driven by this flag, and it is the thing a
  // player acts on: a campaign that can come up in a vote has to be installed
  // before the match, and one that cannot is optional.
  it('reports whether each campaign is in the vote pool', async () => {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1', display: 'One', isFinale: true }]);
    insertDraft(db, {
      slug: 'other', name: 'Other', vpkFilename: 'other.vpk',
      sizeBytes: 9, sha256: 'c'.repeat(64), uploadedBy: null,
    }, [{ map: 'other1', display: null, isFinale: true }]);
    for (const slug of ['dbd', 'other']) {
      publishCampaign(db, slug, slug);
    }
    setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'dbd']));

    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/custom' });
    const byslug = Object.fromEntries(
      res.json().campaigns.map((c: { slug: string; inPool: boolean }) => [c.slug, c.inPool]),
    );
    expect(byslug).toEqual({ dbd: true, other: false });
  });

  // A hand-edited map_pool must not take the public page down with it. The
  // whole point of the shared defensive read is that this degrades to "nothing
  // is in the pool" rather than throwing out of a route players hit.
  it('survives a malformed map_pool rather than erroring', async () => {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1', display: 'One', isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');
    setSetting(db, 'map_pool', 'not json at all');

    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/custom' });
    expect(res.statusCode).toBe(200);
    expect(res.json().campaigns[0].inPool).toBe(false);
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

  // A forced path that a campaign overrides would disconnect every player on
  // its maps, stock client or not: the client checks its disk against the
  // SERVER's checksum, and the server has the campaign mounted.
  it('refuses a campaign that ships files the server enforces, naming them', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const vpkPath = join(addons, 'source.vpk');
    makeVpkMulti(vpkPath, [
      { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION },
      { ext: 'txt', dir: 'scripts', name: 'game_sounds_weapons', body: '// quieter' },
      // Case must not matter: the engine's file system does not care.
      { ext: 'vmt', dir: 'Materials/Models/Infected/Hunter', name: 'Hunter_01', body: 'x' },
      { ext: 'vmt', dir: 'materials/dbd', name: 'wall', body: 'x' },
    ]);
    const form = new FormData();
    form.set('file', new Blob([readFileSync(vpkPath)]), 'dbd.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().collisions).toEqual([
      'materials/models/infected/hunter/hunter_01.vmt', 'scripts/game_sounds_weapons.txt',
    ]);
    expect(res.json().error).toContain('materials/models/infected/hunter/hunter_01.vmt');
    expect(res.json().error).toContain('scripts/game_sounds_weapons.txt');
    expect(res.json().error).not.toContain('materials/dbd/wall.vmt');

    // Refused means nothing landed: no row, no VPK, no temp file. The temp
    // file is removed in the route's finally, which runs AFTER reply.send has
    // already answered this inject, so wait for it rather than race it.
    expect(getCampaign(db, 'dbd')).toBeUndefined();
    expect(existsSync(join(addons, 'dbd.vpk'))).toBe(false);
    await vi.waitFor(() => {
      expect(readdirSync(addons).filter((f) => f.endsWith('.part'))).toEqual([]);
    });
  });

  it('accepts a multi-file campaign that ships only its own files', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const vpkPath = join(addons, 'source.vpk');
    makeVpkMulti(vpkPath, [
      { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION },
      { ext: 'vmt', dir: 'materials/dbd', name: 'wall', body: 'x' },
      { ext: 'wav', dir: 'sound/dbd', name: 'alarm', body: 'x' },
    ]);
    const form = new FormData();
    form.set('file', new Blob([readFileSync(vpkPath)]), 'dbd.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe('dbd');
  });

  it('refuses every upload when the enforced list cannot be loaded', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = await buildTestApp({ db, addonsDir: addons, consistencyListPath: join(addons, 'no-such.cfg') });
      const vpkPath = join(addons, 'source.vpk');
      makeVpk(vpkPath, { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION });
      const form = new FormData();
      form.set('file', new Blob([readFileSync(vpkPath)]), 'dbd.vpk');
      const res = await app.inject({
        method: 'POST', url: '/api/admin/campaigns',
        cookies: adminCookie(app, '76561198000000001'),
        payload: form,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatch(/enforced file list/);
      expect(getCampaign(db, 'dbd')).toBeUndefined();
    } finally {
      err.mockRestore();
    }
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

  // The floor is 2 GB of headroom PLUS the incoming file, not a flat 2 GB.
  // Free space just over the flat floor, but under floor-plus-this-upload,
  // must still be refused: otherwise a large-enough upload can land and
  // leave the partition (which srcds also runs on) nearly full.
  //
  // light-my-request's FormData support streams the multipart body without
  // ever computing a Content-Length (see node_modules/light-my-request/lib/
  // form-data.js), unlike a real browser upload, which does send one for a
  // FormData made of already-sized Blobs. The header is set explicitly here
  // to stand in for that, exactly as a real upload's request would arrive.
  it('refuses when free disk clears the flat floor but not floor-plus-upload-size', async () => {
    const big = 'x'.repeat(1_000_000); // ~1 MB declared via content-length
    const justOverFlatFloor = 2 * 1024 * 1024 * 1024 + 1024;
    const app = await buildTestApp({ db, addonsDir: addons, freeBytes: justOverFlatFloor });
    const form = new FormData();
    form.set('file', new Blob([big]), 'c.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      headers: { 'content-length': String(big.length) },
      payload: form,
    });
    expect(res.statusCode).toBe(507);
  });

  // Same declared size, but with ample free space: the upload clears the
  // floor and proceeds to the ordinary mission-parsing checks.
  it('accepts when free disk clears floor-plus-upload-size', async () => {
    const app = await buildTestApp({ db, addonsDir: addons, freeBytes: 100 * 1024 * 1024 * 1024 });
    const vpkPath = join(addons, 'source.vpk');
    makeVpk(vpkPath, { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION });
    const bytes = readFileSync(vpkPath);
    const form = new FormData();
    form.set('file', new Blob([bytes]), 'dbd.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      headers: { 'content-length': String(bytes.length) },
      payload: form,
    });
    expect(res.statusCode).toBe(200);
  });

  // 413, not the 500 a thrown error would surface as: a file that exceeds
  // the configured limit is a rejected upload, not a server bug.
  it('413s a file over the size limit instead of 500ing', async () => {
    const app = await buildTestApp({ db, addonsDir: addons, maxUploadBytes: 10 });
    const form = new FormData();
    form.set('file', new Blob(['this body is longer than ten bytes']), 'c.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/size limit/i);
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

describe('GET /api/admin/campaigns', () => {
  it('lists every campaign with its chapters and installs', async () => {
    seedServer1();
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1_alley', display: 'Alley', isFinale: true }]);
    setInstall(db, 'dbd', 1, 'installed', { sha256: 'a'.repeat(64) });

    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({
      method: 'GET', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0].slug).toBe('dbd');
    expect(body.campaigns[0].chapters.map((c: { map: string }) => c.map)).toEqual(['dbd1_alley']);
    expect(body.campaigns[0].installs).toEqual([
      expect.objectContaining({ server_id: 1, state: 'installed' }),
    ]);
  });

  // statfs('') throws; that must not take the whole panel down, since the
  // list itself has nothing to do with whether addonsDir is configured.
  it('degrades to a null free-space figure rather than 500ing when addonsDir is unconfigured', async () => {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1_alley', display: null, isFinale: true }]);

    const app = await buildTestApp({ db, addonsDir: '' });
    const res = await app.inject({
      method: 'GET', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.free).toBeNull();
    expect(body.campaigns.map((c: { slug: string }) => c.slug)).toEqual(['dbd']);
  });

  it('refuses a non-admin', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({
      method: 'GET', url: '/api/admin/campaigns',
      cookies: authedCookie(app, db, '76561198000000009'),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/admin/campaigns/:slug/publish', () => {
  // sizeBytes 9 matches fakeAddonsTransport's hardcoded landed size, the same
  // convention tests/campaignInstall.test.ts uses, so installCampaign's own
  // size check passes and the row lands as 'installed' rather than 'failed'.
  const draftDbd = () => {
    seedServer1();
    writeFileSync(join(addons, 'dbd.vpk'), 'vpk bytes');
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1_alley', display: null, isFinale: true }]);
  };

  it('publishes a draft, logs the action, invalidates the cache, and kicks the install', async () => {
    draftDbd();
    const fake = fakeAddonsTransport();
    const app = await buildTestApp({
      db, addonsDir: addons, installTargets: () => [{ id: 1, transport: fake.transport }],
    });

    // Warm the cache on the pre-publish state (draft campaigns aren't in it),
    // so a stale answer after publish would prove invalidateCampaignCache was
    // skipped rather than just never having been exercised.
    expect(campaignRegistry(db).has('dbd')).toBe(false);

    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns/dbd/publish',
      cookies: adminCookie(app, '76561198000000001'),
      payload: { name: 'Dead Before Dawn' },
    });
    expect(res.statusCode).toBe(200);

    const row = getCampaign(db, 'dbd')!;
    expect(row.state).toBe('published');
    expect(row.name).toBe('Dead Before Dawn');

    expect(campaignRegistry(db).has('dbd')).toBe(true);
    expect(db.prepare("SELECT admin_id FROM admin_actions WHERE action = 'campaign_publish'").all())
      .toEqual([{ admin_id: '76561198000000001' }]);

    // The install itself is fired without being awaited by the route, so
    // this is checking a background job's result, not a response body. It
    // is not racy here specifically because fakeAddonsTransport never touches
    // a real timer or the filesystem: every step is a plain microtask, and
    // Node drains the whole microtask queue (including this fire-and-forget
    // chain) before control returns past Fastify's own reply pipeline to this
    // await. A transport doing real disk or network I/O would not offer that
    // guarantee, which is exactly why the route never awaits it either.
    expect(installsOf(db, 'dbd')).toEqual([
      expect.objectContaining({ server_id: 1, state: 'installed' }),
    ]);
    expect(fake.files.has('dbd.vpk')).toBe(true);
  });

  it('refuses a non-admin', async () => {
    draftDbd();
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns/dbd/publish',
      cookies: authedCookie(app, db, '76561198000000009'),
      payload: { name: 'Dead Before Dawn' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s for a campaign that does not exist', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns/nope/publish',
      cookies: adminCookie(app, '76561198000000001'),
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/admin/campaigns/:slug/reinstall', () => {
  const publishedDbd = () => {
    seedServer1();
    writeFileSync(join(addons, 'dbd.vpk'), 'vpk bytes');
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1_alley', display: null, isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');
  };

  it('re-fires the install and logs the action', async () => {
    publishedDbd();
    const fake = fakeAddonsTransport();
    const app = await buildTestApp({
      db, addonsDir: addons, installTargets: () => [{ id: 1, transport: fake.transport }],
    });
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns/dbd/reinstall',
      cookies: adminCookie(app, '76561198000000001'),
    });
    expect(res.statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) c FROM admin_actions WHERE action = 'campaign_reinstall'").get())
      .toEqual({ c: 1 });
    // See the comment in the publish test: safe to assert synchronously here
    // because fakeAddonsTransport never leaves the microtask queue.
    expect(installsOf(db, 'dbd')).toEqual([
      expect.objectContaining({ server_id: 1, state: 'installed' }),
    ]);
  });

  it('refuses a non-admin', async () => {
    publishedDbd();
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns/dbd/reinstall',
      cookies: authedCookie(app, db, '76561198000000009'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s for a campaign that does not exist', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns/nope/reinstall',
      cookies: adminCookie(app, '76561198000000001'),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/admin/campaigns/:slug', () => {
  const installedDbd = (fake: ReturnType<typeof fakeAddonsTransport>) => {
    seedServer1();
    writeFileSync(join(addons, 'dbd.vpk'), 'vpk bytes');
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1_alley', display: null, isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');
    setInstall(db, 'dbd', 1, 'installed', { sha256: 'a'.repeat(64) });
    fake.files.set('dbd.vpk', 9);
  };

  it('removes the install rows, removes the local file, and stops serving downloads', async () => {
    const fake = fakeAddonsTransport();
    installedDbd(fake);
    const app = await buildTestApp({
      db, addonsDir: addons, installTargets: () => [{ id: 1, transport: fake.transport }],
    });

    const before = await app.inject({ method: 'GET', url: '/download/campaign/dbd' });
    expect(before.statusCode).toBe(200);

    const res = await app.inject({
      method: 'DELETE', url: '/api/admin/campaigns/dbd',
      cookies: adminCookie(app, '76561198000000001'),
    });
    expect(res.statusCode).toBe(200);

    expect(installsOf(db, 'dbd')).toEqual([]);
    expect(getCampaign(db, 'dbd')).toBeUndefined();
    expect(existsSync(join(addons, 'dbd.vpk'))).toBe(false);
    expect(fake.files.has('dbd.vpk')).toBe(false);
    expect(db.prepare("SELECT COUNT(*) c FROM admin_actions WHERE action = 'campaign_delete'").get())
      .toEqual({ c: 1 });

    const after = await app.inject({ method: 'GET', url: '/download/campaign/dbd' });
    expect(after.statusCode).toBe(404);
  });

  // Nothing else prunes map_pool. Left in it, the deleted slug stays a vote
  // option even though the orchestrator will now refuse it at match start
  // (tests/orchestrator.test.ts): this is what keeps it from ever reaching
  // that guard in the first place.
  it('prunes the deleted campaign out of map_pool', async () => {
    const fake = fakeAddonsTransport();
    installedDbd(fake);
    setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'dbd', 'death_toll']));
    const app = await buildTestApp({
      db, addonsDir: addons, installTargets: () => [{ id: 1, transport: fake.transport }],
    });

    const res = await app.inject({
      method: 'DELETE', url: '/api/admin/campaigns/dbd',
      cookies: adminCookie(app, '76561198000000001'),
    });
    expect(res.statusCode).toBe(200);
    expect(getJsonSetting<string[]>(db, 'map_pool')).toEqual(['no_mercy', 'death_toll']);
  });

  it('leaves map_pool untouched when the deleted campaign was never pooled', async () => {
    const fake = fakeAddonsTransport();
    installedDbd(fake);
    setSetting(db, 'map_pool', JSON.stringify(['no_mercy']));
    const app = await buildTestApp({
      db, addonsDir: addons, installTargets: () => [{ id: 1, transport: fake.transport }],
    });

    const res = await app.inject({
      method: 'DELETE', url: '/api/admin/campaigns/dbd',
      cookies: adminCookie(app, '76561198000000001'),
    });
    expect(res.statusCode).toBe(200);
    expect(getJsonSetting<string[]>(db, 'map_pool')).toEqual(['no_mercy']);
  });

  // Refusing rather than silently reintroducing the stock four: the admin
  // chose a pool with only this campaign in it, and a delete should not get
  // to override that choice on its own.
  it('refuses to delete the only campaign left in the pool', async () => {
    const fake = fakeAddonsTransport();
    installedDbd(fake);
    setSetting(db, 'map_pool', JSON.stringify(['dbd']));
    const app = await buildTestApp({
      db, addonsDir: addons, installTargets: () => [{ id: 1, transport: fake.transport }],
    });

    const res = await app.inject({
      method: 'DELETE', url: '/api/admin/campaigns/dbd',
      cookies: adminCookie(app, '76561198000000001'),
    });
    expect(res.statusCode).toBe(409);
    expect(getJsonSetting<string[]>(db, 'map_pool')).toEqual(['dbd']);
    // Refused before doing anything else: the campaign, its file and its
    // install rows are all still there.
    expect(getCampaign(db, 'dbd')).not.toBeUndefined();
    expect(existsSync(join(addons, 'dbd.vpk'))).toBe(true);
  });

  it('refuses a non-admin', async () => {
    const fake = fakeAddonsTransport();
    installedDbd(fake);
    const app = await buildTestApp({
      db, addonsDir: addons, installTargets: () => [{ id: 1, transport: fake.transport }],
    });
    const res = await app.inject({
      method: 'DELETE', url: '/api/admin/campaigns/dbd',
      cookies: authedCookie(app, db, '76561198000000009'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s for a campaign that does not exist', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const res = await app.inject({
      method: 'DELETE', url: '/api/admin/campaigns/nope',
      cookies: adminCookie(app, '76561198000000001'),
    });
    expect(res.statusCode).toBe(404);
  });
});
