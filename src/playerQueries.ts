import type { DB } from './db.js';
import { playerMapBreakdown } from './playerStats.js';
import { displaySr } from './rating.js';
import { getPlayer, currentSeasonId, getProfileFields, socialLinks } from './players.js';
import { STAT_DEFS, statDef } from './statKeys.js';
import { playerStandings, RANKED_MIN_GAMES } from './standings.js';

/** Read models shared by the HTTP routes and the Discord slash commands, so a
 *  number on the site and the same number in Discord come from one query. */

const PROFILE_MATCH_LIMIT = 20;

/** The season leaderboard, as GET /api/leaderboard returns it. */
export function leaderboardData(db: DB, requestedSeason?: number) {
  const seasonId = requestedSeason ?? currentSeasonId(db);
  const season = db.prepare('SELECT id, name FROM seasons WHERE id = ?').get(seasonId) as { id: number; name: string } | undefined;
  if (!season) return null;
  const rows = db.prepare(
    `SELECT pr.player_id AS steamid, p.name, p.avatar, pr.mu, pr.sigma, pr.wins, pr.losses,
            (SELECT COUNT(*) FROM rating_history rh WHERE rh.player_id = pr.player_id AND rh.season_id = pr.season_id) AS games
     FROM player_ratings pr JOIN players p ON p.steamid = pr.player_id
     WHERE pr.season_id = ?`,
  ).all(seasonId) as { steamid: string; name: string; avatar: string | null; mu: number; sigma: number; wins: number; losses: number; games: number }[];
  // Per-player season totals, so the leaderboard can be sorted by any stat
  // client side without a request per column. Two queries for the whole
  // table rather than one per player.
  const fixed = db.prepare(
    `SELECT mp.player_id AS steamid,
            COALESCE(SUM(mp.si_damage),0)    AS sidmg,
            COALESCE(SUM(mp.si_kills),0)     AS sikill,
            COALESCE(SUM(mp.common_kills),0) AS ck,
            COALESCE(SUM(mp.ff_dealt),0)     AS ff,
            COALESCE(SUM(mp.revives),0)      AS rev
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE m.season_id = ? AND m.state = 'completed'
     GROUP BY mp.player_id`,
  ).all(seasonId) as Record<string, number | string>[];

  const skill = db.prepare(
    `SELECT mps.player_id AS steamid, mps.stat, SUM(mps.value) AS total
     FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
     WHERE m.season_id = ? AND m.state = 'completed'
     GROUP BY mps.player_id, mps.stat`,
  ).all(seasonId) as { steamid: string; stat: string; total: number }[];

  const statsBy = new Map<string, Record<string, number>>();
  for (const r of fixed) {
    const { steamid, ...rest } = r as { steamid: string } & Record<string, number>;
    statsBy.set(steamid, { ...rest });
  }
  for (const r of skill) {
    // self-visibility stats are never rankable and must not ride along on a
    // public payload, so they are dropped here rather than filtered in the UI.
    if (statDef(r.stat)?.visibility === 'self') continue;
    const bucket = statsBy.get(r.steamid) ?? {};
    bucket[r.stat] = r.total;
    statsBy.set(r.steamid, bucket);
  }

  // How many matches have produced ratings this season. The page used to
  // show the top player's game count under this label, which is only right
  // while everyone has played every match.
  const { matchesRated } = db.prepare(
    'SELECT COUNT(DISTINCT match_id) AS matchesRated FROM rating_history WHERE season_id = ?',
  ).get(seasonId) as { matchesRated: number };

  return {
    season,
    matchesRated,
    rows: rows
      .map((r) => ({
        steamid: r.steamid, name: r.name, avatar: r.avatar,
        sr: displaySr(r.mu, r.sigma), wins: r.wins, losses: r.losses, games: r.games,
        ranked: r.games >= RANKED_MIN_GAMES,
        stats: statsBy.get(r.steamid) ?? {},
      }))
      .sort((x, y) => y.sr - x.sr),
  };
}

/** A player's profile, as GET /api/players/:steamid returns it. `viewer` is the
 *  signed-in steamid (or null), which decides whether self-only stats are
 *  included. Null when there is no such player. */
