import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caughtAs, copyForReplay, parseReplayArgs, replayHistory, weekOf, REPLAY_LIMITS } from '../src/fingerprintReplay.js';
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
    expect(r.weeks).toContainEqual({ week: '2026-09-28', alerts: 1, holds: 0, honestAlerts: 0, honestHolds: 0 });
    expect(r.honestTop5Rate === null || (r.honestTop5Rate >= 0 && r.honestTop5Rate <= 1)).toBe(true);
  });

  it('a second sign seen by then makes it a hold', () => {
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
