import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  LILAC_CHEATS, cheatName, flagsForPlayer, liveMatchOf, recentFlags, recordIntegrityFlag,
} from '../src/integrityFlags.js';
import { addServer } from '../src/serverPool.js';

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

// Which match a flag or a burst is evidence about. It used to be "the newest
// live match on that server", whoever was in it, so a spectator's flag was
// filed on a match they were not playing, and a stale live match on the same
// box took evidence that belonged to the real one.
describe('liveMatchOf', () => {
  const B = '76561198000000002';
  let server: number;
  const match = (id: number, state: string, serverId: number, players: string[]): void => {
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id) VALUES (?, 1, ?, 'dead_air', ?)")
      .run(id, state, serverId);
    for (const p of players) {
      db.prepare("INSERT OR IGNORE INTO players (steamid, name) VALUES (?, 'p')").run(p);
      db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(id, p);
    }
  };
  beforeEach(() => {
    server = addServer(db, { name: 'one', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  });

  it('is the live match on that server the player is rostered in', () => {
    match(1, 'live', server, [A]);
    expect(liveMatchOf(db, server, A)).toBe(1);
  });

  it('is not a live match the player is not in', () => {
    match(1, 'live', server, [B]);
    expect(liveMatchOf(db, server, A)).toBeNull();
  });

  it('passes over a newer live match on the box for the one the player is in', () => {
    match(1, 'live', server, [A]);
    match(2, 'live', server, [B]);
    expect(liveMatchOf(db, server, A)).toBe(1);
    expect(liveMatchOf(db, server, B)).toBe(2);
  });

  it('is not a match that is over, or one on another server', () => {
    const other = addServer(db, { name: 'two', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    match(1, 'completed', server, [A]);
    match(2, 'live', other, [A]);
    expect(liveMatchOf(db, server, A)).toBeNull();
  });

  it('is nothing when the server is unknown', () => {
    match(1, 'live', server, [A]);
    expect(liveMatchOf(db, null, A)).toBeNull();
  });
});
