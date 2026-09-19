import { serverPasswordFor } from './matchToken.js';
import type { DB } from './db.js';
import { Queue, QUEUE_SIZE } from './queue.js';
import { Lobby, realScheduler, type Scheduler, type LobbySnapshot, type LobbyPhase, type PersistedLobby } from './lobby.js';
import { balanceTeams } from './balance.js';
import { getRatings, getPlayer, currentSeasonId } from './players.js';
import { getSetting, getJsonSetting } from './settings.js';
import { getServer } from './serverPool.js';
import { spectateFor, type SpectateInfo } from './spectate.js';
import { activeTimeout, recordPenalty } from './penalties.js';
import { QUEUE_BLOCK_MESSAGE, type QueueBlock } from './queueGate.js';
import { READY_BLOCK_MESSAGE, type ReadyBlock } from './readyGate.js';
import type { Orchestrator } from './orchestrator.js';

export interface MatchmakerDeps {
  broadcast: (event: string) => void;
  orchestrator: Orchestrator;
  scheduler?: Scheduler;
  rng?: () => number;
  /** Optional out-of-band notification hook (Discord). Must never throw. */
  notify?: (msg: string) => void;
  /** The Discord requirement (linked + in the server). See queueGate.ts. */
  queueGate?: (steamid: string) => QueueBlock | null;
  /** The voice requirement for pressing Ready. See readyGate.ts. */
  readyGate?: (steamid: string) => ReadyBlock | null;
}

/** Parse discord_queue_thresholds defensively. A malformed or non-array
 *  setting (admin typo, hand-edited sqlite row) must never break join(). */
