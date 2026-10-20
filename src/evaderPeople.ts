import type { DB } from './db.js';
import { unwatchAccount, watchAccount } from './ipWatch.js';
import { DETHISA } from './evaderSeed.js';

/**
 * Known evaders as PEOPLE: one record per person, grouping every Steam and
 * Discord account they have been caught on.
 *
 * Design: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
 *
 * Replaces the per-account evader_flags (src/ipWatch.ts). dethisa had four
 * flagged accounts that nothing tied together; as one person they have one
 * pooled press fingerprint to match a sixth account against, and one card on
 * People > Alts. An account belongs to at most one person.
 *
 * isFlagged in src/ipWatch.ts now means "a Steam member of an OPEN person",
 * so everything built on flags (watching every connection an evader uses,
 * the loud watch-list alert) carries on unchanged. A closed person is no
 * longer watched or matched; the record stays for history.
 *
 * evader_flags is left in place, read-only, for one release, then dropped.
 */

export type MemberKind = 'steam' | 'discord';

export interface PersonRow {
  id: number; label: string; note: string; createdBy: string; createdAt: string; closedAt: string | null;
}

export class EvaderError extends Error {}

const PERSON_SELECT = `SELECT id, label, note, created_by AS createdBy, created_at AS createdAt, closed_at AS closedAt
  FROM evader_people`;

