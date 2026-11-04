import type { DB } from './db.js';
import { getLiveMatches, type LiveMatch } from './liveView.js';
import { leaderboardData, profileData } from './playerQueries.js';
import { currentSeasonLook } from './seasonThemes.js';
import { inGoodStanding } from './standing.js';
import { matchPlan } from './winProb.js';
import {
  RECENT_FINAL_MS,
  type WidgetLastMatch, type WidgetLive, type WidgetPayload, type WidgetRating, type WidgetSession,
} from './widgetTypes.js';

export * from './widgetTypes.js';

/**
 * What a player's stream widgets show (GET /api/widget/:steamid). Public and
 * keyless, so every value here is one the site already shows anyone: the live
 * match exactly as /live has it (public matches, after the live delay), and
 * the rest from the player's public profile (completed PUGs of the current
 * season, with the profile's SR change per match).
 */

/** A widget's `tz` (minutes east of UTC) further out than any real zone is
 *  read as UTC. */
const MAX_TZ_MIN = 840;
/** How far ahead of the server clock a session `since` may be and still count (clamped to now). */
const MAX_SINCE_SKEW_MS = 10 * 60_000;

/** sqlite 'YYYY-MM-DD HH:MM:SS' (UTC) as epoch ms; NaN for anything else. */
function sqliteMs(s: string | null | undefined): number {
  return s ? Date.parse(`${s.replace(' ', 'T')}Z`) : Number.NaN;
}

/** Epoch ms of the most recent local midnight in a zone `tzOffsetMin` east of UTC. */
function localMidnight(now: number, tzOffsetMin: number): number {
  const shift = tzOffsetMin * 60_000;
  const day = 86_400_000;
  return Math.floor((now + shift) / day) * day - shift;
}

type Side = 'a' | 'b';
const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

/** The live widget for a match on /live the player is in. */
function fromLive(db: DB, m: LiveMatch, side: Side): WidgetLive {
  const names = { a: m.teamA.map((p) => p.name), b: m.teamB.map((p) => p.name) };
  const half = m.halfTime;
  // The half-time score is not in teamAScore/teamBScore until MAP_RESULT.
  const total = (s: Side) => (s === 'a' ? m.teamAScore : m.teamBScore) + (half && half.survTeam === s ? half.score : 0);
  const team = (s: Side) => ({ side: s, names: names[s], score: total(s), mine: s === side });
  return {
    matchId: m.id, campaign: m.campaign, currentMap: m.currentMap,
    mapsPlayed: m.maps.length,
    mapsTotal: matchPlan(db, m.id, m.campaign)?.length ?? null,
    mine: team(side), theirs: team(other(side)),
    maps: m.maps.map((x) => ({
      ordinal: x.ordinal, map: x.map,
      mine: side === 'a' ? x.teamAScore : x.teamBScore,
      theirs: side === 'a' ? x.teamBScore : x.teamAScore,
    })),
    halfTime: half ? { ordinal: half.ordinal, mineSurvived: half.survTeam === side, score: half.score } : null,
    final: false,
  };
}

/** The live widget for a public match the player finished in the last
 *  RECENT_FINAL_MS, held as final so the result stays up for a moment. */
function recentFinal(db: DB, steamid: string, now: number): WidgetLive | null {
  const m = db.prepare(
    `SELECT m.id, m.campaign, m.ended_at, m.team_a_score, m.team_b_score, mp.team
     FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = ?
     WHERE m.state = 'completed' AND m.visibility = 'public' AND m.ended_at IS NOT NULL
     ORDER BY m.ended_at DESC, m.id DESC LIMIT 1`,
  ).get(steamid) as { id: number; campaign: string; ended_at: string; team_a_score: number; team_b_score: number; team: Side } | undefined;
  if (!m) return null;
  const age = now - sqliteMs(m.ended_at);
  if (!(age >= 0 && age <= RECENT_FINAL_MS)) return null;
  // match_maps is the record written at completion; the live scratch is
  // cleared then, so it is only a fallback for a match that has no record.
  const mapsSql = (table: string) =>
    `SELECT ordinal, map, team_a_score AS a, team_b_score AS b FROM ${table} WHERE match_id = ? ORDER BY ordinal`;
  let maps = db.prepare(mapsSql('match_maps')).all(m.id) as { ordinal: number; map: string; a: number; b: number }[];
  if (maps.length === 0) maps = db.prepare(mapsSql('match_live_maps')).all(m.id) as typeof maps;
  const roster = db.prepare(
    `SELECT mp.team, p.name FROM match_players mp JOIN players p ON p.steamid = mp.player_id
     WHERE mp.match_id = ? ORDER BY mp.player_id`,
  ).all(m.id) as { team: Side; name: string }[];
  const team = (s: Side) => ({
    side: s, names: roster.filter((r) => r.team === s).map((r) => r.name),
    score: s === 'a' ? m.team_a_score : m.team_b_score, mine: s === m.team,
  });
  return {
    matchId: m.id, campaign: m.campaign, currentMap: null,
    mapsPlayed: maps.length,
    // It is over: whatever was played is the whole match.
    mapsTotal: maps.length,
    mine: team(m.team), theirs: team(other(m.team)),
    maps: maps.map((x) => ({
      ordinal: x.ordinal, map: x.map,
      mine: m.team === 'a' ? x.a : x.b, theirs: m.team === 'a' ? x.b : x.a,
    })),
    halfTime: null,
    final: true,
  };
}

