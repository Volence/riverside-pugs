import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as E from '../src/events/events.js';
import { must } from './eventFixture.js';

const ADMIN = '76561199000000720';
const MOD = '76561199000000721';
const PLAYER = '76561199000000722';

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const cup = () => (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;

/** An event with a Swiss stage and a single elimination final, at `status`. */
function event(name: string, startsAt: string, status: 'draft' | 'announced' | 'registration' = 'announced', fields: object = {}): E.EventRow {
  const ev = must(E.createEvent(db, { by: ADMIN, fields: { name, startsAt, entryKind: 'team', ...fields } }));
  must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: { type: 'swiss', config: { rounds: 4 }, rulesetId: cup(), campaignPool: ['no_mercy', 'dead_air'], advanceCount: 8 } }));
  must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: { type: 'single_elim', config: { thirdPlace: true }, rulesetId: cup(), campaignPool: ['dead_air'], chapters: 3 } }));
  if (status !== 'draft') must(E.publishEvent(db, { eventId: ev.id, by: ADMIN }));
  if (status === 'registration') must(E.openRegistration(db, { eventId: ev.id, by: ADMIN }));
  return E.getEvent(db, ev.id)!;
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'events-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookies = {};
  for (const id of [ADMIN, MOD, PLAYER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare("UPDATE players SET name = 'Organizer' WHERE steamid = ?").run(ADMIN);
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
});
afterEach(async () => { await app.close(); });

const get = (url: string, as?: string) => app.inject({ method: 'GET', url, cookies: as ? cookies[as] : undefined });

describe('GET /api/events', () => {
  it('lists open events soonest first, then past ones newest first, with their format', async () => {
    event('Later Cup', days(9));
    event('Soon Cup', days(2), 'registration');
    const old = event('Old Cup', days(3));
    const older = event('Older Cup', days(4));
    for (const e of [old, older]) must(E.cancelEvent(db, { eventId: e.id, by: ADMIN, reason: null }));
    const list = (await get('/api/events', PLAYER)).json().events;
    expect(list.map((e: { name: string; status: string }) => [e.name, e.status])).toEqual([
      ['Soon Cup', 'registration'], ['Later Cup', 'announced'], ['Older Cup', 'cancelled'], ['Old Cup', 'cancelled'],
    ]);
    expect(list[0]).toMatchObject({ slug: 'soon-cup', entryKind: 'team', official: true, format: ['Swiss', 'Single elimination'], entries: 0 });
  });

  it('leaves drafts out for everyone but staff', async () => {
    event('Secret Cup', days(5), 'draft');
    event('Open Cup', days(6));
    for (const who of [undefined, PLAYER]) {
      expect((await get('/api/events', who)).json().events.map((e: { name: string }) => e.name)).toEqual(['Open Cup']);
    }
    for (const who of [ADMIN, MOD]) {
      expect((await get('/api/events', who)).json().events.map((e: { name: string }) => e.name)).toEqual(['Secret Cup', 'Open Cup']);
    }
  });
});

describe('GET /api/events/:slug', () => {
  it('serves the page: status, start, format strip, rules, pools, entry rules, no entries yet', async () => {
    const ev = event('Riverside Cup', days(5), 'announced', { description: 'Line one\n<b>two</b>', teamCap: 16 });
    const r = await get(`/api/events/${ev.slug}`, PLAYER);
    expect(r.statusCode).toBe(200);
    const v = r.json();
    expect(v).toMatchObject({
      slug: 'riverside-cup', name: 'Riverside Cup', status: 'announced', entryKind: 'team', official: true, organizerName: 'Organizer',
      startsAt: ev.starts_at, description: 'Line one\n<b>two</b>', teamCap: 16, entries: [], cancelReason: null, bannerKey: null,
      checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
    });
    expect(v.stages.map((s: { summary: string }) => s.summary)).toEqual(['Swiss, 4 rounds, top 8 advance', 'Single elimination, third-place match']);
    expect(v.stages[1]).toMatchObject({
      ordinal: 2, type: 'single_elim',
      veto: 'Bo1: no bans, the higher seed chooses to go first or second, the team that did not pick chooses sides.',
      chapters: '3 chapters', scheduling: 'rolling',
      rulesetName: 'Standard Cup', gameConfig: expect.any(String), campaigns: [{ slug: 'dead_air', name: 'Dead Air' }],
    });
    expect(v.stages[0].rules).toContain('No-show grace: 15 minutes');
    expect(r.body.includes(ADMIN)).toBe(false);
  });

  it('a draft is the same 404 as an unknown slug to everyone but staff', async () => {
    const draft = event('Secret Cup', days(5), 'draft');
    const unknown = await get('/api/events/no-such-cup', PLAYER);
    expect(unknown.statusCode).toBe(404);
    for (const who of [undefined, PLAYER]) {
      const r = await get(`/api/events/${draft.slug}`, who);
      expect([r.statusCode, r.body]).toEqual([404, unknown.body]);
    }
    expect((await get(`/api/events/${draft.slug}`, MOD)).statusCode).toBe(200);
    const mine = await get(`/api/events/${draft.slug}`, ADMIN);
    expect(mine.statusCode).toBe(200);
    // A draft has no snapshot yet: its rules are read from the chosen ruleset.
    expect(mine.json().stages[0].rules).toContain('Higher seed picks sides');
  });

  it('shows a cancelled event with its reason', async () => {
    const ev = event('Gone Cup', days(5));
    must(E.cancelEvent(db, { eventId: ev.id, by: ADMIN, reason: 'Not enough teams' }));
    expect((await get(`/api/events/${ev.slug}`)).json()).toMatchObject({ status: 'cancelled', cancelReason: 'Not enough teams' });
  });

  it('follows the switch: admins only hides it from players and visitors', async () => {
    const ev = event('Riverside Cup', days(5));
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await get(`/api/events/${ev.slug}`, PLAYER)).statusCode).toBe(404);
    expect((await get(`/api/events/${ev.slug}`)).statusCode).toBe(404);
    expect((await get(`/api/events/${ev.slug}`, ADMIN)).statusCode).toBe(200);
  });
});
