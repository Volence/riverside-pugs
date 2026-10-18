import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { publishAdminEvent, subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { BIG_SNAP_DEG, isBigSnap, lilacSeverity } from '../src/aimRules.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = '76561198129925325';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); upsertPlayer(db, { steamid: P, name: 'nepmir', avatar: null }, []); });

describe('rule B, the big snap', () => {
  it('is 60 degrees', () => {
    expect(BIG_SNAP_DEG).toBe(60);
  });

  it('marks an aimbot flag at or over 60 degrees high', () => {
    expect(lilacSeverity('aimbot', false, { lflags: 4, ldelta: 143.5 })).toBe('high');
    expect(lilacSeverity('aimbot', false, { ldelta: 60 })).toBe('high');
    expect(lilacSeverity('aimbot', false, { ldelta: 59.9 })).toBe('suspected');
  });

  it('leaves an unknown, missing or empty reason suspected', () => {
    expect(lilacSeverity('aimbot', false, { ldelta: -1 })).toBe('suspected');
    expect(lilacSeverity('aimbot', false, {})).toBe('suspected');
    expect(lilacSeverity('aimbot', false)).toBe('suspected');
  });

  // Review Focus 4: LilAC's own ban is never downgraded, and only the
  // aimbot check measures an aim-snap.
  it('keeps a LilAC ban banned and never marks another cheat high', () => {
    expect(lilacSeverity('aimbot', true, { ldelta: 143.5 })).toBe('banned');
    expect(lilacSeverity('aimlock', false, { ldelta: 143.5 })).toBe('suspected');
    expect(lilacSeverity('bhop', false, { ldelta: 143.5 })).toBe('suspected');
    expect(isBigSnap('aimlock', { ldelta: 143.5 })).toBe(false);
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

describe('L4DL big snap over the wire', () => {
  let app: FastifyInstance | null = null;
  let off: (() => void) | null = null;
  afterEach(async () => { off?.(); off = null; await app?.close(); app = null; });

  it('stores a 143.5 degree aimbot flag as high and says so on the feed event', async () => {
    const events: AdminEvent[] = [];
    off = subscribeAdminEvents((e) => events.push(e));
    const port = await freeUdpPort();
    addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, `L4DL id=${P} cheat=5 banned=0 lflags=4 ldelta=143.5 ltd=200 maxd=143.5 totd=300 taps=3 taps1=1`);
    await send(port, `L4DL id=${P} cheat=5 banned=0 lflags=4 ldelta=12.3 ltd=100 maxd=12.3 totd=40 taps=2 taps1=0`);
    await settle();
    const rows = db.prepare('SELECT kind, severity FROM integrity_flags ORDER BY id').all();
    expect(rows).toEqual([{ kind: 'aimbot', severity: 'high' }, { kind: 'aimbot', severity: 'suspected' }]);
    const lilac = events.filter((e) => e.kind === 'lilac_flag');
    expect(lilac).toEqual([
      { kind: 'lilac_flag', steamid: P, cheat: 'aimbot', banned: false, matchId: null, bigSnap: 143.5 },
      { kind: 'lilac_flag', steamid: P, cheat: 'aimbot', banned: false, matchId: null },
    ]);
  });
});

describe('the big snap on the admin feed', () => {
  let t: FakeTransport;
  let feed: AdminFeedPoster;
  beforeEach(() => {
    setSetting(db, 'discord_admin_channel_id', 'admins');
    t = new FakeTransport();
    feed = new AdminFeedPoster({ db, transport: t, publicUrl: 'https://pug.test' });
    feed.start();
  });
  afterEach(() => feed.stop());

  it('names the snap and does not ping', async () => {
    setSetting(db, 'mod_call_role_id', '123456789012345678');
    publishAdminEvent({ kind: 'lilac_flag', steamid: P, cheat: 'aimbot', banned: false, matchId: 722, bigSnap: 143.5 });
    await feed.idle();
    const [m] = t.live();
    expect(JSON.stringify(m.payload)).toContain('143.5 degree snap');
    expect(JSON.stringify(m.payload)).toContain('/match/722');
    expect(m.payload.content).toBeUndefined();
    expect(m.payload.mentionRoleIds ?? []).toEqual([]);
  });

  it('reads as before without one', async () => {
    publishAdminEvent({ kind: 'lilac_flag', steamid: P, cheat: 'aimbot', banned: false, matchId: null });
    await feed.idle();
    expect(JSON.stringify(t.live()[0].payload)).toContain('Few and rare suspicions are usually false positives');
  });
});
