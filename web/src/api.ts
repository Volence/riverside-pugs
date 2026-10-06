/** Typed wrappers over the backend. These types mirror the JSON the routes in
 *  src/routes/{api,stats,auth}.ts actually return. If a shape changes there,
 *  it changes here. 4a introduces no new endpoints and alters no existing one. */

import type { TimelineEntry } from './replay/timeline';
import type { DemoSync } from './replay/demoTick';
import type { DrillSpec } from '../../src/drillSpec';
import type { OverlayFeed, StudioState } from '../../src/cast/types';
import type { VetoConfig } from '../../src/events/vetoConfig';

export type Team = 'a' | 'b';
export type Winner = Team | 'draw';
export type MatchResult = 'win' | 'loss' | 'draw';

export interface Me {
  steamid: string;
  name: string;
  avatar: string | null;
  status: string;
  isAdmin: boolean;
  /** May open the Tickets tab. */
  isMod?: boolean;
  /** May open the Cast page (live match connect lines). */
  isCaster?: boolean;
  /** False when the server has no Discord app configured: hide every Discord control. */
  discordEnabled?: boolean;
  discord?: { id: string; name: string } | null;
  /** In the Discord server; null when not linked or not known right now. */
  discordMember?: boolean | null;
  /** False when the server has no Twitch app configured: hide every Twitch control. */
  twitchEnabled?: boolean;
  twitch?: { id: string; name: string } | null;
  /** hold: an alt hold (src/altHolds.ts), worded as a hold, not a ban. */
  ban?: { reason: string; expiresAt: string | null; hold?: boolean } | null;
  /** Show Teams: the competitive switch lets this viewer in. */
  teams?: boolean;
}

export interface NamedPlayer {
  steamid: string;
  name: string;
  avatar: string | null;
}

export type LobbyPhase = 'ready_check' | 'map_vote' | 'done' | 'failed';

/** What stands between a player and pressing Ready: no Discord linked, or
 *  not in a voice channel on the server (when the voice requirement is on). */
export type ReadyBlock = 'link_discord' | 'join_voice';

export interface LobbySnapshot {
  id: string;
  phase: LobbyPhase;
  players: (NamedPlayer & { readyBlock?: ReadyBlock | null })[];
  ready: string[];
  options: string[];
  votes: Record<string, number>;
  /** Epoch ms. Compared against the client clock, as it always has been. */
  deadline: number;
  myVote: string | null;
}

/** A queue timeout being served. `offenses` counts the ladder named by
 *  `kind` only: missed ready checks and no-shows climb separate ladders, and
 *  the timeout shown is whichever of the two ends later. */
export interface QueueTimeout { until: string; offenses: number; kind?: 'ready_fail' | 'no_show' }

export type AbortCause = 'admin' | 'no_show' | 'no_round' | 'setup_failed' | 'abandon' | 'server_lost' | 'uncollected';
export interface AbortNotice {
  matchId: number;
  cause: AbortCause;
  /** Public wording, never naming anyone: "not enough players connected in time". */
  reason: string;
  /** culprit: the no-show or the abandoner. file_check: turned away by the file check. */
  role: 'innocent' | 'culprit' | 'file_check';
  requeued: boolean;
}

/** The GET /api/queue shape: public, so carries nothing viewer-relative and
 *  no connect block, unlike StateSnapshot['queue']. */
export interface PublicQueue {
  count: number;
  players: NamedPlayer[];
  phase: LobbyPhase | null;
  /** A side game up while the queue fills (players = the two teams plus
   *  sitters on the box), and the switch that allows them. */
  sideGame?: { phase: 'running' | 'popped' | 'closing'; size: 2 | 3 | null; players: number } | null;
  sideGamesEnabled?: boolean;
}

export interface StateSnapshot {
  queue: { count: number; joined: boolean; players: NamedPlayer[]; sideOptIn?: boolean };
  lobby: LobbySnapshot | null;
  match: {
    id: number;
    state: string;
    campaign: string;
    teamA: NamedPlayer[];
    teamB: NamedPlayer[];
    /** Only for a viewer on this roster, and only once the match is live. */
    connect: { host: string; port: number; password: string } | null;
    /** How to watch on SourceTV, or null when that server has none. */
    spectate?: SpectateInfo | null;
    /** True while the match is configuring and no server has been claimed
     *  yet, so it is queued behind another match. Never true once the match
     *  is live. */
    waitingForServer: boolean;
  } | null;
  /** A queue timeout the viewer is serving (missed ready checks, no-shows). */
  timeout?: QueueTimeout | null;
  /** The Discord step still missing before the viewer may queue. */
  queueBlock?: 'link_discord' | 'join_discord' | null;
  /** The step still missing before the viewer may press Ready. */
  readyBlock?: ReadyBlock | null;
  /** The ready check the viewer was just in, if it failed and they have not
   *  dismissed it. The failure no longer appears in #queue-here, so this is
   *  where they find out. */
  /** `removed` is set instead of `notReady` when the pop was cancelled because
   *  a player was taken out of it (banned mid ready check). */
  lobbyNotice?: { notReady: NamedPlayer[]; youWereReady: boolean; removed?: NamedPlayer; cancelled?: true } | null;
  /** The match the viewer was on, aborted, until they dismiss it. Stored on
   *  the server (src/matchAborts.ts), so a reload keeps it. */
  abortNotice?: AbortNotice | null;
  /** The sidegames_enabled switch: off, nothing about side games shows. */
  sideGamesEnabled?: boolean;
  /** The unrecorded 2v2/3v3 running (or closing) while the queue fills. */
  sideGame?: {
    phase: 'running' | 'popped' | 'closing';
    size: 2 | 3 | null;
    players: number;
    youIn: boolean;
    connect: { host: string; port: number; password: string } | null;
  } | null;
}

/** What a merge is about to move, or just moved. */
export interface MergePlan {
  from: string;
  into: string;
  matchesMoved: number;
  matchesCollapsed: number;
  rowsByTable: Record<string, number>;
  seasons: number[];
}

export interface SpectateInfo {
  host: string;
  port: number;
  password: string;
  /** SourceTV broadcast delay in seconds. */
  delay: number;
}

export interface Season {
  id: number;
  name: string;
  startedAt: string;
  endedAt: string | null;
  current: boolean;
  matches: number;
}

export interface SiteInfo {
  discordEnabled: boolean;
  discordInviteUrl: string | null;
  requireDiscord: boolean;
}

export interface LeaderboardRow {
  steamid: string;
  name: string;
  avatar: string | null;
  sr: number;
  wins: number;
  losses: number;
  games: number;
  /** False under three games: listed as provisional, below the ranked rows,
   *  with no rank number and no claim on the top-rated card. */
  ranked: boolean;
  /** Season totals per stat, so the table sorts by any column without a
   *  request per column. Self-visibility stats are dropped server side. */
  stats?: Record<string, number>;
  /** The endorsement title they have earned, if any. */
  title?: EndorseKind | null;
}

export interface Leaderboard {
  season: { id: number; name: string };
  /** Distinct matches that produced a rating this season. */
  matchesRated: number;
  rows: LeaderboardRow[];
}

/** Which panel of the weekly board an award sits in. */
export type AwardGroup = 'survivor' | 'infected' | 'overall' | 'shame';

export interface WeeklyWinner { steamid: string; name: string; value: number; games: number; detail: string | null }

/** One line of an award: `avg` and `total` can both exist for the same
 *  `key` (two rows in the same card), `single` never shares its key. */
export interface WeeklyAward { key: string; label: string; group: AwardGroup; kind: 'avg' | 'total' | 'single'; winners: WeeklyWinner[] }

export interface WeeklyRecap {
  matches: number;
  players: number;
  peakConcurrent: number;
  busiestDay: { date: string; matches: number } | null;
  highlights: { key: string; verb: string; label: string; player: { steamid: string; name: string }; value: number; matchId: number }[];
  mostQuads: { matchId: number; quads: number } | null;
  totals: { key: string; label: string; value: number; leader: { steamid: string; name: string; value: number } | null }[];
  streaks: { steamid: string; name: string; w: number; l: number }[];
  iron: { steamid: string; name: string; games: number }[];
  closest: { matchId: number; campaign: string; a: number; b: number } | null;
}

export interface WeeklyData { week: string; live: boolean; minGames: number; awards: WeeklyAward[]; recap: WeeklyRecap }

/** A player's history of weekly awards, shown on their profile. */
export interface PlayerAward { award: string; label: string; count: number; weeks: string[] }

export interface MatchSummary {
  id: number;
  campaign: string;
  endedAt: string | null;
  teamAScore: number;
  teamBScore: number;
  winner: Winner;
  /** The team that forfeited with !gg, null when the match was played out. */
  forfeitTeam?: 'a' | 'b' | null;
}

export interface MatchPlayerStats {
  steamid: string;
  name: string;
  /** Their linked Discord display name, only when it reads differently from
   *  `name`. Null when unlinked or the names match. */
  discordName: string | null;
  team: Team;
  siDamage: number;
  siKills: number;
  commonKills: number;
  ffDealt: number;
  revives: number;
  /** Null when the rating never touched this player in this match. */
  srDelta: number | null;
  /** Skill-detect stats, already filtered server-side for the viewer: a
   *  self-visibility stat is present only when the viewer is the subject. */
  stats: Record<string, number>;
  /** The endorsement title they have earned, if any. */
  title?: EndorseKind | null;
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
  /** Their linked Discord display name, only when it reads differently from
   *  `name`. Null when unlinked or the names match. */
  discordName: string | null;
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

/** What the game is doing, from the plugin's one-second tracker, plus when
 *  it began (epoch ms) so a pause countdown can run against our clock. */
export interface LivePhase {
  state: 'live' | 'paused' | 'readyup' | 'roundover' | 'loading';
  /** Who is charged for a pause; null for a disconnect pause, an admin, or any
   *  state that is not a pause. */
  team: 'a' | 'b' | null;
  /** Seconds a pause may last, 0 for no ceiling. */
  limit: number;
  leave: boolean;
  /** Rostered players not yet ready, during a ready-up. */
  unready: string[];
  sinceMs: number;
}
export interface MatchReadyup {
  mapOrdinal: number;
  half: number | null;
  startedAt: string;
  endedAt: string | null;
  /** Whole seconds to go live, null while still open. */
  seconds: number | null;
  lastUnready: string[];
  lastUnreadyNames: string[];
  players: { steamid: string; name: string; seconds: number }[];
}
export interface SlowToReady {
  steamid: string; name: string; readyups: number; timesLast: number; totalSeconds: number; avgSeconds: number;
}
export interface MatchPause {
  team: 'a' | 'b' | null;
  leave: boolean;
  mapOrdinal: number;
  half: number | null;
  startedAt: string;
  endedAt: string | null;
  /** Whole seconds, null while still open. */
  seconds: number | null;
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
  spectate?: SpectateInfo | null;
  phase?: LivePhase | null;
}

export interface MatchDemo {
  ordinal: number;
  map: string;
  bytes: number;
}

/** A match still being played: 'waiting' for a server, 'configuring' one, or
 *  'live'. Deliberately tiny; never the server address, the token or a
 *  password, none of which belong in a link anyone can open. The same id
 *  answers with a MatchDetail once the match ends. */
export interface MatchOngoing {
  ongoing: true;
  id: number;
  campaign: string;
  state: 'waiting' | 'configuring' | 'live';
}

export interface MatchDetail {
  ongoing: false;
  /** `winner` is null on an aborted match: it never reached a result. The
   *  void fields are set only when a COMPLETED match was voided afterwards,
   *  which the schema also records as state 'aborted'. */
  match: MatchSummary & {
    state: string; winner: Winner | null; voidedAt?: string | null; voidReason?: string | null;
    /** Plan 5: the ordinal of the map this game was replayed from after a
     *  restart, null when it was never restored. */
    restoredAtMap: number | null;
  };
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
    /** The look (time of day, weather) night mode had on this map, such as
     *  "Midnight" or "Storm"; "A / B" when its two halves differed. Null or
     *  absent for a match played before the plugin logged looks. */
    look?: string | null;
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
  /** What the ratings said before the match. Admin only: the field is absent
   *  entirely for anyone else, so the page has nothing to hide. */
  forecast?: Forecast;
  /** Every SourceTV spectator on the match, admin only, absent entirely for
   *  anyone else. A session is evidence of a connection watching, never proof
   *  of who was behind it. */
  sourcetv?: SourceTvSession[];
  /** An aborted match's why, and who never got in or walked with what it
   *  cost them. Staff only, absent for anyone else. */
  abortWho?: AbortWho;
  /** Per-round side attribution. An empty array means this match predates
   *  round capture, which is NOT the same as a match that had no rounds. */
  rounds: {
    ordinal: number; half: number; survTeam: Team;
    score: number; endedAt: string | null; reliable: boolean;
    byPlayer: Record<string, Record<string, number>>;
  }[];
}

/** What GET /api/matches/:id answers, narrowed by `ongoing` so a caller has
 *  to handle the in-progress case before it can reach the finished one's
 *  fields. */
export type MatchApiResult = MatchOngoing | MatchDetail;

export interface RoundAggregate {
  attempts: number;
  fastestSec: number | null;
  avgSec: number | null;
  slowestSec: number | null;
  /** Null, not 0, when no round was measured: survivors_alive is NULL for
   *  every round played before the plugin reported it. */
  survivalPct: number | null;
  /** Rounds the percentage is over. NOT `attempts`, which counts rounds with a
   *  usable clock and is typically several times larger. */
  measured: number;
}

export interface CustomCampaignChapter { map: string; display: string | null; included: boolean }
export interface CustomCampaignRow {
  slug: string; name: string; sizeBytes: number; sha256: string;
  /** Size of the zipped download, or null when the button hands over the raw
   *  VPK (a campaign whose zip has not been made yet). */
  zipBytes: number | null;
  filename: string; notes: string | null; inPool: boolean;
  /** A practice map (Hunter Training): downloadable, never in the vote. */
  practiceOnly?: boolean;
  chapters: CustomCampaignChapter[];
}

export interface MapIndexRow {
  map: string;
  campaign: string | null;
  /** The chapter's real name from its mission file, when we have one. */
  display?: string | null;
  played: number;
  /** Mean over the recorded playings only; null when none has a real score. */
  avgScore: number | null;
  rounds: RoundAggregate;
}

export interface MapLeaderRow {
  steamid: string;
  name: string;
  games: number;
  wins: number;
  losses: number;
  stats: Record<string, number>;
  /** Per map played, to one decimal. */
  avgStats: Record<string, number>;
}

export interface MapDetail {
  map: string;
  /** Campaign slug, or null for a map the registry cannot place. */
  campaign: string | null;
  played: number;
  /** What a team typically scores here. One number, not a per-team pair:
   *  both teams hold survivor once per map, so A and B were two samples of
   *  the same quantity and comparing them compared arbitrary labels. */
  avgScore: number | null;
  /** Pooled across everyone who has played the map, per map played. */
  avgStats: Record<string, number>;
  rounds: RoundAggregate;
  players: MapLeaderRow[];
}

export interface MapBreakdownRow {
  /** Halves played as survivor on this map with a reading, and how many were
   *  survived. A different denominator from `games`, which counts maps. */
  survivalMeasured?: number;
  survived?: number;
  map: string;
  games: number;
  wins: number;
  losses: number;
  stats: Record<string, number>;
  /** Per map played, to one decimal. */
  avgStats: Record<string, number>;
  /** Which campaign this map belongs to, so a list that mixes every campaign
   *  a player has touched can label a bare chapter name that no longer
   *  identifies anything on its own. Null for a map the registry can't place.
   *
   *  Optional rather than required even though the server always sends it: the
   *  server-side row type has it optional too, and a type is a promise about
   *  our code, not about what arrives over the wire. A stale cached response,
   *  or a browser holding new JS against an older server mid-deploy, delivers
   *  a row without it whatever this says. Consumers use `?? null`. */
  campaignName?: string | null;
}

export interface ProfileMatch extends MatchSummary {
  team: Team;
  result: MatchResult;
  srDelta: number;
}

export interface SocialLink {
  platform: string;
  label: string;
  handle: string;
  /** Built by the server from a per-platform template. Nothing on this side
   *  ever constructs a profile URL, so nothing here can be pointed elsewhere. */
  url: string;
}

/** A profile edit. Every field is optional: a field the body omits is left
 *  alone, and an empty string clears it. */
export interface ProfileFieldsInput {
  bio?: string;
  pronouns?: string;
  country?: string;
  links?: Record<string, string>;
}

export interface StreamMatch { id: number; campaign: string; map: string | null }

export interface StreamCard {
  steamid: string;
  name: string;
  avatar: string | null;
  /** The Twitch login. The id is never served. */
  twitchName: string;
  title: string;
  gameName: string;
  viewers: number;
  /** Twitch's template, {width}x{height} intact. Substituted at render. */
  thumbnail: string;
  startedAt: string | null;
  /** The PUG this stream is of, when there is one. */
  match: StreamMatch | null;
}

export interface OfflineCard {
  steamid: string;
  name: string;
  avatar: string | null;
  twitchName: string;
  lastLiveAt: string | null;
}

export interface StreamsView {
  /** True when the poll cache is too old to claim anyone is live. */
  stale: boolean;
  inPug: StreamCard[];
  live: StreamCard[];
  offline: OfflineCard[];
  /** How many offline channels exist, which is not offline.length once capped. */
  offlineTotal: number;
}

export type EndorseKind = 'caller' | 'clutch' | 'vibes';

/** One player's endorse panel for one match. `given` is the viewer's OWN
 *  choices; nothing anywhere says who endorsed whom. */
export interface EndorseState {
  eligible: boolean;
  reason: string | null;
  /** UTC, `YYYY-MM-DD HH:MM:SS`. */
  closesAt: string | null;
  budget: number;
  remaining: number;
  given: { to: string; kind: EndorseKind }[];
  candidates: { steamid: string; name: string; team: Team }[];
}

export interface PendingEndorsement { matchId: number; remaining: number }

/** One line of the profile's chemistry panel. `winRate` is 0 to 1. */
export interface ChemistryLine { steamid: string; name: string; games: number; wins: number; winRate: number }

/** Null lines are absent lines: the two rates are gated by a minimum number
 *  of shared games and are simply not shown until somebody clears it. */
export interface Chemistry {
  mostPlayedWith: ChemistryLine | null;
  bestWith: ChemistryLine | null;
  worstAgainst: ChemistryLine | null;
}

/** Aggregate and anonymous: what was received, never from whom. */
export interface EndorsementSummary {
  counts: Record<EndorseKind, number>;
  total: number;
  perMatch: number;
  title: EndorseKind | null;
}

export interface Profile {
  player: {
    steamid: string;
    name: string;
    avatar: string | null;
    createdAt: string;
    bio: string | null;
    pronouns: string | null;
    country: string | null;
    /** The Twitch login, which is public. The id is never served. */
    twitchName: string | null;
  };
  social: SocialLink[];
  rating: { sr: number; mu: number; sigma: number; wins: number; losses: number } | null;
  /** Matches this player's team forfeited with !gg, and !gg votes they started.
   *  Optional so a response from before the field still renders. */
  forfeits?: { forfeits: number; ggStarted: number };
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
  /** Top-five places this season among ranked players, ranked per match.
   *  Keyed like the stat bag, plus `winrate` and `boomer_rate`. Empty for a
   *  provisional player. */
  standings?: Record<string, Standing>;
  /** Optional only for a server older than the feature. */
  chemistry?: Chemistry;
  /** Optional only for a server older than the feature. */
  endorsements?: EndorsementSummary;
  /** Optional only for a server older than the feature. */
  weeklyAwards?: PlayerAward[];
  /** Other names played under in matches, most played first, never the
   *  current one. Optional only for a server older than the feature. */
  alsoKnownAs?: { name: string; matches: number }[];
}

/** One name from a player's name history (src/playerNames.ts). `name` is the
 *  spelling used most; `sources` says whether it was a Steam persona, an
 *  in-game name, or both. */
export interface NameHistoryRow {
  name: string;
  key: string;
  matches: number;
  firstSeen: string;
  lastSeen: string;
  sources: ('steam' | 'ingame')[];
}

/** A place on this season's board: `rank` of `of` ranked players. Ties share. */
export interface Standing { rank: number; of: number }

/** Thrown for any non-OK response, carrying the status so callers can tell
 *  "not logged in" (401/403) and "no such thing" (404) apart from a real fault.
 *  `nearestSlot` carries the scrim confirm route's `no_capacity` refusal
 *  (src/routes/scrims.ts's `refuse`), which rides alongside `error` in the
 *  body; undefined for every other response. `problems` carries a tournament
 *  entry refusal (src/events/entries.ts), one row per named player who fails
 *  the entry rules; undefined for every other response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly nearestSlot?: string | null,
    readonly problems?: { steamid: string; name: string; problems: string[] }[],
  ) {
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
    // FormData sets its own content-type, including the multipart boundary
    // that the browser generates. Setting it by hand produces a request the
    // server cannot parse.
    ...(body === undefined
      ? {}
      : body instanceof FormData
        ? { body }
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (parsed as { error?: string }).error ?? `POST ${path} → ${res.status}`;
    throw new ApiError(
      res.status, msg, (parsed as { nearestSlot?: string | null }).nearestSlot,
      (parsed as { problems?: { steamid: string; name: string; problems: string[] }[] }).problems,
    );
  }
  return parsed as T;
}

async function put<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (parsed as { error?: string }).error ?? `PUT ${path} → ${res.status}`);
  return parsed as T;
}

async function del<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'DELETE' });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (parsed as { error?: string }).error ?? `DELETE ${path} → ${res.status}`);
  return parsed as T;
}

// ---------- admin ----------

export interface AdminPlayerRow {
  steamid: string;
  name: string;
  avatar: string | null;
  status: string;
  isAdmin: boolean;
  isMod: boolean;
  discordName: string | null;
  sr: number | null;
  games: number;
  createdAt: string;
  offenses: number;
}

export interface AdminBan {
  id: number; reason: string; createdBy: string; createdByName?: string | null; createdAt: string;
  expiresAt: string | null; liftedBy: string | null; liftedByName?: string | null; liftedAt: string | null;
}

export interface AdminPlayerDetail extends AdminPlayerRow {
  discordId: string | null;
  /** Every Discord account this player has linked, newest first, each with
   *  the OTHER Steam accounts that have held it. `linkedBy` is 'backfill' for
   *  a link older than the history table, whose real date nobody recorded. */
  discordHistory?: {
    discordId: string; discordName: string; linkedAt: string; linkedBy: string;
    unlinkedAt: string | null; unlinkedBy: string | null;
    others: { steamid: string; name: string | null; linkedAt: string; unlinkedAt: string | null }[];
  }[];
  activeBan: AdminBan | null;
  bans: AdminBan[];
  notes: { id: number; authorId: string; authorName: string | null; text: string; createdAt: string }[];
  matches: { id: number; campaign: string; state: string; endedAt: string | null; winner: string | null; team: string; connectedAt: string | null }[];
  penalties: { id: number; kind: string; matchId: number | null; createdAt: string; clearedBy: string | null; clearedAt: string | null }[];
  timeout: QueueTimeout | null;
  tickets: TicketSummary[];
  /** Connects that ended before the player was in game, on a map that forced
   *  files. Likely a file-consistency rejection; a cancelled loading screen
   *  looks identical. `enteredAfterAt` is when they next got in, null if never. */
  signonDrops: {
    count: number;
    lastAt: string | null;
    rows: { id: number; name: string; secsConnected: number; forcedCount: number; at: string; enteredAfterAt: string | null }[];
  };
  /** Input signatures that fired on this player's button timing. Evidence to
   *  read next to the replay, never a verdict: the only signature shipped is
   *  the one that needs no statistical tuning. */
  inputCaps: { matchId: number | null; kind: string; serverTick: number; at: string }[];
  inputFlags: {
    id: number; burstId: number; matchId: number | null; steamid: string; kind: string; signature: string; severity: string; at: string; hits: number;
    /** The most common of the bursts' own labels: wheel-like, steady-taps, fixed-hold, variable-hold, no-hold-data. */
    note: string;
    bursts: {
      id: number; at: string; weapon: string; presses: number; ratePerSec: number; meanTicks: number;
      wire: number; serverSpan: number | null; annotation: string;
      hold: { n: number; medianTicks: number; minTicks: number; maxTicks: number; sdTicks: number; oneTickFrac: number; nearMedianFrac: number } | null;
    }[];
  }[];
  /** Second Steam accounts folded into this one by a merge. Their SteamIDs
   *  still resolve here on every line the game server sends. */
  aliases: { steamid: string; canonical: string; created_at: string; created_by: string }[];
  /** Connections this account has been seen on. The address itself is never
   *  stored or sent: `ipHash` is an HMAC under a per-install salt. */
  networks: { ipHash: string; country: string | null; firstSeen: string; lastSeen: string; seenCount: number }[];
  /** Other accounts seen on one of those connections. Evidence, not proof. */
  sharesAddressWith: { steamid: string; name: string; country: string | null; seenCount: number; lastSeen: string }[];
  /** What Steam says about the account. Null until Steam has been asked, and
   *  for good on an install with no api key. Context, never a verdict. */
  steamAccount?: SteamAccount | null;
  /** Scrim records (plan 2): as a pickup captain and each current team's. */
  scrimRecord?: ScrimRecord;
}

