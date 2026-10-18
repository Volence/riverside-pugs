import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caughtAs, copyForReplay, parseReplayArgs, replayHistory, replayPeople, weekOf, REPLAY_LIMITS } from '../src/fingerprintReplay.js';
import { endedMatch, playMatch } from './fingerprintFixtures.js';

// One member only: two identical members would both sit in ALT's top 10 and
// fire second sign 4 on their own.
const M1 = '76561198000000001';
const ALT = '76561198000000003';
const HONEST = [5, 6, 15, 16].map((peak, i) => ({ id: `765611980000001${10 + i}`, peak }));
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const m of [1, 2, 3]) {
    endedMatch(db, m, `2026-10-0${m} 20:00:00`);
    playMatch(db, M1, m, 10, 60, `2026-10-0${m}T19:00:00.000Z`);
    for (const h of HONEST) playMatch(db, h.id, m, h.peak, 40, `2026-10-0${m}T19:00:00.000Z`);
  }
  endedMatch(db, 4, '2026-10-04 20:00:00');
  playMatch(db, ALT, 4, 10, 80, '2026-10-04T19:00:00.000Z');
});

const people = [{ label: 'dethisa', steam: [M1, ALT] }];

describe('weekOf', () => {
  it('names the Monday of the week, UTC', () => {
    expect(weekOf(new Date('2026-10-04T20:00:00Z'))).toBe('2026-09-28'); // a Sunday
    expect(weekOf(new Date('2026-10-05T00:00:00Z'))).toBe('2026-10-05'); // a Monday
  });
});

describe('replayHistory', () => {
  it('catches an account taken out of the seed, at the match it first qualified', () => {
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(r.matches).toBe(4);
    expect(r.excluded).toEqual([{ steamid: ALT, level: 'alert', matchId: 4 }]);
    expect(r.events.filter((e) => e.honest)).toEqual([]);
    expect(r.weeks).toContainEqual({ week: '2026-09-28', alerts: 1, louds: 0, holds: 0, honestAlerts: 0, honestLouds: 0, honestHolds: 0 });
    expect(r.honestTop5Rate === null || (r.honestTop5Rate >= 0 && r.honestTop5Rate <= 1)).toBe(true);
  });

  it('a second sign seen by then makes it a hold', () => {
    db.prepare("INSERT INTO players (steamid, name) VALUES (?, 'alt')").run(ALT);
    db.prepare("INSERT INTO integrity_flags (match_id, steamid, source, kind, severity, at) VALUES (4, ?, 'lilac', 'aimbot', 'suspected', '2026-10-04T19:30:00.000Z')").run(ALT);
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(r.excluded[0].level).toBe('hold');
    expect(r.events[0].signs).toEqual(['cheat_flag']);
  });

  it('a member is never a candidate, and an account banned by then is skipped', () => {
    expect(replayHistory(db, { people, exclude: new Set(), asnLoaded: false }).events).toEqual([]);
    db.prepare("INSERT INTO players (steamid, name) VALUES (?, 'alt')").run(ALT);
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at, kind) VALUES (?, 'x', 'x', '2026-10-03T00:00:00.000Z', 'ban')").run(ALT);
    expect(replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false }).excluded[0].level).toBeNull();
  });

  it('never writes to the database it reads', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM fingerprint_cache').get();
    replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fingerprint_cache').get()).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) AS n FROM fingerprint_alerts').get() as { n: number }).n).toBe(0);
  });
});

describe('sign 2 alone', () => {
  it('counts the holds that came only from the fresh identity sign', () => {
    // A Discord link never used elsewhere and a site account under 7 days old
    // at match 4: sign 2 and nothing else.
    db.prepare("INSERT INTO players (steamid, name, discord_id, created_at) VALUES (?, 'alt', '100000000000000000', '2026-10-02 00:00:00')").run(ALT);
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(r.events[0].signs).toEqual(['fresh_identity']);
    expect(r.freshOnlyHolds).toBe(1);
    expect(r.honestFreshOnlyHolds).toBe(0);
  });

  it('a hold with another sign beside sign 2 is not counted as sign 2 alone', () => {
    db.prepare("INSERT INTO players (steamid, name, discord_id, created_at) VALUES (?, 'alt', '100000000000000000', '2026-10-02 00:00:00')").run(ALT);
    db.prepare("INSERT INTO integrity_flags (match_id, steamid, source, kind, severity, at) VALUES (4, ?, 'lilac', 'aimbot', 'suspected', '2026-10-04T19:30:00.000Z')").run(ALT);
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(r.events[0].signs).toEqual(['fresh_identity', 'cheat_flag']);
    expect(r.freshOnlyHolds).toBe(0);
  });

  it('the printed limits name the as-of-today facts and sign 2 overstatement', () => {
    const text = REPLAY_LIMITS.join(' ');
    expect(text).toMatch(/Steam privacy/);
    expect(text).toMatch(/Discord link/);
    expect(text).toMatch(/sign 2/);
  });
});

