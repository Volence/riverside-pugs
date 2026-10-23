import { forfeitRecord } from './ggVotes.js';
import type { DB } from './db.js';
import { competitiveAccess, competitivePublic } from './teams/access.js';
import { teamChipsOf } from './teams/teams.js';
import { alsoKnownAs } from './playerNames.js';
import { playerMapBreakdown } from './playerStats.js';
import { matchSrChange, playerSeasonState, publicStanding, rankView, seasonLadder, seasonRules, srUnder, topTen, type PublicStanding, type SeasonRules } from './seasonRules.js';
import { playerPastSeasons } from './seasons.js';
import { getPlayer, currentSeasonId, getProfileFields, socialLinks } from './players.js';
import { STAT_DEFS, statDef } from './statKeys.js';
import { playerStandings, RANKED_MIN_GAMES, standingMinGames, type Standing } from './standings.js';
import { resolveCampaignForMap, campaignDisplayName } from './campaignRegistry.js';
import { chemistryFor } from './chemistry.js';
import { allTitles, endorsementSummary } from './endorsements.js';
import { playerWeeklyAwards } from './weeklyStore.js';
import { completedPug, seasonFilter } from './matchKinds.js';
import { notBannedSql } from './banState.js';

/** Read models shared by the HTTP routes and the Discord slash commands, so a
 *  number on the site and the same number in Discord come from one query. */

const PROFILE_MATCH_LIMIT = 20;