export interface SteamAccount {
  checkedAt: string;
  /** Null for a private profile: Steam does not give the date. */
  createdAt: string | null;
  ageDays: number | null;
  /** What the age is measured against: the first match here, or the day they
   *  joined when they have not played yet. */
  reference: { kind: 'first_match' | 'joined'; at: string } | null;
  daysBeforeReference: number | null;
  visibility: 'public' | 'private' | 'unknown';
  profileConfigured: boolean | null;
  bans: { vac: number; game: number; daysSinceLast: number | null; community: boolean; economy: string; checkedAt: string } | null;
  /** `hidden` is never zero hours: game details are private. */
  l4d1:
    | { state: 'visible'; hours: number }
    | { state: 'not_owned' }
    | { state: 'hidden'; lastSeenHours: number | null }
    | null;
  level: number | null;
  /** Last account seen lending this one the game through Family Sharing, and
   *  the player here it belongs to, if any. */
  lender: { steamid: string; seenAt: string; player: { steamid: string; name: string; banned: boolean } | null } | null;
  /** Plain-worded and already hedged by the server. */
  flags: { kind: string; text: string }[];
}

/** Team SR, the gap and the paper odds. `source` says which ratings it came
 *  from: `history` for a finished match, `current` for one in flight, where
 *  the two are the same thing because nothing updates until completion. */
export interface Forecast {
  srA: number; srB: number; srGap: number;
  /** Mean mu difference, A minus B. The skill gap the odds are built from,
   *  with no uncertainty penalty. Near zero next to a large srGap means the
   *  SR lead is confidence rather than skill. */
  muGap: number;
  /** Mean skill and mean uncertainty per side. SR is mu - 2*sigma, so on its
   *  own it cannot show who was favoured; these are the halves it is made of. */
  muA: number; muB: number; sigmaA: number; sigmaB: number;
  winProbA: number; winProbB: number;
  ratedA: number; ratedB: number;
  source: 'history' | 'current';
}

/** One person watching a match over SourceTV. `accounts` is every player
 *  whose recorded connection matches this session's, evidence of the same
 *  connection watching rather than proof of who was behind it. */
export interface SourceTvSession {
  id: number;
  name: string;
  country: string | null;
  joinedAt: string;
  leftAt: string | null;
  leaveReason: string | null;
  accounts: { steamid: string; name: string | null }[];
}

export type LogAuthMode = 'off' | 'log' | 'enforce';
/** What the backend's log signature check has to say about one server. The
 *  secret itself never leaves the backend; `hasSecret` is all the page gets.
 *  Counters are since the backend last started, null when it has no verifier. */
export interface ServerLogAuth {
  mode: LogAuthMode;
  hasSecret: boolean;
  counters: {
    ok: number; missing: number; badMac: number; replay: number;
    lastOkAt: number | null; lastFailAt: number | null; lastFail: string | null;
  } | null;
}

export interface AdminOverview {
  open: {
    id: number; campaign: string; state: string; serverId: number | null; createdAt: string;
    wentLiveAt: string | null; connected: number; rostered: number;
    /** The real game server, admin only, for joining a match you are not in.
     *  Null until the match is live and has a server. Not SourceTV. */
    connect: { host: string; port: number; password: string } | null;
    forecast: Forecast | null;
    /** For the abort dialog's leave-out boxes. Optional for an older server. */
    roster?: { steamid: string; name: string }[];
    /** The booking this game belongs to, or null for an ordinary PUG match.
     *  Aborting a booking game drops the game but leaves the booking's
     *  server with it, so the abort dialog reads this to say so and skip
     *  the leave-out boxes. Optional for an older server. */
    bookingId?: number | null;
    /** Why the ping chooser gave this match its server (src/serverPick.ts);
     *  null when it did not run. Optional for an older server. */
    serverPickNote?: string | null;
  }[];
  /** In pick order: the order free servers are claimed in, first first. */
  servers: {
    id: number; name: string; host: string; port: number; status: string; enabled: number;
    tvPort: number | null; tvPassword: string | null; tvEnabled: number; restartAfterMatch?: number;
    /** Signed log lines. Optional: a payload from before it existed has none. */
    logAuth?: ServerLogAuth;
    /** The open practice lease holding this box (src/practiceLeases.ts). A
     *  leased box is 'idle' in status, so this is what says it is in use.
     *  Optional only for a browser holding new JS against an older server. */
    practice?: { leaseId: number; kind: PracticeKind; ownerName: string; ending: boolean } | null;
  }[];
  recent: { id: number; campaign: string; endedAt: string | null; teamAScore: number; teamBScore: number; winner: string | null; forecast: Forecast | null; pauses: MatchPause[]; readyups: MatchReadyup[] }[];
  /** Ended with no result. `abandonedBy` names the leaver when the abandon
   *  path ended it, and is null for an admin abort or a reaped match. */
  aborted: {
    id: number; campaign: string; endedAt: string | null; teamAScore: number; teamBScore: number; abandonedBy: string | null;
    /** Uncleared no-show penalties it handed out. Optional for an older server. */
    noShows?: number;
    /** Who it was about and what each got. Optional for an older server. */
    parties?: AbortParty[];
  }[];
  voided: { id: number; campaign: string; voidedAt: string; voidReason: string }[];
  queue: NamedPlayer[];
  /** Pops in progress (ready check or campaign vote), for Cancel pop.
   *  Optional only for a browser holding new JS against an older server. */
  lobbies?: { id: string; phase: 'ready_check' | 'map_vote'; deadline: number; players: (NamedPlayer & { ready: boolean })[] }[];
  /** Across every counted match: who is habitually the one holding up the ready-up. */
  slowToReady: SlowToReady[];
  /** Optional only for a browser holding new JS against an older server. */
  captureHealth?: CaptureHealth;
}

/** The admin live board. Mirrors src/admin/liveBoard.ts field for field.
 *  Every `...S` figure is whole seconds as of the moment the server answered;
 *  the page counts on from when the payload arrived and never compares
 *  anything here against its own wall clock. */
export type LiveBoardReason = { kind: 'signon_drop'; at: string } | { kind: 'not_in_voice' };
export type LiveBoardStatus =
  | { kind: 'connected'; remainingS: number | null }
  /** deadlineS: until the no-show rule aborts the match, extension included;
   *  null when it will not (enough connected, a round played). */
  | { kind: 'never_connected'; sincePopS: number; deadlineS?: number | null }
  | { kind: 'dropped'; sinceS: number; remainingS: number | null; held: boolean; holdLeftS: number | null };
export interface LiveBoardPlayer {
  steamid: string; name: string; team: 'a' | 'b'; status: LiveBoardStatus; reason: LiveBoardReason | null;
}
export interface LiveBoardClock {
  kind: 'abandon'; steamid: string; name: string; remainingS: number; held: boolean; holdLeftS: number | null;
}
export interface LiveBoardMatch {
  id: number;
  campaign: string;
  map: string | null;
  state: 'waiting' | 'configuring' | 'live' | 'paused';
  phase: 'live' | 'paused' | 'readyup' | 'roundover' | 'loading' | null;
  server: { id: number; name: string } | null;
  teamAScore: number;
  teamBScore: number;
  elapsedS: number;
  spectate: SpectateInfo | null;
  /** old_plugin: the server's pug-match predates 0.3.4 and has no clock control. */
  leaveControl: 'ok' | 'old_plugin' | 'unknown';
  /** False when the game server runs no reconnect clock for this match at
   *  all, which is every match that was started in game. */
  leaveTracking: boolean;
  teamA: LiveBoardPlayer[];
  teamB: LiveBoardPlayer[];
  clocks: LiveBoardClock[];
  /** The no-show rule against this match (src/noShow.ts noShowClock).
   *  Optional only for a browser holding new JS against an older server. */
  noShow?: { extraMinutes: number; deadlineS: number | null; applies: boolean; canExtend: boolean; why: string | null } | null;
  /** The booking this game belongs to, or null for a PUG. Optional only for
   *  a browser holding new JS against an older server. */
  bookingId?: number | null;
  /** The night mode look the server last rolled for this match (title like
   *  "Storm", layers from the plugin's log line). Null before the first line;
   *  optional only for a browser holding new JS against an older server. */
  look?: { title: string; preset: string; layers: { time: string; weather: string; moon: string; event: string; power: string } | null; at: string } | null;
}
export interface LiveBoard {
  now: string;
  holdMaxMinutes: number;
  /** Where a countdown starts reading as nearly out, in seconds; 0 is off. */
  lowAlertSeconds: number;
  matches: LiveBoardMatch[];
}
export type LeaveClockAction = 'hold' | 'release' | 'add' | 'end';

export interface AdminSetting {
  key: string; label: string; help: string; group: string; secret?: boolean; value: string;
  type:
    | { kind: 'int'; min: number; max: number }
    | { kind: 'string'; maxLength: number; allowEmpty: boolean }
    | { kind: 'campaigns' }
    | { kind: 'bool' }
    | { kind: 'intList'; min: number; max: number; maxItems: number }
    | { kind: 'choice'; options: { value: string; label: string }[] };
}

export interface AuditEntry {
  id: number; adminId: string; adminName: string | null; action: string; target: string;
  targetName: string | null; detail: Record<string, unknown>; createdAt: string;
}

export interface PatchSummary {
  id: number; number: number; name: string | null; notes: string;
  source: 'announced' | 'detected' | 'historical'; firstSeenAt: string; reviewed: boolean;
  /** Every round tagged with this patch (live, voided and unfinished included). */
  rounds: number;
  /** Rounds the comparison uses: computed rounds of completed, non-voided matches. */
  countedRounds: number;
  /** Merged into another patch by the boot refingerprint: keeps its rounds,
   *  gets no new ones. Optional so an older server's answer still reads. */
  merged?: boolean;
  servers: { serverId: number; name: string; lastSeenAt: string }[];
  /** When this patch was published to the public page, null while unpublished. */
  publishedAt: string | null;
  /** Patch triage. pending: undecided; balance: a real patch; folded: not
   *  balance, its rounds count for `foldedInto`. The triage fields are
   *  optional so an older server's answer still reads (as balance). */
  triage?: 'pending' | 'balance' | 'folded';
  foldedInto?: number | null;
  /** Pending or folded only: what it is judged against (the default fold
   *  target) or folded into, and the differences in plain words. */
  triageBase?: { id: number; number: number; name: string | null; needsTriage?: boolean } | null;
  comparedWith?: { id: number; number: number; name: string | null } | null;
  changes?: string[];
  plugins?: string[];
  onlyPluginsChanged?: boolean;
  /** The release that produced this config, when one did. */
  releaseId?: number | null;
}
export interface FleetSig { size: number; sha256: string | null }
export interface FleetCellView {
  sig: FleetSig | null; label: 'repo' | 'base' | 'neither' | 'missing' | 'unread'; highlight: boolean; sizeOnly: boolean;
  /** The release whose copy of this file the box has. */
  origin?: number | null;
}
export interface FleetRowView {
  path: string; area: 'plugins' | 'configs' | 'data' | 'gamedata' | 'extensions' | 'stripper' | 'other';
  repo: FleetSig | null; base: FleetSig | null; cells: Record<number, FleetCellView>; patchedEverywhere: boolean;
  removedEverywhere?: boolean; perBox?: boolean; differs: boolean;
}
export interface FleetBox { serverId: number; name: string; enabled: boolean; readAt: string | null; attemptAt: string | null; error: string | null; pending: boolean }
export interface FleetState { repo: { label: string; at: string } | null; base: { label: string; at: string } | null; boxes: FleetBox[]; rows: FleetRowView[] }
export interface ReleaseBoxView { serverId: number; name: string; state: string; error: string | null; updatedAt: string }
export interface ReleaseSummaryView {
  id: number; kind: 'deploy' | 'undo'; undoOf: number | null; commit: string; short: string; state: string;
  createdBy: string; createdAt: string; deployedBy: string | null; deployedAt: string | null; canaryServerId: number | null;
  balance: { decision: string; name: string | null; notes: string | null } | null; backupsExpired: boolean;
  boxes: ReleaseBoxView[];
}
export interface ReleaseReviewView extends ReleaseSummaryView {
  subject: string | null; github: string | null; invalid: string[]; suggestion: 'not_balance' | 'possibly_balance';
  perBox: { serverId: number; name: string; lines: string[]; warnings: string[]; deployable: boolean }[];
  groups: { servers: string[]; lines: string[] }[];
}
export interface ReleaseOverview {
  commits: { hash: string; short: string; subject: string; author: string; at: string; releaseId: number | null }[];
  releases: ReleaseSummaryView[]; inFlight: number | null; devMode: boolean; fetchError: string | null;
}
export interface GameValueView {
  id: string; label: string; unit: string | null; note: string | null; value: string | null; vanilla: string | null;
  differsFromVanilla: boolean; status: 'reported' | 'not_reported' | 'hidden';
  lastChange: { at: string; patch: { id: number; number: number; name: string } | null } | null;
  /** Admin view only: the value's condition does not hold, so the public page leaves it out. */
  conditionOff?: true;
  /** The game never reads it: shown with a tag, never marked as differing. */
  noEffect?: true;
  /** Fine tuning: folded under the group's details. */
  detail?: true;
}
/** One campaign x look row of /api/admin/balance/looks (src/mapLooks.ts). */
export interface LookStatRow {
  campaign: string;
  title: string;
  matches: number;
  rounds: number;
  avgScore: number;
  finishRate: number | null;
  avgAlive: number | null;
}
export interface LookStats { days: number; since: string; rows: LookStatRow[] }

