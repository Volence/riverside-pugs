import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { bookingMessage } from '../src/bookings/messages.js';
import { classifyBox, type BoxSignals } from '../src/bookings/recovery.js';
import { setMissionsDirs, invalidateCampaignCache } from '../src/campaignRegistry.js';

const P = Array.from({ length: 10 }, (_, i) => `765611990000009${String(i).padStart(2, '0')}`);
const START = Date.parse('2026-10-02T20:00:00.000Z');
const MIN = 60_000;
const PUB = 'Rotoblin Pub VS';

let db: DB;
let now: number;
let sent: { server: string; cmds: string[] }[];
let box: Record<string, { type: string; plugin: boolean; map: string; humans: string[]; down: boolean; execs: number; failExec: number; marker: string; bookingPlugin: string; pugMatch: string }>;
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
    if (c === 'l4d_booking_id') return b.bookingPlugin >= '1.4.0' ? `"l4d_booking_id" = "${b.marker}" ( def. "" )` : 'Unknown command "l4d_booking_id"';
    if (/^sm_pug_(resume|roster)/.test(c)) {
      if (b.pugMatch < '0.3.19') return `Unknown command "${c.split(' ')[0]}"`;
      if (c === 'sm_pug_resume_commit') return `PUGOK resumed maps=${cmds.filter((x) => x.startsWith('sm_pug_resume_map ')).length} roster=${cmds.filter((x) => x.startsWith('sm_pug_roster ')).length}`;
      if (c.startsWith('sm_pug_resume_map ')) return `PUGOK resume_map=${cmds.filter((x) => x.startsWith('sm_pug_resume_map ')).indexOf(c) + 1}`;
      if (c.startsWith('sm_pug_roster ')) return `PUGOK roster=${cmds.filter((x) => x.startsWith('sm_pug_roster ')).indexOf(c) + 1}`;
      return `PUGOK resume=${c.split(' ')[1]}`;
    }
    const mk = /^l4d_booking_id "(\d*)"$/.exec(c);
    if (mk) b.marker = mk[1];
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
    restart: async (server) => { restarted.push(server.name); box[server.name].type = PUB; box[server.name].map = 'l4d_vs_hospital01_apartment'; box[server.name].marker = ''; return true; },
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
    box[n] = { type: PUB, plugin: true, map: 'l4d_vs_hospital01_apartment', humans: [], down: false, execs: 0, failExec: 0, marker: '', bookingPlugin: '1.4.0', pugMatch: '0.3.19' };
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

describe('boot marker', () => {
  it('setup writes the booking id marker', async () => {
    const id = await running();
    expect(box.ccc.marker).toBe(String(id));
  });
  it('setup refuses a box whose l4d_booking has no marker cvar', async () => {
    for (const n of ['a', 'bb', 'ccc']) box[n].bookingPlugin = '1.3.0';
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'setup_failed' });
  });
});

describe('booking_recovered message', () => {
  it('names the connect line, says a move, and carries the restored line', async () => {
    const id = await running();
    const b = getBooking(db, id)!;
    const same = bookingMessage(db, 'https://x', id, 'booking_recovered', { restored: 'your game is back on map 3, p0 812 - p1 640' })!;
    expect(same.content).toContain('restarted');
    expect(same.content).toContain(`password ${b.password}`);
    expect(same.content).toContain('your game is back on map 3');
    const moved = bookingMessage(db, 'https://x', id, 'booking_recovered', { moved: true })!;
    expect(moved.content).toContain('moved to another server');
  });
});

// The stock No Mercy chapter list in the mission-file shape the game ships
// (as tests/bookingRestore.test.ts): without a missions directory the stock
// registry entries carry `maps: []`, and restoreSnapshot needs the chapters.
const NO_MERCY = `"mission"
{
  "Name" "hospital"
  "DisplayTitle" "No Mercy"
  "modes"
  {
    "versus"
    {
      "1" { "Map" "l4d_vs_hospital01_apartment" "DisplayName" "The Apartments" }
      "2" { "Map" "l4d_vs_hospital02_subway" "DisplayName" "The Subway" }
      "3" { "Map" "l4d_vs_hospital03_sewers" "DisplayName" "The Sewers" }
      "4" { "Map" "l4d_vs_hospital04_interior" "DisplayName" "The Hospital" }
      "5" { "Map" "l4d_vs_hospital05_rooftop" "DisplayName" "Rooftop Finale" }
    }
  }
}
`;

/** Box ccc restarts under booking `id`: empty marker, Pub, the default map. */
const crash = (name = 'ccc') => { box[name].marker = ''; box[name].type = PUB; box[name].map = 'l4d_vs_hospital01_apartment'; box[name].humans = []; };

