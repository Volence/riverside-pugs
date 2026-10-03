import type { DB } from './db.js';
import { resolveAlias } from './aliases.js';
import { publishBanChange } from './banEvents.js';
import { insertBan, restoreStatus } from './admin/players.js';
import { hasActiveBan } from './banState.js';
import { getPlayer } from './players.js';
import { canOpenFile, type FileViewer } from './admin/fileAccess.js';

/**
 * Alt holds: the account a Discord moves to is held until staff look.
 *
 * The Discord account is what ties a person to one Steam account, so a
 * Discord arriving from another Steam account is the plainest sign of an alt
 * the site has. Owner ruling 2026-10-03, after one player cycled one Discord
 * through three Steam accounts to get round bans: hold the new account at
 * once and let a moderator lift it when the player explains (a lost account,
 * a move to a new one).
 *
 * A hold is a bans row with kind 'alt_hold', so it blocks everything a ban
 * blocks (queue, ready, roster, the game servers, the Discord gate) with no
 * second set of checks to keep in step. What differs: the public ban list
 * leaves it out, and the player is told their account is on hold rather
 * than banned.
 */

export const HOLD_REASON_PREFIX = 'On hold for review: this Discord account was linked to another Steam account';

export interface AltHoldRow {
  id: number;
  steamid: string;
  name: string;
  otherSteamid: string;
  otherName: string;
  /** The other account is banned right now, which is what makes a hold urgent. */
  otherBanned: boolean;
  discordId: string;
  discordName: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolution: 'cleared' | 'banned' | 'merged' | null;
}

/** The Steam account this Discord was on just before `steamid`, when that
 *  was a different account (and not one merged into it). Any time, not a
 *  window: a Discord parked for two months before moving is still a second
 *  account. Only the link just before counts, so relinking the same Discord
 *  later is not news a second time. */
export function previousSteamOf(db: DB, discordId: string, steamid: string): string | null {
  const r = db.prepare(
    'SELECT steamid FROM discord_link_history WHERE discord_id = ? AND unlinked_at IS NOT NULL ORDER BY id DESC LIMIT 1',
  ).get(discordId) as { steamid: string } | undefined;
  if (!r || resolveAlias(db, r.steamid) === resolveAlias(db, steamid)) return null;
  return r.steamid;
}

/** The Discord this Steam account held just before `discordId`, when that
 *  was a different one. */
export function previousDiscordOf(db: DB, steamid: string, discordId: string): { id: string; name: string } | null {
  const r = db.prepare(
    'SELECT discord_id, discord_name FROM discord_link_history WHERE steamid = ? AND unlinked_at IS NOT NULL ORDER BY id DESC LIMIT 1',
  ).get(steamid) as { discord_id: string; discord_name: string } | undefined;
  return r && r.discord_id !== discordId ? { id: r.discord_id, name: r.discord_name } : null;
}

/**
 * Hold `steamid` because `discordId` came to it from `otherSteamid`.
 *
 * Returns the hold id, or null when nothing was placed: staff already
 * cleared this pair, a hold is already open on the account, or the account
 * is staff (a moderator could not open the file to lift it, and staff alts
 * are an owner conversation, not a queue lock).
 */