export interface GameValues {
  /** Admin view only. */
  asOf?: { patchId: number; number: number } | null;
  /** The newest round ran a config still waiting for triage; the values are the last settled ones. */
  reviewing: boolean;
  unsettled?: true;
  groups: { id: string; label: string; values: GameValueView[]; rules: { id: string; text: string; active: boolean; draft: boolean; missing?: string[] }[] }[];
}
export interface IgnoredPlugin { file: string; reason: string; addedBy: string | null; addedAt: string | null; source: 'site' | 'knobs' }
export type TriageBody = { decision: 'balance'; name: string; notes: string } | { decision: 'fold'; into: number }
  | { decision: 'ignore'; into: number; plugins: string[] };
export interface PatchDetail extends PatchSummary {
  inputs: Record<string, string> | null;
  diffVsPrevious: { added: string[]; removed: string[]; changed: { key: string; from: string; to: string }[] } | null;
}
export interface DriftRow { serverId: number; name: string; patchId: number; since: string; differsFrom: { name: string; diff: string }[] }

export interface KnobView { cvar: string; label: string; group: string; type: 'int' | 'float'; min: number; max: number; step: number;
  baseline: string; unit?: string; note?: string; pairMax?: string }
export interface KnobDiffRow { cvar: string; label: string; group: string; from: string; to: string }
export interface KnobPreview { values: Record<string, string>; errors: string[]; diff: KnobDiffRow[]; groupsChanged: string[];
  base: { patchId: number; number: number } | null; missing: string[]; blocking: { serverId: number; name: string; diff: string; lastMatchAt?: string | null }[];
  fingerprint: string | null; existingPatch: { id: number; number: number; name: string | null; notes: string; source: string; triage?: 'pending' | 'balance' | 'folded' } | null;
  warnings: string[]; rolloutId: number | null }
export interface RolloutServer { serverId: number; name: string; state: 'pending' | 'written' | 'confirmed' | 'failed'; lastError: string | null;
  writtenAt: string | null; confirmedAt: string | null; seen: { patchId: number; number: number; at: string } | null; mismatch: string | null;
  noTransport: boolean }
export interface RolloutSummary { id: number; patchId: number; patchNumber: number; patchName: string | null; values: Record<string, string>;
  createdBy: string; createdByName: string | null; createdAt: string; supersededAt: string | null; servers: RolloutServer[] }
export interface KnobsState { knobs: KnobView[]; current: Record<string, string>; base: { patchId: number; number: number } | null;
  missing: string[]; blocking: { serverId: number; name: string; diff: string; lastMatchAt?: string | null }[]; active: RolloutSummary | null;
  restorable: { id: number; number: number; name: string | null; source: string }[] }

export type Phase = 'all' | 'tank' | 'witch' | 'event' | 'normal';

export type Verdict = 'real' | 'too_early' | 'noise' | 'no_data';

export interface SideSummary {
  matches: number;
  rounds: number;
  meanMu: number | null;
  /** Mean team rating mismatch, |survivor mu - infected mu| per round. */
  meanGap: number | null;
  olderEngineRounds: number;
  historical: boolean;
}

export interface CompareRow {
  metric: string;
  group: string;
  description: string;
  phase: Phase;
  a: number | null;
  b: number | null;
  diff: number | null;
  rel: number | null;
  lo: number | null;
  hi: number | null;
  p: number | null;
  verdict: Verdict;
  moreMatches: number | null;
  excludedMaps: string[];
  /** Both sides have data, but on no common map. */
  noSharedMaps: boolean;
  nA: number;
  nB: number;
}

export interface CompareResult {
  a: SideSummary;
  b: SideSummary;
  rows: CompareRow[];
  counts: Record<Verdict, number>;
  banners: { skill: string | null; approximate: boolean };
  ms: number;
}

export interface TrendPoint { matchId: number; endedAt: string; patchId: number | null; side: 'a' | 'b'; value: number }
export interface MapBar { map: string; a: number; b: number; roundsA: number; roundsB: number }
export interface ExampleRound { matchId: number; ordinal: number; half: number; map: string | null; value: number }
export interface PatchValue { patchId: number; label: string; value: number | null; matches: number }
export interface MetricDetail {
  metric: string;
  phase: Phase;
  trend: TrendPoint[];
  boundaries: { patchId: number; label: string; at: string }[];
  perMap: MapBar[];
  /** Every selected patch's own pooled value, oldest first. */
  perPatch: PatchValue[];
  examples: ExampleRound[];
}

export interface CompareQuery { a: number[]; b: number[]; origin: 'all' | 'queue' | 'in_game'; maps: string[]; phases: 'all' | 'split' }

function compareParams(q: CompareQuery): string {
  const p = new URLSearchParams({ a: q.a.join(','), b: q.b.join(','), origin: q.origin, phases: q.phases });
  if (q.maps.length) p.set('maps', q.maps.join(','));
  return p.toString();
}

/** Mirrors src/balancePublic.ts PublicPatch. */
export interface PublicPatch {
  id: number; number: number; name: string; notes: string;
  source: 'announced' | 'detected' | 'historical';
  /** The patch itself is a historical reconstruction. */
  approximate: boolean;
  /** First and last counted round (match_rounds.started_at, falling back to matches.ended_at). */
  firstRound: string | null; lastRound: string | null;
  matches: number; rounds: number;
  publishedAt: string | null;
}

/** Mirrors src/balancePublic.ts PublicChanges. */
export interface PublicChanges {
  knobs: { label: string; from: string; to: string }[];
  pluginsAdded: string[]; pluginsRemoved: string[]; pluginsUpdated: string[];
  /** Watched config files and the per-map stripper directory that differ, by label. */
  files: string[];
}

/** Mirrors src/balancePublic.ts PublicRow. */
export interface PublicRow {
  metric: string; group: string; label: string;
  a: number | null; b: number | null; diff: number | null; rel: number | null; lo: number | null; hi: number | null;
  verdict: Verdict; moreMatches: number | null; nA: number; nB: number; noSharedMaps: boolean;
}

/** Mirrors src/balancePublic.ts PublicEntry. */
export interface PublicEntry extends PublicPatch {
  /** The baseline: nearest earlier published patch with counted rounds. */
  previous: { id: number; name: string } | null;
  status: 'compared' | 'first' | 'no_rounds';
  changes: PublicChanges | null;
  /** Why `changes` is null: this patch is historical, this patch or the baseline
   *  has no recorded inputs, or there is no baseline. */
  changesUnavailable: 'historical' | 'unrecorded' | 'previous_unrecorded' | 'first' | null;
  /** The newest patch in the public timeline, or one a server is running now. */
  live: boolean;
  effect: {
    a: { matches: number; rounds: number }; b: { matches: number; rounds: number };
    skill: 'differs' | 'unavailable' | null; approximate: boolean; rows: PublicRow[];
  } | null;
}

/** These mirror the DB rows exactly, because the admin campaigns route
 *  returns them unshaped. */
export interface AdminChapter {
  slug: string; ordinal: number; map: string; display: string | null;
  is_finale: number; included: number; play_order: number | null;
}
export interface AdminInstall {
  slug: string; server_id: number; state: 'pending' | 'installed' | 'failed';
  sha256: string | null; error: string | null; updated_at: number;
}
export interface AdminCampaign {
  slug: string; name: string; vpk_filename: string; size_bytes: number;
  sha256: string; state: 'draft' | 'published'; enabled: number;
  uploaded_by: string | null; uploaded_at: number; notes: string | null;
  chapters: AdminChapter[];
  installs: AdminInstall[];
  /** Null when unconfigured: the campaign plays every chapter but the last,
   *  the same default the plugin falls back to on its own. */
  mapsToPlay: number | null;
  /** Every map in play order, from the registry. Empty when the site cannot
   *  see this campaign's chapters (e.g. a stock campaign with no
   *  MISSIONS_DIR configured), which is also what disables this control. */
  maps: string[];
  /** Custom campaigns only: installs and downloads, never offered for the PUG pool. */
  practiceOnly?: boolean;
  /** True for the stock four, which have no custom_campaigns row and so no
   *  upload, reinstall or delete controls. */
  stock: boolean;
}

export interface ReportEligibility {
  canReport: boolean;
  reason?: string;
  targets?: { steamid: string; name: string; alreadyReported: boolean }[];
}

export interface MyReport {
  id: number; targetId: string | null; targetDiscordId: string | null; targetName: string | null; category: string;
  matchId: number | null; createdAt: string; status: 'open' | 'closed';
}

/** Whether anything is being captured at all. An empty panel cannot otherwise
 *  tell "nothing suspicious" apart from "silently broken". */
export interface CaptureHealth {
  bursts: number;
  detections: number;
  lilacFlags: number;
  lastBurstAt: string | null;
  lastFlagAt: string | null;
  matchesWithBursts: number;
  caps: number;
}

export interface IntegrityFlag {
  id: number;
  matchId: number | null;
  steamid: string;
  source: string;
  kind: string;
  severity: 'suspected' | 'banned';
  detail: string;
  at: string;
}

export interface IntegrityClip {
  id: number;
  matchId: number;
  ordinal: number;
  half: number;
  slot: number;
  startMs: number;
  endMs: number;
  kind: string;
  score: number;
  detail: Record<string, unknown>;
}

export interface IntegrityRound {
  matchId: number;
  ordinal: number;
  half: number;
  slot: number;
  campaign: string | null;
  metrics: {
    fidMax: number; fidP95: number;
    /** Tracking windows that formed, how many held enough ghost movement to
     *  score, and the sum of those scores. */
    windows: number; scoreable: number; fidSum: number;
    /** Metric B as sums over 2 second blocks, null on a map with no baseline
     *  yet. The score on the board is worked out from these on the server. */
    occ: { observed: number; expected: number; expectedSq: number; blocks: number; pairs: number } | null;
    /** Pairs that cleared every eligibility gate: how many chances the
     *  detector actually had. Zero here means it never ran, which is a very
     *  different statement from a clean round. */
    eligiblePairs: number;
    gates: {
      considered: number; notLive: number; notGhost: number;
      inGrace: number; tooClose: number; occluded: number; passed: number;
    };
  };
  computedAt: string;
  reviewState: string;
  reviewNote: string;
}

/** State of the analysis job, plus what pressing the button would achieve.
 *  `available: false` is an install with no replay directory at all. */
export type IntegrityJobInfo =
  | { available: false }
  | {
    available: true;
    job: {
      status: 'idle' | 'running' | 'done' | 'failed';
      mode: 'full' | 'pending' | null;
      startedAt: string | null;
      finishedAt: string | null;
      exitCode: number | null;
      output: string[];
    };
    /** Indexed rounds no current-version analysis has measured. */
    pending: number;
    /** Rounds the current analyzer tried and could not measure. Not pending:
     *  it will not try them again until the analyzer changes. */
    unanalysable?: { missing: number; unreadable: number };
    matchInFlight: boolean;
  };

// ---------- tickets ----------

export interface TicketSummary {
  id: number; targetId: string | null; targetDiscordId: string | null; targetName: string | null; status: 'open' | 'closed'; outcome: string | null;
  restricted: boolean; claimedBy: string | null; claimedByName: string | null;
  reports: number; reporters: number; categories: string[];
  createdAt: string; lastReportAt: string | null; closedAt: string | null;
}
export interface TicketReport {
  id: number; reporterId: string | null; reporterDiscordId: string | null; reporterName: string | null; category: string; text: string;
  matchId: number | null; campaign: string | null; moment: { ordinal: number; half: number; tMs: number } | null; createdAt: string;
  /** Each side's team in that match, null when off its roster. */
  reporterTeam?: 'a' | 'b' | null; targetTeam?: 'a' | 'b' | null;
  /** The shared community entry the report is about. Optional only for a browser holding new JS against an older server. */
  entry?: { id: number; kind: CommunityKind; title: string; removed: boolean } | null;
  /** 'game' when an in-game /mod call filed it. Optional for an older server. */
  source?: string | null;
}
export interface TicketEvent {
  id: number; actorId: string | null; actorName: string | null; kind: string; detail: Record<string, unknown>; createdAt: string;
}
/** The accused, as a moderator may see them. Narrower than AdminPlayerDetail
 *  on purpose: no notes, no match list, no hashed network rows. */
export interface CaseFile {
  steamid: string; name: string; avatar: string | null; status: string; sr: number | null; games: number; createdAt: string | null;
  activeBan: AdminBan | null; bans: AdminBan[];
  penalties: AdminPlayerDetail['penalties']; timeout: AdminPlayerDetail['timeout'];
  inputFlags: AdminPlayerDetail['inputFlags']; aliases: AdminPlayerDetail['aliases'];
  sharesAddressWith: AdminPlayerDetail['sharesAddressWith']; tickets: TicketSummary[];
  /** Optional only for a browser holding new JS against an older server. */
  discordSanctions?: DiscordSanction[];
}
/** A Discord-side timeout or ban, on a Discord-only accused. Every row for
 *  their Discord id across every ticket, redacted server-side where the row
 *  belongs to a restricted ticket this viewer cannot open: `ticketId` is
 *  nulled, `reason` is replaced by a fixed withheld message, and the issuer
 *  (`createdBy`, `createdByName`) and `liftedBy` are blanked. */
export interface DiscordSanction {
  id: number; kind: 'timeout' | 'ban'; until: string | null; reason: string; ticketId: number | null;
  createdBy: string; createdByName: string | null; createdAt: string;
  liftedBy: string | null; liftedAt: string | null; active: boolean;
}
export interface TicketDiscussion {
  state: 'ready' | 'pending' | 'unconfigured' | 'restricted' | 'none';
  surface: 'forum' | 'private' | null;
  url: string | null;
}
export interface ReporterChat { id: number; reporterName: string; state: 'open' | 'ended'; url: string | null }

export interface TicketAttachment {
  id: number; filename: string; contentType: string; size: number; sha256: string | null;
  /** On the server and not removed: it can be fetched. */
  stored: boolean;
  skipReason: 'too_large' | 'type' | 'quota' | 'disabled' | 'fetch_failed' | null;
  removed: boolean;
}
/** One message mirrored from a ticket's Discord thread. `removed` set means a
 *  tombstone: content and history are empty and no file can be fetched. */
export interface TicketMessage {
  id: number; channel: 'staff' | 'reporter'; authorName: string; authorPlayerId: string | null; authorPlayerName: string | null;
  content: string; history: string[]; createdAt: string; editedAt: string | null; deletedAt: string | null;
  removed: { at: string; by: string | null; byName: string | null; reason: string } | null;
  attachments: TicketAttachment[];
}

export interface TicketDetail {
  ticket: TicketSummary & { outcomeNote: string; openedBy: string | null; openedByName: string | null; closedBy: string | null; closedByName: string | null };
  reports: TicketReport[];
  events: TicketEvent[];
  bans: { id: number; reason: string; createdBy: string; createdByName: string | null; createdAt: string; expiresAt: string | null; liftedAt: string | null }[];
  discordSanctions: DiscordSanction[];
  access: { steamid: string; name: string }[];
  accessCandidates: { steamid: string; name: string }[];
  discussion: TicketDiscussion;
  messages: TicketMessage[];
  /** Optional only for a browser holding new JS against an older server. */
  reporterChats?: ReporterChat[];
  caseFile: CaseFile | null;
  /** The accused as the Player File's glance row shows them. Null only if
   *  the player row vanished under the ticket. */
  summary: FileSummaryData | null;
  /** banCapMinutes null means no cap: the viewer is an admin. */
  viewer: { isAdmin: boolean; banCapMinutes: number | null };
}

export interface TicketCounts { open: number; mine: number; closed: number }

// ---------- people ----------

export type TimelineSource =
  | 'input' | 'lilac' | 'analyzer' | 'drop' | 'ticket' | 'penalty' | 'ban'
  | 'note' | 'steam' | 'discord_link' | 'cvar' | 'conduct' | 'spray';

/** One row of a player's merged history. The summary is written on the
 *  server so every surface says the same sentence about the same evidence. */
export interface TimelineItem {
  at: string;
  source: TimelineSource;
  kind: string;
  summary: string;
  matchId: number | null;
  replay: { ordinal: number; half: number; tMs: number } | null;
  ref: { type: string; id: number | string } | null;
}

/** Mirrors src/admin/fileAccess.ts. `review_round` is admin-only: it marks a
 *  round reviewed from the replay analyzer. `steam_refresh` is admin-only
 *  too: it gates the Steam account panel's "Check now". */
export type FileAction =
  | 'note' | 'looked_at' | 'open_ticket'
  | 'ban' | 'timeout' | 'merge' | 'sign_out' | 'waive' | 'staff_flags' | 'review_round' | 'steam_refresh';

export type InfectedClass = 'smoker' | 'boomer' | 'hunter';
export interface ClassScores { hiddenShare: number | null; hiddenOccZ: number | null; revealShare: number | null }

/** The analyzer board's columns for one player. A sort key, never a claim.
 *  Mirrors src/admin/analyzerRanks.ts. The hidden columns (D, E, F) are shown
 *  beside the rank and are not part of it. */
export interface AnalyzerRank {
  steamid: string; ranked: boolean; rank: number | null; of: number;
  rounds: number; eligibleRounds: number; clips: number;
  trackShare: number | null; occZ: number | null; teamGap: number | null;
  pFid: number | null; pOcc: number | null; pGap: number | null; composite: number | null;
  losRounds: number; hiddenShare: number | null; hiddenOccZ: number | null;
  reveals: number; revealShare: number | null;
  pHidden: number | null; pHiddenOcc: number | null; pReveal: number | null;
  byClass: Record<InfectedClass, ClassScores>;
}

export interface FileReview {
  id: number; steamid: string; reviewedBy: string; reviewedByName: string | null;
  reviewedAt: string; note: string;
}

/** "Is there anything here": the file's own glance row, and the accused's
 *  section of a ticket page. fileUrl is null when the viewer may not open
 *  the whole file. */
