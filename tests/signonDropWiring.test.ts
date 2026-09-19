import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const ID64 = '76561198030413993';
const DROP = `L4DC SIGNON_DROP steamid=STEAM_1:1:35074132 secs=14 forced=651 name=volence`;
const ENTERED = '"volence<61><STEAM_1:1:35074132><>" entered the game';

/** buildServer does not hand back the port its listener bound, so pick a free
 *  one first. The gap between closing this socket and the listener binding the
 *  same port is a race only against other processes on the machine. */
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
    const text = Buffer.from(`L 09/19/2026 - 14:23:01: ${body}\n`, 'utf8');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 80));
const rows = (db: DB) => db.prepare('SELECT steamid, name, secs_connected, forced_count, entered_after_at FROM signon_drops').all();

let db: DB;
let app: FastifyInstance | null = null;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(async () => { await app?.close(); app = null; });

describe('signon drops, from the UDP socket to the table', () => {
  it('stores a drop sent from the game server\'s address, and stamps it on entry', async () => {
    const port = await freeUdpPort();
    // devMode:false is what builds the real listener. The default
    // LOG_PUBLIC_ADDRESS is 127.0.0.1:27500, and its host half is an allowed
    // source, which is exactly the one-box production shape.
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });

    await send(port, DROP);
    await settle();
    expect(rows(db)).toEqual([
      { steamid: ID64, name: 'volence', secs_connected: 14, forced_count: 651, entered_after_at: null },
    ]);

    await send(port, ENTERED);
    await settle();
    expect((rows(db)[0] as { entered_after_at: string | null }).entered_after_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('stores nothing when the sender is not a known game server', async () => {
    const port = await freeUdpPort();
    // The feed host is somewhere else and there is no servers row, so
    // 127.0.0.1 (where this test sends from) is nobody.
    app = await buildServer({
      config: { ...loadConfig({}), devMode: false, logListenPort: port, logPublicAddress: '203.0.113.9:27500' },
      db,
    });

    await send(port, DROP);
    await settle();
    expect(rows(db)).toEqual([]);
  });
});
