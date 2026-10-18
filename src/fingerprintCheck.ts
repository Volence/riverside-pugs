import type { DB } from './db.js';
import { getSetting } from './settings.js';
import { publishAdminEvent, type AdminEvent } from './adminFeed.js';
import { placeFingerprintHold } from './altHolds.js';
import { currentAsnTable } from './asnTable.js';
import {
  classLabel, matchPersons, medianHold, type Fingerprint, type PersonHit, type PersonModel, type SecondSign,
} from './fingerprint.js';
import { fingerprintWorld, playerFingerprint } from './fingerprintData.js';
import { candidatesOf, secondSigns } from './fingerprintSigns.js';
import { extraVpnAsns, isVpnNetwork } from './networkKinds.js';
import { isFingerprintDismissed } from './evaderPeople.js';

/**
 * The evader fingerprint check, run once per ended match from the end-of-match
 * sweep (scanEndedMatches in src/inputBursts.ts), after the auto-bhop
 * signature.
 *
 * Design: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
 *
 * For each new player in the match: rank their whole-history fingerprint
 * against every fingerprinted player and every open person. A person in the
 * top 5 and within their own threshold is a fingerprint match. Then:
 *
 *   - no second sign: 'alert', a mod channel post, nothing done;
 *   - a second sign, setting 'full': 'hold', an alt hold, a pinged post;
 *   - a second sign, setting 'alert' (or the hold refused): 'loud', a pinged
 *     post and no hold.
 *
 * Each (account, person, level) fires once, and again only when the level
 * goes up. A cleared fingerprint hold is never placed again for that pair,
 * and a pair staff dismissed ("Not them") is never alerted on again.
 */

export type FingerprintMode = 'off' | 'alert' | 'full';
export type AlertLevel = 'alert' | 'loud' | 'hold';
const LEVEL_RANK: Record<AlertLevel, number> = { alert: 1, loud: 2, hold: 3 };

export function fingerprintMode(db: DB): FingerprintMode {
  const v = getSetting(db, 'evader_fingerprint');
  return v === 'alert' || v === 'full' ? v : 'off';
}

export function levelFor(mode: 'alert' | 'full', signs: readonly SecondSign[]): AlertLevel {
  if (signs.length === 0) return 'alert';
  return mode === 'full' ? 'hold' : 'loud';
}

function storedLevel(db: DB, steamid: string, personId: number): AlertLevel | null {
  const rows = db.prepare('SELECT level FROM fingerprint_alerts WHERE steamid = ? AND person_id = ?')
    .all(steamid, personId) as { level: AlertLevel }[];
  let best: AlertLevel | null = null;
  for (const r of rows) if (!best || LEVEL_RANK[r.level] > LEVEL_RANK[best]) best = r.level;
  return best;
}

export interface FingerprintOutcome {
  matchId: number; steamid: string; personId: number; level: AlertLevel; signs: SecondSign[]; holdId: number | null;
}

/** Logged at most hourly: "sign 1 is not being counted" is worth knowing, not
 *  worth a line every minute. */
let asnMissingLoggedAt = Number.NEGATIVE_INFINITY;

function eventFor(
  db: DB, matchId: number, steamid: string, person: PersonModel, fp: Fingerprint, hit: PersonHit,
  signs: SecondSign[], level: AlertLevel, holdId: number | null, extraVpn: ReadonlySet<number>,
): AdminEvent {
  const classes = [...new Set([...Object.keys(fp), ...Object.keys(person.pooled)])].sort();
  const nets = db.prepare('SELECT country, asn, as_org FROM player_networks WHERE player_id = ? ORDER BY last_seen DESC LIMIT 6')
    .all(steamid) as { country: string | null; asn: number | null; as_org: string | null }[];
  return {
    kind: 'fingerprint_match', level, steamid, matchId,
    personId: person.id, personLabel: person.label,
    distance: hit.distance, threshold: hit.threshold, rank: hit.rank,
    signs: [...signs], holdId,
    medians: classes.map((cls) => ({ cls: classLabel(cls), candidate: medianHold(fp[cls]), person: medianHold(person.pooled[cls]) })),
    connections: nets.map((n) => ({ country: n.country, asOrg: n.as_org, vpn: isVpnNetwork(n.asn, n.as_org, extraVpn) })),
  };
}

export function checkMatchFingerprints(db: DB, matchId: number, now = new Date()): FingerprintOutcome[] {
  const mode = fingerprintMode(db);
  if (mode === 'off') return [];
  const candidates = candidatesOf(db, matchId, now);
  if (candidates.length === 0) return [];
  const { field, persons } = fingerprintWorld(db, now);
  if (persons.length === 0) return [];
  const asnLoaded = currentAsnTable() !== null;
  if (!asnLoaded && now.getTime() - asnMissingLoggedAt >= 3_600_000) {
    asnMissingLoggedAt = now.getTime();
    console.warn('[fingerprint] no ASN table is loaded: the VPN sign is not counted until one is');
  }
  const extraVpn = extraVpnAsns(db);
  const out: FingerprintOutcome[] = [];
  for (const steamid of candidates) {
    const fp = playerFingerprint(db, steamid);
    for (const hit of matchPersons(fp, steamid, field, persons)) {
      if (!hit.matched) continue;
      const person = persons.find((p) => p.id === hit.personId);
      if (!person || person.members.length === 0) continue;
      // Staff said "Not them" to this pair: never told about again.
      if (isFingerprintDismissed(db, steamid, person.id)) continue;
      const signs = secondSigns(db, steamid, { members: person.members, membersInTop10: hit.membersInTop10, asnLoaded, extraVpn }, now);
      const before = storedLevel(db, steamid, person.id);
      let level = levelFor(mode, signs);
      if (before && LEVEL_RANK[before] >= LEVEL_RANK[level]) continue;
      let holdId: number | null = null;
      if (level === 'hold') {
        const placed = placeFingerprintHold(db, steamid, person.id, hit.nearestMember ?? person.members[0], now);
        if ('id' in placed) {
          holdId = placed.id;
        } else if (placed.refused === 'cleared') {
          continue; // staff already said no to this pair
        } else {
          level = 'loud';
          if (before && LEVEL_RANK[before] >= LEVEL_RANK.loud) continue;
        }
      }
      db.prepare(
        `INSERT OR IGNORE INTO fingerprint_alerts (steamid, person_id, level, distance, threshold, rank, signs_json, match_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(steamid, person.id, level, hit.distance, hit.threshold, hit.rank, JSON.stringify(signs), matchId, now.toISOString());
      publishAdminEvent(eventFor(db, matchId, steamid, person, fp, hit, signs, level, holdId, extraVpn));
      out.push({ matchId, steamid, personId: person.id, level, signs, holdId });
    }
  }
  return out;
}

/** The sweep's entry point: a failure is logged with the match id and never
 *  reaches the sweep, which carries on with its other checks. */
export function runFingerprintCheck(db: DB, matchId: number, now = new Date()): FingerprintOutcome[] {
  try {
    return checkMatchFingerprints(db, matchId, now);
  } catch (err) {
    console.error(`[fingerprint] fingerprint check failed for match ${matchId}:`, err);
    return [];
  }
}
