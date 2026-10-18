import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { recordPlayerNet } from '../src/playerNetworks.js';
import {
  addMember, closePerson, createPerson, ensureEvaderSchema, EvaderError, isOpenMember, openPeople,
  personByLabel, personOf, removeMember, steamMembersOf,
} from '../src/evaderPeople.js';
import { ipWatchView, isFlagged } from '../src/ipWatch.js';
import { DETHISA } from '../src/evaderSeed.js';
import { player } from './fingerprintFixtures.js';

const STAFF = '76561198000000009';
const OTHER = '76561198000000005';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  player(db, STAFF, 'staff');
});

describe('person records', () => {
  it('one person per label, trimmed, never blank', () => {
    const id = createPerson(db, ' dethisa ', 'five accounts', STAFF);
    expect(personByLabel(db, 'dethisa')?.id).toBe(id);
    expect(() => createPerson(db, 'dethisa', '', STAFF)).toThrow(EvaderError);
    expect(() => createPerson(db, '   ', '', STAFF)).toThrow(EvaderError);
  });

  it('an account belongs to at most one person', () => {
    const a = createPerson(db, 'dethisa', '', STAFF);
    const b = createPerson(db, 'shove', '', STAFF);
    expect(addMember(db, a, 'steam', DETHISA.steam[0], STAFF, 'manual')).toBe('added');
    expect(addMember(db, a, 'steam', DETHISA.steam[0], STAFF, 'manual')).toBe('already');
    expect(addMember(db, b, 'steam', DETHISA.steam[0], STAFF, 'manual')).toBe('other_person');
    expect(addMember(db, 999, 'steam', OTHER, STAFF, 'manual')).toBe('no_person');
    expect(addMember(db, a, 'steam', 'not-a-steamid', STAFF, 'manual')).toBe('invalid');
    expect(addMember(db, a, 'discord', '286250932470153217', STAFF, 'manual')).toBe('added');
    expect(steamMembersOf(db, a)).toEqual([DETHISA.steam[0]]);
    expect(personOf(db, 'discord', '286250932470153217')?.label).toBe('dethisa');
  });

  it('marks the cached pooled fingerprint stale on a membership change', () => {
    const id = createPerson(db, 'dethisa', '', STAFF);
    db.prepare("INSERT INTO fingerprint_cache (subject, classes_json, holds, built_at) VALUES (?, '{}', 0, '2026-10-17T00:00:00.000Z')")
      .run(`person:${id}`);
    addMember(db, id, 'steam', OTHER, STAFF, 'manual');
    const row = db.prepare('SELECT built_at FROM fingerprint_cache WHERE subject = ?').get(`person:${id}`) as { built_at: string };
    expect(row.built_at).toBe('');
  });
});

describe('isFlagged parity', () => {
  it('a Steam member of an open person is flagged; of a closed one, or removed, is not', () => {
    const id = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, id, 'steam', OTHER, STAFF, 'manual');
    expect(isFlagged(db, OTHER)).toBe(true);
    expect(isOpenMember(db, OTHER)).toBe(true);
    expect(closePerson(db, id, STAFF)).toBe(true);
    expect(isFlagged(db, OTHER)).toBe(false);
    expect(openPeople(db)).toEqual([]);
  });

  it('adding a member watches every address they used; removing them stops it', () => {
    recordPlayerNet(db, { steamid: OTHER, ip: '8.8.8.8', country: 'US' }, new Date(), null);
    const id = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, id, 'steam', OTHER, STAFF, 'manual');
    const entries = ipWatchView(db).entries;
    expect(entries.map((e) => e.steamid)).toEqual([OTHER]);
    expect(entries[0].accounts[0].flagged).toBe(true);
    expect(removeMember(db, 'steam', OTHER, STAFF)).toBe(true);
    expect(ipWatchView(db).entries).toEqual([]);
  });

  it('closing a person stops watching their addresses', () => {
    recordPlayerNet(db, { steamid: OTHER, ip: '8.8.8.8', country: 'US' }, new Date(), null);
    const id = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, id, 'steam', OTHER, STAFF, 'manual');
    closePerson(db, id, STAFF);
    expect(ipWatchView(db).entries).toEqual([]);
  });
});