/** A live booking game on ccc with map 1 finished and map 2 under way. */
function liveGame(id: number): number {
  const m = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id, booking_side_a) VALUES (?, 'live', 'no_mercy', 3, 'tok123', 'in_game', 'scrim', 'participants', ?, 'a')",
  ).run(currentSeasonId(db), id).lastInsertRowid);
  db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, 'a', 'udp'), (?, ?, 'b', 'udp')").run(m, P[0], m, P[1]);
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, 0, 1, 'a', 400, 'x'), (?, 0, 2, 'b', 300, 'x'), (?, 1, 1, 'b', 50, NULL)").run(m, m, m);
  db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital02_subway', datetime('now'))").run(m);
  return m;
}

describe('srcds restarted', () => {
  let missionsDir: string;
  beforeEach(() => {
    missionsDir = mkdtempSync(join(tmpdir(), 'missions-'));
    writeFileSync(join(missionsDir, 'hospital.txt'), NO_MERCY);
    setMissionsDirs([missionsDir]);
    invalidateCampaignCache();
  });
  afterEach(() => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    rmSync(missionsDir, { recursive: true, force: true });
  });

  it('sets the booking up again on the same box and resumes the live game on the map it was on', async () => {
    const id = await running();
    const m = liveGame(id);
    crash();
    await runner.tick();
    await runner.idle();
    const cmds = sent.filter((s) => s.server === 'ccc').flatMap((s) => s.cmds);
    const resume = cmds.indexOf(`sm_pug_resume ${m} tok123 l4d_vs_hospital01_apartment a ${1}`);
    expect(resume).toBeGreaterThan(-1);
    expect(cmds.indexOf('sm_pug_auto_track 0')).toBeLessThan(resume);
    expect(cmds).toContain('sm_pug_resume_map l4d_vs_hospital01_apartment 400 300');
    expect(cmds).toContain('changelevel l4d_vs_hospital02_subway');
    expect(box.ccc.marker).toBe(String(id));
    expect(getBooking(db, id)).toMatchObject({ recovering_at: null, recoveries: 1, server_id: 3 });
    expect(db.prepare('SELECT state, restored_at_map FROM matches WHERE id = ?').get(m)).toEqual({ state: 'live', restored_at_map: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ? AND ordinal = 1').get(m)).toEqual({ n: 0 });
    expect(dms.some((d) => d.content.includes('restarted'))).toBe(true);
    expect(cmds.some((c) => c.startsWith('say [Booking] Restored after a server restart'))).toBe(true);
  });

  it('with no live game, sets up again and loads the campaign it was on', async () => {
    const id = await running();
    crash();
    box.ccc.map = 'c1m1_hotel';
    await runner.tick();
    await runner.idle();
    expect(box.ccc.map).toBe('l4d_vs_hospital01_apartment');
    expect(getBooking(db, id)).toMatchObject({ recovering_at: null, recoveries: 1 });
  });

  it('restores the loading campaign when a captain had picked the next one', async () => {
    const id = await running();
    db.prepare("UPDATE bookings SET next_campaign = 'death_toll', next_at = ? WHERE id = ?").run(new Date(now + 10 * MIN).toISOString(), id);
    crash();
    await runner.tick();
    await runner.idle();
    expect(box.ccc.map).toBe('l4d_vs_smalltown01_caves');
  });

  it('an old pug-match: the game is aborted as server_lost and the booking carries on', async () => {
    const id = await running();
    const m = liveGame(id);
    box.ccc.pugMatch = '0.3.18';
    crash();
    await runner.tick();
    await runner.idle();
    expect(db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(m)).toEqual({ state: 'aborted', abort_cause: 'server_lost' });
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', recovering_at: null });
  });

  it('two failed set-ups close the booking as server_lost, not a no-show', async () => {
    const id = await running();
    crash();
    box.ccc.failExec = 99;
    await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'server_lost' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM booking_sides WHERE booking_id = ? AND no_show_at IS NOT NULL').get(id)).toEqual({ n: 0 });
  });

  it('no idle end right after a restore', async () => {
    const id = await running();
    db.prepare("UPDATE bookings SET last_human_at = ? WHERE id = ?").run(new Date(now - 60 * MIN).toISOString(), id);
    now = START + 40 * MIN;
    crash();
    await runner.tick();
    await runner.idle();
    now += MIN;
    await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)!.ending_at).toBeNull();
  });

  it('resume() restarts a recovery a web restart cut off', async () => {
    const id = await running();
    beginRecovery(db, id, 'restart', new Date(now));
    crash();
    const fresh = build();
    fresh.resume();
    await fresh.idle();
    expect(getBooking(db, id)).toMatchObject({ recovering_at: null, recoveries: 1 });
  });

  it('a box that answers with our marker is left alone', async () => {
    const id = await running();
    await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)!.recovering_at).toBeNull();
    expect(sent.flatMap((s) => s.cmds)).not.toContain('sm_pug_auto_track 0');
  });
});
