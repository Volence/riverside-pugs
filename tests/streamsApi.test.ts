import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { stubOrchestrator } from './helpers.js';
import { OFFLINE_CAP } from '../src/streamsView.js';

const P1 = '76561198000000001';
let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    serverExec: async () => {},
  });
});
afterEach(async () => { await app.close(); });

function linkedAndLive(steamid: string, twitchId: string, login: string, live: boolean) {
  db.prepare('UPDATE players SET twitch_id = ?, twitch_name = ? WHERE steamid = ?')
    .run(twitchId, login, steamid);
  const nowIso = new Date().toISOString();
  // The poll heartbeat, which is what staleness is measured from. Without it
  // the view correctly refuses to call anybody live.
  db.prepare("INSERT INTO settings (key, value) VALUES ('twitch_polled_at', ?) "
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(nowIso);
  db.prepare(
    `INSERT INTO twitch_status (player_id, is_live, viewers, checked_at, last_live_at)
     VALUES (?,?,?,?,?)`,
  ).run(steamid, live ? 1 : 0, 18, nowIso, nowIso);
}

describe('GET /api/streams', () => {
  it('is public and empty before anyone links', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/streams' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stale: true, inPug: [], live: [], offline: [], offlineTotal: 0 });
  });

  it('needs no session', async () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    linkedAndLive(P1, '11', 'alicetv', true);
    const res = await app.inject({ method: 'GET', url: '/api/streams' });
    expect(res.statusCode).toBe(200);
    expect(res.json().live[0].twitchName).toBe('alicetv');
  });

  it('never leaks the twitch id', async () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    linkedAndLive(P1, '123456789', 'alicetv', true);
    const res = await app.inject({ method: 'GET', url: '/api/streams' });
    expect(JSON.stringify(res.json())).not.toContain('123456789');
  });

  it('caps the offline tier unless all=1 is asked for', async () => {
    for (let i = 0; i < OFFLINE_CAP + 3; i += 1) {
      const id = `7656119800000${String(1000 + i)}`;
      upsertPlayer(db, { steamid: id, name: `p${i}`, avatar: null }, []);
      linkedAndLive(id, `t${i}`, `l${i}`, false);
    }
    const capped = (await app.inject({ method: 'GET', url: '/api/streams' })).json();
    expect(capped.offline.length).toBe(OFFLINE_CAP);
    expect(capped.offlineTotal).toBe(OFFLINE_CAP + 3);

    const all = (await app.inject({ method: 'GET', url: '/api/streams?all=1' })).json();
    expect(all.offline.length).toBe(OFFLINE_CAP + 3);
  });

  it('treats any all value other than 1 as capped', async () => {
    for (let i = 0; i < OFFLINE_CAP + 3; i += 1) {
      const id = `7656119800000${String(1000 + i)}`;
      upsertPlayer(db, { steamid: id, name: `p${i}`, avatar: null }, []);
      linkedAndLive(id, `t${i}`, `l${i}`, false);
    }
    const res = (await app.inject({ method: 'GET', url: '/api/streams?all=yes' })).json();
    expect(res.offline.length).toBe(OFFLINE_CAP);
  });
});