/** The player's place on the current season's board, as the leaderboard page
 *  numbers it: ranked rows by SR (ties by name), provisional ones unplaced;
 *  a finished season shows its frozen final place. */
function boardPosition(db: DB, steamid: string): number | null {
  const board = leaderboardData(db);
  if (!board) return null;
  const me = board.rows.find((r) => r.steamid === steamid);
  if (!me || me.sr === null) return null;
  if (board.season.ended) return me.finalRank;
  if (!me.ranked) return null;
  const ranked = board.rows
    .filter((r) => r.ranked && r.sr !== null)
    .sort((x, y) => y.sr! - x.sr! || x.name.localeCompare(y.name));
  const i = ranked.findIndex((r) => r.steamid === steamid);
  return i < 0 ? null : i + 1;
}

export function widgetData(
  db: DB, steamid: string, opts: { tzOffsetMin: number; since: number | null; now?: number },
): WidgetPayload | null {
  const now = opts.now ?? Date.now();
  if (!inGoodStanding(db, steamid, new Date(now))) return null;
  const profile = profileData(db, steamid, null);
  if (!profile) return null;
  const tz = Number.isFinite(opts.tzOffsetMin) && Math.abs(opts.tzOffsetMin) <= MAX_TZ_MIN ? opts.tzOffsetMin : 0;
  // `since` comes from the OBS PC's clock: a lead of up to 10 minutes is clock
  // skew and reads as "now"; further ahead is rejected.
  const since = opts.since === null || !Number.isFinite(opts.since) ? null
    : opts.since <= now ? opts.since
    : opts.since - now <= MAX_SINCE_SKEW_MS ? now
    : null;

  // Live: a match on /live with the player on a roster, else one they just finished.
  let live: WidgetLive | null = null;
  for (const m of getLiveMatches(db)) {
    const side: Side | null = m.teamA.some((p) => p.steamid === steamid) ? 'a'
      : m.teamB.some((p) => p.steamid === steamid) ? 'b' : null;
    if (side) { live = fromLive(db, m, side); break; }
  }
  live ??= recentFinal(db, steamid, now);

  const matches = profile.matches;
  const midnight = localMidnight(now, tz);
  const todayDelta = matches
    .filter((m) => sqliteMs(m.endedAt) >= midnight)
    .reduce((t, m) => t + (m.srDelta ?? 0), 0);

  const rating: WidgetRating | null = profile.rating ? {
    sr: profile.rating.sr,
    rank: profile.season?.rank?.name ?? null,
    placing: profile.season?.placing ?? null,
    position: boardPosition(db, steamid),
    wins: profile.rating.wins, losses: profile.rating.losses,
    todayDelta,
  } : null;

  let session: WidgetSession | null = null;
  if (since !== null) {
    const inSession = matches.filter((m) => sqliteMs(m.endedAt) >= since);
    session = {
      since,
      srDelta: inSession.reduce((t, m) => t + (m.srDelta ?? 0), 0),
      wins: inSession.filter((m) => m.result === 'win').length,
      losses: inSession.filter((m) => m.result === 'loss').length,
    };
  }

  let last: WidgetLastMatch | null = null;
  const lm = matches[0];
  if (lm) {
    const row = db.prepare('SELECT si_damage, common_kills FROM match_players WHERE match_id = ? AND player_id = ?')
      .get(lm.id, steamid) as { si_damage: number; common_kills: number } | undefined;
    // Solo skeets only, the `skeets` stat, as the caster studio counts them
    // (src/cast/types.ts soloSkeets; owner, 2026-10-23).
    const skeets = db.prepare("SELECT value FROM match_player_stats WHERE match_id = ? AND player_id = ? AND stat = 'skeets'")
      .get(lm.id, steamid) as { value: number } | undefined;
    const mineA = lm.team === 'a';
    last = {
      matchId: lm.id, campaign: lm.campaign, endedAt: lm.endedAt,
      result: lm.result as WidgetLastMatch['result'],
      mine: mineA ? lm.teamAScore : lm.teamBScore,
      theirs: mineA ? lm.teamBScore : lm.teamAScore,
      srDelta: lm.srDelta,
      stats: { siDamage: row?.si_damage ?? 0, skeets: skeets?.value ?? 0, commons: row?.common_kills ?? 0 },
    };
  }

  return {
    serverNow: now,
    theme: currentSeasonLook(db)?.theme ?? null,
    player: { steamid: profile.player.steamid, name: profile.player.name },
    live, rating, session, last,
    // Filled in by the route, which holds the matchmaker.
    queue: null,
  };
}
