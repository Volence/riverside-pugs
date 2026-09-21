/** Typed wrappers over the backend. These types mirror the JSON the routes in
 *  src/routes/{api,stats,auth}.ts actually return. If a shape changes there,
 *  it changes here. 4a introduces no new endpoints and alters no existing one. */

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
  /** May open the Tickets tab. */
  isMod?: boolean;
  /** False when the server has no Discord app configured: hide every Discord control. */
  discordEnabled?: boolean;
  discord?: { id: string; name: string } | null;
  /** In the Discord server; null when not linked or not known right now. */
  discordMember?: boolean | null;
  /** False when the server has no Twitch app configured: hide every Twitch control. */
  twitchEnabled?: boolean;
  twitch?: { id: string; name: string } | null;
  ban?: { reason: string; expiresAt: string | null } | null;
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

/** The GET /api/queue shape: public, so carries nothing viewer-relative and
 *  no connect block, unlike StateSnapshot['queue']. */
export interface PublicQueue {
  count: number;
  players: NamedPlayer[];
  phase: LobbyPhase | null;
}

export interface StateSnapshot {
  queue: { count: number; joined: boolean; players: NamedPlayer[] };
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
  timeout?: { until: string; offenses: number } | null;
  /** The Discord step still missing before the viewer may queue. */
  queueBlock?: 'link_discord' | 'join_discord' | null;
  /** The step still missing before the viewer may press Ready. */
  readyBlock?: ReadyBlock | null;
  /** The ready check the viewer was just in, if it failed and they have not
   *  dismissed it. The failure no longer appears in #queue-here, so this is
   *  where they find out. */
  /** `removed` is set instead of `notReady` when the pop was cancelled because
   *  a player was taken out of it (banned mid ready check). */
  lobbyNotice?: { notReady: NamedPlayer[]; youWereReady: boolean; removed?: NamedPlayer } | null;
}

/** One row of the public ban list. Nothing private is on it: see
 *  `publicBans` in src/admin/players.ts. */
export interface PublicBan {
  steamid: string;
  name: string;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
  permanent: boolean;
  active: boolean;
  bannedByName: string | null;
  liftedByName: string | null;
  liftedAt: string | null;
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
  /** Their linked Discord display name, only when it reads differently from
   *  `name`. Null when unlinked or the names match. */
  discordName: string | null;
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

export interface MatchDetail {
  /** `winner` is null on an aborted match: it never reached a result. The
   *  void fields are set only when a COMPLETED match was voided afterwards,
   *  which the schema also records as state 'aborted'. */
  match: MatchSummary & { state: string; winner: Winner | null; voidedAt?: string | null; voidReason?: string | null };
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
  /** What the ratings said before the match. Admin only: the field is absent
   *  entirely for anyone else, so the page has nothing to hide. */
  forecast?: Forecast;
  /** Per-round side attribution. An empty array means this match predates
   *  round capture, which is NOT the same as a match that had no rounds. */
  rounds: {
    ordinal: number; half: number; survTeam: Team;
    score: number; endedAt: string | null; reliable: boolean;
    byPlayer: Record<string, Record<string, number>>;
  }[];
}

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
  filename: string; notes: string | null; inPool: boolean;
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
}

/** A place on this season's board: `rank` of `of` ranked players. Ties share. */
export interface Standing { rank: number; of: number }

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
    throw new ApiError(res.status, msg);
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
  timeout: { until: string; offenses: number } | null;
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
    /** What the holds across the evidence look like: wheel-like, fixed-hold, variable-hold, no-hold-data. */
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
  }[];
  servers: {
    id: number; name: string; host: string; port: number; status: string; enabled: number;
    tvPort: number | null; tvPassword: string | null; tvEnabled: number; restartAfterMatch?: number;
    /** Signed log lines. Optional: a payload from before it existed has none. */
    logAuth?: ServerLogAuth;
  }[];
  recent: { id: number; campaign: string; endedAt: string | null; teamAScore: number; teamBScore: number; winner: string | null; forecast: Forecast | null; pauses: MatchPause[]; readyups: MatchReadyup[] }[];
  /** Ended with no result. `abandonedBy` names the leaver when the abandon
   *  path ended it, and is null for an admin abort or a reaped match. */
  aborted: { id: number; campaign: string; endedAt: string | null; teamAScore: number; teamBScore: number; abandonedBy: string | null }[];
  voided: { id: number; campaign: string; voidedAt: string; voidReason: string }[];
  queue: NamedPlayer[];
  /** Across every counted match: who is habitually the one holding up the ready-up. */
  slowToReady: SlowToReady[];
}

