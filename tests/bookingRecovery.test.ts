import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { addServer, type ServerRow } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { currentSeasonId } from '../src/players.js';
import { Notifier } from '../src/notify/notify.js';
import {
  cancelBooking, confirmBooking, createBooking, endBooking, getBooking,
  beginRecovery, dropBox, finishRecovery, markUpAlerted, noteA2s, noteAlive, noteLost, reholdBox,
} from '../src/bookings/bookings.js';
import { bookingLimits, bookingsDue } from '../src/bookings/rules.js';
import { BookingRunner } from '../src/bookings/runner.js';
import { claimIdle } from '../src/serverPool.js';
import { bookingMessage } from '../src/bookings/messages.js';
import { classifyBox, type BoxSignals } from '../src/bookings/recovery.js';
import { setMissionsDirs, invalidateCampaignCache } from '../src/campaignRegistry.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { reapOrphanedMatches } from '../src/liveView.js';
import { ServerReleaser } from '../src/serverRelease.js';

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
      // Mirrors the real console tokenizer: it splits an unquoted arg on ':',
      // so only a quoted `sm_pug_roster "steamid:team:map"` is accepted. A
      // regression to the unquoted form is counted as rejected here, same as
      // the live box.
      const rosterOk = (x: string) => /^sm_pug_roster "\d{17}:[ab]:\d+"$/.test(x);
      if (c === 'sm_pug_resume_commit') return `PUGOK resumed maps=${cmds.filter((x) => x.startsWith('sm_pug_resume_map ')).length} roster=${cmds.filter(rosterOk).length}`;
      if (c.startsWith('sm_pug_resume_map ')) return `PUGOK resume_map=${cmds.filter((x) => x.startsWith('sm_pug_resume_map ')).indexOf(c) + 1}`;
      if (c.startsWith('sm_pug_roster ')) return rosterOk(c) ? `PUGOK roster=${cmds.filter(rosterOk).indexOf(c) + 1}` : 'PUGERR bad roster arg';
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
async function running(playlist?: string[]): Promise<number> {
  const id = book({ playlist });
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
  const base: BoxSignals = { rconOk: true, marker: '7', bookingId: 7, nowMs: 1_000_000, lostSinceMs: null, heartbeatMs: null, a2sPlayers: null, a2sMisses: 0, goneMisses: 3, goneMs: 3 * MIN };
  /** rcon silent for `lost` minutes, no heartbeat. */
  const down = (lost: number, o: Partial<BoxSignals> = {}): BoxSignals => ({ ...base, rconOk: false, lostSinceMs: base.nowMs - lost * MIN, ...o });
  it('ok when rcon answers with our marker, or with no marker cvar at all (old plugin)', () => {
    expect(classifyBox(base)).toEqual({ kind: 'ok' });
    expect(classifyBox({ ...base, marker: null })).toEqual({ kind: 'ok' });
  });
  it('restarted when rcon answers and the marker is empty or another booking', () => {
    expect(classifyBox({ ...base, marker: '' })).toEqual({ kind: 'restarted' });
    expect(classifyBox({ ...base, marker: '8' })).toEqual({ kind: 'restarted' });
  });
  it('quiet while rcon has failed for less than the limit', () => {
    expect(classifyBox(down(2, { a2sMisses: 3 }))).toEqual({ kind: 'quiet' });
  });
  it('quiet while the live game still heartbeats, however long rcon has failed', () => {
    expect(classifyBox(down(10, { heartbeatMs: base.nowMs - 40_000, a2sMisses: 10 }))).toEqual({ kind: 'quiet' });
  });
  it('up_no_rcon when A2S answers past the limit, with or without players', () => {
    expect(classifyBox(down(3, { a2sPlayers: 5 }))).toEqual({ kind: 'up_no_rcon', players: 5 });
    expect(classifyBox(down(3, { a2sPlayers: 0 }))).toEqual({ kind: 'up_no_rcon', players: 0 });
  });
  it('gone when rcon, heartbeat and A2S are all silent past the limit, with at least the limit of A2S misses in a row', () => {
    expect(classifyBox(down(3, { heartbeatMs: base.nowMs - 4 * MIN, a2sMisses: 3 }))).toEqual({ kind: 'gone' });
    expect(classifyBox(down(8, { a2sMisses: 9 }))).toEqual({ kind: 'gone' });
  });
  it('not gone with fewer A2S misses in a row than the limit, however long rcon has failed', () => {
    expect(classifyBox(down(3, { a2sMisses: 2 }))).toEqual({ kind: 'quiet' });
    expect(classifyBox(down(10, { a2sMisses: 0 }))).toEqual({ kind: 'quiet' });
  });
  it('rolling: an earlier A2S answer only resets the misses; gone once the last limit of queries all went unanswered', () => {
    // One dropped reply at the limit after earlier answers.
    expect(classifyBox(down(3, { a2sMisses: 1 }))).toEqual({ kind: 'quiet' });
    // Answered early in the outage, then silent for the limit: gone.
    expect(classifyBox(down(8, { a2sMisses: 3 }))).toEqual({ kind: 'gone' });
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
  // The heartbeat clock is the test's fake `now`, never the wall clock: with a
  // real datetime('now') these rows went stale against the fixed START the day
  // after it was written (the box-gone tests failed from 2026-10-02 20:00 UTC on).
  db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital02_subway', datetime(?, 'unixepoch'))").run(m, Math.floor(now / 1000));
  return m;
}

/** The No Mercy missions dir for the describe it is called in. */
function useMissions(): void {
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
}

describe('srcds restarted', () => {
  useMissions();

  it('sets the booking up again on the same box and resumes the live game on the map it was on', async () => {
    const id = await running();
    const m = liveGame(id);
    crash();
    await runner.tick();
    await runner.idle();
    const cmds = sent.filter((s) => s.server === 'ccc').flatMap((s) => s.cmds);
    const resume = cmds.indexOf(`sm_pug_resume ${m} tok123 l4d_vs_hospital01_apartment a ${1}`);
    expect(resume).toBeGreaterThan(-1);
    // The resume leads its burst: sm_pug_auto_track 0 never kept auto-track off (gameLines sets it to 1 in the same burst).
    expect(cmds).not.toContain('sm_pug_auto_track 0');
    expect(cmds).toContain('sm_pug_resume_map l4d_vs_hospital01_apartment 400 300');
    // Quoted, as the console tokenizer requires (fakeRcon rejects the
    // unquoted form the same way the real box does).
    expect(cmds).toContain(`sm_pug_roster "${P[0]}:a:0"`);
    expect(cmds).toContain(`sm_pug_roster "${P[1]}:b:0"`);
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
    const id = await running(['no_mercy', 'death_toll']);
    db.prepare("UPDATE bookings SET next_campaign = 'death_toll', next_at = ? WHERE id = ?").run(new Date(now + 10 * MIN).toISOString(), id);
    crash();
    await runner.tick();
    await runner.idle();
    expect(box.ccc.map).toBe('l4d_vs_smalltown01_caves');
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, next_at: null, playlist_pos: 1 });
    const cmds = () => sent.filter((s) => s.server === 'ccc').flatMap((s) => s.cmds);
    expect(cmds().some((c) => c.startsWith('say [Booking] Death Toll: !nextmap'))).toBe(true);
    const loads = cmds().filter((c) => c === 'changelevel l4d_vs_smalltown01_caves').length;
    expect(loads).toBe(1);
    // The minute watches after the restore load nothing again.
    now += 11 * MIN;
    await runner.tick();
    await runner.idle();
    now += MIN;
    await runner.tick();
    await runner.idle();
    expect(cmds().filter((c) => c === 'changelevel l4d_vs_smalltown01_caves').length).toBe(loads);
  });

  it('a failed recovery burst never logs or alerts the game token or the booking passwords', async () => {
    const id = await running();
    const m = liveGame(id);
    const b = getBooking(db, id)!;
    crash();
    const events: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => events.push(e));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rcon = async (server: ServerRow, cmds: string[]): Promise<string[]> => {
      // As src/rcon.ts words a timeout: it names the command it was on.
      const resume = cmds.find((c) => c.startsWith('sm_pug_resume '));
      if (resume) throw new Error(`rcon exec timeout: ${resume}; ${cmds.find((c) => c.startsWith('sm_cvar sv_password'))}; ${cmds.find((c) => c.startsWith('sm_cvar tv_password'))}`);
      return fakeRcon(server, cmds);
    };
    const r = build({ rcon });
    try {
      await r.tick();
      await r.idle();
    } finally {
      off();
      warn.mockRestore();
      log.mockRestore();
    }
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'server_lost' });
    const out = [
      ...warn.mock.calls.flat().map((x) => (x instanceof Error ? x.message : String(x))),
      ...events.map((e) => JSON.stringify(e)),
    ].join('\n');
    expect(out).toContain('rcon exec timeout: sm_pug_resume');
    expect(out).not.toContain('tok123');
    expect(out).not.toContain(b.password);
    expect(out).not.toContain(b.tv_password);
    expect(db.prepare('SELECT abort_cause FROM matches WHERE id = ?').get(m)).toEqual({ abort_cause: 'server_lost' });
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

  it('an End that arrives during the recovery winds the booking down with no booking_recovered notice', async () => {
    const id = await running();
    crash();
    let ended = false;
    const rcon = async (server: ServerRow, cmds: string[]): Promise<string[]> => {
      if (!ended && cmds.some((c) => c.startsWith('changelevel '))) {
        ended = true;
        expect(endBooking(db, { bookingId: id, by: P[0], now: new Date(now) }).ok).toBe(true);
      }
      return fakeRcon(server, cmds);
    };
    const r = build({ rcon });
    await r.tick();
    await r.idle();
    expect(ended).toBe(true);
    expect(dms.some((d) => d.content.includes('restarted'))).toBe(false);
    expect(getBooking(db, id)).toMatchObject({ state: 'ended' });
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
    expect(sent.flatMap((s) => s.cmds).some((c) => c.startsWith('say [Booking] Restored'))).toBe(false);
  });

  it('a restart between games is not read as everyone leaving after the game', async () => {
    const id = await running();
    now = START + 40 * MIN;
    const sql = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id, booking_side_a, ended_at) VALUES (?, 'completed', 'no_mercy', 3, 'tokdone', 'in_game', 'scrim', 'participants', ?, 'a', ?)",
    ).run(currentSeasonId(db), id, sql(now - 10 * MIN));
    crash();
    await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ recovering_at: null, recoveries: 1 });
    // Two empty watches within a minute of the restore: everyone is reconnecting.
    now += 30_000; await runner.tick(); await runner.idle();
    now += 30_000; await runner.tick(); await runner.idle();
    expect(getBooking(db, id)!.ending_at).toBeNull();
  });

  it('a box that answers with our marker is left alone', async () => {
    const id = await running();
    sent = [];
    await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ recovering_at: null, recoveries: 0 });
    expect(sent.flatMap((s) => s.cmds)).not.toContain('exec pug_match');
  });
});

