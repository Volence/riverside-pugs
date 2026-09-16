import type { DB } from './db.js';
import { mapStatsFor } from './liveView.js';
import { campaignForMap } from './campaigns.js';
import { unrecordedOrdinals } from './roundStats.js';

/** Which of a match's maps have a real score. Same rule as the match page's
 *  `recorded` flag (roundStats.ts). An unrecorded map still counts as played
 *  and keeps its stats, since those are captured independently of the score,
 *  but it decides no win or loss and joins no average: a stored 0 to 0 that
 *  was never a result would otherwise become a win for the other side.
 *  Memoised per match because every function here walks maps match by match. */
function recordedFor(db: DB): (matchId: number, ordinal: number) => boolean {
  const cache = new Map<number, Set<number>>();
  return (matchId, ordinal) => {
    let set = cache.get(matchId);
    if (!set) { set = unrecordedOrdinals(db, matchId); cache.set(matchId, set); }
    return !set.has(ordinal);
  };
}

/** The rounded mean of the recorded scores, or null when none was recorded.
 *  Null, not 0: a page must say "not recorded" rather than show an average
 *  that never happened. */
function avgOrNull(sum: number, n: number): number | null {
  return n === 0 ? null : Math.round(sum / n);
}

/** Per-map-played means for a bag of summed stats.
 *
 *  One divisor for every key, which is correct here and worth stating because
 *  it looks too simple. Every stat in statKeys.ts declares a side, and a side's
 *  stats can only accrue while its owner is playing that side (the argument
 *  roundStats.ts rests on). A versus map is two halves with the teams
 *  swapping, so a player who played a map held survivor for exactly one half
 *  and infected for exactly one. Dividing tank damage by maps played is
 *  therefore already "per infected half", and no per-side divisor is needed.
 *
 *  A key that was never measured stays absent rather than becoming a zero
 *  average: absent means nobody recorded it, zero would claim the player did
 *  it badly. */
function perMapAverages(stats: Record<string, number>, games: number): Record<string, number> {
  if (games === 0) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) out[k] = Math.round((v / games) * 10) / 10;
  return out;
}

/** Whether a player rostered at `joinedMap` was present for `ordinal`.
 *
 *  A sub rostered on map 3 did not play maps 1 and 2, and crediting them
 *  anyway is invisible in a total (their contribution really is zero) but
 *  wrong in an average, which then divides by maps they never saw. Same
 *  column rating.ts consults through ratedForMaps, for the same reason. */
function playedMap(joinedMap: number, ordinal: number): boolean {
  return ordinal >= joinedMap;
}

export interface RoundAggregate {
  /** Closed, reliable halves of this map. Two per playing when both were
   *  recorded, since each half is an independent survivor attempt. */
  attempts: number;
  fastestSec: number | null;
  avgSec: number | null;
  slowestSec: number | null;
  /** Percentage of MEASURED attempts the survivors lived through, or null
   *  when none was measured. Null rather than 0: survivors_alive is NULL for
   *  every round played before the plugin emitted it, and treating those as
   *  wipes would report the whole back catalogue as lethal. */
  survivalPct: number | null;
}

const NO_ROUNDS: RoundAggregate = {
  attempts: 0, fastestSec: null, avgSec: null, slowestSec: null, survivalPct: null,
};

/**
 * Timing and survival for every reliable, closed half of the given maps.
 *
 * One query for all maps rather than one per map, because the campaign index
 * asks for twenty-odd of them at once.
 *
 * `reliable = 1` is the same gate the scores already use: a half the plugin
 * could not attribute is not an observation. `ended_at IS NOT NULL` excludes a
 * round still open, which would otherwise register as a zero-second record and
 * take the "fastest" column permanently.
 *
 * Survival and timing are counted independently. A round can have a trustworthy
 * clock and no survival reading (an older plugin), and dropping it from the
 * timing stats too would throw away data we have for the sake of data we do not.
 */
