import type { DB } from './db.js';
import { mapStatsFor } from './liveView.js';
import { campaignForMap } from './campaigns.js';

export interface MapBreakdownRow {
  map: string;
  games: number;
  wins: number;
  losses: number;
  /** Summed across every playing of this map. Keys absent entirely when never
   *  measured, so the page can distinguish "never happened" from zero. */
  stats: Record<string, number>;
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
      `SELECT m.id, mp.team FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ? AND m.state = 'completed'`,
    )
    .all(steamid) as { id: number; team: 'a' | 'b' }[];
  if (played.length === 0) return [];

  const mapsOf = db.prepare(
    `SELECT ordinal, map, team_a_score AS a, team_b_score AS b
     FROM match_maps WHERE match_id = ? ORDER BY ordinal`,
  );

  const acc = new Map<string, MapBreakdownRow>();
  for (const { id, team } of played) {
    const maps = mapsOf.all(id) as { ordinal: number; map: string; a: number; b: number }[];
    const byOrdinal = mapStatsFor(db, id);

    for (const mp of maps) {
      let row = acc.get(mp.map);
      if (!row) {
        row = { map: mp.map, games: 0, wins: 0, losses: 0, stats: {} };
        acc.set(mp.map, row);
      }
      row.games++;
      // A drawn map counts as neither. Scores are per map, so a player can win
      // maps inside a match they lost overall, which is the point of this view.
      const mine = team === 'a' ? mp.a : mp.b;
      const theirs = team === 'a' ? mp.b : mp.a;
      if (mine > theirs) row.wins++;
      else if (theirs > mine) row.losses++;

      for (const [k, v] of Object.entries(byOrdinal.get(mp.ordinal)?.[steamid] ?? {})) {
        // hp is a level: summing "health at end of map" across maps would be
        // meaningless, so it is left out of the aggregate entirely.
        if (k === 'hp') continue;
        row.stats[k] = (row.stats[k] ?? 0) + v;
      }
    }
  }

  return [...acc.values()].sort((x, y) => y.games - x.games || x.map.localeCompare(y.map));
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
  avgTeamA: number;
  avgTeamB: number;
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

  const teamOf = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?');
  const nameOf = db.prepare('SELECT name FROM players WHERE steamid = ?');

  const acc = new Map<string, MapLeaderRow>();
  let sumA = 0;
  let sumB = 0;

  for (const r of rows) {
    sumA += r.a;
    sumB += r.b;
    const byOrdinal = mapStatsFor(db, r.match_id);
    const stats = byOrdinal.get(r.ordinal) ?? {};

    for (const p of teamOf.all(r.match_id) as { player_id: string; team: 'a' | 'b' }[]) {
      let row = acc.get(p.player_id);
      if (!row) {
        const n = nameOf.get(p.player_id) as { name: string } | undefined;
        row = {
          steamid: p.player_id, name: n?.name ?? p.player_id,
          games: 0, wins: 0, losses: 0, stats: {},
        };
        acc.set(p.player_id, row);
      }
      row.games++;
      const mine = p.team === 'a' ? r.a : r.b;
      const theirs = p.team === 'a' ? r.b : r.a;
      if (mine > theirs) row.wins++;
      else if (theirs > mine) row.losses++;

      for (const [k, v] of Object.entries(stats[p.player_id] ?? {})) {
        if (k === 'hp') continue;
        row.stats[k] = (row.stats[k] ?? 0) + v;
      }
    }
  }

  return {
    map,
    played: rows.length,
    avgTeamA: Math.round(sumA / rows.length),
    avgTeamB: Math.round(sumB / rows.length),
    players: [...acc.values()].sort((x, y) => y.wins - x.wins || y.games - x.games),
  };
}

export interface MapIndexRow {
  map: string;
  campaign: string | null;
  played: number;
  avgTeamA: number;
  avgTeamB: number;
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
  const rows = db
    .prepare(
      `SELECT mm.map,
              COUNT(*) AS played,
              CAST(ROUND(AVG(mm.team_a_score)) AS INTEGER) AS avgTeamA,
              CAST(ROUND(AVG(mm.team_b_score)) AS INTEGER) AS avgTeamB
       FROM match_maps mm JOIN matches m ON m.id = mm.match_id
       WHERE m.state = 'completed'
       GROUP BY mm.map
       ORDER BY mm.map`,
    )
    .all() as { map: string; played: number; avgTeamA: number; avgTeamB: number }[];

  return rows.map((r) => ({ ...r, campaign: campaignForMap(r.map) }));
}
