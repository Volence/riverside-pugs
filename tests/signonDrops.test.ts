import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { markEntered, recordSignonDrop, signonDropSummary } from '../src/signonDrops.js';

const A = '76561198030413993';
const B = '76561198005192651';
const T0 = Date.parse('2026-09-19T20:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const drop = (steamid = A, name = 'volence') => ({ steamid, name, secs: 14, forced: 651 });

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('signon_drops schema', () => {
  it('has exactly the columns the spec names', () => {
    const cols = (db.prepare('PRAGMA table_info(signon_drops)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'steamid', 'name', 'secs_connected', 'forced_count', 'at', 'entered_after_at']);
  });

  it('stores a drop for a steamid that is not a registered player', () => {
    // Most drops happen to people who have never signed in to the site, so
    // steamid must not be a foreign key into players.
    expect(recordSignonDrop(db, drop(), at(0))).toEqual({ id: 1, streak: 1, total: 1 });
    expect(db.prepare('SELECT steamid, name, secs_connected, forced_count, at, entered_after_at FROM signon_drops').get())
      .toEqual({ steamid: A, name: 'volence', secs_connected: 14, forced_count: 651, at: '2026-09-19T20:00:00.000Z', entered_after_at: null });
  });
});

describe('recordSignonDrop: the streak', () => {
  it('counts a second drop inside ten minutes', () => {
    recordSignonDrop(db, drop(), at(0));
    expect(recordSignonDrop(db, drop(), at(9))).toMatchObject({ streak: 2, total: 2 });
  });

  it('does not count a drop older than ten minutes', () => {
    recordSignonDrop(db, drop(), at(0));
    expect(recordSignonDrop(db, drop(), at(11))).toMatchObject({ streak: 1, total: 2 });
  });

  it('starts again after an entry', () => {
    recordSignonDrop(db, drop(), at(0));
    markEntered(db, A, at(1));
    expect(recordSignonDrop(db, drop(), at(2))).toMatchObject({ streak: 1, total: 2 });
  });

  it('keeps each steamid to itself', () => {
    recordSignonDrop(db, drop(A), at(0));
    expect(recordSignonDrop(db, drop(B, 'mayhem'), at(1))).toMatchObject({ streak: 1, total: 1 });
  });

  it('treats the same datagram delivered twice as one drop', () => {
    recordSignonDrop(db, drop(), at(0));
    expect(recordSignonDrop(db, drop(), new Date(T0 + 1_000))).toBeNull();
    expect(signonDropSummary(db, A).count).toBe(1);
  });
});

describe('markEntered', () => {
  it('stamps every open drop of that steamid and nobody else\'s', () => {
    recordSignonDrop(db, drop(A), at(0));
    recordSignonDrop(db, drop(A), at(5));
    recordSignonDrop(db, drop(B, 'mayhem'), at(5));
    expect(markEntered(db, A, at(6))).toBe(2);
    const rows = db.prepare('SELECT steamid, entered_after_at FROM signon_drops ORDER BY id').all();
    expect(rows).toEqual([
      { steamid: A, entered_after_at: '2026-09-19T20:06:00.000Z' },
      { steamid: A, entered_after_at: '2026-09-19T20:06:00.000Z' },
      { steamid: B, entered_after_at: null },
    ]);
  });

  it('never moves a stamp that is already set', () => {
    recordSignonDrop(db, drop(), at(0));
    markEntered(db, A, at(1));
    expect(markEntered(db, A, at(30))).toBe(0);
    expect(signonDropSummary(db, A).rows[0].enteredAfterAt).toBe('2026-09-19T20:01:00.000Z');
  });

  it('is a no-op for someone with no drops, which is nearly every entry', () => {
    expect(markEntered(db, B, at(0))).toBe(0);
  });
});

describe('signonDropSummary', () => {
  it('reports the count, the last time and the rows newest first', () => {
    recordSignonDrop(db, drop(A, 'old name'), at(0));
    recordSignonDrop(db, drop(A, 'new name'), at(20));
    expect(signonDropSummary(db, A)).toEqual({
      count: 2,
      lastAt: '2026-09-19T20:20:00.000Z',
      rows: [
        { id: 2, name: 'new name', secsConnected: 14, forcedCount: 651, at: '2026-09-19T20:20:00.000Z', enteredAfterAt: null },
        { id: 1, name: 'old name', secsConnected: 14, forcedCount: 651, at: '2026-09-19T20:00:00.000Z', enteredAfterAt: null },
      ],
    });
  });

  it('is empty for someone with none', () => {
    expect(signonDropSummary(db, B)).toEqual({ count: 0, lastAt: null, rows: [] });
  });
});