export interface FileSummaryData {
  steamid: string; name: string; avatar: string | null; status: string;
  isAdmin: boolean; isMod: boolean; sr: number | null; games: number; createdAt: string | null;
  activeBan: AdminBan | null; bans: number; penalties: number;
  timeout: QueueTimeout | null;
  openTickets: number; aliases: number;
  sharesAddressWith: { steamid: string; name: string }[];
  steamFlags: { kind: string; text: string }[];
  evidence: { source: TimelineSource; count: number }[];
  analyzer: AnalyzerRank | null;
  lastReview: FileReview | null;
  fileUrl: string | null;
}

export interface PlayerFileData {
  steamid: string;
  header: {
    steamid: string; name: string; avatar: string | null; status: string;
    isAdmin: boolean; isMod: boolean; isCaster: boolean; discordName: string | null;
    sr: number | null; games: number; createdAt: string;
  };
  glance: FileSummaryData;
  timeline: TimelineItem[];
  sections: {
    identity: {
      aliases: AdminPlayerDetail['aliases'];
      discordHistory: NonNullable<AdminPlayerDetail['discordHistory']>;
      steamAccount: SteamAccount | null;
      networks: AdminPlayerDetail['networks'];
      sharesAddressWith: AdminPlayerDetail['sharesAddressWith'];
      /** Every name played under in a match, most played first. Optional
       *  only for a browser holding new JS against an older server. */
      names?: NameHistoryRow[];
      /** Alt holds naming this account on either side. Optional for an older server. */
      altHolds?: AltHold[];
    };
    standing: {
      activeBan: AdminBan | null;
      bans: AdminBan[];
      penalties: AdminPlayerDetail['penalties'];
      timeout: AdminPlayerDetail['timeout'];
      /** Optional only for a browser holding new JS against an older server. */
      discordSanctions?: DiscordSanction[];
    };
    matches: AdminPlayerDetail['matches'];
    /** Optional only for a browser holding new JS against an older server. */
    conduct?: ConductSection;
    /** Scrim records (plan 2). Optional only for an older server. */
    scrims?: ScrimRecord;
    /** Review aggregates and toxic flags (plan 2 Ruling 6), beside scrims.
     *  Optional only for an older server. */
    scrimReviews?: ScrimReviews;
    /** A player's scrim blocks (scrim blocks plan), beside scrims: read-only
     *  for staff. Optional only for an older server. */
    scrimBlocks?: ScrimBlocks;
    tickets: TicketSummary[];
    notes: AdminPlayerDetail['notes'];
    evidence: {
      analyzer: AnalyzerRank | null;
      rounds: IntegrityRound[];
      clips: IntegrityClip[];
      flags: IntegrityFlag[];
      inputFlags: AdminPlayerDetail['inputFlags'];
      inputCaps: AdminPlayerDetail['inputCaps'];
      signonDrops: AdminPlayerDetail['signonDrops'];
    };
  };
  actions: FileAction[];
  lastReview: FileReview | null;
}

export interface NeedsALookRow {
  steamid: string; name: string; avatar: string | null; status: string;
  newestEvidenceAt: string; sources: TimelineSource[];
  /** What is new since the last look, in one sentence. Optional for an older server. */
  arrived?: string;
  lastReviewAt: string | null; lastReviewBy: string | null;
  openTickets: number; analyzer: AnalyzerRank | null;
}

/** One row of "everyone the analyzer has measured": the board's own columns
 *  plus the name to print. Mirrors MeasuredRow in src/admin/needsALook.ts. */
export type MeasuredRow = AnalyzerRank & { name: string };

export interface PeopleBan {
  id: number; steamid: string; name: string; reason: string; length: string;
  createdAt: string; expiresAt: string | null; createdByName: string | null;
  liftedAt: string | null; liftedByName: string | null; active: boolean;
  ticketId: number | null; withheld: boolean; canOpen: boolean;
  /** An alt hold rather than a ban staff issued. Optional for an older server. */
  hold?: boolean;
}

/** The People desk. Moderators may call all of it; the admin-only actions a
 *  file offers stay on adminApi, which is where the server enforces them. */
export const peopleApi = {
  people: (q: string, signal?: AbortSignal) =>
    get<{ players: AdminPlayerRow[] }>(`/api/admin/people?q=${encodeURIComponent(q)}`, signal),
  file: (steamid: string, signal?: AbortSignal) =>
    get<PlayerFileData>(`/api/admin/people/${encodeURIComponent(steamid)}`, signal),
  review: (signal?: AbortSignal) =>
    get<{ players: NeedsALookRow[]; measured: MeasuredRow[]; health: CaptureHealth }>(
      '/api/admin/people/review', signal,
    ),
  bans: (filter: 'active' | 'expired' | 'all', q: string, signal?: AbortSignal) =>
    get<{ bans: PeopleBan[] }>(`/api/admin/people/bans?filter=${filter}&q=${encodeURIComponent(q)}`, signal),
  note: (steamid: string, text: string) =>
    post<{ ok: true }>(`/api/admin/people/${encodeURIComponent(steamid)}/notes`, { text }),
  lookedAt: (steamid: string, note: string) =>
    post<{ ok: true; review: FileReview }>(`/api/admin/people/${encodeURIComponent(steamid)}/looked-at`, { note }),
  chat: (matchId: number, signal?: AbortSignal) =>
    get<{ lines: StaffChatLine[] }>(`/api/admin/people/chat/${matchId}`, signal),
  alts: (signal?: AbortSignal) =>
    get<{ open: AltHold[]; settled: AltHold[]; clusters: AltCluster[] }>('/api/admin/people/alts', signal),
  liftHold: (id: number) => post<{ ok: true }>(`/api/admin/people/alts/${id}/lift`),
  banFromHold: (id: number, reason: string) => post<{ ok: true }>(`/api/admin/people/alts/${id}/ban`, { reason }),
  pings: (signal?: AbortSignal) => get<PingTable>('/api/admin/people/pings', signal),
};

/** Each player's typical ping to each server host (src/serverPick.ts). */
export interface PingTable {
  /** In pick order; `label` names the servers on that host. */
  hosts: { host: string; label: string }[];
  /** Keyed by host; a host with no recent rounds is absent. */
  players: { steamid: string; name: string; cells: Record<string, { ms: number; rounds: number; loss: number }> }[];
  pickByPing: boolean;
}

/** The state machine behind an appeal (src/appeals/types.ts). */
export type AppealState = 'open' | 'asked' | 'answered' | 'accepted' | 'shortened' | 'denied' | 'auto_denied' | 'lapsed' | 'moot';
/** Which ban or sanction an appeal is about. A body names this; the server
 *  only accepts it if it is among the signed-in identity's own active ones. */
export interface AppealRef { kind: 'ban' | 'sanction'; id: number }
/** One ban, hold or Discord sanction as seen by the person it was issued to. */
export interface PlayerAppealItem {
  ref: AppealRef; hold: boolean; sanctionKind: 'timeout' | 'ban' | null; reason: string; endsAt: string | null;
  canAppeal: boolean; refusal: string | null;
  appeal: { id: number; state: AppealState; question: string | null; answerBy: string | null; line: string | null; filedAt: string } | null;
}
export interface MyAppeals { enabled: boolean; signedInAs: 'steam' | 'discord'; name: string; textMax: number; answerMax: number; items: PlayerAppealItem[] }

export const appealApi = {
  mine: (signal?: AbortSignal) => get<MyAppeals>('/api/appeals/mine', signal),
  file: (ref: AppealRef, whatHappened: string, whyLift: string) =>
    post<{ ok: true; id: number; state: AppealState }>('/api/appeals', { kind: ref.kind, id: ref.id, whatHappened, whyLift }),
  answer: (id: number, answer: string) => post<{ ok: true }>(`/api/appeals/${id}/answer`, { answer }),
  signOut: () => post<{ ok: true }>('/api/appeals/sign-out'),
};

/** One appeal as seen on the staff list (src/appeals/views.ts). */
export interface StaffAppealRow {
  id: number; state: AppealState; name: string; steamid: string | null; discordId: string | null;
  about: 'ban' | 'hold' | 'timeout' | 'discord ban'; filedAt: string; decidedAt: string | null;
}
/** One appeal in full, as seen on its own staff page. */
export interface StaffAppealDetail extends StaffAppealRow {
  whatHappened: string; whyLift: string;
  question: string | null; askedByName: string | null; askedAt: string | null;
  answer: string | null; answeredAt: string | null; answerBy: string | null;
  decidedByName: string | null; newExpiresAt: string | null; slurs: string[];
  target: { reason: string; createdByName: string; createdAt: string; endsAt: string | null; ticketId: number | null; noAppeal: boolean; inForce: boolean };
  earlier: { id: number; state: AppealState; decidedAt: string | null }[];
  canDecide: boolean; canShorten: boolean; canMarkFinal: boolean;
}
export const appealStaffApi = {
  list: (which: 'open' | 'closed', signal?: AbortSignal) => get<{ appeals: StaffAppealRow[] }>(`/api/mod/appeals?state=${which}`, signal),
  get: (id: number, signal?: AbortSignal) => get<StaffAppealDetail>(`/api/mod/appeals/${id}`, signal),
  ask: (id: number, question: string) => post<{ ok: true }>(`/api/mod/appeals/${id}/ask`, { question }),
  decide: (id: number, outcome: 'accept' | 'shorten' | 'deny', endsAt?: string) =>
    post<{ ok: true }>(`/api/mod/appeals/${id}/decide`, { outcome, endsAt }),
  markFinal: (id: number, on: boolean) => post<{ ok: true }>(`/api/admin/appeals/${id}/final`, { on }),
};

/** An alt hold: `steamid` was held because its Discord came from
 *  `otherSteamid`. See src/altHolds.ts. */
export interface AltHold {
  id: number;
  steamid: string;
  name: string;
  otherSteamid: string;
  otherName: string;
  otherBanned: boolean;
  discordId: string;
  discordName: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolution: 'cleared' | 'banned' | 'merged' | null;
}

export type AltSignal = 'discord' | 'merged' | 'lender' | 'connection';

/** Accounts tied together by something the site has seen. */
export interface AltCluster {
  members: { steamid: string; name: string; banned: boolean; held: boolean; lastSeen: string | null }[];
  edges: { a: string; b: string; signal: AltSignal; detail: string; at: string | null }[];
  latest: string | null;
  hasOpenHold: boolean;
  strong: boolean;
}

/** One chat line of a finished match, as staff see it. `half` is -1 before
 *  the first round of a map; `tMs` is -1 when no round clock was running
 *  (ready-up, a pause, between rounds). `player` is the merged account. */
export interface StaffChatLine {
  seq: number;
  mapOrdinal: number;
  half: number;
  tMs: number;
  steamid: string;
  player: string;
  name: string;
  team: 'a' | 'b' | null;
  message: string;
}

/** Where a stored ticket file is served from. A plain function, not part of
 *  modApi: it makes no request, it is what an <img> points at. */
export const ticketAttachmentUrl = (ticketId: number, attachmentId: number): string =>
  `/api/mod/tickets/${ticketId}/attachments/${attachmentId}`;

/** One in-game /mod call on the In-game calls desk. Mirrors src/routes/modCalls.ts. */
export interface ModCallView {
  id: number; createdAt: string; serverId: number | null; serverName: string | null; map: string | null; matchId: number | null;
  moment: { ordinal: number; half: number; tMs: number } | null;
  reason: string; reasonLabel: string; via: 'game' | 'tv';
  caller: { steamid: string; name: string };
  target: { kind: 'player' | 'team' | 'general' | 'none'; steamid: string | null; name: string | null };
  text: string; ticketId: number | null; note: string; postState: string; pinged: boolean;
  handledBy: string | null; handledAt: string | null; folded: ModCallView[];
}

/** Server chat (src/routes/serverChat.ts). */
export interface ChatServerView { id: number; name: string; state: 'match' | 'booking' | 'practice' | 'side' | 'idle' | 'offline'; lastAt: number | null }
export interface ChatLineView {
  id: number; at: number; kind: 'say' | 'staff_in' | 'staff_out'; steamid: string | null; name: string | null;
  team: number | null; scope: 'all' | 'team' | null; message: string; matchId: number | null;
  siteName: string | null;
  to: { kind: 'all' | 'team' | 'player'; value: string | null; name: string | null } | null;
  delivered: number | null;
}
export interface ChatLinesPage { server: { id: number; name: string }; lines: ChatLineView[]; hasEarlier: boolean }
export type ChatSendBody =
  | { to: 'all'; message: string }
  | { to: 'team'; team: 1 | 2 | 3; message: string }
  | { to: 'player'; steamid: string; message: string };

export const modApi = {
  calls: (filter: 'open' | 'all', signal?: AbortSignal) =>
    get<{ calls: ModCallView[]; discordReady: boolean }>(`/api/mod/calls?filter=${filter}`, signal),
  /** Mark an in-game call handled, as the Discord card's button does. */
  handleCall: (id: number) => post<{ ok: true }>(`/api/mod/calls/${id}/handle`),
  chatServers: (signal?: AbortSignal) => get<{ servers: ChatServerView[] }>('/api/mod/chat/servers', signal),
  /** The drawer's opening view: during a live match, that match's chat only. */
  chatLines: (serverId: number, signal?: AbortSignal) =>
    get<ChatLinesPage & { currentMatchId: number | null }>(`/api/mod/chat/${serverId}`, signal),
  /** One page further back than line `before`, any match. */
  chatEarlier: (serverId: number, before: number, signal?: AbortSignal) =>
    get<ChatLinesPage>(`/api/mod/chat/${serverId}?before=${before}`, signal),
  chatSend: (serverId: number, body: ChatSendBody) => post<{ ok: true; id: number }>(`/api/mod/chat/${serverId}`, body),
  /** Humans on the server right now (rcon status), for the Whisper picker. */
  chatPlayers: (serverId: number) => get<{ players: { steamid: string; name: string }[] }>(`/api/mod/chat/${serverId}/players`),
  tickets: (filter: 'open' | 'mine' | 'closed', signal?: AbortSignal) =>
    get<{ tickets: TicketSummary[]; counts: TicketCounts }>(`/api/mod/tickets?filter=${filter}`, signal),
  ticket: (id: number, signal?: AbortSignal) => get<TicketDetail>(`/api/mod/tickets/${id}`, signal),
  /** ticketId is null when the ticket is restricted and the opener is not on
   *  its access list: the note landed, and there is nothing to open. */
  open: (targetId: string, note: string, restricted: boolean) =>
    post<{ ok: true; ticketId: number | null }>('/api/mod/tickets', { targetId, note, restricted }),
  claim: (id: number, claim: boolean) => post(`/api/mod/tickets/${id}/claim`, { claim }),
  restrict: (id: number, restricted: boolean) => post(`/api/mod/tickets/${id}/restrict`, { restricted }),
  access: (id: number, steamid: string) => post(`/api/mod/tickets/${id}/access`, { steamid }),
  ban: (id: number, reason: string, minutes: number | null) => post(`/api/mod/tickets/${id}/ban`, { reason, minutes }),
  close: (id: number, outcome: string, note: string, tellReporters = true) => post(`/api/mod/tickets/${id}/close`, { outcome, note, tellReporters }),
  reopen: (id: number) => post(`/api/mod/tickets/${id}/reopen`),
  removeMessage: (id: number, messageId: number, reason: string) =>
    post(`/api/mod/tickets/${id}/messages/${messageId}/remove`, { reason }),
  discordSanction: (id: number, kind: 'timeout' | 'ban', minutes: number | null, reason: string) =>
    post(`/api/mod/tickets/${id}/discord-sanction`, { kind, minutes, reason }),
  liftDiscordSanction: (sid: number) => post(`/api/mod/discord-sanctions/${sid}/lift`),
  contactReporter: (id: number, reportId: number) => post<{ ok: true; url: string }>(`/api/mod/tickets/${id}/reports/${reportId}/contact`),
  joinChats: (id: number) => post<{ ok: true; url: string }>(`/api/mod/tickets/${id}/chats/join`),
  endChat: (id: number, chatId: number) => post(`/api/mod/tickets/${id}/chats/${chatId}/end`),
  removeEverything: (id: number, chatId: number) =>
    post<{ ok: true; removed: number; ended: boolean }>(`/api/mod/tickets/${id}/chats/${chatId}/remove-all`),
};

/** One live match on the Cast page. Mirrors src/routes/cast.ts. */
export interface CastMatch {
  id: number;
  campaign: string;
  campaignName: string;
  currentMap: string | null;
  /** 1-based chapter being played. */
  mapNumber: number;
  /** Chapters in the campaign, null when unknown. */
  mapCount: number | null;
  /** Running totals over finished maps. */
  teamAScore: number;
  teamBScore: number;
  phase: LivePhase['state'] | null;
  /** 1 or 2 while a round is being played. */
  half: number | null;
  serverName: string | null;
  teamA: string[];
  teamB: string[];
  /** Null for a match started in game: its password is the box's own. */
  connect: { host: string; port: number; password: string } | null;
  spectate: SpectateInfo | null;
  /** A booking's game (plan 4c): connect is always null, SourceTV only. */
  booked: boolean;
}

export const castApi = {
  list: (signal?: AbortSignal) => get<{ matches: CastMatch[] }>('/api/cast', signal),
};

/** Caster studio (src/routes/castStudio.ts). */
export interface StudioPickMatch {
  id: number; kind: string; state: string; campaign: string; campaignName: string;
  teamA: string[]; teamB: string[]; scoreA: number; scoreB: number; bookingId: number | null;
  createdAt: string; endedAt: string | null;
}
export interface StudioPickBooking {
  id: number; purpose: string; state: string; startsAt: string; sideA: string; sideB: string; latestMatchId: number | null;
}
export interface StudioPanel {
  studio: StudioState;
  rev: number;
  key: string;
  matches: StudioPickMatch[];
  bookings: StudioPickBooking[];
  obsScenes: Record<string, string>;
}
export interface PrepSheet {
  players: {
    steamid: string; name: string; team: 'a' | 'b'; matches: number; form: ('W' | 'L' | 'D')[];
    avg: { sidmg: number; ck: number; skeets: number; dps: number; tankDmg: number };
    best: { label: string; value: number; matchId: number }[];
    campaigns: { name: string; played: number; won: number }[];
  }[];
  rivalries: { a: string; b: string; met: number; aWon: number }[];
  duos: { team: 'a' | 'b'; a: string; b: string; together: number; won: number }[];
}

export const studioApi = {
  get: (signal?: AbortSignal) => get<StudioPanel>('/api/cast/studio', signal),
  save: (state: StudioState) => put<{ studio: StudioState; rev: number }>('/api/cast/studio', state),
  callout: (c: { title: string; text: string; team: 'a' | 'b' | null }) => post<{ studio: StudioState; rev: number }>('/api/cast/studio/callout', c),
  clearCallout: () => post<{ studio: StudioState; rev: number }>('/api/cast/studio/callout/clear'),
  newKey: () => post<{ key: string }>('/api/cast/studio/key'),
  feed: (signal?: AbortSignal) => get<OverlayFeed>('/api/cast/studio/feed', signal),
  prep: (matchId: number, signal?: AbortSignal) => get<PrepSheet>(`/api/cast/studio/prep/${matchId}`, signal),
};

