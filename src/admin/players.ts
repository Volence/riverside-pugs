import type { DB } from '../db.js';
import { aliasesOf } from '../aliases.js';
import { networksOf, sharesAddressWith } from '../playerNetworks.js';
import { displaySr } from '../rating.js';
import { currentSeasonId, discordHistoryOf, getPlayer } from '../players.js';
import { activeTimeout, penaltyHistory, recentOffenses } from '../penalties.js';
import { signonDropSummary } from '../signonDrops.js';
import { capsForPlayer, detectionsForPlayer } from '../inputBursts.js';
import { publishBanChange } from '../banEvents.js';
import { steamAccountView } from './steamAccount.js';
import { ticketsAbout } from '../tickets/views.js';

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

/** The state flip and the ban INSERT, with no transaction and no publish of
 *  its own. For a caller that already holds its own outer transaction: run
 *  this inside it, then call publishBanChange yourself once that outer
 *  transaction has committed. Publishing before the outer commit can tell a
 *  game server to hold a PERMANENT engine ban for a bans row that a later
 *  failure in the same transaction rolls back, and nothing in this codebase
 *  ever un-does a permanent engine ban that has no lifted_at row to justify
 *  an sm_unban. */
export function insertBan(
  db: DB, steamid: string, by: string, reason: string, minutes: number | null, now = new Date(),
): void {
  const expires = minutes ? new Date(now.getTime() + minutes * 60 * 1000).toISOString() : null;
  db.prepare('INSERT INTO bans (player_id, reason, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(steamid, reason, by, now.toISOString(), expires);
  // Remember what the ban is interrupting, so its end can put that back. A
  // second ban on an account that is already banned keeps the first memory:
  // what it interrupts is a ban, and "banned" is never what to restore to.
  //
  // session_epoch goes up in the same statement, which ends every session the
  // player holds (src/session.ts). They can sign straight back in, and will
  // then be shown the ban; what they cannot do is carry on in a tab that was
  // open when it landed.
  db.prepare(
    `UPDATE players SET
       status_before_ban = CASE WHEN status = 'banned' THEN status_before_ban ELSE status END,
       status = 'banned',
       session_epoch = session_epoch + 1
     WHERE steamid = ?`,
  ).run(steamid);
}

/**
 * Put a banned account back the way the ban found it.
 *
 * It used to go to `active` unconditionally. For an account that had never
 * been let in, that made a ban the way in: a one-day abandon ban from a match
 * started in game ended with the account past the invite code and past the
 * Discord gate, neither of which it had ever faced.
 *
 * A row banned before status_before_ban existed has nothing remembered, so
 * it is judged on the evidence: `active` only when something shows the
 * account was let in at some point, otherwise `invited`, which costs a
 * genuine player one trip through the gate they have already passed once.
 * What counts: a linked Discord, the admin flag, an admin having activated
 * the account by hand, a queue penalty, or a place on a match that was set
 * up by the site (went_live_at), since the queue only ever took active
 * players. A match started in game proves nothing: that path rosters whoever
 * is on the server.
 */
function restoreStatus(db: DB, steamid: string): void {
  const row = db.prepare('SELECT status, status_before_ban, discord_id, is_admin FROM players WHERE steamid = ?')
    .get(steamid) as
    | { status: string; status_before_ban: string | null; discord_id: string | null; is_admin: number } | undefined;
  if (!row || row.status !== 'banned') return;
  let to = row.status_before_ban;
  if (to !== 'active' && to !== 'invited') {
    const wasLetIn = row.discord_id !== null || row.is_admin === 1 || db.prepare(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM admin_actions WHERE action = 'activate' AND target = @id)
          OR EXISTS (SELECT 1 FROM penalties WHERE player_id = @id)
          OR EXISTS (SELECT 1 FROM match_players mp JOIN matches m ON m.id = mp.match_id
                     WHERE mp.player_id = @id AND m.went_live_at IS NOT NULL)`,
    ).get({ id: steamid }) !== undefined;
    to = wasLetIn ? 'active' : 'invited';
  }
  db.prepare('UPDATE players SET status = ?, status_before_ban = NULL WHERE steamid = ?').run(to, steamid);
}

export function banPlayer(
  db: DB, steamid: string, by: string, reason: string, minutes: number | null, now = new Date(),
): void {
  db.transaction(() => insertBan(db, steamid, by, reason, minutes, now))();
  // After the commit, never inside it: a subscriber may dial RCON.
  publishBanChange({ kind: 'ban', steamid, reason });
}

/** Lift every open ban and restore the player to what they were before it. */
export function unbanPlayer(db: DB, steamid: string, by: string, now = new Date()): void {
  db.transaction(() => {
    db.prepare('UPDATE bans SET lifted_by = ?, lifted_at = ? WHERE player_id = ? AND lifted_at IS NULL')
      .run(by, now.toISOString(), steamid);
    restoreStatus(db, steamid);
  })();
  publishBanChange({ kind: 'unban', steamid });
}

/** Runs on the 60 s reaper. A banned player whose every ban has run out goes
 *  back to what they were before it; one still under another open ban stays
 *  banned. */
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
      restoreStatus(db, player_id);
      lifted.push(player_id);
      publishBanChange({ kind: 'unban', steamid: player_id });
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
  isMod: boolean;
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
    `SELECT p.steamid, p.name, p.avatar, p.status, p.is_admin, p.is_mod, p.discord_name, p.created_at, pr.mu, pr.sigma,
            (SELECT COUNT(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id
              WHERE mp.player_id = p.steamid AND m.state = 'completed') AS games
     FROM players p LEFT JOIN player_ratings pr ON pr.player_id = p.steamid AND pr.season_id = ?
     WHERE ? = '' OR p.name LIKE ? ESCAPE '\\' OR p.steamid LIKE ? ESCAPE '\\' OR p.discord_name LIKE ? ESCAPE '\\'
     ORDER BY p.name COLLATE NOCASE LIMIT ?`,
  ).all(season, q, like, like, like, limit) as {
    steamid: string; name: string; avatar: string | null; status: string; is_admin: number; is_mod: number; discord_name: string | null;
    created_at: string; mu: number | null; sigma: number | null; games: number;
  }[];
  return rows.map((r) => ({
    steamid: r.steamid, name: r.name, avatar: r.avatar, status: r.status, isAdmin: r.is_admin === 1, isMod: r.is_mod === 1,
    discordName: r.discord_name, sr: r.mu === null ? null : displaySr(r.mu, r.sigma!), games: r.games, createdAt: r.created_at,
    offenses: recentOffenses(db, r.steamid),
  }));
}

export interface PlayerNoteRow {
  id: number;
  authorId: string;
  authorName: string | null;
  text: string;
  createdAt: string;
}

/** A player's own bans, newest first, unredacted: callers who must not show
 *  a restricted ticket's reason (the file, the panel ban list) redact at
 *  their own call site rather than here, since only they know their viewer. */
export function bansOf(db: DB, steamid: string): BanRow[] {
  return (db.prepare(`${BAN_SELECT} WHERE b.player_id = ? ORDER BY b.id DESC`).all(steamid) as Parameters<typeof toBan>[0][]).map(toBan);
}

export function notesOf(db: DB, steamid: string): PlayerNoteRow[] {
  return (db.prepare(
    `SELECT n.id, n.author_id, a.name AS author_name, n.text, n.created_at FROM player_notes n
     LEFT JOIN players a ON a.steamid = n.author_id WHERE n.player_id = ? ORDER BY n.id DESC`,
  ).all(steamid) as { id: number; author_id: string; author_name: string | null; text: string; created_at: string }[])
    .map((n) => ({ id: n.id, authorId: n.author_id, authorName: n.author_name, text: n.text, createdAt: n.created_at }));
}

export interface RecentMatchRow {
  id: number;
  campaign: string;
  state: string;
  endedAt: string | null;
  winner: string | null;
  team: string;
  connectedAt: string | null;
}

export function recentMatchesOf(db: DB, steamid: string, limit = 20): RecentMatchRow[] {
  return db.prepare(
    `SELECT m.id, m.campaign, m.state, m.ended_at AS endedAt, m.winner, mp.team, mp.connected_at AS connectedAt
     FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.player_id = ? ORDER BY m.id DESC LIMIT ?`,
  ).all(steamid, limit) as RecentMatchRow[];
}

export function playerDetail(db: DB, steamid: string, viewer: string = '') {
  const p = getPlayer(db, steamid);
  if (!p) return null;
  const [row] = searchPlayers(db, steamid, 1).filter((x) => x.steamid === steamid);
  return {
    ...(row ?? {}),
    steamid: p.steamid,
    discordId: p.discord_id,
    // Every Discord account this player has held, and who else has held each
    // one. One Discord passing between Steam accounts is the plainest sign of
    // an alt this site has.
    discordHistory: discordHistoryOf(db, steamid),
    activeBan: activeBan(db, steamid),
    bans: bansOf(db, steamid),
    notes: notesOf(db, steamid),
    matches: recentMatchesOf(db, steamid),
    penalties: penaltyHistory(db, steamid),
    // Tickets about this player that the viewing admin may see. A restricted
    // one is simply absent for an admin who is not on its list.
    tickets: ticketsAbout(db, steamid, viewer),
    // Connects that ended before the player was in game, on a map that forced
    // files: likely a consistency rejection, possibly a cancelled load.
    signonDrops: signonDropSummary(db, steamid),
    // Input signatures that fired on this player. Evidence from button timing,
    // to be read next to the replay, never a verdict on its own.
    inputFlags: detectionsForPlayer(db, steamid),
    // Rounds where the plugin stopped sending one kind of burst for this
    // player. A quiet panel beside one of these is not a clean round.
    inputCaps: capsForPlayer(db, steamid),
    // Second accounts folded into this one. Shown so an admin can see at a
    // glance that a player has been merged, and undo it.
    aliases: aliasesOf(db, steamid),
    // Where this account connects from, and any other account seen on the
    // same connection. Evidence for the merge tool above, never a verdict:
    // a VPN, a shared house and two siblings all look the same here.
    networks: networksOf(db, steamid),
    sharesAddressWith: sharesAddressWith(db, steamid),
    // What Steam says about the account: age, bans elsewhere, L4D1 hours,
    // whose copy of the game it plays on. Null until Steam has been asked,
    // and for good on an install with no api key. Context, never a verdict.
    steamAccount: steamAccountView(db, steamid),
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

export interface PublicBan {
  steamid: string;
  name: string;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
  /** No expiry: the ban does not end on its own. */
  permanent: boolean;
  /** Still in force right now. A lifted or expired ban stays on the list. */
  active: boolean;
  bannedByName: string | null;
  liftedByName: string | null;
  liftedAt: string | null;
}

/**
 * The ban list as anyone may read it, signed in or not.
 *
 * Public on purpose. A ban list nobody outside the admin team can see asks
 * players to take enforcement on trust, and the reason text is already shown
 * to the person banned, so publishing it tells them nothing new. What is NOT
 * here is everything else on a player's admin page: notes, reports, penalty
 * history, connect drops. Those were never shown to anyone and this route is
 * not a way to reach them.
 *
 * Lifted and expired bans stay listed. A record that quietly deletes its
 * mistakes is not a record, and "unbanned by, and when" is the part that
 * shows the process works.
 */
export function publicBans(db: DB, q = '', now = new Date()): PublicBan[] {
  const like = `%${q.trim().toLowerCase()}%`;
  const rows = db.prepare(
    `SELECT b.player_id AS steamid, p.name AS name, b.reason, b.created_at AS createdAt,
            b.expires_at AS expiresAt, b.lifted_at AS liftedAt,
            pc.name AS bannedByName, pl.name AS liftedByName
       FROM bans b
       LEFT JOIN players p  ON p.steamid  = b.player_id
       LEFT JOIN players pc ON pc.steamid = b.created_by
       LEFT JOIN players pl ON pl.steamid = b.lifted_by
      WHERE (? = '' OR b.player_id = ? OR LOWER(COALESCE(p.name, '')) LIKE ?)
      ORDER BY b.id DESC
      LIMIT 500`,
  ).all(q.trim(), q.trim(), like) as (Omit<PublicBan, 'permanent' | 'active'> & { name: string | null })[];

  return rows.map((r) => ({
    ...r,
    name: r.name ?? r.steamid,
    permanent: r.expiresAt === null,
    active: r.liftedAt === null && (r.expiresAt === null || Date.parse(r.expiresAt) > now.getTime()),
  }));
}
