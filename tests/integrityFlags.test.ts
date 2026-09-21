import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  LILAC_CHEATS, cheatName, flagsForPlayer, recentFlags, recordIntegrityFlag,
} from '../src/integrityFlags.js';

const A = '76561198030413993';
let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('cheatName', () => {
  // The numbers are LilAC's Lilac_DetectionType, whose own header says in
  // capitals not to change them because forwards depend on them. So the mapping
  // is pinned by test: if upstream ever renumbers, this fails loudly rather than
  // silently relabelling one cheat as another in the admin list.
  it('maps every LilAC detection number to its name', () => {
    expect(cheatName(0)).toBe('angles');
    expect(cheatName(4)).toBe('bhop');
    expect(cheatName(5)).toBe('aimbot');
    expect(cheatName(6)).toBe('aimlock');
    expect(cheatName(9)).toBe('macro');
    expect(Object.keys(LILAC_CHEATS)).toHaveLength(11);
  });

  it('does not invent a name for a number it does not know', () => {
    expect(cheatName(11)).toBe('unknown(11)');
    expect(cheatName(-1)).toBe('unknown(-1)');
  });
});

describe('recordIntegrityFlag', () => {
  const flag = (over = {}) => ({
    matchId: 7, serverId: 1, steamid: A, source: 'lilac',
    kind: 'aimbot', severity: 'suspected' as const, detail: '', ...over,
  });

  it('stores a flag and reads it back for the player', () => {
    recordIntegrityFlag(db, flag());
    const rows = flagsForPlayer(db, A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'lilac', kind: 'aimbot', severity: 'suspected' });
  });

  it('keeps a ban separate from a suspicion', () => {
    recordIntegrityFlag(db, flag());
    recordIntegrityFlag(db, flag({ severity: 'banned' }));
    const rows = flagsForPlayer(db, A);
    expect(rows.map((r) => r.severity).sort()).toEqual(['banned', 'suspected']);
  });

  // LilAC fires repeatedly while a cheat is active, so one player in one round
  // can produce a long run of identical flags. The admin list wants the event,
  // not every repetition of it.
  it('collapses a repeat of the same kind within the dedupe window', () => {
    const t0 = new Date('2026-09-21T12:00:00.000Z');
    recordIntegrityFlag(db, flag(), t0);
    recordIntegrityFlag(db, flag(), new Date(t0.getTime() + 5_000));
    expect(flagsForPlayer(db, A)).toHaveLength(1);
  });

  it('keeps a repeat once the window has passed', () => {
    const t0 = new Date('2026-09-21T12:00:00.000Z');
    recordIntegrityFlag(db, flag(), t0);
    recordIntegrityFlag(db, flag(), new Date(t0.getTime() + 10 * 60_000));
    expect(flagsForPlayer(db, A)).toHaveLength(2);
  });

  it('does not collapse two different cheats', () => {
    const t0 = new Date('2026-09-21T12:00:00.000Z');
    recordIntegrityFlag(db, flag({ kind: 'aimbot' }), t0);
    recordIntegrityFlag(db, flag({ kind: 'bhop' }), new Date(t0.getTime() + 1000));
    expect(flagsForPlayer(db, A)).toHaveLength(2);
  });
});

describe('recentFlags', () => {
  it('lists newest first across players', () => {
    const t0 = new Date('2026-09-21T12:00:00.000Z');
    recordIntegrityFlag(db, { matchId: 1, serverId: 1, steamid: A, source: 'lilac', kind: 'bhop', severity: 'suspected', detail: '' }, t0);
    recordIntegrityFlag(db, { matchId: 1, serverId: 1, steamid: '76561198000000002', source: 'lilac', kind: 'aimbot', severity: 'banned', detail: '' }, new Date(t0.getTime() + 60_000));
    const rows = recentFlags(db, 10);
    expect(rows[0].kind).toBe('aimbot');
    expect(rows[1].kind).toBe('bhop');
  });
});

describe('integrityPlayer', () => {
  it('returns flags as their own list, not mixed into clips', async () => {
    const { integrityPlayer } = await import('../src/admin/integrity.js');
    recordIntegrityFlag(db, {
      matchId: null, serverId: 1, steamid: A, source: 'lilac',
      kind: 'aimlock', severity: 'banned', detail: '',
    });
    const out = integrityPlayer(db, A);
    expect(out.clips).toEqual([]);
    expect(out.flags).toHaveLength(1);
    expect(out.flags[0].kind).toBe('aimlock');
  });
});
