import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { applyDemoShiftBackfill, planDemoShiftBackfill } from '../src/demoShiftBackfill.js';
import { storedDemoShifts } from '../src/logParse.js';

/** Match 186 map 2 in miniature: a 66 s pause in half 1, a 20 s one in half 2
 *  after an earlier 10 s one. */
function seeded() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'c', 'x')").run();
  const round = db.prepare(
    `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at, ended_at, demo_tick, demo_hz)
     VALUES (1, 1, ?, 'a', ?, ?, ?, 100)`,
  );
  round.run(1, '2026-09-25 10:00:00', '2026-09-25 10:10:00', 1000);
  round.run(2, '2026-09-25 10:12:00', '2026-09-25 10:22:00', 72000);
  const pause = db.prepare(
    `INSERT INTO match_pauses (match_id, map_ordinal, half, started_at, ended_at) VALUES (1, ?, ?, ?, ?)`,
  );
  pause.run(1, 1, '2026-09-25 10:02:00', '2026-09-25 10:03:06');
  pause.run(1, 2, '2026-09-25 10:13:00', '2026-09-25 10:13:10');
  pause.run(1, 2, '2026-09-25 10:15:00', '2026-09-25 10:15:20');
  // Another map's pause is another demo's business.
  pause.run(0, 1, '2026-09-25 09:30:00', '2026-09-25 09:35:00');
  return db;
}

describe('demo shift backfill', () => {
  it('moves a later half by the pauses before it and lists the in-half ones on the round clock', () => {
    const db = seeded();
    const fixes = planDemoShiftBackfill(db, '2026-09-26 00:00:00');
    expect(fixes).toEqual([
      { matchId: 1, ordinal: 1, half: 1, oldTick: 1000, newTick: 1000, shifts: [{ tMs: 120_000, ticks: 6600 }] },
      {
        matchId: 1, ordinal: 1, half: 2, oldTick: 72000, newTick: 72000 + 6600,
        // The second pause began 180 s of wall clock in, 10 s of which the
        // round clock spent paused.
        shifts: [{ tMs: 60_000, ticks: 1000 }, { tMs: 170_000, ticks: 2000 }],
      },
    ]);
  });

  it('writes once: a second run finds nothing', () => {
    const db = seeded();
    applyDemoShiftBackfill(db, planDemoShiftBackfill(db, '2026-09-26 00:00:00'));
    const row = db.prepare('SELECT demo_tick AS tick, demo_shifts AS s FROM match_rounds WHERE half = 2').get() as
      { tick: number; s: string };
    expect(row.tick).toBe(78600);
    expect(storedDemoShifts(row.s)).toEqual([{ tMs: 60_000, ticks: 1000 }, { tMs: 170_000, ticks: 2000 }]);
    expect(planDemoShiftBackfill(db, '2026-09-26 00:00:00')).toEqual([]);
  });

  it('leaves rounds from after the cutoff, and live matches, alone', () => {
    const db = seeded();
    expect(planDemoShiftBackfill(db, '2026-09-25 10:05:00').map((f) => f.half)).toEqual([1]);
    db.prepare("UPDATE matches SET state = 'live'").run();
    expect(planDemoShiftBackfill(db, '2026-09-26 00:00:00')).toEqual([]);
  });
});
