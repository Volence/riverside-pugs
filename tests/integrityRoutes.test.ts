import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { ANALYZER_VERSION } from '../src/integrity/store.js';

const ADMIN = '76561198000000009';
const SUS = '76561198000000001';
const CLEAN = '76561198000000002';
let db: DB;
let app: FastifyInstance;
let adminCookie: Record<string, string>;
let userCookie: Record<string, string>;

const metrics = (fidMax: number, occZ: number | null) =>
  JSON.stringify({
    fidMax, fidP95: fidMax / 2, occZ, teamRank: 1, teamGap: occZ, eligiblePairs: 200,
    gates: { considered: 600, notLive: 50, notGhost: 150, inGrace: 100, tooClose: 50, occluded: 50, passed: 200 },
  });

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {} });
  adminCookie = authedCookie(app, db, ADMIN);
  userCookie = authedCookie(app, db, CLEAN);
  authedCookie(app, db, SUS);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'farm')").run();
  const ins = db.prepare(
    `INSERT INTO integrity_rounds (match_id, ordinal, half, slot, steamid, analyzer_version, metrics, computed_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  ins.run(1, 1, 0, SUS, ANALYZER_VERSION, metrics(0.95, 4.2));
  ins.run(1, 1, 1, CLEAN, ANALYZER_VERSION, metrics(0.2, 0.1));
  // A SECOND player-round for the same player, differing only in slot. With one
  // round in the fixture a partial-key lookup that dropped half or slot would
  // still match and the review tests would still pass, while an admin was being
  // shown that a moment had already been cleared when it had not.
  ins.run(2, 1, 3, SUS, ANALYZER_VERSION, metrics(0.8, 3.0));
  const insClip = db.prepare(
    `INSERT INTO integrity_clips (match_id, ordinal, half, slot, steamid, start_ms, end_ms, kind, score, detail, analyzer_version)
     VALUES (1, ?, ?, ?, ?, ?, ?, 'ghost_track', ?, '{"ghostSlot":4}', ?)`,
  );
  insClip.run(1, 1, 0, SUS, 12000, 14000, 0.95, ANALYZER_VERSION);
  insClip.run(2, 1, 3, SUS, 30000, 32000, 0.8, ANALYZER_VERSION);
});
afterEach(async () => { await app.close(); });

describe('GET /api/admin/integrity', () => {
  it('refuses a non-admin', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/integrity', cookies: userCookie });
    expect(r.statusCode).toBe(403);
  });

  // /backfill sits under the same prefix as /:steamid, and a steamid is just
  // a string. If the parametric route ever won, pressing the button would
  // silently look up a player called "backfill" and report nothing.
  it('resolves /integrity/backfill as the job route, not as a player id', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/integrity/backfill', cookies: adminCookie });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { available: boolean; job?: { status: string } };
    // loadConfig({}) has no replay directory, so the honest answer is that
    // there is nothing to analyse here.
    expect(body).toHaveProperty('available');
    expect(body).not.toHaveProperty('rounds');
  });

  it('refuses the job route to a non-admin', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/integrity/backfill', cookies: userCookie });
    expect(r.statusCode).toBe(403);
  });

  it('refuses to start a run with no replay directory rather than failing silently', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/integrity/backfill', cookies: adminCookie, payload: { mode: 'full' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: expect.stringMatching(/replay directory/i) });
  });

  it('returns players ranked by composite', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/integrity', cookies: adminCookie });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { players: { steamid: string; composite: number }[] };
    expect(body.players[0].steamid).toBe(SUS);
    expect(body.players[0].composite).toBeGreaterThan(body.players[1].composite);
  });

  it('names the players and counts their clips, so nobody is a 17 digit number', async () => {
    db.prepare('UPDATE players SET name = ? WHERE steamid = ?').run('tino', SUS);
    const r = await app.inject({ method: 'GET', url: '/api/admin/integrity', cookies: adminCookie });
    const body = r.json() as { players: { steamid: string; name: string; clips: number }[] };
    const sus = body.players.find((p) => p.steamid === SUS)!;
    const clean = body.players.find((p) => p.steamid === CLEAN)!;
    expect(sus.name).toBe('tino');
    expect(sus.clips).toBe(2);
    expect(clean.clips).toBe(0);
  });

  it('falls back to the SteamID when the player has no name', async () => {
    db.prepare('UPDATE players SET name = ? WHERE steamid = ?').run('', SUS);
    const r = await app.inject({ method: 'GET', url: '/api/admin/integrity', cookies: adminCookie });
    const body = r.json() as { players: { steamid: string; name: string }[] };
    expect(body.players.find((p) => p.steamid === SUS)!.name).toBe(SUS);
  });
});

describe('GET /api/admin/integrity/:steamid', () => {
  it('returns that player rounds and clips', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/admin/integrity/${SUS}`, cookies: adminCookie });
    const body = r.json() as { rounds: unknown[]; clips: { startMs: number }[] };
    expect(body.rounds).toHaveLength(2);
    expect(body.clips[0].startMs).toBe(12000);
  });
});

describe('POST review', () => {
  it('marks only the addressed player-round, not its neighbour one slot over', async () => {
    // The key is all four of (matchId, ordinal, half, slot). Slots 0 and 3 here
    // differ in nothing else, so a lookup or a write that dropped slot would
    // show up as the other round changing too.
    await app.inject({
      method: 'POST', url: '/api/admin/integrity/1/1/1/0/review', cookies: adminCookie,
      payload: { state: 'dismissed', note: 'heard the spawn' },
    });
    const r = await app.inject({ method: 'GET', url: `/api/admin/integrity/${SUS}`, cookies: adminCookie });
    const body = r.json() as { rounds: { ordinal: number; slot: number; reviewState: string; reviewNote: string }[] };
    const touched = body.rounds.find((x) => x.slot === 0)!;
    const untouched = body.rounds.find((x) => x.slot === 3)!;
    expect(touched.reviewState).toBe('dismissed');
    expect(touched.reviewNote).toBe('heard the spawn');
    expect(untouched.reviewState).toBe('new');
    expect(untouched.reviewNote).toBe('');
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_reviews').get()).toEqual({ c: 1 });
  });

  it('records the state, the note and an audit entry', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/integrity/1/1/1/0/review', cookies: adminCookie,
      payload: { state: 'dismissed', note: 'heard the spawn' },
    });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT state, note FROM integrity_reviews').get()).toEqual({ state: 'dismissed', note: 'heard the spawn' });
    expect(db.prepare("SELECT COUNT(*) c FROM admin_actions WHERE action = 'integrity_review'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT admin_id FROM admin_actions WHERE action = 'integrity_review'").get()).toEqual({ admin_id: ADMIN });
  });

  it('rejects a state outside the allowed set', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/integrity/1/1/1/0/review', cookies: adminCookie,
      payload: { state: 'banned', note: '' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('refuses a non-admin', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/integrity/1/1/1/0/review', cookies: userCookie,
      payload: { state: 'reviewed', note: '' },
    });
    expect(r.statusCode).toBe(403);
  });
});
