import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { ADMIN } from './eventFixture.js';
import { A, B, OUTSIDER, entryFixture, rosterA, rosterB, type EntryFixture } from './entryFixture.js';

let f: EntryFixture;
let app: FastifyInstance;
let communityDir: string;
const cookies: Record<string, Record<string, string>> = {};
let slug: string;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(async () => {
  f = entryFixture({ startsAt: days(9) });
  communityDir = mkdtempSync(join(tmpdir(), 'entries-'));
  app = await buildServer({
    config: { ...loadConfig({}), communityDir }, db: f.db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const s of [...A, ...B, OUTSIDER, ADMIN]) cookies[s] = authedCookie(app, f.db, s);
  slug = E.getEvent(f.db, f.eventId)!.slug;
});
afterEach(async () => { await app.close(); });

const get = (url: string, as?: string) => app.inject({ method: 'GET', url, cookies: as ? cookies[as] : undefined });
const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });

describe('registration over HTTP', () => {
  it('offers a captain their team with each member marked, then registers it', async () => {
    const mine = (await get(`/api/events/${slug}/mine`, A[0])).json();
    expect(mine.canRegister).toBe(true);
    expect(mine.register).toHaveLength(1);
    expect(mine.register[0].members.map((m: { steamid: string }) => m.steamid)).toEqual(expect.arrayContaining(A));
    const res = await post(`/api/events/${slug}/entries`, A[0], { teamId: f.teamA, roster: rosterA() });
    expect(res.statusCode).toBe(200);
    const after = (await get(`/api/events/${slug}/mine`, A[0])).json();
    expect(after.register).toEqual([]);
    expect(after.entries[0]).toMatchObject({ name: 'Rats', manage: true, onRoster: true, status: 'registered', waitlist: null });
    const pub = (await get(`/api/events/${slug}`)).json();
    expect(pub.entries).toEqual([{ id: after.entries[0].id, name: 'Rats', tag: 'RAT', logoKey: null, seed: null, status: 'registered', waitlist: null, placement: null }]);
  });

  it('answers a refusal with the players and their problems by name', async () => {
    f.db.prepare('UPDATE players SET discord_id = NULL WHERE steamid = ?').run(A[2]);
    const res = await post(`/api/events/${slug}/entries`, A[0], { teamId: f.teamA, roster: rosterA() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Someone on the roster does not meet the entry rules.',
      problems: [{ steamid: A[2], name: `p${A[2].slice(-3)}`, problems: ['Discord is not linked'] }],
    });
  });

  it('lets a rostered player leave and a captain withdraw and check in', async () => {
    const id = (await post(`/api/events/${slug}/entries`, B[0], { teamId: f.teamB, roster: rosterB() })).json().id;
    expect((await post(`/api/events/${slug}/entries/${id}/checkin`, B[0])).statusCode).toBe(409);
    E.openCheckin(f.db, { eventId: f.eventId, by: null });
    expect((await post(`/api/events/${slug}/entries/${id}/checkin`, B[0])).statusCode).toBe(200);
    expect((await post(`/api/events/${slug}/entries/${id}/leave`, B[3])).statusCode).toBe(200);
    expect(N.getEntry(f.db, id)!.status).toBe('registered');
    expect((await post(`/api/events/${slug}/entries/${id}/withdraw`, B[0])).statusCode).toBe(200);
  });

  it('refuses an entry id from another event as not found', async () => {
    const id = (await post(`/api/events/${slug}/entries`, B[0], { teamId: f.teamB, roster: rosterB() })).json().id;
    const other = E.createEvent(f.db, { by: A[0], fields: { name: 'Other Cup', startsAt: days(30), entryKind: 'team' } });
    if (!other.ok) throw new Error(other.error);
    f.db.prepare("UPDATE events SET status = 'announced' WHERE id = ?").run(other.value.id);
    expect((await post(`/api/events/${other.value.slug}/entries/${id}/withdraw`, B[0])).statusCode).toBe(404);
  });

  it('is a 404 signed out, and with the switch closed', async () => {
    // Signed out gets the same 404 as a closed switch (allowedActive, like
    // the team routes): competitiveAccess(db, null) is always false, so an
    // anonymous caller never reaches the login check to get a 401.
    expect((await app.inject({ method: 'POST', url: `/api/events/${slug}/entries`, payload: {} })).statusCode).toBe(404);
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await get(`/api/events/${slug}/mine`, A[0])).statusCode).toBe(404);
  });
});

describe('drafts over HTTP', () => {
  it('answers a draft with 404 to a player on /mine and on register, and lets an admin read /mine', async () => {
    f.db.prepare("UPDATE events SET status = 'draft' WHERE id = ?").run(f.eventId);
    expect((await get(`/api/events/${slug}/mine`, A[0])).statusCode).toBe(404);
    expect((await post(`/api/events/${slug}/entries`, A[0], { teamId: f.teamA, roster: rosterA() })).statusCode).toBe(404);
    expect(N.entryOfTeam(f.db, f.eventId, f.teamA)).toBeUndefined();
    const admin = await get(`/api/events/${slug}/mine`, ADMIN);
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toMatchObject({ entries: [], register: [] });
  });
});

describe('entry logos', () => {
  const KEY = 'd'.repeat(64);
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082', 'hex');
  beforeEach(() => {
    mkdirSync(join(communityDir, 'logos'), { recursive: true });
    writeFileSync(join(communityDir, 'logos', `${KEY}.png`), PNG);
  });

  it('serves a key only an entry of a visible event holds', async () => {
    expect((await get(`/api/events/logos/${KEY}.png`, A[0])).statusCode).toBe(404);
    f.db.prepare('UPDATE teams SET logo_key = ? WHERE id = ?').run(KEY, f.teamA);
    await post(`/api/events/${slug}/entries`, A[0], { teamId: f.teamA, roster: rosterA() });
    const res = await get(`/api/events/logos/${KEY}.png`, B[0]);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    f.db.prepare("UPDATE events SET status = 'draft' WHERE id = ?").run(f.eventId);
    expect((await get(`/api/events/logos/${KEY}.png`, B[0])).statusCode).toBe(404);
  });
});
