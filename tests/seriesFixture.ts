import { vi, type MockInstance } from 'vitest';
import type { DB } from '../src/db.js';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import * as B from '../src/bookings/bookings.js';
import { addServer, type ServerRow } from '../src/serverPool.js';
import { BookingRunner } from '../src/bookings/runner.js';
import { Notifier } from '../src/notify/notify.js';
import { SeriesEngine, lateHooks } from '../src/events/series.js';
import { RoomClock } from '../src/events/roomClock.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import type { ServerReleaser } from '../src/serverRelease.js';
import { parseLogDatagram } from '../src/logParse.js';
import { handleModCall } from '../src/modCalls.js';
import { recordPresenceLine } from '../src/presence.js';
import { NOW } from './eventFixture.js';
import { A, B as BATS } from './entryFixture.js';
import { POOL7, TIMERS, driveToBooking, roomFixture, type RoomFixture } from './roomFixture.js';

/** A room driven to `booking` (both lineups locked), one idle server, a
 *  booking runner on a fake box, the series engine and the room clock, all on
 *  one controllable clock (plan T3b). Ban to one by default: game 1 is
 *  no_mercy and Bats (entry b) start as survivors, so match team a is Bats
 *  and booking_side_a is 'b'. */
export const MIN = 60_000;
export interface SeriesFixture extends RoomFixture {
  t: { t: number }; runner: BookingRunner; series: SeriesEngine; clock: RoomClock;
  sent: string[];
  /** subOk / freezeOk: pug-match takes sm_pug_sub / sm_pug_adminpause (else it answers PUGERR subErr / PUGERR no match configured).
   *  failOn: an rcon burst with a command starting with this throws (the connection dropped on it), as `down` does for every burst. */
  box: { map: string; humans: string[]; down: boolean; resumeOk: boolean; subOk: boolean; subErr: string; freezeOk: boolean; failOn: string | null; pug: { state: string; match: number } }; send: MockInstance; alerts: AdminEvent[]; pushes: number[];
  /** The room clock (which ticks the series engine), then the runner's
   *  minute pass, then any tracked work. */
  tick(): Promise<void>;
  /** One more idle, enabled dlc4 box (a higher id than the first, so a
   *  booking's pickBox takes it first). The rcon fake answers for every box. */
  addServer(name: string): number;
  match(): P.MatchRow; booking(): B.BookingRow; gameOf(ordinal: number): R.GameRow;
  /** The plugin's MATCH_START for a pushed game: the heartbeat row, then the engine. */
  goLive(gameMatchId: number, map?: string): void;
  /** The orchestrator finished a game with these per-map scores (match team a first; half1Surv is who survived first on that map), then the runner's hook. */
  endGame(gameMatchId: number, maps: { map: string; a: number; b: number; half1Surv?: 'a' | 'b' }[]): void;
  /** The token of the game being played now (a live matches row of this match's booking). */
  liveGameToken(): string;
  /** One log line (`PUG <token> ...` or `PUGCALL ...`) parsed as the listener
   *  would, dispatched as src/server.ts does, then the tracked work. */
  line(body: string): Promise<void>;
  close(): void;
}

const steam2 = (sid: string) => { const n = BigInt(sid) - 76561197960265728n; return `STEAM_1:${n % 2n}:${n / 2n}`; };

