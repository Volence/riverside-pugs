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
import * as N from '../src/events/entries.js';
import { ADMIN } from './eventFixture.js';
import { A, B, OUTSIDER, entryFixture, rosterA, rosterB, type EntryFixture } from './entryFixture.js';

const MOD = '76561199000000830';
let f: EntryFixture;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};
let ea: number;
let eb: number;

beforeEach(async () => {
  f = entryFixture({ teamCap: 1, startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString() });
  upsertPlayer(f.db, { steamid: MOD, name: 'mod', avatar: null }, []);
  f.db.prepare("UPDATE players SET is_mod = 1, status = 'active' WHERE steamid = ?").run(MOD);
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'desk-entries-')) },
    db: f.db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const s of [ADMIN, MOD]) cookies[s] = authedCookie(app, f.db, s);
  const reg = (team: number, by: string, roster: object) => {
    const r = N.registerEntry(f.db, { eventId: f.eventId, teamId: team, by, roster });
    if (!r.ok) throw new Error(r.error);
    return r.value.entry.id;
  };
  ea = reg(f.teamA, A[0], rosterA());
  eb = reg(f.teamB, B[0], rosterB());
});
afterEach(async () => { await app.close(); });

const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });

describe('desk entries', () => {
  it('lists entries with roster, SR and waitlist for staff', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/admin/events/${f.eventId}/entries`, cookies: cookies[MOD] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lockedAt).toBeNull();
    expect(body.entries.map((e: { id: number; waitlist: number | null }) => [e.id, e.waitlist])).toEqual([[ea, null], [eb, 1]]);
    expect(body.entries[0].roster).toHaveLength(5);
    expect(typeof body.entries[0].sr).toBe('number');
  });

  it('refuses every write from a mod', async () => {
    for (const url of ['open-checkin', 'lock-entries', `entries/${ea}/restore`, `entries/${ea}/disqualify`]) {
      expect((await post(`/api/admin/events/${f.eventId}/${url}`, MOD)).statusCode).toBe(403);
    }
  });

  it('opens check-in, finalises, reorders seeds, and audits each', async () => {
    expect((await post(`/api/admin/events/${f.eventId}/open-checkin`, ADMIN)).statusCode).toBe(200);
    N.checkInEntry(f.db, { entryId: eb, by: B[0] });
    expect((await post(`/api/admin/events/${f.eventId}/lock-entries`, ADMIN)).statusCode).toBe(200);
    expect(N.getEntry(f.db, eb)!.seed).toBe(1);
    expect((await post(`/api/admin/events/${f.eventId}/seeds`, ADMIN, { order: [eb] })).statusCode).toBe(200);
    const actions = (f.db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['event_open_checkin', 'event_lock_entries', 'event_seeds']);
  });

  it('edits a roster as staff, disqualifies with a reason and restores', async () => {
    expect((await post(`/api/admin/events/${f.eventId}/entries/${ea}/roster`, ADMIN, { roster: rosterA({ coach: OUTSIDER }) })).statusCode).toBe(200);
    expect((await post(`/api/admin/events/${f.eventId}/entries/${ea}/disqualify`, ADMIN, { reason: 'Ringer' })).statusCode).toBe(200);
    expect(N.getEntry(f.db, ea)!.status).toBe('disqualified');
    expect((await post(`/api/admin/events/${f.eventId}/entries/${ea}/restore`, ADMIN)).statusCode).toBe(200);
    expect(E.eventLog(f.db, f.eventId).map((l) => l.action)).toEqual(expect.arrayContaining(['entry_disqualified', 'entry_restored']));
  });

  it('answers an entry of another event as not found', async () => {
    expect((await post(`/api/admin/events/${f.eventId + 99}/entries/${ea}/restore`, ADMIN)).statusCode).toBe(404);
  });
});
