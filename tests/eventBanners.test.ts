import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { CommunityStore } from '../src/community/store.js';
import { BANNER_MAX_BYTES, bannerType, checkBanner, webpSize } from '../src/community/validate.js';
import { ORPHAN_GRACE_MS, sweepCommunity } from '../src/community/sweep.js';
import * as E from '../src/events/events.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { png } from './pngFixture.js';
import { ADMIN, NOW, eventFixture, must } from './eventFixture.js';

/** The first 30 bytes of a WebP of each kind, enough for webpSize, then padding. */
function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number, pad = 64): Buffer {
  const b = Buffer.alloc(30 + pad);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'latin1');
  b.write(kind, 12, 'latin1');
  b.writeUInt32LE(b.length - 20, 16);
  if (kind === 'VP8 ') {
    b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  } else if (kind === 'VP8L') {
    const bits = (w - 1) | ((h - 1) << 14);
    b[20] = 0x2f;
    b.writeUInt32LE(bits >>> 0, 21);
  } else {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  }
  return b;
}

describe('banner checks', () => {
  it('reads the size of all three WebP kinds, and nothing else as a WebP', () => {
    expect(webpSize(webp('VP8 ', 1600, 400))).toEqual({ w: 1600, h: 400 });
    expect(webpSize(webp('VP8L', 1600, 400))).toEqual({ w: 1600, h: 400 });
    expect(webpSize(webp('VP8X', 1600, 400))).toEqual({ w: 1600, h: 400 });
    expect(webpSize(png(1600, 400))).toBeNull();
    expect(webpSize(Buffer.from('RIFF....WAVEfmt '))).toBeNull();
  });

  it('takes a 1600 x 400 PNG or WebP up to 1 MB, and nothing else', () => {
    expect(checkBanner(png(1600, 400))).toEqual({ ok: true, value: { w: 1600, h: 400, type: 'png' } });
    expect(checkBanner(webp('VP8X', 1600, 400))).toEqual({ ok: true, value: { w: 1600, h: 400, type: 'webp' } });
    expect(checkBanner(png(1600, 401))).toMatchObject({ ok: false, status: 400 });
    expect(checkBanner(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)]))).toMatchObject({ ok: false, status: 400, error: 'The banner is not a PNG or WebP image.' });
    expect(checkBanner(Buffer.alloc(BANNER_MAX_BYTES + 1))).toMatchObject({ ok: false, status: 413 });
    expect(bannerType(webp('VP8 ', 1600, 400))).toBe('webp');
  });
});

describe('banner files', () => {
  it('stay through the sweep while any event holds them, and an entry logo snapshot keeps its logo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'banners-'));
    const store = new CommunityStore({ dir, maxBytes: () => 1e9, freeBytes: async () => 1e12 });
    const used = store.putBanner(png(1600, 400));
    const spare = store.putBanner(webp('VP8X', 1600, 400));
    const logo = store.putLogo(png(256, 256));
    const f = eventFixture('announced');
    must(E.setEventBanner(f.db, { eventId: f.eventId, by: ADMIN, bannerKey: used.name, now: NOW }));
    must(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: null, now: NOW }));
    f.db.prepare("INSERT INTO event_entries (event_id, name, logo_key, registered_by, created_at) VALUES (?, 'Rats', ?, ?, 'x')")
      .run(f.eventId, logo.name, ADMIN);
    const old = (Date.now() - ORPHAN_GRACE_MS - 60_000) / 1000;
    for (const kind of ['banner', 'logo'] as const) for (const file of store.list(kind)) utimesSync(file.file, old, old);
    sweepCommunity(f.db, store, new Date());
    expect(store.readBanner(used.name)).not.toBeNull();
    expect(store.readBanner(spare.name)).toBeNull();
    expect(store.readLogo(logo.name)).not.toBeNull();
  });
});