function roundAggregates(db: DB, maps: string[]): Map<string, RoundAggregate> {
  const out = new Map<string, RoundAggregate>();
  if (maps.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT mm.map AS map,
              (julianday(r.ended_at) - julianday(r.started_at)) * 86400 AS secs,
              r.survivors_alive AS alive
       FROM match_rounds r
       JOIN match_maps mm ON mm.match_id = r.match_id AND mm.ordinal = r.ordinal
       JOIN matches m ON m.id = r.match_id
       WHERE m.state = 'completed'
         AND r.reliable = 1
         AND r.ended_at IS NOT NULL
         AND r.started_at IS NOT NULL
         AND mm.map IN (${maps.map(() => '?').join(',')})`,
    )
    .all(...maps) as { map: string; secs: number | null; alive: number | null }[];

  const acc = new Map<string, { secs: number[]; measured: number; survived: number }>();
  for (const r of rows) {
    let a = acc.get(r.map);
    if (!a) { a = { secs: [], measured: 0, survived: 0 }; acc.set(r.map, a); }
    if (r.secs !== null && r.secs >= 0) a.secs.push(r.secs);
    if (r.alive !== null) {
      a.measured++;
      // > 0, not >= 1 by accident: a versus round ends when the survivors
      // either wipe or reach the checkpoint, so anyone still standing means
      // they got there.
      if (r.alive > 0) a.survived++;
    }
  }

  for (const [map, a] of acc) {
    out.set(map, {
      attempts: a.secs.length,
      fastestSec: a.secs.length ? Math.round(Math.min(...a.secs)) : null,
      slowestSec: a.secs.length ? Math.round(Math.max(...a.secs)) : null,
      avgSec: a.secs.length ? Math.round(a.secs.reduce((x, y) => x + y, 0) / a.secs.length) : null,
      survivalPct: a.measured === 0 ? null : Math.round((a.survived / a.measured) * 100),
    });
  }
  return out;
}

export interface MapBreakdownRow {
  map: string;
  games: number;
  wins: number;
  losses: number;
  /** Summed across every playing of this map. Keys absent entirely when never
   *  measured, so the page can distinguish "never happened" from zero. */
  stats: Record<string, number>;
  /** The same keys divided by `games`, to one decimal. What a player usually
   *  gets here, which is the comparable number: a total just says who has
   *  played the most. */
  avgStats: Record<string, number>;
}

/**
 * How a player performs on each individual map, across every completed match.
 *
 * Built from the end-of-map snapshots the live pipeline records, because the
 * authoritative dump only carries match totals: there is no per-map row for a
 * player anywhere else. Matches played before that capture existed contribute
 * their win/loss but no stats, which is why `stats` can be empty while `games`
 * is not.
 *
 * Aggregated by map NAME rather than by ordinal, so "how do I do on Dead Air 2"
 * answers across every time it has been played, whatever position it held in
 * the campaign.
 */
export function playerMapBreakdown(db: DB, steamid: string): MapBreakdownRow[] {
  const played = db
    .prepare(
      `SELECT m.id, mp.team, mp.joined_map AS joinedMap FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ? AND m.state = 'completed'`,
    )
    .all(steamid) as { id: number; team: 'a' | 'b'; joinedMap: number }[];
  if (played.length === 0) return [];

  const mapsOf = db.prepare(
    `SELECT ordinal, map, team_a_score AS a, team_b_score AS b
     FROM match_maps WHERE match_id = ? ORDER BY ordinal`,
  );

  const recorded = recordedFor(db);
  const acc = new Map<string, MapBreakdownRow>();
  for (const { id, team, joinedMap } of played) {
    const maps = mapsOf.all(id) as { ordinal: number; map: string; a: number; b: number }[];
    const byOrdinal = mapStatsFor(db, id);

    for (const mp of maps) {
      // A sub did not play the maps that happened before they were rostered.
      if (!playedMap(joinedMap, mp.ordinal)) continue;
      let row = acc.get(mp.map);
      if (!row) {
        row = { map: mp.map, games: 0, wins: 0, losses: 0, stats: {}, avgStats: {} };
        acc.set(mp.map, row);
      }
      row.games++;
      // A drawn map counts as neither, and so does an unrecorded one. Scores
      // are per map, so a player can win maps inside a match they lost
      // overall, which is the point of this view.
      if (recorded(id, mp.ordinal)) {
        const mine = team === 'a' ? mp.a : mp.b;
        const theirs = team === 'a' ? mp.b : mp.a;
        if (mine > theirs) row.wins++;
        else if (theirs > mine) row.losses++;
      }

      for (const [k, v] of Object.entries(byOrdinal.get(mp.ordinal)?.[steamid] ?? {})) {
        // hp is a level: summing "health at end of map" across maps would be
        // meaningless, so it is left out of the aggregate entirely.
        if (k === 'hp') continue;
        row.stats[k] = (row.stats[k] ?? 0) + v;
      }
    }
  }

  for (const row of acc.values()) row.avgStats = perMapAverages(row.stats, row.games);
  return [...acc.values()].sort((x, y) => y.games - x.games || x.map.localeCompare(y.map));
}

export interface MapLeaderRow {
  steamid: string;
  name: string;
  games: number;
  wins: number;
  losses: number;
  stats: Record<string, number>;
  /** Per map played, to one decimal. See perMapAverages. */
  avgStats: Record<string, number>;
}

export interface MapDetail {
  map: string;
  played: number;
  /**
   * The average score a team puts up on this map, over RECORDED playings
   * only, null when there are none.
   *
   * One number, not the avgTeamA/avgTeamB pair this replaced. `team_a_score`
   * for a map is that team's score WHILE THEY HELD SURVIVOR, and both teams
   * hold survivor once per map, so A and B are two samples of the same
   * quantity. Reporting them separately split the sample in half and invited
   * a comparison between labels that balanceTeams assigns arbitrarily, which
   * carried no information about the map at all. Combined, it is a real
   * difficulty measure: what a team typically scores here.
   */
  avgScore: number | null;
  /** What anyone usually does on this map: every player's stats pooled and
   *  divided by the total number of player-maps. The map's own baseline, as
   *  opposed to any one player's line in `players`. */
  avgStats: Record<string, number>;
  /** How long a round here takes and how often survivors live through it. */
  rounds: RoundAggregate;
  players: MapLeaderRow[];
}

/**
 * Everyone's record on one map, across every completed match.
 *
 * The counterpart to playerMapBreakdown: that answers "how do I do on each
 * map", this answers "who does well on this map". Same snapshot-difference
 * source, so the two can never disagree.
 *
 * Returns null for a map nobody has played, so the route can 404 rather than
 * render an empty page for a typo'd name.
 */
export function mapDetail(db: DB, map: string): MapDetail | null {
  const rows = db
    .prepare(
      `SELECT mm.match_id, mm.ordinal, mm.team_a_score AS a, mm.team_b_score AS b
       FROM match_maps mm JOIN matches m ON m.id = mm.match_id
       WHERE mm.map = ? AND m.state = 'completed'
       ORDER BY mm.match_id`,
    )
    .all(map) as { match_id: number; ordinal: number; a: number; b: number }[];
  if (rows.length === 0) return null;

  const teamOf = db.prepare(
    'SELECT player_id, team, joined_map AS joinedMap FROM match_players WHERE match_id = ?',
  );
  const nameOf = db.prepare('SELECT name FROM players WHERE steamid = ?');

  const recorded = recordedFor(db);
  const acc = new Map<string, MapLeaderRow>();
  let sumA = 0;
  let sumB = 0;
  let recordedCount = 0;

  for (const r of rows) {
    const isRecorded = recorded(r.match_id, r.ordinal);
    if (isRecorded) {
      sumA += r.a;
      sumB += r.b;
      recordedCount++;
    }
    const byOrdinal = mapStatsFor(db, r.match_id);
    const stats = byOrdinal.get(r.ordinal) ?? {};

    for (const p of teamOf.all(r.match_id) as
         { player_id: string; team: 'a' | 'b'; joinedMap: number }[]) {
      // A sub rostered later in the match was not on this map at all.
      if (!playedMap(p.joinedMap, r.ordinal)) continue;
      let row = acc.get(p.player_id);
      if (!row) {
        const n = nameOf.get(p.player_id) as { name: string } | undefined;
        row = {
          steamid: p.player_id, name: n?.name ?? p.player_id,
          games: 0, wins: 0, losses: 0, stats: {}, avgStats: {},
        };
        acc.set(p.player_id, row);
      }
      row.games++;
      if (isRecorded) {
        const mine = p.team === 'a' ? r.a : r.b;
        const theirs = p.team === 'a' ? r.b : r.a;
        if (mine > theirs) row.wins++;
        else if (theirs > mine) row.losses++;
      }

      for (const [k, v] of Object.entries(stats[p.player_id] ?? {})) {
        if (k === 'hp') continue;
        row.stats[k] = (row.stats[k] ?? 0) + v;
      }
    }
  }

  // Pooled across every player-map, which is what makes it the map's baseline
  // rather than an average of averages weighted by who turned up most.
  const pooled: Record<string, number> = {};
  let playerMaps = 0;
  for (const row of acc.values()) {
    row.avgStats = perMapAverages(row.stats, row.games);
    playerMaps += row.games;
    for (const [k, v] of Object.entries(row.stats)) pooled[k] = (pooled[k] ?? 0) + v;
  }

  return {
    map,
    played: rows.length,
    // Divided by 2 * recorded playings: each playing contributes two survivor
    // scores, one per team, and both are samples of the same quantity.
    avgScore: avgOrNull(sumA + sumB, recordedCount * 2),
    avgStats: perMapAverages(pooled, playerMaps),
    rounds: roundAggregates(db, [map]).get(map) ?? NO_ROUNDS,
    players: [...acc.values()].sort((x, y) => y.wins - x.wins || y.games - x.games),
  };
}

export interface MapIndexRow {
  map: string;
  campaign: string | null;
  played: number;
  /** Average score a team puts up here, over RECORDED playings only. See
   *  MapDetail.avgScore for why this is one number and not a per-team pair. */
  avgScore: number | null;
  /** How long a round here takes and how often survivors live through it. */
  rounds: RoundAggregate;
}

/**
 * Every map that has actually been played, newest-campaign-grouped by the
 * caller. Exists because map pages were previously reachable only by clicking
 * a map name buried in a match or a profile: there was no index and nothing in
 * the nav, so nobody would ever find them.
 *
 * Only maps with a completed match appear. A map nobody has played has no page
 * worth linking to.
 */
export function mapIndex(db: DB): MapIndexRow[] {
  // Aggregated here rather than in SQL so the recorded rule is the one
  // function in roundStats.ts and not a second copy of it in a query.
  const rows = db
    .prepare(
      `SELECT mm.match_id, mm.ordinal, mm.map, mm.team_a_score AS a, mm.team_b_score AS b
       FROM match_maps mm JOIN matches m ON m.id = mm.match_id
       WHERE m.state = 'completed'
       ORDER BY mm.map`,
    )
    .all() as { match_id: number; ordinal: number; map: string; a: number; b: number }[];

  const recorded = recordedFor(db);
  const acc = new Map<string, { played: number; n: number; sumA: number; sumB: number }>();
  for (const r of rows) {
    let row = acc.get(r.map);
    if (!row) { row = { played: 0, n: 0, sumA: 0, sumB: 0 }; acc.set(r.map, row); }
    row.played++;
    if (recorded(r.match_id, r.ordinal)) { row.n++; row.sumA += r.a; row.sumB += r.b; }
  }

  const rounds = roundAggregates(db, [...acc.keys()]);
  return [...acc.entries()].map(([map, r]) => ({
    map, campaign: campaignForMap(map), played: r.played,
    avgScore: avgOrNull(r.sumA + r.sumB, r.n * 2),
    rounds: rounds.get(map) ?? NO_ROUNDS,
  }));
}
