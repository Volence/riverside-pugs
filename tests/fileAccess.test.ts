import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { canDo, canOpenFile, fileActions, fileViewer } from '../src/admin/fileAccess.js';

const PLAYER = '76561199000000001';
const ALT = '76561199000000002';
const MOD = '76561199000000003';
const MOD2 = '76561199000000004';
const ADMIN = '76561199000000005';
const NOBODY = '76561199000000006';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [PLAYER, ALT, MOD, MOD2, ADMIN, NOBODY]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

describe('who may open a file', () => {
  it('admins open anything, including their own and another admin\'s', () => {
    const v = fileViewer(db, ADMIN);
    expect(v).toEqual({ steamid: ADMIN, isAdmin: true, isMod: false });
    for (const target of [PLAYER, MOD, ADMIN]) expect(canOpenFile(db, v, target)).toBe(true);
  });

  it('a moderator opens players but never themselves or other staff', () => {
    const v = fileViewer(db, MOD);
    expect(canOpenFile(db, v, PLAYER)).toBe(true);
    expect(canOpenFile(db, v, MOD)).toBe(false);
    expect(canOpenFile(db, v, MOD2)).toBe(false);
    expect(canOpenFile(db, v, ADMIN)).toBe(false);
  });

  it('a moderator cannot reach their own file through a merged second account', () => {
    addAlias(db, { steamid: ALT, canonical: MOD, by: 'test' });
    expect(canOpenFile(db, fileViewer(db, MOD), ALT)).toBe(false);
    // And a merged alt of a plain player is still that player's file.
    expect(canOpenFile(db, fileViewer(db, ADMIN), ALT)).toBe(true);
  });

  it('anybody else opens nothing', () => {
    expect(canOpenFile(db, fileViewer(db, NOBODY), PLAYER)).toBe(false);
    expect(fileActions(db, fileViewer(db, NOBODY), PLAYER)).toEqual([]);
  });
});

describe('what a viewer may do on a file', () => {
  it('a moderator writes notes, marks it looked at and opens a ticket, and nothing else', () => {
    const v = fileViewer(db, MOD);
    expect(fileActions(db, v, PLAYER)).toEqual(['note', 'looked_at', 'open_ticket']);
    for (const action of ['note', 'looked_at', 'open_ticket'] as const) {
      expect(canDo(db, v, PLAYER, action)).toBe(true);
    }
    for (const action of ['ban', 'timeout', 'merge', 'sign_out', 'waive', 'staff_flags', 'review_round'] as const) {
      expect(canDo(db, v, PLAYER, action)).toBe(false);
    }
  });

  it('an admin may do all of it, and nobody may act on a file they cannot open', () => {
    const admin = fileViewer(db, ADMIN);
    expect(canDo(db, admin, PLAYER, 'ban')).toBe(true);
    expect(canDo(db, admin, PLAYER, 'merge')).toBe(true);
    expect(canDo(db, fileViewer(db, MOD), ADMIN, 'note')).toBe(false);
  });

  it('review_round is admin-only', () => {
    expect(fileActions(db, fileViewer(db, ADMIN), PLAYER)).toContain('review_round');
    expect(fileActions(db, fileViewer(db, MOD), PLAYER)).not.toContain('review_round');
    expect(canDo(db, fileViewer(db, MOD), PLAYER, 'review_round')).toBe(false);
  });
});
