// tests/matchVisibilityLive.test.ts
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
import { getLiveMatches } from '../src/liveView.js';
import { replayFileVisible } from '../src/routes/replays.js';
import { viewerFor } from '../src/matchVisibility.js';
import {
  encodeHeader, encodeFrame, VERSION, PLAYER_SLOTS,
  type ReplayHeader, type Frame,
} from '../src/replayFormat.js';

const TOKEN_LIVE = 'b'.repeat(32);
const TOKEN_DONE = 'c'.repeat(32);
const TOKEN_MIX = 'd'.repeat(32);

function header(token: string, over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token, ordinal: 1, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: 1_785_956_274, indexOffset: 0, indexCount: 0, frameCount: 5,
    slots: ['', '', '', '', '', '', '', ''],
    infectedMask: 0,
    sidesKnown: false,
    ...over,
  };
}
function emptyFrame(tMs: number): Frame {
  return {
    tMs, offset: 0,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  };
}
function replayBytes(token: string): Buffer {
  return Buffer.concat([
    encodeHeader(header(token)),
    ...Array.from({ length: 5 }, (_, i) => encodeFrame(emptyFrame(i * 100))),
  ]);
}

let db: DB;
let app: FastifyInstance;
let replayDir: string;
let ids: string[];
let outsider: string;
let mod: string;
let caster: string;
/** A private scrim, live, with a real match_live/match_rounds round in
 *  progress and a real token: /api/replays/live/match/:id would answer with
 *  its phase and current round if it were not gated. */
let livePriv: number;
/** A second private scrim, completed, with a real .rpl file on disk and a
 *  match_replays row: /api/replays/match/:id/1/1 and
 *  /api/replays/timeline/:id/1/1 would both serve real content if not gated. */
let donePriv: number;

beforeEach(async () => {
  db = openDb(':memory:');
  replayDir = mkdtempSync(join(tmpdir(), 'pugreplay-vis-'));
  const all = seedPlayers(db, 11);
  ids = all.slice(0, 8);
  outsider = all[8];
  caster = all[9];
  mod = all[10];
  db.prepare('UPDATE players SET is_caster = 1 WHERE steamid = ?').run(caster);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(mod);
  app = await buildServer({
    config: loadConfig({ REPLAY_DIR: replayDir }), db, orchestrator: stubOrchestrator(),
    serverCleaner: async () => {}, serverExec: async () => {},
  });
  const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));

  livePriv = seedMatch(db, {
    endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', state: 'live', lines,
  });
  db.prepare('UPDATE matches SET token = ? WHERE id = ?').run(TOKEN_LIVE, livePriv);
  db.prepare(
    `INSERT INTO match_live (match_id, current_map, last_seen, phase, phase_since, phase_team, phase_limit, phase_leave)
     VALUES (?, 'l4d_vs_farm01_hilltop', '2026-09-21 13:00:00', 'live', '2026-09-21 13:00:00', NULL, 0, 0)`,
  ).run(livePriv);
  db.prepare(
    `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at, ended_at)
     VALUES (?, 0, 1, 'a', '2026-09-21 13:00:00', NULL)`,
  ).run(livePriv);

  donePriv = seedMatch(db, {
    endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', state: 'completed', lines,
  });
  const doneFilename = `pug_${TOKEN_DONE}_1_1.rpl`;
  writeFileSync(join(replayDir, doneFilename), replayBytes(TOKEN_DONE));
  db.prepare(
    'INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (?, 1, 1, ?, ?, 5, 10)',
  ).run(donePriv, doneFilename, replayBytes(TOKEN_DONE).length);
});
afterEach(async () => { await app.close(); rmSync(replayDir, { recursive: true, force: true }); });

const get = (url: string, who?: string) =>
  app.inject({ method: 'GET', url, cookies: who ? authedCookie(app, db, who) : undefined });
const post = (url: string, payload: unknown, who?: string) =>
  app.inject({
    method: 'POST', url, payload: payload as object,
    cookies: who ? authedCookie(app, db, who) : undefined,
  });

