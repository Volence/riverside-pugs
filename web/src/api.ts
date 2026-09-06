/** Typed wrappers over the backend. These types mirror the JSON the routes in
 *  src/routes/{api,stats,auth}.ts actually return. If a shape changes there,
 *  it changes here. 4a introduces no new endpoints and alters no existing one. */

export type Team = 'a' | 'b';
export type Winner = Team | 'draw';
export type MatchResult = 'win' | 'loss' | 'draw';

export interface Me {
  steamid: string;
  name: string;
  avatar: string | null;
  status: string;
  isAdmin: boolean;
}

export interface NamedPlayer {
  steamid: string;
  name: string;
}

export type LobbyPhase = 'ready_check' | 'map_vote' | 'done' | 'failed';

export interface LobbySnapshot {
  id: string;
  phase: LobbyPhase;
  players: NamedPlayer[];
  ready: string[];
  options: string[];
  votes: Record<string, number>;
  /** Epoch ms. Compared against the client clock, as it always has been. */
  deadline: number;
  myVote: string | null;
}

export interface StateSnapshot {
  queue: { count: number; joined: boolean };
  lobby: LobbySnapshot | null;
  match: {
    id: number;
    state: string;
    campaign: string;
    teamA: NamedPlayer[];
    teamB: NamedPlayer[];
  } | null;
}

export interface LeaderboardRow {
  steamid: string;
  name: string;
  avatar: string | null;
  sr: number;
  wins: number;
  losses: number;
  games: number;
}

export interface Leaderboard {
  season: { id: number; name: string };
  rows: LeaderboardRow[];
}

export interface MatchSummary {
  id: number;
  campaign: string;
  endedAt: string | null;
  teamAScore: number;
  teamBScore: number;
  winner: Winner;
}

export interface MatchPlayerStats {
  steamid: string;
  name: string;
  team: Team;
  siDamage: number;
  siKills: number;
  commonKills: number;
  ffDealt: number;
  revives: number;
  srDelta: number;
}

export interface MatchDetail {
  match: MatchSummary & { state: string };
  maps: { ordinal: number; map: string; teamAScore: number; teamBScore: number }[];
  players: MatchPlayerStats[];
}

export interface ProfileMatch extends MatchSummary {
  team: Team;
  result: MatchResult;
  srDelta: number;
}

export interface Profile {
  player: { steamid: string; name: string; avatar: string | null; createdAt: string };
  rating: { sr: number; mu: number; sigma: number; wins: number; losses: number } | null;
  totals: {
    games: number;
    siDamage: number;
    siKills: number;
    commonKills: number;
    ffDealt: number;
    revives: number;
  };
  matches: ProfileMatch[];
  history: { matchId: number; sr: number }[];
}

/** Thrown for any non-OK response, carrying the status so callers can tell
 *  "not logged in" (401/403) and "no such thing" (404) apart from a real fault. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (!res.ok) throw new ApiError(res.status, `GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

/** POST an action. Returns the parsed body on success; throws ApiError otherwise,
 *  so callers can surface the backend's own `error` string (e.g. a 409 from
 *  /api/queue/join saying "already in a lobby"). */
async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (parsed as { error?: string }).error ?? `POST ${path} → ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
}

export const api = {
  me: (signal?: AbortSignal) => get<Me>('/api/me', signal),
  state: (signal?: AbortSignal) => get<StateSnapshot>('/api/state', signal),
  leaderboard: (signal?: AbortSignal) => get<Leaderboard>('/api/leaderboard', signal),
  matches: (signal?: AbortSignal) => get<{ matches: MatchSummary[] }>('/api/matches', signal),
  match: (id: string, signal?: AbortSignal) =>
    get<MatchDetail>(`/api/matches/${encodeURIComponent(id)}`, signal),
  profile: (steamid: string, signal?: AbortSignal) =>
    get<Profile>(`/api/players/${encodeURIComponent(steamid)}`, signal),

  register: (code: string) => post('/api/register', { code }),
  joinQueue: () => post('/api/queue/join'),
  leaveQueue: () => post('/api/queue/leave'),
  ready: () => post('/api/lobby/ready'),
  vote: (campaign: string) => post('/api/lobby/vote', { campaign }),

  dev: {
    enabled: () => get<unknown>('/api/dev/enabled'),
    login: (steamid: string) => post('/api/dev/login', { steamid }),
    fill: () => post('/api/dev/fill'),
    readyAll: () => post('/api/dev/ready-all'),
    voteAll: () => post('/api/dev/vote-all'),
    clearMatches: () => post('/api/dev/clear-matches'),
    simulateMatch: () => post('/api/dev/simulate-match'),
  },
};