// ---------- teams ----------

export type TeamRole = 'captain' | 'cocaptain' | 'member';
export interface TeamListItem { slug: string; name: string; tag: string; logoKey: string | null; members: number; captainName: string }
export interface MyTeamItem { slug: string; name: string; tag: string; logoKey: string | null; role: TeamRole; members: number }
export interface TeamInviteItem { id: number; slug: string; name: string; tag: string; invitedByName: string | null; createdAt: string }
export interface TeamMemberView { steamid: string; name: string; avatar: string | null; role: TeamRole; joinedAt: string }
export interface TeamView {
  slug: string; name: string; tag: string; logoKey: string | null; createdAt: string; disbandedAt: string | null;
  captain: string; members: TeamMemberView[]; former: { steamid: string; name: string; leftAt: string }[];
  viewer: { role: TeamRole | null; staff: boolean };
  manage: { invites: { id: number; steamid: string; name: string; createdAt: string }[]; joinLinkToken: string | null } | null;
  /** The team's scrim record: members and staff only, unless the record is
   *  public. Absent for everyone else. */
  record?: ScrimReliability;
  /** Sent with record: whether the record is public, so it shows as a badge. */
  recordPublic?: boolean;
  /** The aggregate of reviews the team received (plan 2): current members and
   *  staff only, regardless of scrim_reliability_public. Absent otherwise. */
  reviews?: ReviewSummary;
}

export const logoUrl = (key: string): string => `/api/teams/logos/${key}.png`;

const enc = encodeURIComponent;
export const teamsApi = {
  list: (signal?: AbortSignal) => get<{ teams: TeamListItem[] }>('/api/teams', signal),
  mine: (signal?: AbortSignal) => get<{ teams: MyTeamItem[]; invites: TeamInviteItem[]; canCreate: boolean }>('/api/teams/mine', signal),
  get: (slug: string, signal?: AbortSignal) => get<TeamView>(`/api/teams/${enc(slug)}`, signal),
  search: (q: string, signal?: AbortSignal) =>
    get<{ players: { steamid: string; name: string; avatar: string | null }[] }>(`/api/teams/player-search?q=${enc(q)}`, signal),
  create: (name: string, tag: string) => post<{ slug: string }>('/api/teams', { name, tag }),
  invite: (slug: string, steamid: string) => post<{ inviteId: number }>(`/api/teams/${enc(slug)}/invites`, { steamid }),
  accept: (id: number) => post<{ slug: string }>(`/api/teams/invites/${id}/accept`),
  decline: (id: number) => post<{ slug: string }>(`/api/teams/invites/${id}/decline`),
  cancelInvite: (id: number) => post(`/api/teams/invites/${id}/cancel`),
  joinLink: (slug: string, on: boolean) => post<{ token: string | null }>(`/api/teams/${enc(slug)}/join-link`, { on }),
  joinInfo: (token: string, signal?: AbortSignal) =>
    get<{ slug: string; name: string; tag: string; logoKey: string | null; members: number; captainName: string }>(`/api/teams/join/${enc(token)}`, signal),
  join: (token: string) => post<{ slug: string }>(`/api/teams/join/${enc(token)}`),
  leave: (slug: string) => post<{ disbanded: boolean; captain: string | null }>(`/api/teams/${enc(slug)}/leave`),
  kick: (slug: string, steamid: string) => post(`/api/teams/${enc(slug)}/members/${enc(steamid)}/kick`),
  setRole: (slug: string, steamid: string, role: 'cocaptain' | 'member') => post(`/api/teams/${enc(slug)}/members/${enc(steamid)}/role`, { role }),
  makeCaptain: (slug: string, steamid: string) => post(`/api/teams/${enc(slug)}/captain`, { steamid }),
  rename: (slug: string, body: { name?: string; tag?: string }) => post<{ name: string; tag: string }>(`/api/teams/${enc(slug)}/rename`, body),
  disband: (slug: string) => post(`/api/teams/${enc(slug)}/disband`),
  logo: (slug: string, png: string) => post<{ logoKey: string }>(`/api/teams/${enc(slug)}/logo`, { png }),
  scrims: (slug: string, signal?: AbortSignal) => get<{ scrims: TeamScrim[] }>(`/api/teams/${enc(slug)}/scrims`, signal),
};

// ---------- events (tournaments plan T1a; mirrors src/events/validate.ts, src/events/views.ts) ----------

