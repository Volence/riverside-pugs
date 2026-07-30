export type LobbyPhase = 'ready_check' | 'map_vote' | 'done' | 'failed';

export interface Scheduler {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
};

export interface LobbyOpts {
  readySeconds: number;
  voteSeconds: number;
  mapPool: string[];
  rng?: () => number;
}

export interface LobbyEvents {
  /** Fired on any state change worth broadcasting. */
  onEvent(): void;
  onComplete(result: { players: string[]; campaign: string }): void;
  onFail(ready: string[], notReady: string[]): void;
}

export interface LobbySnapshot {
  id: string;
  phase: LobbyPhase;
  players: string[];
  ready: string[];
  options: string[];
  votes: Record<string, number>;
  deadline: number;
}

export class Lobby {
  readonly id: string;
  readonly players: string[];
  private phase: LobbyPhase = 'ready_check';
  private ready = new Set<string>();
  private votes = new Map<string, string>();
  private timer: number | null = null;
  private deadline = 0;
  private readonly rng: () => number;

  constructor(
    id: string,
    players: string[],
    private opts: LobbyOpts,
    private events: LobbyEvents,
    private sched: Scheduler = realScheduler,
  ) {
    this.id = id;
    this.players = [...players];
    this.rng = opts.rng ?? Math.random;
    this.startTimer(opts.readySeconds, () => this.failReadyCheck());
  }

  private startTimer(seconds: number, onFire: () => void): void {
    if (this.timer !== null) this.sched.clear(this.timer);
    this.deadline = Date.now() + seconds * 1000;
    this.timer = this.sched.set(onFire, seconds * 1000);
  }

  private stopTimer(): void {
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = null;
  }

  markReady(steamid: string): boolean {
    if (this.phase !== 'ready_check' || !this.players.includes(steamid)) return false;
    this.ready.add(steamid);
    if (this.ready.size === this.players.length) {
      this.phase = 'map_vote';
      this.startTimer(this.opts.voteSeconds, () => this.tally());
    }
    this.events.onEvent();
    return true;
  }

  castVote(steamid: string, campaign: string): boolean {
    if (this.phase !== 'map_vote' || !this.players.includes(steamid)) return false;
    if (!this.opts.mapPool.includes(campaign)) return false;
    this.votes.set(steamid, campaign);
    if (this.votes.size === this.players.length) {
      this.tally();
    } else {
      this.events.onEvent();
    }
    return true;
  }

  private failReadyCheck(): void {
    if (this.phase !== 'ready_check') return;
    this.stopTimer();
    this.phase = 'failed';
    const ready = this.players.filter((p) => this.ready.has(p));
    const notReady = this.players.filter((p) => !this.ready.has(p));
    this.events.onFail(ready, notReady);
  }

  private tally(): void {
    if (this.phase !== 'map_vote') return;
    this.stopTimer();
    const counts = new Map<string, number>();
    for (const c of this.votes.values()) counts.set(c, (counts.get(c) ?? 0) + 1);
    let winners: string[];
    if (counts.size === 0) {
      winners = [...this.opts.mapPool];
    } else {
      const max = Math.max(...counts.values());
      winners = [...counts.entries()].filter(([, n]) => n === max).map(([c]) => c);
    }
    const campaign = winners[Math.floor(this.rng() * winners.length)];
    this.phase = 'done';
    this.events.onComplete({ players: this.players, campaign });
  }

  snapshot(): LobbySnapshot {
    const votes: Record<string, number> = {};
    for (const c of this.votes.values()) votes[c] = (votes[c] ?? 0) + 1;
    return {
      id: this.id,
      phase: this.phase,
      players: [...this.players],
      ready: [...this.ready],
      options: [...this.opts.mapPool],
      votes,
      deadline: this.deadline,
    };
  }

  myVote(steamid: string): string | null {
    return this.votes.get(steamid) ?? null;
  }

  destroy(): void {
    this.stopTimer();
  }
}
