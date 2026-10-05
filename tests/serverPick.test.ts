import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { openDb, type DB } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer, claimableServers, claimIdle, moveServer, type ServerRow } from '../src/serverPool.js';
import { choosePing, pingChooser, pingTo, recordPing } from '../src/serverPick.js';
import { parseLogDatagram } from '../src/logParse.js';
import { setSetting } from '../src/settings.js';

const NOW = Date.parse('2026-10-05T20:00:00.000Z');
const ids = (n: number) => Array.from({ length: n }, (_, i) => `7656119800000000${i}`);

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const box = (name: string, host: string, port = 27015) =>
  addServer(db, { name, host, port, rconPort: port, rconPassword: 'x' });

describe('pick order', () => {
  it('claims in pick order, which starts as id order', () => {
    const a = box('dallas', 'h1');
    const b = box('riverside3', 'h2');
    expect(claimableServers(db).map((s) => s.id)).toEqual([a, b]);
    expect(claimIdle(db, NOW)?.id).toBe(a);
  });

  it('moving a server changes which one is claimed', () => {
    const a = box('dallas', 'h1');
    const b = box('riverside3', 'h2');
    const c = box('chicago5', 'h3');
    expect(moveServer(db, c, -1)).toBe(true);
    expect(moveServer(db, c, -1)).toBe(true);
    expect(claimableServers(db).map((s) => s.id)).toEqual([c, a, b]);
    expect(moveServer(db, c, -1)).toBe(false); // already first
    expect(moveServer(db, b, 1)).toBe(false); // already last
    expect(claimIdle(db, NOW)?.id).toBe(c);
  });

  it('a row with no pick order (inserted directly) sorts by id and survives a move', () => {
    const a = box('dallas', 'h1');
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('raw', 'h9', 1, 1, 'x', 'idle')").run();
    const raw = (db.prepare("SELECT id FROM servers WHERE name = 'raw'").get() as { id: number }).id;
    expect(claimableServers(db).map((s) => s.id)).toEqual([a, raw]);
    expect(moveServer(db, raw, -1)).toBe(true);
    expect(claimableServers(db).map((s) => s.id)).toEqual([raw, a]);
  });

  it('a new server goes to the end even after reordering', () => {
    const a = box('dallas', 'h1');
    const b = box('riverside3', 'h2');
    moveServer(db, b, -1);
    const c = box('new', 'h3');
    expect(claimableServers(db).map((s) => s.id)).toEqual([b, a, c]);
  });
});

const srv = (id: number, host: string): ServerRow => ({ id, name: `s${id}`, host } as ServerRow);
const table = (rows: Record<string, Record<string, number | null>>) =>
  new Map(Object.entries(rows).map(([p, byHost]) => [p, new Map(Object.entries(byHost))]));

describe('choosePing', () => {
  const opts = { marginMs: 15, minPlayers: 2 };
  const free = [srv(1, 'dal'), srv(2, 'chi')];

  it('moves to the host with the lower worst ping when it beats the margin', () => {
    const c = choosePing(free, table({ p1: { dal: 40, chi: 30 }, p2: { dal: 90, chi: 50 } }), opts);
    expect(c.server.id).toBe(2);
    expect(c.moved).toBe(true);
  });

  it('keeps the pick-order box inside the margin', () => {
    const c = choosePing(free, table({ p1: { dal: 40, chi: 30 }, p2: { dal: 60, chi: 50 } }), opts);
    expect(c.server.id).toBe(1);
    expect(c.moved).toBe(false);
  });

  it('only compares players known on every free host', () => {
    // p2 never played on chi: comparing them would favour chi for nothing.
    const c = choosePing(free, table({ p1: { dal: 40, chi: 35 }, p2: { dal: 150, chi: null }, p3: { dal: 50, chi: 45 } }), opts);
    expect(c.server.id).toBe(1);
  });

  it('falls back to pick order with too few comparable players', () => {
    const c = choosePing(free, table({ p1: { dal: 100, chi: 20 } }), opts);
    expect(c.server.id).toBe(1);
    expect(c.reason).toMatch(/need 2/);
  });

  it('takes the first box in pick order on the winning host', () => {
    const three = [srv(1, 'dal'), srv(3, 'riv'), srv(4, 'riv')];
    const c = choosePing(three, table({ p1: { dal: 80, riv: 30 }, p2: { dal: 80, riv: 30 } }), opts);
    expect(c.server.id).toBe(3);
  });
});