export interface AdminSetting {
  key: string; label: string; help: string; group: string; secret?: boolean; value: string;
  type:
    | { kind: 'int'; min: number; max: number }
    | { kind: 'string'; maxLength: number; allowEmpty: boolean }
    | { kind: 'campaigns' }
    | { kind: 'bool' }
    | { kind: 'intList'; min: number; max: number; maxItems: number };
}

export interface AuditEntry {
  id: number; adminId: string; adminName: string | null; action: string; target: string;
  targetName: string | null; detail: Record<string, unknown>; createdAt: string;
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
  id: number; targetId: string; targetName: string | null; category: string;
  matchId: number | null; createdAt: string; status: 'open' | 'closed';
}

/** One row of the integrity board. trackShare, occZ, teamGap and their percentiles are nullable:
 *  a map with too little recorded history gets no occupancy score at all, and
 *  that must never be confused with an average (0) score. composite is a sort
 *  key, not a verdict. */
export interface IntegrityPlayerRow {
  steamid: string;
  /** Resolved name, or the SteamID when the server has never seen one. */
  name: string;
  rounds: number;
  /** Clips in existence for this player. Zero on every row means nothing has
   *  been flagged at all, and a ranking with nothing flagged is a list of your
   *  best players by another name. */
  clips: number;
  /** Rounds in which the detector had at least one chance. A player under the
   *  server's minimum is listed but not ranked. */
  eligibleRounds: number;
  ranked: boolean;
  /** The best single tracking window in their history. Context only: it is a
   *  maximum, so it rises with playtime, and nothing is ranked on it. */
  fidMax: number;
  fidP95: number;
  scoreable: number;
  /** Tracking as ranked: summed fidelity over scoreable windows. Null with too
   *  few windows to make a ratio of. */
  trackShare: number | null;
  occZ: number | null;
  teamGap: number | null;
  pFid: number | null;
  pOcc: number | null;
  pGap: number | null;
  /** Null when unranked. */
  composite: number | null;
}

/** A flag raised live by another plugin (today Little Anti-Cheat) rather than
 *  by replay analysis. No clip behind it, so nothing to watch. */
/** One row of the cross-player flag feed: LilAC hits and input-stat detections
 *  merged, so the panel has a front door. */
export interface RecentFlag {
  id: number;
  kind: string;
  source: string;
  severity: string;
  steamid: string;
  name: string;
  matchId: number | null;
  at: string;
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
  id: number; targetId: string; targetName: string | null; status: 'open' | 'closed'; outcome: string | null;
  restricted: boolean; claimedBy: string | null; claimedByName: string | null;
  reports: number; reporters: number; categories: string[];
  createdAt: string; lastReportAt: string | null; closedAt: string | null;
}
export interface TicketReport {
  id: number; reporterId: string; reporterName: string | null; category: string; text: string;
  matchId: number | null; campaign: string | null; moment: { ordinal: number; half: number; tMs: number } | null; createdAt: string;
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
}
export interface TicketDetail {
  ticket: TicketSummary & { outcomeNote: string; openedBy: string | null; openedByName: string | null; closedBy: string | null; closedByName: string | null };
  reports: TicketReport[];
  events: TicketEvent[];
  bans: { id: number; reason: string; createdBy: string; createdByName: string | null; createdAt: string; expiresAt: string | null; liftedAt: string | null }[];
  access: { steamid: string; name: string }[];
  accessCandidates: { steamid: string; name: string }[];
  caseFile: CaseFile | null;
  /** banCapMinutes null means no cap: the viewer is an admin. */
  viewer: { isAdmin: boolean; banCapMinutes: number | null };
}

