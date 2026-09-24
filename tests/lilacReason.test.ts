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

const P = '76561198030288393';
const STAFF = '76561198000000009';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); upsertPlayer(db, { steamid: P, name: 'nehoc', avatar: null }, []); });

/** Same integrity_flags row shape server.ts writes, built directly so the
 *  summary sentence can be checked against a chosen `detail` without going
 *  through the network for every case. The wiring itself (parse -> canonical
 *  detail -> row) is covered by the UDP test below. */
const lilac = (kind: string, detail: string, severity: 'suspected' | 'banned' = 'suspected') =>
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (7, 1, ?, 'lilac', ?, ?, ?, datetime('now'))`,
  ).run(P, kind, severity, detail);

const summary = () => playerTimeline(db, P, STAFF)[0].summary;

describe('the lilac timeline summary, reason beside the flag', () => {
  it('reads exactly as today when detail is empty', () => {
    lilac('aimbot', '');
    expect(summary()).toBe(
      'Little Anti-Cheat suspected aimbot. Few and rare suspicions are usually false positives; a run of them is what matters.',
    );
  });

  it('names LilAC\'s reason from the flag bits and keeps our own measurement beside it', () => {
    lilac('aimbot', 'lflags=2 ldelta=12.3 ltd=100 maxd=80.2 totd=200.5 taps=10 taps1=8');
    const s = summary();
    expect(s).toMatch(/LilAC's reason: Autoshoot\./);
    expect(s).toMatch(
      /Our measurement over the 1\.5 s before: biggest one-tick aim change 80\.2 degrees, total 200\.5 degrees, 10 trigger presses, 8 of them one tick long\./,
    );
  });

  it('an lflags of -1 (unknown) omits LilAC\'s reason but keeps ours', () => {
    lilac('aimbot', 'lflags=-1 ldelta=-1 ltd=-1 maxd=80.2 totd=200.5 taps=10 taps1=8');
    const s = summary();
    expect(s).not.toMatch(/LilAC's reason/);
    expect(s).toMatch(/Our measurement over the 1\.5 s before/);
  });

  it('adds Total-Delta when ltd is over 450, even with no bit set', () => {
    lilac('aimbot', 'lflags=0 ldelta=5 ltd=500 maxd=10 totd=20 taps=3 taps1=2');
    expect(summary()).toMatch(/LilAC's reason: Total-Delta\./);
  });

  it('says none recorded when no bit is set and ltd is not over 450', () => {
    lilac('aimbot', 'lflags=0 ldelta=5 ltd=100 maxd=10 totd=20 taps=3 taps1=2');
    expect(summary()).toMatch(/LilAC's reason: none recorded\./);
  });

  it('names every combination of bits', () => {
    lilac('aimbot', 'lflags=15 ldelta=5 ltd=100 maxd=10 totd=20 taps=3 taps1=2');
    expect(summary()).toMatch(/LilAC's reason: Angle-Repeat, Autoshoot, Aim-Snap, Aim-Snap2\./);
  });

  it('says the perfect-hop streak for a bhop flag', () => {
    lilac('bhop', 'lbhops=14 ljump=22');
    expect(summary()).toMatch(/14 perfect hops in a row/);
  });

  it('says an aimlock\'s target and hedges the through-walls caveat when lself_team is unknown', () => {
    lilac('aimlock', 'maxd=45 totd=90 taps=6 taps1=5 ltarget_team=2 ltarget_class=0 ltarget_ghost=0');
    const s = summary();
    expect(s).toMatch(/Locked onto a survivor/);
    expect(s).toMatch(/infected players see survivors through walls in L4D, so this can be legitimate if the flagged player was infected/i);
    expect(s).toMatch(
      /Our measurement over the 1\.5 s before: biggest one-tick aim change 45 degrees, total 90 degrees, 6 trigger presses, 5 of them one tick long\./,
    );
    expect(s).not.toMatch(/LilAC's reason/);
  });

  it('a survivor target never gets the ghost suffix, even when ltarget_ghost=1', () => {
    lilac('aimlock', 'maxd=45 totd=90 taps=6 taps1=5 ltarget_team=2 ltarget_class=0 ltarget_ghost=1');
    expect(summary()).toMatch(/Locked onto a survivor\./);
    expect(summary()).not.toMatch(/ghost/i);
  });

  it('hedges the same way when lself_team is explicitly -1 (unknown)', () => {
    lilac('aimlock', 'maxd=45 totd=90 taps=6 taps1=5 ltarget_team=2 ltarget_class=0 ltarget_ghost=0 lself_team=-1');
    expect(summary()).toMatch(/infected players see survivors through walls in L4D, so this can be legitimate if the flagged player was infected/i);
  });

  it('states the caveat as fact when lself_team says the flagged player was infected', () => {
    lilac('aimlock', 'maxd=45 totd=90 taps=6 taps1=5 ltarget_team=2 ltarget_class=0 ltarget_ghost=0 lself_team=3');
    const s = summary();
    expect(s).toMatch(/Locked onto a survivor/);
    expect(s).toMatch(/infected players see survivors through walls in L4D/i);
    // No longer hedged: the flagged player's own team is known, so this
    // should read as fact, not as a maybe.
    expect(s).not.toMatch(/can be legitimate if the flagged player was infected/i);
  });

  it('drops the caveat entirely when lself_team says the flagged player was a survivor', () => {
    lilac('aimlock', 'maxd=45 totd=90 taps=6 taps1=5 ltarget_team=2 ltarget_class=0 ltarget_ghost=0 lself_team=2');
    const s = summary();
    expect(s).toMatch(/Locked onto a survivor/);
    expect(s).not.toMatch(/through walls/i);
  });

  it('names the infected class and a ghost, with no caveat for an infected target', () => {
    lilac('aimlock', 'maxd=45 totd=90 taps=6 taps1=5 ltarget_team=3 ltarget_class=3 ltarget_ghost=1');
    const s = summary();
    expect(s).toMatch(/Locked onto an infected hunter \(a ghost\)/);
    expect(s).not.toMatch(/through walls/i);
  });

  it('says nothing extra about the target when it is unknown', () => {
    lilac('aimlock', 'maxd=45 totd=90 taps=6 taps1=5 ltarget_team=-1 ltarget_class=-1 ltarget_ghost=-1');
    expect(summary()).not.toMatch(/Locked onto/);
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
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 09/24/2026 - 14:23:01: ${body}\n`, 'utf8')]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}
const settle = () => new Promise((r) => setTimeout(r, 80));

