import type { DB } from './db.js';
import type { FinalStanding } from './seasons.js';
import { completedPug } from './matchKinds.js';
import { notBannedSql } from './banState.js';
import { getSetting } from './settings.js';
import { standingMinGames, RANKED_MIN_GAMES } from './standings.js';
import { seasonRules, srUnder } from './seasonRules.js';
import { ENDORSE_KINDS, titleFromCounts, type EndorseKind } from './endorsements.js';
import { awardDef } from './weeklyAwards.js';

/**
 * Season Wrapped: a story deck of each player's season, plus the community's.
 *
 * Computed ONCE, when the season closes (startNewSeason calls
 * freezeSeasonWrapped right after freezing season_results), and stored as
 * JSON in season_wrapped, the same way weeklyStore freezes a week. Ratings are
 * recomputed on merges and voids and names change, so cards computed on the
 * fly would shift after people shared them.
 *
 * Every number reads the same match set: completed PUGs of the season, not
 * voided. Banned players' matches count in community totals, but they are
 * left off every named list and get no deck of their own. Spec and data
 * study: docs/season-wrapped.md.
 */

/** How many PUGs buy each deck. The full deck needs the badge gate
 *  (standing_min_games), the short one the ranked gate. */
export type WrappedTier = 'full' | 'short' | 'dropin';
/** Games together (or against) before a duo or a nemesis counts
 *  (chemistry_min_games). */
const PAIR_MIN_DEFAULT = 5;
const CAMPAIGN_MIN = 5;
const MAP_MIN = 4;
/** Best duo on the community board: a pair this regular, so it is not a
 *  three-game fluke. */
const COMMUNITY_DUO_MIN = 15;
/** Points the sparkline keeps; a heavy player has 190 rated games. */
const SPARK_POINTS = 40;

/** Stats a signature card can be about, with the card's wording. Left out:
 *  stats that were never recorded (deadstops, tongue cuts, melee skeets) and
 *  anything that is not an achievement. */
const SIGNATURE: readonly (readonly [key: string, label: string])[] = [
  ['winrate', 'win rate'], ['sidmg', 'SI damage'], ['sikill', 'SI kills'], ['ck', 'common kills'], ['rev', 'revives'],
  ['skeets', 'skeets'], ['team_skeets', 'team skeets'], ['skeet_assists', 'skeet assists'], ['boomer_pops', 'boomer pops'],
  ['crowns', 'witch crowns'], ['self_clears', 'self clears'], ['rock_skeets', 'rock skeets'], ['clears', 'clears'],
  ['insta_clears', 'insta clears'], ['tongue_clears', 'tongue clears'], ['tank_damage', 'tank damage'],
  ['dps_landed', 'damage pounces'], ['pounce_damage_high', 'high pounce damage'], ['biles_landed', 'biles landed'],
  ['tank_rocks_landed', 'tank rocks landed'], ['damage_as_si', 'damage as SI'], ['tank_punches', 'tank punches'],
  ['boom_successes', 'booms landed'], ['quad_caps', 'quad caps'],
];
/** Per-map bests, from match_live_map_stats keys. */
const MAP_BEST_KEYS = ['sidmg', 'ck', 'skeets', 'damage_as_si', 'tank_damage'] as const;
/** Weekly awards nobody wants on a trophy shelf. */
const SHAME_AWARDS = new Set(['slow_ready', 'friendly_fire', 'group_hug']);

export interface PairLine { steamid: string; name: string; games: number; wins: number }
export interface MapLine { map: string; games: number; wins: number; avgMargin: number }
export interface CampaignLine { campaign: string; games: number; wins: number }
export interface MatchRef { matchId: number; map: string | null; value: number }

export interface WrappedPlayer {
  v: 1;
  steamid: string;
  name: string;
  tier: WrappedTier;
  numbers: {
    matches: number; wins: number; losses: number; hours: number; maps: number; nights: number;
    /** Place by matches played among everyone who played (1 = most). */
    gamesRank: number; ofPlayers: number;
    longestNight: { date: string; matches: number; hours: number } | null;
  };
  /** From the frozen final standings. Null when they never played a rated game. */
  standing: {
    sr: number; peakSr: number; peakAt: string | null; peakMatchId: number | null;
    finalRank: number | null; ofRanked: number; finalMinGames: number; games: number;
    /** SR after each rated game, thinned to at most SPARK_POINTS. */
    spark: number[];
    rankIdx: number | null; peakRankIdx: number | null;
  } | null;
  streaks: { win: number; loss: number };
  campaigns: { most: CampaignLine | null; best: CampaignLine | null };
  maps: { best: MapLine | null; worst: MapLine | null };
  people: { mostWith: PairLine | null; bestDuo: PairLine | null; teammates: number };
  rivals: { nemesis: PairLine | null; favourite: PairLine | null; mostFaced: PairLine | null };
  /** Best per-match ranks among the full-deck pool, best first; null under the gate. */
  signature: { key: string; label: string; perMatch: number; rank: number; of: number }[] | null;
  bestMap: Partial<Record<(typeof MAP_BEST_KEYS)[number], MatchRef>>;
  bestMatchSkeets: MatchRef | null;
  sides: {
    survivorHalves: number; survivorAvg: number | null; survivedPct: number | null;
    infectedHalves: number; concededAvg: number | null; wipedPct: number | null;
    communityAvg: number;
  };
  endorsements: { counts: Record<EndorseKind, number>; givers: number; given: number; title: EndorseKind | null; mostEndorsedRank: number | null };
  trophies: {
    weekly: { award: string; label: string; week: string }[];
    skeetTriples: number;
    totals: { ck: number; skeets: number; crowns: number; rockSkeets: number; quadCaps: number; revives: number; dps: number };
  };
  /** Matches started per UTC hour of the week: index = day * 24 + hour,
   *  day 0 = Sunday. The page rotates it into the viewer's zone. */
  hours: number[];
  first: { matchId: number; campaign: string; startedAt: string; won: boolean; firstEver: boolean; firstPartner: PairLine | null };
}