export const modApi = {
  tickets: (filter: 'open' | 'mine' | 'closed', signal?: AbortSignal) =>
    get<{ tickets: TicketSummary[] }>(`/api/mod/tickets?filter=${filter}`, signal),
  ticket: (id: number, signal?: AbortSignal) => get<TicketDetail>(`/api/mod/tickets/${id}`, signal),
  /** ticketId is null when the ticket is restricted and the opener is not on
   *  its access list: the note landed, and there is nothing to open. */
  open: (targetId: string, note: string, restricted: boolean) =>
    post<{ ok: true; ticketId: number | null }>('/api/mod/tickets', { targetId, note, restricted }),
  claim: (id: number, claim: boolean) => post(`/api/mod/tickets/${id}/claim`, { claim }),
  restrict: (id: number, restricted: boolean) => post(`/api/mod/tickets/${id}/restrict`, { restricted }),
  access: (id: number, steamid: string) => post(`/api/mod/tickets/${id}/access`, { steamid }),
  ban: (id: number, reason: string, minutes: number | null) => post(`/api/mod/tickets/${id}/ban`, { reason, minutes }),
  close: (id: number, outcome: string, note: string) => post(`/api/mod/tickets/${id}/close`, { outcome, note }),
  reopen: (id: number) => post(`/api/mod/tickets/${id}/reopen`),
};

