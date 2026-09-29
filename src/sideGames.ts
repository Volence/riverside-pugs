/**
 * Queue side games: a 2v2 or 3v3 on a free box while the PUG queue fills.
 * See docs/superpowers/specs/2026-09-28-queue-side-games-design.md.
 *
 * State lives in memory, like the matchmaker's. The only table is
 * side_games, and a row there does one thing: it holds the box (the box
 * stays 'idle' in servers, and NOT_LEASED_SQL keeps claimIdle and friends
 * away from it, the practice_leases pattern). Nothing about a side game is
 * recorded anywhere else.
 *
 * The rules (sizes, who sits out, who subs in) are the pure functions in
 * src/sideGameRules.ts; this file applies them to the queue, the box and the
 * PUGSIDE log lines from plugin/pug-sidegame.sp.
 */
import type { DB } from './db.js';
import { NOT_LEASED_SQL, getServer, type ServerRow } from './serverPool.js';
import { openLeases, matchesWaiting, type LeaseRcon } from './practiceLeases.js';
import { newToken } from './matchToken.js';
import { getRatings } from './players.js';
import { balanceTeams } from './balance.js';
import { campaignRegistry, campaignDisplayName } from './campaignRegistry.js';
import { campaignForMap } from './campaigns.js';
import { getSetting } from './settings.js';
import { sizeFor, choosePlaying, onLeave, type SideCandidate, type SideSize } from './sideGameRules.js';
import type { LobbySnapshot } from './lobby.js';
import type { MatchmakerListener } from './matchmaker.js';
import type { SideLogEvent } from './logParse.js';

export const RECONNECT_GRACE_MS = 90_000;
export const CLOSE_GRACE_MS = 180_000;
/** After a box refuses to open a side game, wait this long before trying again. */
const OPEN_RETRY_MS = 60_000;
const CONFIG: Record<SideSize, string> = { 2: 'rotoblin_hardcore_2v2', 3: 'rotoblin_hardcore_3v3' };
const FALLBACK_FIRST_MAP = 'l4d_vs_hospital01_apartment';

/** The part of the Matchmaker a side game reads. */
export interface SideQueue {
  sideCandidates(): string[];
  queuePosition(steamid: string): number;
  lobbyOf(steamid: string): LobbySnapshot | null;
  lobbies(): { id: string; snapshot: LobbySnapshot }[];
  ready(steamid: string): { ok: boolean; error?: string };
  vote(steamid: string, campaign: string): boolean;
  on(l: MatchmakerListener): void;
}

export interface SideGameDeps {
  db: DB;
  queue: SideQueue;
  rcon: LeaseRcon;
  /** Forced-restart release (ServerReleaser, forceRestart). True when the box came back. */
  release: (serverId: number) => Promise<boolean>;
  /** Hub 'refresh'. */
  broadcast: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  rng?: () => number;
}

export interface SideGameView {
  phase: 'running' | 'popped' | 'closing';
  size: SideSize | null;
  players: number;
  youIn: boolean;
  connect: { host: string; port: number; password: string } | null;
}

export interface SideLogLine {
  event: SideLogEvent;
  token: string;
  steamid: string | null;
  map: string | null;
  campaign: string | null;
}

type Team = 'A' | 'B' | 'S';
interface Seat { steamid: string; team: Team }
type Timer = { cancel(): void };

interface Active {
  rowId: number;
  server: ServerRow;
  token: string;
  password: string;
  phase: 'running' | 'popped' | 'closing';
  size: SideSize;
  /** The roster as last pushed. Gone players stay here as S until they
   *  rejoin or leave the queue. */
  seats: Seat[];
  /** Anyone has joined the box yet. Until then nobody is benched for not
   *  being connected. */
  seen: boolean;
  connected: Set<string>;
  away: Map<string, Timer>;
  gone: Set<string>;
  satOut: Map<string, number>;
  played: Map<string, number>;
  /** The lobby this game popped into, and whether it just failed (the
   *  matchmaker requeues its players after lobbyFailed, so the resume
   *  decision waits for the stateChanged that follows). */
  poppedLobby: string | null;
  resumePending: boolean;
  voteSentFor: string | null;
  closeTimer: Timer | null;
}

