import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, ensureRating } from '../src/players.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { recordSiKill } from '../src/aimRules.js';

const P = '76561198129925325';
const ALT = '76561199861598482';
let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, ALT]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []);
  for (const id of [P, ALT]) ensureRating(db, id);
});

describe('recordSiKill', () => {
  it('stores the kill as the spec\'s columns', () => {
    const id = recordSiKill(db, {
      matchId: 722, serverId: 1, steamid: P, weapon: 'smg', headshot: true, dist: 612, pre: 143.5, back: -1, victimClass: 'hunter',
    }, new Date('2026-10-17T21:04:13.000Z'));
    expect(db.prepare('SELECT * FROM si_kills WHERE id = ?').get(id)).toEqual({
      id, match_id: 722, server_id: 1, steamid: P, weapon: 'smg', headshot: 1, dist: 612,
      pre: 143.5, back: -1, victim_class: 'hunter', at: '2026-10-17T21:04:13.000Z',
    });
  });

  it('moves with a merged alt', () => {
    recordSiKill(db, { matchId: 722, serverId: 1, steamid: ALT, weapon: 'smg', headshot: false, dist: 300, pre: 5, back: 2, victimClass: 'smoker' });
    mergePlayers(db, { from: ALT, into: P });
    expect(db.prepare('SELECT steamid FROM si_kills').all()).toEqual([{ steamid: P }]);
  });
});

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
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 10/17/2026 - 21:04:13: ${body}\n`, 'utf8')]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}
const settle = () => new Promise((r) => setTimeout(r, 80));
const LINE = `L4DM id=${P} k=sikill w=smg hs=1 dist=612 pre=143.5 back=12.0 cls=hunter v=3`;

describe('sikill over the wire', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it('stores a kill by a survivor rostered in a live match on that server', async () => {
    const port = await freeUdpPort();
    const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id) VALUES (722, 1, 'live', 'farm', ?)").run(sid);
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (722, ?, 'a')").run(P);
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, LINE);
    await settle();
    expect(db.prepare(
      'SELECT match_id AS matchId, server_id AS serverId, weapon, headshot, dist, pre, back, victim_class AS victimClass FROM si_kills',
    ).all()).toEqual([{ matchId: 722, serverId: sid, weapon: 'smg', headshot: 1, dist: 612, pre: 143.5, back: 12, victimClass: 'hunter' }]);
  });

  // Review Focus 1: warmup, a spectator box, a practice lease. Not evidence
  // about a ranked game, and it must never reach a pool.
  it('drops a kill by anyone not rostered in a live match', async () => {
    const port = await freeUdpPort();
    addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, LINE);
    await settle();
    expect(db.prepare('SELECT COUNT(*) AS n FROM si_kills').get()).toEqual({ n: 0 });
  });
});
