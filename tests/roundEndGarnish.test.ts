import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';

// The win chance's half-end storage is garnish on the round_end line: when it
// throws, the replay indexing after it must still run.
vi.mock('../src/winLive/liveState.js', async (orig) => ({
  ...(await orig<typeof import('../src/winLive/liveState.js')>()),
  writeProgressSamples: () => { throw new Error('boom'); },
}));
const recorded = vi.fn();
vi.mock('../src/replays.js', async (orig) => ({
  ...(await orig<typeof import('../src/replays.js')>()),
  recordMatchReplays: (...a: unknown[]) => { recorded(...a); return 0; },
}));

const TOKEN = 'abcdef0123456789abcdef0123456789';

function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
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

let db: DB;
let app: FastifyInstance | null = null;
beforeEach(() => { db = openDb(':memory:'); recorded.mockClear(); });
afterEach(async () => { await app?.close(); app = null; vi.restoreAllMocks(); });

describe('round_end with the win chance storage failing', () => {
  it('still indexes the replays', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'x', ?)").run(TOKEN);
    const { buildServer } = await import('../src/server.js');
    const port = await freeUdpPort();
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, `PUG ${TOKEN} ROUND_END map=l4d_hospital01_apartment half=1 surv=a score=100 alive=3`);
    await new Promise((r) => setTimeout(r, 150));
    expect(err.mock.calls.some((c) => String(c[0]).includes('storing progress samples failed'))).toBe(true);
    expect(recorded).toHaveBeenCalled();
  });
});
