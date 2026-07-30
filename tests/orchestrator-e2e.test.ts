import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import dgram from 'node:dgram';
import { openDb, type DB } from '../src/db.js';
import { RealOrchestrator } from '../src/orchestrator.js';
import { LogListener } from '../src/logListener.js';
import { addServer } from '../src/serverPool.js';
import { currentSeasonId } from '../src/players.js';
import {
  decodePackets, encodePacket, SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from '../src/rconPacket.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

function fakeServer(dumpFor: (mid: string) => string) {
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    const server = net.createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk as Buffer]);
        const { packets, rest } = decodePackets(buf); buf = rest;
        for (const p of packets) {
          if (p.type === SERVERDATA_AUTH) {
            sock.write(encodePacket(0, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(p.id, SERVERDATA_AUTH_RESPONSE, ''));
          } else if (p.type === SERVERDATA_EXECCOMMAND) {
            const m = p.body.match(/^sm_pug_dump \S+/);
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, m ? dumpFor(p.body) : 'ok'));
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

function seedMatch(db: DB): number {
  const season = currentSeasonId(db);
  for (const id of IDS) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(id, `p${id.slice(-1)}`);
  const mid = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', 'no_mercy')").run(season).lastInsertRowid);
  IDS.forEach((id, i) => db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(mid, id, i < 4 ? 'a' : 'b'));
  return mid;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });
let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('orchestrator end-to-end (fake server + real UDP)', () => {
  it('a MATCH_END datagram drives finishMatch to completion', async () => {
    const dumpFor = (cmd: string) => {
      const token = cmd.split(/\s+/)[1];
      const mid = (db.prepare('SELECT id FROM matches WHERE token = ?').get(token) as any).id;
      return [
        `DUMP match=${mid}`,
        'MAP map=l4d_hospital01 a=100 b=200',
        ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} sidmg=1 sikill=1 ck=1 ff=1 rev=1`),
        'END winner=b a=100 b=200',
      ].join('\n');
    };
    const srv = await fakeServer(dumpFor);
    cleanup.push(srv.close);
    addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });

    let onMatchEnd: (token: string) => void = () => {};
    const listener = new LogListener((ev) => { if (ev.kind === 'match_end') onMatchEnd(ev.token); });
    const port = await listener.listen(0);
    cleanup.push(() => listener.close());

    const orch = new RealOrchestrator({ db, listener, logPublicAddress: `127.0.0.1:${port}`, makeRcon: (o) => o });
    onMatchEnd = (token) => {
      const mid = (db.prepare('SELECT id FROM matches WHERE token = ?').get(token) as any).id;
      void orch.finishMatch(mid);
    };

    const mid = seedMatch(db);
    await orch.setupMatch(mid);
    const token = (db.prepare('SELECT token FROM matches WHERE id = ?').get(mid) as any).token;

    const c = dgram.createSocket('udp4');
    const body = `L 07/30/2026 - 14:23:01: PUG ${token} MATCH_END a=100 b=200 winner=b\n`;
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(body)]);
    await new Promise<void>((r) => c.send(pkt, port, '127.0.0.1', () => { c.close(); r(); }));

    await new Promise((r) => setTimeout(r, 150));

    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(mid) as any;
    expect(m.state).toBe('completed');
    expect(m.winner).toBe('b');
  });
});
