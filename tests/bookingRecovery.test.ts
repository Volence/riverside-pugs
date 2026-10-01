import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, type ServerRow } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { currentSeasonId } from '../src/players.js';
import { Notifier } from '../src/notify/notify.js';
import {
  confirmBooking, createBooking, getBooking,
  beginRecovery, dropBox, finishRecovery, markUpAlerted, noteA2s, noteAlive, noteLost, reholdBox,
} from '../src/bookings/bookings.js';
import { bookingLimits, bookingsDue } from '../src/bookings/rules.js';
import { BookingRunner } from '../src/bookings/runner.js';
import { classifyBox, type BoxSignals } from '../src/bookings/recovery.js';

const P = Array.from({ length: 10 }, (_, i) => `765611990000009${String(i).padStart(2, '0')}`);
const START = Date.parse('2026-10-02T20:00:00.000Z');
const MIN = 60_000;
const PUB = 'Rotoblin Pub VS';

let db: DB;
let now: number;
let sent: { server: string; cmds: string[] }[];
let box: Record<string, { type: string; plugin: boolean; map: string; humans: string[]; down: boolean; execs: number; failExec: number }>;
let released: number[];
let restarted: string[];
let dms: { to: string; content: string }[];
let preempts: number;
let runner: BookingRunner;

const status = (b: { map: string; humans: string[] }) => [
  'hostname: test', `map     : ${b.map} at: 0 x, 0 y, 0 z`, `players : ${b.humans.length} humans, 0 bots (31 max)`,
  '# userid name uniqueid connected ping loss state rate adr',
  ...b.humans.map((sid, i) => `#  ${i + 2} ${i + 1} "h${i}" ${steam2(sid)} 01:12 33 0 active 128000 10.0.0.${i}:27005`),
].join('\n');
/** SteamID64 -> STEAM_1:Y:Z, the form `status` prints. */
const steam2 = (sid: string) => { const n = BigInt(sid) - 76561197960265728n; return `STEAM_1:${n % 2n}:${n / 2n}`; };

/** The fake box: records each burst and answers like srcds would. */
const fakeRcon = async (server: ServerRow, cmds: string[]): Promise<string[]> => {
  const b = box[server.name];
  if (b.down) throw new Error('rcon connect timeout');
  sent.push({ server: server.name, cmds });
  return cmds.map((c) => {
    if (c === 'status') return status(b);
    if (c === 'l4d_game_type_name') return `"l4d_game_type_name" = "${b.type}" ( def. "" )`;
    if (c === 'l4d_booking_version') return b.plugin ? '"l4d_booking_version" = "1.0.0" ( def. "1.0.0" )' : 'Unknown command "l4d_booking_version"';
    if (c === 'exec pug_match') { b.execs++; if (b.failExec > 0) b.failExec--; else b.type = 'Rotoblin 4v4 PUG'; }
    const m = /^changelevel (\S+)$/.exec(c);
    if (m) b.map = m[1];
    return '';
  });
};

