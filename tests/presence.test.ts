import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { getPresence, recordPresenceLine, remainingNow } from '../src/presence.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const STRANGER = '76561199000000099';
const TOKEN = 'a'.repeat(32);
const at = (s: number) => new Date(Date.UTC(2026, 8, 21, 20, 0, s));
let db: DB;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const p of [...IDS, STRANGER]) { upsertPlayer(db, { steamid: p, name: `p${p.slice(-2)}`, avatar: null }, []); activatePlayer(db, p); }
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'dead_air', ?)").run(TOKEN).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(matchId, p, i < 4 ? 'a' : 'b'));
});

const leave = (remaining: number, extra: object = {}) => ({ kind: 'leave' as const, token: TOKEN, steamid: IDS[2], remaining, ...extra });
const back = (remaining: number) => ({ kind: 'return' as const, token: TOKEN, steamid: IDS[2], remaining });
const player = (event: 'connect' | 'disconnect', steamid = IDS[2]) => ({ kind: 'player' as const, token: TOKEN, steamid, event });
const row = () => getPresence(db, matchId, IDS[2])!;

describe('LEAVE, RETURN and connect', () => {
  it('a connect makes a connected row, and the map change pulse changes nothing', () => {
    expect(recordPresenceLine(db, player('connect'), at(0))).toMatchObject({ changed: true });
    expect(row()).toMatchObject({ state: 'connected', since: at(0).toISOString(), remaining_s: null, held: 0 });
    expect(recordPresenceLine(db, player('disconnect'), at(30))).toBeNull();
    expect(recordPresenceLine(db, player('connect'), at(60))).toMatchObject({ changed: false });
    expect(row().since).toBe(at(0).toISOString());
  });

  it('a LEAVE drops them with the allowance, and it counts down from there', () => {
    recordPresenceLine(db, player('connect'), at(0));
    recordPresenceLine(db, leave(300), at(10));
    expect(row()).toMatchObject({ state: 'dropped', since: at(10).toISOString(), remaining_s: 300, remaining_at: at(10).toISOString(), held: 0 });
    expect(remainingNow(row(), at(40))).toBe(270);
    expect(remainingNow(row(), at(999))).toBe(0);
  });

  it('a RETURN brings them back with what is left', () => {
    recordPresenceLine(db, leave(300), at(10));
    recordPresenceLine(db, back(254), at(56));
    expect(row()).toMatchObject({ state: 'connected', since: at(56).toISOString(), remaining_s: 254, held: 0, hold_until: null });
    expect(remainingNow(row(), at(500))).toBe(254);
  });

  it('a connect with the RETURN lost still brings them back, with the arithmetic done here', () => {
    recordPresenceLine(db, leave(300), at(10));
    recordPresenceLine(db, player('connect'), at(40));
    expect(row()).toMatchObject({ state: 'connected', remaining_s: 270 });
  });

  it('a duplicated datagram is not a change and does not move the anchor', () => {
    recordPresenceLine(db, leave(300), at(10));
    expect(recordPresenceLine(db, leave(300), at(13))).toMatchObject({ changed: false });
    expect(row().remaining_at).toBe(at(10).toISOString());
  });
});

describe('a hold', () => {
  it('stops the countdown, keeps when they left, and knows when it ends', () => {
    recordPresenceLine(db, leave(300), at(10));
    recordPresenceLine(db, leave(260, { held: true, holdLeft: 1800 }), at(50));
    expect(row()).toMatchObject({
      state: 'dropped', since: at(10).toISOString(), remaining_s: 260, held: 1,
      hold_until: new Date(at(50).getTime() + 1800_000).toISOString(),
    });
    expect(remainingNow(row(), at(59))).toBe(260);
  });

  it('falls back to the setting when the line gives no hold_left', () => {
    setSetting(db, 'clock_hold_max_minutes', '10');
    recordPresenceLine(db, leave(260, { held: true }), at(50));
    expect(row().hold_until).toBe(new Date(at(50).getTime() + 600_000).toISOString());
  });

  it('a release resumes from the moment of the release, and reports the transition', () => {
    recordPresenceLine(db, leave(260, { held: true, holdLeft: 1800 }), at(50));
    expect(recordPresenceLine(db, leave(260, { held: false, holdLeft: 0, auto: true }), at(59)))
      .toEqual({ matchId, changed: true, holdReleased: true });
    expect(row()).toMatchObject({ held: 0, hold_until: null, remaining_at: at(59).toISOString() });
    expect(remainingNow(row(), at(69))).toBe(250);
  });

  it('keeps the once per drop alert stamp across a hold, and clears it on the next drop', () => {
    recordPresenceLine(db, leave(80), at(10));
    db.prepare('UPDATE match_presence SET low_alert_at = ? WHERE match_id = ?').run(at(11).toISOString(), matchId);
    recordPresenceLine(db, leave(79, { held: true, holdLeft: 1800 }), at(12));
    expect(row().low_alert_at).toBe(at(11).toISOString());
    recordPresenceLine(db, back(79), at(20));
    recordPresenceLine(db, leave(79), at(30));
    expect(row().low_alert_at).toBeNull();
  });
});

describe('what is ignored', () => {
  it('an id that is not on the roster', () => {
    expect(recordPresenceLine(db, { ...leave(300), steamid: STRANGER }, at(10))).toBeNull();
    expect(getPresence(db, matchId, STRANGER)).toBeUndefined();
  });

  it('a token with no ongoing match', () => {
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);
    expect(recordPresenceLine(db, leave(300), at(10))).toBeNull();
  });

  it('a configuring match counts as ongoing', () => {
    db.prepare("UPDATE matches SET state = 'configuring' WHERE id = ?").run(matchId);
    expect(recordPresenceLine(db, player('connect'), at(0))).toMatchObject({ changed: true });
  });
});