describe('replays and live data respect visibility', () => {
  it('live/match/:id answers a private scrim like a missing match for outsiders, and opens it to participants and staff', async () => {
    const missing = await get('/api/replays/live/match/999999');
    for (const who of [undefined, outsider]) {
      const r = await get(`/api/replays/live/match/${livePriv}`, who);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual(missing.json());
    }
    expect((await get(`/api/replays/live/match/${livePriv}`, ids[0])).statusCode).toBe(200);
    expect((await get(`/api/replays/live/match/${livePriv}`, mod)).statusCode).toBe(200);
  });

  it('match/:id/:ordinal/:half answers a private scrim like a missing replay for outsiders, and opens it to participants and staff', async () => {
    const missing = await get('/api/replays/match/999999/1/1');
    for (const who of [undefined, outsider]) {
      const r = await get(`/api/replays/match/${donePriv}/1/1`, who);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual(missing.json());
    }
    expect((await get(`/api/replays/match/${donePriv}/1/1`, ids[0])).statusCode).toBe(200);
    expect((await get(`/api/replays/match/${donePriv}/1/1`, mod)).statusCode).toBe(200);
  });

  it('timeline/:matchId/:ordinal/:half answers a private scrim like a missing match for outsiders, and opens it to participants and staff', async () => {
    const missing = await get('/api/replays/timeline/999999/1/1');
    for (const who of [undefined, outsider]) {
      const r = await get(`/api/replays/timeline/${donePriv}/1/1`, who);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual(missing.json());
    }
    expect((await get(`/api/replays/timeline/${donePriv}/1/1`, ids[0])).statusCode).toBe(200);
    expect((await get(`/api/replays/timeline/${donePriv}/1/1`, mod)).statusCode).toBe(200);
  });

  it('the public live list and the caster list leave the scrim out', async () => {
    expect(getLiveMatches(db).map((m) => m.id)).not.toContain(livePriv);
    const cast = await get('/api/cast', caster);
    expect(JSON.stringify(cast.json())).not.toContain(`"id":${livePriv}`);
  });
});

describe('replayFileVisible', () => {
  it('a filename with a match_replays row is gated by that match', () => {
    const filename = `pug_${TOKEN_DONE}_1_1.rpl`;
    expect(replayFileVisible(db, viewerFor(db, outsider), filename)).toBe(false);
    expect(replayFileVisible(db, viewerFor(db, ids[0]), filename)).toBe(true);
  });

  it('a name with no row and no ranked shape passes through unchanged', () => {
    expect(replayFileVisible(db, viewerFor(db, outsider), 'not_a_replay_name.rpl')).toBe(true);
  });

  // match_replays rows are written at round_end, so the round livePriv has in
  // progress has none yet. Its filename still carries the match's own token,
  // which is what the fallback resolves against matches.token.
  it('a round still in progress (no match_replays row yet) is gated by its token', () => {
    const filename = `pug_${TOKEN_LIVE}_0_1.rpl`;
    expect(replayFileVisible(db, viewerFor(db, outsider), filename)).toBe(false);
    expect(replayFileVisible(db, viewerFor(db, ids[0]), filename)).toBe(true);
  });

  it('a ranked-shaped name whose token belongs to no match (a standalone !mix session) passes through', () => {
    const filename = `pug_${TOKEN_MIX}_0_1.rpl`;
    expect(replayFileVisible(db, viewerFor(db, outsider), filename)).toBe(true);
  });
});

describe('POST /api/practice/drills respects visibility', () => {
  it('answers a private scrim like a missing match for an outsider, and builds normally for a participant', async () => {
    const body = { matchId: donePriv, ordinal: 1, half: 1, tMs: 200 };
    const missing = await post('/api/practice/drills', { ...body, matchId: 999999 }, ids[0]);
    expect(missing.statusCode).toBe(404);

    const asOutsider = await post('/api/practice/drills', body, outsider);
    expect(asOutsider.statusCode).toBe(404);
    expect(asOutsider.json()).toEqual(missing.json());

    const asParticipant = await post('/api/practice/drills', body, ids[0]);
    expect(asParticipant.statusCode).toBe(200);
    expect(asParticipant.json().spec).toBeTruthy();
  });
});