function build(over: Partial<ConstructorParameters<typeof BookingRunner>[0]> = {}) {
  return new BookingRunner({
    db,
    publicUrl: 'https://riversidepug.com',
    rcon: fakeRcon,
    release: async (id) => { released.push(id); db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id); return true; },
    restart: async (server) => { restarted.push(server.name); box[server.name].type = PUB; box[server.name].map = 'l4d_vs_hospital01_apartment'; return true; },
    notifier: new Notifier({ db, dm: () => async (to, p) => { dms.push({ to, content: p.content ?? '' }); } }),
    preempt: () => { preempts++; },
    sleep: async () => {},
    now: () => now,
    ...over,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  now = START - 2 * 24 * 60 * MIN;
  sent = []; released = []; restarted = []; dms = []; preempts = 0; box = {};
  const ins = db.prepare("INSERT INTO players (steamid, name, status, discord_id) VALUES (?, ?, 'active', ?)");
  P.forEach((id, i) => ins.run(id, `p${i}`, `d${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll', 'dead_center']));
  setSetting(db, 'pug_reserve_servers', '1');
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: '10.0.0.1', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
    box[n] = { type: PUB, plugin: true, map: 'l4d_vs_hospital01_apartment', humans: [], down: false, execs: 0, failExec: 0 };
  }
  runner = build();
});

/** The slot is estimated from the campaigns (no PUG history, so 60 each):
 *  one campaign is a 90 minute slot (until 21:30 UTC), two are 180 (23:00). */
const book = (o: { playlist?: string[]; confirm?: boolean } = {}) => {
  const r = createBooking(db, {
    by: P[0], opponent: { steamid: P[1] }, startsAt: new Date(START).toISOString(),
    playlist: o.playlist ?? ['no_mercy'], now: new Date(now),
  });
  if (!r.ok) throw new Error(r.error);
  if (o.confirm !== false) confirmBooking(db, { bookingId: r.value.id, by: P[1], now: new Date(now) });
  return r.value.id;
};

/** A booking set up and running on box ccc (server 3). */
async function running(): Promise<number> {
  const id = book();
  now = START - 15 * MIN;
  runner.allocate();
  await runner.idle();
  expect(getBooking(db, id)!.state).toBe('ready');
  now = START;
  return id;
}

describe('recovery writes', () => {
  it('beginRecovery only on a running booking, once', async () => {
    const id = await running();
    expect(beginRecovery(db, id, 'restart', new Date(now))).toBe(true);
    expect(beginRecovery(db, id, 'restart', new Date(now))).toBe(false);
    const b = getBooking(db, id)!;
    expect(b.recover_reason).toBe('restart');
    const ev = db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'recovery_started'").get(id) as { detail: string };
    expect(JSON.parse(ev.detail)).toEqual({ reason: 'restart', serverId: 3 });
  });

  it('noteLost keeps the first time, noteAlive clears the outage', async () => {
    const id = await running();
    const first = noteLost(db, id, new Date(now));
    expect(noteLost(db, id, new Date(now + MIN))).toBe(first);
    noteA2s(db, id, new Date(now));
    expect(markUpAlerted(db, id, new Date(now))).toBe(true);
    expect(markUpAlerted(db, id, new Date(now))).toBe(false);
    noteAlive(db, id);
    expect(getBooking(db, id)).toMatchObject({ lost_since: null, a2s_seen_at: null, up_alerted_at: null });
  });

  it('dropBox gives up the box, marks it offline, and the waiting booking is kept a box ahead of PUGs', async () => {
    const id = await running();
    beginRecovery(db, id, 'gone', new Date(now));
    expect(dropBox(db, id, new Date(now))).toBe(3);
    expect(getBooking(db, id)).toMatchObject({ server_id: null, state: 'ready' });
    expect((db.prepare('SELECT status FROM servers WHERE id = 3').get() as { status: string }).status).toBe('offline');
    expect(bookingsDue(db, now, bookingLimits(db).protectMinutes)).toBe(1);
  });

  it('reholdBox takes an idle unheld box and moves the live game with it', async () => {
    const id = await running();
    const m = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id) VALUES (?, 'live', 'no_mercy', 3, 'tok', 'in_game', 'scrim', 'participants', ?)",
    ).run(currentSeasonId(db), id).lastInsertRowid);
    beginRecovery(db, id, 'gone', new Date(now));
    dropBox(db, id, new Date(now));
    expect(reholdBox(db, id, 3, new Date(now))).toBe(false); // offline now
    expect(reholdBox(db, id, 2, new Date(now))).toBe(true);
    expect(getBooking(db, id)!.server_id).toBe(2);
    expect((db.prepare('SELECT server_id FROM matches WHERE id = ?').get(m) as { server_id: number }).server_id).toBe(2);
    expect(bookingsDue(db, now, bookingLimits(db).protectMinutes)).toBe(0);
  });

  it('finishRecovery clears the outage, counts it and restarts the idle clock', async () => {
    const id = await running();
    beginRecovery(db, id, 'restart', new Date(now));
    noteLost(db, id, new Date(now));
    expect(finishRecovery(db, id, new Date(now + 2 * MIN))).toBe(true);
    expect(getBooking(db, id)).toMatchObject({
      recovering_at: null, recover_reason: null, lost_since: null, waiting_since: null, recoveries: 1,
      last_human_at: new Date(now + 2 * MIN).toISOString(),
    });
  });

  it('the limits read the two settings with their bounds', () => {
    expect(bookingLimits(db)).toMatchObject({ goneMinutes: 3, recoverWaitMinutes: 20 });
    setSetting(db, 'booking_gone_minutes', '1');
    setSetting(db, 'booking_recover_wait_minutes', '999');
    expect(bookingLimits(db)).toMatchObject({ goneMinutes: 2, recoverWaitMinutes: 60 });
  });
});

describe('classifyBox', () => {
  const base: BoxSignals = { rconOk: true, marker: '7', bookingId: 7, nowMs: 1_000_000, lostSinceMs: null, heartbeatMs: null, a2sPlayers: null, goneMs: 3 * MIN };
  it('ok when rcon answers with our marker, or with no marker cvar at all (old plugin)', () => {
    expect(classifyBox(base)).toEqual({ kind: 'ok' });
    expect(classifyBox({ ...base, marker: null })).toEqual({ kind: 'ok' });
  });
  it('restarted when rcon answers and the marker is empty or another booking', () => {
    expect(classifyBox({ ...base, marker: '' })).toEqual({ kind: 'restarted' });
    expect(classifyBox({ ...base, marker: '8' })).toEqual({ kind: 'restarted' });
  });
  it('quiet while rcon has failed for less than the limit', () => {
    expect(classifyBox({ ...base, rconOk: false, lostSinceMs: base.nowMs - 2 * MIN })).toEqual({ kind: 'quiet' });
  });
  it('quiet while the live game still heartbeats, however long rcon has failed', () => {
    expect(classifyBox({ ...base, rconOk: false, lostSinceMs: base.nowMs - 10 * MIN, heartbeatMs: base.nowMs - 40_000 })).toEqual({ kind: 'quiet' });
  });
  it('up_no_rcon when A2S answers past the limit, with or without players', () => {
    expect(classifyBox({ ...base, rconOk: false, lostSinceMs: base.nowMs - 3 * MIN, a2sPlayers: 5 })).toEqual({ kind: 'up_no_rcon', players: 5 });
    expect(classifyBox({ ...base, rconOk: false, lostSinceMs: base.nowMs - 3 * MIN, a2sPlayers: 0 })).toEqual({ kind: 'up_no_rcon', players: 0 });
  });
  it('gone when rcon, heartbeat and A2S are all silent past the limit', () => {
    expect(classifyBox({ ...base, rconOk: false, lostSinceMs: base.nowMs - 3 * MIN, heartbeatMs: base.nowMs - 4 * MIN })).toEqual({ kind: 'gone' });
  });
});