describe('L4DL over the wire, end to end', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it('stores the canonical reason string and the timeline shows it', async () => {
    const port = await freeUdpPort();
    addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, `L4DL id=${P} cheat=5 banned=0 lflags=2 ldelta=12.3 ltd=470.5 maxd=80.2 totd=200.5 taps=10 taps1=8`);
    await settle();
    expect(db.prepare("SELECT detail FROM integrity_flags").get())
      .toEqual({ detail: 'lflags=2 ldelta=12.3 ltd=470.5 maxd=80.2 totd=200.5 taps=10 taps1=8' });
    const [item] = playerTimeline(db, P, STAFF);
    expect(item.summary).toMatch(/LilAC's reason: Autoshoot, Total-Delta\./);
  });

  it('stores lself_team appended at the end of an aimlock line and states the caveat as fact', async () => {
    const port = await freeUdpPort();
    addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(
      port,
      `L4DL id=${P} cheat=6 banned=0 maxd=45.0 totd=90.0 taps=6 taps1=5 `
      + 'ltarget_team=2 ltarget_class=0 ltarget_ghost=0 lself_team=3',
    );
    await settle();
    expect(db.prepare("SELECT detail FROM integrity_flags").get()).toEqual({
      detail: 'maxd=45 totd=90 taps=6 taps1=5 ltarget_team=2 ltarget_class=0 ltarget_ghost=0 lself_team=3',
    });
    const [item] = playerTimeline(db, P, STAFF);
    expect(item.summary).toMatch(/Locked onto a survivor/);
    expect(item.summary).toMatch(/infected players see survivors through walls in L4D/i);
    expect(item.summary).not.toMatch(/can be legitimate if the flagged player was infected/i);
  });

  it('stores an empty detail for a flag with no reason fields, same as before', async () => {
    const port = await freeUdpPort();
    addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, `L4DL id=${P} cheat=9 banned=0`);
    await settle();
    expect(db.prepare("SELECT detail FROM integrity_flags").get()).toEqual({ detail: '' });
  });
});