export type EventStatus = 'draft' | 'announced' | 'registration' | 'checkin' | 'live' | 'finished' | 'cancelled';
export type EntryKind = 'team' | 'draft';
export type StageType = 'single_elim' | 'double_elim' | 'round_robin' | 'swiss' | 'league';
export type VetoType = 'ban_to_one' | 'home_away' | 'pick_ban';
export type Scheduling = 'rolling' | 'window';
export interface EventEligibility { minPugs: number; requireDiscord: boolean; srFloor: number | null; srCeiling: number | null }
export interface EventCheckin { enabled: boolean; opensMinutes: number; closesMinutes: number }
export type RosterLock = { kind: 'none' } | { kind: 'at'; at: string } | { kind: 'after_round'; stage: number; round: number };
export interface EventRoster { starters: 4; maxSubs: number; lock: RosterLock; maxAdditions: number | null }
export interface StageConfigs {
  single_elim: { thirdPlace: boolean };
  double_elim: { grandFinalReset: boolean };
  round_robin: { groups: number };
  swiss: { rounds: number };
  league: { matches: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin'; seasonStart: string | null };
}
export type StageConfig = StageConfigs[StageType];
/** Mirrors src/events/validate.ts RoundSchedule (plan T4). */
export interface RoundSchedule { round: number; at: string | null; from: string | null; to: string | null }
export interface StageSettings {
  type: StageType; config: StageConfig; rulesetId: number; gameConfig: string; campaignPool: string[];
  vetoType: VetoType; veto: VetoConfig; chapters: number | null; scheduling: Scheduling; advanceCount: number | null;
}
export type { VetoConfig };
export interface EventFields {
  name: string; startsAt: string; entryKind: EntryKind; official: boolean; teamCap: number | null; description: string;
  eligibility: EventEligibility; checkin: EventCheckin; roster: EventRoster;
}
export interface EventListItem {
  slug: string; name: string; status: EventStatus; entryKind: EntryKind; official: boolean; startsAt: string; bannerKey: string | null;
  format: string[]; entries: number;
}
export interface EventStageView {
  ordinal: number; type: StageType; summary: string; veto: string; chapters: string; scheduling: Scheduling;
  rulesetName: string | null; rules: string[]; gameConfig: string; campaigns: { slug: string; name: string }[];
}
export interface EventEntryView { id: number; name: string; tag: string; logoKey: string | null; seed: number | null; status: string; waitlist: number | null; placement: number | null }
export interface PlayEntry { id: number; name: string; tag: string; logoKey: string | null; seed: number | null; out: boolean }
/** Mirrors src/events/playViews.ts's RoomPhase. */
export type RoomPhase = 'pending' | 'waiting' | 'ready' | 'veto' | 'lineup' | 'server' | 'connect' | 'live' | 'confirming' | 'hold' | 'done';
export interface PlayMatch {
  id: number; group: number; round: number; slot: number; a: PlayEntry | null; b: PlayEntry | null; status: string;
  winner: 'a' | 'b' | null; scoreA: number | null; scoreB: number | null; forfeit: boolean; bye: boolean; phase: RoomPhase;
  /** Plan T4: the match's time (UTC ISO) and where it came from; null with no time. */
  scheduledAt: string | null; scheduleSource: 'default' | 'agreed' | 'staff' | null;
  /** Staff only (plan T3c Ruling 16). */
  desk?: PlayMatchDesk;
}
/** What only the Events desk sees of a match (mirrors src/events/playViews.ts PlayMatchDesk, plan T3c). */
export interface PlayMatchDesk {
  holdReason: string | null; holdFrom: string | null;
  dispute: { side: 'a' | 'b'; byName: string; reason: string; at: string } | null;
  frozen: boolean; graceEndsAt: string | null;
  booking: { id: number; state: string; serverName: string | null; recovering: boolean } | null;
  liveGame: { matchId: number; campaign: string; chapters: { ordinal: number; map: string }[] } | null;
  subs: { a: number; b: number };
  /** Plan T4: a window stage's match only. */
  schedule: { windowStart: string | null; windowEnd: string | null; proposal: { side: 'a' | 'b'; byName: string; time: string; autoAcceptAt: string | null } | null; proposals: number } | null;
  /** Plan T5: the match's technical pauses with who called, flagged and ruled. */
  pauses: DeskPause[];
}
/** dates: a league round's week, first and last day (YYYY-MM-DD); null for
 *  every other stage type. defaultAt: a window round's default time or a
 *  rolling round's date (plan T4 Rulings 2 and 3); window: the round's
 *  window on a window stage. */
export interface PlayRound {
  group: number; round: number; label: string; dates: { from: string; to: string } | null;
  defaultAt: string | null; window: { from: string; to: string } | null; matches: PlayMatch[];
}
export interface PlayStanding {
  entry: PlayEntry; group: number; rank: number; groupRank: number; played: number; wins: number; losses: number;
  points: number; buchholz: number; scoreDiff: number;
}
export interface StagePlayView {
  ordinal: number; type: string; status: 'live' | 'finished'; layout: 'bracket' | 'table';
  groups: { number: number; label: string }[]; rounds: PlayRound[]; standings: PlayStanding[]; advanceCount: number | null;
  /** Swiss, or a league paired Swiss (mirrors src/events/playViews.ts). */
  pairsAsItGoes: boolean;
}
/** The Play section of the desk (plan T2 Ruling 17). Mirrors
 *  src/routes/adminEvents.ts AdminEventPlay. */
export interface AdminEventPlay { status: string; lockedAt: string | null; startsAt: string; seeded: number; stages: StagePlayView[] }
export interface EventView {
  slug: string; name: string; status: EventStatus; entryKind: EntryKind; official: boolean; organizerName: string | null;
  bannerKey: string | null; startsAt: string; description: string; teamCap: number | null;
  eligibility: EventEligibility; checkin: EventCheckin; roster: EventRoster;
  stages: EventStageView[]; entries: EventEntryView[]; play: StagePlayView[];
  finishedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
  lockedAt: string | null; checkinOpensAt: string | null; checkinClosesAt: string | null;
}

export const bannerUrl = (key: string): string => `/api/events/banners/${key}`;
/** The Events desk's own copy of an event's banner, staff only and not
 *  behind the competitive switch. The key only busts the cache on a new one. */
export const adminBannerUrl = (eventId: number, key: string): string => `/api/admin/events/${eventId}/banner?k=${key}`;

/** A player's role on a tournament entry's roster, and the roster itself:
 *  exactly 4 starters, 0 to the event's maxSubs subs, 0 or 1 coach (plan
 *  T1b, global constraints). Mirrors src/events/views.ts. */
export type EntryRole = 'starter' | 'sub' | 'coach';
export interface EntryRoster { starters: string[]; subs: string[]; coach: string | null }
export interface RosterPlaceView { steamid: string; name: string; avatar: string | null; role: EntryRole; problems: string[] }
/** onTeam is false for a roster player who has since left the team. */
export interface MemberOptionView { steamid: string; name: string; avatar: string | null; problems: string[]; elsewhere: string | null; onTeam: boolean }
export interface MyEntryView {
  id: number; name: string; tag: string; logoKey: string | null; status: string; seed: number | null; waitlist: number | null;
  checkedInAt: string | null; manage: boolean; onRoster: boolean; roster: RosterPlaceView[];
  rosterLocked: boolean; additionsLeft: number | null;
  canEditRoster: boolean; canCheckIn: boolean; canWithdraw: boolean; canLeave: boolean; leaveNeedsStaff: boolean; members: MemberOptionView[];
}
export interface RegisterOptionView { teamId: number; name: string; tag: string; logoKey: string | null; members: MemberOptionView[] }
export interface MyEventView { entries: MyEntryView[]; register: RegisterOptionView[]; canRegister: boolean }
export const entryLogoUrl = (key: string): string => `/api/events/logos/${key}.png`;

// ---------- the match room (tournaments plan T3a; mirrors src/events/roomViews.ts) ----------

export interface RoomCampaign { slug: string; name: string; state: 'open' | 'banned' | 'picked' | 'decider'; by: 'a' | 'b' | null; game: number | null }
export type VetoActionKind = 'first' | 'second' | 'ban' | 'pick' | 'survivors' | 'infected';
export interface RoomLogLine { step: number; side: 'a' | 'b'; action: VetoActionKind; campaign: string | null; campaignName: string | null; auto: boolean; at: string }
/** One row of the series in play order (a tiebreak right after its game),
 *  with its score once recorded and the running score while it is live
 *  (plan T3b). game is the series game a tiebreak stands in for. */
export interface RoomGame {
  id: number; game: number; ordinal: number; tiebreak: boolean; campaign: string; campaignName: string; map: string | null;
  pickedBy: 'a' | 'b' | null; sideBy: 'a' | 'b' | null; firstSurvivors: 'a' | 'b' | null;
  matchId: number | null; state: 'upcoming' | 'live' | 'done'; scoreA: number | null; scoreB: number | null; winner: 'a' | 'b' | null;
  /** The side that typed !gg on this game (it lost the game whatever the score), or null. */
  forfeit: 'a' | 'b' | null;
  live: { map: string | null; scoreA: number; scoreB: number } | null;
}
export interface RoomSeries { bestOf: number; totalScore: boolean; winsA: number; winsB: number; totalA: number; totalB: number; over: boolean; winner: 'a' | 'b' | null }
/** The match's booked server (plan T3b). connect is shown only to staff and
 *  the booking's accepted people; present is each side's locked four on the
 *  box at the last minute watch. */
export interface RoomServer {
  state: 'waiting' | 'setup' | 'ready' | 'ended'; name: string | null; since: string;
  connect: { host: string; port: number; password: string } | null; present: { a: number; b: number } | null; graceEndsAt: string | null;
}
export interface RoomPlayer { steamid: string; name: string }
/** Plan T4 (mirrors src/events/roomViews.ts). */
export type RescheduleStatus = 'open' | 'accepted' | 'auto_accepted' | 'declined' | 'countered' | 'withdrawn' | 'expired';
/** One reschedule proposal as the room page lists it (plan T4). */
export interface RoomProposal {
  id: number; side: 'a' | 'b'; byName: string; time: string; createdAt: string; autoAcceptAt: string | null;
  /** Present only for the two rosters and staff (final review). */
  note?: string;
  status: RescheduleStatus; respondedByName: string | null; respondedAt: string | null;
}
/** The schedule of a window-stage match (plan T4 Ruling 12); null on a
 *  rolling stage. Everything is public like the veto log (Global
 *  Constraint): the locked time, the window, the open proposal and the log
 *  of closed ones. Only the can* flags depend on the viewer. A proposal
 *  staff closed from the desk names its responder as Staff to everyone but
 *  staff. */
export interface RoomSchedule {
  scheduledAt: string | null; source: 'default' | 'agreed' | 'staff' | null; windowStart: string | null; windowEnd: string | null;
  /** scheduledAt minus the lead: when the room opens on its own. */
  opensAt: string | null; leadMinutes: number;
  proposal: RoomProposal | null; log: RoomProposal[];
  canPropose: boolean; canAnswer: boolean; canWithdraw: boolean;
}
/** a and b are null only while a bracket match still waits for its teams. */
export interface MatchRoomView {
  id: number; eventSlug: string; eventName: string; roundLabel: string; a: PlayEntry | null; b: PlayEntry | null; phase: RoomPhase;
  higher: 'a' | 'b' | null; deadline: string | null; serverNow: string; ready: { a: boolean; b: boolean };
  vetoSummary: string; pool: RoomCampaign[]; log: RoomLogLine[]; games: RoomGame[];
  next: { kind: 'order' | 'ban' | 'pick' | 'side'; by: 'a' | 'b'; game: number | null; step: number } | { kind: 'wait'; game: number } | null;
  lineups: { a: RoomPlayer[] | null; b: RoomPlayer[] | null; aLocked: boolean; bLocked: boolean };
  holdReason: string | null;
  result: { winner: 'a' | 'b'; scoreA: number | null; scoreB: number | null; forfeit: boolean } | null;
  me: { side: 'a' | 'b'; manager: boolean; playable: RoomPlayer[]; defaultFour: string[] | null } | null;
  series: RoomSeries | null;
  server: RoomServer | null;
  confirm: { deadline: string | null; a: boolean; b: boolean } | null;
  dispute: { side: 'a' | 'b'; byName: string; reason: string; at: string } | null;
  frozen: boolean;
  /** Plan T4: null on a rolling stage. */
  schedule: RoomSchedule | null;
  /** Plan T5: every technical pause of the match. */
  pauses: RoomPause[];
}
/** Mirrors src/events/pauseViews.ts RoomPause and DeskPause (plan T5). reason
 *  and flagNote are null unless the viewer is on either team or staff. */
export interface RoomPause {
  id: number; game: number; tiebreak: boolean; side: 'a' | 'b'; cause: 'call' | 'disconnect';
  reason: string | null; startedAt: string; endedAt: string | null; usedS: number; budgetS: number;
  overrun: boolean; flagged: boolean; flagNote: string | null; penalty: 'warning' | 'forfeit' | null;
}
export interface DeskPause extends RoomPause { byName: string | null; flaggedBy: string | null; penaltyNote: string | null; live: boolean }
export interface PrefsView {
  entryId: number; defaultFour: string[] | null; side: 'survivors' | 'infected' | null; roster: RoomPlayer[];
  stages: { stageId: number; ordinal: number; pool: { slug: string; name: string }[]; order: string[] }[];
}

export const eventsApi = {
  list: (signal?: AbortSignal) => get<{ events: EventListItem[] }>('/api/events', signal),
  get: (slug: string, signal?: AbortSignal) => get<EventView>(`/api/events/${enc(slug)}`, signal),
  mine: (slug: string, signal?: AbortSignal) => get<MyEventView>(`/api/events/${enc(slug)}/mine`, signal),
  register: (slug: string, teamId: number, roster: EntryRoster) => post<{ id: number }>(`/api/events/${enc(slug)}/entries`, { teamId, roster }),
  setRoster: (slug: string, entryId: number, roster: EntryRoster) => post(`/api/events/${enc(slug)}/entries/${entryId}/roster`, { roster }),
  withdraw: (slug: string, entryId: number) => post(`/api/events/${enc(slug)}/entries/${entryId}/withdraw`),
  checkIn: (slug: string, entryId: number) => post(`/api/events/${enc(slug)}/entries/${entryId}/checkin`),
  leave: (slug: string, entryId: number) => post(`/api/events/${enc(slug)}/entries/${entryId}/leave`),
  /** The match room (plan T3a). */
  room: (slug: string, id: number, signal?: AbortSignal) => get<MatchRoomView>(`/api/events/${enc(slug)}/matches/${id}`, signal),
  ready: (slug: string, id: number) => post(`/api/events/${enc(slug)}/matches/${id}/ready`),
  veto: (slug: string, id: number, step: number, action: string, campaign: string | null = null) =>
    post(`/api/events/${enc(slug)}/matches/${id}/veto`, { step, action, campaign }),
  lineup: (slug: string, id: number, steamids: string[]) => post(`/api/events/${enc(slug)}/matches/${id}/lineup`, { steamids }),
  confirmResult: (slug: string, id: number) => post(`/api/events/${enc(slug)}/matches/${id}/confirm`),
  dispute: (slug: string, id: number, reason: string) => post(`/api/events/${enc(slug)}/matches/${id}/dispute`, { reason }),
  /** Reschedule proposals (plan T4). */
  propose: (slug: string, id: number, time: string, note: string) => post(`/api/events/${enc(slug)}/matches/${id}/propose`, { time, note }),
  respond: (slug: string, id: number, accept: boolean) => post(`/api/events/${enc(slug)}/matches/${id}/respond`, { accept }),
  counter: (slug: string, id: number, time: string, note: string) => post(`/api/events/${enc(slug)}/matches/${id}/counter`, { time, note }),
  /** Named withdrawProposal, not withdraw: eventsApi.withdraw already means
   *  withdrawing an entry (a different route entirely). */
  withdrawProposal: (slug: string, id: number) => post(`/api/events/${enc(slug)}/matches/${id}/withdraw`),
  prefs: (slug: string, entryId: number, signal?: AbortSignal) => get<PrefsView>(`/api/events/${enc(slug)}/entries/${entryId}/prefs`, signal),
  savePrefs: (slug: string, entryId: number, body: { defaultFour: string[] | null; side: 'survivors' | 'infected' | null; campaigns: Record<string, string[]> }) =>
    post(`/api/events/${enc(slug)}/entries/${entryId}/prefs`, body),
};

export interface TeamScrim {
  bookingId: number; opponent: string; startsAt: string; state: string;
  /** Whether the viewer may open the booking page (its people, managers
   *  and staff); every member may open the game links. */
  canView: boolean;
  games: { matchId: number; campaign: string; state: string; us: number; them: number }[];
}

// ---------- bookings ----------

export type BookingState = 'scheduled' | 'held' | 'setup' | 'ready' | 'active' | 'ended' | 'cancelled' | 'no_show';
export type BookingSide = 'a' | 'b';
export type BookingRole = 'player' | 'ringer' | 'spectator';
/** The slot estimate's inputs, as both options routes send them
 *  (src/bookings/rules.ts estimateOptions). */
export interface SlotEstimate {
  perCampaign: Record<string, number>; base: number; slack: number; step: number; min: number;
}
export interface BookingOptions {
  campaigns: { slug: string; name: string; minutes: number }[];
  rulesets: RulesetOption[];
  gameConfigs: { key: string; label: string }[];
  limits: { daysAhead: number; playlistMax: number };
  /** The slot is estimated from the campaigns (bookings by campaign); these
   *  are its inputs, for the live "About 2 h 30" line. */
  estimate: SlotEstimate;
  myTeams: { id: number; slug: string; name: string; tag: string }[];
  teams: { id: number; slug: string; name: string; tag: string }[];
}
export interface BookingSummary {
  id: number; state: BookingState; ending: boolean; startsAt: string; endsAt: string; aName: string; bName: string;
  mySide: BookingSide | null; needs: 'confirm' | 'accept' | null;
}
export interface NotifyPref { type: string; label: string; enabled: boolean }
/** Mirrors src/scrims/reliability.ts's Reliability (plan 2 Ruling 1): shown
 *  of booked, the marks, and excused marks counted in neither. */
export interface ScrimReliability { shown: number; booked: number; noShows: number; lateCancels: number; excused: number }
/** Staff only: a player's pickup record and each current team's. */
export interface ScrimRecord {
  pickup: ScrimReliability;
  teams: { teamId: number; slug: string; name: string; tag: string; record: ScrimReliability }[];
}
/** Mirrors src/scrims/reviews.ts's REVIEW_TAGS (plan 2 Ruling 5). */
export type ReviewTag = 'on_time' | 'good_comms' | 'good_sport' | 'left_early' | 'toxic';
/** A review aggregate: under SUMMARY_MIN (3) there is no percentage or top
 *  tag, and no count unless the viewer is staff. */
export interface ReviewSummary { count?: number; positivePct: number | null; topTag: ReviewTag | null }
/** A single side's review of the other, staff only. */
export interface StaffReview {
  side: BookingSide; reviewer: string; reviewerName: string; thumbs: 1 | -1; tags: ReviewTag[]; createdAt: string; updatedAt: string;
}
/** A player's review aggregates and toxic flags (plan 2 Ruling 6), as a
 *  pickup captain and each current team's. Staff only. */
export interface ScrimReviews {
  pickup: { summary: ReviewSummary; toxic: boolean };
  teams: { teamId: number; slug: string; name: string; tag: string; summary: ReviewSummary; toxic: boolean }[];
}
export interface BookingPerson { steamid: string; name: string; avatar: string | null; role: BookingRole; status: 'invited' | 'accepted' }
export interface BookingSideView {
  side: BookingSide; name: string; team: { id: number; slug: string; name: string; tag: string; logoKey: string | null } | null;
  captain: { steamid: string; name: string }; confirmed: boolean; peakPresent: number; noShow: boolean; people: BookingPerson[];
  /** This side cancelled late (plan 2), and whether its mark is excused. */
  lateCancel: boolean; excused: boolean;
  /** The viewer manages the other side (and not this one) and may excuse
   *  this late cancel. */
  canExcuse: boolean;
  /** Closed as ended or no_show with this side under the shown minimum,
   *  claimed or not, so staff may excuse it. */
  short: boolean;
  /** The side's record, only for staff and the side itself (or anyone when public). */
  record?: ScrimReliability;
}
export interface BookingGameView {
  matchId: number; campaign: string; state: string; scoreA: number; scoreB: number; sideA: BookingSide | null;
  startedAt: string; endedAt: string | null;
  /** Plan 5: the ordinal of the map this game was replayed from after a
   *  restart, null when it was never restored. */
  restoredAtMap: number | null;
}
export interface BookingView {
  id: number; purpose: 'scrim' | 'tournament'; state: BookingState; ending: boolean;
  /** The close has finished; ending stays true for ever after it. */
  ended: boolean;
  startsAt: string; endsAt: string;
  extendedMinutes: number; createdAt: string;
  /** Bookings by campaign: how many campaigns the booking may play, how many
   *  have finished, and the 5 minute closing deadline once all are played. */
  gamesAllowed: number; gamesPlayed: number; closeAt: string | null;
  playlist: { slug: string; name: string }[];
  rules: { noShowGraceMinutes: number } | null; gameConfig: { key: string; label: string };
  sides: BookingSideView[]; server: { name: string } | null; connect: { host: string; port: number; password: string } | null;
  cancel: { side: BookingSide | null; reason: string | null } | null; endReason: string | null; noShowFrom: string;
  /** Crash recovery (plan 5): present while the box is being set up again
   *  after a restart, or while the booking waits for another box. `moved` is
   *  true once the old box was given up (recover_reason 'gone'); `waiting` is
   *  true while no box is held yet (connect above is then also null). */
  recovery: { since: string; moved: boolean; waiting: boolean } | null;
  viewer: { side: BookingSide | null; manages: BookingSide[]; staff: boolean; invited: boolean };
  games: BookingGameView[];
  /** Casters either side invited, and which sides' halves are set. */
  casters: BookingCaster[];
  /** Re-posting a cancelled scrim in one click (plan 2): true only when the
   *  booking is cancelled, came from a post, and the viewer manages a side. */
  repost: { allowed: boolean };
  /** Plan 2 Ruling 5: present only when the viewer manages exactly one
   *  confirmed side of a scrim that closed as ended or no_show. open says whether the 7 day
   *  window still takes a review; mine is the viewer's own side's review. */
  review?: { open: boolean; mine: { thumbs: 1 | -1; tags: ReviewTag[] } | null };
  /** Both sides' single reviews, staff only. */
  reviews?: StaffReview[];
}
export interface BookingCaster { steamid: string; name: string; a: boolean; b: boolean }
export interface NewBooking {
  teamId: number | null; opponent: { teamId: number } | { steamid: string }; startsAt: string;
  playlist: string[]; rulesetId?: number; gameConfig?: string;
}

export const bookingsApi = {
  options: (signal?: AbortSignal) => get<BookingOptions>('/api/bookings/options', signal),
  /** `record` is the viewer's own pickup record, once they have captained a
   *  pickup side; `recordPublic` comes with it and says whether everyone sees it. */
  mine: (signal?: AbortSignal) => get<{ open: BookingSummary[]; recent: BookingSummary[]; prefs: NotifyPref[]; record?: ScrimReliability; recordPublic?: boolean }>('/api/bookings/mine', signal),
  get: (id: number | string, signal?: AbortSignal) => get<BookingView>(`/api/bookings/${enc(String(id))}`, signal),
  create: (b: NewBooking) => post<{ id: number }>('/api/bookings', b),
  act: (id: number, action: 'confirm' | 'decline' | 'accept' | 'leave' | 'extend' | 'no-show' | 'end') =>
    post<BookingView>(`/api/bookings/${id}/${action}`),
  /** +1 campaign (the extend route): a named campaign is appended to the
   *  playlist; none leaves the pick for later. */
  addCampaign: (id: number, campaign?: string) => post<BookingView>(`/api/bookings/${id}/extend`, campaign ? { campaign } : {}),
  cancel: (id: number, reason: string) => post<BookingView>(`/api/bookings/${id}/cancel`, { reason }),
  /** The other side excuses a late cancel (plan 2): "All good, no hard feelings". */
  excuse: (id: number) => post<BookingView>(`/api/bookings/${id}/excuse`),
  addPerson: (id: number, side: BookingSide, steamid: string, role: BookingRole) =>
    post<BookingView>(`/api/bookings/${id}/people`, { side, steamid, role }),
  removePerson: (id: number, steamid: string) => post<BookingView>(`/api/bookings/${id}/people/${enc(steamid)}/remove`),
  setPref: (type: string, enabled: boolean) => post<{ prefs: NotifyPref[] }>('/api/bookings/prefs', { type, enabled }),
  /** Between-games playlist control (plan 4b): pick a campaign (or the next
   *  playlist one when omitted), or replay the last game's campaign. */
  next: (id: number, campaign?: string) => post<BookingView>(`/api/bookings/${id}/next`, campaign ? { campaign } : undefined),
  stay: (id: number) => post<BookingView>(`/api/bookings/${id}/stay`),
  /** Casters (plan 4c): who may be invited, and a side's half of an invite. */
  casters: (signal?: AbortSignal) => get<{ casters: { steamid: string; name: string; avatar: string | null }[] }>('/api/bookings/casters', signal),
  inviteCaster: (id: number, steamid: string) => post<BookingView>(`/api/bookings/${id}/casters`, { steamid }),
  withdrawCaster: (id: number, steamid: string) => post<BookingView>(`/api/bookings/${id}/casters/${enc(steamid)}/withdraw`),
  /** The viewer's own private review of the other side (plan 2 Ruling 5). */
  review: (id: number, thumbs: 1 | -1, tags: ReviewTag[]) => post<BookingView>(`/api/bookings/${id}/review`, { thumbs, tags }),
};

// ---------- scrims (the /scrims board, scrim board plan 1) ----------

export interface ScrimOptions {
  campaigns: { slug: string; name: string; minutes: number }[];
  limits: {
    daysAhead: number; playlistMax: number; noteMax: number; acceptCampaignsMax: number;
  };
  estimate: SlotEstimate;
  myTeams: { id: number; slug: string; name: string; tag: string }[];
  teams: { id: number; slug: string; name: string; tag: string }[];
  /** scrim_show_sr: off, the post form has no SR range and sends none. */
  showSr: boolean;
}

/** Mirrors src/scrims/scrims.ts's BoardSide: a team (with its badge) or a
 *  pickup group named by its captain. */
export type ScrimSide =
  | { kind: 'team'; teamId: number; name: string; tag: string; slug: string; logoKey: string | null }
  | { kind: 'pickup'; steamid: string; name: string };

export interface ScrimBoardAccept {
  id: number; side: ScrimSide; sr: number; fits: boolean; campaigns: string[]; createdAt: string;
  proposed: { playlist: string[]; minutes: number };
}

/** Mirrors src/scrims/scrims.ts's BoardPost, the one shape the board, "Your
 *  posts" and the `?post=` highlight all read. */
export interface ScrimBoardPost {
  id: number; status: 'open' | 'pending' | 'booked' | 'expired' | 'withdrawn'; side: ScrimSide; sr: number;
  srRange: number | null; startsAt: string; minutes: number; campaigns: string[]; campaignCount: number; note: string; createdAt: string;
  challenge: { teamId: number; name: string } | null;
  acceptCount: number;
  /** Plan 2: whether this post's start falls inside the weekly scrim night
   *  window, for the row highlight and tag. */
  night: boolean;
  /** The viewer manages the posting side: `accepts` is filled in. */
  mine: boolean;
  /** The viewer's side's own pending acceptance of this post, if any. */
  myAcceptId: number | null;
  accepts: ScrimBoardAccept[] | null;
  /** The posting side's record, only while the record is public. */
  record?: ScrimReliability;
}

/** srRange is only sent while scrim_show_sr is on; the server reads a
 *  missing range as open, and ignores any range while the setting is off. */
export interface NewScrimPost {
  teamId: number | null; startsAt: string; campaigns: string[]; srRange?: number | null;
  note: string; targetTeamId?: number | null;
}

/** Plan 2 Ruling 7: the weekly scrim night window, null while it is off. */
export interface ScrimNightWindow { startsAt: string; endsAt: string }

/** A block's target, as src/scrims/blocks.ts's blocksOf sends it: a team or
 *  a player, by name, never a bare id or steamid alone. */
export type BlockTargetView = { kind: 'team'; id: number; name: string; tag: string } | { kind: 'player'; steamid: string; name: string };
export interface BlockEntry { target: BlockTargetView; createdAt: string }
/** A single party's target to block or unblock, as the routes take it. */
export type BlockTargetInput = { teamId: number } | { steamid: string };
/** A player's blocks for the staff People desk (scrim blocks plan): as a
 *  pickup captain, and each current team's. Mirrors src/scrims/blocks.ts's
 *  ScrimBlocks. */
export interface ScrimBlocks {
  pickup: BlockEntry[];
  teams: { teamId: number; slug: string; name: string; tag: string; blocks: BlockEntry[] }[];
}

export const scrimsApi = {
  options: (signal?: AbortSignal) => get<ScrimOptions>('/api/scrims/options', signal),
  /** `fitsOnly` is only sent when true, which the page only does while
   *  `showSr` (scrim_show_sr) is on. */
  board: (fitsOnly = false, signal?: AbortSignal) =>
    get<{ posts: ScrimBoardPost[]; night: ScrimNightWindow | null; showSr: boolean }>(`/api/scrims${fitsOnly ? '?fitsOnly=1' : ''}`, signal),
  create: (b: NewScrimPost) => post<{ id: number }>('/api/scrims', b),
  withdraw: (postId: number) => post<{ acceptIds: number[] }>(`/api/scrims/${postId}/withdraw`),
  accept: (postId: number, teamId: number | null, campaigns: string[]) =>
    post<{ id: number; sr: number; fits: boolean }>(`/api/scrims/${postId}/accept`, { teamId, campaigns }),
  withdrawAccept: (acceptId: number) => post<{ postId: number; reopened: boolean }>(`/api/scrims/accepts/${acceptId}/withdraw`),
  decline: (acceptId: number) => post<{ postId: number; reopened: boolean }>(`/api/scrims/accepts/${acceptId}/decline`),
  /** On a `no_capacity` refusal the nearest free slot rides on the thrown
   *  ApiError's `nearestSlot` (see post(), above), not in this return type. */
  confirm: (acceptId: number) => post<{ bookingId: number }>(`/api/scrims/accepts/${acceptId}/confirm`),
  /** Re-post a cancelled scrim in one click (plan 2): a fresh public post for
   *  the caller's own side, built from the booking. A `too_late` or
   *  `no_capacity` refusal reads the same as createPost's own (nearestSlot on
   *  ApiError for the latter). */
  repost: (bookingId: number) => post<{ id: number }>(`/api/scrims/repost/${bookingId}`),
  /** A side's block list (scrim blocks plan): `teamId` null is the viewer as
   *  a pickup captain. */
  blocks: (teamId: number | null, signal?: AbortSignal) =>
    get<{ blocks: BlockEntry[] }>(`/api/scrims/blocks${teamId === null ? '' : `?teamId=${teamId}`}`, signal),
  block: (teamId: number | null, target: BlockTargetInput) => post<{ added: boolean }>('/api/scrims/blocks', { teamId, target }),
  unblock: (teamId: number | null, target: BlockTargetInput) =>
    post<{ removed: boolean }>('/api/scrims/blocks/remove', { teamId, target }),
};

export interface AdminBookingRow {
  id: number; purpose: 'scrim' | 'tournament'; state: BookingState; ending: boolean; startsAt: string; endsAt: string; aName: string; bName: string;
  server: string | null; peak: { a: number; b: number }; endReason: string | null;
  /** Plan 2 Ruling 6: a side whose team (or pickup captain) carries the toxic flag. */
  toxic: { a: boolean; b: boolean };
}

/** src/routes/adminBookings.ts: the scrim cap and PUG reserve (each per region), and the scrims holding a box per region (server priority Ruling 9). */
export interface AdminBookingPriority { scrimMax: number; pugReserve: number; regions: { region: string; scrimsHolding: number }[] }

/** src/routes/adminEvents.ts */
export interface AdminEventRow {
  id: number; slug: string; name: string; status: EventStatus; entryKind: EntryKind; startsAt: string; stages: number; updatedAt: string;
}
export interface AdminEventStage {
  id: number; ordinal: number; summary: string; settings: StageSettings; rulesSnapshotted: boolean;
  /** Plan T4: the stage's round schedule rows, and how many rounds it will have when known. */
  schedule: RoundSchedule[]; roundsKnown: number | null;
  /** Final review: a finished stage's schedule cannot change, so the desk hides Schedule. */
  status: 'pending' | 'live' | 'finished';
}
export interface AdminEventDetail {
  id: number; slug: string; status: EventStatus; fields: EventFields; bannerKey: string | null;
  cancelReason: string | null; createdAt: string; updatedAt: string;
  stages: AdminEventStage[];
  log: { at: string; actorName: string | null; action: string; detail: Record<string, unknown> }[];
}
export interface AdminEventOptions {
  campaigns: { slug: string; name: string }[]; defaultPool: string[];
  rulesets: RulesetOption[]; defaultRulesetId: number | null;
  gameConfigs: { key: string; label: string }[];
  defaults: { eligibility: EventEligibility; checkin: EventCheckin; roster: EventRoster };
}

/** The Entries section of the desk (plan T1b Ruling 10). Mirrors
 *  src/events/views.ts AdminEntryView. */
export interface AdminEntryView {
  id: number; teamSlug: string | null; name: string; tag: string; status: string; dropReason: string | null; seed: number | null;
  waitlist: number | null; sr: number; checkedInAt: string | null; createdAt: string; registeredByName: string; roster: RosterPlaceView[];
}

/** A ruleset a picker offers, with its one-line summary (src/events/format.ts rulesSummary). */
export interface RulesetOption { id: number; name: string; summary: string }

/** Mirrors src/rulesets.ts MatchRules. */
export interface MatchRules {
  rated: boolean;
  pause: { limit: number | null; seconds: number | null; mutualUnpause: boolean; techPauses: number; techSeconds: number };
  teamLock: boolean;
  playerMapControl: boolean;
  restartHalf: { allowed: boolean; lockAfterDamage: boolean };
  noShowGraceMinutes: number;
  penalties: boolean;
  bosses: 'random_published' | 'fixed' | 'voteboss';
  sideRule: 'higher_seed_chooses' | 'non_picker_chooses' | 'coin';
  spectate: { sideLocked: boolean };
  subs: { perMatch: number; emergency: boolean; emergencyChargeSeconds: number };
  disconnect: { teamSeconds: number };
  staffCall: { cooldownSeconds: number };
  series: { nextGameSeconds: number };
}
/** What the Rulesets editor sends: everything but rated and penalties,
 *  which the server sets to false on every ruleset but PUG. */
export type EditableRules = Omit<MatchRules, 'rated' | 'penalties'>;
/** Mirrors src/rulesetStore.ts RulesetListItem. */
export interface AdminRuleset {
  id: number; name: string; template: boolean; basedOn: string | null; readOnly: boolean; archived: boolean;
  summary: string; rules: MatchRules | null; inUse: { bookings: number; events: number };
}
/** Mirrors src/gameConfigStore.ts GameConfigListItem. */
export interface AdminGameConfig {
  key: string; label: string; cfg: string; enabled: boolean; locked: boolean; inUse: { bookings: number; events: number };
}

export const adminApi = {
  ban: (steamid: string, reason: string, minutes: number | null) =>
    post(`/api/admin/players/${steamid}/ban`, { reason, minutes }),
  unban: (steamid: string) => post(`/api/admin/players/${steamid}/unban`),
  activate: (steamid: string) => post(`/api/admin/players/${steamid}/activate`),
  setAdmin: (steamid: string, isAdmin: boolean) => post(`/api/admin/players/${steamid}/admin`, { isAdmin }),
  setMod: (steamid: string, isMod: boolean) => post(`/api/admin/players/${steamid}/mod`, { isMod }),
  setCaster: (steamid: string, isCaster: boolean) => post(`/api/admin/players/${steamid}/caster`, { isCaster }),
  revokeCastKey: (steamid: string) => post(`/api/admin/players/${steamid}/cast-key/revoke`),
  unlinkDiscord: (steamid: string) => post(`/api/admin/players/${steamid}/unlink-discord`),
  /** Ends every session the player holds, on every device. */
  signOutPlayer: (steamid: string) => post(`/api/admin/players/${steamid}/sign-out`),
  clearPenalties: (steamid: string) => post(`/api/admin/players/${steamid}/clear-penalties`),
  clearPenalty: (steamid: string, id: number) => post(`/api/admin/players/${steamid}/penalties/${id}/clear`),
  mergePlayer: (steamid: string, into: string, dryRun = false) =>
    post<{ plan: MergePlan; ok?: true }>(`/api/admin/players/${steamid}/merge`, { into, dryRun }),
  unaliasPlayer: (steamid: string) => post(`/api/admin/players/${steamid}/unalias`),
  steamRefresh: (steamid: string) =>
    post<{ ok: true; refreshed: number }>(`/api/admin/players/${steamid}/steam-refresh`),
  note: (steamid: string, text: string) => post(`/api/admin/players/${steamid}/notes`, { text }),
  overview: (signal?: AbortSignal) => get<AdminOverview>('/api/admin/overview', signal),
  activity: (signal?: AbortSignal) => get<QueueActivity>('/api/admin/activity', signal),
  live: (signal?: AbortSignal) => get<LiveBoard>('/api/admin/live', signal),
  practiceLeases: (signal?: AbortSignal) => get<{ leases: AdminPracticeLease[] }>('/api/admin/practice/leases', signal),
  practicePlayers: (leaseId: number, signal?: AbortSignal) =>
    get<{ players: AdminPracticePlayer[] }>(`/api/admin/practice/${leaseId}/players`, signal),
  practiceKick: (leaseId: number, userid: number, reason: string) =>
    post<{ ok: true }>(`/api/admin/practice/${leaseId}/kick`, { userid, reason }),
  leaveClock: (matchId: number, steamid: string, action: LeaveClockAction, seconds?: number) =>
    post<{ ok: true; reply: string }>(`/api/admin/live/${matchId}/players/${steamid}/leave`, { action, seconds }),
  /** `leaveOut`: rostered players to tell but not put back in the queue.
   *  `message`, when present, is read out to the admin after the abort: a
   *  booking game's route says the booking carries on. */
  abortMatch: (id: number, leaveOut: string[]) =>
    post<{ ok: true; message?: string }>(`/api/admin/matches/${id}/abort`, { leaveOut }),
  clearMatchNoShows: (id: number) => post<{ ok: true; cleared: string[] }>(`/api/admin/matches/${id}/clear-noshows`),
  /** Five more minutes on this match's no-show deadline, for everyone missing. */
  noShowExtend: (matchId: number) => post<{ ok: true; extraMinutes: number }>(`/api/admin/live/${matchId}/noshow-extend`),
  voidMatch: (id: number, reason: string) => post(`/api/admin/matches/${id}/void`, { reason }),
  serverIdle: (id: number) => post(`/api/admin/servers/${id}/idle`),
  serverEnabled: (id: number, enabled: boolean) => post(`/api/admin/servers/${id}/enabled`, { enabled }),
  serverSourcetv: (id: number, enabled: boolean, port: string, password: string) =>
    post(`/api/admin/servers/${id}/sourcetv`, { enabled, port, password }),
  queueRemove: (steamid: string) => post('/api/admin/queue/remove', { steamid }),
  /** Cancel a pop at any phase; `exclude` are players not to put back in the queue. */
  cancelPop: (lobbyId: string, exclude: string[]) => post('/api/admin/queue/cancel-pop', { lobbyId, exclude }),
  settings: (signal?: AbortSignal) =>
    get<{ settings: AdminSetting[]; campaigns: { slug: string; name: string }[]; serversMissingDlc4: string[] }>('/api/admin/settings', signal),
  saveSetting: (key: string, value: unknown) => put<{ ok: true; value: string }>(`/api/admin/settings/${key}`, { value }),
  serverMove: (id: number, dir: 'up' | 'down') =>
    post(`/api/admin/servers/${id}/move`, { dir }),
  serverRestartAfterMatch: (id: number, on: boolean) =>
    post(`/api/admin/servers/${id}/restart-after-match`, { on }),
  serverLogSecret: (id: number, rotate = false) =>
    post<{ ok: true; pushed: boolean; rotated: boolean }>(`/api/admin/servers/${id}/log-secret`, { rotate }),
  serverLogAuth: (id: number, mode: LogAuthMode) => post(`/api/admin/servers/${id}/log-auth`, { mode }),
  dlc4Check: () => post<{ results: { id: number; name: string; hasDlc4: boolean }[] }>('/api/admin/servers/dlc4-check'),
  syncServerAdmins: () => post<{ results: { serverId: number; server: string; ok: boolean; error?: string }[] }>('/api/admin/servers/admins-sync'),
  bookings: (signal?: AbortSignal) => get<{ bookings: AdminBookingRow[]; priority?: AdminBookingPriority }>('/api/admin/bookings', signal),
  cancelBooking: (id: number, reason: string) => post(`/api/admin/bookings/${id}/cancel`, { reason }),
  /** +1 campaign, staff side: a named campaign is appended to the playlist. */
  extendBooking: (id: number, campaign?: string) => post(`/api/admin/bookings/${id}/extend`, campaign ? { campaign } : {}),
  endBooking: (id: number) => post(`/api/admin/bookings/${id}/end`),
  /** Staff excuse a side's late cancel or no-show (plan 2), with an optional note. */
  excuseBooking: (id: number, side: BookingSide, note: string) => post(`/api/admin/bookings/${id}/excuse`, { side, note }),
  /** The Events desk (tournaments plan T1a). */
  events: (signal?: AbortSignal) => get<{ events: AdminEventRow[] }>('/api/admin/events', signal),
  eventOptions: (signal?: AbortSignal) => get<AdminEventOptions>('/api/admin/events/options', signal),
  event: (id: number, signal?: AbortSignal) => get<AdminEventDetail>(`/api/admin/events/${id}`, signal),
  createEvent: (body: { name: string; startsAt: string; entryKind: EntryKind }) => post<{ id: number; slug: string }>('/api/admin/events', body),
  updateEvent: (id: number, fields: Partial<EventFields>) => post(`/api/admin/events/${id}`, fields),
  addStage: (id: number, stage: StageSettings) => post(`/api/admin/events/${id}/stages`, stage),
  updateStage: (id: number, stageId: number, stage: StageSettings) => post(`/api/admin/events/${id}/stages/${stageId}`, stage),
  removeStage: (id: number, stageId: number) => post(`/api/admin/events/${id}/stages/${stageId}/remove`),
  reorderStages: (id: number, order: number[]) => post(`/api/admin/events/${id}/stages/order`, { order }),
  publishEvent: (id: number) => post(`/api/admin/events/${id}/publish`),
  openEventRegistration: (id: number) => post(`/api/admin/events/${id}/open-registration`),
  cancelEvent: (id: number, reason: string) => post(`/api/admin/events/${id}/cancel`, { reason }),
  /** `image` is base64 of the 1600 x 400 banner from toBannerImage, no data: prefix. */
  setEventBanner: (id: number, image: string) => post<{ bannerKey: string }>(`/api/admin/events/${id}/banner`, { image }),
  removeEventBanner: (id: number) => post(`/api/admin/events/${id}/banner/remove`),
  /** Drafts only: a draft is deleted, never cancelled. */
  deleteEvent: (id: number) => post(`/api/admin/events/${id}/delete`),
  /** The Entries section (plan T1b Ruling 10). */
  eventEntries: (id: number, signal?: AbortSignal) => get<{ lockedAt: string | null; entries: AdminEntryView[] }>(`/api/admin/events/${id}/entries`, signal),
  openEventCheckin: (id: number) => post(`/api/admin/events/${id}/open-checkin`),
  lockEventEntries: (id: number) => post(`/api/admin/events/${id}/lock-entries`),
  reorderEventSeeds: (id: number, order: number[]) => post(`/api/admin/events/${id}/seeds`, { order }),
  setEventEntryRoster: (id: number, entryId: number, roster: EntryRoster) => post(`/api/admin/events/${id}/entries/${entryId}/roster`, { roster }),
  disqualifyEventEntry: (id: number, entryId: number, reason: string) => post(`/api/admin/events/${id}/entries/${entryId}/disqualify`, { reason }),
  restoreEventEntry: (id: number, entryId: number) => post(`/api/admin/events/${id}/entries/${entryId}/restore`),
  /** The Play section (plan T2 Ruling 17). */
  eventPlay: (id: number, signal?: AbortSignal) => get<AdminEventPlay>(`/api/admin/events/${id}/play`, signal),
  startEvent: (id: number) => post(`/api/admin/events/${id}/start`),
  recordEventResult: (id: number, matchId: number, body: { winner: 'a' | 'b'; scoreA?: number; scoreB?: number; forfeit?: boolean }) =>
    post(`/api/admin/events/${id}/matches/${matchId}/result`, body),
  /** The match room, opened or reset by hand, or held (plan T3a Ruling 13). */
  openEventRoom: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/open-room`),
  resetEventRoom: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/reset-room`),
  holdEventMatch: (id: number, matchId: number, reason: string) => post(`/api/admin/events/${id}/matches/${matchId}/hold`, { reason }),
  /** The desk tools (plan T3c). */
  actForTeam: (id: number, matchId: number, body: { kind: 'ready' | 'veto' | 'lineup'; side: 'a' | 'b'; step?: number; action?: string; campaign?: string | null; steamids?: string[] }) =>
    post(`/api/admin/events/${id}/matches/${matchId}/act`, body),
  reopenEventVeto: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/reopen-veto`),
  /** Answers once the replay has started; its outcome reaches the staff feed (plan T3c final review). */
  replayEventChapter: (id: number, matchId: number, ordinal: number) => post<{ started: true }>(`/api/admin/events/${id}/matches/${matchId}/replay-chapter`, { ordinal }),
  moveEventServer: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/move-server`),
  extendEventGrace: (id: number, matchId: number, minutes: number) => post(`/api/admin/events/${id}/matches/${matchId}/extend-grace`, { minutes }),
  releaseEventHold: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/release-hold`),
  freezeEventMatch: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/freeze`),
  unfreezeEventMatch: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/unfreeze`),
  techPenaltyEventMatch: (id: number, matchId: number, pauseId: number, penalty: 'warning' | 'forfeit') =>
    post(`/api/admin/events/${id}/matches/${matchId}/tech-penalty`, { pauseId, penalty }),
  /** Plan T4: a stage's round schedule, and a match's time set by staff. */
  setRoundSchedule: (id: number, stageId: number, rounds: RoundSchedule[]) => post<{ stamped: number }>(`/api/admin/events/${id}/stages/${stageId}/schedule`, { rounds }),
  setEventMatchTime: (id: number, matchId: number, time: string) => post(`/api/admin/events/${id}/matches/${matchId}/set-time`, { time }),
  /** Setup > Rulesets and Game configs (rulesets editor plan). */
  rulesets: (signal?: AbortSignal) => get<{ rulesets: AdminRuleset[] }>('/api/admin/rulesets', signal),
  createRuleset: (copyFrom: number, name: string) => post<{ id: number }>('/api/admin/rulesets', { copyFrom, name }),
  updateRuleset: (id: number, name: string, rules: EditableRules) => post(`/api/admin/rulesets/${id}`, { name, rules }),
  archiveRuleset: (id: number) => post(`/api/admin/rulesets/${id}/archive`),
  unarchiveRuleset: (id: number) => post(`/api/admin/rulesets/${id}/unarchive`),
  gameConfigs: (signal?: AbortSignal) => get<{ gameConfigs: AdminGameConfig[] }>('/api/admin/game-configs', signal),
  createGameConfig: (body: { key: string; label: string; cfg: string }) => post<{ key: string }>('/api/admin/game-configs', body),
  updateGameConfig: (key: string, body: { label: string; enabled: boolean }) => post(`/api/admin/game-configs/${enc(key)}`, body),
  deleteGameConfig: (key: string) => post(`/api/admin/game-configs/${enc(key)}/delete`),
  audit: (signal?: AbortSignal) => get<{ actions: AuditEntry[] }>('/api/admin/audit', signal),
  renameSeason: (id: number, name: string) => post(`/api/admin/seasons/${id}/rename`, { name }),
  newSeason: (name: string) => post<{ ok: true; id: number }>('/api/admin/seasons/new', { name }),
  integrityReview: (matchId: number, ordinal: number, half: number, slot: number, state: string, note: string) =>
    post(`/api/admin/integrity/${matchId}/${ordinal}/${half}/${slot}/review`, { state, note }),
  integrityJob: (signal?: AbortSignal) =>
    get<IntegrityJobInfo>('/api/admin/integrity/backfill', signal),
  integrityRun: (mode: 'full' | 'pending', force: boolean) =>
    post('/api/admin/integrity/backfill', { mode, force }),
  campaigns: (signal?: AbortSignal) =>
    get<{ free: number | null; campaigns: AdminCampaign[] }>('/api/admin/campaigns', signal),
  /** Upload a campaign VPK, reporting progress as the bytes go out.
   *
   *  XMLHttpRequest rather than fetch, which cannot report upload progress at
   *  all: `xhr.upload.onprogress` is the only way a browser will tell you how
   *  many bytes have been sent. These files run to hundreds of megabytes, and
   *  without a number on screen the page looks frozen for minutes, which is
   *  exactly what the first real upload felt like.
   *
   *  `onProgress` receives a 0..1 fraction, or null when the browser cannot
   *  say how big the body is (no `lengthComputable`), so the caller can show
   *  an indeterminate state rather than a fake percentage. */
  uploadCampaign: (
    file: File,
    onProgress?: (fraction: number | null) => void,
  ): Promise<{ slug: string; name: string; sizeBytes: number; chapters: AdminChapter[] }> => {
    const form = new FormData();
    form.set('file', file);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/admin/campaigns');
      xhr.upload.onprogress = (e) => {
        onProgress?.(e.lengthComputable ? e.loaded / e.total : null);
      };
      xhr.onload = () => {
        let parsed: unknown = {};
        try { parsed = JSON.parse(xhr.responseText); } catch { /* keep {} */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parsed as { slug: string; name: string; sizeBytes: number; chapters: AdminChapter[] });
          return;
        }
        // Same contract as post(): surface the backend's own error string, so
        // the 507, 409, 413 and 400 cases each say what they mean.
        const msg = (parsed as { error?: string }).error ?? `POST /api/admin/campaigns → ${xhr.status}`;
        reject(new ApiError(xhr.status, msg));
      };
      // A dropped connection mid-upload is the likeliest failure on a 300 MB
      // body, and it must not leave the caller waiting forever.
      xhr.onerror = () => reject(new ApiError(0, 'the upload failed to reach the server'));
      xhr.onabort = () => reject(new ApiError(0, 'the upload was cancelled'));
      xhr.send(form);
    });
  },
  publishCampaign: (slug: string, name: string) =>
    post<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}/publish`, { name }),
  reinstallCampaign: (slug: string) =>
    post<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}/reinstall`, {}),
  setMapsToPlay: (slug: string, maps: number | null) =>
    post<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}/maps-to-play`, { maps }),
  setCampaignPracticeOnly: (slug: string, practiceOnly: boolean) =>
    post<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}/practice-only`, { practiceOnly }),
  deleteCampaign: (slug: string) =>
    del<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}`),
  balancePatches: (signal?: AbortSignal) => get<{ patches: PatchSummary[] }>('/api/admin/balance/patches', signal),
  gameValues: (signal?: AbortSignal) => get<GameValues>('/api/admin/balance/values', signal),
  looks: (days: number, signal?: AbortSignal) => get<LookStats>(`/api/admin/balance/looks?days=${days}`, signal),
  balancePatch: (id: number, signal?: AbortSignal) => get<PatchDetail>(`/api/admin/balance/patches/${id}`, signal),
  balanceDrift: (signal?: AbortSignal) => get<{ servers: DriftRow[] }>('/api/admin/balance/drift', signal),
  editBalancePatch: (id: number, body: { name?: string | null; notes?: string; reviewed?: boolean }) =>
    post(`/api/admin/balance/patches/${id}`, body),
  balanceKnobs: (signal?: AbortSignal) => get<KnobsState>('/api/admin/balance/knobs', signal),
  balanceKnobsPreview: (values: Record<string, string>) => post<KnobPreview>('/api/admin/balance/knobs/preview', { values }),
  balanceKnobsApply: (body: { values: Record<string, string>; name: string; notes: string; baseRolloutId: number | null }) =>
    post<{ ok: true; rolloutId: number; patchId: number; reused: boolean }>('/api/admin/balance/knobs/apply', body),
  balanceKnobsRestore: (patchId: number) => get<{ values: Record<string, string>; notes: string[] }>(`/api/admin/balance/knobs/restore/${patchId}`),
  balanceRollouts: (signal?: AbortSignal) => get<{ rollouts: RolloutSummary[] }>('/api/admin/balance/rollouts', signal),
  balancePublicPreview: (id: number, signal?: AbortSignal) => get<PublicEntry>(`/api/admin/balance/patches/${id}/public`, signal),
  publishBalancePatch: (id: number, published: boolean) => post(`/api/admin/balance/patches/${id}/publish`, { published }),
  fleet: (signal?: AbortSignal) => get<FleetState>('/api/admin/fleet', signal),
  fleetCheck: (body: { serverId: number } | { all: true }) => post<{ states: Record<number, string> }>('/api/admin/fleet/check', body),
  releases: (signal?: AbortSignal) => get<ReleaseOverview>('/api/admin/releases', signal),
  releasesRefresh: () => post<ReleaseOverview>('/api/admin/releases/refresh', {}),
  releaseStage: (commit: string) => post<{ id: number }>('/api/admin/releases/stage', { commit }),
  release: (id: number, signal?: AbortSignal) => get<ReleaseReviewView>(`/api/admin/releases/${id}`, signal),
  releaseDeploy: (id: number, body: { targets: number[]; canary: number | null; balance: { decision: 'balance' | 'not_balance' | 'later'; name?: string; notes?: string } }) =>
    post<{ ok: true }>(`/api/admin/releases/${id}/deploy`, body),
  releaseContinue: (id: number) => post<{ ok: true }>(`/api/admin/releases/${id}/continue`, {}),
  releaseUndo: (id: number, servers?: number[]) => post<{ id: number }>(`/api/admin/releases/${id}/undo`, servers ? { servers } : {}),
  triageBalancePatch: (id: number, body: TriageBody) => post<{ ok: true; target?: number }>(`/api/admin/balance/patches/${id}/triage`, body),
  unfoldBalancePatch: (id: number) => post<{ ok: true }>(`/api/admin/balance/patches/${id}/unfold`, {}),
  balanceIgnoredPlugins: (signal?: AbortSignal) => get<{ plugins: IgnoredPlugin[] }>('/api/admin/balance/ignored-plugins', signal),
  removeIgnoredPlugin: (file: string) => del<{ ok: true }>(`/api/admin/balance/ignored-plugins/${encodeURIComponent(file)}`),
  balanceCompare: (q: CompareQuery, signal?: AbortSignal) => get<CompareResult>(`/api/admin/balance/compare?${compareParams(q)}`, signal),
  balanceMetric: (q: CompareQuery, metric: string, phase: string, signal?: AbortSignal) =>
    get<MetricDetail>(`/api/admin/balance/metric?${compareParams(q)}&metric=${encodeURIComponent(metric)}&phase=${encodeURIComponent(phase)}`, signal),
};

