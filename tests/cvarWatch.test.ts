import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { upsertPlayer } from '../src/players.js';
import { playerTimeline } from '../src/admin/playerTimeline.js';
import { isEvidence } from '../src/admin/timeline/types.js';

const P = '76561198030413993';

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
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 09/22/2026 - 14:23:01: ${body}\n`, 'utf8')]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}
const settle = () => new Promise((r) => setTimeout(r, 80));

let db: DB;
let app: FastifyInstance | null = null;
beforeEach(() => { db = openDb(':memory:'); upsertPlayer(db, { steamid: P, name: 'nehoc', avatar: null }, []); });
afterEach(async () => { await app?.close(); app = null; });

describe('cpu_level from l4d_cvarwatch', () => {
  it('lands on the player\'s file as evidence, once however often it is repeated', async () => {
    const port = await freeUdpPort();
    addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, `L4DV id=${P} cvar=cpu_level value=0`);
    await send(port, `L4DV id=${P} cvar=cpu_level value=0.000000`);
    await settle();
    expect(db.prepare("SELECT source, kind, detail FROM integrity_flags").all())
      .toEqual([{ source: 'cvar', kind: 'cpu_level', detail: 'value=0' }]);
    const [item] = playerTimeline(db, P, '76561198000000001');
    expect(item).toMatchObject({ source: 'cvar', kind: 'cpu_level' });
    expect(item.summary).toMatch(/cpu_level 0: low effect detail/);
    expect(isEvidence(item)).toBe(true);
  });
});