export function profileData(db: DB, steamid: string, viewer: string | null) {
  const player = getPlayer(db, steamid);
  if (!player) return null;
  const seasonId = currentSeasonId(db);

  const r = db.prepare('SELECT mu, sigma, wins, losses FROM player_ratings WHERE player_id = ? AND season_id = ?')
    .get(steamid, seasonId) as { mu: number; sigma: number; wins: number; losses: number } | undefined;

  const totals = db.prepare(
    `SELECT COUNT(*) AS games, COALESCE(SUM(mp.si_damage),0) AS siDamage, COALESCE(SUM(mp.si_kills),0) AS siKills,
            COALESCE(SUM(mp.common_kills),0) AS commonKills, COALESCE(SUM(mp.ff_dealt),0) AS ffDealt, COALESCE(SUM(mp.revives),0) AS revives
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND m.state = 'completed'`,
  ).get(steamid) as { games: number; siDamage: number; siKills: number; commonKills: number; ffDealt: number; revives: number };

  const matches = (db.prepare(
    `SELECT m.id, m.campaign, m.ended_at, m.team_a_score, m.team_b_score, m.winner, mp.team,
            rh.mu_before, rh.sigma_before, rh.mu_after, rh.sigma_after
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     LEFT JOIN rating_history rh ON rh.match_id = m.id AND rh.player_id = mp.player_id
     WHERE mp.player_id = ? AND m.state = 'completed'
     ORDER BY m.id DESC LIMIT ?`,
  ).all(steamid, PROFILE_MATCH_LIMIT) as any[]).map((m) => ({
    id: m.id, campaign: m.campaign, endedAt: m.ended_at,
    teamAScore: m.team_a_score, teamBScore: m.team_b_score, team: m.team,
    result: m.winner === 'draw' ? 'draw' : m.winner === m.team ? 'win' : 'loss',
    srDelta: m.mu_after === null ? 0
      : displaySr(m.mu_after, m.sigma_after) - displaySr(m.mu_before, m.sigma_before),
  }));

  const history = (db.prepare(
    'SELECT match_id, mu_after, sigma_after FROM rating_history WHERE player_id = ? AND season_id = ? ORDER BY id',
  ).all(steamid, seasonId) as any[]).map((h) => ({ matchId: h.match_id, sr: displaySr(h.mu_after, h.sigma_after) }));

  const statRows = db.prepare(
    `SELECT mps.stat, SUM(mps.value) AS total
     FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
     WHERE mps.player_id = ? AND m.state = 'completed'
     GROUP BY mps.stat`,
  ).all(steamid) as { stat: string; total: number }[];

  const statTotals: Record<string, number> = {};
  const privateTotals: Record<string, number> = {};
  for (const r2 of statRows) {
    const def = statDef(r2.stat);
    if (!def) continue;
    (def.visibility === 'self' ? privateTotals : statTotals)[r2.stat] = r2.total;
  }
  const isSelf = viewer === steamid;

  const fields = getProfileFields(db, steamid);

  return {
    player: {
      steamid: player.steamid,
      name: player.name,
      avatar: player.avatar,
      createdAt: player.created_at,
      bio: fields.bio,
      pronouns: fields.pronouns,
      country: fields.country,
      // The login, never the id. The login is already public on Twitch; the
      // id is an internal join key and has no business leaving the server.
      twitchName: player.twitch_name ?? null,
    },
    social: socialLinks(db, steamid),
    rating: r ? { sr: displaySr(r.mu, r.sigma), mu: r.mu, sigma: r.sigma, wins: r.wins, losses: r.losses } : null,
    totals, matches, history,
    statTotals,
    // Top-5 places this season, per match, among ranked players. Keyed like
    // the stat bag plus `winrate` and `boomer_rate`.
    standings: playerStandings(db, seasonId, steamid),
    // How this player does on each map, across every match. Only meaningful
    // once per-map capture exists, so older matches contribute win/loss with
    // an empty stat bag rather than being omitted.
    byMap: playerMapBreakdown(db, steamid),
    // Contract (web/src/api.ts: Profile['privateStatTotals']) is populated-or-
    // null, never an empty object: Profile.tsx gates its private-stats panel
    // on truthiness, and {} is truthy, so a self-viewer with no private stats
    // recorded yet would otherwise render an empty panel.
    privateStatTotals: (isSelf && Object.keys(privateTotals).length > 0) ? privateTotals : null,
    statDefs: STAT_DEFS,
  };
}
