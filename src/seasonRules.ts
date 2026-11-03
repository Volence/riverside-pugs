import type { DB } from './db.js';

/**
 * The rules a season's ladder is shown under (owner rulings 2026-10-19).
 *
 * Ratings themselves never change with these: mu and sigma are OpenSkill's
 * and the balancer reads them as before. The rules decide only what players
 * SEE: how SR is derived from a rating, how many games a player places before
 * it shows, whether the season hands out ranks, and how many games a player
 * needs for a place in the final standings.
 */
export interface SeasonRules {
  /** SR = (mu - k * sigma) * 100. Season 0 used 2; later seasons 1, because
   *  placement now hides the uncertain first games that 2 was guarding. */
  srSigmaK: number;
  /** Games a player plays each season before their SR shows. */
  placementGames: number;
  /** Whether the season shows Bronze..Master ranks. */
  ranks: boolean;
  /** Games for a place in the final standings and the Top 10 badge. */
  finalMinGames: number;
}

/** The rules Season 0 was played under, and the column defaults. */
export const LEGACY_RULES: SeasonRules = { srSigmaK: 2, placementGames: 0, ranks: false, finalMinGames: 20 };

/** What startNewSeason writes for every season from Season 1 on. */
export const NEW_SEASON_RULES: SeasonRules = { srSigmaK: 1, placementGames: 5, ranks: true, finalMinGames: 20 };

/**
 * The soft reset a new season starts from: mu pulled 30% of the way back to
 * the default (50% from above it), sigma raised to at least 6. Backtested
 * 2026-10-19 by starting a pretend season on 09-28 and on 10-05 and replaying
 * every later match: log loss 0.693 / 0.680, against 0.725 / 0.729 for a hard
 * reset and 0.704 / 0.693 for carrying ratings over unchanged. The owner
 * asked for the harder pull above the default on 11-02: with keep 0.7 there
 * too, the top Season 0 player started Season 1 in Master, above anyone's
 * Season 0 SR, because Season 1 SR subtracts one sigma instead of two.
 */
export const SOFT_RESET = { keep: 0.7, keepAbove: 0.5, sigmaFloor: 6, mu: 25 } as const;

export function softResetRating(r: { mu: number; sigma: number }): { mu: number; sigma: number } {
  const keep = r.mu > SOFT_RESET.mu ? SOFT_RESET.keepAbove : SOFT_RESET.keep;
  return {
    mu: SOFT_RESET.mu + keep * (r.mu - SOFT_RESET.mu),
    sigma: Math.max(r.sigma, SOFT_RESET.sigmaFloor),
  };
}

export function seasonRules(db: DB, seasonId: number): SeasonRules {
  const row = db.prepare('SELECT sr_sigma_k, placement_games, ranks, final_min_games FROM seasons WHERE id = ?')
    .get(seasonId) as { sr_sigma_k: number; placement_games: number; ranks: number; final_min_games: number } | undefined;
  if (!row) return LEGACY_RULES;
  return { srSigmaK: row.sr_sigma_k, placementGames: row.placement_games, ranks: row.ranks === 1, finalMinGames: row.final_min_games };
}

/** SR under a season's rules. Never negative. */
export function srUnder(rules: Pick<SeasonRules, 'srSigmaK'>, mu: number, sigma: number): number {
  return Math.max(0, Math.round((mu - rules.srSigmaK * sigma) * 100));
}

// ---- Ranks ---------------------------------------------------------------

export const RANK_TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master'] as const;
export type RankTier = typeof RANK_TIERS[number];
/** Lowest division first: Gold III, then Gold II, then Gold I. */
export const RANK_DIVISIONS = ['III', 'II', 'I'] as const;
/** Where each tier starts. Gold is the middle of the ladder (the median
 *  player sits around 1800), Bronze and Master are the thin ends: Silver to
 *  Platinum are 500 SR wide, Diamond 600, and Master is open-ended above
 *  3300 (its divisions are 200 apart). Bronze starts (notionally) at 600 and
 *  holds everything below it too. */
const TIER_FLOORS = [600, 1100, 1600, 2100, 2700, 3300];
const TIER_WIDTHS = [500, 500, 500, 600, 600, 600];
export const RANK_COUNT = RANK_TIERS.length * RANK_DIVISIONS.length;
/** SR below a held division's floor before the badge drops. Ranking up is
 *  instant; ranking down waits for this, so a player on a line does not
 *  flicker between two badges every game. */
export const DEMOTION_BUFFER = 50;

/** The SR at which rank index `i` starts (0 = Bronze III, 17 = Master I). */
export function rankFloor(i: number): number {
  const tier = Math.floor(i / RANK_DIVISIONS.length);
  const division = i % RANK_DIVISIONS.length;
  return TIER_FLOORS[tier] + Math.round((division * TIER_WIDTHS[tier]) / RANK_DIVISIONS.length);
}

/** The rank an SR earns, with no buffer. */
export function rankIndexOf(sr: number): number {
  let i = 0;
  while (i + 1 < RANK_COUNT && sr >= rankFloor(i + 1)) i++;
  return i;
}