describe('setEventBanner', () => {
  it('sets, keeps quiet on the same key, removes, and refuses a key that is not a sha256', () => {
    const f = eventFixture();
    const key = 'b'.repeat(64);
    expect(must(E.setEventBanner(f.db, { eventId: f.eventId, by: ADMIN, bannerKey: key, now: NOW })).banner_key).toBe(key);
    must(E.setEventBanner(f.db, { eventId: f.eventId, by: ADMIN, bannerKey: key, now: NOW }));
    expect(must(E.setEventBanner(f.db, { eventId: f.eventId, by: ADMIN, bannerKey: null, now: NOW })).banner_key).toBeNull();
    expect(E.eventLog(f.db, f.eventId).map((l) => l.action).slice(-2)).toEqual(['banner_set', 'banner_removed']);
    expect(E.setEventBanner(f.db, { eventId: f.eventId, by: ADMIN, bannerKey: '../etc', now: NOW })).toEqual({ ok: false, error: 'bad_request' });
    expect(E.setEventBanner(f.db, { eventId: 999, by: ADMIN, bannerKey: null, now: NOW })).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('banner routes', () => {
  const MOD = '76561199000000741';
  const PLAYER = '76561199000000742';
  let db: DB;
  let app: FastifyInstance;
  let cookies: Record<string, Record<string, string>>;
  beforeEach(async () => {
    db = openDb(':memory:');
    app = await buildServer({
      config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'eventbanners-')) },
      db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    });
    cookies = {};
    for (const id of [ADMIN, MOD, PLAYER]) cookies[id] = authedCookie(app, db, id);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  });
  afterEach(async () => { await app.close(); });
  const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
    app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });
  const draftEvent = () => must(E.createEvent(db, {
    by: ADMIN, fields: { name: 'Banner Cup', startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), entryKind: 'team' },
  }));

  it('an admin uploads a banner; it is audited twice and served as its own type', async () => {
    const ev = draftEvent();
    const image = webp('VP8X', 1600, 400).toString('base64');
    const up = await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, { image });
    expect(up.statusCode).toBe(200);
    const { bannerKey } = up.json();
    expect(E.getEvent(db, ev.id)!.banner_key).toBe(bannerKey);
    expect(E.eventLog(db, ev.id).at(-1)!.action).toBe('banner_set');
    expect(db.prepare("SELECT target FROM admin_actions WHERE action = 'event_banner'").get()).toEqual({ target: String(ev.id) });
    const got = await call('GET', `/api/events/banners/${bannerKey}`, ADMIN);
    expect([got.statusCode, got.headers['content-type'], got.headers['x-content-type-options']]).toEqual([200, 'image/webp', 'nosniff']);
  });

  it('refuses a wrong size, a non-image, an over-large body, a mod and a player', async () => {
    const ev = draftEvent();
    const bad = await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, { image: png(800, 400).toString('base64') });
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'The banner must be 1600 x 400.' }]);
    expect((await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, { image: 'not base64 at all' })).statusCode).toBe(400);
    expect((await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, {})).statusCode).toBe(400);
    expect((await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, { image: Buffer.alloc(BANNER_MAX_BYTES + 10).toString('base64') })).statusCode).toBe(413);
    for (const who of [MOD, PLAYER]) {
      expect((await call('POST', `/api/admin/events/${ev.id}/banner`, who, { image: png(1600, 400).toString('base64') })).statusCode).toBe(403);
    }
    expect((await call('POST', '/api/admin/events/999/banner', ADMIN, { image: png(1600, 400).toString('base64') })).statusCode).toBe(404);
    expect(E.getEvent(db, ev.id)!.banner_key).toBeNull();
  });

  it('serves a banner only while an event the viewer may see holds it', async () => {
    const ev = draftEvent();
    const { bannerKey } = (await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, { image: png(1600, 400).toString('base64') })).json();
    expect((await call('GET', `/api/events/banners/${bannerKey}`, PLAYER)).statusCode).toBe(404);
    expect((await call('GET', `/api/events/banners/${bannerKey}`, MOD)).statusCode).toBe(200);
    db.prepare("UPDATE events SET status = 'announced' WHERE id = ?").run(ev.id);
    const open = await call('GET', `/api/events/banners/${bannerKey}`);
    expect([open.statusCode, open.headers['content-type']]).toEqual([200, 'image/png']);
    expect((await call('POST', `/api/admin/events/${ev.id}/banner/remove`, ADMIN)).statusCode).toBe(200);
    expect((await call('GET', `/api/events/banners/${bannerKey}`)).statusCode).toBe(404);
    expect((await call('GET', '/api/events/banners/not-a-key')).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event_banner_remove'").get()).toEqual({ n: 1 });
  });
});
