import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { NO_TANK_HOLD_MS } from '../src/noTankWatch.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const MAP = 'l4d_vs_smalltown04_mainstreet';

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
    const text = Buffer.from(`L 10/13/2026 - 03:56:00: ${body}\n`, 'utf8');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 80));
const hud = (prog: number, tank: number) => `PUG ${TOKEN} LIVEHUD prog=${prog} tank=${tank} witch=65 p=`;

let db: DB;
let app: FastifyInstance | null = null;
let port: number;
let problems: Extract<AdminEvent, { kind: 'problem' }>[];
let unsubscribe: () => void;

beforeEach(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (673, 1, 'live', 'death_toll', ?)").run(TOKEN);
  problems = [];
  unsubscribe = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e); });
  port = await freeUdpPort();
  app = await buildServer({
    config: { ...loadConfig({}), devMode: false, logListenPort: port }, db,
    serverExec: async () => {}, serverCleaner: async () => {},
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  unsubscribe();
  await app?.close();
  app = null;
});

/** Shifts Date.now() forward by `ms` from here on, leaving timers alone. */
function jump(ms: number): void {
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => real() + ms);
}

describe('no tank alert, from the UDP socket to the admin feed', () => {
  it('posts once when survivors stay well past the tank with no tank_spawn', async () => {
    await send(port, `PUG ${TOKEN} ROUND_START map=${MAP} half=1 surv=a`);
    await send(port, hud(36, 30));
    await settle();
    jump(NO_TANK_HOLD_MS + 1000);
    await send(port, hud(43, 30));
    await send(port, hud(44, 30));
    await settle();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ matchId: 673, link: { label: 'Live board', path: '/admin/live?live=673' } });
    expect(problems[0]!.text).toContain(`Match 673: no tank on ${MAP} half 1. Survivors are at 43% and the tank was set for 30%.`);
  });

  it('stays quiet when the tank spawned', async () => {
    await send(port, `PUG ${TOKEN} ROUND_START map=${MAP} half=1 surv=a`);
    await send(port, hud(30, 30));
    await send(port, `PUG ${TOKEN} EVENT seq=491 kind=tank_spawn actor=76561199034101183 target=0 value=0 half=1 t=60450`);
    await send(port, hud(36, 30));
    await settle();
    jump(NO_TANK_HOLD_MS + 1000);
    await send(port, hud(43, 30));
    await settle();
    expect(problems).toHaveLength(0);
  });
});
