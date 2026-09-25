import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { planPauseMerge, applyPauseMerge } from '../src/pauseMerge.js';
import { pausesFor } from '../src/liveView.js';

let db: DB;
const ins = (match: number, team: string | null, leave: number, start: string, end: string | null, by: string | null = null) =>
  db.prepare(
    `INSERT INTO match_pauses (match_id, map_ordinal, half, team, leave_pause, started_at, ended_at, called_by)
     VALUES (?, 3, 2, ?, ?, ?, ?, ?)`,
  ).run(match, team, leave, `2026-09-25 ${start}`, end && `2026-09-25 ${end}`, by);

beforeEach(() => {
  db = openDb(':memory:');
  db.pragma('foreign_keys = OFF');
});

describe('merging split pauses', () => {
  it('turns match 190\'s four rows into its two real pauses', () => {
    ins(190, 'a', 0, '07:30:13', '07:30:36', 'X');
    ins(190, 'a', 1, '07:30:36', '07:30:57', 'X');
    ins(190, 'a', 0, '07:30:57', '07:31:01', 'X');
    ins(190, 'a', 0, '07:31:03', '07:31:16', 'X');
    applyPauseMerge(db, planPauseMerge(db));
    expect(pausesFor(db, 190)).toMatchObject([
      { team: 'a', leave: true, calledBy: 'X', seconds: 48 },
      { team: 'a', leave: false, calledBy: 'X', seconds: 13 },
    ]);
  });

  it('joins a disconnect pause to its unpause countdown', () => {
    ins(84, null, 1, '00:18:24', '00:18:41');
    ins(84, null, 0, '00:18:41', '00:18:46');
    expect(planPauseMerge(db)).toEqual([{ matchId: 84, ids: [1, 2] }]);
  });

  it('keeps a same-second re-pause, another team, another match and an open end apart', () => {
    ins(1, 'a', 0, '01:00:00', '01:00:10');
    ins(1, 'a', 0, '01:00:10', '01:00:20'); // re-pause: flag unchanged
    ins(1, 'b', 1, '01:00:20', '01:00:30'); // other team
    ins(2, 'b', 0, '01:00:30', '01:00:40'); // other match
    ins(3, 'a', 0, '01:00:00', null);
    ins(3, 'a', 1, '01:00:00', null);
    expect(planPauseMerge(db)).toEqual([]);
  });

  it('keeps a chain whose last row never closed open', () => {
    ins(77, 'b', 0, '11:51:08', '11:51:58');
    ins(77, 'b', 1, '11:51:58', null);
    applyPauseMerge(db, planPauseMerge(db));
    expect(pausesFor(db, 77)).toMatchObject([{ leave: true, endedAt: null, seconds: null }]);
  });
});
