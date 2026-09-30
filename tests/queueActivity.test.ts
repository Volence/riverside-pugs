import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { queueActivity, recordQueueStint, MIN_WAIT_SAMPLES } from '../src/queueActivity.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer } from '../src/players.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let db: DB;

beforeEach(() => { db = openDb(':memory:'); });

function pop(at: string, origin = 'queue'): void {
  db.prepare("INSERT INTO matches (season_id, state, campaign, origin, created_at) VALUES (1, 'completed', 'no_mercy', ?, ?)").run(origin, at);
}

describe('queueActivity', () => {
  it('buckets queue pops by UTC weekday and hour, inside four weeks only', () => {
    pop('2026-09-29 21:15:00'); // Tuesday 21 UTC
    pop('2026-09-29 21:59:59');
    pop('2026-09-27 03:00:00'); // Sunday 03 UTC
    pop('2026-09-29 21:30:00', 'in_game'); // not a queue pop
    pop('2026-08-20 21:00:00'); // older than 28 days
    const a = queueActivity(db, NOW);
    expect(a.pops[2][21]).toBe(2);
    expect(a.pops[0][3]).toBe(1);
    expect(a.totalPops).toBe(3);
    expect(a.pops).toHaveLength(7);
    expect(a.pops.every((row) => row.length === 24)).toBe(true);
  });

  it('reports no wait until there are enough samples', () => {
    for (let i = 0; i < MIN_WAIT_SAMPLES - 1; i++) {
      recordQueueStint(db, { steamid: `p${i}`, joinedAt: NOW - DAY, endedAt: NOW - DAY + 4 * MIN, outcome: 'popped', requeued: false });
    }
    const a = queueActivity(db, NOW);
    expect(a.waits.medianSec).toBeNull();
    expect(a.waits.popped).toBe(MIN_WAIT_SAMPLES - 1);
    expect(a.waits.byHourSec.every((x) => x === null)).toBe(true);
  });

  it('medians fresh popped waits overall and by UTC join hour, leaving requeues and leavers out', () => {
    const joined = Date.parse('2026-09-29T22:10:00Z');
    [2, 4, 6, 8, 10].forEach((m, i) => recordQueueStint(db, {
      steamid: `p${i}`, joinedAt: joined, endedAt: joined + m * MIN, outcome: 'popped', requeued: false,
    }));
    recordQueueStint(db, { steamid: 'r', joinedAt: joined, endedAt: joined + 60 * MIN, outcome: 'popped', requeued: true });
    for (let i = 0; i < 5; i++) {
      recordQueueStint(db, { steamid: `l${i}`, joinedAt: joined, endedAt: joined + 20 * MIN, outcome: 'left', requeued: false });
    }
    const a = queueActivity(db, NOW);
    expect(a.waits.medianSec).toBe(6 * 60);
    expect(a.waits.byHourSec[22]).toBe(6 * 60);
    expect(a.waits.byHourSec[21]).toBeNull();
    expect(a.waits.popped).toBe(5);
    expect(a.waits.left).toBe(5);
    expect(a.waits.leftMedianSec).toBe(20 * 60);
  });

  it('prunes stints far older than anything it reads', () => {
    recordQueueStint(db, { steamid: 'old', joinedAt: NOW - 400 * DAY, endedAt: NOW - 400 * DAY, outcome: 'left', requeued: false });
    recordQueueStint(db, { steamid: 'new', joinedAt: NOW, endedAt: NOW, outcome: 'left', requeued: false });
    expect(db.prepare('SELECT player_id FROM queue_stints').all()).toEqual([{ player_id: 'new' }]);
  });
});

describe('matchmaker records queue stints', () => {
  const IDS = Array.from({ length: 9 }, (_, i) => `765611980000001${String(i + 10)}`);
  const make = () => new Matchmaker(db, {
    broadcast: () => {},
    orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} } as never,
    rng: () => 0,
  });

  beforeEach(() => {
    for (const id of IDS) upsertPlayer(db, { steamid: id, name: id.slice(-2), avatar: null }, []);
  });

  it('a pop writes eight popped rows and a leave writes a left row', () => {
    const mm = make();
    mm.join(IDS[8]); mm.leave(IDS[8]);
    for (const id of IDS.slice(0, 8)) mm.join(id);
    const rows = db.prepare('SELECT outcome, COUNT(*) AS n FROM queue_stints GROUP BY outcome ORDER BY outcome').all();
    expect(rows).toEqual([{ outcome: 'left', n: 1 }, { outcome: 'popped', n: 8 }]);
  });

  it('a restart keeps each queued player\'s join time', () => {
    const a = make();
    a.join(IDS[0]);
    const saved = JSON.parse((db.prepare('SELECT json FROM matchmaker_state').get() as { json: string }).json);
    const joinedAt = saved.queueJoinedAt[IDS[0]] as number;
    expect(typeof joinedAt).toBe('number');
    // Pretend the first join happened an hour earlier, as a deploy mid-wait would see it.
    saved.queueJoinedAt[IDS[0]] = joinedAt - 3_600_000;
    db.prepare('UPDATE matchmaker_state SET json = ?').run(JSON.stringify(saved));
    const b = make();
    b.restore();
    b.leave(IDS[0]);
    const row = db.prepare('SELECT joined_at, ended_at FROM queue_stints').get() as { joined_at: number; ended_at: number };
    expect(row.joined_at).toBe(joinedAt - 3_600_000);
    expect(row.ended_at - row.joined_at).toBeGreaterThanOrEqual(3_600_000);
  });
});
