import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, getServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { SelfStartedMatches } from '../src/selfStarted.js';
import type { LogEvent } from '../src/logParse.js';
import { RealOrchestrator } from '../src/orchestrator.js';
import { ServerReleaser } from '../src/serverRelease.js';
import { LogListener } from '../src/logListener.js';
import { currentSeasonId } from '../src/players.js';
import {
  addPerson, confirmBooking, createBooking, getBooking, holdBox, markReady, markSetup, respondPerson,
} from '../src/bookings/bookings.js';
import {
  abortBookingGame, bookingGames, bookingOnServer, bookingSideForTeamA, liveBookingGame, teamScrims,
} from '../src/bookings/games.js';
import { createTeam } from '../src/teams/teams.js';
import net from 'node:net';
import {
  decodePackets, encodePacket, SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from '../src/rconPacket.js';
import { pugReply } from './helpers.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';

const P = Array.from({ length: 10 }, (_, i) => `765611990000009${String(i).padStart(2, '0')}`);
const START = Date.parse('2026-10-02T20:00:00.000Z');
const MIN = 60_000;
const TOKEN = '0123456789abcdef0123456789abcdef';
const MAP = 'l4d_vs_hospital01_apartment';

let db: DB;

/** A fake srcds rcon port answering pug-match commands, as in orchestrator.test.ts. */
function fakeRconServer(dumpBody: (cmd: string) => string): Promise<{ port: number; close: () => Promise<void> }> {
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
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, pugReply(p.body, dumpBody)));
          } else if (p.type === SERVERDATA_RESPONSE_VALUE) {
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, '\u0000\u0001\u0000\u0000'));
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status, discord_id) VALUES (?, ?, 'active', ?)");
  P.forEach((id, i) => ins.run(id, `p${i}`, `d${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll', 'dead_center']));
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: '10.0.0.1', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});

/** A confirmed booking with three accepted people a side (a: P0 P2 P3, b: P1
 *  P4 P5), held and set up on server 3 (state ready). */
function readyBooking(serverId = 3, stage: 'setup' | 'ready' = 'ready'): number {
  const created = new Date(START - 2 * 24 * 60 * MIN);
  const r = createBooking(db, {
    by: P[0], opponent: { steamid: P[1] }, startsAt: new Date(START).toISOString(), minutes: 120,
    playlist: ['no_mercy'], now: created,
  });
  if (!r.ok) throw new Error(r.error);
  const id = r.value.id;
  confirmBooking(db, { bookingId: id, by: P[1], now: created });
  for (const [by, side, who] of [[P[0], 'a', P[2]], [P[0], 'a', P[3]], [P[1], 'b', P[4]], [P[1], 'b', P[5]]] as const) {
    const a = addPerson(db, { bookingId: id, by, side, steamid: who, role: 'player', now: created });
    if (!a.ok) throw new Error(a.error);
    respondPerson(db, { bookingId: id, steamid: who, accept: true, now: created });
  }
  const at = new Date(START - 15 * MIN);
  if (!holdBox(db, id, serverId, at)) throw new Error('hold failed');
  markSetup(db, id, at);
  if (stage === 'ready' && !markReady(db, id, at)) throw new Error('ready failed');
  return id;
}

const SIDE_A = [P[0], P[2], P[3]];
const SIDE_B = [P[1], P[4], P[5]];

describe('bookingSideForTeamA', () => {
  let id: number;
  beforeEach(() => { id = readyBooking(); });
  it('answers a when most of match team A is booking side a', () => {
    expect(bookingSideForTeamA(db, id, [P[0], P[2], P[4]], [P[1], P[5], P[3]])).toBe('a');
  });
  it('answers b when most of match team A is booking side b', () => {
    expect(bookingSideForTeamA(db, id, [P[1], P[4], P[0]], [P[2], P[3], P[5]])).toBe('b');
  });
  it('answers a on a tie', () => {
    expect(bookingSideForTeamA(db, id, [P[0], P[1]], [P[2], P[4]])).toBe('a');
  });
  it('answers a when nobody on either team is on the booking', () => {
    expect(bookingSideForTeamA(db, id, [P[6], P[7]], [P[8], P[9]])).toBe('a');
  });
});

describe('bookingOnServer', () => {
  it('finds the ready booking holding the box, and nothing on a box no booking holds', () => {
    const id = readyBooking();
    expect(bookingOnServer(db, 3)?.id).toBe(id);
    expect(bookingOnServer(db, 1)).toBeNull();
  });
  it('ignores a booking that is ending', () => {
    const id = readyBooking();
    db.prepare("UPDATE bookings SET ending_at = '2026-10-02T20:30:00.000Z' WHERE id = ?").run(id);
    expect(bookingOnServer(db, 3)).toBeNull();
  });
});

describe('adopting a game started in game', () => {
  let registered: string[];
  let setIds: { token: string; matchId: number; serverId: number }[];
  let notified: string[];

  function adopter(serverId: number) {
    registered = []; setIds = []; notified = [];
    return new SelfStartedMatches({
      db,
      listener: { register: (t) => registered.push(t) },
      setMatchId: async (token, matchId, sid) => { setIds.push({ token, matchId, serverId: sid }); },
      resolveServerId: () => serverId,
      adminSteamIds: [],
      notify: (m) => notified.push(m),
    });
  }

  async function burst(serverId: number, teamA: string[], teamB: string[]) {
    const s = adopter(serverId);
    const n = teamA.length + teamB.length;
    s.handle({ kind: 'match_create', token: TOKEN, map: MAP, players: n } as LogEvent, 'src');
    for (const id of teamA) s.handle({ kind: 'match_roster', token: TOKEN, steamid: id, team: 'a', name: id, joinedMap: 0 } as LogEvent, 'src');
    for (const id of teamB) s.handle({ kind: 'match_roster', token: TOKEN, steamid: id, team: 'b', name: id, joinedMap: 0 } as LogEvent, 'src');
    s.handle({ kind: 'match_create_end', token: TOKEN, players: n } as LogEvent, 'src');
    await vi.waitFor(() => expect(setIds.length).toBe(1));
  }

  const row = () => db.prepare(
    'SELECT kind, visibility, origin, booking_id, booking_side_a, rules_json, game_config FROM matches WHERE token = ?',
  ).get(TOKEN);

  it('adopts a game on a booked box as the booking\'s private scrim, leaving the box status alone', async () => {
    const id = readyBooking();
    await burst(3, SIDE_A, SIDE_B);
    expect(row()).toEqual({
      kind: 'scrim', visibility: 'participants', origin: 'in_game', booking_id: id, booking_side_a: 'a',
      rules_json: getBooking(db, id)!.rules_json, game_config: 'standard',
    });
    expect(getServer(db, 3)!.status).toBe('idle');
    expect(notified).toEqual([]);
    expect(getBooking(db, id)!.state).toBe('active');
    const mid = setIds[0].matchId;
    expect(registered).toEqual([TOKEN]);
    expect(setIds[0]).toEqual({ token: TOKEN, matchId: mid, serverId: 3 });
    const ev = db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'game_started'").all(id) as { detail: string }[];
    expect(ev.map((e) => JSON.parse(e.detail))).toEqual([{ matchId: mid }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_players WHERE match_id = ?').get(mid)).toEqual({ n: 6 });
  });

  it('links match team A to booking side b when side b\'s people are on it', async () => {
    const id = readyBooking();
    await burst(3, SIDE_B, SIDE_A);
    expect(row()).toMatchObject({ booking_id: id, booking_side_a: 'b' });
  });

  describe('on a box a booking holds while the booking is not running', () => {
    let problems: string[];
    let unsub: () => void;
    beforeEach(() => {
      problems = [];
      unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
    });
    afterEach(() => unsub());

    async function refusedBurst() {
      const s = adopter(3);
      s.handle({ kind: 'match_create', token: TOKEN, map: MAP, players: 6 } as LogEvent, 'src');
      for (const id of SIDE_A) s.handle({ kind: 'match_roster', token: TOKEN, steamid: id, team: 'a', name: id, joinedMap: 0 } as LogEvent, 'src');
      for (const id of SIDE_B) s.handle({ kind: 'match_roster', token: TOKEN, steamid: id, team: 'b', name: id, joinedMap: 0 } as LogEvent, 'src');
      s.handle({ kind: 'match_create_end', token: TOKEN, players: 6 } as LogEvent, 'src');
      // setMatchId is fire and forget; give a wrongly adopted match the same
      // chance to report itself that the adopting tests wait for.
      await new Promise((r) => setTimeout(r, 10));
    }

    function expectRefused() {
      expect(db.prepare('SELECT COUNT(*) AS n FROM matches').get()).toEqual({ n: 0 });
      expect(getServer(db, 3)!.status).toBe('idle');
      expect(notified).toEqual([]);
      expect(registered).toEqual([]);
      expect(setIds).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('booked server whose booking is not running');
    }

    it('refuses a game while the booking is still being set up', async () => {
      const id = readyBooking(3, 'setup');
      expect(getBooking(db, id)!.state).toBe('setup');
      await refusedBurst();
      expectRefused();
      expect(getBooking(db, id)!.state).toBe('setup');
    });

    it('refuses a game while the booking is ending', async () => {
      const id = readyBooking();
      db.prepare("UPDATE bookings SET ending_at = '2026-10-02T20:30:00.000Z' WHERE id = ?").run(id);
      await refusedBurst();
      expectRefused();
      expect(getBooking(db, id)!.state).toBe('ready');
    });
  });

  it('refuses a match started in-game while a recovering booking already has a live game', async () => {
    const id = readyBooking();
    // The booking's own game is still live (on a box other than the one this
    // burst targets: a dead box it has not let go of yet, or none at all),
    // so the busy check on server 3 alone would not catch this.
    db.prepare(
      "INSERT INTO matches (season_id, state, campaign, token, server_id, booking_id) VALUES (?, 'live', 'no_mercy', 'already-live', NULL, ?)",
    ).run(currentSeasonId(db), id);
    db.prepare("UPDATE bookings SET recovering_at = '2026-10-02T20:30:00.000Z', recover_reason = 'restart' WHERE id = ?").run(id);

    const s = adopter(3);
    s.handle({ kind: 'match_create', token: TOKEN, map: MAP, players: 6 } as LogEvent, 'src');
    for (const pid of SIDE_A) s.handle({ kind: 'match_roster', token: TOKEN, steamid: pid, team: 'a', name: pid, joinedMap: 0 } as LogEvent, 'src');
    for (const pid of SIDE_B) s.handle({ kind: 'match_roster', token: TOKEN, steamid: pid, team: 'b', name: pid, joinedMap: 0 } as LogEvent, 'src');
    s.handle({ kind: 'match_create_end', token: TOKEN, players: 6 } as LogEvent, 'src');
    await new Promise((r) => setTimeout(r, 10));

    expect(db.prepare('SELECT COUNT(*) AS n FROM matches').get()).toEqual({ n: 1 });
    expect(setIds).toEqual([]);
    expect(registered).toEqual([]);
  });

  it('adopts a game on a box no booking holds exactly as before', async () => {
    readyBooking();
    await burst(1, SIDE_A, SIDE_B);
    expect(row()).toEqual({
      kind: 'pug', visibility: 'public', origin: 'in_game', booking_id: null, booking_side_a: null,
      rules_json: null, game_config: null,
    });
    expect(getServer(db, 1)!.status).toBe('live');
    expect(notified).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE event = 'game_started'").get()).toEqual({ n: 0 });
  });
});

describe('the booking game read helpers', () => {
  function insertGame(bookingId: number, state: string, sideA: 'a' | 'b', token: string): number {
    return Number(db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id, booking_side_a, team_a_score, team_b_score)
       VALUES (?, ?, 'no_mercy', 3, ?, 'in_game', 'scrim', 'participants', ?, ?, 10, 20)`,
    ).run(currentSeasonId(db), state, token, bookingId, sideA).lastInsertRowid);
  }

  it('lists a booking\'s games oldest first and finds the live one', () => {
    const id = readyBooking();
    const first = insertGame(id, 'completed', 'b', 't1');
    const second = insertGame(id, 'live', 'a', 't2');
    // Another booking's game must not show up under this one.
    const other = Number(db.prepare(
      `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
       SELECT purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at
         FROM bookings WHERE id = ?`,
    ).run(id).lastInsertRowid);
    insertGame(other, 'live', 'a', 't3');
    expect(bookingGames(db, id).map((g) => [g.matchId, g.state, g.sideA, g.scoreA, g.scoreB, g.campaign]))
      .toEqual([[first, 'completed', 'b', 10, 20, 'no_mercy'], [second, 'live', 'a', 10, 20, 'no_mercy']]);
    expect(liveBookingGame(db, id)).toEqual({ id: second, token: 't2', campaign: 'no_mercy' });
  });

  it('aborts only a live booking game, returning its token', () => {
    const id = readyBooking();
    const live = insertGame(id, 'live', 'a', 't1');
    const done = insertGame(id, 'completed', 'a', 't2');
    const pug = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (?, 'live', 'no_mercy', 't3')")
      .run(currentSeasonId(db)).lastInsertRowid);
    const now = new Date('2026-10-02T21:00:00.000Z');
    expect(abortBookingGame(db, live, now)).toBe('t1');
    expect(db.prepare('SELECT state, abort_cause, ended_at FROM matches WHERE id = ?').get(live))
      .toEqual({ state: 'aborted', abort_cause: 'booking_ended', ended_at: '2026-10-02 21:00:00' });
    expect(abortBookingGame(db, live, now)).toBeNull();
    expect(abortBookingGame(db, done, now)).toBeNull();
    expect(abortBookingGame(db, pug, now)).toBeNull();
    expect(liveBookingGame(db, id)).toBeNull();
  });
});

