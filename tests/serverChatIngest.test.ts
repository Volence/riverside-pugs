import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { Hub } from '../src/ws.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import {
  STAFF_FEED_QUIET_MS, _resetFeedQuiet, _resetNames, handleServerChatEvent, isActiveStaff, listLines, recordStaffOut,
} from '../src/serverChat.js';

const P = '76561199048276493';
const MOD = '76561199000000009';
const server = (db: DB, name: string): number => Number(db.prepare(
  "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES (?, '1.2.3.4', 27015, 27015, 'x', 27020, 1)",
).run(name).lastInsertRowid);
let db: DB;
let s1: number;
let events: AdminEvent[];
let off: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  _resetNames();
  _resetFeedQuiet();
  s1 = server(db, 'Dallas');
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => off());

describe('handleServerChatEvent', () => {
  it('stores a say line and notifies', () => {
    const notify = vi.fn();
    handleServerChatEvent(db, { kind: 'say', steamid: P, team: 2, scope: 'all', message: 'hi' }, s1, notify);
    expect(listLines(db, s1, 0, 10)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a name event names later lines and does not notify', () => {
    const notify = vi.fn();
    handleServerChatEvent(db, { kind: 'name', steamid: P, event: 'connect', name: 'Zoey' }, s1, notify);
    handleServerChatEvent(db, { kind: 'say', steamid: P, team: 2, scope: null, message: 'x' }, s1, notify);
    expect(listLines(db, s1, 0, 10)[0].name).toBe('Zoey');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('drops a line whose server is unknown', () => {
    const notify = vi.fn();
    handleServerChatEvent(db, { kind: 'say', steamid: P, team: 2, scope: null, message: 'x' }, null, notify);
    expect(db.prepare('SELECT COUNT(*) AS n FROM server_chat').get()).toEqual({ n: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('a /staff message posts to the admin feed once per player per quiet window', () => {
    const t0 = 1_000_000;
    const msg = (message: string, at: number) =>
      handleServerChatEvent(db, { kind: 'staff_in', steamid: P, team: 3, message }, s1, () => {}, at);
    msg('first', t0);
    msg('second', t0 + 60_000);
    msg('later', t0 + STAFF_FEED_QUIET_MS + 1);
    expect(events).toEqual([
      { kind: 'staff_message', steamid: P, serverId: s1, text: 'first' },
      { kind: 'staff_message', steamid: P, serverId: s1, text: 'later' },
    ]);
    expect(listLines(db, s1, 0, 10)).toHaveLength(3);
  });

  it('a delivery report updates the send and notifies only when it matched', () => {
    const notify = vi.fn();
    const id = recordStaffOut(db, s1, { sentBy: MOD, name: 'V', toKind: 'all', toValue: null, message: 'x' });
    handleServerChatEvent(db, { kind: 'staff_sent', sendId: id + 100, delivered: 2 }, s1, notify);
    expect(notify).not.toHaveBeenCalled();
    handleServerChatEvent(db, { kind: 'staff_sent', sendId: id, delivered: 2 }, s1, notify);
    expect(listLines(db, s1, 0, 10)[0].delivered).toBe(2);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('isActiveStaff', () => {
  it('is true for a mod or admin in good standing only', () => {
    upsertPlayer(db, { steamid: MOD, name: 'Mod', avatar: null }, []);
    upsertPlayer(db, { steamid: P, name: 'Player', avatar: null }, []);
    // Controller ruling: upsertPlayer creates 'invited' players and
    // inGoodStanding requires 'active', so MOD is activated the same way
    // tests/modCallPoster.test.ts does before it is made a moderator, so the
    // "true" assertion below tests a real active moderator.
    activatePlayer(db, MOD);
    expect(isActiveStaff(db, MOD)).toBe(false);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    expect(isActiveStaff(db, MOD)).toBe(true);
    expect(isActiveStaff(db, P)).toBe(false);
    expect(isActiveStaff(db, '76561199000000077')).toBe(false);
  });
});

describe('a chat line from the UDP socket to the table', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  const freeUdpPort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
  const sendLine = (port: number, body: string): Promise<void> => new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const text = Buffer.from(`L 09/28/2026 - 20:00:00: ${body}\n`, 'utf8');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });

  it('a PUGSAY from a known server address is stored against that server and tells staff', async () => {
    const local = Number(db.prepare(
      "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES ('Local', '127.0.0.1', 27015, 27015, 'x', 27020, 1)",
    ).run().lastInsertRowid);
    upsertPlayer(db, { steamid: MOD, name: 'Mod', avatar: null }, []);
    activatePlayer(db, MOD);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    const hub = new Hub();
    const heard: string[] = [];
    hub.add({ readyState: 1, send: (m: string) => heard.push(JSON.parse(m).event) }, MOD);
    const port = await freeUdpPort();
    app = await buildServer({
      config: { ...loadConfig({}), devMode: false, logListenPort: port }, db, hub,
      serverExec: async () => {}, serverCleaner: async () => {},
    });
    await sendLine(port, `PUGSAY steamid=${P} team=2 scope=team msg=rush the tank`);
    await vi.waitFor(() => expect(listLines(db, local, 0, 10)).toHaveLength(1), { timeout: 2000 });
    expect(listLines(db, local, 0, 10)[0]).toMatchObject({ kind: 'say', steamid: P, team: 2, scope: 'team', message: 'rush the tank' });
    expect(listLines(db, s1, 0, 10)).toHaveLength(0);
    expect(heard).toContain('server_chat');
  });
});
