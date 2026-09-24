import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { markLookedAt } from '../src/admin/reviews.js';
import { everyoneMeasured, needsALook } from '../src/admin/needsALook.js';
import { ANALYZER_VERSION } from '../src/integrity/store.js';
import { TUNING } from '../src/integrity/constants.js';

const P = '76561199000000001';
const ALT = '76561199000000002';
const MOD = '76561199000000003';
const ADMIN = '76561199000000005';
const STRANGER = '76561198005192651';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, ALT, MOD, ADMIN]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

const flag = (steamid: string, at: string) =>
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (NULL, 1, ?, 'lilac', 'aimbot', 'suspected', '', ?)`,
  ).run(steamid, at);

const drop = (steamid: string, at: string) =>
  db.prepare(
    `INSERT INTO signon_drops (steamid, name, secs_connected, forced_count, at, entered_after_at)
     VALUES (?, 'n', 5, 651, ?, NULL)`,
  ).run(steamid, at);

describe('Needs a look', () => {
  it('lists a player with new evidence, drops them once reviewed, and brings them back when something newer arrives', () => {
    const admin = fileViewer(db, ADMIN);
    flag(P, '2026-09-20T10:00:00.000Z');
    expect(needsALook(db, admin).map((r) => r.steamid)).toEqual([P]);
    expect(needsALook(db, admin)[0].sources).toEqual(['lilac']);
    expect(needsALook(db, admin)[0].arrived).toMatch(/^Little Anti-Cheat: /);

    markLookedAt(db, P, ADMIN, '', new Date('2026-09-20T11:00:00.000Z'));
    expect(needsALook(db, admin)).toEqual([]);

    flag(P, '2026-09-21T10:00:00.000Z');
    const back = needsALook(db, admin);
    expect(back).toHaveLength(1);
    expect(back[0].newestEvidenceAt).toBe('2026-09-21T10:00:00.000Z');
    expect(back[0].lastReviewAt).toBe('2026-09-20T11:00:00.000Z');
    expect(back[0].lastReviewBy).toBe('p005');
  });

  it('one connect drop lists nobody, a repeat lists them', () => {
    const admin = fileViewer(db, ADMIN);
    drop(P, '2026-09-20T10:00:00.000Z');
    expect(needsALook(db, admin)).toEqual([]);
    drop(P, '2026-09-20T10:04:00.000Z');
    expect(needsALook(db, admin).map((r) => r.sources)).toEqual([['drop']]);
  });

  it('counts evidence held under a merged second account as the main account\'s', () => {
    flag(ALT, '2026-09-20T10:00:00.000Z');
    addAlias(db, { steamid: ALT, canonical: P, by: 'test' });
    expect(needsALook(db, fileViewer(db, ADMIN)).map((r) => r.steamid)).toEqual([P]);
  });

  it('never lists a moderator their own file or another member of staff', () => {
    flag(MOD, '2026-09-20T10:00:00.000Z');
    flag(ADMIN, '2026-09-20T10:00:00.000Z');
    flag(P, '2026-09-20T10:00:00.000Z');
    expect(needsALook(db, fileViewer(db, MOD)).map((r) => r.steamid)).toEqual([P]);
    expect(needsALook(db, fileViewer(db, ADMIN)).map((r) => r.steamid).sort())
      .toEqual([MOD, ADMIN, P].sort());
  });

  it('leaves off an id that has never signed in here, because it has no file to open', () => {
    flag(STRANGER, '2026-09-20T10:00:00.000Z');
    expect(needsALook(db, fileViewer(db, ADMIN))).toEqual([]);
  });
});

/** `observed` on-target blocks out of 40 that the prior expects 4 of, as the
 *  board's own fixtures write them. */
const metrics = (fidMax: number, observed: number) =>
  JSON.stringify({
    fidMax, fidP95: fidMax / 2, windows: 12, scoreable: 10, fidSum: fidMax * 5, eligiblePairs: 200,
    occ: { observed, expected: 4, expectedSq: 0.4, blocks: 40, pairs: 200 },
    gates: { considered: 600, notLive: 50, notGhost: 150, inGrace: 100, tooClose: 50, occluded: 50, passed: 200 },
  });

/** Analysed rounds for one player, with no clip and nothing else attached:
 *  the case the retired board listed and nothing else does. */
function measure(steamid: string, slot: number, rounds: number, fidMax: number) {
  db.prepare("INSERT OR IGNORE INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'farm')").run();
  const ins = db.prepare(
    `INSERT INTO integrity_rounds (match_id, ordinal, half, slot, steamid, analyzer_version, metrics, computed_at)
     VALUES (1, ?, 1, ?, ?, ?, ?, datetime('now'))`,
  );
  const prior = db.prepare(
    `INSERT OR IGNORE INTO integrity_prior_rounds (match_id, ordinal, half, frames, counts, map, analyzer_version)
     VALUES (1, ?, 1, 100, '[]', 'l4d_vs_farm01_hilltop', ?)`,
  );
  for (let ordinal = 1; ordinal <= rounds; ordinal++) {
    ins.run(ordinal, slot, steamid, ANALYZER_VERSION, metrics(fidMax, Math.round(fidMax * 12)));
    prior.run(ordinal, ANALYZER_VERSION);
  }
}

describe('everyone the analyzer has measured', () => {
  it('lists a ranked player who has no flagged clip and nothing waiting to be read', () => {
    measure(P, 0, TUNING.MIN_BOARD_ROUNDS, 0.9);
    measure(ALT, 1, TUNING.MIN_BOARD_ROUNDS, 0.2);

    expect(needsALook(db, fileViewer(db, ADMIN))).toEqual([]);
    const measured = everyoneMeasured(db, fileViewer(db, ADMIN));
    expect(measured.map((m) => m.steamid).sort()).toEqual([P, ALT].sort());
    const p = measured.find((m) => m.steamid === P)!;
    expect(p).toMatchObject({ name: 'p001', ranked: true, of: 2, clips: 0 });
    expect(p.rank).toBe(1);
  });

  it('carries an unranked player with ranked false rather than a rank of nothing', () => {
    measure(P, 0, 1, 0.9);
    const [only] = everyoneMeasured(db, fileViewer(db, ADMIN));
    expect(only).toMatchObject({ steamid: P, ranked: false, rank: null, of: 0 });
  });

  it('never shows a moderator a colleague, themselves, or an id with no player row', () => {
    measure(P, 0, TUNING.MIN_BOARD_ROUNDS, 0.9);
    measure(MOD, 1, TUNING.MIN_BOARD_ROUNDS, 0.8);
    measure(ADMIN, 2, TUNING.MIN_BOARD_ROUNDS, 0.7);
    measure(STRANGER, 3, TUNING.MIN_BOARD_ROUNDS, 0.6);

    expect(everyoneMeasured(db, fileViewer(db, MOD)).map((m) => m.steamid)).toEqual([P]);
    expect(everyoneMeasured(db, fileViewer(db, ADMIN)).map((m) => m.steamid).sort())
      .toEqual([P, MOD, ADMIN].sort());
  });
});