describe('finishing a booking game', () => {
  const IDS = [...SIDE_A, ...SIDE_B];
  const dumpFor = (mid: number) => (cmd: string): string => {
    const nonce = cmd.split(' ')[2] ?? '';
    return [
      `DUMP match=${mid} skilldetect=0 nonce=${nonce} state=ended`,
      'MAP map=l4d_hospital01 a=245 b=310',
      ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 3 ? 'a' : 'b'} joined_map=0 sidmg=${100 + i} sikill=${i} ck=${i * 10} ff=${i} rev=${i}`),
      `END winner=b a=245 b=310 nonce=${nonce} state=ended`,
    ].join('\n');
  };

  let cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

  async function rig(booked: boolean) {
    let mid = 0;
    const srv = await fakeRconServer((cmd) => dumpFor(mid)(cmd));
    cleanup.push(srv.close);
    const serverId = booked ? 3 : 1;
    db.prepare('UPDATE servers SET host = ?, rcon_port = ? WHERE id = ?').run('127.0.0.1', srv.port, serverId);
    const bookingId = booked ? readyBooking(serverId) : null;
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const releaser = new ServerReleaser(db, async () => {});
    const released: unknown[][] = [];
    vi.spyOn(releaser, 'release').mockImplementation((...args: unknown[]) => { released.push(args); });
    const notified: string[] = [];
    const ended: number[] = [];
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500', releaser, makeRcon: (o) => o,
      notify: (m) => notified.push(m), onBookingGameEnded: (id) => ended.push(id),
    });
    mid = Number(db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id, booking_side_a)
       VALUES (?, 'live', 'no_mercy', ?, ?, 'in_game', ?, ?, ?, ?)`,
    ).run(currentSeasonId(db), serverId, TOKEN, booked ? 'scrim' : 'pug', booked ? 'participants' : 'public', bookingId, booked ? 'a' : null).lastInsertRowid);
    IDS.forEach((id, i) => db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, ?, 'udp')")
      .run(mid, id, i < 3 ? 'a' : 'b'));
    if (!booked) db.prepare("UPDATE servers SET status = 'live' WHERE id = ?").run(serverId);
    listener.register(TOKEN);
    return { orch, mid, serverId, released, notified, ended };
  }

  it('completes the game, keeps the box with the booking, says nothing in public and tells the runner', async () => {
    const { orch, mid, released, notified, ended } = await rig(true);
    expect(await orch.finishMatch(mid)).toBe('completed');
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as { state: string }).state).toBe('completed');
    expect(released).toEqual([]);
    expect(notified).toEqual([]);
    expect(ended).toEqual([mid]);
  });

  it('still releases a non-booking match with a restart and announces it', async () => {
    const { orch, mid, serverId, released, notified, ended } = await rig(false);
    expect(await orch.finishMatch(mid)).toBe('completed');
    expect(released).toEqual([[serverId, { restart: true }]]);
    expect(notified).toHaveLength(1);
    expect(ended).toEqual([]);
  });
});