export class SideGames {
  private active: Active | null = null;
  private work: Promise<void> = Promise.resolve();
  private retryAfter = 0;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<SideGameDeps['setTimer']>;
  private readonly rng: () => number;

  constructor(private readonly deps: SideGameDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    });
    this.rng = deps.rng ?? Math.random;
    // One listener for the life of the manager. The vote menu rides on the
    // same event: the lobby moving to map_vote is a state change.
    deps.queue.on({
      stateChanged: () => { this.sync(); this.maybeSendVote(); },
      lobbyStarted: (id, players) => this.onPop(id, players),
      lobbyFailed: (id) => this.onLobbyFailed(id),
    });
  }

  /** Rcon in order, one batch at a time, never throwing into the caller.
   *  `ok` inspects the replies; false (or a throw) runs `onFail`. */
  private send(server: ServerRow, commands: string[], ok?: (replies: string[]) => boolean, onFail?: () => void): void {
    this.work = this.work
      .then(() => this.deps.rcon(server, commands))
      .then((replies) => { if (ok && !ok(replies)) throw new Error(`refused: ${replies.join(' | ')}`); })
      .catch((err) => {
        console.warn(`[sidegame] rcon to ${server.name} failed:`, err instanceof Error ? err.message : err);
        onFail?.();
      });
  }

  /** Resolves once every queued rcon batch and release has run, including
   *  work queued while waiting (tests). */
  async settled(): Promise<void> {
    let w: Promise<void>;
    do { w = this.work; await w; } while (w !== this.work);
  }

  private enabled(): boolean { return getSetting(this.deps.db, 'sidegames_enabled') === '1'; }

  private minPlayers(): number {
    return Math.max(4, Number(getSetting(this.deps.db, 'sidegames_min_players') ?? 4) || 4);
  }

  /** Re-evaluate from the queue. Called on every matchmaker state change. */
  sync(): void {
    const a = this.active;
    if (!a) { this.maybeOpen(this.deps.queue.sideCandidates()); return; }
    if (a.phase === 'popped') {
      // A pop takes the eight out of the queue; they are not leavers. Only a
      // failed lobby, once its players are back in the queue, ends the pop.
      if (!a.resumePending) return;
      a.resumePending = false;
      const cands = this.deps.queue.sideCandidates();
      if (cands.length >= this.minPlayers()) { this.restart(a, cands); return; }
      this.send(a.server, ['sm_side_resume']);
      a.seats = cands.map((steamid) => ({ steamid, team: 'S' }));
      this.windDown(a);
      return;
    }
    const cands = this.deps.queue.sideCandidates();
    if (a.phase === 'closing') {
      // Held for CLOSE_GRACE_MS after dropping under 4: back to the minimum
      // reopens on the same box. The plugin already has everyone as S.
      if (cands.length >= this.minPlayers()) this.restart(a, cands);
      else a.seats = cands.map((steamid) => ({ steamid, team: 'S' }));
      return;
    }
    for (const s of a.seats.map((x) => x.steamid)) {
      if (!cands.includes(s)) this.gone(a, s, 'left');
      if (a.phase !== 'running') return;
    }
    const added = cands.filter((c) => !a.seats.some((s) => s.steamid === c));
    if (added.length) {
      a.seats = [...a.seats, ...added.map((steamid) => ({ steamid, team: 'S' as const }))];
      this.pushRoster(a);
    }
  }

  private maybeOpen(cands: string[]): void {
    if (!this.enabled() || cands.length < this.minPlayers()) return;
    if (this.now() < this.retryAfter || matchesWaiting(this.deps.db) > 0) return;
    // The lowest id claimable box: the one claimIdle would give the match.
    const server = this.deps.db.prepare(
      `SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 AND ${NOT_LEASED_SQL} ORDER BY id LIMIT 1`,
    ).get() as ServerRow | undefined;
    if (!server) return;
    const token = newToken();
    const password = `side_${token.slice(0, 8)}`;
    const rowId = Number(this.deps.db.prepare(
      'INSERT INTO side_games (server_id, token, password) VALUES (?, ?, ?)',
    ).run(server.id, token, password).lastInsertRowid);
    const size = sizeFor(Math.min(cands.length, 7))!;
    const a: Active = {
      rowId, server, token, password, phase: 'running', size, seats: [], seen: false,
      connected: new Set(), away: new Map(), gone: new Set(), satOut: new Map(), played: new Map(),
      poppedLobby: null, resumePending: false, voteSentFor: null, closeTimer: null,
    };
    a.seats = this.lineup(a, cands, size);
    this.active = a;
    console.log(`[sidegame] opening a ${size}v${size} on ${server.name} for ${cands.length} players`);
    const commands = [
      `sv_password "${password}"`,
      `exec ${CONFIG[size]}`,
      `sm_side_start ${token} ${password}`,
      this.rosterCommand(a.seats),
      `changelevel ${this.randomFirstMap(null)}`,
    ];
    // Without the plugin armed there is no team lock and no tracking guard,
    // so a refused sm_side_start closes the game and backs off.
    this.send(server, commands, (r) => (r[2] ?? '').startsWith('PUGOK'), () => {
      if (this.active !== a) return;
      this.retryAfter = this.now() + OPEN_RETRY_MS;
      this.close('rcon_failed');
    });
    this.deps.broadcast();
  }

  private candidateOf(a: Active, steamid: string): SideCandidate {
    return {
      steamid,
      connected: !a.gone.has(steamid) && (!a.seen || a.connected.has(steamid)),
      queuePos: this.deps.queue.queuePosition(steamid),
      satOut: a.satOut.get(steamid) ?? 0,
      playedStreak: a.played.get(steamid) ?? 0,
    };
  }

  /** Candidates to seats: who plays (rules), then SR-balanced A/B, bench as S. */
  private lineup(a: Active, cands: string[], size: SideSize): Seat[] {
    const { playing, bench } = choosePlaying(cands.map((c) => this.candidateOf(a, c)), size);
    const ratings = getRatings(this.deps.db, playing);
    const { teamA, teamB } = balanceTeams(playing.map((steamid) => {
      const r = ratings.get(steamid)!;
      return { steamid, mu: r.mu, sigma: r.sigma };
    }));
    return [
      ...teamA.map((steamid) => ({ steamid, team: 'A' as const })),
      ...teamB.map((steamid) => ({ steamid, team: 'B' as const })),
      ...bench.map((steamid) => ({ steamid, team: 'S' as const })),
    ];
  }

  /** Everyone not gone, lined up at `size`, with the gone kept as S. */
  private relineup(a: Active, size: SideSize): Seat[] {
    const present = a.seats.map((s) => s.steamid).filter((s) => !a.gone.has(s));
    return [...this.lineup(a, present, size), ...[...a.gone].map((steamid) => ({ steamid, team: 'S' as const }))];
  }

  private rosterCommand(seats: Seat[]): string {
    return `sm_side_roster ${seats.map((s) => `${s.steamid}:${s.team}`).join(' ')}`;
  }

  private pushRoster(a: Active): void {
    this.send(a.server, [this.rosterCommand(a.seats)]);
    this.deps.broadcast();
  }

  onLog(ev: SideLogLine): void {
    const a = this.active;
    if (!a || ev.token !== a.token) return;
    const id = ev.steamid;
    switch (ev.event) {
      case 'join': if (id) this.onJoin(a, id); break;
      case 'part': if (id) this.onPart(a, id); break;
      case 'ready': if (id && a.phase === 'popped') this.onReady(a, id); break;
      case 'vote': if (id && ev.campaign && a.phase === 'popped') this.deps.queue.vote(id, ev.campaign); break;
      case 'mapend': this.onMapEnd(a, ev.map); break;
      case 'mapstart': this.onMapStart(a); break;
    }
  }

  private onJoin(a: Active, id: string): void {
    a.seen = true;
    a.connected.add(id);
    a.away.get(id)?.cancel();
    a.away.delete(id);
    // Back after the grace ran out: an ordinary sitter again, and counted
    // for the size at the next mapstart.
    if (a.gone.delete(id)) this.deps.broadcast();
  }

  private onPart(a: Active, id: string): void {
    a.connected.delete(id);
    if (!a.seats.some((s) => s.steamid === id) || a.away.has(id) || a.gone.has(id)) return;
    a.away.set(id, this.setTimer(() => {
      a.away.delete(id);
      if (this.active === a && a.phase === 'running' && !a.connected.has(id)) this.gone(a, id, 'disconnected');
    }, RECONNECT_GRACE_MS));
  }

  private onReady(a: Active, id: string): void {
    const r = this.deps.queue.ready(id);
    if (r.ok) return;
    const text = `Not ready: ${r.error ?? 'try again on the site'}`.replace(/"/g, "'");
    this.send(a.server, [`sm_side_notice ${id} "${text}"`]);
  }

  /**
   * A player is out: left the queue (dropped from the seats), or the
   * reconnect grace ran out (kept as a gone S, so a rejoin brings them
   * back). Shrinking is handled at once: sub, rebuild smaller, or wind down.
   */
  private gone(a: Active, id: string, why: 'left' | 'disconnected'): void {
    const seat = a.seats.find((s) => s.steamid === id);
    if (!seat) return;
    a.away.get(id)?.cancel();
    a.away.delete(id);
    if (why === 'left') {
      a.gone.delete(id);
      a.seats = a.seats.filter((s) => s.steamid !== id);
    } else {
      a.gone.add(id);
      a.seats = a.seats.map((s) => (s.steamid === id ? { ...s, team: 'S' } : s));
    }
    if (seat.team === 'S') {
      if (why === 'left') this.pushRoster(a);
      return;
    }
    const stillIn = a.seats.filter((s) => !a.gone.has(s.steamid)).map((s) => this.candidateOf(a, s.steamid));
    const bench = stillIn.filter((c) => a.seats.find((s) => s.steamid === c.steamid)!.team === 'S');
    const action = onLeave(stillIn, bench);
    if (action.kind === 'close') { this.windDown(a); return; }
    if (action.kind === 'sub') {
      a.seats = a.seats.map((s) => (s.steamid === action.steamid ? { ...s, team: seat.team } : s));
      this.pushRoster(a);
      return;
    }
    a.size = action.size;
    a.seats = this.relineup(a, action.size);
    // The config ends in sm_restartmap: this restarts the map at the new size.
    this.send(a.server, [`exec ${CONFIG[action.size]}`, this.rosterCommand(a.seats)]);
    this.deps.broadcast();
  }

  /** Under 4: stop the game at once but hold the box for CLOSE_GRACE_MS, in
   *  case someone opts in or reconnects. sync() reopens it; the timer closes. */
  private windDown(a: Active): void {
    a.phase = 'closing';
    a.poppedLobby = null;
    a.seats = a.seats.map((s) => ({ ...s, team: 'S' }));
    this.send(a.server, [
      this.rosterCommand(a.seats),
      'say [Side] Not enough players. The side game restarts if someone joins in the next 3 minutes.',
    ]);
    a.closeTimer?.cancel();
    a.closeTimer = this.setTimer(() => {
      if (this.active === a && a.phase === 'closing') this.close('too_few');
    }, CLOSE_GRACE_MS);
    this.deps.broadcast();
  }

  /** Back to running on the box already held (closing, or a failed pop). */
  private restart(a: Active, cands: string[]): void {
    const size = sizeFor(Math.min(cands.length, 7))!;
    const wasPopped = a.phase === 'popped';
    a.closeTimer?.cancel();
    a.closeTimer = null;
    a.phase = 'running';
    a.size = size;
    a.poppedLobby = null;
    a.voteSentFor = null;
    a.gone.clear();
    a.seats = this.lineup(a, cands, size);
    this.send(a.server, [...(wasPopped ? ['sm_side_resume'] : []), `exec ${CONFIG[size]}`, this.rosterCommand(a.seats)]);
    this.deps.broadcast();
  }

  private onMapEnd(a: Active, map: string | null): void {
    if (a.phase !== 'running') return;
    for (const s of a.seats) {
      if (s.team === 'S') {
        a.satOut.set(s.steamid, (a.satOut.get(s.steamid) ?? 0) + 1);
        a.played.set(s.steamid, 0);
      } else {
        a.played.set(s.steamid, (a.played.get(s.steamid) ?? 0) + 1);
        a.satOut.set(s.steamid, 0);
      }
    }
    if (map && this.isFinale(map)) this.send(a.server, [`changelevel ${this.randomFirstMap(campaignForMap(map))}`]);
  }

  /**
   * Growth and rotation land here, at the start of the next map: an exec at
   * map end would restart the map just finished. The lineup is worked out
   * now from the counters onMapEnd updated, so a leave in between cannot
   * leave a stale plan behind. Idempotent: the restart an exec causes logs
   * another mapstart, which then finds nothing to change.
   */
  private onMapStart(a: Active): void {
    if (a.phase !== 'running') return;
    const present = a.seats.filter((s) => !a.gone.has(s.steamid)).length;
    const size = sizeFor(Math.min(present, 7));
    if (!size) return;
    const seats = this.relineup(a, size);
    const cmds: string[] = [];
    if (size !== a.size) cmds.push(`exec ${CONFIG[size]}`);
    const key = (xs: Seat[]) => xs.map((s) => `${s.steamid}:${s.team}`).sort().join(' ');
    if (size !== a.size || key(seats) !== key(a.seats)) cmds.push(this.rosterCommand(seats));
    a.size = size;
    a.seats = seats;
    if (cmds.length) { this.send(a.server, cmds); this.deps.broadcast(); }
  }

  private onPop(lobbyId: string, players: string[]): void {
    const a = this.active;
    if (!a || a.phase === 'popped' || !a.seats.some((s) => players.includes(s.steamid))) return;
    a.closeTimer?.cancel();
    a.closeTimer = null;
    a.phase = 'popped';
    a.poppedLobby = lobbyId;
    a.resumePending = false;
    this.send(a.server, ['sm_side_popped']);
    this.deps.broadcast();
  }

  private maybeSendVote(): void {
    const a = this.active;
    if (!a || a.phase !== 'popped' || a.voteSentFor === a.poppedLobby) return;
    const lobby = this.deps.queue.lobbies().find((l) => l.id === a.poppedLobby)?.snapshot;
    if (!lobby || lobby.phase !== 'map_vote') return;
    a.voteSentFor = lobby.id;
    const opts = lobby.options.map((slug) => `"${slug}=${campaignDisplayName(this.deps.db, slug).replace(/"/g, "'")}"`);
    this.send(a.server, [`sm_side_vote ${opts.join(' ')}`]);
  }

  private onLobbyFailed(lobbyId: string): void {
    const a = this.active;
    if (a?.phase === 'popped' && a.poppedLobby === lobbyId) a.resumePending = true;
  }

  /** The pop's match takes the held box, if the campaign can run there. */
  takeForMatch(_campaign: string, runsOn: (server: ServerRow) => boolean): { server: ServerRow; firstCommands: string[] } | null {
    const a = this.active;
    if (!a) return null;
    const server = getServer(this.deps.db, a.server.id);
    if (!server || !runsOn(server)) { this.close('campaign'); return null; }
    const db = this.deps.db;
    const took = db.transaction(() => {
      if (db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ? AND status = 'idle'").run(server.id).changes !== 1) return false;
      db.prepare("UPDATE side_games SET end_reason = 'match', ended_at = datetime('now') WHERE id = ?").run(a.rowId);
      return true;
    })();
    if (!took) { this.close('campaign'); return null; }
    this.stopTimers(a);
    this.active = null;
    this.deps.broadcast();
    return { server: { ...server, status: 'reserved' }, firstCommands: [`sm_side_stop ${a.token}`] };
  }

  /** A match waits with no free box. A practice lease is preempted first;
   *  a side game that is only holding its box (closing) goes at once. */
  needServer(): void {
    const a = this.active;
    if (!a) return;
    if (a.phase !== 'closing' && openLeases(this.deps.db).length > 0) return;
    this.close('preempted');
  }

  /** Boot: nothing in memory survived, so every open row is closed. */
  recover(): void {
    const rows = this.deps.db.prepare('SELECT id, server_id FROM side_games WHERE ended_at IS NULL')
      .all() as { id: number; server_id: number }[];
    for (const r of rows) this.releaseRow(r.id, r.server_id, 'boot');
  }

  private close(reason: string): void {
    const a = this.active;
    if (!a) return;
    console.log(`[sidegame] closing on ${a.server.name}: ${reason}`);
    this.active = null;
    this.stopTimers(a);
    this.send(a.server, [`sm_side_stop ${a.token}`]);
    this.releaseRow(a.rowId, a.server.id, reason);
    this.deps.broadcast();
  }

  /** The reason is written now; ended_at only once the release is done, so
   *  the row keeps the box out of the pool through the forced restart. */
  private releaseRow(rowId: number, serverId: number, reason: string): void {
    const db = this.deps.db;
    db.prepare('UPDATE side_games SET end_reason = ? WHERE id = ? AND ended_at IS NULL').run(reason, rowId);
    this.work = this.work
      .then(() => this.deps.release(serverId))
      .catch((err) => { console.error(`[sidegame] releasing server ${serverId} failed:`, err); })
      .then(() => { db.prepare("UPDATE side_games SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL").run(rowId); });
  }

  private stopTimers(a: Active): void {
    for (const t of a.away.values()) t.cancel();
    a.away.clear();
    a.closeTimer?.cancel();
    a.closeTimer = null;
  }

  /** The base game's campaigns, which every box carries; custom and dlc4 are skipped. */
  private randomFirstMap(notSlug: string | null): string {
    const stock = [...campaignRegistry(this.deps.db).values()]
      .filter((c) => !c.custom && !c.requiresDlc4 && !c.practiceOnly);
    // Prefer the ones whose chapter list is known, so the finale is caught.
    const known = stock.filter((c) => c.maps.length > 0);
    let pool = known.length ? known : stock;
    if (pool.length > 1) pool = pool.filter((c) => c.slug !== notSlug);
    return pool[Math.floor(this.rng() * pool.length)]?.firstMap ?? FALLBACK_FIRST_MAP;
  }

  private isFinale(map: string): boolean {
    const slug = campaignForMap(map);
    const entry = slug ? campaignRegistry(this.deps.db).get(slug) : undefined;
    return !!entry && entry.maps.length > 0 && entry.maps[entry.maps.length - 1].toLowerCase() === map.toLowerCase();
  }

  view(steamid: string): SideGameView | null {
    const a = this.active;
    if (!a) return null;
    const youIn = a.seats.some((s) => s.steamid === steamid);
    return {
      phase: a.phase,
      size: a.phase === 'running' ? a.size : null,
      players: a.seats.length,
      youIn,
      connect: youIn ? { host: a.server.host, port: a.server.port, password: a.password } : null,
    };
  }

  publicView(): { size: SideSize | null; players: number } | null {
    const a = this.active;
    return a ? { size: a.phase === 'running' ? a.size : null, players: a.seats.length } : null;
  }
}
