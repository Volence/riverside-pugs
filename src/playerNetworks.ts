import { createHmac, randomBytes } from 'node:crypto';
import type { DB } from './db.js';
import { getSetting, setSetting } from './settings.js';

/**
 * Which accounts have been seen connecting from the same place.
 *
 * Built for one job: noticing that two Steam accounts are one person, before
 * that costs a season recompute. Match 65 (2026-09-20) only came to light
 * because somebody happened to count five names on a Discord card; the two
 * accounts had been playing from the same connection for four matches.
 *
 * The address itself is never stored. What goes in the table is an HMAC of it
 * under a salt generated once for this installation, plus a two-letter country
 * code. That is enough to answer "same connection?" and "roughly where?" and
 * nothing else: the rows cannot be turned back into addresses, and a hash
 * copied out of this database matches nothing in any other install.
 *
 * It is evidence, never a verdict. A VPN, a shared house, a LAN cafe and two
 * siblings all look identical here, so nothing acts on this automatically. It
 * shows up on the admin page next to the merge tool and a person decides.
 */

export interface PlayerNetwork {
  ipHash: string;
  country: string | null;
  firstSeen: string;
  lastSeen: string;
  seenCount: number;
}

export interface SharedAccount {
  steamid: string;
  name: string;
  country: string | null;
  /** Sightings of the OTHER account on the shared address. */
  seenCount: number;
  lastSeen: string;
}

/**
 * Addresses that identify nobody.
 *
 * Loopback is every listen server and anyone testing on the box. The private
 * ranges are a LAN, where correlating would report a whole household, or a
 * whole internet cafe, as one person. Both are worse than no data: they
 * manufacture confident false matches.
 */
function usable(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 127 || a === 0 || a === 10) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

/**
 * The salt, generated once and kept in settings.
 *
 * In the database rather than the environment on purpose: it has to outlive
 * a changed .env, because rotating it silently breaks every correlation
 * already recorded without anything appearing to go wrong.
 */
function salt(db: DB): string {
  const existing = getSetting(db, 'ip_hash_salt');
  if (existing) return existing;
  const fresh = randomBytes(32).toString('hex');
  setSetting(db, 'ip_hash_salt', fresh);
  return fresh;
}

export function hashIp(db: DB, ip: string): string {
  return createHmac('sha256', salt(db)).update(ip).digest('hex');
}

/** Record one sighting. Repeats bump a counter rather than adding rows. */
export function recordPlayerNet(
  db: DB, ev: { steamid: string; ip: string; country: string | null }, now = new Date(),
): void {
  if (!usable(ev.ip)) return;
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO player_networks (player_id, ip_hash, country, first_seen, last_seen, seen_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(player_id, ip_hash) DO UPDATE SET
       last_seen  = excluded.last_seen,
       seen_count = player_networks.seen_count + 1,
       -- A later lookup wins only when it actually resolved. A country that
       -- was read once should not be erased by a sighting that could not
       -- read one.
       country    = COALESCE(excluded.country, player_networks.country)`,
  ).run(ev.steamid, hashIp(db, ev.ip), ev.country, at, at);
}

export function networksOf(db: DB, steamid: string): PlayerNetwork[] {
  return db.prepare(
    `SELECT ip_hash AS ipHash, country, first_seen AS firstSeen, last_seen AS lastSeen,
            seen_count AS seenCount
       FROM player_networks WHERE player_id = ? ORDER BY last_seen DESC`,
  ).all(steamid) as PlayerNetwork[];
}

/** Other accounts seen on any address this one has used. */
export function sharesAddressWith(db: DB, steamid: string): SharedAccount[] {
  return db.prepare(
    `SELECT n.player_id AS steamid, COALESCE(p.name, n.player_id) AS name,
            n.country, n.seen_count AS seenCount, n.last_seen AS lastSeen
       FROM player_networks n
       LEFT JOIN players p ON p.steamid = n.player_id
      WHERE n.player_id <> ?
        AND n.ip_hash IN (SELECT ip_hash FROM player_networks WHERE player_id = ?)
      ORDER BY n.seen_count DESC, n.last_seen DESC`,
  ).all(steamid, steamid) as SharedAccount[];
}
