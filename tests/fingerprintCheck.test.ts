import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { banPlayer } from '../src/admin/players.js';
import { hasActiveBan } from '../src/banState.js';
import { liftAltHold } from '../src/altHolds.js';
import { setAsnTable } from '../src/asnTable.js';
import { addMember, createPerson } from '../src/evaderPeople.js';
import { checkMatchFingerprints, runFingerprintCheck } from '../src/fingerprintCheck.js';
import { scanEndedMatches } from '../src/inputBursts.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { endedMatch, playMatch, player } from './fingerprintFixtures.js';

const MEMBER = '76561198000000001';
const CAND = '76561198000000002';
const STAFF = '76561198000000009';
const HONEST = [5, 6, 7, 14, 15, 16].map((peak, i) => ({ id: `765611980000001${10 + i}`, peak }));
const NOW = new Date('2026-10-17T21:00:00Z');

let db: DB;
let personId: number;
let events: Extract<AdminEvent, { kind: 'fingerprint_match' }>[];
let off: () => void;

const cheatFlag = () => db.prepare(
  "INSERT INTO integrity_flags (match_id, steamid, source, kind, severity, at) VALUES (900, ?, 'lilac', 'aimbot', 'suspected', '2026-10-17T20:30:00.000Z')",
).run(CAND);

