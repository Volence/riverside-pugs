import { rating } from 'openskill';
import type { DB } from './db.js';

export interface PlayerRow {
  steamid: string;
  name: string;
  avatar: string | null;
  status: 'invited' | 'active' | 'banned';
  is_admin: number;
  created_at: string;
}

export interface RatingRow {
  player_id: string;
  season_id: number;
  mu: number;
  sigma: number;
  wins: number;
  losses: number;
}

export function upsertPlayer(
  db: DB,
  p: { steamid: string; name: string; avatar: string | null },
  adminSteamIds: string[],
): void {
  const isAdmin = adminSteamIds.includes(p.steamid);
  db.prepare(
    `INSERT INTO players (steamid, name, avatar, status, is_admin)
     VALUES (@steamid, @name, @avatar, @status, @is_admin)
     ON CONFLICT(steamid) DO UPDATE SET
       name = excluded.name,
       avatar = excluded.avatar,
       is_admin = MAX(players.is_admin, excluded.is_admin),
       status = CASE WHEN excluded.is_admin = 1 THEN 'active' ELSE players.status END`,
  ).run({
    steamid: p.steamid,
    name: p.name,
    avatar: p.avatar,
    status: isAdmin ? 'active' : 'invited',
    is_admin: isAdmin ? 1 : 0,
  });
}

export function getPlayer(db: DB, steamid: string): PlayerRow | undefined {
  return db.prepare('SELECT * FROM players WHERE steamid = ?').get(steamid) as PlayerRow | undefined;
}

export function activatePlayer(db: DB, steamid: string): void {
  db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(steamid);
}

export function currentSeasonId(db: DB): number {
  const row = db.prepare('SELECT id FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as { id: number };
  return row.id;
}

export function ensureRating(db: DB, steamid: string): RatingRow {
  const season = currentSeasonId(db);
  const existing = db
    .prepare('SELECT * FROM player_ratings WHERE player_id = ? AND season_id = ?')
    .get(steamid, season) as RatingRow | undefined;
  if (existing) return existing;
  const r = rating(); // openskill defaults: mu=25, sigma=25/3
  db.prepare(
    'INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, ?, ?)',
  ).run(steamid, season, r.mu, r.sigma);
  return { player_id: steamid, season_id: season, mu: r.mu, sigma: r.sigma, wins: 0, losses: 0 };
}

export function getRatings(db: DB, steamids: string[]): Map<string, RatingRow> {
  const out = new Map<string, RatingRow>();
  for (const id of steamids) out.set(id, ensureRating(db, id));
  return out;
}
