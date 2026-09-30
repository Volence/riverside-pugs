import type { DB } from './db.js';
import { resolveAlias } from './aliases.js';
import { getSetting } from './settings.js';

/**
 * Name history: every name a player has played a match under, Steam persona
 * and in-game both, so staff can still tell who "v" was after the rename.
 *
 * A name counts only once it has been used in a match. People rename every
 * hour, and a log of every rename would be noise nobody reads; a name that
 * never reached a match never mattered to anyone else. The ledger is
 * player_name_uses (see the comment in src/db.ts): one row per name per
 * match, with every count derived from it.
 *
 * Every entry point resolves the SteamID through the alias table, so a
 * merged alt's names land on the main account whichever way they arrive.
 */

export type NameSource = 'steam' | 'ingame';

/** The daily digest's cadence. A day, because the point is a skim over
 *  coffee, not an alert: nobody needs to act on a rename within the hour. */
export const DIGEST_EVERY_MS = 24 * 60 * 60 * 1000;

/** How far before a match went live a player's last in-game name still
 *  speaks for them. Covers a player who connected during warmup and never
 *  renamed once the match was live, which is almost everybody. Twelve hours
 *  rather than minutes because a player can sit on a server through several
 *  matches without reconnecting. */
const LAST_NAME_WINDOW = '-12 hours';

/** And how far after. The fallback is for a name held from before the match,
 *  so a sighting well after it went live is somewhere else: a practice server
 *  while this match's result was still being retried, or the next match. Two
 *  minutes covers the clock skew between the live stamp and the connect lines
 *  of players loading into the first map. */
const LAST_NAME_GRACE = '+2 minutes';

/** Chain length in the digest. Somebody who has been through twenty names
 *  does not need all twenty in a Discord line; the latest few say who it is. */
const DIGEST_CHAIN_MAX = 6;

/** Characters that render as nothing. A "blank" name is usually one of these,
 *  and a real name padded with one is the same name. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

/** A clan tag at either end: [TAG] or |TAG|, eight characters or fewer inside.
 *  Only brackets and pipes, the two conventions seen on these servers; round
 *  brackets are left alone because "(S)" and "(1)" are handled on their own
 *  and a name like "(cat)" is more often the name itself. */
const LEADING_TAG = /^(?:\[[^\]]{1,8}\]|\|[^|]{1,8}\|)\s*/;
const TRAILING_TAG = /\s*(?:\[[^\]]{1,8}\]|\|[^|]{1,8}\|)$/;

/** When a timestamp becomes a row: SQLite's own datetime format, so rows
 *  written here compare correctly against datetime('now') and each other. */
export function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * A name as it should be shown (`display`) and the key two spellings of one
 * name share (`key`). Null for a name that is not a name at all.
 *
 * Normalised away, because none of them is a rename:
 *  - the engine's "(S)" spectator prefix and its "(1)" duplicate-name prefix;
 *  - invisible characters, and whitespace at the ends or doubled inside;
 *  - case, and compatibility forms (full-width letters and the like), in the
 *    key only;
 *  - one clan tag at the start or end, in the key only, and only when there
 *    is a name left without it: "[RS] v" and "v" are one name, "[RS]" alone
 *    is its own.
 */
export function normaliseName(raw: string): { display: string; key: string } | null {
  let s = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  // Repeated because the engine stacks them: a spectator who got a duplicate
  // name is "(S)(1)name".
  for (;;) {
    const next = s.replace(/^\((?:S|\d{1,2})\)\s*/, '');
    if (next === s) break;
    s = next;
  }
  if (!s) return null;
  let key = s.normalize('NFKC').toLowerCase();
  const untagged = key.replace(LEADING_TAG, '').replace(TRAILING_TAG, '').trim();
  if (untagged) key = untagged;
  return { display: s, key };
}

/**
 * An in-game name seen on a game server. Always kept as the player's latest,
 * and also recorded against `matchId` when the player is rostered in a live
 * match there; it counts only if that match completes (foldMatchNames).
 */