export async function seriesFixture(o: {
  veto?: object; pool?: string[]; drive?: (f: RoomFixture) => void;
  /** The real releaser instead of the fake that sets a box idle at once,
   *  wired as src/server.ts wires it (forced restart, booking: true, and a
   *  freed box wakes the runner's allocate). */
  releaser?: (db: DB) => ServerReleaser;
} = {}): Promise<SeriesFixture> {
  const f = await roomFixture({ veto: o.veto, pool: o.pool });
  (o.drive ?? driveToBooking)(f);
  const serverId = addServer(f.db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
  // dlc4: POOL7 carries L4D2 campaigns (dark_carnival, dead_center, swamp_fever).
  f.db.prepare("UPDATE servers SET status = 'idle', has_dlc4 = 1 WHERE id = ?").run(serverId);
  const t = { t: NOW.getTime() + 10 * MIN };
  const sent: string[] = [];
  const box = { map: 'l4d_vs_hospital01_apartment', humans: [] as string[], down: false, resumeOk: false, subOk: true, subErr: 'not rostered', freezeOk: true, failOn: null as string | null, marker: '', type: 'Rotoblin Pub VS', pug: { state: 'none', match: 0 } };
  const status = () => [
    'hostname: test', `map     : ${box.map} at: 0 x, 0 y, 0 z`, `players : ${box.humans.length} humans, 0 bots (31 max)`,
    '# userid name uniqueid connected ping loss state rate adr',
    ...box.humans.map((sid, i) => `#  ${i + 2} ${i + 1} "h${i}" ${steam2(sid)} 01:12 33 0 active 128000 10.0.0.${i}:27005`),
  ].join('\n');
  const rcon = async (_s: ServerRow, cmds: string[]): Promise<string[]> => {
    if (box.down) throw new Error('rcon connect timeout');
    const failOn = box.failOn;
    if (failOn !== null && cmds.some((c) => c.startsWith(failOn))) throw new Error('rcon read timeout');
    return cmds.map((c) => {
      sent.push(c);
      if (c === 'status') return status();
      // pug-match's own state (sm_pug_status), as the plugin keeps it across a changelevel.
      if (c === 'sm_pug_status') return `STATUS state=${box.pug.state} match=${box.pug.match} token=(none) campaign=(none) map=${box.map} stopAfterMap=(none)\nSTATUS end`;
      const pm = /^sm_pug_match (\d+) /.exec(c);
      if (pm) box.pug = { state: 'pending', match: Number(pm[1]) };
      // pug-match's answer to a restore (plan 5): taken, or refused.
      if (c === 'sm_pug_resume_commit') return box.resumeOk ? 'PUGOK resumed maps=0 roster=8' : 'PUGERR resume incomplete';
      // pug-match 0.3.25's answers (plugin/pug-tourney.inc Cmd_PugSub, Cmd_AdminPause).
      const sub = /^sm_pug_sub \S+ (\d+) (\d+)$/.exec(c);
      if (sub) return box.subOk ? `PUGOK sub out=${sub[1]} in=${sub[2]} slot=8` : `PUGERR ${box.subErr}`;
      const ap = /^sm_pug_adminpause \S+ (on|off)\b/.exec(c);
      if (ap) return box.freezeOk ? `PUGOK adminpause=${ap[1]} frozen=${ap[1] === 'on' ? 1 : 0}` : 'PUGERR no match configured';
      if (c === 'l4d_game_type_name') return `"l4d_game_type_name" = "${box.type}" ( def. "" )`;
      if (c === 'l4d_booking_version') return '"l4d_booking_version" = "1.4.0" ( def. "1.0.0" )';
      if (c === 'l4d_booking_id') return `"l4d_booking_id" = "${box.marker}" ( def. "" )`;
      const mk = /^l4d_booking_id "(\d*)"$/.exec(c);
      if (mk) box.marker = mk[1]!;
      if (c === 'exec pug_match') box.type = 'Rotoblin 4v4 PUG';
      const m = /^changelevel (\S+)$/.exec(c);
      if (m) box.map = m[1]!;
      return '';
    });
  };
  const notifier = new Notifier({ db: f.db, dm: () => async () => {} });
  const send = vi.spyOn(notifier, 'send');
  const alerts: AdminEvent[] = [];
  const unsubscribe = subscribeAdminEvents((e) => alerts.push(e));
  const pushes: number[] = [];
  let series: SeriesEngine | null = null;
  const releaser = o.releaser?.(f.db) ?? null;
  let extra = 0;
  const runner = new BookingRunner({
    db: f.db, publicUrl: 'https://x', rcon,
    release: releaser
      ? (id, opts) => new Promise<boolean>((resolve) => {
        releaser.release(id, { restart: true, forceRestart: true, booking: true, gone: opts?.gone ?? false }, resolve);
      })
      // As the real releaser's forced restart: offline at once, before the
      // first await, and idle again once the restart answers.
      : async (id) => {
        f.db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(id);
        await Promise.resolve();
        f.db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
        return true;
      },
    ...(releaser ? { releasing: (id: number) => releaser.isRestarting(id) } : {}),
    restart: async () => { box.map = 'l4d_vs_hospital01_apartment'; box.marker = ''; box.type = 'Rotoblin Pub VS'; box.pug = { state: 'none', match: 0 }; return true; },
    notifier, preempt: () => {}, sleep: async () => {}, now: () => t.t, tournament: lateHooks(() => series),
  });
  releaser?.onFreed(() => runner.allocate());
  series = new SeriesEngine({ db: f.db, runner, notifier, publicUrl: 'https://x', push: (id) => pushes.push(id), registerToken: () => {}, now: () => t.t });
  const clock = new RoomClock({ db: f.db, notifier, publicUrl: 'https://x', push: (id) => pushes.push(id), now: () => t.t, seed: () => 0, series });
  const db: DB = f.db;
  // The engine's forfeit and automatic result run as untracked promise
  // chains (forfeitMatch, autoResultFlow): a macrotask turn after the
  // runner's work lets them land, and a second idle collects the wind-down
  // a forfeit starts.
  const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await runner.idle(); };
  return {
    ...f, t, runner, series, clock, sent, box, send, alerts, pushes,
    async tick() { await clock.tick(); await runner.tick(); await runner.idle(); await settle(); },
    addServer(name) {
      const id = addServer(db, { name, host: '10.0.0.2', port: 27100 + (extra += 1), rconPort: 1, rconPassword: 'x' });
      db.prepare("UPDATE servers SET status = 'idle', has_dlc4 = 1 WHERE id = ?").run(id);
      return id;
    },
    match: () => P.getMatch(db, f.matchId)!,
    booking: () => B.getBooking(db, P.getMatch(db, f.matchId)!.booking_id!)!,
    gameOf: (ordinal) => R.gamesOf(db, f.matchId).find((g) => g.ordinal === ordinal)!,
    goLive(gameMatchId, map = box.map) {
      db.prepare("INSERT OR REPLACE INTO match_live (match_id, current_map, last_seen) VALUES (?, ?, datetime('now'))").run(gameMatchId, map);
      series!.gameStarted(gameMatchId);
    },
    endGame(gameMatchId, maps) {
      const a = maps.reduce((n, m) => n + m.a, 0);
      const b = maps.reduce((n, m) => n + m.b, 0);
      db.prepare("UPDATE matches SET state = 'completed', team_a_score = ?, team_b_score = ?, winner = ?, ended_at = datetime('now') WHERE id = ?")
        .run(a, b, a > b ? 'a' : b > a ? 'b' : 'draw', gameMatchId);
      const insMap = db.prepare('INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)');
      const insRound = db.prepare("INSERT OR REPLACE INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
      maps.forEach((m, i) => {
        insMap.run(gameMatchId, i, m.map, m.a, m.b);
        const first = m.half1Surv ?? 'a';
        insRound.run(gameMatchId, i, 1, first, first === 'a' ? m.a : m.b);
        insRound.run(gameMatchId, i, 2, first === 'a' ? 'b' : 'a', first === 'a' ? m.b : m.a);
      });
      db.prepare('DELETE FROM match_live WHERE match_id = ?').run(gameMatchId);
      runner.onGameEnded(gameMatchId);
    },
    liveGameToken: () => (db.prepare("SELECT token FROM matches WHERE booking_id = ? AND state = 'live' ORDER BY id DESC LIMIT 1")
      .get(P.getMatch(db, f.matchId)!.booking_id!) as { token: string }).token,
    async line(body) {
      const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]);
      const ev = parseLogDatagram(Buffer.concat([head, Buffer.from(`L 10/07/2026 - 20:00:00: ${body}\n`, 'utf8')]));
      if (!ev) throw new Error(`fixture line did not parse: ${body}`);
      if (ev.kind === 'sub_request') await series!.subRequested(ev.token, ev.by, ev.out, ev.in);
      else if (ev.kind === 'admin_pause') series!.adminPauseLine(ev.token, ev.on, ev.by, ev.cause);
      else if (ev.kind === 'call') handleModCall(db, ev, serverId, { adminSteamIds: [], now: new Date(t.t) });
      // As server.ts: a PLAYER disconnect reaches nothing (only connect is recorded), LEAVE and RETURN the presence table.
      else if ((ev.kind === 'player' && ev.event === 'connect') || ev.kind === 'leave' || ev.kind === 'return') recordPresenceLine(db, ev, new Date(t.t));
      else if (ev.kind === 'player') { /* disconnect: not a writer (src/presence.ts) */ }
      else throw new Error(`fixture line is not dispatched here: ${ev.kind}`);
      await settle();
    },
    close: () => { unsubscribe(); },
  };
}