export function safeThresholds(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface NamedPlayer {
  steamid: string;
  name: string;
  avatar: string | null;
}

export interface StateSnapshot {
  queue: { count: number; joined: boolean; players: NamedPlayer[] };
  lobby:
    | (Omit<LobbySnapshot, 'players'> & {
      /** Each player's own ready block, so the roster can show who is
       *  still missing from voice. Null once they may press Ready. */
      players: (NamedPlayer & { readyBlock: ReadyBlock | null })[];
      myVote: string | null;
    })
    | null;
  match: {
    id: number;
    state: string;
    campaign: string;
    teamA: NamedPlayer[];
    teamB: NamedPlayer[];
    /** Only for a viewer on this roster, and only once the match is live. */
    connect: { host: string; port: number; password: string } | null;
    /** How to watch this match on SourceTV, or null. */
    spectate: SpectateInfo | null;
    /** True while the match is configuring and no server has been claimed
     *  yet, so it is queued behind another match. Never true once the match
     *  is live. */
    waitingForServer: boolean;
  } | null;
  /** A queue timeout the viewer is serving, as an ISO time. */
  timeout: { until: string; offenses: number } | null;
  /** What the viewer still has to do on Discord before they may queue. */
  queueBlock: QueueBlock | null;
  /** What the viewer still has to do before they may press Ready. */
  readyBlock: ReadyBlock | null;
}

/** Lifecycle events the broadcast cannot carry, because it sends only an
 *  event name. The bot needs them to tie a lobby's message to the match it
 *  became, and penalties need who failed a ready check. Every method optional. */
export interface MatchmakerListener {
  lobbyStarted?(lobbyId: string, players: string[]): void;
  lobbyCompleted?(lobbyId: string, matchId: number): void;
  lobbyFailed?(lobbyId: string, ready: string[], notReady: string[]): void;
}

/** Distinguishes this process's lobby ids from a previous run's, so a stored
 *  Discord message for lob_1 before a restart is never mistaken for lob_1 after. */
const BOOT = Date.now().toString(36);
let instanceSeq = 0;

export class Matchmaker {
  private queue = new Queue();
  private lobbyMap = new Map<string, Lobby>();
  private playerLobby = new Map<string, string>();
  private lobbySeq = 0;
  private readonly idPrefix = `lob_${BOOT}${(instanceSeq++).toString(36)}_`;
  private listeners: MatchmakerListener[] = [];
  private failures = new Map<string, { ready: string[]; notReady: string[] }>();

  constructor(private db: DB, private deps: MatchmakerDeps) {}

  /**
   * Save the queue and open lobbies, then tell every surface.
   *
   * Both live only in memory, so a deploy used to drop the queue and cancel a
   * ready check in progress. Written on every change (a handful of rows' worth
   * of JSON, a few times a minute at most), and read back by restore() at boot.
   */
  private changed(): void {
    try {
      const state = {
        queue: this.queue.list(),
        lobbies: [...this.lobbyMap.values()]
          .map((l) => l.persist())
          .filter((l) => l.phase === 'ready_check' || l.phase === 'map_vote'),
      };
      this.db.prepare(
        `INSERT INTO matchmaker_state (id, json, updated_at) VALUES (1, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      ).run(JSON.stringify(state));
    } catch (err) {
      console.error('[matchmaker] could not save queue state:', err);
    }
    this.deps.broadcast('refresh');
  }

  /** Bring back the queue and lobbies saved by the previous process. Call once
   *  at boot, before any surface starts reading state. */
  restore(): void {
    const row = this.db.prepare('SELECT json FROM matchmaker_state WHERE id = 1').get() as { json: string } | undefined;
    if (!row) return;
    let state: { queue: string[]; lobbies: PersistedLobby[] };
    try {
      state = JSON.parse(row.json);
    } catch {
      return;
    }
    for (const p of state.lobbies ?? []) {
      const lobby = Lobby.restore(p, this.lobbyOpts(), this.lobbyEvents(p.id), this.deps.scheduler ?? realScheduler);
      this.lobbyMap.set(p.id, lobby);
      for (const player of p.players) this.playerLobby.set(player, p.id);
    }
    for (const id of state.queue ?? []) {
      if (!this.playerLobby.has(id)) this.queue.join(id);
    }
    if (state.queue?.length || state.lobbies?.length) {
      console.log(`[matchmaker] restored ${state.queue?.length ?? 0} queued and ${state.lobbies?.length ?? 0} lobbies`);
    }
    this.changed();
  }

  private lobbyOpts() {
    return {
      readySeconds: Number(getSetting(this.db, 'ready_seconds') ?? 120),
      voteSeconds: Number(getSetting(this.db, 'vote_seconds') ?? 30),
      mapPool: getJsonSetting<string[]>(this.db, 'map_pool'),
      rng: this.deps.rng,
    };
  }

  private lobbyEvents(id: string) {
    return {
      onEvent: () => this.changed(),
      onComplete: (result: { players: string[]; campaign: string }) => this.onLobbyComplete(id, result),
      onFail: (ready: string[], notReady: string[]) => this.onLobbyFail(id, ready, notReady),
    };
  }

  on(listener: MatchmakerListener): void {
    this.listeners.push(listener);
  }

  private emit<K extends keyof MatchmakerListener>(
    event: K, ...args: Parameters<NonNullable<MatchmakerListener[K]>>
  ): void {
    for (const l of this.listeners) {
      try {
        (l[event] as ((...a: unknown[]) => void) | undefined)?.(...args);
      } catch (err) {
        console.error(`[matchmaker] listener ${event} failed:`, err);
      }
    }
  }

  /** Every open lobby, for surfaces that render all of them (the bot). */
  lobbies(): { id: string; snapshot: LobbySnapshot }[] {
    return [...this.lobbyMap.values()].map((l) => ({ id: l.id, snapshot: l.snapshot() }));
  }

  /** Who readied and who did not, for a lobby that failed in this process. */
  lastFailure(lobbyId: string): { ready: string[]; notReady: string[] } | null {
    return this.failures.get(lobbyId) ?? null;
  }

  join(steamid: string): { ok: boolean; error?: string } {
    if (this.playerLobby.has(steamid)) return { ok: false, error: 'already in a lobby' };
    if (this.hasOpenMatch(steamid)) return { ok: false, error: 'already in an active match' };
    const block = this.deps.queueGate?.(steamid) ?? null;
    if (block) return { ok: false, error: QUEUE_BLOCK_MESSAGE[block] };
    const timeout = activeTimeout(this.db, steamid);
    if (timeout) {
      return { ok: false, error: `timed out for missed ready checks or no-shows until ${timeout.until.toISOString()}` };
    }
    this.queue.join(steamid);
    const thresholds = safeThresholds(getSetting(this.db, 'discord_queue_thresholds'));
    if (thresholds.includes(this.queue.count())) {
      this.deps.notify?.(`🧟 ${this.queue.count()}/${QUEUE_SIZE} in queue`);
    }
    this.maybeStartLobby();
    this.changed();
    return { ok: true };
  }

  leave(steamid: string): void {
    this.queue.leave(steamid);
    this.changed();
  }

  ready(steamid: string): { ok: boolean; error?: string } {
    const lobby = this.lobbyFor(steamid);
    if (!lobby) return { ok: false, error: 'no ready check active' };
    const block = this.readyBlock(steamid);
    if (block) return { ok: false, error: READY_BLOCK_MESSAGE[block] };
    return lobby.markReady(steamid) ? { ok: true } : { ok: false, error: 'no ready check active' };
  }

  /** Take back a player's Ready, for someone who left voice during the ready
   *  check. True when it changed anything. */
  unready(steamid: string): boolean {
    return this.lobbyFor(steamid)?.unmarkReady(steamid) ?? false;
  }

  /** What stands between this player and pressing Ready, or null. */
  readyBlock(steamid: string): ReadyBlock | null {
    return this.deps.readyGate?.(steamid) ?? null;
  }

  vote(steamid: string, campaign: string): boolean {
    return this.lobbyFor(steamid)?.castVote(steamid, campaign) ?? false;
  }

  /** All players currently in any lobby (dev tooling). */
  lobbyMembers(): string[] {
    return [...this.playerLobby.keys()];
  }

  private lobbyFor(steamid: string): Lobby | undefined {
    const id = this.playerLobby.get(steamid);
    return id ? this.lobbyMap.get(id) : undefined;
  }

  private hasOpenMatch(steamid: string): boolean {
    return this.db
      .prepare(
        `SELECT 1 FROM matches m JOIN match_players mp ON mp.match_id = m.id
         WHERE mp.player_id = ? AND m.state IN ('configuring','live') LIMIT 1`,
      )
      .get(steamid) !== undefined;
  }

  private maybeStartLobby(): void {
    while (this.queue.count() >= QUEUE_SIZE) {
      const players = this.queue.takeBatch(QUEUE_SIZE);
      const id = `${this.idPrefix}${++this.lobbySeq}`;
      const lobby = new Lobby(id, players, this.lobbyOpts(), this.lobbyEvents(id), this.deps.scheduler ?? realScheduler);
      this.lobbyMap.set(id, lobby);
      this.deps.notify?.('🔔 Queue popped, ready check started!');
      for (const p of players) this.playerLobby.set(p, id);
      this.emit('lobbyStarted', id, [...players]);
    }
  }

  private dissolveLobby(id: string): string[] {
    const lobby = this.lobbyMap.get(id);
    if (!lobby) return [];
    lobby.destroy();
    this.lobbyMap.delete(id);
    for (const p of lobby.players) this.playerLobby.delete(p);
    return lobby.players;
  }

  private onLobbyFail(id: string, ready: string[], notReady: string[] = []): void {
    try {
      // Bounded: only the most recent failures matter, to the message that
      // renders them within seconds.
      this.failures.set(id, { ready: [...ready], notReady: [...notReady] });
      if (this.failures.size > 20) this.failures.delete(this.failures.keys().next().value!);
      for (const p of notReady) recordPenalty(this.db, p, 'ready_fail', null);
      this.emit('lobbyFailed', id, [...ready], [...notReady]);
      this.dissolveLobby(id);
      this.queue.requeueFront(ready);
      this.maybeStartLobby();
    } catch (err) {
      console.error(`lobby ${id} fail handler error:`, err);
    } finally {
      this.changed();
    }
  }

  private onLobbyComplete(id: string, result: { players: string[]; campaign: string }): void {
    try {
      this.dissolveLobby(id);
      const ratings = getRatings(this.db, result.players);
      const { teamA, teamB } = balanceTeams(
        result.players.map((steamid) => {
          const r = ratings.get(steamid)!;
          return { steamid, mu: r.mu, sigma: r.sigma };
        }),
      );
      const season = currentSeasonId(this.db);
      const matchId = this.db.transaction(() => {
        const insertMatch = this.db.prepare(
          "INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', ?)",
        );
        const id = Number(insertMatch.run(season, result.campaign).lastInsertRowid);
        const insertMp = this.db.prepare(
          'INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)',
        );
        for (const p of teamA) insertMp.run(id, p, 'a');
        for (const p of teamB) insertMp.run(id, p, 'b');
        return id;
      })();

      this.emit('lobbyCompleted', id, matchId);
      this.deps.orchestrator.setupMatch(matchId).catch((err) => {
        console.error(`orchestrator failed for match ${matchId}:`, err);
      });
    } catch (err) {
      console.error(`lobby ${id} complete handler error:`, err);
    } finally {
      this.changed();
    }
  }

  stateFor(steamid: string): StateSnapshot {
    const named = this.named.bind(this);

    const lobby = this.lobbyFor(steamid);
    const snap = lobby?.snapshot();

    // The JOIN on match_players below is what puts the viewer on the roster:
    // no separate roster check is needed (or wanted) anywhere in this method.
    const matchRow = this.db
      .prepare(
        `SELECT m.* FROM matches m
         JOIN match_players mp ON mp.match_id = m.id
         WHERE mp.player_id = ? AND m.state IN ('configuring','live')
         ORDER BY m.id DESC LIMIT 1`,
      )
      .get(steamid) as
      | { id: number; state: string; campaign: string; server_id: number | null; token: string | null }
      | undefined;

    let match: StateSnapshot['match'] = null;
    if (matchRow) {
      const mps = this.db
        .prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
        .all(matchRow.id) as { player_id: string; team: 'a' | 'b' }[];

      // Derived, never stored twice: this is the same expression setupMatch
      // uses to set sv_password, so the two cannot drift.
      let connect: { host: string; port: number; password: string } | null = null;
      if (matchRow.state === 'live' && matchRow.server_id !== null && matchRow.token) {
        const server = getServer(this.db, matchRow.server_id);
        if (server) {
          connect = {
            host: server.host,
            port: server.port,
            password: serverPasswordFor(matchRow.token),
          };
        }
      }

      match = {
        id: matchRow.id,
        state: matchRow.state,
        campaign: matchRow.campaign,
        teamA: mps.filter((r) => r.team === 'a').map((r) => named(r.player_id)),
        teamB: mps.filter((r) => r.team === 'b').map((r) => named(r.player_id)),
        connect,
        spectate: spectateFor(this.db, matchRow.server_id),
        waitingForServer: matchRow.state === 'configuring' && matchRow.server_id === null,
      };
    }

    return {
      queue: {
        count: this.queue.count(),
        joined: this.queue.has(steamid),
        players: this.queue.list().map(named),
      },
      lobby: snap && lobby
        ? {
          ...snap,
          players: snap.players.map((p) => ({ ...named(p), readyBlock: this.readyBlock(p) })),
          myVote: lobby.myVote(steamid),
        }
        : null,
      match,
      timeout: (() => {
        const t = activeTimeout(this.db, steamid);
        return t ? { until: t.until.toISOString(), offenses: t.offenses } : null;
      })(),
      queueBlock: this.deps.queueGate?.(steamid) ?? null,
      readyBlock: this.readyBlock(steamid),
    };
  }

  /**
   * The queue as anyone may see it, signed in or not.
   *
   * Deliberately not stateFor with the auth removed: that snapshot is entirely
   * viewer-relative (are YOU queued, YOUR lobby, YOUR vote) and would be
   * meaningless anonymously. Carries no connect block and no match id.
   */
  publicQueue(): { count: number; players: NamedPlayer[]; phase: LobbyPhase | null } {
    const anyLobby = [...this.lobbyMap.values()][0];
    return {
      count: this.queue.count(),
      players: this.queue.list().map((id) => this.named(id)),
      phase: anyLobby?.snapshot().phase ?? null,
    };
  }

  private named(id: string): NamedPlayer {
    const p = getPlayer(this.db, id);
    return { steamid: id, name: p?.name ?? id, avatar: p?.avatar ?? null };
  }
}
