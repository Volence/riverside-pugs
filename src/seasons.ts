import type { DB } from './db.js';
import { completedPug } from './matchKinds.js';
import {
  NEW_SEASON_RULES, rankIndexOf, rankView, seasonLadder, seasonRules, softResetRating, srUnder,
} from './seasonRules.js';

export interface SeasonRow {
  id: number;
  name: string;
  startedAt: string;
  endedAt: string | null;
  current: boolean;
  matches: number;
}

/** Newest first. The current season is the one with no end. */
export function listSeasons(db: DB): SeasonRow[] {
  return (db.prepare(
    `SELECT s.id, s.name, s.started_at, s.ended_at,
            (SELECT COUNT(*) FROM matches m WHERE m.season_id = s.id AND ${completedPug('m')}) AS matches
     FROM seasons s ORDER BY s.id DESC`,
  ).all() as { id: number; name: string; started_at: string; ended_at: string | null; matches: number }[])
    .map((s) => ({ id: s.id, name: s.name, startedAt: s.started_at, endedAt: s.ended_at, current: s.ended_at === null, matches: s.matches }));
}

export function renameSeason(db: DB, id: number, name: string): boolean {
  return db.prepare('UPDATE seasons SET name = ? WHERE id = ?').run(name, id).changes > 0;
}

export type NewSeasonResult = { ok: true; id: number } | { ok: false; error: string };

/**
 * End the current season and open a new one (owner rulings 2026-10-19).
 *
 * In one transaction:
 *  1. The closing season's final standings are frozen into season_results
 *     (freezeSeasonResults), so nothing done later can reorder them.
 *  2. The new season opens under NEW_SEASON_RULES.
 *  3. Everyone who played a rated game in the closing season starts the new
 *     one from a soft reset of their rating (softResetRating), recorded in
 *     season_seeds so a recompute replays from the same start. Their record
 *     starts at 0-0 and they place again; anyone else gets openskill's
 *     defaults when they first play, as before.
 *
 * The old season's ladder, matches and history stay as they were and remain
 * viewable. Refused while a match is being set up or played, so no match
 * straddles the change.
 */
export function startNewSeason(db: DB, name: string, now = new Date()): NewSeasonResult {
  const open = db.prepare("SELECT COUNT(*) AS n FROM matches WHERE state IN ('configuring', 'live')").get() as { n: number };
  if (open.n > 0) return { ok: false, error: 'a match is being set up or played; start the season once it is over' };
  const id = db.transaction(() => {
    const closing = currentSeasonIdOrNull(db);
    const seeds = closing === null ? [] : seasonResetPreview(db, now).rows;
    if (closing !== null) freezeSeasonResults(db, closing, now);
    db.prepare("UPDATE seasons SET ended_at = datetime('now') WHERE ended_at IS NULL").run();
    const r = NEW_SEASON_RULES;
    const newId = Number(db.prepare(
      'INSERT INTO seasons (name, sr_sigma_k, placement_games, ranks, final_min_games) VALUES (?, ?, ?, ?, ?)',
    ).run(name, r.srSigmaK, r.placementGames, r.ranks ? 1 : 0, r.finalMinGames).lastInsertRowid);
    const seed = db.prepare('INSERT INTO season_seeds (season_id, player_id, mu, sigma) VALUES (?, ?, ?, ?)');
    const rate = db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, ?, ?)');
    for (const p of seeds) {
      seed.run(newId, p.steamid, p.newMu, p.newSigma);
      rate.run(p.steamid, newId, p.newMu, p.newSigma);
    }
    return newId;
  })();
  return { ok: true, id };
}