/** The rank shown after a game: up at once, down only once SR falls
 *  DEMOTION_BUFFER below the held division's floor. */
export function rankAfter(held: number | null, sr: number): number {
  const earned = rankIndexOf(sr);
  if (held === null || earned >= held) return earned;
  return sr < rankFloor(held) - DEMOTION_BUFFER ? earned : held;
}

export interface RankView {
  index: number;
  tier: RankTier;
  division: typeof RANK_DIVISIONS[number];
  /** "Gold II". */
  name: string;
  /** SR where this division starts, and where the next one does (null at
   *  Master I), so a page can say "120 to Gold I". */
  floor: number;
  next: number | null;
}

export function rankView(index: number): RankView {
  const tier = RANK_TIERS[Math.floor(index / RANK_DIVISIONS.length)];
  const division = RANK_DIVISIONS[index % RANK_DIVISIONS.length];
  return {
    index, tier, division, name: `${tier} ${division}`,
    floor: rankFloor(index), next: index + 1 < RANK_COUNT ? rankFloor(index + 1) : null,
  };
}

// ---- A season's ladder ---------------------------------------------------

export interface LadderEntry {
  steamid: string;
  mu: number;
  sigma: number;
  wins: number;
  losses: number;
  /** Rated games this season (rating_history rows). */
  games: number;
  /** SR under the season's rules, whether or not it is shown yet. */
  sr: number;
  /** Past placement. Always true in a season without placement. */
  placed: boolean;
  /** Rank held (with the demotion buffer), null while placing or in a
   *  season without ranks. */
  rankIdx: number | null;
  /** Highest SR since placement, null while placing. */
  peakSr: number | null;
  /** Highest rank held at any point this season (the season-end trophy),
   *  null while placing or in a season without ranks. */
  peakRankIdx: number | null;
}

/**
 * Every rated player's standing in a season, derived from rating_history so a
 * recompute, a void or a merge needs no second bookkeeping: the held rank is
 * a fold of rankAfter over the player's SR after each game from the one that
 * completed placement on.
 */
export function seasonLadder(db: DB, seasonId: number, only?: string): Map<string, LadderEntry> {
  const rules = seasonRules(db, seasonId);
  const ratings = db.prepare(
    `SELECT player_id, mu, sigma, wins, losses FROM player_ratings WHERE season_id = ?${only ? ' AND player_id = ?' : ''}`,
  ).all(...(only ? [seasonId, only] : [seasonId])) as { player_id: string; mu: number; sigma: number; wins: number; losses: number }[];
  const hist = db.prepare(
    `SELECT player_id, mu_after, sigma_after FROM rating_history WHERE season_id = ?${only ? ' AND player_id = ?' : ''} ORDER BY id`,
  ).all(...(only ? [seasonId, only] : [seasonId])) as { player_id: string; mu_after: number; sigma_after: number }[];

  const out = new Map<string, LadderEntry>();
  for (const r of ratings) {
    out.set(r.player_id, {
      steamid: r.player_id, mu: r.mu, sigma: r.sigma, wins: r.wins, losses: r.losses,
      games: 0, sr: srUnder(rules, r.mu, r.sigma), placed: rules.placementGames === 0,
      rankIdx: null, peakSr: null, peakRankIdx: null,
    });
  }
  for (const h of hist) {
    const e = out.get(h.player_id);
    if (!e) continue;
    e.games++;
    if (e.games < rules.placementGames) continue;
    const sr = srUnder(rules, h.mu_after, h.sigma_after);
    e.placed = true;
    e.peakSr = e.peakSr === null ? sr : Math.max(e.peakSr, sr);
    if (rules.ranks) {
      e.rankIdx = rankAfter(e.rankIdx, sr);
      e.peakRankIdx = e.peakRankIdx === null ? e.rankIdx : Math.max(e.peakRankIdx, e.rankIdx);
    }
  }
  // A season with no placement shows SR from the start, so a peak exists
  // before any game too; the current SR stands in.
  for (const e of out.values()) if (e.placed && e.peakSr === null) e.peakSr = e.sr;
  return out;
}

export function playerSeasonState(db: DB, seasonId: number, steamid: string): LadderEntry | null {
  return seasonLadder(db, seasonId, steamid).get(steamid) ?? null;
}

/**
 * The Top 10 of a season: placed players with at least the season's final
 * minimum of games, not banned, by SR. Ties keep the more games first, then
 * the steamid, so the order is stable.
 */
