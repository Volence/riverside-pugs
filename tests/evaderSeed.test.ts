import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DETHISA, SEED_PEOPLE, SHOVE } from '../src/evaderSeed.js';
import { seedPeople } from '../src/seedEvaders.js';
import { addMember, createPerson, ensureEvaderSchema, personByLabel, personOf, steamMembersOf } from '../src/evaderPeople.js';
import { player } from './fingerprintFixtures.js';

const PREBAN = '76561198869884852';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  player(db, PREBAN, 'dethisa (pre-ban)');
});

describe('seedPeople', () => {
  it('writes dethisa and shove with their Steam accounts, the pre-ban name, and Discords', () => {
    const r = seedPeople(db, SEED_PEOPLE);
    expect(r.created).toEqual(['dethisa', 'shove']);
    expect(r.conflicts).toEqual([]);
    const d = personByLabel(db, 'dethisa')!;
    expect(steamMembersOf(db, d.id).sort()).toEqual([...DETHISA.steam, PREBAN].sort());
    for (const id of DETHISA.discord) expect(personOf(db, 'discord', id)?.label).toBe('dethisa');
    for (const id of SHOVE.steam) expect(personOf(db, 'steam', id)?.label).toBe('shove');
  });

  it('is safe to run twice', () => {
    seedPeople(db, SEED_PEOPLE);
    const again = seedPeople(db, SEED_PEOPLE);
    expect(again.created).toEqual([]);
    expect(again.added).toEqual([]);
    expect(again.already.length).toBe(DETHISA.steam.length + 1 + DETHISA.discord.length + SHOVE.steam.length + SHOVE.discord.length);
  });

  it('a dry run reports and writes nothing', () => {
    const r = seedPeople(db, SEED_PEOPLE, { dryRun: true });
    expect(r.created).toEqual(['dethisa', 'shove']);
    expect(personByLabel(db, 'dethisa')).toBeNull();
  });

  it('reports an account already on another person and never moves it', () => {
    const other = createPerson(db, 'someone', '', 'system');
    addMember(db, other, 'steam', DETHISA.steam[0], 'system', 'manual');
    const r = seedPeople(db, SEED_PEOPLE);
    expect(r.conflicts).toEqual([`dethisa steam ${DETHISA.steam[0]}: other_person`]);
    expect(personOf(db, 'steam', DETHISA.steam[0])?.label).toBe('someone');
  });

  it('builds on the person the evader_flags migration made', () => {
    db.prepare("INSERT INTO evader_flags (steamid, reason, created_by, created_at) VALUES (?, 'dethisa', 'x', '2026-10-08T00:00:00.000Z')")
      .run(DETHISA.steam[0]);
    db.exec('DROP TABLE evader_members; DROP TABLE evader_people;');
    ensureEvaderSchema(db);
    const r = seedPeople(db, SEED_PEOPLE);
    expect(r.created).toEqual(['shove']);
    expect(r.already).toContain(`dethisa steam ${DETHISA.steam[0]}`);
  });
});
