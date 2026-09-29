import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer, currentSeasonId } from '../src/players.js';
import { setMissionsDirs } from '../src/campaignRegistry.js';
import type { LobbySnapshot } from '../src/lobby.js';
import type { MatchmakerListener } from '../src/matchmaker.js';
import type { SideLogEvent } from '../src/logParse.js';
import { SideGames, RECONNECT_GRACE_MS, CLOSE_GRACE_MS, type SideQueue } from '../src/sideGames.js';

// Two stock campaigns with chapter lists, so the finale check and the first
// map have something to read (the registry's maps come from missions files).
const mission = (name: string, maps: string[]) => `"mission"
{
  "Name" "${name}"
  "modes"
  {
    "versus"
    {
${maps.map((m, i) => `      "${i + 1}" { "Map" "${m}" }`).join('\n')}
    }
  }
}
`;
const HOSPITAL = ['l4d_vs_hospital01_apartment', 'l4d_vs_hospital02_subway', 'l4d_vs_hospital03_sewers',
  'l4d_vs_hospital04_interior', 'l4d_vs_hospital05_rooftop'];
const AIRPORT = ['l4d_vs_airport01_greenhouse', 'l4d_vs_airport02_offices', 'l4d_vs_airport03_garage',
  'l4d_vs_airport04_terminal', 'l4d_vs_airport05_runway'];

const ids = (n: number) => Array.from({ length: n }, (_, i) => `7656119800000${String(i + 1).padStart(4, '0')}`);

class FakeQueue implements SideQueue {
  candidates: string[] = [];
  lobbyList: { id: string; snapshot: LobbySnapshot }[] = [];
  listener: MatchmakerListener = {};
  readyResult: { ok: boolean; error?: string } = { ok: true };
  ready = vi.fn((_id: string) => this.readyResult);
  vote = vi.fn((_id: string, _c: string) => true);
  sideCandidates() { return [...this.candidates]; }
  queuePosition(id: string) { return this.candidates.indexOf(id); }
  lobbyOf(id: string) { return this.lobbyList.find((l) => l.snapshot.players.includes(id))?.snapshot ?? null; }
  lobbies() { return this.lobbyList; }
  on(l: MatchmakerListener) { this.listener = l; }
}

interface FakeTimer { fn: () => void; ms: number; cancelled: boolean }

let db: DB;
let dir: string;
let q: FakeQueue;
let rconLog: string[][];
let released: number[];
let timers: FakeTimer[];
let sg: SideGames;
let s1: number;
let s2: number;

const flat = () => rconLog.flat();
const lastRoster = () => [...flat()].reverse().find((c) => c.startsWith('sm_side_roster '))!;
const teamOf = (roster: string, id: string) => roster.split(' ').slice(1).find((e) => e.startsWith(`${id}:`))!.slice(-1);
const countTeam = (roster: string, t: string) => roster.split(' ').slice(1).filter((e) => e.endsWith(`:${t}`)).length;
const fire = (ms: number) => { for (const t of timers.filter((x) => x.ms === ms && !x.cancelled)) { t.cancelled = true; t.fn(); } };
const log = (event: SideLogEvent, extra: { steamid?: string; map?: string; campaign?: string; token?: string } = {}) =>
  sg.onLog({ event, token: extra.token ?? token(), steamid: extra.steamid ?? null, map: extra.map ?? null, campaign: extra.campaign ?? null });
const token = () => (db.prepare('SELECT token FROM side_games ORDER BY id DESC LIMIT 1').get() as { token: string }).token;
const openRows = () => db.prepare('SELECT * FROM side_games WHERE ended_at IS NULL').all();

async function openWith(n: number) {
  q.candidates = ids(n);
  sg.sync();
  await sg.settled();
}

