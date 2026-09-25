import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { drainPending, pendingRounds, reaperRoundLimit, REAPER_ROUNDS_PER_TICK, REAPER_ROUNDS_PER_TICK_LIVE, runMetricsPass } from '../../src/metrics/job.js';
import { ENGINE } from '../../src/metrics/registry.js';
import type { RoundKey } from '../../src/metrics/types.js';
import { frames, replayOf, standing4 } from './fixtures.js';

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

  it('keeps computing while a match is live, one round a minute', () => {
    const db = setup();
    expect(reaperRoundLimit(db)).toBe(REAPER_ROUNDS_PER_TICK_LIVE);
    expect(REAPER_ROUNDS_PER_TICK_LIVE).toBeGreaterThan(0);
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = 3").run();
    expect(reaperRoundLimit(db)).toBe(REAPER_ROUNDS_PER_TICK);
  });

  it('respects the limit', () => {
    expect(pendingRounds(setup(), { engine: ENGINE, replayWaitMin: 30, limit: 1, now: NOW })).toHaveLength(1);
  });

  it('records a poisoned round as failed, still computes the rest of the batch, and only retries after an engine bump', () => {
    const db = setup();
    const boom = new Error('boom');
    const load = (key: RoundKey) => { if (key.half === 1) throw boom; return null; };
    const errSpy = { calls: 0 };
    const origError = console.error;
    console.error = ((...args: unknown[]) => { errSpy.calls++; }) as typeof console.error;
    let result: ReturnType<typeof runMetricsPass>;
    try {
      result = runMetricsPass(db, '', { limit: 10, now: NOW, load });
    } finally {
      console.error = origError;
    }
    expect(result!).toEqual({ computed: 1, failed: 1, frozen: 0, failedKeys: [{ matchId: 1, ordinal: 0, half: 1 }] });
    expect(errSpy.calls).toBe(1);
    expect(pendingRounds(db, { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW })).toEqual([]);
    expect(pendingRounds(db, { engine: ENGINE + ',new.metric:1', replayWaitMin: 30, limit: 10, now: NOW })).toHaveLength(2);
  });

  it('picks up a round with a replay row once, and does not retry it every tick when decoding keeps failing', () => {
    const db = setup();
    runMetricsPass(db, '', { limit: 10, now: NOW, load: () => null });
    db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (1, 0, 2, 'f', 1, 1, 10)").run();
    expect(pendingRounds(db, { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW }).map((k) => k.half)).toEqual([2]);
    const r2 = runMetricsPass(db, '', { limit: 10, now: NOW, load: () => null });
    expect(r2).toEqual({ computed: 1, failed: 0, frozen: 0, failedKeys: [] });
    expect(pendingRounds(db, { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW })).toEqual([]);
  });

  describe('a round computed with a replay that is later pruned', () => {
    const replay = replayOf(frames(0, 20_000, () => ({ surv: standing4 })));
    const addReplay = (db: ReturnType<typeof setup>) =>
      db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (1, 0, 1, 'f', 1, 1, 10)").run();
    const rowsOf = (db: ReturnType<typeof setup>) => db.prepare(
      'SELECT metric, phase, num, den FROM round_metrics WHERE match_id = 1 AND ordinal = 0 AND half = 1 ORDER BY metric, phase').all();
    const engineOf = (db: ReturnType<typeof setup>) => (db.prepare(
      'SELECT engine, has_replay FROM round_metric_context WHERE match_id = 1 AND ordinal = 0 AND half = 1').get() as { engine: string; has_replay: number });

    function computedWithReplay() {
      const db = setup();
      addReplay(db);
      const r = runMetricsPass(db, '', { limit: 10, now: NOW, load: (k) => (k.matchId === 1 && k.half === 1 ? replay : null) });
      expect(r.computed).toBe(2);
      expect(engineOf(db).has_replay).toBe(1);
      // Simulate an engine bump: the stored engine no longer matches.
      db.prepare("UPDATE round_metric_context SET engine = 'old-engine'").run();
      return db;
    }

    it('keeps its rows and freezes on the new engine when the replay row is pruned', () => {
      const db = computedWithReplay();
      const before = rowsOf(db);
      expect(before.some((r) => (r as { phase: string }).phase === 'normal')).toBe(true);
      db.prepare("UPDATE match_replays SET pruned_at = '2026-09-23 09:00:00'").run();
      let loads = 0;
      const r = runMetricsPass(db, '', { limit: 10, now: NOW, load: () => { loads++; return null; } });
      expect(r).toEqual({ computed: 1, failed: 0, frozen: 1, failedKeys: [] });
      expect(loads).toBe(1); // only the other round; the pruned one is not even loaded
      expect(rowsOf(db)).toEqual(before);
      expect(engineOf(db)).toEqual({ engine: ENGINE + '!frozen', has_replay: 1 });
      expect(pendingRounds(db, { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW })).toEqual([]);
      // A later bump makes it pending again.
      expect(pendingRounds(db, { engine: ENGINE + ',new.metric:1', replayWaitMin: 30, limit: 10, now: NOW })).toHaveLength(2);
    });

    it('also freezes when the replay row is there but the file no longer decodes', () => {
      const db = computedWithReplay();
      const before = rowsOf(db);
      const r = runMetricsPass(db, '', { limit: 10, now: NOW, load: () => null });
      expect(r.frozen).toBe(1);
      expect(rowsOf(db)).toEqual(before);
      expect(engineOf(db).engine).toBe(ENGINE + '!frozen');
    });

    it('recomputes normally when the replay is still usable', () => {
      const db = computedWithReplay();
      const r = runMetricsPass(db, '', { limit: 10, now: NOW, load: (k) => (k.half === 1 ? replay : null) });
      expect(r).toEqual({ computed: 2, failed: 0, frozen: 0, failedKeys: [] });
      expect(engineOf(db)).toEqual({ engine: ENGINE, has_replay: 1 });
    });
  });

  describe('drainPending', () => {
    it('runs passes until nothing is pending', () => {
      const db = setup();
      const r = drainPending(db, '', { limit: 1, maxPasses: 100, now: NOW, load: () => null });
      expect(r).toMatchObject({ computed: 2, failed: 0, passes: 3, stop: 'done' });
    });

    it('stops instead of spinning when a round fails and its failed marker cannot be written', () => {
      const db = setup();
      db.exec("CREATE TRIGGER no_ctx BEFORE INSERT ON round_metric_context WHEN NEW.match_id = 1 AND NEW.half = 1 BEGIN SELECT RAISE(ABORT, 'disk full'); END");
      const origError = console.error;
      console.error = (() => {}) as typeof console.error;
      let r: ReturnType<typeof drainPending>;
      try {
        r = drainPending(db, '', { limit: 10, maxPasses: 1000, now: NOW,
          load: (k) => { if (k.half === 1) throw new Error('boom'); return null; } });
      } finally {
        console.error = origError;
      }
      expect(r!.stop).toBe('stuck');
      expect(r!.passes).toBe(2);
      expect(r!.computed).toBe(1);
    });

    it('stops at the pass cap', () => {
      const db = setup();
      const r = drainPending(db, '', { limit: 1, maxPasses: 1, now: NOW, load: () => null });
      expect(r).toMatchObject({ computed: 1, passes: 1, stop: 'cap' });
    });
  });
});
