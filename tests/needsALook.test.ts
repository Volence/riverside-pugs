import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { markLookedAt } from '../src/admin/reviews.js';
import { needsALook } from '../src/admin/needsALook.js';

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
