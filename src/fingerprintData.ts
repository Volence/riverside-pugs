import type { DB } from './db.js';
import {
  BASE_KINDS, BASE_WEAPON_NAMES, MIN_CANDIDATE_HOLDS, fingerprintOf, holdTotal, personThreshold, pooled,
  type BurstHoldRow, type FieldEntry, type Fingerprint, type PersonModel,
} from './fingerprint.js';
import { openPeople, steamMembersOf } from './evaderPeople.js';

/**
 * Fingerprints read from input_bursts, and the cache that keeps the check
 * cheap.
 *
 * Ranking a candidate needs every fingerprinted player's whole history. Built
 * from scratch that is every infected burst on record, every match. So each
 * player's histogram (and each person's pooled one) is cached in
 * fingerprint_cache and rebuilt only when that player has a burst newer than
 * the row (or, for a person, when a member played or the membership changed,
 * which blanks built_at). The first check after the setting is turned on
 * builds everyone; every check after that rebuilds the handful who played.
 */

/** The base classes, as a WHERE fragment. Literal constants, no parameters. */
export const BASE_BURST_SQL = `holds IS NOT NULL
  AND kind IN (${BASE_KINDS.map((k) => `'${k}'`).join(', ')})
  AND weapon IN (${BASE_WEAPON_NAMES.map((w) => `'${w}'`).join(', ')})`;

export function playerFingerprint(db: DB, steamid: string): Fingerprint {
  return fingerprintOf(
    db.prepare(`SELECT kind, weapon, holds FROM input_bursts WHERE steamid = ? AND ${BASE_BURST_SQL}`)
      .iterate(steamid) as IterableIterator<BurstHoldRow>,
  );
}

/** One fingerprint per (account, match), for a person's own threshold. */
export function memberMatchFingerprints(db: DB, steamids: readonly string[]): Fingerprint[] {
  if (steamids.length === 0) return [];
  const rows = db.prepare(
    `SELECT steamid, match_id AS matchId, kind, weapon, holds FROM input_bursts
      WHERE match_id IS NOT NULL AND steamid IN (${steamids.map(() => '?').join(', ')}) AND ${BASE_BURST_SQL}
      ORDER BY steamid, match_id`,
  ).all(...steamids) as (BurstHoldRow & { steamid: string; matchId: number })[];
  const groups = new Map<string, BurstHoldRow[]>();
  for (const r of rows) {
    const key = `${r.steamid}/${r.matchId}`;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  return [...groups.values()].map((g) => fingerprintOf(g));
}

interface CacheRow { subject: string; classes_json: string; holds: number; built_at: string }

export interface FingerprintWorld {
  /** Every fingerprinted player and every open person's pool. */
  field: FieldEntry[];
  persons: PersonModel[];
  /** Cache rows rebuilt by this call. */
  rebuilt: number;
}

export function fingerprintWorld(db: DB, now = new Date()): FingerprintWorld {
  const at = now.toISOString();
  const last = new Map(
    (db.prepare(`SELECT steamid, MAX(at) AS last FROM input_bursts WHERE ${BASE_BURST_SQL} GROUP BY steamid`)
      .all() as { steamid: string; last: string }[]).map((r) => [r.steamid, r.last]),
  );
  const cache = new Map(
    (db.prepare('SELECT subject, classes_json, holds, built_at FROM fingerprint_cache').all() as CacheRow[])
      .map((r) => [r.subject, r]),
  );
  const write = db.prepare(
    `INSERT INTO fingerprint_cache (subject, classes_json, holds, built_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(subject) DO UPDATE SET classes_json = excluded.classes_json, holds = excluded.holds,
       built_at = excluded.built_at`,
  );
  let rebuilt = 0;
  const store = (subject: string, fp: Fingerprint): void => {
    const row = { subject, classes_json: JSON.stringify(fp), holds: holdTotal(fp), built_at: at };
    write.run(row.subject, row.classes_json, row.holds, row.built_at);
    cache.set(subject, row);
    rebuilt += 1;
  };
  const fpOf = (subject: string): Fingerprint => JSON.parse(cache.get(subject)?.classes_json ?? '{}') as Fingerprint;
  const people = openPeople(db).map((p) => ({ id: p.id, label: p.label, members: steamMembersOf(db, p.id) }));

  db.transaction(() => {
    for (const [steamid, played] of last) {
      const c = cache.get(`steam:${steamid}`);
      if (!c || c.built_at < played) store(`steam:${steamid}`, playerFingerprint(db, steamid));
    }
    for (const p of people) {
      const subject = `person:${p.id}`;
      const c = cache.get(subject);
      const played = p.members.map((m) => last.get(m) ?? '').sort().pop() ?? '';
      if (!c || c.built_at === '' || c.built_at < played) store(subject, pooled(p.members.map((m) => fpOf(`steam:${m}`))));
    }
  })();

  const field: FieldEntry[] = [];
  for (const steamid of last.keys()) {
    const row = cache.get(`steam:${steamid}`);
    if (row && row.holds >= MIN_CANDIDATE_HOLDS) field.push({ subject: `steam:${steamid}`, fp: JSON.parse(row.classes_json) as Fingerprint });
  }
  const persons: PersonModel[] = people.map((p) => ({
    id: p.id, label: p.label, members: p.members,
    pooled: fpOf(`person:${p.id}`),
    threshold: personThreshold(memberMatchFingerprints(db, p.members)),
  }));
  for (const p of persons) field.push({ subject: `person:${p.id}`, fp: p.pooled });
  return { field, persons, rebuilt };
}

/** Every cached player fingerprint pooled, for "how does everyone hold".
 *  Reads the cache only: a page view must never trigger a rebuild. */
export function cachedPopulation(db: DB): Fingerprint {
  return pooled(
    (db.prepare("SELECT classes_json FROM fingerprint_cache WHERE subject LIKE 'steam:%'").all() as { classes_json: string }[])
      .map((r) => JSON.parse(r.classes_json) as Fingerprint),
  );
}
