import type { DB } from './db.js';

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
            (SELECT COUNT(*) FROM matches m WHERE m.season_id = s.id AND m.state = 'completed') AS matches
     FROM seasons s ORDER BY s.id DESC`,
  ).all() as { id: number; name: string; started_at: string; ended_at: string | null; matches: number }[])
    .map((s) => ({ id: s.id, name: s.name, startedAt: s.started_at, endedAt: s.ended_at, current: s.ended_at === null, matches: s.matches }));
}

export function renameSeason(db: DB, id: number, name: string): boolean {
  return db.prepare('UPDATE seasons SET name = ? WHERE id = ?').run(name, id).changes > 0;
}

export type NewSeasonResult = { ok: true; id: number } | { ok: false; error: string };

/**
 * End the current season and open a new one.
 *
 * Ratings are per season, so everyone starts the new one at the default
 * rating with no record; the old season's ladder, matches and history stay as
 * they were and remain viewable. Refused while a match is being set up or
 * played, so no match straddles the change.
 */
export function startNewSeason(db: DB, name: string): NewSeasonResult {
  const open = db.prepare("SELECT COUNT(*) AS n FROM matches WHERE state IN ('configuring', 'live')").get() as { n: number };
  if (open.n > 0) return { ok: false, error: 'a match is being set up or played; start the season once it is over' };
  const id = db.transaction(() => {
    db.prepare("UPDATE seasons SET ended_at = datetime('now') WHERE ended_at IS NULL").run();
    return Number(db.prepare('INSERT INTO seasons (name) VALUES (?)').run(name).lastInsertRowid);
  })();
  return { ok: true, id };
}
