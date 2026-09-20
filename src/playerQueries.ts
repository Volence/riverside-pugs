import type { DB } from './db.js';
import { playerMapBreakdown } from './playerStats.js';
import { displaySr } from './rating.js';
import { getPlayer, currentSeasonId } from './players.js';
import { FIXED_STAT_KEYS, STAT_DEFS, statDef } from './statKeys.js';
import { quantiles, type Quantiles } from './quantiles.js';
import { playerStandings, RANKED_MIN_GAMES } from './standings.js';
import { resolveCampaignForMap, campaignDisplayName } from './campaignRegistry.js';

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
  // Per-player season stats, so the leaderboard can be sorted by any stat
  // client side without a request per column. Two queries for the whole table
  // rather than one per player.
  //
  // These pull one row PER MATCH rather than a SUM, because the table now
  // offers a per-match median as well as a season total, and a median cannot be
  // recovered from a sum. Both bags are then reduced from the same samples, so
  // the two tabs can never disagree about what they are measuring. The season
  // total is unchanged by the switch: it is the same addition, done here.
  //
  // `stats_json IS NOT NULL` is the captured test for the fixed columns. They
  // live on match_players and default to 0, and matchResult.ts writes them and
  // stats_json together in one UPDATE per player the dump carried, so a NULL
  // there marks the fixed zeros as never recorded rather than as a bad night.
  // The skill table needs no such test: a row that was not measured is absent.
  const fixedRows = db.prepare(
    `SELECT mp.player_id AS steamid,
            mp.si_damage AS sidmg, mp.si_kills AS sikill, mp.common_kills AS ck,
            mp.ff_dealt AS ff, mp.revives AS rev
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE m.season_id = ? AND m.state = 'completed' AND mp.stats_json IS NOT NULL`,
  ).all(seasonId) as ({ steamid: string } & Record<string, number>)[];

  const skillRows = db.prepare(
    `SELECT mps.player_id AS steamid, mps.stat, mps.value
     FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
     WHERE m.season_id = ? AND m.state = 'completed'`,
  ).all(seasonId) as { steamid: string; stat: string; value: number }[];

  const samplesBy = new Map<string, Map<string, number[]>>();
  const sample = (steamid: string, key: string, value: number) => {
    let bags = samplesBy.get(steamid);
    if (!bags) { bags = new Map(); samplesBy.set(steamid, bags); }
    const bag = bags.get(key);
    if (bag) bag.push(value);
    else bags.set(key, [value]);
  };
  for (const r of fixedRows) for (const k of FIXED_STAT_KEYS) sample(r.steamid, k, r[k]);
  for (const r of skillRows) {
    // self-visibility stats are never rankable and must not ride along on a
    // public payload, so they are dropped here rather than filtered in the UI.
    if (statDef(r.stat)?.visibility === 'self') continue;
    sample(r.steamid, r.stat, r.value);
  }

  const statsBy = new Map<string, Record<string, number>>();
  const medianBy = new Map<string, Record<string, number>>();
  for (const [steamid, bags] of samplesBy) {
    const totals: Record<string, number> = {};
    const medians: Record<string, number> = {};
    for (const [key, values] of bags) {
      totals[key] = values.reduce((a, b) => a + b, 0);
      // Never null here: a bag only exists once something has been pushed into
      // it. A key nobody recorded has no bag and so appears in neither result,
      // which is the absent-is-not-zero rule the rest of this file follows.
      medians[key] = quantiles(values)!.p50;
    }
    statsBy.set(steamid, totals);
    medianBy.set(steamid, medians);
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
        medianStats: medianBy.get(r.steamid) ?? {},
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

  // What this player USUALLY gets, per completed match, with the spread around
  // it. The tiles above divided a career total by games played, which one
  // enormous night distorts for the rest of the season: a player with a
  // 40-skeet game and eleven quiet ones was shown a figure they had never once
  // scored. The same two sample rules as leaderboardData, and for the same
  // reasons: stats_json separates a real zero from a player the dump missed,
  // and an absent match_player_stats row means the stat was not measured.
  const fixedSamples = db.prepare(
    `SELECT mp.si_damage AS sidmg, mp.si_kills AS sikill, mp.common_kills AS ck,
            mp.ff_dealt AS ff, mp.revives AS rev
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND m.state = 'completed' AND mp.stats_json IS NOT NULL`,
  ).all(steamid) as Record<string, number>[];

  const skillSamples = db.prepare(
    `SELECT mps.stat, mps.value
     FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
     WHERE mps.player_id = ? AND m.state = 'completed'`,
  ).all(steamid) as { stat: string; value: number }[];

  const samples = new Map<string, number[]>();
  const sample = (key: string, value: number) => {
    const bag = samples.get(key);
    if (bag) bag.push(value);
    else samples.set(key, [value]);
  };
  for (const r2 of fixedSamples) for (const k of FIXED_STAT_KEYS) sample(k, r2[k]);
  for (const r2 of skillSamples) {
    // Self-visibility stats keep the same split they have in the totals above:
    // never on the public bag. They have no private quantiles of their own,
    // since the private panel is a lifetime list and asks a different question.
    if (statDef(r2.stat)?.visibility === 'self') continue;
    sample(r2.stat, r2.value);
  }
  const statQuantiles: Record<string, Quantiles> = {};
  for (const [key, values] of samples) statQuantiles[key] = quantiles(values)!;

  return {
    player: { steamid: player.steamid, name: player.name, avatar: player.avatar, createdAt: player.created_at },
    rating: r ? { sr: displaySr(r.mu, r.sigma), mu: r.mu, sigma: r.sigma, wins: r.wins, losses: r.losses } : null,
    totals, matches, history,
    statTotals,
    statQuantiles,
    // Top-5 places this season, per match, among ranked players. Keyed like
    // the stat bag plus `winrate` and `boomer_rate`.
    standings: playerStandings(db, seasonId, steamid),
    // How this player does on each map, across every match. Only meaningful
    // once per-map capture exists, so older matches contribute win/loss with
    // an empty stat bag rather than being omitted.
    //
    // Campaign resolved here rather than inside playerMapBreakdown: that module
    // is pure statistics over the database and has no campaign import, and
    // pulling the registry into it for a presentation concern would drag
    // customCampaigns into the stats path too.
    byMap: playerMapBreakdown(db, steamid).map((r) => {
      const slug = resolveCampaignForMap(db, r.map);
      return { ...r, campaignName: slug ? campaignDisplayName(db, slug) : null };
    }),
    // Contract (web/src/api.ts: Profile['privateStatTotals']) is populated-or-
    // null, never an empty object: Profile.tsx gates its private-stats panel
    // on truthiness, and {} is truthy, so a self-viewer with no private stats
    // recorded yet would otherwise render an empty panel.
    privateStatTotals: (isSelf && Object.keys(privateTotals).length > 0) ? privateTotals : null,
    statDefs: STAT_DEFS,
  };
}
