import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { getPresence, recordPresenceLine, sweepPresence } from '../src/presence.js';

const ID = '76561199000000002';
const TOKEN = 'a'.repeat(32);
const at = (s: number) => new Date(Date.UTC(2026, 8, 21, 20, 0, 0) + s * 1000);
let db: DB;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: ID, name: 'bob', avatar: null }, []);
  activatePlayer(db, ID);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'dead_air', ?)").run(TOKEN).lastInsertRowid);
  db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(matchId, ID);
});

const leave = (remaining: number, extra: object = {}) => ({ kind: 'leave' as const, token: TOKEN, steamid: ID, remaining, ...extra });

describe('the low allowance warning', () => {
  it('fires when the allowance crosses the line, and only once for that drop', () => {
    recordPresenceLine(db, leave(300), at(0));
    expect(sweepPresence(db, at(200))).toEqual([]);
    expect(sweepPresence(db, at(215))).toEqual([{ what: 'low_allowance', matchId, steamid: ID, remainingS: 85 }]);
    expect(sweepPresence(db, at(220))).toEqual([]);
  });

  it('survives a restart: the stamp is in the table, not in memory', () => {
    recordPresenceLine(db, leave(300), at(0));
    sweepPresence(db, at(215));
    expect(getPresence(db, matchId, ID)!.low_alert_at).toBe(at(215).toISOString());
    // Nothing but the database carries over a restart, and the next sweep
    // after one reads the same row.
    expect(sweepPresence(db, at(216))).toEqual([]);
  });

  it('fires late rather than never, when the crossing happened while the backend was down', () => {
    recordPresenceLine(db, leave(300), at(0));
    expect(sweepPresence(db, at(280))).toEqual([{ what: 'low_allowance', matchId, steamid: ID, remainingS: 20 }]);
  });

  it('fires straight away for a second drop that starts under the line, and again for a later drop', () => {
    recordPresenceLine(db, leave(40), at(0));
    expect(sweepPresence(db, at(1))).toHaveLength(1);
    recordPresenceLine(db, { kind: 'return', token: TOKEN, steamid: ID, remaining: 30 }, at(10));
    recordPresenceLine(db, leave(30), at(60));
    expect(sweepPresence(db, at(61))).toEqual([{ what: 'low_allowance', matchId, steamid: ID, remainingS: 29 }]);
  });

  it('says nothing while held, at zero, when turned off, or once the match is over', () => {
    recordPresenceLine(db, leave(80, { held: true, holdLeft: 1800 }), at(0));
    expect(sweepPresence(db, at(5))).toEqual([]);

    recordPresenceLine(db, leave(80, { held: false, holdLeft: 0 }), at(10));
    expect(sweepPresence(db, at(500))).toEqual([]);

    setSetting(db, 'abandon_low_alert_seconds', '0');
    expect(sweepPresence(db, at(20))).toEqual([]);

    setSetting(db, 'abandon_low_alert_seconds', '90');
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
    expect(sweepPresence(db, at(20))).toEqual([]);
  });
});

describe('a hold that reaches its ceiling', () => {
  it('is released here when the plugin\'s own line about it never arrives, and the clock resumes from the ceiling', () => {
    recordPresenceLine(db, leave(200, { held: true, holdLeft: 60 }), at(0));
    expect(sweepPresence(db, at(61))).toEqual([]);
    expect(sweepPresence(db, at(63))).toEqual([{ what: 'hold_expired', matchId, steamid: ID, remainingS: 197 }]);
    expect(getPresence(db, matchId, ID)).toMatchObject({ held: 0, hold_until: null, remaining_at: at(60).toISOString() });
    expect(sweepPresence(db, at(70))).toEqual([]);
  });

  it('is not announced twice when the plugin\'s line got here first', () => {
    recordPresenceLine(db, leave(200, { held: true, holdLeft: 60 }), at(0));
    expect(recordPresenceLine(db, leave(200, { held: false, holdLeft: 0, auto: true }), at(60))).toMatchObject({ holdReleased: true });
    expect(sweepPresence(db, at(63))).toEqual([]);
  });

  it('can release and warn in the same pass', () => {
    recordPresenceLine(db, leave(50, { held: true, holdLeft: 60 }), at(0));
    expect(sweepPresence(db, at(65)).map((e) => e.what)).toEqual(['hold_expired', 'low_allowance']);
  });
});