/** The season leaderboard, as GET /api/leaderboard returns it. */
export function leaderboardData(db: DB, requestedSeason?: number, now = new Date()) {
  const seasonId = requestedSeason ?? currentSeasonId(db);
  const season = db.prepare('SELECT id, name FROM seasons WHERE id = ?').get(seasonId) as { id: number; name: string } | undefined;
  if (!season) return null;
  // A finished season reads entirely from its frozen results, so a later
  // ban, merge or recompute cannot reorder it or change a record; a live one
  // from the ratings, banned players left out.
  const frozenRows = db.prepare(
    `SELECT r.player_id AS steamid, COALESCE(p.name, r.player_id) AS name, p.avatar, r.wins, r.losses, r.games,
            r.sr, r.final_rank, r.rank_idx, r.placed
     FROM season_results r LEFT JOIN players p ON p.steamid = r.player_id WHERE r.season_id = ?`,
  ).all(seasonId) as { steamid: string; name: string; avatar: string | null; wins: number; losses: number; games: number; sr: number; final_rank: number | null; rank_idx: number | null; placed: number }[];
  const frozen = new Map(frozenRows.map((f) => [f.steamid, f]));
  const ended = frozen.size > 0;
  const rows = ended ? frozenRows : db.prepare(
    `SELECT pr.player_id AS steamid, p.name, p.avatar, pr.wins, pr.losses,
            (SELECT COUNT(*) FROM rating_history rh WHERE rh.player_id = pr.player_id AND rh.season_id = pr.season_id) AS games
     FROM player_ratings pr JOIN players p ON p.steamid = pr.player_id
     WHERE pr.season_id = ? AND ${notBannedSql('pr.player_id')}`,
  ).all(seasonId, now.toISOString()) as { steamid: string; name: string; avatar: string | null; wins: number; losses: number; games: number }[];
  // Per-player season totals, so the leaderboard can be sorted by any stat
  // client side without a request per column. Two queries for the whole
  // table rather than one per player.
  const fixed = db.prepare(
    `SELECT mp.player_id AS steamid, COUNT(*) AS statGames,
            COALESCE(SUM(mp.si_damage),0)    AS sidmg,
            COALESCE(SUM(mp.si_kills),0)     AS sikill,
            COALESCE(SUM(mp.common_kills),0) AS ck,
            COALESCE(SUM(mp.ff_dealt),0)     AS ff,
            COALESCE(SUM(mp.revives),0)      AS rev
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE m.season_id = ? AND ${completedPug('m')}
     GROUP BY mp.player_id`,
  ).all(seasonId) as Record<string, number | string>[];

  const skill = db.prepare(
    `SELECT mps.player_id AS steamid, mps.stat, SUM(mps.value) AS total
     FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
     WHERE m.season_id = ? AND ${completedPug('m')}
     GROUP BY mps.player_id, mps.stat`,
  ).all(seasonId) as { steamid: string; stat: string; total: number }[];

  const statsBy = new Map<string, Record<string, number>>();
  // Completed PUGs this season, the denominator of every per-game figure on
  // the board. Not `games` (rated games), which can count an abandon loss on
  // a match that has no stats.
  const statGamesBy = new Map<string, number>();
  for (const r of fixed) {
    const { steamid, statGames, ...rest } = r as { steamid: string; statGames: number } & Record<string, number>;
    statsBy.set(steamid, { ...rest });
    statGamesBy.set(steamid, statGames);
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

  // The title is the part of an endorsement that travels. One pass over the
  // whole table, not a lookup per row.
  const titles = allTitles(db);

  // What players see of each standing (src/seasonRules.ts). A finished
  // season with frozen results reads its SR, place and rank from those, so a
  // later merge or recompute cannot reorder it.
  const rules = seasonRules(db, seasonId);
  const ladder = ended ? new Map() : seasonLadder(db, seasonId);
  const top = ended ? [] : topTen(db, seasonId, ladder, now);

  return {
    season: { ...season, placementGames: rules.placementGames, ranks: rules.ranks, finalMinGames: rules.finalMinGames, ended },
    // Games before a per-game stat ranks on the board or its leader cards:
    // the same gate as the profile's standing badges (standing_min_games).
    statMinGames: standingMinGames(db),
    matchesRated,
    rows: rows
      // A soft-reset season seeds a row for every returning player; until they
      // play they are not on this season's ladder at all.
      .filter((r) => r.games > 0 || rules.placementGames === 0 || frozen.has(r.steamid))
      .map((r) => {
        const f = frozen.get(r.steamid);
        const view = publicStanding(rules, ladder.get(r.steamid), top);
        // A frozen row that never placed keeps its SR hidden for good.
        const sr = f ? (f.placed ? f.sr : null) : view.sr;
        return {
          steamid: r.steamid, name: r.name, avatar: r.avatar,
          sr, wins: r.wins, losses: r.losses, games: r.games,
          // Placement replaces the old three-game provisional list in a season
          // that has it; Season 0 keeps the three games.
          ranked: f ? f.final_rank !== null : rules.placementGames > 0 ? view.placing === null : r.games >= RANKED_MIN_GAMES,
          placing: f ? (f.placed ? null : { played: f.games, of: rules.placementGames }) : view.placing,
          rank: f ? (f.rank_idx === null ? null : rankView(f.rank_idx)) : view.rank,
          top10: f ? f.final_rank !== null && f.final_rank <= 10 : view.top10,
          finalRank: f ? f.final_rank : null,
          title: titles.get(r.steamid) ?? null,
          stats: statsBy.get(r.steamid) ?? {},
          statGames: statGamesBy.get(r.steamid) ?? 0,
        };
      })
      .sort((x, y) => (y.sr ?? -1) - (x.sr ?? -1) || y.games - x.games),
  };
}

/** Which numbers a profile shows (owner, 2026-10-23): one season (the
 *  current one by default) or the whole career. Every number on the page
 *  follows it, so a season record never sits beside a career match count. */
export type ProfileScope = { kind: 'season'; seasonId?: number } | { kind: 'career' };

/** The scope a request asked for: `?season=career`, `?season=N`, or nothing
 *  (the current season). Null for something that is neither. */
export function parseProfileScope(raw: string | undefined): ProfileScope | null {
  if (raw === undefined || raw === '') return { kind: 'season' };
  if (raw === 'career') return { kind: 'career' };
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? { kind: 'season', seasonId: id } : null;
}

/** A player's profile, as GET /api/players/:steamid returns it. `viewer` is the
 *  signed-in steamid (or null), which decides whether self-only stats are
 *  included. Null when there is no such player, or no such season. */
export function profileData(db: DB, steamid: string, viewer: string | null, scope: ProfileScope = { kind: 'season' }) {
  const player = getPlayer(db, steamid);
  if (!player) return null;
  const currentId = currentSeasonId(db);
  // null = the whole career.
  const seasonId = scope.kind === 'career' ? null : scope.seasonId ?? currentId;
  const seasonRow = seasonId === null ? null
    : db.prepare('SELECT id, name, ended_at FROM seasons WHERE id = ?').get(seasonId) as { id: number; name: string; ended_at: string | null } | undefined;
  if (seasonId !== null && !seasonRow) return null;
  // Appended to every completed-PUG filter below, so each number reads the
  // same match set.
  const inScope = `${completedPug('m')}${seasonFilter('m', seasonId)}`;

  const totals = db.prepare(
    `SELECT COUNT(*) AS games, COALESCE(SUM(mp.si_damage),0) AS siDamage, COALESCE(SUM(mp.si_kills),0) AS siKills,
            COALESCE(SUM(mp.common_kills),0) AS commonKills, COALESCE(SUM(mp.ff_dealt),0) AS ffDealt, COALESCE(SUM(mp.revives),0) AS revives
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND ${inScope}`,
  ).get(steamid) as { games: number; siDamage: number; siKills: number; commonKills: number; ffDealt: number; revives: number };

  // The record. A season's is its rating row (rated games, as the
  // leaderboard counts them); a career's comes from the match results, since
  // a merged or reset rating row is not a history.
  let record: { wins: number; losses: number } = { wins: 0, losses: 0 };
  const r = seasonId === null ? undefined
    : db.prepare('SELECT mu, sigma, wins, losses FROM player_ratings WHERE player_id = ? AND season_id = ?')
      .get(steamid, seasonId) as { mu: number; sigma: number; wins: number; losses: number } | undefined;
  if (seasonId === null) {
    record = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN m.winner = mp.team THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(SUM(CASE WHEN m.winner IN ('a', 'b') AND m.winner != mp.team THEN 1 ELSE 0 END), 0) AS losses
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ? AND ${inScope}`,
    ).get(steamid) as { wins: number; losses: number };
  } else if (r) {
    record = { wins: r.wins, losses: r.losses };
  }

  // Each rated game's place in its season decides what the row may show: a
  // placement game shows no SR change, the game that completed placement
  // shows the rank it placed into, and only later games show a change.
  const rulesBySeason = new Map<number, SeasonRules>();
  const rulesOf = (id: number): SeasonRules => {
    let x = rulesBySeason.get(id);
    if (!x) { x = seasonRules(db, id); rulesBySeason.set(id, x); }
    return x;
  };
  const matches = (db.prepare(
    `SELECT m.id, m.campaign, m.ended_at, m.team_a_score, m.team_b_score, m.winner, mp.team,
            rh.season_id AS rh_season, rh.mu_before, rh.sigma_before, rh.mu_after, rh.sigma_after,
            (SELECT COUNT(*) FROM rating_history x
              WHERE x.player_id = rh.player_id AND x.season_id = rh.season_id AND x.id <= rh.id) AS game_no
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     LEFT JOIN rating_history rh ON rh.match_id = m.id AND rh.player_id = mp.player_id
     WHERE mp.player_id = ? AND ${inScope}
     ORDER BY m.id DESC LIMIT ?`,
  ).all(steamid, PROFILE_MATCH_LIMIT) as any[]).map((m) => ({
    id: m.id, campaign: m.campaign, endedAt: m.ended_at,
    teamAScore: m.team_a_score, teamBScore: m.team_b_score, team: m.team,
    result: m.winner === 'draw' ? 'draw' : m.winner === m.team ? 'win' : 'loss',
    ...matchSrChange(m.mu_after === null ? null : rulesOf(m.rh_season), m.game_no ?? undefined, m),
  }));

  // SR, rank, placement and the SR line belong to a season. A Career view
  // has none of them: an SR from one season beside a career record is the
  // mix this scope exists to stop.
  let rating: { sr: number | null; mu?: number; sigma?: number; wins: number; losses: number } | null = null;
  let season: (PublicStanding & {
    id: number; name: string; current: boolean; placementGames: number; ranks: boolean; finalMinGames: number; games: number;
    finalRank: number | null; of: number | null;
  }) | null = null;
  let history: { matchId: number; sr: number }[] = [];
  let standings: Record<string, Standing> = {};
  if (seasonId !== null && seasonRow) {
    const rules = rulesOf(seasonId);
    history = (db.prepare(
      'SELECT match_id, mu_after, sigma_after FROM rating_history WHERE player_id = ? AND season_id = ? ORDER BY id',
    ).all(steamid, seasonId) as any[])
      .slice(Math.max(0, rules.placementGames - 1))
      .map((h) => ({ matchId: h.match_id, sr: srUnder(rules, h.mu_after, h.sigma_after) }));
    // A finished season reads its frozen result, as the leaderboard does, so
    // a later merge or recompute cannot change what it says.
    const frozen = seasonRow.ended_at === null ? undefined : db.prepare(
      `SELECT r.sr, r.peak_sr, r.games, r.wins, r.losses, r.final_rank, r.rank_idx, r.placed,
              (SELECT COUNT(*) FROM season_results x WHERE x.season_id = r.season_id AND x.final_rank IS NOT NULL) AS of
       FROM season_results r WHERE r.season_id = ? AND r.player_id = ?`,
    ).get(seasonId, steamid) as { sr: number; peak_sr: number; games: number; wins: number; losses: number; final_rank: number | null; rank_idx: number | null; placed: number; of: number } | undefined;
    if (!r && frozen) record = { wins: frozen.wins, losses: frozen.losses };
    let standing: PublicStanding;
    let games: number;
    if (frozen) {
      standing = frozen.placed
        ? { sr: frozen.sr, placing: null, rank: frozen.rank_idx === null ? null : rankView(frozen.rank_idx), peakSr: frozen.peak_sr, top10: frozen.final_rank !== null && frozen.final_rank <= 10 }
        : { sr: null, placing: { played: frozen.games, of: rules.placementGames }, rank: null, peakSr: null, top10: false };
      games = frozen.games;
    } else {
      const entry = playerSeasonState(db, seasonId, steamid);
      standing = publicStanding(rules, entry, entry?.placed ? topTen(db, seasonId) : []);
      games = entry?.games ?? 0;
    }
    season = {
      id: seasonId, name: seasonRow.name, current: seasonRow.ended_at === null,
      placementGames: rules.placementGames, ranks: rules.ranks, finalMinGames: rules.finalMinGames, games, ...standing,
      finalRank: frozen?.final_rank ?? null, of: frozen ? frozen.of : null,
    };
    // mu and sigma would give away a placing player's SR, so they ride along
    // only once it shows, and never for a frozen season.
    rating = r || frozen ? {
      sr: standing.sr, wins: record.wins, losses: record.losses,
      ...(standing.placing || frozen || !r ? {} : { mu: r.mu, sigma: r.sigma }),
    } : null;
    // Top-5 places in that season among ranked players, per match.
    standings = playerStandings(db, seasonId, steamid);
  }

  const statRows = db.prepare(
    `SELECT mps.stat, SUM(mps.value) AS total
     FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
     WHERE mps.player_id = ? AND ${inScope}
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

  // The seasons this player can be looked at in: the current one always (it
  // is the default view), and every other they played a completed PUG in.
  const seasonsPlayed = (db.prepare(
    `SELECT s.id, s.name, s.ended_at,
            (SELECT COUNT(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id
              WHERE mp.player_id = ? AND m.season_id = s.id AND ${completedPug('m')}) AS games
     FROM seasons s ORDER BY s.id DESC`,
  ).all(steamid) as { id: number; name: string; ended_at: string | null; games: number }[])
    .filter((s) => s.id === currentId || s.games > 0)
    .map((s) => ({ id: s.id, name: s.name, current: s.ended_at === null, games: s.games }));

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
    // What every number below covers, for the page to say so.
    scope: seasonRow
      ? { kind: 'season' as const, seasonId: seasonRow.id, name: seasonRow.name, current: seasonRow.ended_at === null }
      : { kind: 'career' as const },
    seasonsPlayed,
    // Other names they have played matches under, most played first, so a
    // player who renamed is still recognisable (src/playerNames.ts).
    alsoKnownAs: alsoKnownAs(db, steamid, player.name),
    // The teams they are on, as header chips. Gated exactly as the team pages
    // the chips link to (src/routes/teams.ts allowedViewer): while the switch
    // is at admins only nobody else gets a team here, and a chip never links
    // to a page that would answer 404.
    teams: (viewer ? competitiveAccess(db, viewer) : competitivePublic(db)) ? teamChipsOf(db, steamid) : [],
    social: socialLinks(db, steamid),
    // The season's rating (null in Career view, or before a first game).
    rating,
    // The scoped record: the season's rated games, or the career's results.
    record,
    // The season under its rules: placement progress, rank, peak, Top 10;
    // a finished season's frozen place. Null in Career view.
    season,
    // Frozen results from every finished season, newest first. Each row is
    // labelled with its season, so it shows in every view.
    pastSeasons: playerPastSeasons(db, steamid),
    // Public on purpose: the owner wants forfeiting allowed but visible.
    forfeits: forfeitRecord(db, steamid, inScope),
    totals, matches, history,
    statTotals,
    // Top-5 places in the season, per match, among ranked players. Keyed like
    // the stat bag plus `winrate` and `boomer_rate`. Empty in Career view:
    // a career figure has no season place to badge.
    standings,
    // Weekly award wins, grouped by award with the weeks. Shame awards are
    // left out: they are for the Discord post, not a player's page.
    weeklyAwards: playerWeeklyAwards(db, steamid, seasonId),
    // Who they win with and lose to. Three lines, computed per request: it is
    // one grouped query over an indexed primary key.
    chemistry: chemistryFor(db, steamid, seasonId),
    // Aggregate and anonymous: counts per kind, a per match rate and the
    // title. Never who gave them. The title is the career's (it travels).
    endorsements: endorsementSummary(db, steamid, seasonId),
    // How this player does on each map in the scope. Only meaningful once
    // per-map capture exists, so older matches contribute win/loss with an
    // empty stat bag rather than being omitted.
    //
    // Campaign resolved here rather than inside playerMapBreakdown: that module
    // is pure statistics over the database and has no campaign import, and
    // pulling the registry into it for a presentation concern would drag
    // customCampaigns into the stats path too.
    byMap: playerMapBreakdown(db, steamid, seasonId).map((row) => {
      const slug = resolveCampaignForMap(db, row.map);
      return { ...row, campaignName: slug ? campaignDisplayName(db, slug) : null };
    }),
    // Contract (web/src/api.ts: Profile['privateStatTotals']) is populated-or-
    // null, never an empty object: Profile.tsx gates its private-stats panel
    // on truthiness, and {} is truthy, so a self-viewer with no private stats
    // recorded yet would otherwise render an empty panel.
    privateStatTotals: (isSelf && Object.keys(privateTotals).length > 0) ? privateTotals : null,
    statDefs: STAT_DEFS,
  };
}
