import type { DB } from '../db.js';
import { displaySr } from '../rating.js';
import { currentSeasonId, getPlayer } from '../players.js';
import { activeTimeout, penaltyHistory, recentOffenses } from '../penalties.js';
import { listReports } from '../reports.js';

export interface BanRow {
  id: number;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  liftedBy: string | null;
  liftedAt: string | null;
  createdByName?: string | null;
  liftedByName?: string | null;
}

const toBan = (r: {
  id: number; reason: string; created_by: string; created_at: string; expires_at: string | null;
  lifted_by: string | null; lifted_at: string | null; created_by_name?: string | null; lifted_by_name?: string | null;
}): BanRow => ({
  id: r.id, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at,
  liftedBy: r.lifted_by, liftedAt: r.lifted_at, createdByName: r.created_by_name ?? null, liftedByName: r.lifted_by_name ?? null,
});

const BAN_SELECT = `SELECT b.*, pc.name AS created_by_name, pl.name AS lifted_by_name FROM bans b
  LEFT JOIN players pc ON pc.steamid = b.created_by LEFT JOIN players pl ON pl.steamid = b.lifted_by`;

export function activeBan(db: DB, steamid: string, now = new Date()): BanRow | null {
  const r = db.prepare(
    `${BAN_SELECT} WHERE b.player_id = ? AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > ?)
     ORDER BY b.id DESC LIMIT 1`,
  ).get(steamid, now.toISOString()) as Parameters<typeof toBan>[0] | undefined;
  return r ? toBan(r) : null;
}

export function banPlayer(
  db: DB, steamid: string, by: string, reason: string, minutes: number | null, now = new Date(),
): void {
  const expires = minutes ? new Date(now.getTime() + minutes * 60 * 1000).toISOString() : null;
  db.transaction(() => {
    db.prepare('INSERT INTO bans (player_id, reason, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(steamid, reason, by, now.toISOString(), expires);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(steamid);
  })();
}

/** Lift every open ban and restore the player to active. */
export function unbanPlayer(db: DB, steamid: string, by: string, now = new Date()): void {
  db.transaction(() => {
    db.prepare('UPDATE bans SET lifted_by = ?, lifted_at = ? WHERE player_id = ? AND lifted_at IS NULL')
      .run(by, now.toISOString(), steamid);
    db.prepare("UPDATE players SET status = 'active' WHERE steamid = ? AND status = 'banned'").run(steamid);
  })();
}

/** Runs on the 60 s reaper. A banned player whose every ban has run out goes
 *  back to active; one still under another open ban stays banned. */
export function liftExpiredBans(db: DB, now = new Date()): string[] {
  const iso = now.toISOString();
  const expired = db.prepare(
    'SELECT DISTINCT player_id FROM bans WHERE lifted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?',
  ).all(iso) as { player_id: string }[];
  const lifted: string[] = [];
  for (const { player_id } of expired) {
    db.prepare("UPDATE bans SET lifted_by = 'system', lifted_at = ? WHERE player_id = ? AND lifted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?")
      .run(iso, player_id, iso);
    if (!activeBan(db, player_id, now)) {
      db.prepare("UPDATE players SET status = 'active' WHERE steamid = ? AND status = 'banned'").run(player_id);
      lifted.push(player_id);
    }
  }
  return lifted;
}

/** What a banned player is told (Discord uses <t:> timestamps). */
export function banMessage(db: DB, steamid: string): string {
  const ban = activeBan(db, steamid);
  if (!ban) return 'You are banned from the PUG.';
  const until = ban.expiresAt ? ` It ends <t:${Math.floor(Date.parse(ban.expiresAt) / 1000)}:R>.` : '';
  return `You are banned from the PUG: ${ban.reason}.${until}`;
}

export interface AdminPlayerRow {
  steamid: string;
  name: string;
  avatar: string | null;
  status: string;
  isAdmin: boolean;
  discordName: string | null;
  sr: number | null;
  games: number;
  createdAt: string;
  /** Uncleared no-show / ready-check offenses in the penalty window. */
  offenses: number;
}

export function searchPlayers(db: DB, q: string, limit = 200): AdminPlayerRow[] {
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const season = currentSeasonId(db);
  const rows = db.prepare(
    `SELECT p.steamid, p.name, p.avatar, p.status, p.is_admin, p.discord_name, p.created_at, pr.mu, pr.sigma,
            (SELECT COUNT(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id
              WHERE mp.player_id = p.steamid AND m.state = 'completed') AS games
     FROM players p LEFT JOIN player_ratings pr ON pr.player_id = p.steamid AND pr.season_id = ?
     WHERE ? = '' OR p.name LIKE ? ESCAPE '\\' OR p.steamid LIKE ? ESCAPE '\\' OR p.discord_name LIKE ? ESCAPE '\\'
     ORDER BY p.name COLLATE NOCASE LIMIT ?`,
  ).all(season, q, like, like, like, limit) as {
    steamid: string; name: string; avatar: string | null; status: string; is_admin: number; discord_name: string | null;
    created_at: string; mu: number | null; sigma: number | null; games: number;
  }[];
  return rows.map((r) => ({
    steamid: r.steamid, name: r.name, avatar: r.avatar, status: r.status, isAdmin: r.is_admin === 1,
    discordName: r.discord_name, sr: r.mu === null ? null : displaySr(r.mu, r.sigma!), games: r.games, createdAt: r.created_at,
    offenses: recentOffenses(db, r.steamid),
  }));
}

export function playerDetail(db: DB, steamid: string) {
  const p = getPlayer(db, steamid);
  if (!p) return null;
  const [row] = searchPlayers(db, steamid, 1).filter((x) => x.steamid === steamid);
  const bans = (db.prepare(`${BAN_SELECT} WHERE b.player_id = ? ORDER BY b.id DESC`).all(steamid) as Parameters<typeof toBan>[0][]).map(toBan);
  const notes = (db.prepare(
    `SELECT n.id, n.author_id, a.name AS author_name, n.text, n.created_at FROM player_notes n
     LEFT JOIN players a ON a.steamid = n.author_id WHERE n.player_id = ? ORDER BY n.id DESC`,
  ).all(steamid) as { id: number; author_id: string; author_name: string | null; text: string; created_at: string }[])
    .map((n) => ({ id: n.id, authorId: n.author_id, authorName: n.author_name, text: n.text, createdAt: n.created_at }));
  const matches = db.prepare(
    `SELECT m.id, m.campaign, m.state, m.ended_at AS endedAt, m.winner, mp.team, mp.connected_at AS connectedAt
     FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.player_id = ? ORDER BY m.id DESC LIMIT 20`,
  ).all(steamid);
  return {
    ...(row ?? {}),
    steamid: p.steamid,
    discordId: p.discord_id,
    activeBan: activeBan(db, steamid),
    bans,
    notes,
    matches,
    penalties: penaltyHistory(db, steamid),
    reportsAgainst: listReports(db, 'all').filter((r) => r.targetId === steamid),
    timeout: (() => {
      const t = activeTimeout(db, steamid);
      return t ? { until: t.until.toISOString(), offenses: t.offenses } : null;
    })(),
  };
}

export function addNote(db: DB, steamid: string, authorId: string, text: string): void {
  db.prepare('INSERT INTO player_notes (player_id, author_id, text, created_at) VALUES (?, ?, ?, ?)')
    .run(steamid, authorId, text, new Date().toISOString());
}