export function noteInGameName(
  db: DB, steamid: string, rawName: string, matchId: number | null, now = new Date(),
): void {
  const n = normaliseName(rawName);
  if (!n) return;
  const id = resolveAlias(db, steamid);
  const at = sqlTime(now);
  db.prepare(
    `INSERT INTO player_ingame_last (steamid, name, seen_at) VALUES (?, ?, ?)
     ON CONFLICT(steamid) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at`,
  ).run(id, n.display, at);
  if (matchId === null) return;
  db.prepare(
    'INSERT OR IGNORE INTO match_name_sightings (match_id, steamid, name, seen_at) VALUES (?, ?, ?, ?)',
  ).run(matchId, id, n.display, at);
}

export interface NameUse { source: NameSource; name: string }

/**
 * Record that `steamid` played the match `matchKey` under each of `uses`.
 * Idempotent: the same name in the same match is one row however often it
 * is recorded.
 *
 * With `queue`, a name this player has never used in a match before goes on
 * the digest, unless this is the player's first match on record: a new
 * player's first name is not a rename. Returns the keys that were new.
 */
export function recordNameUses(
  db: DB, steamid: string, matchKey: string, uses: NameUse[], at: string, opts: { queue: boolean },
): string[] {
  const id = resolveAlias(db, steamid);
  const hadHistory = db.prepare(
    'SELECT 1 FROM player_name_uses WHERE steamid = ? AND match_key != ? LIMIT 1',
  ).get(id, matchKey) !== undefined;
  const known = db.prepare('SELECT 1 FROM player_name_uses WHERE steamid = ? AND name_key = ? LIMIT 1');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO player_name_uses (steamid, name_key, source, match_key, name, seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const enqueue = db.prepare(
    `INSERT INTO player_name_digest (steamid, name_key, name, match_key, queued_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const fresh: string[] = [];
  for (const u of uses) {
    const n = normaliseName(u.name);
    if (!n) continue;
    const isNew = known.get(id, n.key) === undefined;
    insert.run(id, n.key, u.source, matchKey, n.display, at);
    if (!isNew) continue;
    fresh.push(n.key);
    if (opts.queue && hadHistory) enqueue.run(id, n.key, n.display, matchKey, at);
  }
  return fresh;
}

/**
 * Count the names of everyone rostered in a completed match: the in-game
 * names seen while it was live and the Steam persona each player has now.
 *
 * The persona is read at completion rather than at roster time, which only
 * differs for somebody who logged in to the site with a new persona during
 * their own match. A player with no avatar has never been looked up on Steam
 * (src/personaBackfill.ts), so their players.name is an in-game name off a
 * roster line and is not recorded as a persona.
 *
 * A roster row the server's own result does not list is skipped: a forged
 * MATCH_ROSTER line looks exactly like that (src/matchResult.ts), and its
 * name is whatever the forger typed.
 *
 * Called after the result commits and never allowed to throw into it: name
 * history is bookkeeping, and the match result is not.
 */
export function foldMatchNames(db: DB, matchId: number, now = new Date()): void {
  const match = db.prepare(
    'SELECT COALESCE(went_live_at, created_at) AS since FROM matches WHERE id = ?',
  ).get(matchId) as { since: string } | undefined;
  if (!match) return;
  const matchKey = `m:${matchId}`;
  const at = sqlTime(now);
  const queue = getSetting(db, 'admin_feed_renames') !== '0';
  const roster = db.prepare(
    `SELECT mp.player_id AS steamid, p.name, p.avatar FROM match_players mp
       JOIN players p ON p.steamid = mp.player_id
      WHERE mp.match_id = ? AND COALESCE(mp.unrated_reason, '') != 'not_in_dump'`,
  ).all(matchId) as { steamid: string; name: string; avatar: string | null }[];
  const sightings = db.prepare('SELECT name FROM match_name_sightings WHERE match_id = ? AND steamid = ?');
  const lastName = db.prepare(
    `SELECT name FROM player_ingame_last WHERE steamid = ?
        AND seen_at >= datetime(?, '${LAST_NAME_WINDOW}') AND seen_at <= datetime(?, '${LAST_NAME_GRACE}')`,
  );
  db.transaction(() => {
    for (const p of roster) {
      const uses: NameUse[] = (sightings.all(matchId, p.steamid) as { name: string }[])
        .map((s) => ({ source: 'ingame', name: s.name }));
      if (uses.length === 0) {
        const last = lastName.get(p.steamid, match.since, match.since) as { name: string } | undefined;
        if (last) uses.push({ source: 'ingame', name: last.name });
      }
      if (p.avatar !== null) uses.push({ source: 'steam', name: p.name });
      recordNameUses(db, p.steamid, matchKey, uses, at, { queue });
    }
    // This match's scratch, and any left behind by matches that were aborted
    // and so never folded.
    db.prepare(
      `DELETE FROM match_name_sightings WHERE match_id = ?
          OR match_id IN (SELECT id FROM matches WHERE state IN ('completed','aborted'))`,
    ).run(matchId);
  })();
}

export interface NameHistoryRow {
  name: string;
  key: string;
  matches: number;
  firstSeen: string;
  lastSeen: string;
  sources: NameSource[];
}

/** Every name a player has played under, most played first. `name` is the
 *  spelling used in the most matches, the latest one on a tie. */
export function nameHistory(db: DB, steamid: string): NameHistoryRow[] {
  const id = resolveAlias(db, steamid);
  const groups = db.prepare(
    `SELECT name_key AS key, COUNT(DISTINCT match_key) AS matches, MIN(seen_at) AS firstSeen,
            MAX(seen_at) AS lastSeen, GROUP_CONCAT(DISTINCT source) AS sources
       FROM player_name_uses WHERE steamid = ? GROUP BY name_key
      ORDER BY matches DESC, lastSeen DESC`,
  ).all(id) as { key: string; matches: number; firstSeen: string; lastSeen: string; sources: string }[];
  const variants = db.prepare(
    `SELECT name_key AS key, name FROM player_name_uses WHERE steamid = ?
      GROUP BY name_key, name ORDER BY COUNT(DISTINCT match_key) DESC, MAX(seen_at) DESC`,
  ).all(id) as { key: string; name: string }[];
  const display = new Map<string, string>();
  for (const v of variants) if (!display.has(v.key)) display.set(v.key, v.name);
  return groups.map((g) => ({
    name: display.get(g.key) ?? g.key,
    key: g.key,
    matches: g.matches,
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    sources: g.sources.split(',').sort() as NameSource[],
  }));
}

/**
 * The profile's "also known as": the most played names other than the one
 * the page is headed with. Once there are more than `limit` of them, names
 * used in a single match are dropped first: a one-night joke name is not
 * how anybody knows a player.
 */
export function alsoKnownAs(
  db: DB, steamid: string, currentName: string, limit = 3,
): { name: string; matches: number }[] {
  const current = normaliseName(currentName)?.key;
  let rows = nameHistory(db, steamid).filter((r) => r.key !== current);
  if (rows.length > limit) {
    const repeated = rows.filter((r) => r.matches > 1);
    if (repeated.length > 0) rows = repeated;
  }
  return rows.slice(0, limit).map((r) => ({ name: r.name, matches: r.matches }));
}

export interface RenameDigestEntry {
  steamid: string;
  /** Every name in the order first used, oldest first, trimmed to the latest
   *  few. */
  chain: string[];
  /** Names that were dropped off the front of the chain. */
  earlier: number;
}

/**
 * The digest, if one is due: at most once per DIGEST_EVERY_MS, only while the
 * setting is on, and only when something is queued. Marks what it returns as
 * posted, so the caller publishes it and a crash in between loses one digest
 * rather than posting it twice.
 */
export function takeRenameDigest(db: DB, now = new Date()): RenameDigestEntry[] | null {
  if (getSetting(db, 'admin_feed_renames') === '0') return null;
  const last = (db.prepare('SELECT MAX(posted_at) AS at FROM player_name_digest').get() as { at: string | null }).at;
  if (last !== null && now.getTime() - Date.parse(`${last.replace(' ', 'T')}Z`) < DIGEST_EVERY_MS) return null;
  const pending = db.prepare(
    `SELECT steamid FROM player_name_digest WHERE posted_at IS NULL
      GROUP BY steamid ORDER BY MIN(id)`,
  ).all() as { steamid: string }[];
  if (pending.length === 0) return null;
  const entries = pending.map(({ steamid }) => {
    const all = nameHistory(db, steamid)
      .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen) || a.lastSeen.localeCompare(b.lastSeen))
      .map((r) => r.name);
    const chain = all.slice(-DIGEST_CHAIN_MAX);
    return { steamid, chain, earlier: all.length - chain.length };
  });
  db.prepare('UPDATE player_name_digest SET posted_at = ? WHERE posted_at IS NULL').run(sqlTime(now));
  return entries;
}