beforeEach(() => {
  db = openDb(':memory:');
  setAsnTable(null);
  for (const id of [MEMBER, CAND, STAFF, ...HONEST.map((h) => h.id)]) player(db, id);
  endedMatch(db, 800, '2026-10-16 20:00:00');
  endedMatch(db, 900, '2026-10-17 20:00:00');
  playMatch(db, MEMBER, 800, 10, 100, '2026-10-16T19:00:00.000Z');
  for (const h of HONEST) playMatch(db, h.id, 800, h.peak, 80, '2026-10-16T19:00:00.000Z');
  playMatch(db, CAND, 900, 10, 80, '2026-10-17T19:00:00.000Z');
  personId = createPerson(db, 'dethisa', '', STAFF);
  addMember(db, personId, 'steam', MEMBER, STAFF, 'seed');
  setSetting(db, 'evader_fingerprint', 'alert');
  events = [];
  off = subscribeAdminEvents((e) => { if (e.kind === 'fingerprint_match') events.push(e); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { off(); vi.restoreAllMocks(); });

describe('checkMatchFingerprints', () => {
  it('does nothing while the setting is off', () => {
    setSetting(db, 'evader_fingerprint', 'off');
    expect(checkMatchFingerprints(db, 900, NOW)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('alerts on a fingerprint alone, once, and holds nobody', () => {
    const [o] = checkMatchFingerprints(db, 900, NOW);
    expect(o).toMatchObject({ steamid: CAND, personId, level: 'alert', signs: [], holdId: null });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ personLabel: 'dethisa', rank: 1, distance: 0, threshold: 0.25, matchId: 900 });
    expect(events[0].medians.map((m) => m.cls)).toEqual(['hunter claw', 'hunter air attack']);
    expect(hasActiveBan(db, CAND)).toBe(false);
    expect(checkMatchFingerprints(db, 900, NOW)).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('in alert mode, a fingerprint with a second sign is loud, never a hold', () => {
    cheatFlag();
    const [o] = checkMatchFingerprints(db, 900, NOW);
    expect(o).toMatchObject({ level: 'loud', signs: ['cheat_flag'], holdId: null });
    expect(hasActiveBan(db, CAND)).toBe(false);
  });

  it('in full mode, a fingerprint with a second sign holds the account', () => {
    setSetting(db, 'evader_fingerprint', 'full');
    cheatFlag();
    const [o] = checkMatchFingerprints(db, 900, NOW);
    expect(o.level).toBe('hold');
    expect(o.holdId).toEqual(expect.any(Number));
    expect(hasActiveBan(db, CAND)).toBe(true);
    expect(events[0]).toMatchObject({ level: 'hold', holdId: o.holdId });
  });

  it('fires again only when the level goes up', () => {
    expect(checkMatchFingerprints(db, 900, NOW)[0].level).toBe('alert');
    cheatFlag();
    setSetting(db, 'evader_fingerprint', 'full');
    expect(checkMatchFingerprints(db, 900, NOW)[0].level).toBe('hold');
    expect(events.map((e) => e.level)).toEqual(['alert', 'hold']);
  });

  it('a released fingerprint hold stays released when the account plays again', () => {
    setSetting(db, 'evader_fingerprint', 'full');
    cheatFlag();
    const [o] = checkMatchFingerprints(db, 900, NOW);
    liftAltHold(db, o.holdId!, STAFF, new Date('2026-10-17T20:50:00Z'));
    endedMatch(db, 901, '2026-10-17 20:40:00');
    playMatch(db, CAND, 901, 10, 80, '2026-10-17T20:30:00.000Z');
    expect(checkMatchFingerprints(db, 901, NOW)).toEqual([]);
    expect(hasActiveBan(db, CAND)).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('posts loud when the hold is refused (staff)', () => {
    setSetting(db, 'evader_fingerprint', 'full');
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(CAND);
    cheatFlag();
    expect(checkMatchFingerprints(db, 900, NOW)[0]).toMatchObject({ level: 'loud', holdId: null });
  });

  it('skips established players and banned ones', () => {
    for (let i = 0; i < 15; i++) {
      endedMatch(db, 100 + i, '2026-09-01 20:00:00');
      db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(100 + i, CAND);
    }
    db.prepare("UPDATE players SET created_at = '2026-08-01 00:00:00' WHERE steamid = ?").run(CAND);
    expect(checkMatchFingerprints(db, 900, NOW)).toEqual([]);
    db.prepare('DELETE FROM match_players WHERE player_id = ?').run(CAND);
    // Dated before NOW: the check reads bans as of the moment it answers for.
    banPlayer(db, CAND, STAFF, 'toxic', null, new Date('2026-10-17T10:00:00Z'));
    expect(checkMatchFingerprints(db, 900, NOW)).toEqual([]);
  });

  it('a person with no Steam accounts or no data is skipped without a fuss', () => {
    const ghost = createPerson(db, 'ghost', '', STAFF);
    addMember(db, ghost, 'discord', '286250932470153217', STAFF, 'manual');
    createPerson(db, 'empty', '', STAFF);
    const out = checkMatchFingerprints(db, 900, NOW);
    expect(out.map((o) => o.personId)).toEqual([personId]);
  });

  it('a person whose Steam account has no infected holds is skipped too', () => {
    const quiet = createPerson(db, 'quiet', '', STAFF);
    addMember(db, quiet, 'steam', STAFF, STAFF, 'manual');
    const out = checkMatchFingerprints(db, 900, NOW);
    expect(out.map((o) => o.personId)).toEqual([personId]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM alt_holds WHERE other_steamid = ''").get()).toEqual({ n: 0 });
  });
});

describe('wiring', () => {
  it('runFingerprintCheck logs a failure and returns nothing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DROP TABLE fingerprint_cache');
    expect(runFingerprintCheck(db, 900, NOW)).toEqual([]);
    expect(String(err.mock.calls[0]?.[0])).toContain('fingerprint check failed for match 900');
  });

  it('the end-of-match sweep hands each newly ended match to the hook once', () => {
    const seen: number[] = [];
    scanEndedMatches(db, undefined, NOW, undefined, (id) => seen.push(id));
    scanEndedMatches(db, undefined, NOW, undefined, (id) => seen.push(id));
    expect(seen).toEqual([900]); // 800 ended more than six hours before NOW
  });

  it('a failing check on one match does not stop the sweep reaching the next', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    endedMatch(db, 902, '2026-10-17 20:30:00');
    playMatch(db, CAND, 902, 10, 80, '2026-10-17T20:10:00.000Z');
    db.exec('DROP TABLE fingerprint_cache');
    const seen: number[] = [];
    scanEndedMatches(db, undefined, NOW, undefined, (id) => { seen.push(id); runFingerprintCheck(db, id, NOW); });
    expect(seen.sort()).toEqual([900, 902]);
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([
      expect.stringContaining('fingerprint check failed for match 900'),
      expect.stringContaining('fingerprint check failed for match 902'),
    ]));
  });
});