describe('teamScrims', () => {
  function insertGame(bookingId: number, state: string, sideA: 'a' | 'b', scoreA: number, scoreB: number, token: string): number {
    return Number(db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id, booking_side_a, team_a_score, team_b_score)
       VALUES (?, ?, 'no_mercy', 3, ?, 'in_game', 'scrim', 'participants', ?, ?, ?, ?)`,
    ).run(currentSeasonId(db), state, token, bookingId, sideA, scoreA, scoreB).lastInsertRowid);
  }

  function teamBooking(o: { by: string; teamId?: number; opponent: { teamId: number } | { steamid: string }; startsAt: number }): number {
    const created = new Date(o.startsAt - 2 * 24 * 60 * MIN);
    const r = createBooking(db, {
      by: o.by, teamId: o.teamId, opponent: o.opponent, startsAt: new Date(o.startsAt).toISOString(), minutes: 120,
      playlist: ['no_mercy'], now: created,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  }

  it('lists only the team\'s own bookings, newest first, each game oriented to the team\'s own booking side', () => {
    const alpha = createTeam(db, { creator: P[0], name: 'Team Alpha', tag: 'ALF' });
    if (!alpha.ok) throw new Error(alpha.error);
    const teamId = alpha.value.id;

    // Booking 1: team Alpha books as side a against a pickup group (P4).
    const id1 = teamBooking({ by: P[0], teamId, opponent: { steamid: P[4] }, startsAt: START });
    insertGame(id1, 'completed', 'a', 10, 20, 't1'); // sideA matches the team's side: us is scoreA
    insertGame(id1, 'completed', 'b', 30, 5, 't2'); // sideA is the other side: us is scoreB

    // Booking 2: a pickup group (P5) books against team Alpha, who is side b.
    const id2 = teamBooking({ by: P[5], opponent: { teamId }, startsAt: START + 24 * 60 * MIN });
    insertGame(id2, 'completed', 'b', 7, 2, 't3'); // sideA matches the team's side (b): us is scoreA
    insertGame(id2, 'live', 'a', 1, 9, 't4'); // sideA is the other side: us is scoreB

    // A booking team Alpha was never in must never be listed.
    teamBooking({ by: P[6], opponent: { steamid: P[7] }, startsAt: START + 2 * 24 * 60 * MIN });

    const scrims = teamScrims(db, teamId);
    expect(scrims.map((s) => s.bookingId)).toEqual([id2, id1]);

    const s1 = scrims.find((s) => s.bookingId === id1)!;
    expect(s1.opponent).toBe("p4's group");
    expect(s1.state).toBe('scheduled');
    expect(s1.games.map((g) => [g.matchId, g.campaign, g.state, g.us, g.them])).toEqual([
      [expect.any(Number), 'no_mercy', 'completed', 10, 20],
      [expect.any(Number), 'no_mercy', 'completed', 5, 30],
    ]);

    const s2 = scrims.find((s) => s.bookingId === id2)!;
    expect(s2.opponent).toBe("p5's group");
    expect(s2.games.map((g) => [g.us, g.them])).toEqual([[7, 2], [9, 1]]);
  });

  it('exposes each booking\'s purpose, keeping a tournament booking in the list', () => {
    const alpha = createTeam(db, { creator: P[0], name: 'Team Alpha', tag: 'ALF' });
    if (!alpha.ok) throw new Error(alpha.error);
    const scrimId = teamBooking({ by: P[0], teamId: alpha.value.id, opponent: { steamid: P[4] }, startsAt: START });
    const cupId = teamBooking({ by: P[0], teamId: alpha.value.id, opponent: { steamid: P[5] }, startsAt: START + 24 * 60 * MIN });
    db.prepare("UPDATE bookings SET purpose = 'tournament' WHERE id = ?").run(cupId);
    const scrims = teamScrims(db, alpha.value.id);
    expect(scrims.map((s) => [s.bookingId, s.purpose])).toEqual([[cupId, 'tournament'], [scrimId, 'scrim']]);
  });

  it('never lists another team\'s bookings', () => {
    const alpha = createTeam(db, { creator: P[0], name: 'Team Alpha', tag: 'ALF' });
    const bravo = createTeam(db, { creator: P[1], name: 'Team Bravo', tag: 'BRV' });
    if (!alpha.ok || !bravo.ok) throw new Error('setup');
    teamBooking({ by: P[1], teamId: bravo.value.id, opponent: { steamid: P[4] }, startsAt: START });
    expect(teamScrims(db, alpha.value.id)).toEqual([]);
  });
});