describe('ping samples', () => {
  it('pingTo is the median of recent rounds, shared by two servers on one host', () => {
    const s3 = box('riverside3', 'rhost', 27015);
    const s4 = box('riverside4', 'rhost', 27016);
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
    const p = '76561198000000001';
    const at = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
    recordPing(db, 1, 1, { id: s3, host: 'rhost' }, { half: 1, steamid: p, ms: 40, loss: 0, samples: 9 }, at(1));
    recordPing(db, 1, 1, { id: s4, host: 'rhost' }, { half: 2, steamid: p, ms: 60, loss: 0, samples: 9 }, at(1));
    recordPing(db, 1, 2, { id: s4, host: 'rhost' }, { half: 1, steamid: p, ms: 50, loss: 0, samples: 9 }, at(1));
    recordPing(db, 1, 3, { id: s4, host: 'rhost' }, { half: 1, steamid: p, ms: 999, loss: 0, samples: 9 }, at(90)); // too old
    expect(pingTo(db, p, 'rhost', NOW)).toBe(50);
    expect(pingTo(db, p, 'elsewhere', NOW)).toBeNull();
    // A duplicated datagram upserts, never adds a sample.
    recordPing(db, 1, 1, { id: s3, host: 'rhost' }, { half: 1, steamid: p, ms: 40, loss: 0, samples: 9 }, at(1));
    expect(db.prepare('SELECT COUNT(*) AS n FROM player_pings').get()).toEqual({ n: 4 });
  });

  it('claimIdle with the chooser moves a match and says why', () => {
    const dal = box('dallas', 'dal');
    const chi = box('chicago', 'chi');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
    const players = ids(4);
    players.forEach((p, i) => {
      recordPing(db, 1, 1, { id: dal, host: 'dal' }, { half: 1, steamid: p, ms: 90 + i, loss: 0, samples: 9 }, new Date(NOW).toISOString());
      recordPing(db, 1, 1, { id: chi, host: 'chi' }, { half: 2, steamid: p, ms: 40 + i, loss: 0, samples: 9 }, new Date(NOW).toISOString());
    });
    const reasons: string[] = [];
    const got = claimIdle(db, NOW, pingChooser(db, players, (c) => reasons.push(c.reason), NOW));
    expect(got?.id).toBe(chi);
    expect(reasons[0]).toMatch(/^picked chicago/);
    setSetting(db, 'server_pick_ping_min_players', '5');
    db.prepare("UPDATE servers SET status = 'idle'").run();
    expect(claimIdle(db, NOW, pingChooser(db, players, undefined, NOW))?.id).toBe(dal);
  });
});

describe('PING line', () => {
  const TOKEN = '0123456789abcdef0123456789abcdef';
  const framed = (body: string) => Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 07/30/2026 - 14:23:01: ${body}\n`, 'utf8'),
  ]);

  it('parses', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PING half=2 steamid=76561198000000001 ms=48 loss=1 n=12`))).toEqual({
      kind: 'ping', token: TOKEN, half: 2, steamid: '76561198000000001', ms: 48, loss: 1, samples: 12,
    });
  });

  it('rejects a bad half, steamid or value', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PING half=3 steamid=76561198000000001 ms=48 loss=1 n=12`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PING half=1 steamid=bob ms=48 loss=1 n=12`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PING half=1 steamid=76561198000000001 ms=48 loss=1 n=0`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PING half=1 steamid=76561198000000001 ms=-1 loss=1 n=3`))).toBeNull();
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
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 10/05/2026 - 14:23:01: ${body}\n`, 'utf8')]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}

describe('PING end to end', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); });

  it('stores the sample against the match server and its host', async () => {
    const T = 'c'.repeat(32);
    const port = await freeUdpPort();
    const sid = box('dallas', '127.0.0.1');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token) VALUES (1, 1, 'live', 'x', ?, ?)").run(sid, T);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (1, 'm', datetime('now'))").run();
    const app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    close = () => app.close();
    await send(port, `PUG ${T} ROUND_START map=m half=1 surv=a`);
    await new Promise((r) => setTimeout(r, 80));
    await send(port, `PUG ${T} PING half=1 steamid=76561198000000001 ms=52 loss=0 n=14`);
    await new Promise((r) => setTimeout(r, 80));
    expect(db.prepare('SELECT server_id, host, ms, samples FROM player_pings').get())
      .toEqual({ server_id: sid, host: '127.0.0.1', ms: 52, samples: 14 });
  });
});