describe('caughtAs', () => {
  it('only counts a catch against the named person', () => {
    const two = [{ label: 'dethisa', steam: [M1, ALT] }, { label: 'shove', steam: ['76561198000000099'] }];
    const r = replayHistory(db, { people: two, exclude: new Set([ALT]), asnLoaded: false });
    expect(caughtAs(r, ALT, 'dethisa')).toEqual({ level: 'alert', matchId: 4 });
    expect(caughtAs(r, ALT, 'shove')).toBeNull();
  });
});

describe('parseReplayArgs', () => {
  it('reads --db, --required, --exclude and --json', () => {
    expect(parseReplayArgs(['--db', 'x.db', '--exclude', '1', '--exclude', '2', '--json'])).toEqual({
      db: 'x.db', required: false, exclude: ['1', '2'], json: true,
    });
    expect(parseReplayArgs(['--required', '--db', 'x.db']).required).toBe(true);
  });

  it('a flag without its value is an error, not a silent skip', () => {
    expect(() => parseReplayArgs(['--db'])).toThrow(/--db needs a value/);
    expect(() => parseReplayArgs(['--db', '--required'])).toThrow(/--db needs a value/);
    expect(() => parseReplayArgs(['--db', 'x.db', '--exclude'])).toThrow(/--exclude needs a value/);
    expect(() => parseReplayArgs(['--db', 'x.db', '--exclude', '--json'])).toThrow(/--exclude needs a value/);
  });

  it('no --db, a repeated --db and an unknown flag are errors', () => {
    expect(() => parseReplayArgs([])).toThrow(/usage/);
    expect(() => parseReplayArgs(['--db', 'a', '--db', 'b'])).toThrow(/once/);
    expect(() => parseReplayArgs(['--db', 'a', '--exlude', '1'])).toThrow(/unknown/);
  });
});

describe('copyForReplay', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fp-replay-test-')); return () => rmSync(dir, { recursive: true, force: true }); });

  it('a missing source is an error and creates nothing', async () => {
    const missing = join(dir, 'nope.db');
    await expect(copyForReplay(missing, join(dir, 'copy.db'))).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(dir, 'copy.db'))).toBe(false);
  });

  it('copies through the backup API and leaves the source byte for byte as it was', async () => {
    const src = join(dir, 'src.db');
    const s = openDb(src);
    endedMatch(s, 1, '2026-10-01 20:00:00');
    s.pragma('wal_checkpoint(TRUNCATE)');
    s.close();
    const before = readFileSync(src);
    const copy = await copyForReplay(src, join(dir, 'copy.db'));
    expect((copy.prepare('SELECT COUNT(*) AS n FROM matches').get() as { n: number }).n).toBe(1);
    copy.prepare('DELETE FROM matches').run();
    copy.close();
    expect(readFileSync(src).equals(before)).toBe(true);
  });
});

const FLAG = "INSERT INTO integrity_flags (match_id, steamid, source, kind, severity, at) VALUES (4, ?, 'lilac', 'aimbot', 'suspected', '2026-10-04T19:30:00.000Z')";