/** The room test's loser picks opening (POOL7, Bo3 ban to three): Rats go
 *  first, four bans, Rats pick POOL7[5] for game 1, Bats survive first, both
 *  lineups locked. Use with seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks }). */
export function driveLoserPicks(f: RoomFixture): void {
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
  const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
  ok(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
  ok(R.readyUp(f.db, { matchId: f.matchId, steamid: A[0]!, timers: TIMERS, now: at(1) }));
  ok(R.readyUp(f.db, { matchId: f.matchId, steamid: BATS[0]!, timers: TIMERS, now: at(1) }));
  const steps: [string, number, string, string | null][] = [
    [A[0]!, 0, 'first', null], [A[0]!, 1, 'ban', POOL7[0]!], [BATS[0]!, 2, 'ban', POOL7[1]!], [A[0]!, 3, 'ban', POOL7[2]!], [BATS[0]!, 4, 'ban', POOL7[3]!],
    [A[0]!, 5, 'pick', POOL7[5]!], [BATS[0]!, 6, 'survivors', null],
  ];
  for (const [who, step, action, campaign] of steps) ok(R.actVeto(f.db, { matchId: f.matchId, steamid: who, step, action, campaign, timers: TIMERS, now: at(2) }));
  ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0]!, steamids: A.slice(0, 4), timers: TIMERS, now: at(4) }));
  ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: BATS[0]!, steamids: BATS.slice(0, 4), timers: TIMERS, now: at(4) }));
}