describe('box gone', () => {
  useMissions();
  const kill = (name = 'ccc') => { box[name].down = true; };
  /** One watch a minute (TICK_MS) from the first failed one until rcon has
   *  been silent for the 3 minute limit: four watches, four A2S queries. */
  const tickOut = async () => {
    await runner.tick(); await runner.idle();
    for (let i = 0; i < 3; i++) { now += MIN; await runner.tick(); await runner.idle(); }
  };

  it('is quiet before the limit, then moves to another box after rcon, heartbeat and A2S are silent for 3 minutes', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    const m = liveGame(id);
    db.prepare("UPDATE match_live SET last_seen = datetime(?, 'unixepoch') WHERE match_id = ?").run(Math.floor((now - 10 * MIN) / 1000), m);
    kill();
    for (let i = 0; i < 3; i++) {
      await runner.tick(); await runner.idle();
      expect(getBooking(db, id)!.server_id).toBe(3);
      now += MIN;
    }
    await runner.tick(); await runner.idle();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ server_id: 2, recovering_at: null, recoveries: 1 });
    expect((db.prepare('SELECT status FROM servers WHERE id = 3').get() as { status: string }).status).toBe('offline');
    expect(restarted).toContain('bb');
    expect(db.prepare('SELECT server_id, state FROM matches WHERE id = ?').get(m)).toEqual({ server_id: 2, state: 'live' });
    expect(dms.some((d) => d.content.includes('moved to another server'))).toBe(true);
  });

  it('never moves while A2S answers; staff are told once', async () => {
    const seen: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => seen.push(e));
    try {
      runner = build({ a2s: async () => ({ players: 6, map: 'x' }) });
      const id = await running();
      kill();
      for (let i = 0; i < 6; i++) { await runner.tick(); await runner.idle(); now += MIN; }
      expect(getBooking(db, id)).toMatchObject({ server_id: 3, recovering_at: null });
      expect(seen.filter((e) => e.kind === 'problem' && e.text.includes('answers the server browser')).length).toBe(1);
    } finally {
      off();
    }
  });

  it('asks A2S on every watch from the first failed rcon watch on', async () => {
    let asked = 0;
    runner = build({ a2s: async () => { asked++; return { players: 0, map: 'x' }; } });
    const id = await running();
    kill();
    await runner.tick(); await runner.idle();
    expect(asked).toBe(1);
    expect(getBooking(db, id)!.a2s_seen_at).not.toBeNull();
    now += MIN; await runner.tick(); await runner.idle();
    expect(asked).toBe(2);
  });

  it('A2S answers early in the outage, then is silent for the limit of minutes in a row: moves', async () => {
    const answers = [true, true];
    runner = build({ a2s: async () => (answers.shift() ? { players: 0, map: 'x' } : null) });
    const id = await running();
    kill();
    // Answers at 0 and 1 minutes, misses at 2, 3 and 4.
    for (let i = 0; i < 4; i++) { await runner.tick(); await runner.idle(); now += MIN; }
    expect(getBooking(db, id)).toMatchObject({ server_id: 3, recovering_at: null });
    await runner.tick(); await runner.idle();
    expect(getBooking(db, id)!.server_id).not.toBe(3);
  });

  it('one dropped A2S reply among answers never moves the booking', async () => {
    const answers = [true, true, true, false, true, true, false, true, true, true];
    runner = build({ a2s: async () => (answers.shift() ? { players: 0, map: 'x' } : null) });
    const id = await running();
    kill();
    for (let i = 0; i < 10; i++) { await runner.tick(); await runner.idle(); now += MIN; }
    expect(getBooking(db, id)).toMatchObject({ server_id: 3, recovering_at: null });
  });

  it('one dropped A2S reply at the limit after earlier answers: no move', async () => {
    const answers = [true, true, true, false];
    runner = build({ a2s: async () => (answers.shift() ? { players: 0, map: 'x' } : null) });
    const id = await running();
    kill();
    await tickOut();
    expect(getBooking(db, id)).toMatchObject({ server_id: 3, recovering_at: null });
  });

  it('fewer A2S misses in a row than the limit: no move, even past the limit', async () => {
    // A web restart mid-outage forgets the misses: the count starts again.
    runner = build({ a2s: async () => null });
    const id = await running();
    kill();
    for (let i = 0; i < 2; i++) { await runner.tick(); await runner.idle(); now += MIN; }
    runner = build({ a2s: async () => null });
    now += 5 * MIN;
    for (let i = 0; i < 2; i++) { await runner.tick(); await runner.idle(); now += MIN; }
    expect(getBooking(db, id)).toMatchObject({ server_id: 3, recovering_at: null });
    await runner.tick(); await runner.idle();
    expect(getBooking(db, id)!.server_id).not.toBe(3);
  });

  it('never moves while the live game still heartbeats', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    const m = liveGame(id);
    kill();
    for (let i = 0; i < 5; i++) {
      db.prepare('UPDATE match_live SET last_seen = ? WHERE match_id = ?').run(new Date(now).toISOString().replace('T', ' ').slice(0, 19), m);
      await runner.tick(); await runner.idle(); now += MIN;
    }
    expect(getBooking(db, id)!.server_id).toBe(3);
  });

  it('with no free box: waits ahead of PUGs, takes the first freed box, gives up after the wait', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    kill();
    await tickOut();
    expect(getBooking(db, id)).toMatchObject({ server_id: null });
    expect(getBooking(db, id)!.waiting_since).not.toBeNull();
    expect(preempts).toBeGreaterThan(0);
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = 1").run();
    expect(claimIdle(db, now)).toBeNull(); // kept back for the waiting booking
    runner.allocate(); await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ server_id: 1, recoveries: 1 });
  });

  it('gives up after booking_recover_wait_minutes', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    const m = liveGame(id);
    db.prepare("UPDATE match_live SET last_seen = datetime(?, 'unixepoch') WHERE match_id = ?").run(Math.floor((now - 30 * MIN) / 1000), m);
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    kill();
    await tickOut();
    now += 20 * MIN;
    await runner.tick(); await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'server_lost' });
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
    expect(db.prepare('SELECT abort_cause FROM matches WHERE id = ?').get(m)).toEqual({ abort_cause: 'server_lost' });
  });

  it('a waiting booking survives a web restart', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    kill();
    await tickOut();
    const fresh = build({ a2s: async () => null });
    fresh.resume();
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = 2").run();
    await fresh.tick(); await fresh.idle();
    expect(getBooking(db, id)).toMatchObject({ server_id: 2, recoveries: 1 });
  });

  it('a gone box goes back to idle by itself after answering twice in a row', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    kill();
    await tickOut();
    expect((db.prepare('SELECT status, gone_since FROM servers WHERE id = 3').get() as { status: string; gone_since: string | null }).gone_since).not.toBeNull();
    box.ccc.down = false;
    await runner.tick(); await runner.idle();
    expect((db.prepare('SELECT status FROM servers WHERE id = 3').get() as { status: string }).status).toBe('offline');
    await runner.tick(); await runner.idle();
    expect(db.prepare('SELECT status, gone_since FROM servers WHERE id = 3').get()).toEqual({ status: 'idle', gone_since: null });
    expect(getBooking(db, id)!.server_id).not.toBe(3);
    // Given back through the releaser (its forced restart clears the old
    // booking's plugin match, passwords and players), not a raw status write.
    expect(released).toEqual([3]);
  });

  it('a miss between two answers starts the count again; a box staff set idle only loses gone_since', async () => {
    runner = build({ a2s: async () => null });
    await running();
    kill();
    await tickOut();
    const row = () => db.prepare('SELECT status, gone_since FROM servers WHERE id = 3').get() as { status: string; gone_since: string | null };
    box.ccc.down = false; await runner.tick(); await runner.idle();
    box.ccc.down = true; await runner.tick(); await runner.idle();
    box.ccc.down = false; await runner.tick(); await runner.idle();
    expect(row().status).toBe('offline');
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = 3").run();
    box.ccc.down = true;
    await runner.tick(); await runner.idle();
    expect(row()).toEqual({ status: 'idle', gone_since: null });
  });

  it('a gone box the releaser is already restarting (staff Set idle) is not given back a second time', async () => {
    runner = build({ a2s: async () => null, releasing: (sid) => sid === 3 });
    await running();
    kill();
    await tickOut();
    box.ccc.down = false;
    await runner.tick(); await runner.idle();
    await runner.tick(); await runner.idle();
    await runner.tick(); await runner.idle();
    expect(released).toEqual([]);
  });

  /** Booking `id` waiting for a box (both others busy) with its live game. */
  async function waitingWithGame(r: BookingRunner): Promise<{ id: number; m: number }> {
    runner = r;
    const id = await running();
    const m = liveGame(id);
    db.prepare("UPDATE match_live SET last_seen = datetime(?, 'unixepoch') WHERE match_id = ?").run(Math.floor((now - 30 * MIN) / 1000), m);
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    kill();
    await tickOut();
    expect(getBooking(db, id)).toMatchObject({ server_id: null });
    expect(getBooking(db, id)!.waiting_since).not.toBeNull();
    return { id, m };
  }

  it('a captain End during the wait aborts the live game and closes the booking', async () => {
    const unregistered: string[] = [];
    const { id, m } = await waitingWithGame(build({ a2s: async () => null, unregisterToken: (t) => { unregistered.push(t); } }));
    expect(endBooking(db, { bookingId: id, by: P[0], now: new Date(now) }).ok).toBe(true);
    runner.settle(id); await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ended' });
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
    expect(db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(m)).toEqual({ state: 'aborted', abort_cause: 'booking_ended' });
    expect(unregistered).toContain('tok123');
    expect(released).toEqual([]);
  });

  it('a reap right after a long-wait move leaves the moved game alone', async () => {
    const { id, m } = await waitingWithGame(build({ a2s: async () => null }));
    now += 15 * MIN;
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = 2").run();
    await runner.tick(); await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ server_id: 2, recovering_at: null, recoveries: 1 });
    // The fresh plugin's first heartbeat has not landed yet.
    expect(reapOrphanedMatches(db, new ServerReleaser(db, async () => {}))).toEqual([]);
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(m)).toEqual({ state: 'live' });
  });

  it('a staff cancel during the wait aborts the live game and closes the booking', async () => {
    const unregistered: string[] = [];
    const { id, m } = await waitingWithGame(build({ a2s: async () => null, unregisterToken: (t) => { unregistered.push(t); } }));
    expect(cancelBooking(db, { bookingId: id, by: P[5], staff: true, now: new Date(now) }).ok).toBe(true);
    await runner.tick(); await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'staff' });
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
    expect(db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(m)).toEqual({ state: 'aborted', abort_cause: 'booking_ended' });
    expect(unregistered).toContain('tok123');
  });
});