export interface NamedValue { steamid: string; name: string; value: number; games?: number }

export interface WrappedCommunity {
  v: 1;
  season: { id: number; name: string; startedAt: string; endedAt: string | null };
  overview: { matches: number; matchHours: number; playerHours: number; avgMinutes: number; players: number; maps: number; halves: number; first: string | null; last: string | null };
  /** Matches per award week (Monday 12:00 UTC weeks), oldest first. */
  weeks: { week: string; matches: number }[];
  busiestNight: { date: string; matches: number } | null;
  hours: number[];
  campaigns: { campaign: string; matches: number; hours: number }[];
  deadliestMap: { map: string; halves: number; survivedPct: number } | null;
  kindestMap: { map: string; halves: number; survivedPct: number } | null;
  totals: Record<string, number>;
  survival: { measured: number; survived: number };
  top10: { rank: number; steamid: string; name: string; sr: number; wins: number; losses: number }[];
  finalMinGames: number;
  peakSr: NamedValue | null;
  leaders: Record<string, NamedValue[]>;
  duos: { best: { a: string; b: string; games: number; wins: number }[]; common: { a: string; b: string; games: number; wins: number }[] };
  moments: {
    closest: { matchId: number; campaign: string; a: number; b: number }[];
    blowout: { matchId: number; campaign: string; a: number; b: number } | null;
    longest: { matchId: number; campaign: string; minutes: number } | null;
    bestHalf: { matchId: number; map: string; score: number } | null;
    bestSingleMap: Partial<Record<string, MatchRef & { steamid: string; name: string }>>;
    skeetTriples: number;
  };
  endorsements: { given: number; givers: number; receivers: number; startedAt: string | null };
  buckets: { full: number; short: number; dropin: number };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
const intSetting = (db: DB, key: string, fallback: number): number => {
  const n = Math.trunc(Number(getSetting(db, key)));
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
/** sqlite datetime text to epoch ms (stored as UTC without a zone). */
const utcMs = (s: string): number => Date.parse(s.includes('T') ? (s.endsWith('Z') ? s : `${s}Z`) : `${s.replace(' ', 'T')}Z`);
const hourOfWeek = (s: string): number => { const d = new Date(utcMs(s)); return d.getUTCDay() * 24 + d.getUTCHours(); };

export function wrappedTier(matches: number, fullMin: number): WrappedTier {
  return matches >= fullMin ? 'full' : matches >= RANKED_MIN_GAMES ? 'short' : 'dropin';
}

/** Longest runs of 1s and of 0s, in order. */
export function longestRuns(seq: readonly boolean[]): { win: number; loss: number } {
  let win = 0; let loss = 0; let w = 0; let l = 0;
  for (const x of seq) { w = x ? w + 1 : 0; l = x ? 0 : l + 1; win = Math.max(win, w); loss = Math.max(loss, l); }
  return { win, loss };
}

/** Thin a series to n points, always keeping the first and last. */
export function thin(xs: readonly number[], n: number): number[] {
  if (xs.length <= n) return [...xs];
  return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
}

interface PmRow { id: number; campaign: string; winner: string | null; a: number; b: number; ended_at: string; started_at: string; hours: number }
interface MpRow { match_id: number; player_id: string; team: string; joined_map: number; si_damage: number; si_kills: number; common_kills: number; revives: number }
interface Live { match_id: number; ordinal: number; player_id: string; stats_json: string; map: string | null }

/**
 * Everything Wrapped shows for one season, for every player at once. Bulk
 * queries, then grouping in memory: a season is a few thousand player
 * matches, and the per-player version of this was 4,000 queries.
 */
export function computeWrapped(
  db: DB, seasonId: number, now = new Date(), opts: { standings?: readonly FinalStanding[] } = {},
): { community: WrappedCommunity; players: WrappedPlayer[] } {
  const season = db.prepare('SELECT id, name, started_at, ended_at FROM seasons WHERE id = ?')
    .get(seasonId) as { id: number; name: string; started_at: string; ended_at: string | null } | undefined;
  if (!season) throw new Error(`no season ${seasonId}`);
  const nowIso = now.toISOString();
  const fullMin = standingMinGames(db);
  const pairMin = intSetting(db, 'chemistry_min_games', PAIR_MIN_DEFAULT);
  const rules = seasonRules(db, seasonId);

  // The match set, with a duration: first round start to last round end,
  // falling back to went live (or created) to ended for a match without rounds.
  const pm = db.prepare(
    `SELECT m.id, m.campaign, m.winner, m.team_a_score AS a, m.team_b_score AS b, m.ended_at,
            COALESCE(r.s, m.went_live_at, m.created_at) AS started_at,
            MAX(0, (julianday(COALESCE(r.e, m.ended_at)) - julianday(COALESCE(r.s, m.went_live_at, m.created_at))) * 24) AS hours
     FROM matches m
     LEFT JOIN (SELECT match_id, MIN(started_at) s, MAX(ended_at) e FROM match_rounds GROUP BY match_id) r ON r.match_id = m.id
     WHERE m.season_id = ? AND ${completedPug('m')} AND m.voided_at IS NULL AND m.ended_at IS NOT NULL
     ORDER BY m.ended_at, m.id`,
  ).all(seasonId) as PmRow[];
  const pmById = new Map(pm.map((m) => [m.id, m]));
  const ids = `SELECT m.id FROM matches m WHERE m.season_id = ${Number(seasonId)} AND ${completedPug('m')} AND m.voided_at IS NULL AND m.ended_at IS NOT NULL`;

  const players = new Map((db.prepare('SELECT steamid, name FROM players').all() as { steamid: string; name: string }[]).map((p) => [p.steamid, p.name]));
  const nameOf = (id: string) => players.get(id) ?? id;
  const banned = new Set((db.prepare(
    'SELECT DISTINCT player_id FROM bans WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
  ).all(nowIso) as { player_id: string }[]).map((r) => r.player_id));
  const aliases = new Map((db.prepare('SELECT steamid, canonical_id FROM player_aliases').all() as { steamid: string; canonical_id: string }[]).map((r) => [r.steamid, r.canonical_id]));
  const canon = (id: string) => aliases.get(id) ?? id;

  const mps = db.prepare(
    `SELECT match_id, player_id, team, joined_map, si_damage, si_kills, common_kills, revives
     FROM match_players WHERE match_id IN (${ids})`,
  ).all() as MpRow[];
  const byMatch = new Map<number, MpRow[]>();
  const byPlayer = new Map<string, MpRow[]>();
  for (const r of mps) {
    (byMatch.get(r.match_id) ?? byMatch.set(r.match_id, []).get(r.match_id)!).push(r);
    (byPlayer.get(r.player_id) ?? byPlayer.set(r.player_id, []).get(r.player_id)!).push(r);
  }
  for (const rows of byPlayer.values()) rows.sort((x, y) => (pmById.get(x.match_id)!.ended_at.localeCompare(pmById.get(y.match_id)!.ended_at)) || x.match_id - y.match_id);
  const won = (r: MpRow) => pmById.get(r.match_id)!.winner === r.team;

  const statRows = db.prepare(
    `SELECT match_id, player_id, stat, value FROM match_player_stats WHERE match_id IN (${ids})`,
  ).all() as { match_id: number; player_id: string; stat: string; value: number }[];
  const statTotals = new Map<string, Record<string, number>>();
  const seasonTotals: Record<string, number> = {};
  const matchSkeets = new Map<string, MatchRef>();
  for (const s of statRows) {
    const bag = statTotals.get(s.player_id) ?? statTotals.set(s.player_id, {}).get(s.player_id)!;
    bag[s.stat] = (bag[s.stat] ?? 0) + s.value;
    seasonTotals[s.stat] = (seasonTotals[s.stat] ?? 0) + s.value;
    if (s.stat === 'skeets' && s.value > (matchSkeets.get(s.player_id)?.value ?? 0)) matchSkeets.set(s.player_id, { matchId: s.match_id, map: null, value: s.value });
  }
  const crownsOf = (bag: Record<string, number> | undefined) => (bag?.crowns ?? 0) + (bag?.draw_crowns ?? 0);

  // Maps a player was present for, with the map score.
  const mapRows = db.prepare(
    `SELECT mm.match_id, mm.ordinal, mm.map, mm.team_a_score AS a, mm.team_b_score AS b,
            NOT EXISTS (SELECT 1 FROM match_rounds r WHERE r.match_id = mm.match_id AND r.ordinal = mm.ordinal AND r.reliable = 0) AS reliable
     FROM match_maps mm WHERE mm.match_id IN (${ids})`,
  ).all() as { match_id: number; ordinal: number; map: string; a: number; b: number; reliable: number }[];
  const mapsByMatch = new Map<number, typeof mapRows>();
  for (const m of mapRows) (mapsByMatch.get(m.match_id) ?? mapsByMatch.set(m.match_id, []).get(m.match_id)!).push(m);
  const mapName = new Map(mapRows.map((m) => [`${m.match_id}:${m.ordinal}`, m.map]));

  const rounds = db.prepare(
    `SELECT match_id, ordinal, surv_team, score, survivors_alive FROM match_rounds WHERE reliable = 1 AND match_id IN (${ids})`,
  ).all() as { match_id: number; ordinal: number; surv_team: string; score: number; survivors_alive: number | null }[];
  const roundsByMatch = new Map<number, typeof rounds>();
  for (const r of rounds) (roundsByMatch.get(r.match_id) ?? roundsByMatch.set(r.match_id, []).get(r.match_id)!).push(r);
  const communityAvgHalf = Math.round(ratio(rounds.reduce((s, r) => s + r.score, 0), rounds.length));

  // Per-map bests from the cumulative snapshots, diffed against the previous
  // map of the same match (liveView.mapStatsFor does the same).
  const live = db.prepare(
    `SELECT l.match_id, l.ordinal, l.player_id, l.stats_json, mm.map FROM match_live_map_stats l
     LEFT JOIN match_maps mm ON mm.match_id = l.match_id AND mm.ordinal = l.ordinal
     WHERE l.match_id IN (${ids}) ORDER BY l.match_id, l.player_id, l.ordinal`,
  ).all() as Live[];
  const mapBest = new Map<string, Partial<Record<string, MatchRef>>>();
  const communityMapBest: Partial<Record<string, MatchRef & { steamid: string; name: string }>> = {};
  {
    let prev: { match_id: number; player_id: string; ordinal: number; s: Record<string, number> } | null = null;
    for (const r of live) {
      let s: Record<string, number>;
      try { s = JSON.parse(r.stats_json) as Record<string, number>; } catch { continue; }
      const base = prev && prev.match_id === r.match_id && prev.player_id === r.player_id && prev.ordinal === r.ordinal - 1 ? prev.s : {};
      prev = { match_id: r.match_id, player_id: r.player_id, ordinal: r.ordinal, s };
      const mine = mapBest.get(r.player_id) ?? mapBest.set(r.player_id, {}).get(r.player_id)!;
      for (const k of MAP_BEST_KEYS) {
        const d = (Number(s[k]) || 0) - (Number(base[k]) || 0);
        if (d <= 0) continue;
        if (d > (mine[k]?.value ?? 0)) mine[k] = { matchId: r.match_id, map: r.map, value: d };
        if (!banned.has(r.player_id) && d > (communityMapBest[k]?.value ?? 0)) {
          communityMapBest[k] = { matchId: r.match_id, map: r.map, value: d, steamid: r.player_id, name: nameOf(r.player_id) };
        }
      }
    }
  }

  // Pairs, alias-resolved on both sides like chemistry.ts.
  type Pair = { games: number; wins: number };
  const pairs = new Map<string, { with: Map<string, Pair>; vs: Map<string, Pair> }>();
  const pairsOf = (id: string) => pairs.get(id) ?? pairs.set(id, { with: new Map(), vs: new Map() }).get(id)!;
  for (const [matchId, rows] of byMatch) {
    const m = pmById.get(matchId)!;
    const roster = new Map<string, string>();
    for (const r of rows) roster.set(canon(r.player_id), r.team);
    for (const [me, team] of roster) {
      for (const [o, oteam] of roster) {
        if (o === me) continue;
        const bucket = pairsOf(me)[oteam === team ? 'with' : 'vs'];
        const p = bucket.get(o) ?? bucket.set(o, { games: 0, wins: 0 }).get(o)!;
        p.games++; if (m.winner === team) p.wins++;
      }
    }
  }
  const line = (id: string, p: Pair): PairLine => ({ steamid: id, name: nameOf(id), games: p.games, wins: p.wins });
  /** Pick from pair rows, banned partners left out (they are off every named list). */
  const pick = (m: Map<string, Pair>, min: number, cmp: (a: Pair, b: Pair) => number): PairLine | null => {
    const best = [...m].filter(([id, p]) => p.games >= min && !banned.has(id)).sort(([ia, a], [ib, b]) => cmp(a, b) || b.games - a.games || ia.localeCompare(ib))[0];
    return best ? line(best[0], best[1]) : null;
  };
  const byRate = (a: Pair, b: Pair) => b.wins / b.games - a.wins / a.games;

  // Endorsements and weekly awards inside the season.
  const endorse = db.prepare(
    `SELECT from_id, to_id, kind, e.match_id FROM endorsements e WHERE e.match_id IN (${ids})`,
  ).all() as { from_id: string; to_id: string; kind: string }[];
  const firstEndorse = (db.prepare(`SELECT MIN(created_at) AS t FROM endorsements WHERE match_id IN (${ids})`).get() as { t: string | null } | undefined)?.t ?? null;
  const endorseMinCount = intSetting(db, 'endorse_title_min', 5);
  const endorseMinGames = intSetting(db, 'endorse_title_min_games', 10);
  const received = new Map<string, { counts: Record<EndorseKind, number>; givers: Set<string> }>();
  const given = new Map<string, number>();
  for (const e of endorse) {
    if (!(ENDORSE_KINDS as readonly string[]).includes(e.kind)) continue;
    const r = received.get(e.to_id) ?? received.set(e.to_id, { counts: { caller: 0, clutch: 0, vibes: 0 }, givers: new Set() }).get(e.to_id)!;
    r.counts[e.kind as EndorseKind]++; r.givers.add(e.from_id);
    given.set(e.from_id, (given.get(e.from_id) ?? 0) + 1);
  }
  const endorseTotal = (id: string) => { const c = received.get(id)?.counts; return c ? c.caller + c.clutch + c.vibes : 0; };
  const endorseOrder = [...received.keys()].filter((id) => !banned.has(id)).sort((a, b) => endorseTotal(b) - endorseTotal(a));

  const weekly = db.prepare(
    `SELECT player_id, award, week_start FROM weekly_awards
     WHERE week_start >= date(?) AND (? IS NULL OR week_start < date(?)) ORDER BY week_start, award`,
  ).all(season.started_at, season.ended_at, season.ended_at) as { player_id: string; award: string; week_start: string }[];
  const weeklyBy = new Map<string, { award: string; label: string; week: string }[]>();
  for (const w of weekly) {
    const def = awardDef(w.award);
    if (!def || SHAME_AWARDS.has(w.award) || def.group === 'shame') continue;
    const list = weeklyBy.get(w.player_id) ?? weeklyBy.set(w.player_id, []).get(w.player_id)!;
    if (!list.some((x) => x.award === w.award && x.week === w.week_start)) list.push({ award: w.award, label: def.label, week: w.week_start });
  }
  const triples = db.prepare(`SELECT player_id, COUNT(*) AS n FROM skeet_streaks WHERE match_id IN (${ids}) GROUP BY player_id`).all() as { player_id: string; n: number }[];
  const triplesBy = new Map(triples.map((t) => [t.player_id, t.n]));

  // The frozen final standings (season_results): freezeSeasonWrapped always
  // runs right after freezeSeasonResults. A staff preview of a season still
  // open passes today's standings instead.
  type ResultRow = { player_id: string; sr: number; peak_sr: number; final_rank: number | null; rank_idx: number | null; peak_rank_idx: number | null; placed: number; games: number; wins: number; losses: number };
  const resultRows: ResultRow[] = opts.standings
    ? opts.standings.map((r) => ({ player_id: r.steamid, sr: r.sr, peak_sr: r.peakSr, final_rank: r.finalRank, rank_idx: r.rankIdx, peak_rank_idx: r.peakRankIdx, placed: r.placed ? 1 : 0, games: r.games, wins: r.wins, losses: r.losses }))
    : db.prepare('SELECT player_id, sr, peak_sr, final_rank, rank_idx, peak_rank_idx, placed, games, wins, losses FROM season_results WHERE season_id = ?').all(seasonId) as ResultRow[];
  const results = new Map(resultRows.map((r) => [r.player_id, r]));
  const ofRanked = [...results.values()].filter((r) => r.final_rank !== null).length;
  const history = db.prepare(
    `SELECT rh.player_id, rh.mu_after AS mu, rh.sigma_after AS sigma, rh.match_id, m.ended_at
     FROM rating_history rh JOIN matches m ON m.id = rh.match_id WHERE rh.season_id = ? ORDER BY rh.id`,
  ).all(seasonId) as { player_id: string; mu: number; sigma: number; match_id: number; ended_at: string }[];
  const histBy = new Map<string, typeof history>();
  for (const h of history) (histBy.get(h.player_id) ?? histBy.set(h.player_id, []).get(h.player_id)!).push(h);

  // Percentile pool: everyone with the full deck, per-match rates.
  const gamesOf = (id: string) => byPlayer.get(id)?.length ?? 0;
  const pool = [...byPlayer.keys()].filter((id) => gamesOf(id) >= fullMin);
  const fixedTotals = (id: string) => {
    const rows = byPlayer.get(id) ?? [];
    return {
      sidmg: rows.reduce((s, r) => s + (r.si_damage ?? 0), 0), sikill: rows.reduce((s, r) => s + (r.si_kills ?? 0), 0),
      ck: rows.reduce((s, r) => s + (r.common_kills ?? 0), 0), rev: rows.reduce((s, r) => s + (r.revives ?? 0), 0),
    };
  };
  const fixedBy = new Map([...byPlayer.keys()].map((id) => [id, fixedTotals(id)]));
  const metric = (id: string, key: string): number => {
    const g = gamesOf(id);
    if (g === 0) return 0;
    if (key === 'winrate') return (byPlayer.get(id) ?? []).filter(won).length / g;
    const f = fixedBy.get(id) as Record<string, number> | undefined;
    if (f && key in f) return f[key] / g;
    if (key === 'crowns') return crownsOf(statTotals.get(id)) / g;
    return (statTotals.get(id)?.[key] ?? 0) / g;
  };
  const poolMetrics = new Map(SIGNATURE.map(([k]) => [k, pool.map((id) => metric(id, k))]));

  const gamesSorted = [...byPlayer.keys()].map(gamesOf);
  const firstEverId = pm[0]?.id ?? null;

  const out: WrappedPlayer[] = [];
  for (const [id, rows] of byPlayer) {
    if (banned.has(id)) continue;
    const n = rows.length;
    const wins = rows.filter(won).length;
    const tier = wrappedTier(n, fullMin);

    // Nights: Eastern evenings with a 5 am cut, since the community is NA.
    const nights = new Map<string, { matches: number; hours: number }>();
    const hoursHist = new Array<number>(168).fill(0);
    let hours = 0; let maps = 0;
    for (const r of rows) {
      const m = pmById.get(r.match_id)!;
      hours += m.hours;
      maps += (mapsByMatch.get(r.match_id) ?? []).filter((x) => x.ordinal >= r.joined_map).length;
      hoursHist[hourOfWeek(m.started_at)]++;
      const night = new Date(utcMs(m.started_at) - 9 * 3600_000).toISOString().slice(0, 10);
      const e = nights.get(night) ?? nights.set(night, { matches: 0, hours: 0 }).get(night)!;
      e.matches++; e.hours += m.hours;
    }
    const longest = [...nights].sort(([da, a], [db2, b]) => b.matches - a.matches || b.hours - a.hours || da.localeCompare(db2))[0];

    const res = results.get(id);
    const hist = histBy.get(id) ?? [];
    let standing: WrappedPlayer['standing'] = null;
    if (res && res.placed) {
      const srs = hist.map((h) => srUnder(rules, h.mu, h.sigma));
      const peakIdx = srs.findIndex((s) => s === res.peak_sr);
      standing = {
        sr: res.sr, peakSr: res.peak_sr,
        peakAt: peakIdx >= 0 ? hist[peakIdx].ended_at : null, peakMatchId: peakIdx >= 0 ? hist[peakIdx].match_id : null,
        finalRank: res.final_rank, ofRanked, finalMinGames: rules.finalMinGames, games: res.games,
        spark: thin(srs, SPARK_POINTS), rankIdx: res.rank_idx, peakRankIdx: res.peak_rank_idx,
      };
    }

    // Campaigns (match level) and maps (map level, recorded maps only).
    const camps = new Map<string, CampaignLine>();
    const mapAgg = new Map<string, { games: number; wins: number; margin: number }>();
    for (const r of rows) {
      const m = pmById.get(r.match_id)!;
      const c = camps.get(m.campaign) ?? camps.set(m.campaign, { campaign: m.campaign, games: 0, wins: 0 }).get(m.campaign)!;
      c.games++; if (won(r)) c.wins++;
      for (const mm of mapsByMatch.get(r.match_id) ?? []) {
        if (mm.ordinal < r.joined_map || !mm.reliable || mm.a + mm.b <= 0) continue;
        const mine = r.team === 'a' ? mm.a : mm.b; const theirs = r.team === 'a' ? mm.b : mm.a;
        const e = mapAgg.get(mm.map) ?? mapAgg.set(mm.map, { games: 0, wins: 0, margin: 0 }).get(mm.map)!;
        e.games++; if (mine > theirs) e.wins++; e.margin += mine - theirs;
      }
    }
    const campList = [...camps.values()];
    const most = [...campList].sort((a, b) => b.games - a.games || b.wins - a.wins || a.campaign.localeCompare(b.campaign))[0] ?? null;
    const bestCamp = campList.filter((c) => c.games >= CAMPAIGN_MIN).sort((a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games)[0] ?? null;
    const mapList: MapLine[] = [...mapAgg].filter(([, e]) => e.games >= MAP_MIN)
      .map(([map, e]) => ({ map, games: e.games, wins: e.wins, avgMargin: Math.round(e.margin / e.games) }));
    const bestMapLine = [...mapList].sort((a, b) => b.wins / b.games - a.wins / a.games || b.avgMargin - a.avgMargin)[0] ?? null;
    const worstMapLine = [...mapList].sort((a, b) => a.wins / a.games - b.wins / b.games || a.avgMargin - b.avgMargin)[0] ?? null;

    const pr = pairs.get(canon(id)) ?? { with: new Map<string, Pair>(), vs: new Map<string, Pair>() };

    let signature: WrappedPlayer['signature'] = null;
    if (tier === 'full') {
      signature = SIGNATURE.map(([key, label]) => {
        const mine = metric(id, key);
        const field = poolMetrics.get(key)!;
        return { key, label, perMatch: Math.round(mine * 100) / 100, rank: 1 + field.filter((v) => v > mine).length, of: pool.length, mine };
      }).filter((s) => s.mine > 0).sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)).slice(0, 3)
        .map(({ mine: _m, ...s }) => s);
    }

    // Sides: the team's half scores while they were on each side.
    let sN = 0; let sSum = 0; let sMeas = 0; let sLived = 0; let iN = 0; let iSum = 0; let iMeas = 0; let iLived = 0;
    for (const r of rows) {
      for (const h of roundsByMatch.get(r.match_id) ?? []) {
        if (h.ordinal < r.joined_map) continue;
        const surv = h.surv_team === r.team;
        if (surv) { sN++; sSum += h.score; if (h.survivors_alive !== null) { sMeas++; if (h.survivors_alive > 0) sLived++; } } else { iN++; iSum += h.score; if (h.survivors_alive !== null) { iMeas++; if (h.survivors_alive > 0) iLived++; } }
      }
    }

    const rec = received.get(id);
    const counts = rec?.counts ?? { caller: 0, clutch: 0, vibes: 0 };
    const t = statTotals.get(id) ?? {};
    const f = fixedBy.get(id)!;
    const firstRow = [...rows].sort((a, b) => pmById.get(a.match_id)!.started_at.localeCompare(pmById.get(b.match_id)!.started_at) || a.match_id - b.match_id)[0];
    const firstM = pmById.get(firstRow.match_id)!;
    const firstMates = (byMatch.get(firstRow.match_id) ?? []).filter((x) => x.team === firstRow.team && x.player_id !== id && !banned.has(x.player_id));
    const firstPartner = firstMates.map((x) => ({ x, p: pr.with.get(canon(x.player_id)) })).filter((x) => x.p)
      .sort((a, b) => b.p!.games - a.p!.games)[0];
    const mostRank = endorseOrder.indexOf(id);

    out.push({
      v: 1, steamid: id, name: nameOf(id), tier,
      numbers: {
        matches: n, wins, losses: n - wins, hours: round1(hours), maps, nights: nights.size,
        gamesRank: 1 + gamesSorted.filter((g) => g > n).length, ofPlayers: byPlayer.size,
        longestNight: longest ? { date: longest[0], matches: longest[1].matches, hours: round1(longest[1].hours) } : null,
      },
      standing,
      streaks: longestRuns(rows.map(won)),
      campaigns: { most, best: bestCamp },
      maps: { best: bestMapLine, worst: worstMapLine && worstMapLine.map !== bestMapLine?.map ? worstMapLine : null },
      people: { mostWith: pick(pr.with, 1, (a, b) => b.games - a.games), bestDuo: pick(pr.with, pairMin, byRate), teammates: pr.with.size },
      rivals: {
        nemesis: pick(pr.vs, pairMin, (a, b) => -byRate(a, b)),
        favourite: pick(pr.vs, pairMin, byRate),
        mostFaced: pick(pr.vs, 1, (a, b) => b.games - a.games),
      },
      signature,
      bestMap: mapBest.get(id) ?? {},
      bestMatchSkeets: matchSkeets.get(id) ?? null,
      sides: {
        survivorHalves: sN, survivorAvg: sN ? Math.round(sSum / sN) : null, survivedPct: sMeas ? round1((100 * sLived) / sMeas) : null,
        infectedHalves: iN, concededAvg: iN ? Math.round(iSum / iN) : null, wipedPct: iMeas ? round1((100 * (iMeas - iLived)) / iMeas) : null,
        communityAvg: communityAvgHalf,
      },
      endorsements: {
        counts, givers: rec?.givers.size ?? 0, given: given.get(id) ?? 0,
        title: titleFromCounts(counts, n, endorseMinCount, endorseMinGames),
        mostEndorsedRank: mostRank >= 0 && endorseTotal(id) > 0 ? mostRank + 1 : null,
      },
      trophies: {
        weekly: weeklyBy.get(id) ?? [],
        skeetTriples: triplesBy.get(id) ?? 0,
        totals: { ck: f.ck, skeets: t.skeets ?? 0, crowns: crownsOf(t), rockSkeets: t.rock_skeets ?? 0, quadCaps: t.quad_caps ?? 0, revives: f.rev, dps: t.dps_landed ?? 0 },
      },
      hours: hoursHist,
      first: {
        matchId: firstM.id, campaign: firstM.campaign, startedAt: firstM.started_at, won: won(firstRow), firstEver: firstM.id === firstEverId,
        firstPartner: firstPartner ? line(canon(firstPartner.x.player_id), firstPartner.p!) : null,
      },
    });
  }

  return { community: community(), players: out };

  function community(): WrappedCommunity {
    const matchHours = pm.reduce((s, m) => s + m.hours, 0);
    const playerHours = mps.reduce((s, r) => s + pmById.get(r.match_id)!.hours, 0);
    const hoursHist = new Array<number>(168).fill(0);
    const weeks = new Map<string, number>();
    const nights = new Map<string, number>();
    const camps = new Map<string, { matches: number; hours: number }>();
    for (const m of pm) {
      hoursHist[hourOfWeek(m.started_at)]++;
      // Award weeks turn at Monday 12:00 UTC (weeklyAwards.weekStartOf).
      const t = new Date(utcMs(m.started_at) - 12 * 3600_000);
      const monday = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - ((t.getUTCDay() + 6) % 7)));
      const wk = monday.toISOString().slice(0, 10);
      weeks.set(wk, (weeks.get(wk) ?? 0) + 1);
      const night = new Date(utcMs(m.started_at) - 9 * 3600_000).toISOString().slice(0, 10);
      nights.set(night, (nights.get(night) ?? 0) + 1);
      const c = camps.get(m.campaign) ?? camps.set(m.campaign, { matches: 0, hours: 0 }).get(m.campaign)!;
      c.matches++; c.hours += m.hours;
    }
    const busiest = [...nights].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0];

    // Survival per map over measured halves, maps with a real sample only.
    const surv = new Map<string, { n: number; lived: number }>();
    let measured = 0; let lived = 0;
    for (const r of rounds) {
      if (r.survivors_alive === null) continue;
      measured++; if (r.survivors_alive > 0) lived++;
      const map = mapName.get(`${r.match_id}:${r.ordinal}`);
      if (!map) continue;
      const e = surv.get(map) ?? surv.set(map, { n: 0, lived: 0 }).get(map)!;
      e.n++; if (r.survivors_alive > 0) e.lived++;
    }
    const survList = [...surv].filter(([, e]) => e.n >= 40).map(([map, e]) => ({ map, halves: e.n, survivedPct: round1((100 * e.lived) / e.n) }))
      .sort((a, b) => a.survivedPct - b.survivedPct);

    const fixedSum = (k: keyof MpRow) => mps.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const totals: Record<string, number> = {
      ...seasonTotals, ck: fixedSum('common_kills'), sidmg: fixedSum('si_damage'), sikill: fixedSum('si_kills'), rev: fixedSum('revives'),
      crowns_all: (seasonTotals.crowns ?? 0) + (seasonTotals.draw_crowns ?? 0),
    };

    // final_rank already leaves out anyone banned at the close; a ban since
    // takes the name off without renumbering the frozen places.
    const top10 = [...results.values()].filter((r) => r.final_rank !== null && r.final_rank <= 10 && !banned.has(r.player_id))
      .sort((a, b) => a.final_rank! - b.final_rank!)
      .map((r) => ({ rank: r.final_rank!, steamid: r.player_id, name: nameOf(r.player_id), sr: r.sr, wins: r.wins, losses: r.losses }));

    let peakSr: NamedValue | null = null;
    for (const r of results.values()) {
      if (!r.placed || banned.has(r.player_id)) continue;
      if (!peakSr || r.peak_sr > peakSr.value) peakSr = { steamid: r.player_id, name: nameOf(r.player_id), value: r.peak_sr };
    }

    const eligible = [...byPlayer.keys()].filter((id) => !banned.has(id));
    const top = (value: (id: string) => number, n = 3): NamedValue[] => eligible.map((id) => ({ steamid: id, name: nameOf(id), value: value(id), games: gamesOf(id) }))
      .filter((x) => x.value > 0).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)).slice(0, n);
    const stat = (k: string) => (id: string) => statTotals.get(id)?.[k] ?? 0;
    const perMatch = (value: (id: string) => number) => (id: string) => (gamesOf(id) >= fullMin ? value(id) / gamesOf(id) : 0);
    const leaders: Record<string, NamedValue[]> = {
      matches: top(gamesOf),
      skeets: top(stat('skeets')), skeets_pm: top(perMatch(stat('skeets'))),
      sidmg: top((id) => fixedBy.get(id)!.sidmg), sidmg_pm: top(perMatch((id) => fixedBy.get(id)!.sidmg)),
      ck: top((id) => fixedBy.get(id)!.ck),
      crowns: top((id) => crownsOf(statTotals.get(id))), crowns_pm: top(perMatch((id) => crownsOf(statTotals.get(id)))),
      rock_skeets: top(stat('rock_skeets')),
      rev: top((id) => fixedBy.get(id)!.rev),
      damage_as_si: top(stat('damage_as_si')), damage_as_si_pm: top(perMatch(stat('damage_as_si'))),
      quad_caps: top(stat('quad_caps')),
      dps: top(stat('dps_landed')),
      win_streak: top((id) => longestRuns((byPlayer.get(id) ?? []).map(won)).win),
      endorsed: top(endorseTotal),
      weekly: top((id) => weeklyBy.get(id)?.length ?? 0),
      match_skeets: top((id) => matchSkeets.get(id)?.value ?? 0),
    };

    const duoRows: { a: string; b: string; games: number; wins: number }[] = [];
    for (const [a, p] of pairs) {
      if (banned.has(a)) continue;
      for (const [b, x] of p.with) if (a < b && !banned.has(b)) duoRows.push({ a: nameOf(a), b: nameOf(b), games: x.games, wins: x.wins });
    }
    const duos = {
      best: duoRows.filter((d) => d.games >= COMMUNITY_DUO_MIN).sort((x, y) => y.wins / y.games - x.wins / x.games || y.games - x.games).slice(0, 3),
      common: [...duoRows].sort((x, y) => y.games - x.games || y.wins - x.wins).slice(0, 3),
    };

    // Moments. Only full 4v4 rosters count for the records, so an
    // opening-day test or a 9-player late join does not hold one.
    const full = pm.filter((m) => (byMatch.get(m.id)?.length ?? 0) === 8);
    const score = (m: PmRow) => ({ matchId: m.id, campaign: m.campaign, a: m.a, b: m.b });
    const margin = (m: PmRow) => Math.abs(m.a - m.b);
    const closest = [...full].sort((x, y) => margin(x) - margin(y) || x.id - y.id).slice(0, 3).map(score);
    const blowout = [...full].sort((x, y) => margin(y) - margin(x) || x.id - y.id)[0];
    const fourMap = full.filter((m) => (mapsByMatch.get(m.id)?.length ?? 0) === 4).sort((x, y) => y.hours - x.hours)[0];
    const bestHalf = [...rounds].filter((r) => full.some((m) => m.id === r.match_id)).sort((x, y) => y.score - x.score)[0];

    const endorsers = new Set(endorse.map((e) => e.from_id));
    const receivers = new Set(endorse.map((e) => e.to_id));
    const tiers = { full: 0, short: 0, dropin: 0 };
    for (const id of byPlayer.keys()) tiers[wrappedTier(gamesOf(id), fullMin)]++;

    return {
      v: 1,
      season: { id: season!.id, name: season!.name, startedAt: season!.started_at, endedAt: season!.ended_at },
      overview: {
        matches: pm.length, matchHours: round1(matchHours), playerHours: Math.round(playerHours),
        avgMinutes: Math.round(ratio(matchHours * 60, pm.length)), players: byPlayer.size,
        maps: mapRows.length, halves: (db.prepare(`SELECT COUNT(*) AS n FROM match_rounds WHERE match_id IN (${ids})`).get() as { n: number }).n,
        first: pm[0]?.started_at ?? null, last: pm.length ? pm[pm.length - 1].ended_at : null,
      },
      weeks: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, matches]) => ({ week, matches })),
      busiestNight: busiest ? { date: busiest[0], matches: busiest[1] } : null,
      hours: hoursHist,
      campaigns: [...camps].map(([campaign, c]) => ({ campaign, matches: c.matches, hours: Math.round(c.hours) })).sort((a, b) => b.matches - a.matches),
      deadliestMap: survList[0] ?? null,
      kindestMap: survList.length > 1 ? survList[survList.length - 1] : null,
      totals,
      survival: { measured, survived: lived },
      top10, finalMinGames: rules.finalMinGames, peakSr, leaders, duos,
      moments: {
        closest, blowout: blowout ? score(blowout) : null,
        longest: fourMap ? { matchId: fourMap.id, campaign: fourMap.campaign, minutes: Math.round(fourMap.hours * 60) } : null,
        bestHalf: bestHalf ? { matchId: bestHalf.match_id, map: mapName.get(`${bestHalf.match_id}:${bestHalf.ordinal}`) ?? '', score: bestHalf.score } : null,
        bestSingleMap: communityMapBest,
        skeetTriples: triples.reduce((s, t) => s + t.n, 0),
      },
      endorsements: { given: endorse.length, givers: endorsers.size, receivers: receivers.size, startedAt: firstEndorse },
      buckets: tiers,
    };
  }
}