export function topTen(db: DB, seasonId: number, ladder?: Map<string, LadderEntry>, now = new Date()): string[] {
  const rules = seasonRules(db, seasonId);
  // Season 0 has no ranks, and so no Top 10 badge either.
  if (!rules.ranks) return [];
  // Memoised per season on everything the answer depends on, so a profile
  // view does not fold the whole season's history each time: a new rating
  // row, a recompute (ids change), and a ban or lift all change the key.
  const key = JSON.stringify(db.prepare(
    `SELECT (SELECT COUNT(*) FROM rating_history WHERE season_id = ?) AS n,
            (SELECT MAX(id) FROM rating_history WHERE season_id = ?) AS last,
            (SELECT COUNT(*) || ':' || IFNULL(MAX(rowid), 0) FROM bans WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)) AS bans,
            (SELECT final_min_games FROM seasons WHERE id = ?) AS min`,
  ).get(seasonId, seasonId, now.toISOString(), seasonId));
  const memo = topTenMemo.get(db)?.get(seasonId);
  if (memo && memo.key === key) return memo.ids;
  ladder ??= seasonLadder(db, seasonId);
  const banned = new Set((db.prepare(
    'SELECT DISTINCT player_id FROM bans WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
  ).all(now.toISOString()) as { player_id: string }[]).map((r) => r.player_id));
  const ids = [...ladder.values()]
    .filter((e) => e.placed && e.games >= rules.finalMinGames && !banned.has(e.steamid))
    .sort((a, b) => b.sr - a.sr || b.games - a.games || a.steamid.localeCompare(b.steamid))
    .slice(0, 10)
    .map((e) => e.steamid);
  if (!topTenMemo.has(db)) topTenMemo.set(db, new Map());
  topTenMemo.get(db)!.set(seasonId, { key, ids });
  return ids;
}

const topTenMemo = new WeakMap<DB, Map<number, { key: string; ids: string[] }>>();

/**
 * Where one rated game sits in a player's season: still placing, the game
 * that completed placement, or an ordinary ranked game. A match page and the
 * Discord card use it so a placement game never shows an SR change.
 */
export type GamePhase = { kind: 'placing'; played: number; of: number } | { kind: 'placed' } | { kind: 'ranked' };

export function gamePhase(rules: SeasonRules, gameNumber: number): GamePhase {
  if (rules.placementGames === 0 || gameNumber > rules.placementGames) return { kind: 'ranked' };
  if (gameNumber === rules.placementGames) return { kind: 'placed' };
  return { kind: 'placing', played: gameNumber, of: rules.placementGames };
}

/** The 1-based number of each listed player's game in `matchId` within its
 *  season, from rating_history (absent for a player with no row there). */
export function gameNumbers(db: DB, matchId: number): Map<string, number> {
  const rows = db.prepare(
    `SELECT rh.player_id,
            (SELECT COUNT(*) FROM rating_history x
              WHERE x.player_id = rh.player_id AND x.season_id = rh.season_id AND x.id <= rh.id) AS n
     FROM rating_history rh WHERE rh.match_id = ?`,
  ).all(matchId) as { player_id: string; n: number }[];
  return new Map(rows.map((r) => [r.player_id, r.n]));
}

/** What anyone but staff may see of a player's season standing: no SR, rank
 *  or peak while they are placing, only how far through placement they are. */
export interface PublicStanding {
  sr: number | null;
  placing: { played: number; of: number } | null;
  rank: RankView | null;
  peakSr: number | null;
  top10: boolean;
}

export function publicStanding(rules: SeasonRules, e: LadderEntry | null | undefined, top10: readonly string[] = []): PublicStanding {
  if (!e) {
    return rules.placementGames > 0
      ? { sr: null, placing: { played: 0, of: rules.placementGames }, rank: null, peakSr: null, top10: false }
      : { sr: null, placing: null, rank: null, peakSr: null, top10: false };
  }
  if (!e.placed) return { sr: null, placing: { played: e.games, of: rules.placementGames }, rank: null, peakSr: null, top10: false };
  return {
    sr: e.sr, placing: null, rank: e.rankIdx === null ? null : rankView(e.rankIdx),
    peakSr: e.peakSr, top10: top10.includes(e.steamid),
  };
}

/**
 * What a match row may say about one player's SR in it: the change, or for a
 * placement game no change and how far through placement they are, or for
 * the game that completed placement the rank it placed them into. Null
 * srDelta, not 0, when the rating never touched them: "+0" claims a result.
 */
export function matchSrChange(
  rules: SeasonRules | null, gameNumber: number | undefined,
  h: { mu_before: number | null; sigma_before: number | null; mu_after: number | null; sigma_after: number | null },
): { srDelta: number | null; placement: GamePhase | null; placedRank: string | null } {
  if (!rules || gameNumber === undefined || h.mu_after === null || h.mu_before === null) {
    return { srDelta: null, placement: null, placedRank: null };
  }
  const phase = gamePhase(rules, gameNumber);
  if (phase.kind === 'placing') return { srDelta: null, placement: phase, placedRank: null };
  const after = srUnder(rules, h.mu_after, h.sigma_after!);
  if (phase.kind === 'placed') {
    return { srDelta: null, placement: phase, placedRank: rules.ranks ? rankView(rankIndexOf(after)).name : null };
  }
  return { srDelta: after - srUnder(rules, h.mu_before, h.sigma_before!), placement: null, placedRank: null };
}