describe('drift from the live check (fix round 1)', () => {
  it('an alias of a seeded member is neither a candidate nor counted honest', () => {
    const ALIAS = '76561198000000077';
    db.prepare("INSERT INTO players (steamid, name) VALUES (?, 'm1')").run(M1);
    db.prepare("INSERT INTO player_aliases (steamid, canonical_id, created_at, created_by) VALUES (?, ?, '2026-10-01T00:00:00.000Z', 'x')").run(ALIAS, M1);
    playMatch(db, ALIAS, 4, 10, 80, '2026-10-04T19:00:00.000Z');
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(r.events.map((e) => e.steamid)).toEqual([ALT]);
    expect(r.events.filter((e) => e.honest)).toEqual([]);
  });

  it('a member of a person in the database (not the seed) is not a candidate, unless it is the account under test', () => {
    const OTHER = '76561198000000078';
    db.prepare("INSERT INTO evader_people (id, label, note, created_at, created_by) VALUES (9, 'db', '', '2026-10-01T00:00:00.000Z', 'x')").run();
    for (const id of [OTHER, ALT]) {
      db.prepare("INSERT INTO evader_members (person_id, kind, ident, added_at, added_by, how) VALUES (9, 'steam', ?, '2026-10-01T00:00:00.000Z', 'x', 'manual')").run(id);
    }
    playMatch(db, OTHER, 4, 10, 80, '2026-10-04T19:00:00.000Z');
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect([...new Set(r.events.map((e) => e.steamid))]).toEqual([ALT]);
  });

  it('an account held at match N is not a candidate at match N+1', () => {
    const M2 = '76561198000000002';
    db.prepare("INSERT INTO players (steamid, name) VALUES (?, 'alt')").run(ALT);
    db.prepare(FLAG).run(ALT);
    endedMatch(db, 5, '2026-10-05 20:00:00');
    playMatch(db, M2, 5, 10, 60, '2026-10-05T19:00:00.000Z');
    playMatch(db, ALT, 5, 10, 80, '2026-10-05T19:00:00.000Z');
    const two = [...people, { label: 'shove', steam: [M2] }];
    const r = replayHistory(db, { people: two, exclude: new Set([ALT]), asnLoaded: false });
    expect(r.events.map((e) => [e.matchId, e.person, e.level])).toEqual([[4, 'dethisa', 'hold']]);
  });

  it('a hold live would refuse counts as loud: staff, an open hold by then, or no players row', () => {
    db.prepare(FLAG).run(ALT);
    expect(replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false }).excluded[0].level).toBe('loud');
    db.prepare("INSERT INTO players (steamid, name, is_mod) VALUES (?, 'alt', 1)").run(ALT);
    expect(replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false }).excluded[0].level).toBe('loud');
    db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(ALT);
    db.prepare("INSERT INTO alt_holds (steamid, other_steamid, discord_id, ban_id, created_at) VALUES (?, ?, '', 0, '2026-10-04T10:00:00.000Z')").run(ALT, M1);
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(r.excluded[0].level).toBe('loud');
    expect(r.weeks).toContainEqual({ week: '2026-09-28', alerts: 0, louds: 1, holds: 0, honestAlerts: 0, honestLouds: 0, honestHolds: 0 });
    // A hold placed after the match end does not count yet.
    db.prepare("UPDATE alt_holds SET created_at = '2026-10-05T10:00:00.000Z'").run();
    expect(replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false }).excluded[0].level).toBe('hold');
  });

  it('the limits say candidates come only from base-class bursts', () => {
    expect(REPLAY_LIMITS.join(' ')).toMatch(/base-class bursts/);
  });
});

const P2 = '76561198000000002';
const NEWBIE = '76561198000000005';
const addDbPerson = (id: number, label: string, steam: readonly string[]) => {
  db.prepare("INSERT INTO evader_people (id, label, note, created_at, created_by) VALUES (?, ?, '', '2026-10-01T00:00:00.000Z', 'x')").run(id, label);
  for (const s of steam) {
    db.prepare("INSERT INTO evader_members (person_id, kind, ident, added_at, added_by, how) VALUES (?, 'steam', ?, '2026-10-01T00:00:00.000Z', 'x', 'migrated flag')").run(id, s);
  }
};

describe('every open database person is modelled (final review)', () => {
  it('an open database person the seed does not have produces alerts', () => {
    // P2 plays like M1 and is a member of a migrated person only. NEWBIE
    // then plays like them at match 5: the replay must check NEWBIE against
    // that person, as live fingerprintWorld would.
    for (const m of [1, 2, 3]) playMatch(db, P2, m, 19, 60, `2026-10-0${m}T19:00:00.000Z`);
    addDbPerson(7, 'migrated', [P2]);
    endedMatch(db, 5, '2026-10-05 20:00:00');
    playMatch(db, NEWBIE, 5, 19, 80, '2026-10-05T19:00:00.000Z');
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(r.events.filter((e) => e.person === 'migrated').map((e) => [e.steamid, e.level])).toEqual([[NEWBIE, 'alert']]);
    expect(caughtAs(r, NEWBIE, 'migrated')).toEqual({ level: 'alert', matchId: 5 });
    // The seed alone (no database person) never sees it.
    db.prepare("UPDATE evader_people SET closed_at = '2026-10-02T00:00:00.000Z', closed_by = 'x' WHERE id = 7").run();
    expect(replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false }).events.filter((e) => e.steamid === NEWBIE)).toEqual([]);
  });

  it('seed members merge into the database person of the same label; the account under test stays out', () => {
    addDbPerson(3, 'dethisa', [ALT, '76561198000000011']);
    addDbPerson(4, 'other', ['76561198000000012']);
    expect(replayPeople(db, [{ label: 'dethisa', steam: [M1, ALT] }, { label: 'shove', steam: ['76561198000000099'] }])).toEqual([
      { label: 'dethisa', steam: [ALT, '76561198000000011', M1] },
      { label: 'other', steam: ['76561198000000012'] },
      { label: 'shove', steam: ['76561198000000099'] },
    ]);
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(caughtAs(r, ALT, 'dethisa')).toEqual({ level: 'alert', matchId: 4 });
  });

  it('the limits say what is read as of today and what is not modelled', () => {
    const text = REPLAY_LIMITS.join(' ');
    expect(text).toMatch(/membership \(database persons, aliases and the seed\) is read as of today/);
    expect(text).toMatch(/players-row existence is read as of today/);
    expect(text).toMatch(/cleared .* not modelled/);
    expect(text).toMatch(/replayed hold is never resolved/);
    expect(text).toMatch(/dismissals are live-only/);
  });
});
