import type { DB } from '../db.js';
import { hasActiveBan } from '../banState.js';
import { getPlayer } from '../players.js';
import { membersOf, openPeople } from '../evaderPeople.js';
import { extraVpnAsns, isVpnNetwork } from '../networkKinds.js';
import { BASE_KINDS, BASE_WEAPONS, classLabel, medianHold, pooled } from '../fingerprint.js';
import { cachedPopulation, playerFingerprint } from '../fingerprintData.js';
import { canOpenFile, type FileViewer } from './fileAccess.js';

/**
 * People > Alts > Known evaders: one card per open person.
 *
 * A moderator is shown a person only when every Steam member's file is open
 * to them, as with related-account groups: leaving one member out would
 * point straight at a staff account. Connections are the members'
 * player_networks rows, shown by a hash prefix, country and provider, never
 * an address. The person's hold medians are read live from their members'
 * bursts; the population's come from the fingerprint cache only, so a page
 * view never rebuilds anything (they read "-" until the check has run).
 */

export interface KnownEvader {
  id: number; label: string; note: string; createdAt: string; createdByName: string | null;
  steam: { steamid: string; name: string; banned: boolean; held: boolean; lastSeen: string | null; how: string }[];
  discord: { id: string; how: string }[];
  connections: { ipHash: string; steamid: string; country: string | null; asOrg: string | null; vpn: boolean; lastSeen: string }[];
  medians: { cls: string; person: number | null; population: number | null }[];
  alerts: {
    steamid: string; name: string; level: 'alert' | 'loud' | 'hold'; distance: number; threshold: number; rank: number;
    signs: string[]; matchId: number | null; createdAt: string; banned: boolean;
  }[];
}

function signsOf(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function knownEvaders(db: DB, viewer: FileViewer, now = new Date()): KnownEvader[] {
  const extra = extraVpnAsns(db);
  const population = cachedPopulation(db);
  const held = new Set((db.prepare('SELECT steamid FROM alt_holds WHERE resolved_at IS NULL').all() as { steamid: string }[]).map((r) => r.steamid));
  const lastSeen = db.prepare('SELECT MAX(last_seen) AS t FROM player_networks WHERE player_id = ?');
  const out: KnownEvader[] = [];
  for (const p of openPeople(db)) {
    const members = membersOf(db, p.id);
    const steamIds = members.filter((m) => m.kind === 'steam').map((m) => m.ident);
    if (!steamIds.every((id) => canOpenFile(db, viewer, id))) continue;
    const nets = steamIds.length === 0 ? [] : db.prepare(
      `SELECT player_id, ip_hash, country, asn, as_org, last_seen FROM player_networks
        WHERE player_id IN (${steamIds.map(() => '?').join(', ')}) ORDER BY last_seen DESC LIMIT 30`,
    ).all(...steamIds) as { player_id: string; ip_hash: string; country: string | null; asn: number | null; as_org: string | null; last_seen: string }[];
    const fp = pooled(steamIds.map((id) => playerFingerprint(db, id)));
    const medians = BASE_KINDS.flatMap((kind) => BASE_WEAPONS.map((w) => `${kind}:${w}`))
      .map((cls) => ({ cls: classLabel(cls), person: medianHold(fp[cls]), population: medianHold(population[cls]) }))
      .filter((m) => m.person !== null || m.population !== null);
    const alerts = (db.prepare(
      `SELECT a.steamid, COALESCE(pl.name, a.steamid) AS name, a.level, a.distance, a.threshold, a.rank, a.signs_json,
              a.match_id, a.created_at
         FROM fingerprint_alerts a LEFT JOIN players pl ON pl.steamid = a.steamid
        WHERE a.person_id = ? ORDER BY a.created_at DESC LIMIT 20`,
    ).all(p.id) as { steamid: string; name: string; level: 'alert' | 'loud' | 'hold'; distance: number; threshold: number; rank: number; signs_json: string; match_id: number | null; created_at: string }[])
      .filter((a) => canOpenFile(db, viewer, a.steamid));
    out.push({
      id: p.id, label: p.label, note: p.note, createdAt: p.createdAt,
      createdByName: p.createdBy === 'system' ? 'system' : getPlayer(db, p.createdBy)?.name ?? null,
      steam: members.filter((m) => m.kind === 'steam').map((m) => ({
        steamid: m.ident, name: getPlayer(db, m.ident)?.name ?? m.ident, how: m.how,
        banned: hasActiveBan(db, m.ident, now) && !held.has(m.ident), held: held.has(m.ident),
        lastSeen: (lastSeen.get(m.ident) as { t: string | null }).t,
      })),
      discord: members.filter((m) => m.kind === 'discord').map((m) => ({ id: m.ident, how: m.how })),
      connections: nets.map((n) => ({
        ipHash: n.ip_hash, steamid: n.player_id, country: n.country, asOrg: n.as_org,
        vpn: isVpnNetwork(n.asn, n.as_org, extra), lastSeen: n.last_seen,
      })),
      medians,
      alerts: alerts.map((a) => ({
        steamid: a.steamid, name: a.name, level: a.level, distance: a.distance, threshold: a.threshold, rank: a.rank,
        signs: signsOf(a.signs_json), matchId: a.match_id, createdAt: a.created_at, banned: hasActiveBan(db, a.steamid, now),
      })),
    });
  }
  return out;
}