describe('the evader_flags migration', () => {
  /** Re-run the schema as if this were the first boot with person records. */
  const firstBoot = () => {
    db.exec('DROP TABLE evader_members; DROP TABLE evader_people;');
    ensureEvaderSchema(db);
  };
  const flag = (steamid: string, reason: string, cleared = false) => db.prepare(
    `INSERT INTO evader_flags (steamid, reason, created_by, created_at, cleared_by, cleared_at)
     VALUES (?, ?, ?, '2026-10-08T00:00:00.000Z', ?, ?)`,
  ).run(steamid, reason, STAFF, cleared ? STAFF : null, cleared ? '2026-10-09T00:00:00.000Z' : null);

  it('puts every open dethisa flag on one person dethisa', () => {
    for (const id of DETHISA.steam.slice(0, 4)) flag(id, 'dethisa');
    firstBoot();
    const p = personByLabel(db, 'dethisa')!;
    expect(steamMembersOf(db, p.id).sort()).toEqual([...DETHISA.steam.slice(0, 4)].sort());
    for (const id of DETHISA.steam.slice(0, 4)) expect(isFlagged(db, id)).toBe(true);
  });

  it('gives any other open flag its own person named after the account, and skips cleared flags', () => {
    player(db, OTHER, 'someone');
    flag(OTHER, 'another evader');
    flag('76561198000000006', 'cleared one', true);
    firstBoot();
    expect(openPeople(db).map((p) => p.label)).toEqual(['someone']);
    expect(personOf(db, 'steam', '76561198000000006')).toBeNull();
  });

  it('runs once and leaves evader_flags in place', () => {
    flag(DETHISA.steam[0], 'dethisa');
    firstBoot();
    ensureEvaderSchema(db);
    expect(openPeople(db)).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM evader_flags').get() as { n: number }).n).toBe(1);
  });
});

describe('migration robustness', () => {
  const flag = (steamid: string) => db.prepare(
    `INSERT INTO evader_flags (steamid, reason, created_by, created_at) VALUES (?, 'r', ?, '2026-10-08T00:00:00.000Z')`,
  ).run(steamid, STAFF);

  it('a migration that throws rolls the table creation back, and the next boot migrates', () => {
    db.exec('DROP TABLE evader_members; DROP TABLE evader_people;');
    flag(DETHISA.steam[0]);
    // dropping the flags table makes the migration's own query throw
    db.exec('DROP TABLE evader_flags');
    expect(() => ensureEvaderSchema(db)).toThrow();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'evader_people'").get()).toBeUndefined();
    db.exec(`CREATE TABLE evader_flags (steamid TEXT PRIMARY KEY, reason TEXT NOT NULL, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, cleared_by TEXT, cleared_at TEXT)`);
    flag(DETHISA.steam[0]);
    ensureEvaderSchema(db);
    expect(isFlagged(db, DETHISA.steam[0])).toBe(true);
  });

  it('an existing but empty evader_people with open flags migrates on the next call', () => {
    flag(DETHISA.steam[0]);
    expect(openPeople(db)).toEqual([]);
    ensureEvaderSchema(db);
    expect(isFlagged(db, DETHISA.steam[0])).toBe(true);
  });

  it('running twice migrates once', () => {
    flag(DETHISA.steam[0]);
    ensureEvaderSchema(db);
    ensureEvaderSchema(db);
    expect(openPeople(db)).toHaveLength(1);
    expect(steamMembersOf(db, openPeople(db)[0].id)).toEqual([DETHISA.steam[0]]);
  });

  it('dethisa takes the label first, a stranger named dethisa gets a suffixed one, long names are clamped', () => {
    player(db, '76561198000000007', 'dethisa');
    player(db, '76561198000000008', 'dethisa (pre-ban)');
    player(db, '76561198000000010', 'x'.repeat(60));
    flag('76561198000000007');
    flag('76561198000000008');
    flag('76561198000000010');
    ensureEvaderSchema(db);
    const d = personByLabel(db, 'dethisa')!;
    expect(steamMembersOf(db, d.id)).toEqual(['76561198000000008']);
    const labels = openPeople(db).map((p) => p.label);
    expect(labels).toContain('dethisa (76561198000000007)');
    expect(labels.every((l) => l.length >= 1 && l.length <= 40)).toBe(true);
  });
});
