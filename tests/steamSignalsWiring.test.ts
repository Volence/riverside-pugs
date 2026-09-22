import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { banPlayer } from '../src/admin/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { getSteamSignals } from '../src/steamSignals.js';
import { fakeSteam } from './fakes/steamApi.js';
import { stubOrchestrator } from './helpers.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
const LENDER = '76561198000000099';
const TOKEN = '0123456789abcdef0123456789abcdef';

function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function send(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const text = Buffer.from(`L 09/21/2026 - 14:23:01: ${body}\n`, 'utf8');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 80));

let db: DB;
let app: FastifyInstance | null = null;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(async () => { await app?.close(); app = null; });

describe('steam signals at login', () => {
  const login = (a: FastifyInstance) => a.inject({ method: 'GET', url: '/auth/steam/return?openid.mode=id_res' });
  const build = (env: Record<string, string>, steamFetch: (url: string) => Promise<Response>) => buildServer({
    config: loadConfig(env), db, verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: 'http://a/1.jpg' }),
    orchestrator: stubOrchestrator(), serverExec: async () => {}, steamFetch,
  });

  it('stores the signals of whoever just signed in', async () => {
    const steam = fakeSteam({ [P1]: { timecreated: 1_200_000_000, level: 9 } });
    app = await build({ STEAM_API_KEY: 'key' }, steam.fetch);
    expect((await login(app)).statusCode).toBe(302);
    await settle();
    expect(getSteamSignals(db, P1)).toMatchObject({ time_created: 1_200_000_000, steam_level: 9 });
    // Nobody is in game at a login, so the sharing question is not asked.
    expect(steam.calls.some((u) => u.includes('IsPlayingSharedGame'))).toBe(false);
  });

  it('does not wait for Steam, and survives Steam failing', async () => {
    app = await build({ STEAM_API_KEY: 'key' }, () => new Promise<Response>(() => {}));
    expect((await login(app)).statusCode).toBe(302);
    await app.close();
    app = await build({ STEAM_API_KEY: 'key' }, async () => { throw new Error('steam is down'); });
    expect((await login(app)).statusCode).toBe(302);
    await settle();
    expect(getSteamSignals(db, P1)).toBeNull();
  });

  it('asks Steam nothing without an api key', async () => {
    let asked = false;
    app = await build({}, async () => { asked = true; throw new Error('must not fetch'); });
    expect((await login(app)).statusCode).toBe(302);
    await settle();
    expect(asked).toBe(false);
    expect(getSteamSignals(db, P1)).toBeNull();
  });
});

describe('steam signals when a match goes live', () => {
  let events: AdminEvent[];
  let off: () => void;
  beforeEach(() => {
    events = [];
    off = subscribeAdminEvents((e) => { if (e.kind === 'steam_signal') events.push(e); });
    for (const id of [P1, P2, LENDER]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: 'http://a/1.jpg' }, []);
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (7, 1, 'live', 'dead_air', ?)").run(TOKEN);
    for (const id of [P1, P2]) db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (7, ?, 'a')").run(id);
  });
  afterEach(() => off());

  const build = async (steamFetch: (url: string) => Promise<Response>, env: Record<string, string> = { STEAM_API_KEY: 'key' }) => {
    const port = await freeUdpPort();
    app = await buildServer({
      config: { ...loadConfig(env), devMode: false, logListenPort: port }, db, steamFetch,
      serverExec: async () => {}, serverCleaner: async () => {},
    });
    return port;
  };

  it('checks the whole roster, sharing included, and tells the admin feed once', async () => {
    banPlayer(db, LENDER, 'admin', 'cheating', null);
    const steam = fakeSteam({ [P1]: { bans: { game: 1, daysSince: 30 } }, [P2]: { lender: LENDER } });
    const port = await build(steam.fetch);

    await send(port, `PUG ${TOKEN} MATCH_START map=l4d_airport01_greenhouse`);
    await settle();

    expect(getSteamSignals(db, P1)).toMatchObject({ game_bans: 1 });
    expect(getSteamSignals(db, P2)).toMatchObject({ lender_id: LENDER });
    expect(steam.calls.filter((u) => u.includes('GetPlayerBans')).length).toBe(1);
    expect(events).toEqual([
      { kind: 'steam_signal', steamid: P1, matchId: 7, signal: { what: 'recent_ban', vacBans: 0, gameBans: 1, daysSinceLastBan: 30 } },
      { kind: 'steam_signal', steamid: P2, matchId: 7, signal: { what: 'banned_lender', lenderId: LENDER } },
    ]);
  });

  it('checks a player who connects to a live match, such as a late joiner', async () => {
    const steam = fakeSteam({ [P2]: { lender: LENDER } });
    const port = await build(steam.fetch);
    await send(port, `PUG ${TOKEN} PLAYER steamid=${P2} event=connect`);
    await settle();
    expect(getSteamSignals(db, P2)).toMatchObject({ lender_id: LENDER });
    expect(getSteamSignals(db, P1)).toBeNull();
  });

  it('checks a sub who is rostered into a match started in game', async () => {
    const sub = '76561198000000003';
    upsertPlayer(db, { steamid: sub, name: 'sub', avatar: 'http://a/1.jpg' }, []);
    db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(sub);
    const steam = fakeSteam({ [sub]: { lender: LENDER, level: 2 } });
    const port = await build(steam.fetch);
    await send(port, `PUG ${TOKEN} MATCH_ROSTER steamid=${sub} team=b joined_map=1 name=sub`);
    await settle();
    expect(getSteamSignals(db, sub)).toMatchObject({ lender_id: LENDER, steam_level: 2 });
  });

  it('asks Steam nothing without an api key, and the match carries on', async () => {
    let asked = false;
    const port = await build(async () => { asked = true; throw new Error('must not fetch'); }, {});
    await send(port, `PUG ${TOKEN} MATCH_START map=l4d_airport01_greenhouse`);
    await settle();
    expect(asked).toBe(false);
    expect(events).toEqual([]);
  });
});