export function ensureEvaderSchema(db: DB): void {
  // One transaction (SQLite DDL is transactional): a migration that dies
  // rolls the table creation back, so the next boot tries again.
  db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evader_people (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT NOT NULL UNIQUE,
      note        TEXT NOT NULL DEFAULT '',
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      -- closed = no longer watched or matched
      closed_by   TEXT,
      closed_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS evader_members (
      person_id   INTEGER NOT NULL REFERENCES evader_people(id),
      kind        TEXT NOT NULL CHECK (kind IN ('steam','discord')),
      -- SteamID64 or Discord user id
      ident       TEXT NOT NULL,
      -- admin steamid or 'system'
      added_by    TEXT NOT NULL,
      added_at    TEXT NOT NULL,
      -- 'seed', 'manual', 'migrated flag', 'ban as same person'
      how         TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (kind, ident)
    );
    CREATE INDEX IF NOT EXISTS evader_members_person ON evader_members (person_id);
    -- Fingerprints built from input_bursts (src/fingerprintData.ts). subject is
    -- steam:<id> (whole history) or person:<id> (pooled members). built_at ''
    -- means stale: rebuilt on the next check, as is a row binned by an older
    -- scheme (binning < FINGERPRINT_BINNING).
    CREATE TABLE IF NOT EXISTS fingerprint_cache (
      subject      TEXT PRIMARY KEY,
      classes_json TEXT NOT NULL,
      holds        INTEGER NOT NULL,
      built_at     TEXT NOT NULL,
      binning      INTEGER NOT NULL DEFAULT 1
    );
    -- One row per (candidate, person, level) that fired (src/fingerprintCheck.ts).
    -- A candidate is told about again only when the level goes up.
    CREATE TABLE IF NOT EXISTS fingerprint_alerts (
      steamid     TEXT NOT NULL,
      person_id   INTEGER NOT NULL,
      level       TEXT NOT NULL CHECK (level IN ('alert','loud','hold')),
      distance    REAL NOT NULL,
      threshold   REAL NOT NULL,
      rank        INTEGER NOT NULL,
      signs_json  TEXT NOT NULL DEFAULT '[]',
      match_id    INTEGER,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (steamid, person_id, level)
    );
    -- "Not them": staff looked at a fingerprint alert and say the account is
    -- not this person. The check never alerts or holds the pair again.
    CREATE TABLE IF NOT EXISTS fingerprint_dismissals (
      steamid     TEXT NOT NULL,
      person_id   INTEGER NOT NULL,
      -- staff steamid
      dismissed_by TEXT NOT NULL,
      at          TEXT NOT NULL,
      PRIMARY KEY (steamid, person_id)
    );
  `);
  // 1 = tick bins, every row before rate-aware bins (2026-10-20).
  const cacheCols = db.prepare('PRAGMA table_info(fingerprint_cache)').all() as { name: string }[];
  if (!cacheCols.some((c) => c.name === 'binning')) {
    db.exec('ALTER TABLE fingerprint_cache ADD COLUMN binning INTEGER NOT NULL DEFAULT 1');
  }
  // People are never deleted, so an empty table with open flags means the
  // migration has not happened yet (first boot, or an earlier one was cut short).
  const none = (db.prepare('SELECT COUNT(*) AS n FROM evader_people').get() as { n: number }).n === 0;
  if (none) migrateEvaderFlags(db);
  })();
}

function insertPerson(db: DB, label: string, note: string, by: string, at: string): number {
  return Number(db.prepare('INSERT INTO evader_people (label, note, created_by, created_at) VALUES (?, ?, ?, ?)')
    .run(label, note, by, at).lastInsertRowid);
}

/** A label nobody has: the account's name, or the name and the id. */
function freeLabel(db: DB, name: string, steamid: string): string {
  const base = name.trim().slice(0, 40) || steamid;
  if (!personByLabel(db, base)) return base;
  const withId = `${base.slice(0, 40 - steamid.length - 3)} (${steamid})`;
  return personByLabel(db, withId) ? steamid : withId;
}

/**
 * Every open evader flag becomes a Steam member of a person. The dethisa
 * accounts (src/evaderSeed.ts) go on one person `dethisa`. Any other flag is
 * NOT guessed at: it becomes its own person named after the account, and
 * staff merge records by hand. Runs once, on the boot that creates
 * evader_people. It writes no watch rows: the flags already put them there.
 */
export function migrateEvaderFlags(db: DB): void {
  const flags = db.prepare(
    `SELECT f.steamid, f.reason, f.created_by AS createdBy, f.created_at AS createdAt, p.name
       FROM evader_flags f LEFT JOIN players p ON p.steamid = f.steamid
      WHERE f.cleared_at IS NULL ORDER BY f.created_at, f.steamid`,
  ).all() as { steamid: string; reason: string; createdBy: string; createdAt: string; name: string | null }[];
  if (flags.length === 0) return;
  const dethisa = new Set(DETHISA.steam);
  const isKnown = (f: { steamid: string; name: string | null }) =>
    dethisa.has(f.steamid) || (f.name !== null && DETHISA.steamByName.includes(f.name));
  db.transaction(() => {
    // dethisa first, so an unrelated account named "dethisa" can never take the label.
    const first = flags.find(isKnown);
    if (first && !personByLabel(db, DETHISA.label)) {
      insertPerson(db, DETHISA.label, 'Made from the evader flags.', first.createdBy, first.createdAt);
    }
    for (const f of flags) {
      const known = isKnown(f);
      const label = known ? DETHISA.label : freeLabel(db, f.name ?? f.steamid, f.steamid);
      const id = personByLabel(db, label)?.id
        ?? insertPerson(db, label, known ? 'Made from the evader flags.' : f.reason, f.createdBy, f.createdAt);
      db.prepare(
        `INSERT OR IGNORE INTO evader_members (person_id, kind, ident, added_by, added_at, how)
         VALUES (?, 'steam', ?, ?, ?, 'migrated flag')`,
      ).run(id, f.steamid, f.createdBy, f.createdAt);
    }
  })();
}

export function createPerson(db: DB, label: string, note: string, by: string, now = new Date()): number {
  const l = label.trim();
  if (!l || l.length > 40) throw new EvaderError('a label is 1 to 40 characters');
  if (note.length > 500) throw new EvaderError('a note is up to 500 characters');
  if (personByLabel(db, l)) throw new EvaderError('a person with that label already exists');
  return insertPerson(db, l, note.trim(), by, now.toISOString());
}

export function personByLabel(db: DB, label: string): PersonRow | null {
  return (db.prepare(`${PERSON_SELECT} WHERE label = ?`).get(label) as PersonRow | undefined) ?? null;
}

export function personById(db: DB, id: number): PersonRow | null {
  return (db.prepare(`${PERSON_SELECT} WHERE id = ?`).get(id) as PersonRow | undefined) ?? null;
}

export function openPeople(db: DB): PersonRow[] {
  return db.prepare(`${PERSON_SELECT} WHERE closed_at IS NULL ORDER BY id`).all() as PersonRow[];
}

export function personOf(db: DB, kind: MemberKind, ident: string): { id: number; label: string; closed: boolean } | null {
  const r = db.prepare(
    `SELECT p.id, p.label, p.closed_at FROM evader_members m JOIN evader_people p ON p.id = m.person_id
      WHERE m.kind = ? AND m.ident = ?`,
  ).get(kind, ident) as { id: number; label: string; closed_at: string | null } | undefined;
  return r ? { id: r.id, label: r.label, closed: r.closed_at !== null } : null;
}

export function isOpenMember(db: DB, steamid: string): boolean {
  const p = personOf(db, 'steam', steamid);
  return p !== null && !p.closed;
}

export function steamMembersOf(db: DB, personId: number): string[] {
  return (db.prepare("SELECT ident FROM evader_members WHERE person_id = ? AND kind = 'steam' ORDER BY added_at, ident")
    .all(personId) as { ident: string }[]).map((r) => r.ident);
}

export function membersOf(db: DB, personId: number): { kind: MemberKind; ident: string; addedBy: string; addedAt: string; how: string }[] {
  return db.prepare(
    'SELECT kind, ident, added_by AS addedBy, added_at AS addedAt, how FROM evader_members WHERE person_id = ? ORDER BY kind, added_at',
  ).all(personId) as { kind: MemberKind; ident: string; addedBy: string; addedAt: string; how: string }[];
}

/** The pooled fingerprint no longer describes the person: rebuild it next time. */
export function markPersonStale(db: DB, personId: number): void {
  db.prepare("UPDATE fingerprint_cache SET built_at = '' WHERE subject = ?").run(`person:${personId}`);
}

export type AddResult = 'added' | 'already' | 'other_person' | 'no_person' | 'invalid';

/** Add an account to a person. A Steam account on an open person has every
 *  connection it has used put on the IP watch list, as a flag did. */
export function addMember(
  db: DB, personId: number, kind: MemberKind, ident: string, by: string, how: string, now = new Date(),
): AddResult {
  if (kind === 'steam' ? !/^\d{17}$/.test(ident) : !/^\d{17,20}$/.test(ident)) return 'invalid';
  const person = personById(db, personId);
  if (!person) return 'no_person';
  const existing = personOf(db, kind, ident);
  if (existing) return existing.id === personId ? 'already' : 'other_person';
  const at = now.toISOString();
  db.transaction(() => {
    db.prepare('INSERT INTO evader_members (person_id, kind, ident, added_by, added_at, how) VALUES (?, ?, ?, ?, ?, ?)')
      .run(personId, kind, ident, by, at, how);
    markPersonStale(db, personId);
    if (kind === 'steam' && !person.closedAt) watchAccount(db, ident, by, at);
  })();
  return 'added';
}

/** Take an account off its person, and stop watching what it put on the
 *  list. Addresses added by hand, or by another member, stay. */
export function removeMember(db: DB, kind: MemberKind, ident: string, by: string, now = new Date()): boolean {
  const p = personOf(db, kind, ident);
  if (!p) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM evader_members WHERE kind = ? AND ident = ?').run(kind, ident);
    markPersonStale(db, p.id);
    if (kind === 'steam') unwatchAccount(db, ident, by, now.toISOString());
  })();
  return true;
}

/** No longer watched or matched. Every member's watched addresses go. */
export function closePerson(db: DB, personId: number, by: string, now = new Date()): boolean {
  const at = now.toISOString();
  let closed = false;
  db.transaction(() => {
    closed = db.prepare('UPDATE evader_people SET closed_by = ?, closed_at = ? WHERE id = ? AND closed_at IS NULL')
      .run(by, at, personId).changes > 0;
    if (closed) for (const steamid of steamMembersOf(db, personId)) unwatchAccount(db, steamid, by, at);
  })();
  return closed;
}

/**
 * "Not them" on a fingerprint alert: staff say `steamid` is not person
 * `personId`. From then on the fingerprint check (src/fingerprintCheck.ts)
 * never alerts on the pair again at any level, and placeFingerprintHold
 * refuses it as it refuses a pair staff cleared from a hold. Only the pair:
 * the account is still checked against every other person. It does not
 * touch an open hold, which is lifted on the Alts list as any other.
 * Returns false when the pair was already dismissed.
 */
export function dismissFingerprint(db: DB, steamid: string, personId: number, by: string, now = new Date()): boolean {
  return db.prepare('INSERT OR IGNORE INTO fingerprint_dismissals (steamid, person_id, dismissed_by, at) VALUES (?, ?, ?, ?)')
    .run(steamid, personId, by, now.toISOString()).changes > 0;
}

export function isFingerprintDismissed(db: DB, steamid: string, personId: number): boolean {
  return db.prepare('SELECT 1 FROM fingerprint_dismissals WHERE steamid = ? AND person_id = ?').get(steamid, personId) !== undefined;
}
