import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { openDb, type DB } from '../src/db.js';
import { practiceRoutes, chapterFromName } from '../src/routes/practice.js';
import {
  encodeHeader, encodeFrame, PLAYER_SLOTS, STATE, VERSION, type Frame, type ReplayHeader,
} from '../src/replayFormat.js';
import { upsertPlayer } from '../src/players.js';
import { CODE_ALPHABET, DRILLS_PER_HOUR } from '../src/practiceDrills.js';
import type { R2Config } from '../src/r2.js';
import { authedCookie } from './helpers.js';

const TOKEN = 'd'.repeat(32);
const ME = '76561199000000050';
const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i}`);
const LIVE = STATE.PRESENT | STATE.ALIVE;

const CFG: R2Config = {
  endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'b',
  accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'SECRETEXAMPLE', publicUrl: 'https://pub.example',
};

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_hospital03_sewers',
    startedUnix: 1789000000, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: [...IDS], infectedMask: 0xf0, sidesKnown: true, losKnown: false,
    ...over,
  };
}

/** Survivor in slot 0 walking along x, a hunter in slot 4, ten frames a second for 3 s. */
function roundBytes(h: Partial<ReplayHeader> = {}): Buffer {
  const frames: Frame[] = [];
  for (let t = 0; t <= 3000; t += 100) {
    frames.push({
      tMs: t, offset: 0, entities: [],
      players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
        slot, x: slot === 0 ? t / 10 : 0, y: 0, z: 0, yaw: 0, pitch: 0,
        state: slot === 0 || slot === 4 ? LIVE : 0,
        health: slot === 0 ? 80 : 250, temp: 0, cls: slot === 0 ? 1 : 3,
        weapon: slot === 0 ? 5 : 0, clip: 50, reserve: 360,
      })),
    });
  }
  return Buffer.concat([encodeHeader(header(h)), ...frames.map(encodeFrame)]);
}

let dir: string;
let db: DB;
let app: FastifyInstance;
let me: Record<string, string>;

async function makeApp(r2?: { store: Map<string, Buffer>; fail?: boolean }): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(cookie, { secret: 'x'.repeat(32) });
  const r2Get = async (_cfg: unknown, key: string, from: number) => {
    if (r2?.fail) throw new Error('R2 down');
    const b = r2?.store.get(key);
    return b ? { body: b.subarray(from), total: b.length } : null;
  };
  await a.register(practiceRoutes, { db, replayDir: dir, r2: r2 ? CFG : null, r2Get: r2Get as never });
  await a.ready();
  return a;
}

/** A finished match with its roster, a round row and (optionally) the round's file on disk. */
function seedMatch(state = 'completed', file: Buffer | null = roundBytes()): number {
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, token) VALUES (1, ?, 'no_mercy', ?)",
  ).run(state, TOKEN).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(id, p, i < 4 ? 'a' : 'b'));
  if (file) {
    const name = `pug_${TOKEN}_0_1.rpl`;
    writeFileSync(join(dir, name), file);
    db.prepare(
      'INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (?, 0, 1, ?, ?, 31, 10)',
    ).run(id, name, file.length);
  }
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'practice-'));
  db = openDb(':memory:');
  IDS.forEach((id, i) => upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []));
  app = await makeApp();
  me = authedCookie(app, db, ME);
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** `null` for signed out: undefined would fall through to the default. */
const create = (payload: unknown, cookies: Record<string, string> | null = me, a = app) =>
  a.inject({ method: 'POST', url: '/api/practice/drills', payload: payload as object, cookies: cookies ?? undefined });
const fetchSpec = (code: string, a = app) => a.inject({ method: 'GET', url: `/api/practice/drills/${code}` });

describe('POST /api/practice/drills', () => {
  it('refuses anyone signed out, or not an active player', async () => {
    const id = seedMatch();
    expect((await create({ matchId: id, ordinal: 0, half: 1, tMs: 1000 }, null)).statusCode).toBe(401);
    const invited = authedCookie(app, db, '76561199000000051', { active: false });
    expect((await create({ matchId: id, ordinal: 0, half: 1, tMs: 1000 }, invited)).statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM practice_drills').get()).toEqual({ n: 0 });
  });

  it('turns a moment of a completed match into a drill with a code', async () => {
    const id = seedMatch();
    const res = await create({ matchId: id, ordinal: 0, half: 1, tMs: 1250.7 });
    expect(res.statusCode).toBe(200);
    const { code, spec } = res.json();
    expect(code).toMatch(/^[A-Z2-9]{4}$/);
    expect(spec).toMatchObject({
      code, version: 1, map: 'l4d_vs_hospital03_sewers',
      title: `Match ${id}, No Mercy 3, round 1 at 0:01`,
      source: { matchId: id, ordinal: 0, half: 1, tMs: 1200 },
    });
    expect(spec.actors).toEqual([
      expect.objectContaining({ side: 'survivor', cls: 'zoey', name: 'player0', x: 120, vx: 100, weapon: 'rifle', health: 80 }),
      expect.objectContaining({ side: 'infected', cls: 'hunter', name: 'player4' }),
    ]);
    expect(db.prepare('SELECT created_by, match_id, ordinal, half, t_ms FROM practice_drills').get())
      .toEqual({ created_by: ME, match_id: id, ordinal: 0, half: 1, t_ms: 1300 });
  });

  it('accepts an aborted match', async () => {
    const id = seedMatch('aborted');
    expect((await create({ matchId: id, ordinal: 0, half: 1, tMs: 0 })).statusCode).toBe(200);
  });

  it('refuses a match that is not finished, with a reason', async () => {
    for (const state of ['live', 'configuring']) {
      const id = seedMatch(state);
      const res = await create({ matchId: id, ordinal: 0, half: 1, tMs: 1000 });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/finished matches/);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM practice_drills').get()).toEqual({ n: 0 });
  });

  it('404s an unknown match and a round with no replay', async () => {
    expect((await create({ matchId: 999, ordinal: 0, half: 1, tMs: 0 })).statusCode).toBe(404);
    const id = seedMatch('completed', null);
    const res = await create({ matchId: id, ordinal: 0, half: 1, tMs: 0 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/no replay/);
  });

  it('400s a malformed body', async () => {
    const id = seedMatch();
    for (const bad of [
      {}, { matchId: id, ordinal: 0, half: 3, tMs: 0 }, { matchId: id, ordinal: -1, half: 1, tMs: 0 },
      { matchId: String(id), ordinal: 0, half: 1, tMs: 0 }, { matchId: id, ordinal: 0, half: 1, tMs: -5 },
      { matchId: id, ordinal: 0, half: 1, tMs: 'soon' },
    ]) {
      expect((await create(bad)).statusCode).toBe(400);
    }
  });

  it('answers the same moment with the same code', async () => {
    const id = seedMatch();
    const a = (await create({ matchId: id, ordinal: 0, half: 1, tMs: 2010 })).json();
    const b = (await create({ matchId: id, ordinal: 0, half: 1, tMs: 2040 })).json();
    expect(b.code).toBe(a.code);
    expect(b.spec).toEqual(a.spec);
    expect(db.prepare('SELECT COUNT(*) AS n FROM practice_drills').get()).toEqual({ n: 1 });
  });

  it('limits new drills an hour, but a moment that already has one is free', async () => {
    const id = seedMatch();
    const first = (await create({ matchId: id, ordinal: 0, half: 1, tMs: 0 })).json();
    const ins = db.prepare(
      "INSERT INTO practice_drills (code, spec_json, created_by, match_id, ordinal, half, t_ms) VALUES (?, '{}', ?, ?, 0, 2, ?)",
    );
    for (let i = 1; i < DRILLS_PER_HOUR; i++) ins.run(`ZZ${CODE_ALPHABET[i]}${CODE_ALPHABET[i]}`, ME, id, i * 100);
    const res = await create({ matchId: id, ordinal: 0, half: 1, tMs: 2500 });
    expect(res.statusCode).toBe(429);
    expect((await create({ matchId: id, ordinal: 0, half: 1, tMs: 0 })).json().code).toBe(first.code);
    // An hour-old drill no longer counts.
    db.prepare("UPDATE practice_drills SET created_at = datetime('now', '-2 hours')").run();
    expect((await create({ matchId: id, ordinal: 0, half: 1, tMs: 2500 })).statusCode).toBe(200);
  });

  it('stamps sides from the database for a file that never recorded them', async () => {
    // Version 1 file, no mask: slot order would make slot 4 the infected. The
    // round row says team b survived, so slots 4-7 are survivors and slot 0
    // (cls 1, a smoker on that side) is infected.
    const id = seedMatch('completed', roundBytes({ version: 1, sidesKnown: false, infectedMask: 0 }));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (?, 0, 1, 'b')").run(id);
    const { spec } = (await create({ matchId: id, ordinal: 0, half: 1, tMs: 1000 })).json();
    expect(spec.actors.map((a: { name: string; side: string }) => [a.name, a.side])).toEqual([
      ['player4', 'survivor'], ['player0', 'infected'],
    ]);
  });

  it('reads the round from R2 when no local copy is left', async () => {
    const store = new Map([[`replays/1/0_1.rpl`, roundBytes()]]);
    const a = await makeApp({ store });
    const id = seedMatch('completed', null);
    db.prepare(
      "INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz, r2_key) VALUES (?, 0, 1, ?, 1, 31, 10, 'replays/1/0_1.rpl')",
    ).run(id, `pug_${TOKEN}_0_1.rpl`);
    const res = await create({ matchId: id, ordinal: 0, half: 1, tMs: 500 }, authedCookie(a, db, ME), a);
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.actors).toHaveLength(2);
    await a.close();
  });

  it('404s when R2 fails', async () => {
    const a = await makeApp({ store: new Map(), fail: true });
    const id = seedMatch('completed', null);
    db.prepare(
      "INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz, r2_key) VALUES (?, 0, 1, ?, 1, 31, 10, 'k')",
    ).run(id, `pug_${TOKEN}_0_1.rpl`);
    expect((await create({ matchId: id, ordinal: 0, half: 1, tMs: 0 }, authedCookie(a, db, ME), a)).statusCode).toBe(404);
    await a.close();
  });
});

describe('GET /api/practice/drills/:code', () => {
  it('serves exactly the stored spec, by any case, and counts the fetch', async () => {
    const id = seedMatch();
    const { code, spec } = (await create({ matchId: id, ordinal: 0, half: 1, tMs: 1000 })).json();
    const res = await fetchSpec(code.toLowerCase());
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual(spec);
    // The DESIGN.md shape and nothing wrapped around it.
    expect(Object.keys(res.json())).toEqual(['code', 'version', 'map', 'title', 'source', 'actors', 'entities']);
    await fetchSpec(code);
    expect(db.prepare('SELECT fetch_count FROM practice_drills').get()).toEqual({ fetch_count: 2 });
  });

  it('needs no session', async () => {
    const id = seedMatch();
    const { code } = (await create({ matchId: id, ordinal: 0, half: 1, tMs: 1000 })).json();
    expect((await app.inject({ method: 'GET', url: `/api/practice/drills/${code}` })).statusCode).toBe(200);
  });

  it('404s an unknown or malformed code', async () => {
    for (const code of ['ZZZZ', 'K0QX', 'x', 'ABCDEFG']) {
      const res = await fetchSpec(code);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'no such drill' });
    }
  });
});

describe('chapterFromName', () => {
  it('reads the chapter out of each naming scheme', () => {
    expect(chapterFromName('l4d_vs_hospital03_sewers')).toBe(3);
    expect(chapterFromName('c1m2_streets')).toBe(2);
    expect(chapterFromName('l4d_vs_city17_04')).toBe(4);
    expect(chapterFromName('deadbeforedawn')).toBeNull();
  });
});