export function placeAltHold(
  db: DB, steamid: string, otherSteamid: string, discordId: string, discordName: string, now = new Date(),
): number | null {
  const cleared = db.prepare(
    "SELECT 1 FROM alt_holds WHERE steamid = ? AND other_steamid = ? AND resolution = 'cleared'",
  ).get(steamid, otherSteamid);
  if (cleared) return null;
  if (openHoldOf(db, steamid)) return null;
  const p = getPlayer(db, steamid);
  if (!p || p.is_admin === 1 || p.is_mod === 1) return null;
  const other = getPlayer(db, otherSteamid);
  const reason = `${HOLD_REASON_PREFIX} (${other?.name ?? otherSteamid}). A moderator will review it`;
  let id = 0;
  db.transaction(() => {
    const banId = insertBan(db, steamid, 'system', reason, null, now, 'alt_hold');
    id = Number(db.prepare(
      `INSERT INTO alt_holds (steamid, other_steamid, discord_id, discord_name, ban_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(steamid, otherSteamid, discordId, discordName, banId, now.toISOString()).lastInsertRowid);
  })();
  // After the commit: a subscriber dials RCON.
  publishBanChange({ kind: 'ban', steamid, reason });
  return id;
}

export function openHoldOf(db: DB, steamid: string): { id: number; banId: number } | null {
  const r = db.prepare(
    'SELECT id, ban_id FROM alt_holds WHERE steamid = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1',
  ).get(steamid) as { id: number; ban_id: number } | undefined;
  return r ? { id: r.id, banId: r.ban_id } : null;
}

export function holdById(db: DB, id: number): { id: number; steamid: string; otherSteamid: string; banId: number; resolvedAt: string | null } | null {
  const r = db.prepare('SELECT id, steamid, other_steamid, ban_id, resolved_at FROM alt_holds WHERE id = ?').get(id) as
    | { id: number; steamid: string; other_steamid: string; ban_id: number; resolved_at: string | null } | undefined;
  return r ? { id: r.id, steamid: r.steamid, otherSteamid: r.other_steamid, banId: r.ban_id, resolvedAt: r.resolved_at } : null;
}

/** Close the hold and lift its bans row, inside the caller's transaction.
 *  Never touches another ban: an account held AND banned for something else
 *  stays banned. Returns whether the account is now free. */
function closeHold(db: DB, holdId: number, by: string, resolution: 'cleared' | 'banned' | 'merged', now: Date): boolean {
  const h = holdById(db, holdId);
  if (!h || h.resolvedAt) return false;
  const iso = now.toISOString();
  db.prepare('UPDATE alt_holds SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?').run(iso, by, resolution, holdId);
  db.prepare('UPDATE bans SET lifted_by = ?, lifted_at = ? WHERE id = ? AND lifted_at IS NULL').run(by, iso, h.banId);
  if (hasActiveBan(db, h.steamid, now)) return false;
  restoreStatus(db, h.steamid);
  return true;
}

/** "Not an alt", or "an alt we are fine with": the account plays again and
 *  this pair is never held again. */
export function liftAltHold(db: DB, holdId: number, by: string, now = new Date()): boolean {
  const h = holdById(db, holdId);
  if (!h || h.resolvedAt) return false;
  let freed = false;
  db.transaction(() => { freed = closeHold(db, holdId, by, 'cleared', now); })();
  if (freed) publishBanChange({ kind: 'unban', steamid: h.steamid });
  return true;
}

/** Turn a hold into an ordinary ban, which the public list shows. */
export function banFromHold(db: DB, holdId: number, by: string, reason: string, now = new Date()): boolean {
  const h = holdById(db, holdId);
  if (!h || h.resolvedAt) return false;
  db.transaction(() => {
    insertBan(db, h.steamid, by, reason, null, now);
    closeHold(db, holdId, by, 'banned', now);
  })();
  publishBanChange({ kind: 'ban', steamid: h.steamid, reason });
  return true;
}

/**
 * Run inside a merge's transaction, before bans move: a hold between the two
 * accounts being merged is answered by the merge itself. Without this the
 * alt's hold would follow its bans onto the survivor and lock the main out.
 * Returns the steamids that came free, for the caller to publish after its
 * commit.
 */
export function closeHoldsForMerge(db: DB, from: string, into: string, by: string, now = new Date()): string[] {
  const rows = db.prepare(
    `SELECT id, steamid FROM alt_holds WHERE resolved_at IS NULL
       AND (steamid = ? OR (steamid = ? AND other_steamid = ?))`,
  ).all(from, into, from) as { id: number; steamid: string }[];
  const freed: string[] = [];
  for (const r of rows) if (closeHold(db, r.id, by, 'merged', now) && r.steamid === into) freed.push(into);
  return freed;
}

const HOLD_SELECT = `SELECT h.*, p.name AS name, o.name AS other_name, r.name AS resolved_by_name
  FROM alt_holds h
  LEFT JOIN players p ON p.steamid = h.steamid
  LEFT JOIN players o ON o.steamid = h.other_steamid
  LEFT JOIN players r ON r.steamid = h.resolved_by`;

interface HoldDbRow {
  id: number; steamid: string; other_steamid: string; discord_id: string; discord_name: string;
  created_at: string; resolved_at: string | null; resolved_by: string | null; resolution: AltHoldRow['resolution'];
  name: string | null; other_name: string | null; resolved_by_name: string | null;
}

function toHold(db: DB, r: HoldDbRow, now: Date): AltHoldRow {
  return {
    id: r.id, steamid: r.steamid, name: r.name ?? r.steamid,
    otherSteamid: r.other_steamid, otherName: r.other_name ?? r.other_steamid,
    otherBanned: hasActiveBan(db, r.other_steamid, now),
    discordId: r.discord_id, discordName: r.discord_name,
    createdAt: r.created_at, resolvedAt: r.resolved_at,
    resolvedByName: r.resolved_by === 'system' ? 'system' : r.resolved_by_name, resolution: r.resolution,
  };
}

/** Open holds first, then the last 50 settled ones. A moderator sees only
 *  holds where both files are open to them. */
export function altHolds(db: DB, viewer: FileViewer, now = new Date()): { open: AltHoldRow[]; settled: AltHoldRow[] } {
  const visible = (r: HoldDbRow) => canOpenFile(db, viewer, r.steamid) && canOpenFile(db, viewer, r.other_steamid);
  const open = (db.prepare(`${HOLD_SELECT} WHERE h.resolved_at IS NULL ORDER BY h.id DESC`).all() as HoldDbRow[])
    .filter(visible).map((r) => toHold(db, r, now));
  const settled = (db.prepare(`${HOLD_SELECT} WHERE h.resolved_at IS NOT NULL ORDER BY h.resolved_at DESC LIMIT 50`).all() as HoldDbRow[])
    .filter(visible).map((r) => toHold(db, r, now));
  return { open, settled };
}

/** Holds naming this account on either side, newest first, for the file. */
export function holdsAbout(db: DB, steamid: string, now = new Date()): AltHoldRow[] {
  return (db.prepare(`${HOLD_SELECT} WHERE h.steamid = ? OR h.other_steamid = ? ORDER BY h.id DESC`)
    .all(steamid, steamid) as HoldDbRow[]).map((r) => toHold(db, r, now));
}

// ---------------------------------------------------------------------------
// Related accounts: every account tied to another by something the site has
// seen, grouped, so nobody has to know which file to open first.

export type AltSignal = 'discord' | 'merged' | 'lender' | 'connection';

export interface AltEdge { a: string; b: string; signal: AltSignal; detail: string; at: string | null }

export interface AltCluster {
  members: { steamid: string; name: string; banned: boolean; held: boolean; lastSeen: string | null }[];
  edges: AltEdge[];
  /** The newest thing that tied two of these accounts together. */
  latest: string | null;
  hasOpenHold: boolean;
  /** Joined by something stronger than a shared connection. */
  strong: boolean;
}

function edgesOf(db: DB): AltEdge[] {
  const out: AltEdge[] = [];
  // A Discord held by two Steam accounts, one edge per consecutive pair.
  const links = db.prepare(
    'SELECT discord_id, discord_name, steamid, linked_at FROM discord_link_history ORDER BY discord_id, id',
  ).all() as { discord_id: string; discord_name: string; steamid: string; linked_at: string }[];
  for (let i = 1; i < links.length; i++) {
    const prev = links[i - 1], cur = links[i];
    if (prev.discord_id !== cur.discord_id || prev.steamid === cur.steamid) continue;
    out.push({ a: prev.steamid, b: cur.steamid, signal: 'discord', detail: `Discord ${cur.discord_name || cur.discord_id} moved`, at: cur.linked_at });
  }
  for (const r of db.prepare('SELECT steamid, canonical_id, created_at FROM player_aliases').all() as
    { steamid: string; canonical_id: string; created_at: string }[]) {
    out.push({ a: r.steamid, b: r.canonical_id, signal: 'merged', detail: 'merged', at: r.created_at });
  }
  for (const r of db.prepare(
    `SELECT s.steamid, s.lender_id, s.lender_seen_at FROM player_steam_signals s
      JOIN players p ON p.steamid = s.lender_id WHERE s.lender_id IS NOT NULL AND s.lender_id != s.steamid`,
  ).all() as { steamid: string; lender_id: string; lender_seen_at: string | null }[]) {
    out.push({ a: r.steamid, b: r.lender_id, signal: 'lender', detail: 'plays on a copy lent by Family Sharing', at: r.lender_seen_at });
  }
  // Same connection: one edge per pair of accounts per shared address.
  const nets = db.prepare(
    `SELECT a.player_id AS a, b.player_id AS b, MAX(MIN(a.last_seen, b.last_seen)) AS at, COUNT(*) AS n
       FROM player_networks a JOIN player_networks b ON a.ip_hash = b.ip_hash AND a.player_id < b.player_id
      GROUP BY a.player_id, b.player_id`,
  ).all() as { a: string; b: string; at: string | null; n: number }[];
  for (const r of nets) {
    out.push({ a: r.a, b: r.b, signal: 'connection', detail: r.n === 1 ? 'same connection' : `same connection (${r.n} addresses)`, at: r.at });
  }
  return out;
}

/**
 * Every group of two or more accounts tied together, newest first, open holds
 * on top. A moderator is given a group only if every file in it is open to
 * them: leaving one member out would point straight at the staff account.
 */
export function altClusters(db: DB, viewer: FileViewer, now = new Date()): AltCluster[] {
  const edges = edgesOf(db);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const e of edges) {
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, AltEdge[]>();
  for (const e of edges) {
    const root = find(e.a);
    groups.set(root, [...(groups.get(root) ?? []), e]);
  }
  const held = new Set((db.prepare('SELECT steamid FROM alt_holds WHERE resolved_at IS NULL').all() as { steamid: string }[]).map((r) => r.steamid));
  const lastSeen = db.prepare('SELECT MAX(last_seen) AS t FROM player_networks WHERE player_id = ?');
  const out: AltCluster[] = [];
  for (const group of groups.values()) {
    const ids = [...new Set(group.flatMap((e) => [e.a, e.b]))];
    if (!ids.every((id) => canOpenFile(db, viewer, id))) continue;
    const members = ids.map((steamid) => ({
      steamid,
      name: getPlayer(db, steamid)?.name ?? steamid,
      banned: hasActiveBan(db, steamid, now) && !held.has(steamid),
      held: held.has(steamid),
      lastSeen: (lastSeen.get(steamid) as { t: string | null }).t,
    }));
    const latest = group.map((e) => e.at).filter((t): t is string => !!t).sort().pop() ?? null;
    out.push({
      members, edges: group, latest,
      hasOpenHold: members.some((m) => m.held),
      strong: group.some((e) => e.signal !== 'connection'),
    });
  }
  return out.sort((x, y) =>
    Number(y.hasOpenHold) - Number(x.hasOpenHold) || (y.latest ?? '').localeCompare(x.latest ?? ''));
}
