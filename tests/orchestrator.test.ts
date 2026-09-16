import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import { openDb, type DB } from '../src/db.js';
import { RealOrchestrator } from '../src/orchestrator.js';
import { ServerReleaser } from '../src/serverRelease.js';
import { addServer, getServer } from '../src/serverPool.js';
import { LogListener } from '../src/logListener.js';
import { currentSeasonId } from '../src/players.js';
import {
  decodePackets, encodePacket, SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from '../src/rconPacket.js';
import { pugReply } from './helpers.js';

function fakeServer(dumpBody: string): Promise<{ port: number; cmds: string[]; close: () => Promise<void> }> {
  const cmds: string[] = [];
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk as Buffer]);
        const { packets, rest } = decodePackets(buf);
        buf = rest;
        for (const p of packets) {
          if (p.type === SERVERDATA_AUTH) {
            sock.write(encodePacket(0, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(p.id, SERVERDATA_AUTH_RESPONSE, ''));
          } else if (p.type === SERVERDATA_EXECCOMMAND) {
            cmds.push(p.body);
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, pugReply(p.body, dumpBody)));
          } else if (p.type === SERVERDATA_RESPONSE_VALUE) {
            // The client's multi-packet terminator. Source answers it with an
            // empty packet and then four junk bytes, both under the marker id.
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, '\u0000\u0001\u0000\u0000'));
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        cmds,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

function seedMatch(db: DB): number {
  const season = currentSeasonId(db);
  for (const id of IDS) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(id, `p${id.slice(-1)}`);
  const mid = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', 'no_mercy')")
      .run(season).lastInsertRowid,
  );
  IDS.forEach((id, i) => db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)')
    .run(mid, id, i < 4 ? 'a' : 'b'));
  return mid;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('RealOrchestrator', () => {
  it('setupMatch reserves a server, configures it over RCON, marks match live', async () => {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());

    const releaser = new ServerReleaser(db, async () => {});
    const orch = new RealOrchestrator({
      db, listener,
      logPublicAddress: '127.0.0.1:27500',
      releaser,
      makeRcon: (o) => o,
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);

    expect(getServer(db, serverId)!.status).toBe('live');
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(mid) as any;
    expect(m.state).toBe('live');
    expect(m.server_id).toBe(serverId);
    expect(m.token).toMatch(/^[0-9a-f]{32}$/);

    expect(srv.cmds.some((c) => c.startsWith('logaddress_add 127.0.0.1:27500'))).toBe(true);
    expect(srv.cmds.filter((c) => c.startsWith('sm_pug_roster'))).toHaveLength(8);
    expect(srv.cmds.some((c) => c.startsWith(`sm_pug_match ${mid} ${m.token} no_mercy`))).toBe(true);
    expect(srv.cmds.some((c) => c.startsWith('changelevel'))).toBe(true);
  });

  it('setupMatch aborts the match when no server is free', async () => {
    const orch = new RealOrchestrator({
      db, listener: new LogListener(() => {}),
      logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o,
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('aborted');
  });

  it('finishMatch pulls the dump, persists scores/stats, resets server, completes match', async () => {
    const mid = 1;
    const dump = [
      `DUMP match=${mid}`,
      'MAP map=l4d_hospital01 a=245 b=310',
      ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} sidmg=${100 + i} sikill=${i} ck=${i * 10} ff=${i} rev=${i}`),
      'END winner=b a=245 b=310',
    ].join('\n');
    const srv = await fakeServer(dump);
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({ db, listener, logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o });

    const realMid = seedMatch(db);
    expect(realMid).toBe(mid);
    await orch.setupMatch(realMid);
    await orch.finishMatch(realMid);

    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(realMid) as any;
    expect(m.state).toBe('completed');
    expect(m.winner).toBe('b');
    expect(m.team_a_score).toBe(245);
    expect(m.team_b_score).toBe(310);
    expect(getServer(db, serverId)!.status).toBe('idle');
    const mp = db.prepare('SELECT * FROM match_players WHERE match_id = ? AND player_id = ?').get(realMid, IDS[0]) as any;
    expect(mp.si_damage).toBe(100);
    expect(JSON.parse(mp.stats_json).sidmg).toBe('100');
  });

  it('finishMatch still releases the server and completes the match when sm_pug_abort fails', async () => {
    const mid = 1;
    const dump = [
      `DUMP match=${mid}`,
      'MAP map=l4d_hospital01 a=245 b=310',
      ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} sidmg=${100 + i} sikill=${i} ck=${i * 10} ff=${i} rev=${i}`),
      'END winner=b a=245 b=310',
    ].join('\n');

    const cmds: string[] = [];
    const srv = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const server = net.createServer((sock) => {
        let buf: Buffer = Buffer.alloc(0);
        sock.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk as Buffer]);
          const { packets, rest } = decodePackets(buf);
          buf = rest;
          for (const p of packets) {
            if (p.type === SERVERDATA_AUTH) {
              sock.write(encodePacket(0, SERVERDATA_RESPONSE_VALUE, ''));
              sock.write(encodePacket(p.id, SERVERDATA_AUTH_RESPONSE, ''));
            } else if (p.type === SERVERDATA_EXECCOMMAND) {
              cmds.push(p.body);
              if (p.body.startsWith('sm_pug_abort')) {
                sock.destroy();
              } else {
                sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, pugReply(p.body, dump)));
              }
            } else if (p.type === SERVERDATA_RESPONSE_VALUE) {
              sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
              sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, '\u0000\u0001\u0000\u0000'));
            }
          }
        });
      });
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as net.AddressInfo).port,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500',
      releaser: new ServerReleaser(db, async () => {}),
      // sm_pug_abort never gets a response once the fake server destroys the socket;
      // use a short rcon exec timeout so the test doesn't wait out the default 5s.
      makeRcon: (o) => ({ ...o, timeoutMs: 300 }),
    });

    const realMid = seedMatch(db);
    expect(realMid).toBe(mid);
    await orch.setupMatch(realMid);
    await orch.finishMatch(realMid);

    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(realMid) as any;
    expect(m.state).toBe('completed');
    expect(getServer(db, serverId)!.status).toBe('idle');
  });

  it('finishMatch is a no-op when called again after the match already completed', async () => {
    const mid = 1;
    const dump = [
      `DUMP match=${mid}`,
      'MAP map=l4d_hospital01 a=245 b=310',
      ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} sidmg=${100 + i} sikill=${i} ck=${i * 10} ff=${i} rev=${i}`),
      'END winner=b a=245 b=310',
    ].join('\n');
    const srv = await fakeServer(dump);
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({ db, listener, logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o });

    const realMid = seedMatch(db);
    expect(realMid).toBe(mid);
    await orch.setupMatch(realMid);
    await orch.finishMatch(realMid);

    const before = db.prepare('SELECT * FROM matches WHERE id = ?').get(realMid) as any;
    expect(before.state).toBe('completed');
    expect(getServer(db, serverId)!.status).toBe('idle');

    await expect(orch.finishMatch(realMid)).resolves.not.toThrow();

    const after = db.prepare('SELECT * FROM matches WHERE id = ?').get(realMid) as any;
    expect(after.state).toBe('completed');
    expect(after.ended_at).toBe(before.ended_at);
    expect(getServer(db, serverId)!.status).toBe('idle');
  });
});
