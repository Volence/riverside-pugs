import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { pendingRounds, runMetricsPass } from '../../src/metrics/job.js';
import { ENGINE } from '../../src/metrics/registry.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare(`INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES
    (1, 1, 'completed', 'x', '2026-09-23 08:00:00'),
    (2, 1, 'completed', 'x', '2026-09-23 09:50:00'),
    (3, 1, 'live', 'x', NULL),
    (4, 1, 'aborted', 'x', '2026-09-23 07:00:00')`).run();
  const r = db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, started_at, ended_at, survivors_alive) VALUES (?, 0, ?, 'a', 100, '2026-09-23 07:00:00', '2026-09-23 07:10:00', 1)");
  for (const m of [1, 2, 3, 4]) { r.run(m, 1); r.run(m, 2); }
  return db;
}
const NOW = '2026-09-23 10:00:00';

describe('metrics job', () => {
  it('picks completed, unvoided matches and waits for a recent match replay', () => {
    const keys = pendingRounds(setup(), { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW });
    expect(keys.map((k) => `${k.matchId}/${k.half}`)).toEqual(['1/1', '1/2']);
  });

  it('takes a recent match once its replay row exists', () => {
    const db = setup();
    db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (2, 0, 1, 'f', 1, 1, 10)").run();
    const keys = pendingRounds(db, { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW });
    expect(keys.map((k) => `${k.matchId}/${k.half}`)).toEqual(['1/1', '1/2', '2/1']);
  });

  it('computes, then skips until the engine changes', () => {
    const db = setup();
    const r1 = runMetricsPass(db, '', { limit: 10, now: NOW, load: () => null });
    expect(r1.computed).toBe(2);
    expect(pendingRounds(db, { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW })).toEqual([]);
    expect(pendingRounds(db, { engine: ENGINE + ',new.metric:1', replayWaitMin: 30, limit: 10, now: NOW })).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM round_metrics WHERE metric = 'round.saferoom'").get()).toEqual({ n: 2 });
  });

  it('recomputes a round whose replay arrived after it was computed', () => {
    const db = setup();
    runMetricsPass(db, '', { limit: 10, now: NOW, load: () => null });
    db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (1, 0, 2, 'f', 1, 1, 10)").run();
    expect(pendingRounds(db, { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW }).map((k) => k.half)).toEqual([2]);
  });

  it('respects the limit', () => {
    expect(pendingRounds(setup(), { engine: ENGINE, replayWaitMin: 30, limit: 1, now: NOW })).toHaveLength(1);
  });
});
