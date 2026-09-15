/** Typed wrappers over the backend. These types mirror the JSON the routes in
 *  src/routes/{api,stats,auth}.ts actually return. If a shape changes there,
 *  it changes here. 4a introduces no new endpoints and alters no existing one. */

import type { ReplaySession } from '../../src/replaySessionTypes';
import type { TimelineEntry } from './replay/timeline';

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
  /** Season totals per stat, so the table sorts by any column without a
   *  request per column. Self-visibility stats are dropped server side. */
  stats?: Record<string, number>;
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
  /** Skill-detect stats, already filtered server-side for the viewer: a
   *  self-visibility stat is present only when the viewer is the subject. */
  stats: Record<string, number>;
}

export interface StatDef {
  key: string;
  side: 'survivor' | 'infected';
  visibility: 'public' | 'self';
  label: string;
  needsSkillDetect: boolean;
  direction: 'high_good' | 'high_bad' | 'neutral';
}

export interface LivePlayer extends NamedPlayer {
  /** Missing key means "not measured", never zero. skill_detect keys are
   *  absent entirely when that plugin is not loaded. */
  stats: Record<string, number>;
}

export interface LiveEvent {
  seq: number;
  kind: string;
  /** Which map of the match it happened on, zero-based. */
  mapOrdinal: number;
  /** Which half of that map, 1 or 2, or -1 when the event carried no round
   *  timing (what a match played before round capture looks like). */
  half: number;
  /** Milliseconds since that round went live, or -1 for no timing. Only
   *  comparable between events in the same map and half. */
  tMs: number;
  actor: NamedPlayer;
  target: NamedPlayer | null;
  value: number;
}

export interface LiveMatch {
  id: number;
  campaign: string;
  currentMap: string | null;
  teamA: LivePlayer[];
  teamB: LivePlayer[];
  maps: {
    ordinal: number; map: string; teamAScore: number; teamBScore: number;
    /** This map's own per-player stats, keyed by steamid. */
    stats: Record<string, Record<string, number>>;
  }[];
  teamAScore: number;
  teamBScore: number;
  lastSeen: string | null;
  /** No heartbeat for a while. The match is shown anyway, flagged, because a
   *  died-quietly match is information rather than something to hide. */
  stale: boolean;
  demos: MatchDemo[];
  /** Most recent first. Discrete things that happened, so a big deadly pounce
   *  is distinguishable from six small ones. */
  events: LiveEvent[];
}

export interface MatchDemo {
  ordinal: number;
  map: string;
  bytes: number;
}

export interface MatchDetail {
  match: MatchSummary & { state: string };
  maps: {
    ordinal: number; map: string; teamAScore: number; teamBScore: number;
    /** Per-player stats for this map, keyed by steamid. Empty for matches
     *  played before per-map capture existed. */
    stats: Record<string, Record<string, number>>;
    /** False when the stored score is not a result (a round the plugin could
     *  not attribute or read). The page says "not recorded" instead of the
     *  scoreline. Optional only for an older server that predates the flag,
     *  which is read as recorded. */
    recorded?: boolean;
  }[];
  players: MatchPlayerStats[];
  events?: LiveEvent[];
  /** Metadata is public; downloading the bytes needs a session. Absent or
   *  empty when the server has no demo directory configured. */
  demos?: MatchDemo[];
  /** The stat registry, served with the match so the page reads direction
   *  from one authoritative source rather than a browser-side copy. Labels
   *  are NOT read from this: they still come from the hand-maintained
   *  STAT_LABELS in format.ts, deliberately, because they are shortened for
   *  narrow columns ("Chip", "Team", "Rocks shot"). */
  statDefs: StatDef[];
  /** Per-round side attribution. An empty array means this match predates
   *  round capture, which is NOT the same as a match that had no rounds. */
  rounds: {
    ordinal: number; half: number; survTeam: Team;
    score: number; endedAt: string | null; reliable: boolean;
    byPlayer: Record<string, Record<string, number>>;
  }[];
}

export interface MapIndexRow {
  map: string;
  campaign: string | null;
  played: number;
  /** Mean over the recorded playings only; null when none has a real score. */
  avgTeamA: number | null;
  avgTeamB: number | null;
}

export interface MapLeaderRow {
  steamid: string;
  name: string;
  games: number;
  wins: number;
  losses: number;
  stats: Record<string, number>;
}

export interface MapDetail {
  map: string;
  played: number;
  /** Mean over the recorded playings only; null when none has a real score. */
  avgTeamA: number | null;
  avgTeamB: number | null;
  players: MapLeaderRow[];
}

export interface MapBreakdownRow {
  map: string;
  games: number;
  wins: number;
  losses: number;
  stats: Record<string, number>;
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
  /** Public skill-stat lifetime totals, keyed by stat. */
  statTotals: Record<string, number>;
  /** Lifetime totals for self-visibility stats. Only ever populated for the
   *  subject themselves; null for anyone else, never an empty object. */
  privateStatTotals: Record<string, number> | null;
  statDefs: StatDef[];
  /** Per-map performance across every completed match. `stats` can be empty
   *  for matches played before per-map capture existed, while `games` is not. */
  byMap?: MapBreakdownRow[];
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
  live: (signal?: AbortSignal) => get<{ matches: LiveMatch[] }>('/api/live', signal),
  maps: (signal?: AbortSignal) => get<{ maps: MapIndexRow[] }>('/api/maps', signal),
  replaySessions: (signal?: AbortSignal) =>
    get<{ sessions: ReplaySession[] }>('/api/replays/sessions', signal),
  replayLive: (token: string, signal?: AbortSignal) =>
    get<{ filename: string; closed: boolean }>(`/api/replays/live/${encodeURIComponent(token)}`, signal),
  replayTimeline: (matchId: number, ordinal: number, half: number, signal?: AbortSignal) =>
    get<{ entries: TimelineEntry[] }>(`/api/replays/timeline/${matchId}/${ordinal}/${half}`, signal),
  map: (map: string, signal?: AbortSignal) =>
    get<MapDetail>(`/api/maps/${encodeURIComponent(map)}`, signal),
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
