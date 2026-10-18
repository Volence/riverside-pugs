import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('scripts/seed-evader-people.ts', () => {
  const root = join(import.meta.dirname, '..');
  // DB_PATH points at a file that must never be touched: a bare --db used to
  // fall back to the configured path.
  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'scripts/seed-evader-people.ts'), ...args],
      { encoding: 'utf8', cwd: root, env: { ...process.env, ...env } });

  it('a --db with no value, an unknown flag and a repeated --db exit 2 and never fall back to the configured database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    const configured = join(dir, 'configured.db');
    openDb(configured).close();
    const env = { DB_PATH: configured };
    for (const args of [['--db'], ['--db', '--commit'], ['--commit', '--db'], ['--comit'], ['--db', 'a.db', '--db', 'b.db']]) {
      const r = run(env, ...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/usage: seed-evader-people\.ts/);
    }
    const c = openDb(configured);
    expect(personByLabel(c, 'dethisa')).toBeNull();
    c.close();
  });

  it('a missing --db file is refused and not created; a real one gets a dry run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    const missing = join(dir, 'nope.db');
    expect(run({}, '--db', missing).status).toBe(2);
    expect(existsSync(missing)).toBe(false);
    const real = join(dir, 'x.db');
    openDb(real).close();
    const dry = run({}, '--db', real);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('Dry run, nothing written');
    const c = openDb(real);
    expect(personByLabel(c, 'dethisa')).toBeNull();
    c.close();
  });
});
