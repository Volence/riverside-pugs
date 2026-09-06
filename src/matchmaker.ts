import type { DB } from './db.js';
import { Queue, QUEUE_SIZE } from './queue.js';
import { Lobby, realScheduler, type Scheduler, type LobbySnapshot } from './lobby.js';
import { balanceTeams } from './balance.js';
import { getRatings, getPlayer, currentSeasonId } from './players.js';
import { getSetting, getJsonSetting } from './settings.js';
import type { Orchestrator } from './orchestrator.js';

export interface MatchmakerDeps {
  broadcast: (event: string) => void;
  orchestrator: Orchestrator;
  scheduler?: Scheduler;
  rng?: () => number;
  /** Optional out-of-band notification hook (Discord). Must never throw. */
  notify?: (msg: string) => void;
}

/** Parse discord_queue_thresholds defensively. A malformed or non-array
 *  setting (admin typo, hand-edited sqlite row) must never break join(). */
function safeThresholds(raw: string | undefined): number[] {
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
}

export interface StateSnapshot {
  queue: { count: number; joined: boolean };
  lobby:
    | (Omit<LobbySnapshot, 'players'> & { players: NamedPlayer[]; myVote: string | null })
    | null;
  match: {
    id: number;
    state: string;
    campaign: string;
    teamA: NamedPlayer[];
    teamB: NamedPlayer[];
  } | null;
}

export class Matchmaker {
  private queue = new Queue();
  private lobbies = new Map<string, Lobby>();
  private playerLobby = new Map<string, string>();
  private lobbySeq = 0;

  constructor(private db: DB, private deps: MatchmakerDeps) {}

  join(steamid: string): { ok: boolean; error?: string } {
    if (this.playerLobby.has(steamid)) return { ok: false, error: 'already in a lobby' };
    if (this.hasOpenMatch(steamid)) return { ok: false, error: 'already in an active match' };
    this.queue.join(steamid);
    const thresholds = safeThresholds(getSetting(this.db, 'discord_queue_thresholds'));
    if (thresholds.includes(this.queue.count())) {
      this.deps.notify?.(`🧟 ${this.queue.count()}/${QUEUE_SIZE} in queue`);
    }
    this.maybeStartLobby();
    this.deps.broadcast('refresh');
    return { ok: true };
  }

  leave(steamid: string): void {
    this.queue.leave(steamid);
    this.deps.broadcast('refresh');
  }

  ready(steamid: string): boolean {
    return this.lobbyFor(steamid)?.markReady(steamid) ?? false;
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
    return id ? this.lobbies.get(id) : undefined;
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
      const id = `lob_${++this.lobbySeq}`;
      const lobby = new Lobby(
        id,
        players,
        {
          readySeconds: Number(getSetting(this.db, 'ready_seconds') ?? 60),
          voteSeconds: Number(getSetting(this.db, 'vote_seconds') ?? 30),
          mapPool: getJsonSetting<string[]>(this.db, 'map_pool'),
          rng: this.deps.rng,
        },
        {
          onEvent: () => this.deps.broadcast('refresh'),
          onComplete: (result) => this.onLobbyComplete(id, result),
          onFail: (ready) => this.onLobbyFail(id, ready),
        },
        this.deps.scheduler ?? realScheduler,
      );
      this.lobbies.set(id, lobby);
      this.deps.notify?.('🔔 Queue popped, ready check started!');
      for (const p of players) this.playerLobby.set(p, id);
    }
  }

  private dissolveLobby(id: string): string[] {
    const lobby = this.lobbies.get(id);
    if (!lobby) return [];
    lobby.destroy();
    this.lobbies.delete(id);
    for (const p of lobby.players) this.playerLobby.delete(p);
    return lobby.players;
  }

  private onLobbyFail(id: string, ready: string[]): void {
    try {
      this.dissolveLobby(id);
      this.queue.requeueFront(ready);
      this.maybeStartLobby();
    } catch (err) {
      console.error(`lobby ${id} fail handler error:`, err);
    } finally {
      this.deps.broadcast('refresh');
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

      this.deps.orchestrator.setupMatch(matchId).catch((err) => {
        console.error(`orchestrator failed for match ${matchId}:`, err);
      });
    } catch (err) {
      console.error(`lobby ${id} complete handler error:`, err);
    } finally {
      this.deps.broadcast('refresh');
    }
  }

  stateFor(steamid: string): StateSnapshot {
    const named = (id: string): NamedPlayer => ({
      steamid: id,
      name: getPlayer(this.db, id)?.name ?? id,
    });

    const lobby = this.lobbyFor(steamid);
    const snap = lobby?.snapshot();

    const matchRow = this.db
      .prepare(
        `SELECT m.* FROM matches m
         JOIN match_players mp ON mp.match_id = m.id
         WHERE mp.player_id = ? AND m.state IN ('configuring','live')
         ORDER BY m.id DESC LIMIT 1`,
      )
      .get(steamid) as { id: number; state: string; campaign: string } | undefined;

    let match: StateSnapshot['match'] = null;
    if (matchRow) {
      const mps = this.db
        .prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
        .all(matchRow.id) as { player_id: string; team: 'a' | 'b' }[];
      match = {
        id: matchRow.id,
        state: matchRow.state,
        campaign: matchRow.campaign,
        teamA: mps.filter((r) => r.team === 'a').map((r) => named(r.player_id)),
        teamB: mps.filter((r) => r.team === 'b').map((r) => named(r.player_id)),
      };
    }

    return {
      queue: { count: this.queue.count(), joined: this.queue.has(steamid) },
      lobby: snap && lobby
        ? { ...snap, players: snap.players.map(named), myVote: lobby.myVote(steamid) }
        : null,
      match,
    };
  }
}