// ---- The frozen store ----------------------------------------------------

/** The community deck's row in season_wrapped. */
const COMMUNITY = '';

/** Compute a season's Wrapped and store it, replacing an earlier freeze of
 *  the same season. Returns how many player decks were written. */
export function freezeSeasonWrapped(db: DB, seasonId: number, now = new Date()): number {
  const { community, players } = computeWrapped(db, seasonId, now);
  db.transaction(() => {
    db.prepare('DELETE FROM season_wrapped WHERE season_id = ?').run(seasonId);
    const ins = db.prepare("INSERT INTO season_wrapped (season_id, player_id, data, frozen_at) VALUES (?, ?, ?, datetime('now'))");
    ins.run(seasonId, COMMUNITY, JSON.stringify(community));
    for (const p of players) ins.run(seasonId, p.steamid, JSON.stringify(p));
  })();
  return players.length;
}

/** Seasons with a frozen Wrapped, newest first. */
export function wrappedSeasons(db: DB): { id: number; name: string; frozenAt: string }[] {
  return db.prepare(
    `SELECT w.season_id AS id, s.name, w.frozen_at AS frozenAt FROM season_wrapped w JOIN seasons s ON s.id = w.season_id
     WHERE w.player_id = ? ORDER BY w.season_id DESC`,
  ).all(COMMUNITY) as { id: number; name: string; frozenAt: string }[];
}

export function frozenCommunity(db: DB, seasonId: number): WrappedCommunity | null {
  const row = db.prepare('SELECT data FROM season_wrapped WHERE season_id = ? AND player_id = ?').get(seasonId, COMMUNITY) as { data: string } | undefined;
  return row ? JSON.parse(row.data) as WrappedCommunity : null;
}

/** One player's frozen deck. Null for nobody-by-that-id, for the community
 *  row's key, and for anyone banned now (a ban after the freeze still takes
 *  their deck down). */
export function frozenPlayer(db: DB, seasonId: number, steamid: string, now = new Date()): WrappedPlayer | null {
  if (!steamid) return null;
  const row = db.prepare(
    `SELECT data FROM season_wrapped WHERE season_id = ? AND player_id = ? AND ${notBannedSql('player_id')}`,
  ).get(seasonId, steamid, now.toISOString()) as { data: string } | undefined;
  return row ? JSON.parse(row.data) as WrappedPlayer : null;
}
