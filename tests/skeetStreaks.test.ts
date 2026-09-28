import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { findSkeetStreaks, STREAK_MIN, STREAK_WINDOW_MS } from '../src/skeetStreaks.js';

const PID = 'STEAM_0:0:1';

let db: DB; let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run().lastInsertRowid);
});

/** Inserts one skeet event per time given, on the same actor/map/half unless
 *  overridden. seq just needs to be unique within the match. */
function skeet(times: number[], over: { actor?: string; mapOrdinal?: number; half?: number; seqStart?: number } = {}): void {
  const { actor = PID, mapOrdinal = 3, half = 1, seqStart = 0 } = over;
  const ins = db.prepare(
    'INSERT INTO match_live_events (match_id, map_ordinal, seq, kind, actor, target, half, t_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  times.forEach((t, i) => ins.run(matchId, mapOrdinal, seqStart + i, 'skeet', actor, null, half, t));
}

describe('findSkeetStreaks', () => {
  it('constants match the brief', () => {
    expect(STREAK_WINDOW_MS).toBe(5000);
    expect(STREAK_MIN).toBe(3);
  });

  it('finds a real triple (match 61: VII map 3 half 1)', () => {
    skeet([248080, 248940, 251940]);
    expect(findSkeetStreaks(db, matchId)).toEqual([
      { matchId, steamid: PID, mapOrdinal: 3, half: 1, tMs: 248080, count: 3, spanMs: 3860 },
    ]);
  });

  it('finds a real triple (match 230)', () => {
    skeet([243450, 244190, 245150]);
    expect(findSkeetStreaks(db, matchId)).toEqual([
      { matchId, steamid: PID, mapOrdinal: 3, half: 1, tMs: 243450, count: 3, spanMs: 1700 },
    ]);
  });

  it('does not count 3 skeets spread over more than the window', () => {
    skeet([0, 2000, 5001]);
    expect(findSkeetStreaks(db, matchId)).toEqual([]);
  });

  it('reports 4 within the window as one streak of 4, not two triples', () => {
    skeet([0, 1000, 2000, 3000]);
    expect(findSkeetStreaks(db, matchId)).toEqual([
      { matchId, steamid: PID, mapOrdinal: 3, half: 1, tMs: 0, count: 4, spanMs: 3000 },
    ]);
  });

  it('splits 6 skeets each within 5s of the last into two triples when the whole run spans 9s', () => {
    // Consecutive gaps are all <= 5s (2s,2s,2s,2s,1s), but the greedy scan
    // anchors its window on the run's first skeet, not the previous one, so
    // once t[j] - t[i] would exceed 5s the run closes and a new one starts
    // from the next skeet rather than growing into one 6-streak.
    skeet([0, 2000, 4000, 6000, 8000, 9000]);
    expect(findSkeetStreaks(db, matchId)).toEqual([
      { matchId, steamid: PID, mapOrdinal: 3, half: 1, tMs: 0, count: 3, spanMs: 4000 },
      { matchId, steamid: PID, mapOrdinal: 3, half: 1, tMs: 6000, count: 3, spanMs: 3000 },
    ]);
  });

  it('never combines skeets from different halves', () => {
    skeet([0, 1000, 2000], { half: 1, seqStart: 0 });
    skeet([100, 1100, 2100], { half: 2, seqStart: 10 });
    expect(findSkeetStreaks(db, matchId)).toHaveLength(2);
  });

  it('never combines skeets from different maps', () => {
    skeet([0, 1000, 2000], { mapOrdinal: 1, seqStart: 0 });
    skeet([100, 1100, 2100], { mapOrdinal: 2, seqStart: 10 });
    expect(findSkeetStreaks(db, matchId)).toHaveLength(2);
  });

  it('never combines skeets from different actors', () => {
    skeet([0, 1000, 2000], { actor: PID, seqStart: 0 });
    skeet([100, 1100, 2100], { actor: 'STEAM_0:0:2', seqStart: 10 });
    expect(findSkeetStreaks(db, matchId)).toHaveLength(2);
  });

  it('ignores events with an unknown time (t_ms -1)', () => {
    skeet([-1, -1, 0, 1000, 2000]);
    expect(findSkeetStreaks(db, matchId)).toEqual([
      { matchId, steamid: PID, mapOrdinal: 3, half: 1, tMs: 0, count: 3, spanMs: 2000 },
    ]);
  });

  it('ignores events from a different match', () => {
    const other = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run().lastInsertRowid);
    db.prepare('INSERT INTO match_live_events (match_id, map_ordinal, seq, kind, actor, half, t_ms) VALUES (?, 3, 0, ?, ?, 1, 0)')
      .run(other, 'skeet', PID);
    db.prepare('INSERT INTO match_live_events (match_id, map_ordinal, seq, kind, actor, half, t_ms) VALUES (?, 3, 1, ?, ?, 1, 1000)')
      .run(other, 'skeet', PID);
    db.prepare('INSERT INTO match_live_events (match_id, map_ordinal, seq, kind, actor, half, t_ms) VALUES (?, 3, 2, ?, ?, 1, 2000)')
      .run(other, 'skeet', PID);
    expect(findSkeetStreaks(db, matchId)).toEqual([]);
  });
});