export const adminApi = {
  players: (q: string, signal?: AbortSignal) =>
    get<{ players: AdminPlayerRow[] }>(`/api/admin/players?q=${encodeURIComponent(q)}`, signal),
  player: (steamid: string, signal?: AbortSignal) =>
    get<AdminPlayerDetail>(`/api/admin/players/${encodeURIComponent(steamid)}`, signal),
  ban: (steamid: string, reason: string, minutes: number | null) =>
    post(`/api/admin/players/${steamid}/ban`, { reason, minutes }),
  unban: (steamid: string) => post(`/api/admin/players/${steamid}/unban`),
  activate: (steamid: string) => post(`/api/admin/players/${steamid}/activate`),
  setAdmin: (steamid: string, isAdmin: boolean) => post(`/api/admin/players/${steamid}/admin`, { isAdmin }),
  setMod: (steamid: string, isMod: boolean) => post(`/api/admin/players/${steamid}/mod`, { isMod }),
  unlinkDiscord: (steamid: string) => post(`/api/admin/players/${steamid}/unlink-discord`),
  /** Ends every session the player holds, on every device. */
  signOutPlayer: (steamid: string) => post(`/api/admin/players/${steamid}/sign-out`),
  clearPenalties: (steamid: string) => post(`/api/admin/players/${steamid}/clear-penalties`),
  mergePlayer: (steamid: string, into: string, dryRun = false) =>
    post<{ plan: MergePlan; ok?: true }>(`/api/admin/players/${steamid}/merge`, { into, dryRun }),
  unaliasPlayer: (steamid: string) => post(`/api/admin/players/${steamid}/unalias`),
  steamRefresh: (steamid: string) =>
    post<{ ok: true; refreshed: number }>(`/api/admin/players/${steamid}/steam-refresh`),
  note: (steamid: string, text: string) => post(`/api/admin/players/${steamid}/notes`, { text }),
  overview: (signal?: AbortSignal) => get<AdminOverview>('/api/admin/overview', signal),
  abortMatch: (id: number) => post(`/api/admin/matches/${id}/abort`),
  voidMatch: (id: number, reason: string) => post(`/api/admin/matches/${id}/void`, { reason }),
  serverIdle: (id: number) => post(`/api/admin/servers/${id}/idle`),
  serverEnabled: (id: number, enabled: boolean) => post(`/api/admin/servers/${id}/enabled`, { enabled }),
  serverSourcetv: (id: number, enabled: boolean, port: string, password: string) =>
    post(`/api/admin/servers/${id}/sourcetv`, { enabled, port, password }),
  queueRemove: (steamid: string) => post('/api/admin/queue/remove', { steamid }),
  settings: (signal?: AbortSignal) =>
    get<{ settings: AdminSetting[]; campaigns: { slug: string; name: string }[]; serversMissingDlc4: string[] }>('/api/admin/settings', signal),
  saveSetting: (key: string, value: unknown) => put<{ ok: true; value: string }>(`/api/admin/settings/${key}`, { value }),
  serverRestartAfterMatch: (id: number, on: boolean) =>
    post(`/api/admin/servers/${id}/restart-after-match`, { on }),
  serverLogSecret: (id: number, rotate = false) =>
    post<{ ok: true; pushed: boolean; rotated: boolean }>(`/api/admin/servers/${id}/log-secret`, { rotate }),
  serverLogAuth: (id: number, mode: LogAuthMode) => post(`/api/admin/servers/${id}/log-auth`, { mode }),
  dlc4Check: () => post<{ results: { id: number; name: string; hasDlc4: boolean }[] }>('/api/admin/servers/dlc4-check'),
  syncServerAdmins: () => post<{ results: { serverId: number; server: string; ok: boolean; error?: string }[] }>('/api/admin/servers/admins-sync'),
  audit: (signal?: AbortSignal) => get<{ actions: AuditEntry[] }>('/api/admin/audit', signal),
  renameSeason: (id: number, name: string) => post(`/api/admin/seasons/${id}/rename`, { name }),
  newSeason: (name: string) => post<{ ok: true; id: number }>('/api/admin/seasons/new', { name }),
  integrity: (season: string, signal?: AbortSignal) =>
    get<{ players: IntegrityPlayerRow[]; flags: RecentFlag[]; health: CaptureHealth }>(
      `/api/admin/integrity?season=${encodeURIComponent(season)}`, signal),
  /** Flags raised live by another plugin (today Little Anti-Cheat). No replay
   *  behind them, so they are listed beside the clips rather than among them. */
  integrityPlayer: (steamid: string, signal?: AbortSignal) =>
    get<{ rounds: IntegrityRound[]; clips: IntegrityClip[]; flags: IntegrityFlag[] }>(`/api/admin/integrity/${steamid}`, signal),
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
  deleteCampaign: (slug: string) =>
    del<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}`),
};

export const api = {
  me: (signal?: AbortSignal) => get<Me>('/api/me', signal),
  site: (signal?: AbortSignal) => get<SiteInfo>('/api/site', signal),
  state: (signal?: AbortSignal) => get<StateSnapshot>('/api/state', signal),
  bans: (q = '', signal?: AbortSignal) =>
    get<{ bans: PublicBan[] }>(`/api/bans${q ? `?q=${encodeURIComponent(q)}` : ''}`, signal),
  queue: (signal?: AbortSignal) => get<PublicQueue>('/api/queue', signal),
  leaderboard: (signal?: AbortSignal, season?: number) =>
    get<Leaderboard>(season === undefined ? '/api/leaderboard' : `/api/leaderboard?season=${season}`, signal),
  seasons: (signal?: AbortSignal) => get<{ seasons: Season[] }>('/api/seasons', signal),
  matches: (signal?: AbortSignal) => get<{ matches: MatchSummary[] }>('/api/matches', signal),
  live: (signal?: AbortSignal) => get<{ matches: LiveMatch[] }>('/api/live', signal),
  streams: (all = false, signal?: AbortSignal) =>
    get<StreamsView>(`/api/streams${all ? '?all=1' : ''}`, signal),
  maps: (signal?: AbortSignal) => get<{ maps: MapIndexRow[]; pool: string[] }>('/api/maps', signal),
  campaignNames: (signal?: AbortSignal) =>
    get<{ names: Record<string, string> }>('/api/campaigns/names', signal),
  customCampaigns: (signal?: AbortSignal) =>
    get<{ campaigns: CustomCampaignRow[] }>('/api/campaigns/custom', signal),
  replayLive: (token: string, signal?: AbortSignal) =>
    get<{ filename: string; closed: boolean }>(`/api/replays/live/${encodeURIComponent(token)}`, signal),
  replayTimeline: (matchId: number, ordinal: number, half: number, signal?: AbortSignal) =>
    get<{ entries: TimelineEntry[] }>(`/api/replays/timeline/${matchId}/${ordinal}/${half}`, signal),
  map: (map: string, signal?: AbortSignal) =>
    get<MapDetail>(`/api/maps/${encodeURIComponent(map)}`, signal),
  match: (id: string, signal?: AbortSignal) =>
    get<MatchDetail>(`/api/matches/${encodeURIComponent(id)}`, signal),
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
  report: (matchId: number, targetId: string, category: string, text: string) =>
    post(`/api/matches/${matchId}/reports`, { targetId, category, text }),
  fileReport: (body: { targetId: string; category: string; text: string; matchId?: number; moment?: { ordinal: number; half: number; tMs: number } }) =>
    post('/api/reports', body),
  myReports: (signal?: AbortSignal) => get<{ reports: MyReport[] }>('/api/reports/mine', signal),
  joinQueue: () => post('/api/queue/join'),
  leaveQueue: () => post('/api/queue/leave'),
  ready: () => post('/api/lobby/ready'),
  dismissNotice: () => post('/api/lobby/dismiss-notice'),
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