function make() {
  sg = new SideGames({
    db,
    queue: q,
    rcon: async (_server, commands) => { rconLog.push(commands); return commands.map(() => 'PUGOK'); },
    release: async (id) => { released.push(id); return true; },
    broadcast: () => {},
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
    rng: () => 0,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sidegame-missions-'));
  writeFileSync(join(dir, 'hospital.txt'), mission('hospital', HOSPITAL));
  writeFileSync(join(dir, 'airport.txt'), mission('airport', AIRPORT));
  setMissionsDirs([dir]);
  db = openDb(':memory:');
  s1 = addServer(db, { name: 'One', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  s2 = addServer(db, { name: 'Two', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
  setSetting(db, 'sidegames_enabled', '1');
  for (const id of ids(8)) upsertPlayer(db, { steamid: id, name: id.slice(-4), avatar: null }, []);
  q = new FakeQueue();
  rconLog = [];
  released = [];
  timers = [];
  make();
});

afterEach(() => {
  setMissionsDirs([]);
  rmSync(dir, { recursive: true, force: true });
});

describe('SideGames', () => {
  it('opens on the lowest id box with a 2v2 at 4 candidates', async () => {
    await openWith(4);
    const cmds = flat();
    expect(cmds[0]).toMatch(/^sv_password "side_[0-9a-f]{8}"$/);
    expect(cmds[1]).toBe('exec rotoblin_hardcore_2v2');
    expect(cmds[2]).toMatch(/^sm_side_start [0-9a-f]{32} side_[0-9a-f]{8}$/);
    expect(cmds[2].split(' ')[2]).toBe(cmds[0].slice(13, -1));
    expect(countTeam(cmds[3], 'A')).toBe(2);
    expect(countTeam(cmds[3], 'B')).toBe(2);
    expect(cmds[4]).toBe('changelevel l4d_vs_hospital01_apartment');
    expect(cmds).toHaveLength(5);
    expect(db.prepare('SELECT server_id FROM side_games WHERE ended_at IS NULL').get()).toEqual({ server_id: s1 });
  });

  it('does not open when disabled, under the minimum, with a match waiting, or with no box', async () => {
    setSetting(db, 'sidegames_enabled', '0');
    await openWith(4);
    setSetting(db, 'sidegames_enabled', '1');
    setSetting(db, 'sidegames_min_players', '5');
    await openWith(4);
    setSetting(db, 'sidegames_min_players', '4');
    await openWith(3);
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', 'no_mercy')").run(currentSeasonId(db));
    await openWith(4);
    db.prepare("UPDATE matches SET state = 'aborted'").run();
    db.prepare("UPDATE servers SET status = 'live'").run();
    await openWith(4);
    expect(rconLog).toEqual([]);
    expect(openRows()).toEqual([]);
    db.prepare(`UPDATE servers SET status = 'idle' WHERE id = ${s2}`).run();
    await openWith(4);
    expect(openRows()).toMatchObject([{ server_id: s2 }]);
  });

  it('seats a mid-map joiner as S at once', async () => {
    await openWith(4);
    rconLog = [];
    await openWith(5);
    expect(rconLog).toHaveLength(1);
    const roster = rconLog[0][0];
    expect(roster.split(' ').slice(1)).toHaveLength(5);
    expect(teamOf(roster, ids(5)[4])).toBe('S');
    expect(sg.publicView()).toEqual({ size: 2, players: 5 });
  });

  it('grows to 3v3 at the next mapstart', async () => {
    await openWith(4);
    log('mapend', { map: HOSPITAL[0] });
    await openWith(6);
    rconLog = [];
    log('mapstart', { map: HOSPITAL[1] });
    await sg.settled();
    expect(rconLog).toHaveLength(1);
    expect(rconLog[0][0]).toBe('exec rotoblin_hardcore_3v3');
    expect(countTeam(rconLog[0][1], 'A')).toBe(3);
    expect(countTeam(rconLog[0][1], 'B')).toBe(3);
    expect(sg.publicView()).toEqual({ size: 3, players: 6 });
  });

  it('rotates the sitter in and the longest streak out at a map change', async () => {
    // Two maps with four, then a fifth arrives: after the next map the
    // fifth has sat once and the first four have a streak of 3 against the
    // newcomer's none, so the newcomer comes in and the latest queued sits.
    await openWith(4);
    log('mapend', { map: HOSPITAL[0] });
    log('mapstart', { map: HOSPITAL[1] });
    await openWith(5);
    const newcomer = ids(5)[4];
    expect(teamOf(lastRoster(), newcomer)).toBe('S');
    log('mapend', { map: HOSPITAL[1] });
    rconLog = [];
    log('mapstart', { map: HOSPITAL[2] });
    await sg.settled();
    expect(flat().some((c) => c.startsWith('exec'))).toBe(false);
    const roster = lastRoster();
    expect(teamOf(roster, newcomer)).not.toBe('S');
    expect(countTeam(roster, 'S')).toBe(1);
    expect(teamOf(roster, ids(4)[3])).toBe('S');
  });

  it('starts a new stock campaign after the finale', async () => {
    await openWith(4);
    rconLog = [];
    log('mapend', { map: HOSPITAL[4] });
    await sg.settled();
    expect(flat()).toEqual(['changelevel l4d_vs_airport01_greenhouse']);
    rconLog = [];
    log('mapend', { map: HOSPITAL[2] });
    await sg.settled();
    expect(flat()).toEqual([]);
  });

  it('gives a disconnected player 90 s, and a rejoin cancels it', async () => {
    await openWith(4);
    const [a] = ids(4);
    log('join', { steamid: a });
    log('part', { steamid: a });
    const t = timers.find((x) => x.ms === RECONNECT_GRACE_MS)!;
    expect(t).toBeDefined();
    log('join', { steamid: a });
    expect(t.cancelled).toBe(true);
    rconLog = [];
    await sg.settled();
    expect(rconLog).toEqual([]);
    // Grace runs out: with nobody sitting, 4 to 3 winds the game down.
    log('part', { steamid: a });
    fire(RECONNECT_GRACE_MS);
    await sg.settled();
    expect(sg.view(a)!.phase).toBe('closing');
  });

  it('subs the sitter into the leaver\'s team with one roster push', async () => {
    await openWith(5);
    const roster = lastRoster();
    const sitter = ids(5)[4];
    const leaver = ids(5)[0];
    const leaverTeam = teamOf(roster, leaver);
    rconLog = [];
    q.candidates = ids(5).filter((x) => x !== leaver);
    sg.sync();
    await sg.settled();
    expect(rconLog).toHaveLength(1);
    expect(rconLog[0]).toHaveLength(1);
    expect(teamOf(rconLog[0][0], sitter)).toBe(leaverTeam);
    expect(rconLog[0][0]).not.toContain(leaver);
  });

  it('rebuilds at 2v2 when 6 drop to 5 with nobody sitting', async () => {
    await openWith(6);
    rconLog = [];
    q.candidates = ids(6).slice(1);
    sg.sync();
    await sg.settled();
    expect(rconLog).toHaveLength(1);
    expect(rconLog[0][0]).toBe('exec rotoblin_hardcore_2v2');
    const roster = rconLog[0][1];
    expect(countTeam(roster, 'A')).toBe(2);
    expect(countTeam(roster, 'B')).toBe(2);
    expect(countTeam(roster, 'S')).toBe(1);
  });

  it('winds down at 3, holds the box, then closes after the grace', async () => {
    await openWith(4);
    rconLog = [];
    q.candidates = ids(3);
    sg.sync();
    await sg.settled();
    expect(countTeam(rconLog[0][0], 'S')).toBe(3);
    expect(rconLog[0][1]).toMatch(/^say /);
    expect(sg.view(ids(3)[0])!.phase).toBe('closing');
    expect(openRows()).toHaveLength(1);
    expect(released).toEqual([]);
    rconLog = [];
    fire(CLOSE_GRACE_MS);
    await sg.settled();
    expect(flat()).toEqual([expect.stringMatching(/^sm_side_stop [0-9a-f]{32}$/)]);
    expect(released).toEqual([s1]);
    expect(db.prepare('SELECT end_reason, ended_at IS NOT NULL AS ended FROM side_games').get())
      .toEqual({ end_reason: 'too_few', ended: 1 });
    expect(sg.publicView()).toBeNull();
  });

  it('pop: spectates everyone and ignores queue changes while popped', async () => {
    await openWith(5);
    rconLog = [];
    q.listener.lobbyStarted!('lob_1', ids(8));
    await sg.settled();
    expect(flat()).toEqual(['sm_side_popped']);
    expect(sg.view(ids(1)[0])!.phase).toBe('popped');
    rconLog = [];
    q.candidates = [];
    q.listener.stateChanged!();
    await sg.settled();
    expect(rconLog).toEqual([]);
    expect(sg.view(ids(1)[0])!.phase).toBe('popped');
  });

  it('sends the vote menu once per lobby when it reaches map_vote', async () => {
    await openWith(4);
    q.listener.lobbyStarted!('lob_1', ids(8));
    await sg.settled();
    const snap: LobbySnapshot = { id: 'lob_1', phase: 'ready_check', players: ids(8), ready: [], options: ['no_mercy', 'dead_air'], votes: {}, deadline: 0 };
    q.lobbyList = [{ id: 'lob_1', snapshot: snap }];
    q.candidates = [];
    q.listener.stateChanged!();
    snap.phase = 'map_vote';
    rconLog = [];
    q.listener.stateChanged!();
    q.listener.stateChanged!();
    await sg.settled();
    expect(flat()).toEqual(['sm_side_vote "no_mercy=No Mercy" "dead_air=Dead Air"']);
  });

  it('in-game ready goes to the queue and a refusal is told in game; ignores a stale token', async () => {
    await openWith(4);
    q.listener.lobbyStarted!('lob_1', ids(8));
    await sg.settled();
    const [a] = ids(1);
    rconLog = [];
    log('ready', { steamid: a });
    expect(q.ready).toHaveBeenCalledWith(a);
    await sg.settled();
    expect(rconLog).toEqual([]);
    q.readyResult = { ok: false, error: 'join the "PUG" voice channel' };
    log('ready', { steamid: a });
    await sg.settled();
    expect(flat()).toEqual([`sm_side_notice ${a} "Not ready: join the 'PUG' voice channel"`]);
    q.ready.mockClear();
    log('ready', { steamid: a, token: 'f'.repeat(32) });
    expect(q.ready).not.toHaveBeenCalled();
  });

  it('in-game vote goes to the queue', async () => {
    await openWith(4);
    q.listener.lobbyStarted!('lob_1', ids(8));
    log('vote', { steamid: ids(1)[0], campaign: 'dead_air' });
    expect(q.vote).toHaveBeenCalledWith(ids(1)[0], 'dead_air');
  });

  it('lobbyFailed resumes with 4 or more left, and winds down with 3', async () => {
    await openWith(5);
    q.listener.lobbyStarted!('lob_1', ids(8));
    q.candidates = [];
    // The matchmaker fires lobbyFailed before it requeues the ready players,
    // then stateChanged once they are back.
    q.listener.lobbyFailed!('lob_1', ids(6), ids(8).slice(6));
    q.candidates = ids(6);
    await sg.settled();
    rconLog = [];
    q.listener.stateChanged!();
    await sg.settled();
    expect(rconLog).toHaveLength(1);
    expect(rconLog[0][0]).toBe('sm_side_resume');
    expect(rconLog[0][1]).toBe('exec rotoblin_hardcore_3v3');
    expect(countTeam(rconLog[0][2], 'A')).toBe(3);
    expect(sg.view(ids(1)[0])!.phase).toBe('running');

    q.listener.lobbyStarted!('lob_2', ids(8));
    q.candidates = [];
    q.listener.lobbyFailed!('lob_2', ids(3), ids(8).slice(3));
    q.candidates = ids(3);
    await sg.settled();
    rconLog = [];
    q.listener.stateChanged!();
    await sg.settled();
    expect(flat()[0]).toBe('sm_side_resume');
    expect(flat().some((c) => c.startsWith('say '))).toBe(true);
    expect(sg.view(ids(1)[0])!.phase).toBe('closing');
  });

  it('takeForMatch hands the held box to the match', async () => {
    expect(sg.takeForMatch('no_mercy', () => true)).toBeNull();
    await openWith(4);
    const took = sg.takeForMatch('no_mercy', () => true)!;
    expect(took.server.id).toBe(s1);
    expect(took.firstCommands).toEqual([`sm_side_stop ${token()}`]);
    expect(db.prepare('SELECT status FROM servers WHERE id = ?').get(s1)).toEqual({ status: 'reserved' });
    expect(db.prepare('SELECT end_reason, ended_at IS NOT NULL AS ended FROM side_games').get())
      .toEqual({ end_reason: 'match', ended: 1 });
    expect(sg.view(ids(1)[0])).toBeNull();
    expect(released).toEqual([]);
  });

  it('takeForMatch falls back when the campaign cannot run there', async () => {
    await openWith(4);
    expect(sg.takeForMatch('custom_x', () => false)).toBeNull();
    await sg.settled();
    expect(released).toEqual([s1]);
    expect(db.prepare('SELECT status FROM servers WHERE id = ?').get(s1)).toEqual({ status: 'idle' });
    expect(db.prepare('SELECT end_reason FROM side_games').get()).toEqual({ end_reason: 'campaign' });
    expect(sg.publicView()).toBeNull();
  });

  it('needServer closes the side game when no practice lease is open', async () => {
    await openWith(4);
    db.prepare(
      `INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at) VALUES (?, 'park', ?, 'pw', datetime('now', '+1 hour'))`,
    ).run(s2, ids(1)[0]);
    sg.needServer();
    await sg.settled();
    expect(released).toEqual([]);
    expect(sg.publicView()).not.toBeNull();
    db.prepare("UPDATE practice_leases SET ended_at = datetime('now')").run();
    sg.needServer();
    await sg.settled();
    expect(released).toEqual([s1]);
    expect(db.prepare('SELECT end_reason FROM side_games').get()).toEqual({ end_reason: 'preempted' });
  });

  it('recover closes open rows left by the previous process', async () => {
    db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (?, 'a', 'p'), (?, 'b', 'p')").run(s1, s2);
    make();
    sg.recover();
    await sg.settled();
    expect(released.sort()).toEqual([s1, s2]);
    expect(db.prepare('SELECT end_reason FROM side_games WHERE ended_at IS NOT NULL').all())
      .toEqual([{ end_reason: 'boot' }, { end_reason: 'boot' }]);
  });

  it('reopens on the same box within the close grace; needServer while closing closes at once', async () => {
    await openWith(4);
    q.candidates = ids(3);
    sg.sync();
    const closeTimer = timers.find((t) => t.ms === CLOSE_GRACE_MS)!;
    await sg.settled();
    rconLog = [];
    await openWith(4);
    expect(closeTimer.cancelled).toBe(true);
    expect(rconLog).toHaveLength(1);
    expect(rconLog[0][0]).toBe('exec rotoblin_hardcore_2v2');
    expect(countTeam(rconLog[0][1], 'A')).toBe(2);
    expect(sg.view(ids(1)[0])!.phase).toBe('running');
    expect(openRows()).toHaveLength(1);
    expect(released).toEqual([]);

    q.candidates = ids(3);
    sg.sync();
    db.prepare(
      `INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at) VALUES (?, 'park', ?, 'pw', datetime('now', '+1 hour'))`,
    ).run(s2, ids(1)[0]);
    sg.needServer();
    await sg.settled();
    expect(released).toEqual([s1]);
    expect(db.prepare('SELECT end_reason FROM side_games').get()).toEqual({ end_reason: 'preempted' });
  });

  it('views: connect details only for a participant', async () => {
    expect(sg.view(ids(1)[0])).toBeNull();
    expect(sg.publicView()).toBeNull();
    await openWith(4);
    const pw = flat()[0].slice(13, -1);
    expect(sg.view(ids(1)[0])).toEqual({
      phase: 'running', size: 2, players: 4, youIn: true,
      connect: { host: '10.0.0.1', port: 27015, password: pw },
    });
    expect(sg.view('76561198999999999')).toEqual({ phase: 'running', size: 2, players: 4, youIn: false, connect: null });
    expect(sg.publicView()).toEqual({ size: 2, players: 4 });
  });

  it('closes and backs off for a minute when the box refuses sm_side_start', async () => {
    let now = 1_000_000;
    let refuse = true;
    sg = new SideGames({
      db, queue: q,
      rcon: async (_s, commands) => { rconLog.push(commands); return commands.map((c) => refuse && c.startsWith('sm_side_start') ? 'Unknown command' : 'PUGOK'); },
      release: async (id) => { released.push(id); return true; },
      broadcast: () => {},
      setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
      rng: () => 0,
      now: () => now,
    });
    await openWith(4);
    expect(released).toEqual([s1]);
    expect(db.prepare('SELECT end_reason FROM side_games').get()).toEqual({ end_reason: 'rcon_failed' });
    rconLog = [];
    sg.sync();
    await sg.settled();
    expect(rconLog).toEqual([]);
    now += 60_000;
    refuse = false;
    sg.sync();
    await sg.settled();
    expect(openRows()).toHaveLength(1);
  });
});