function currentSeasonIdOrNull(db: DB): number | null {
  const row = db.prepare('SELECT id FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
  return row?.id ?? null;
}

export interface FinalStanding {
  steamid: string;
  sr: number;
  peakSr: number;
  wins: number;
  losses: number;
  games: number;
  /** Place in the final standings; null under the season's minimum games,
   *  still placing, or banned when the season closed. */
  finalRank: number | null;
  /** The rank badge held at the end, null in a season without ranks. */
  rankIdx: number | null;
  /** False when they never finished placement: sr and peakSr were never
   *  shown, and nothing that reads the freeze may show them. */
  placed: boolean;
}

/** A season's final standings as they stand right now: the ladder, with a
 *  final place for every eligible player (placed, at least the season's
 *  minimum games, not banned), best SR first. */
export function finalStandings(db: DB, seasonId: number, now = new Date()): FinalStanding[] {
  const ladder = seasonLadder(db, seasonId);
  const rules = seasonRules(db, seasonId);
  const banned = new Set((db.prepare(
    'SELECT DISTINCT player_id FROM bans WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
  ).all(now.toISOString()) as { player_id: string }[]).map((r) => r.player_id));
  const rows = [...ladder.values()].filter((e) => e.games > 0)
    .sort((a, b) => b.sr - a.sr || b.games - a.games || a.steamid.localeCompare(b.steamid));
  let place = 0;
  return rows.map((e) => {
    const eligible = e.placed && e.games >= rules.finalMinGames && !banned.has(e.steamid);
    return {
      steamid: e.steamid, sr: e.sr, peakSr: e.peakSr ?? e.sr, wins: e.wins, losses: e.losses, games: e.games,
      finalRank: eligible ? ++place : null, rankIdx: e.rankIdx, placed: e.placed,
    };
  });
}

/** Write a season's final standings into season_results, replacing any
 *  earlier freeze of the same season. */
export function freezeSeasonResults(db: DB, seasonId: number, now = new Date()): number {
  const rows = finalStandings(db, seasonId, now);
  db.transaction(() => {
    db.prepare('DELETE FROM season_results WHERE season_id = ?').run(seasonId);
    const ins = db.prepare(
      `INSERT INTO season_results (season_id, player_id, sr, peak_sr, wins, losses, games, final_rank, rank_idx, placed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) ins.run(seasonId, r.steamid, r.sr, r.peakSr, r.wins, r.losses, r.games, r.finalRank, r.rankIdx, r.placed ? 1 : 0);
  })();
  return rows.length;
}

export interface ResetPreviewRow {
  steamid: string;
  name: string;
  games: number;
  /** Where they stand now, under the current season's rules. */
  oldSr: number;
  finalRank: number | null;
  newMu: number;
  newSigma: number;
  /** What their SR would read under the new rules on day one. Hidden from
   *  them until they place; staff see it here. */
  startSr: number;
  startRank: string;
}

/**
 * What startNewSeason would do to everyone, without doing it: each player
 * with a rated game this season, their standing now, and the rating, SR and
 * rank they would start the next season from. The admin Seasons page shows it
 * before anyone presses the button, and startNewSeason seeds from the very
 * same rows.
 */
export function seasonResetPreview(db: DB, now = new Date()): { seasonId: number | null; rows: ResetPreviewRow[] } {
  const seasonId = currentSeasonIdOrNull(db);
  if (seasonId === null) return { seasonId, rows: [] };
  const names = new Map((db.prepare('SELECT steamid, name FROM players').all() as { steamid: string; name: string }[])
    .map((p) => [p.steamid, p.name]));
  const ladder = seasonLadder(db, seasonId);
  const ranks = new Map(finalStandings(db, seasonId, now).map((r) => [r.steamid, r.finalRank]));
  // Someone who sat this season out still has the seed it gave them; they
  // carry it on (softened once more) rather than drop to the defaults.
  const seeded = new Set((db.prepare('SELECT player_id FROM season_seeds WHERE season_id = ?').all(seasonId) as { player_id: string }[])
    .map((r) => r.player_id));
  const rows = [...ladder.values()].filter((e) => e.games > 0 || seeded.has(e.steamid)).map((e) => {
    const next = softResetRating(e);
    const startSr = srUnder(NEW_SEASON_RULES, next.mu, next.sigma);
    return {
      steamid: e.steamid, name: names.get(e.steamid) ?? e.steamid, games: e.games,
      oldSr: e.sr, finalRank: ranks.get(e.steamid) ?? null,
      newMu: next.mu, newSigma: next.sigma, startSr, startRank: rankView(rankIndexOf(startSr)).name,
    };
  }).sort((a, b) => b.oldSr - a.oldSr);
  return { seasonId, rows };
}

export interface PastSeason {
  seasonId: number;
  name: string;
  /** Null when they never finished that season's placement. */
  sr: number | null;
  peakSr: number | null;
  placed: boolean;
  wins: number;
  losses: number;
  games: number;
  finalRank: number | null;
  /** How many players held a final place, for "#3 of 61". */
  of: number;
  rank: string | null;
  /** In the Top 10 of the final standings. */
  top10: boolean;
}

/** A player's frozen results in every finished season, newest first. */
export function playerPastSeasons(db: DB, steamid: string): PastSeason[] {
  return (db.prepare(
    `SELECT r.season_id, s.name, r.sr, r.peak_sr, r.wins, r.losses, r.games, r.final_rank, r.rank_idx, r.placed,
            (SELECT COUNT(*) FROM season_results x WHERE x.season_id = r.season_id AND x.final_rank IS NOT NULL) AS of
     FROM season_results r JOIN seasons s ON s.id = r.season_id
     WHERE r.player_id = ? ORDER BY r.season_id DESC`,
  ).all(steamid) as { season_id: number; name: string; sr: number; peak_sr: number; wins: number; losses: number; games: number; final_rank: number | null; rank_idx: number | null; placed: number; of: number }[])
    .map((r) => ({
      seasonId: r.season_id, name: r.name,
      sr: r.placed ? r.sr : null, peakSr: r.placed ? r.peak_sr : null, placed: r.placed === 1,
      wins: r.wins, losses: r.losses, games: r.games,
      finalRank: r.final_rank, of: r.of, rank: r.rank_idx === null ? null : rankView(r.rank_idx).name,
      top10: r.final_rank !== null && r.final_rank <= 10,
    }));
}