// ---------- community ----------

export type CommunityKind = 'hud' | 'crosshair';

/** One shared HUD or crosshair, as the gallery lists it (src/community/entries.ts). */
export interface CommunityEntry {
  id: number;
  kind: CommunityKind;
  title: string;
  description: string;
  author: { steamid: string; name: string; avatar: string | null };
  likes: number;
  likedByMe: boolean;
  createdAt: string;
  /** When its author last updated it; null if never. */
  updatedAt?: string | null;
  /** Crosshairs only: the CrosshairArt, untrusted until readArt has read it. */
  art?: unknown;
  /** HUDs only. */
  preset?: string | null;
  aspect?: string | null;
  advanced?: boolean;
  importName?: string | null;
  previewUrl?: string | null;
  /** HUDs only: the infected side's preview; null on entries shared before there was one. */
  previewInfectedUrl?: string | null;
}

/** One entry with its payload, from GET /api/community/:id. */
export interface CommunityEntryDetail extends CommunityEntry {
  /** HUDs only: the design, untrusted until validateDesign has read it. */
  design?: unknown;
  importId?: string | null;
  /** Staff only, on a removed entry. */
  removed?: { by: string | null; byName?: string | null; reason: string | null; at: string };
  /** Staff only: the versions its author's updates replaced, newest first. */
  versions?: { id: number; replacedAt: string }[];
  /** Staff only, on a replaced version: the live entry it was a version of. */
  versionOf?: number | null;
}

