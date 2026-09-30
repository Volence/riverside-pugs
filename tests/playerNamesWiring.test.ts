import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { upsertPlayer } from '../src/players.js';
import { completeMatch } from '../src/matchResult.js';
import { nameHistory } from '../src/playerNames.js';

// The PUGNAME line from pug-match, through the real listener, to a counted
// name once the match completes.
const P = '76561199014394259';

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
beforeEach(() => { db = openDb(':memory:'); upsertPlayer(db, { steamid: P, name: 'v', avatar: 'a.jpg' }, []); });
afterEach(async () => { await app?.close(); app = null; });

describe('name history wiring', () => {
  it('counts an in-game rename during a live match, and the persona, when it completes', async () => {
    const port = await freeUdpPort();
    const serverId = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const matchId = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token, went_live_at) VALUES (1, 'live', 'dead_air', ?, ?, datetime('now'))",
    ).run(serverId, 'a'.repeat(32)).lastInsertRowid);
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(matchId, P);
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, `PUGNAME steamid=${P} event=connect name=amour plastique`);
    await send(port, `PUGNAME steamid=${P} event=change name=(S)amour plastique`);
    await settle();
    expect(nameHistory(db, P)).toEqual([]);
    completeMatch(db, matchId, { matchId, totalA: 1, totalB: 0, winner: 'a', maps: [], players: [], skills: [], skillDetect: false });
    expect(nameHistory(db, P).map((r) => [r.name, r.matches, r.sources]).sort()).toEqual([
      ['amour plastique', 1, ['ingame']], ['v', 1, ['steam']],
    ]);
  });
});
