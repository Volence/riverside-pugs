import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { upsertPlayer } from '../src/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { markIgnoredLilac } from '../src/lilacIgnore.js';
import { lilacAdapter } from '../src/admin/timeline/lilac.js';
import { isEvidence } from '../src/admin/timeline/types.js';
import { flagsForPlayer } from '../src/integrityFlags.js';
import { secondSigns } from '../src/fingerprintSigns.js';

const P = '76561198000000771';
const SURV = 'maxd=50.4 totd=50.4 taps=0 taps1=0 ltarget_team=3 ltarget_class=3 ltarget_ghost=1 lself_team=2';
const INF = 'maxd=105.1 totd=169.4 taps=0 taps1=0 ltarget_team=2 ltarget_class=0 ltarget_ghost=0 lself_team=3';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P, name: 'flagged', avatar: null }, []);
  // Servers 1 and 2, for the matches and flags below.
  addServer(db, { name: 'one', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  addServer(db, { name: 'two', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
});

function match(id: number, serverId: number | null, state = 'completed', endedAt: string | null = '2026-10-20 04:39:34'): void {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, ended_at) VALUES (?, 1, ?, 'death_toll', ?, ?)")
    .run(id, state, serverId, endedAt);
}
function readyup(matchId: number, from: string, to: string | null): void {
  db.prepare('INSERT INTO match_readyups (match_id, map_ordinal, half, started_at, ended_at) VALUES (?, 0, 1, ?, ?)')
    .run(matchId, from, to);
}
function flag(kind: string, at: string, detail: string, matchId: number | null = 754, serverId: number | null = 1): number {
  return Number(db.prepare(
    "INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at) VALUES (?, ?, ?, 'lilac', ?, 'suspected', ?, ?)",
  ).run(matchId, serverId, P, kind, detail, at).lastInsertRowid);
}
const ignored = () => db.prepare('SELECT id, ignored FROM integrity_flags ORDER BY id').all();

describe('markIgnoredLilac', () => {
  it('marks aimlocks in a ready-up window or on an infected player, and nothing else', () => {
    match(754, 1);
    readyup(754, '2026-10-20 03:47:26', '2026-10-20 03:55:49');
    const inReady = flag('aimlock', '2026-10-20T03:53:31.418Z', SURV);
    const infReady = flag('aimlock', '2026-10-20T03:54:00.000Z', INF);
    const infLive = flag('aimlock', '2026-10-20T04:10:00.000Z', INF);
    const survLive = flag('aimlock', '2026-10-20T04:11:00.000Z', SURV);
    // An aimbot flag still counts, in a ready-up or on an infected player.
    const aimbot = flag('aimbot', '2026-10-20T03:50:00.000Z', 'lflags=4 ldelta=30 ltd=40 maxd=30 totd=40 taps=1 taps1=0');
    const old = flag('aimlock', '2026-10-20T04:12:00.000Z', '');
    expect(markIgnoredLilac(db)).toEqual({ readyup: 2, infected: 1 });
    expect(ignored()).toEqual([
      { id: inReady, ignored: 'readyup' }, { id: infReady, ignored: 'readyup' },
      { id: infLive, ignored: 'infected' }, { id: survLive, ignored: null },
      { id: aimbot, ignored: null }, { id: old, ignored: null },
    ]);
    // Idempotent, and only ever sets a mark.
    expect(markIgnoredLilac(db)).toEqual({ readyup: 0, infected: 0 });
  });

  it('runs an open ready-up to the match end, and on a live match until now', () => {
    match(1, 1, 'completed', '2026-11-15 02:18:47');
    readyup(1, '2026-11-15 02:11:47', null);
    const inside = flag('aimlock', '2026-11-15T02:15:00.000Z', SURV, 1);
    const after = flag('aimlock', '2026-11-15T02:30:00.000Z', SURV, 1);
    match(2, 2, 'live', null);
    readyup(2, '2026-11-15 05:00:00', null);
    const live = flag('aimlock', '2026-11-15T05:01:00.000Z', SURV, 2, 2);
    markIgnoredLilac(db);
    expect(ignored()).toEqual([{ id: inside, ignored: 'readyup' }, { id: after, ignored: null }, { id: live, ignored: 'readyup' }]);
  });

  it('files a flag on no match by a ready-up on its server', () => {
    match(754, 1);
    readyup(754, '2026-10-20 03:47:26', '2026-10-20 03:55:49');
    const here = flag('aimlock', '2026-10-20T03:50:00.000Z', SURV, null, 1);
    const elsewhere = flag('aimlock', '2026-10-20T03:50:00.000Z', SURV, null, 2);
    markIgnoredLilac(db, here);
    expect(ignored()).toEqual([{ id: here, ignored: 'readyup' }, { id: elsewhere, ignored: null }]);
  });
});

describe('an ignored aimlock on the file and in the signs', () => {
  beforeEach(() => {
    match(754, 1);
    readyup(754, '2026-10-20 03:47:26', '2026-10-20 03:55:49');
  });

  it('is on the timeline as ignored, never evidence', () => {
    flag('aimlock', '2026-10-20T03:53:31.418Z', SURV);
    flag('aimlock', '2026-10-20T04:10:00.000Z', INF);
    markIgnoredLilac(db);
    const items = lilacAdapter.items({ db, steamid: P, ids: [P], viewer: P });
    expect(items.map((i) => i.summary.split(':')[0])).toEqual(['Ignored (infected)', 'Ignored (ready-up)']);
    expect(items.every((i) => i.allowed === true && !isEvidence(i))).toBe(true);
    expect(lilacAdapter.evidence!(db)).toEqual([]);
    expect(flagsForPlayer(db, P).map((f) => f.ignored)).toEqual(['infected', 'readyup']);
  });

  it('still counts an aimbot flag on an infected player', () => {
    flag('aimbot', '2026-10-20T04:10:00.000Z', 'lflags=4 ldelta=30 ltd=40 maxd=30 totd=40 taps=1 taps1=0');
    markIgnoredLilac(db);
    const [item] = lilacAdapter.items({ db, steamid: P, ids: [P], viewer: P });
    expect(isEvidence(item)).toBe(true);
    expect(lilacAdapter.evidence!(db)).toHaveLength(1);
  });

  it('gives no cheat_flag sign', () => {
    const ctx = { asnLoaded: false, extraVpn: [], membersInTop10: 0, members: [] } as unknown as Parameters<typeof secondSigns>[2];
    const at = new Date('2026-10-21T00:00:00Z');
    flag('aimlock', '2026-10-20T03:53:31.418Z', SURV);
    markIgnoredLilac(db);
    expect(secondSigns(db, P, ctx, at)).not.toContain('cheat_flag');
    flag('aimlock', '2026-10-20T04:11:00.000Z', SURV);
    markIgnoredLilac(db);
    expect(secondSigns(db, P, ctx, at)).toContain('cheat_flag');
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
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 11/15/2026 - 21:04:13: ${body}\n`, 'utf8')]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}
const settle = () => new Promise((r) => setTimeout(r, 80));

describe('L4DL aimlock over the wire', () => {
  let app: FastifyInstance | null = null;
  let off: (() => void) | null = null;
  afterEach(async () => { off?.(); off = null; await app?.close(); app = null; });

  it('keeps an infected aimlock as ignored with no admin alert, and still alerts an aimbot flag', async () => {
    const events: AdminEvent[] = [];
    off = subscribeAdminEvents((e) => events.push(e));
    const port = await freeUdpPort();
    addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, `L4DL id=${P} cheat=6 banned=0 ${INF}`);
    await settle();
    await send(port, `L4DL id=${P} cheat=5 banned=0 lflags=4 ldelta=30 ltd=40 maxd=30 totd=40 taps=1 taps1=0`);
    await settle();
    const rows = db.prepare('SELECT kind, ignored FROM integrity_flags ORDER BY id').all();
    expect(rows).toEqual([{ kind: 'aimlock', ignored: 'infected' }, { kind: 'aimbot', ignored: null }]);
    expect(events.filter((e) => e.kind === 'lilac_flag').map((e) => (e as { cheat: string }).cheat)).toEqual(['aimbot']);
  });
});