export interface CommunityList { entries: CommunityEntry[]; page: number; pageSize: number; total: number }
export interface CommunityMine {
  entries: (CommunityEntry & { removedByStaff: string | null })[];
  caps: { huds: number; crosshairs: number; perDay: number; sharedToday: number };
}
export interface CommunityListQuery { kind: CommunityKind; sort?: 'new' | 'top'; page?: number; author?: string; liked?: boolean }

export const communityApi = {
  list: (q: CommunityListQuery, signal?: AbortSignal) => {
    const p = new URLSearchParams({ kind: q.kind, sort: q.sort ?? 'new', page: String(q.page ?? 0) });
    if (q.author) p.set('author', q.author);
    if (q.liked) p.set('liked', '1');
    return get<CommunityList>(`/api/community?${p}`, signal);
  },
  get: (id: number, signal?: AbortSignal) => get<CommunityEntryDetail>(`/api/community/${id}`, signal),
  mine: (signal?: AbortSignal) => get<CommunityMine>('/api/community/mine', signal),
  /** `replaces`: update that live crosshair of yours in place instead of sharing a new one. */
  shareCrosshair: (body: { title: string; description: string; art: unknown; permission: boolean; replaces?: number }) =>
    post<{ id: number }>('/api/community/crosshairs', body),
  /** Multipart: meta, preview and (on an imported HUD) import; see community/publish.ts's buildHudForm.
   *  `replaces`: update that live HUD of yours in place (in the URL, so the server knows before the body). */
  shareHud: (form: FormData, replaces?: number) =>
    post<{ id: number }>(replaces === undefined ? '/api/community/huds' : `/api/community/huds?replaces=${replaces}`, form),
  like: (id: number) => put<{ likes: number; likedByMe: boolean }>(`/api/community/${id}/like`, {}),
  unlike: (id: number) => del<{ likes: number; likedByMe: boolean }>(`/api/community/${id}/like`),
  /** Staff: take an entry down, with the reason its author is shown. */
  remove: (id: number, reason: string) => post<{ ok: true }>(`/api/community/${id}/remove`, { reason }),
  /** The author's own delete. */
  delete: (id: number) => del<{ ok: true }>(`/api/community/${id}`),
};

/** A second of a round: which map of the match, which half, how far in. */
export interface ReportMoment { ordinal: number; half: number; tMs: number }

/** A replay drill as the practice plugin receives it. The shape is defined
 *  once, server-side, in src/drillSpec.ts (the contract with the plugin), and
 *  only imported here so the panel can never drift from it. */
export type { DrillSpec, DrillActor } from '../../src/drillSpec';
export interface DrillMoment { matchId: number; ordinal: number; half: number; tMs: number }

/** Practice server leases (src/practiceLeases.ts). Declared here rather than
 *  imported, because that module pulls in node:crypto, which the web build
 *  cannot resolve even for a type. Kept field for field with LeaseView,
 *  ParkListing, HunterListing and AdminLeaseRow there. */
export type PracticeKind = 'park' | 'drill' | 'hunter';
export type PracticeState = 'setting_up' | 'ready' | 'ending' | 'ended';
export type PracticeEndReason =
  | 'owner' | 'admin' | 'idle' | 'expired' | 'preempted' | 'setup_failed' | 'players_on_server' | 'interrupted';
export interface PracticeLease {
  id: number;
  kind: PracticeKind;
  server: string;
  owner: { steamid: string; name: string };
  isOwner: boolean;
  canEnd: boolean;
  drillCode: string | null;
  createdAt: string;
  readyAt: string | null;
  /** While setting up: 'resetting' (srcds restarting) or 'loading'. */
  setupPhase: 'resetting' | 'loading' | null;
  endsAt: string;
  humans: number;
  capacity: number | null;
  map: string | null;
  warnedAt: string | null;
  state: PracticeState;
  endReason: PracticeEndReason | null;
  endedAt: string | null;
  connect: { host: string; port: number; password: string } | null;
}
export interface PracticeParkListing {
  id: number; server: string; humans: number; capacity: number; map: string | null; ready: boolean; endsAt: string;
}
export interface PracticeHunterListing {
  id: number; server: string; ready: boolean; inUse: boolean; endsAt: string;
}
export interface PracticeParks {
  /** False on an install with no lease manager: the card hides itself. */
  available: boolean;
  parks: PracticeParkListing[];
  /** Open Hunter Training servers: one player each, so no Join. */
  hunters: PracticeHunterListing[];
  /** The viewer's own open lease, when logged in and they have one. */
  mine: { id: number; kind: PracticeKind } | null;
}
/** One human on a practice server, from its rcon `status` (see
 *  src/practicePlayers.ts). team: 1 spectator, 2 survivor, 3 infected;
 *  trainer: 1 skeet, 2 crown, 3 rocks; both null when unknown. */
export interface AdminPracticePlayer {
  userid: number;
  name: string;
  steamid64: string | null;
  connectedFor: string;
  ping: number;
  team: number | null;
  trainer: number | null;
  station: string | null;
  /** The site knows this SteamID: the name links to the profile and the file. */
  onSite: boolean;
}
export interface AdminPracticeLease {
  id: number;
  kind: PracticeKind;
  server: string;
  serverId: number;
  owner: { steamid: string; name: string };
  state: PracticeState;
  humans: number;
  map: string | null;
  createdAt: string;
  endsAt: string;
  warnedAt: string | null;
  endReason: PracticeEndReason | null;
}

/** When people play and how long the queue takes (src/queueActivity.ts).
 *  `pops` is indexed [UTC weekday, 0 = Sunday][UTC hour]. */
export interface QueueActivity {
  days: number;
  pops: number[][];
  totalPops: number;
  waits: {
    medianSec: number | null;
    byHourSec: (number | null)[];
    popped: number;
    left: number;
    leftMedianSec: number | null;
  };
}

export const api = {
  me: (signal?: AbortSignal) => get<Me>('/api/me', signal),
  site: (signal?: AbortSignal) => get<SiteInfo>('/api/site', signal),
  state: (signal?: AbortSignal) => get<StateSnapshot>('/api/state', signal),
  queue: (signal?: AbortSignal) => get<PublicQueue>('/api/queue', signal),
  leaderboard: (signal?: AbortSignal, season?: number) =>
    get<Leaderboard>(season === undefined ? '/api/leaderboard' : `/api/leaderboard?season=${season}`, signal),
  seasons: (signal?: AbortSignal) => get<{ seasons: Season[] }>('/api/seasons', signal),
  weekly: (signal?: AbortSignal, week?: string) => get<WeeklyData>(week ? `/api/weekly?week=${week}` : '/api/weekly', signal),
  weeklyWeeks: (signal?: AbortSignal) => get<{ current: string; weeks: string[] }>('/api/weekly/weeks', signal),
  matches: (signal?: AbortSignal) => get<{ matches: MatchSummary[] }>('/api/matches', signal),
  live: (signal?: AbortSignal) => get<{ matches: LiveMatch[] }>('/api/live', signal),
  streams: (all = false, signal?: AbortSignal) =>
    get<StreamsView>(`/api/streams${all ? '?all=1' : ''}`, signal),
  maps: (signal?: AbortSignal) => get<{ maps: MapIndexRow[]; pool: string[] }>('/api/maps', signal),
  campaignNames: (signal?: AbortSignal) =>
    get<{ names: Record<string, string> }>('/api/campaigns/names', signal),
  customCampaigns: (signal?: AbortSignal) =>
    get<{ campaigns: CustomCampaignRow[] }>('/api/campaigns/custom', signal),
  balancePatches: (signal?: AbortSignal) => get<{ patches: PublicPatch[] }>('/api/balance/patches', signal),
  gameValues: (signal?: AbortSignal) => get<GameValues>('/api/balance/values', signal),
  balancePatch: (id: number, signal?: AbortSignal) => get<PublicEntry>(`/api/balance/patches/${id}`, signal),
  replayLive: (token: string, signal?: AbortSignal) =>
    get<{ filename: string; closed: boolean }>(`/api/replays/live/${encodeURIComponent(token)}`, signal),
  /** The Practice Park list, public (GET /api/practice/park). */
  practiceParks: (signal?: AbortSignal) => get<PracticeParks>('/api/practice/park', signal),
  /** Start a practice server, or join the park that has room. */
  startPractice: (body: { kind: PracticeKind; drillCode?: string }) =>
    post<{ joined: boolean; lease: PracticeLease }>('/api/practice/leases', body),
  practiceLease: (id: number, signal?: AbortSignal) => get<PracticeLease>(`/api/practice/leases/${id}`, signal),
  endPractice: (id: number) => post<PracticeLease>(`/api/practice/leases/${id}/end`),
  /** Load a drill on your own drill server (owner only). */
  loadDrillOnLease: (id: number, code: string) => post<PracticeLease>(`/api/practice/leases/${id}/drill`, { code }),
  /** Turn a moment of a finished match into a drill code (POST /api/practice/drills). */
  createDrill: (m: DrillMoment) => post<{ code: string; spec: DrillSpec }>('/api/practice/drills', m),
  replayTimeline: (matchId: number, ordinal: number, half: number, signal?: AbortSignal) =>
    get<{ entries: TimelineEntry[]; demo?: DemoSync | null }>(`/api/replays/timeline/${matchId}/${ordinal}/${half}`, signal),
  map: (map: string, signal?: AbortSignal) =>
    get<MapDetail>(`/api/maps/${encodeURIComponent(map)}`, signal),
  match: (id: string, signal?: AbortSignal) =>
    get<MatchApiResult>(`/api/matches/${encodeURIComponent(id)}`, signal),
  endorseState: (matchId: number, signal?: AbortSignal) =>
    get<EndorseState>(`/api/matches/${matchId}/endorse`, signal),
  endorse: (matchId: number, to: string, kind: EndorseKind) =>
    post<{ ok: true; remaining: number; state: EndorseState }>(`/api/matches/${matchId}/endorse`, { to, kind }),
  endorsePending: (signal?: AbortSignal) =>
    get<{ pending: PendingEndorsement[] }>('/api/endorse/pending', signal),
  profile: (steamid: string, signal?: AbortSignal) =>
    get<Profile>(`/api/players/${encodeURIComponent(steamid)}`, signal),

  register: (code: string) => post('/api/register', { code }),
  /** Whose Discord a link code is for. Reads, never spends. */
  peekDiscordCode: (code: string) =>
    get<{ discordId: string; discordName: string }>(`/api/discord/link-code?code=${encodeURIComponent(code)}`),
  linkDiscordCode: (code: string) =>
    post<{ ok: true; active: boolean; discordName: string }>('/api/discord/link-code', { code }),
  unlinkDiscord: () => post('/api/discord/unlink'),
  /** Sign out of this browser. */
  logout: () => post<{ ok: true }>('/auth/logout'),
  saveProfile: (body: ProfileFieldsInput) => post<{ ok: true }>('/api/profile', body),
  unlinkTwitch: () => post<{ ok: true }>('/api/twitch/unlink'),
  reportEligibility: (matchId: number, signal?: AbortSignal) =>
    get<ReportEligibility>(`/api/matches/${matchId}/report-eligibility`, signal),
  report: (matchId: number, targetId: string, category: string, text: string, moment?: ReportMoment) =>
    post(`/api/matches/${matchId}/reports`, moment ? { targetId, category, text, moment } : { targetId, category, text }),
  fileReport: (body: { targetId: string; category: string; text: string; matchId?: number; moment?: ReportMoment; entryId?: number }) =>
    post('/api/reports', body),
  myReports: (signal?: AbortSignal) => get<{ reports: MyReport[] }>('/api/reports/mine', signal),
  reportChat: (reportId: number) => post<{ ok: true; url: string }>(`/api/reports/${reportId}/chat`),
  joinQueue: () => post('/api/queue/join'),
  leaveQueue: () => post('/api/queue/leave'),
  setSideOptIn: (on: boolean) => post('/api/queue/side', { on }),
  ready: () => post('/api/lobby/ready'),
  dismissNotice: () => post('/api/lobby/dismiss-notice'),
  dismissAbortNotice: () => post('/api/match/dismiss-abort-notice'),
  vote: (campaign: string) => post('/api/lobby/vote', { campaign }),

  dev: {
    enabled: () => get<{ enabled: boolean }>('/api/dev/enabled'),
    login: (steamid: string) => post('/api/dev/login', { steamid }),
    fill: () => post('/api/dev/fill'),
    readyAll: () => post('/api/dev/ready-all'),
    voteAll: () => post('/api/dev/vote-all'),
    clearMatches: () => post('/api/dev/clear-matches'),
    simulateMatch: () => post('/api/dev/simulate-match'),
  },
};

/** src/admin/conduct.ts. Seconds are whole; dates are SQLite's "YYYY-MM-DD HH:MM:SS". */
export interface ConductSection {
  readyups: {
    count: number;
    avgSeconds: number | null;
    timesLast: number;
    leagueAvgSeconds: number | null;
    leagueLastShare: number | null;
    slowest: { matchId: number; mapOrdinal: number; half: number | null; seconds: number; wasLast: boolean }[];
  };
  pauses: {
    trackedSince: string | null;
    called: number;
    matchesSince: number;
    totalSeconds: number;
    recent: { matchId: number; mapOrdinal: number; half: number | null; seconds: number | null; startedAt: string }[];
  };
}

/** One player an abort was about (src/matchAborts.ts). `outcome` is already
 *  in words: "1 h queue timeout (1st no-show in 7 days)". */
export interface AbortParty {
  steamid: string; name: string; team: 'a' | 'b' | null;
  role: 'no_show' | 'file_check' | 'abandon'; what: string; outcome: string;
}
export interface AbortWho { reason: string | null; parties: AbortParty[] }
