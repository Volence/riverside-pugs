// tests/matchVisibilityRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';

let db: DB;
let app: FastifyInstance;
let ids: string[];
let outsider: string;
let mod: string;
let priv: number;
let pub: number;
let staffOnly: number;
let bookingGame: number;
let bookingSpectator: string;
let bookingInvited: string;
let demoDir: string;

// The real file backing priv's demo ordinal 1: a regression guard has to
// exercise the route's actual R2/local-file serving path, not just the
// 404-because-nothing-was-seeded case resolveDemoPath already produces on
// its own.
const DEMO_TOKEN = 'a'.repeat(32);
const DEMO_FILENAME = `pug_${DEMO_TOKEN}_1_no_mercy.dem`;
const DEMO_BYTES = 64;

beforeEach(async () => {
  db = openDb(':memory:');
  demoDir = mkdtempSync(join(tmpdir(), 'pugdemo-vis-'));
  const all = seedPlayers(db, 14);
  ids = all.slice(0, 8);
  outsider = all[8];
  mod = all[9];
  const bookingCaptainA = all[10];
  const bookingCaptainB = all[11];
  bookingSpectator = all[12];
  bookingInvited = all[13];
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(mod);
  app = await buildServer({
    config: loadConfig({ DEMO_DIR: demoDir }), db, orchestrator: stubOrchestrator(),
    serverCleaner: async () => {}, serverExec: async () => {},
  });
  const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
  pub = seedMatch(db, { endedAt: '2026-09-21 12:00:00', lines });
  priv = seedMatch(db, { endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', lines });
  staffOnly = seedMatch(db, { endedAt: '2026-09-21 14:00:00', kind: 'scrim', visibility: 'staff', lines });
  writeFileSync(join(demoDir, DEMO_FILENAME), Buffer.alloc(DEMO_BYTES, 7));
  db.prepare(
    'INSERT INTO match_demos (match_id, ordinal, map, filename, bytes) VALUES (?, 1, ?, ?, ?)',
  ).run(priv, 'no_mercy', DEMO_FILENAME, DEMO_BYTES);

  // A booking's scrim game: side a confirmed, with an accepted spectator
  // (never a match_players row) and an invited-but-not-accepted player.
  const bookingId = Number(db.prepare(
    `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES ('scrim', 'na', '2026-09-21T15:00:00.000Z', '2026-09-21T17:00:00.000Z', 'pw', 'tvpw', 'standard', '{}', '[]', ?, '2026-09-21T14:00:00.000Z')`,
  ).run(bookingCaptainA).lastInsertRowid);
  const side = db.prepare('INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, ?, ?, ?)');
  side.run(bookingId, 'a', bookingCaptainA, '2026-09-21T14:00:00.000Z');
  side.run(bookingId, 'b', bookingCaptainB, '2026-09-21T14:00:00.000Z');
  const person = db.prepare(
    'INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  person.run(bookingId, 'a', bookingSpectator, 'spectator', 'accepted', bookingCaptainA, '2026-09-21T14:00:00.000Z');
  person.run(bookingId, 'a', bookingInvited, 'player', 'invited', bookingCaptainA, '2026-09-21T14:00:00.000Z');
  // A line-up of just the two captains, so bookingSpectator and
  // bookingInvited reach visibility purely through the booking, not by
  // being a match_players row (and so the existing "only its players"
  // assertions on pub/priv/staffOnly, scoped to `ids`, are unaffected).
  const bookingLines = [{ id: bookingCaptainA, team: 'a' as const }, { id: bookingCaptainB, team: 'b' as const }];
  bookingGame = seedMatch(db, { endedAt: '2026-09-21 18:00:00', kind: 'scrim', visibility: 'participants', lines: bookingLines });
  db.prepare('UPDATE matches SET booking_id = ? WHERE id = ?').run(bookingId, bookingGame);
});
afterEach(async () => { await app.close(); rmSync(demoDir, { recursive: true, force: true }); });

const get = (url: string, who?: string) =>
  app.inject({ method: 'GET', url, cookies: who ? authedCookie(app, db, who) : undefined });

describe('match routes respect visibility', () => {
  it('lists the private scrim only to its players', async () => {
    const listed = async (who?: string) => ((await get('/api/matches', who)).json().matches as { id: number }[]).map((m) => m.id);
    expect(await listed()).toEqual([pub]);
    expect(await listed(outsider)).toEqual([pub]);
    expect(await listed(ids[0])).toEqual([priv, pub]);
  });

  it('answers a private scrim like a missing match for outsiders', async () => {
    const missing = await get('/api/matches/999999');
    for (const who of [undefined, outsider]) {
      const r = await get(`/api/matches/${priv}`, who);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual(missing.json());
    }
    expect((await get(`/api/matches/${priv}`, ids[0])).statusCode).toBe(200);
  });

  it('gates the ongoing stub exactly like a missing match', async () => {
    db.prepare("UPDATE matches SET state = 'live' WHERE id = ?").run(priv);
    const missing = await get('/api/matches/999999');
    const stub = await get(`/api/matches/${priv}`, outsider);
    expect(stub.statusCode).toBe(404);
    expect(stub.json()).toEqual(missing.json());
  });

  it('gates a real demo file: hidden to an outsider, served to a participant', async () => {
    // The 404 a nonexistent match's demo gets is the baseline: the gated
    // response for an outsider on a real, on-disk demo must be identical, or
    // the demo's existence would leak through the difference.
    const missingDemo = await get('/api/matches/999999/demos/1');
    expect(missingDemo.statusCode).toBe(404);

    const outsiderRes = await get(`/api/matches/${priv}/demos/1`, outsider);
    expect(outsiderRes.statusCode).toBe(404);
    expect(outsiderRes.json()).toEqual(missingDemo.json());

    const participantRes = await get(`/api/matches/${priv}/demos/1`, ids[0]);
    expect(participantRes.statusCode).toBe(200);
    expect(participantRes.rawPayload.length).toBe(DEMO_BYTES);
  });

  it('shows a staff-only match to a mod but not to its own participant', async () => {
    expect((await get(`/api/matches/${staffOnly}`, ids[0])).statusCode).toBe(404);
    expect((await get(`/api/matches/${staffOnly}`, mod)).statusCode).toBe(200);
  });

  it("shows the booking's game to its accepted spectator, and hides it from an invited-but-not-accepted person", async () => {
    expect((await get(`/api/matches/${bookingGame}`, bookingSpectator)).statusCode).toBe(200);
    expect((await get(`/api/matches/${bookingGame}`, bookingInvited)).statusCode).toBe(404);
  });
});
