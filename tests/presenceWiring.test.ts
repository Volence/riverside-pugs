import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { Hub } from '../src/ws.js';
import { getPresence } from '../src/presence.js';

const P1 = '76561198000000001';
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
    const text = Buffer.from(`L 09/21/2026 - 20:00:00: ${body}\n`, 'utf8');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 80));

let db: DB;
let app: FastifyInstance | null = null;
let heard: string[];
let port: number;

beforeEach(async () => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
  // Before buildServer: the listener re-registers the tokens of matches that
  // are already live when it starts.
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (7, 1, 'live', 'dead_air', ?)").run(TOKEN);
  db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (7, ?, 'a')").run(P1);
  heard = [];
  const hub = new Hub();
  hub.subscribe((e) => heard.push(e));
  port = await freeUdpPort();
  app = await buildServer({
    config: { ...loadConfig({}), devMode: false, logListenPort: port }, db, hub,
    serverExec: async () => {}, serverCleaner: async () => {},
  });
});
afterEach(async () => { await app?.close(); app = null; });

describe('presence, from the UDP socket to the table', () => {
  it('a LEAVE drops the player and tells every open board', async () => {
    await send(port, `PUG ${TOKEN} LEAVE steamid=${P1} remaining=300`);
    await settle();
    expect(getPresence(db, 7, P1)).toMatchObject({ state: 'dropped', remaining_s: 300, held: 0 });
    expect(heard).toContain('refresh');
  });

  it('a held LEAVE and then a RETURN', async () => {
    await send(port, `PUG ${TOKEN} LEAVE steamid=${P1} remaining=200 held=1 hold_left=1800 auto=0`);
    await settle();
    expect(getPresence(db, 7, P1)).toMatchObject({ state: 'dropped', held: 1 });
    await send(port, `PUG ${TOKEN} RETURN steamid=${P1} remaining=200`);
    await settle();
    expect(getPresence(db, 7, P1)).toMatchObject({ state: 'connected', remaining_s: 200, held: 0 });
  });

  it('a first connect makes them present and still stamps connected_at', async () => {
    await send(port, `PUG ${TOKEN} PLAYER steamid=${P1} event=connect`);
    await settle();
    expect(getPresence(db, 7, P1)).toMatchObject({ state: 'connected' });
    expect((db.prepare('SELECT connected_at FROM match_players WHERE match_id = 7').get() as { connected_at: string | null }).connected_at).not.toBeNull();
    expect(heard).toContain('refresh');
  });
});
