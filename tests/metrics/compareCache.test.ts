import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db.js';
import { memo, parseSideParams } from '../../src/metrics/compare/cache.js';
import { metricsGeneration, writeRoundMetrics } from '../../src/metrics/store.js';

describe('compare cache', () => {
  it('reuses a result until metrics are written', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a')").run();
    const fn = vi.fn(() => 42);
    memo('k', fn); memo('k', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    const g = metricsGeneration();
    writeRoundMetrics(db, { matchId: 1, ordinal: 0, half: 1 }, [], { hasReplay: false, hasStats: false, replaySeen: false, engine: 'e' });
    expect(metricsGeneration()).toBe(g + 1);
    memo('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('parses and validates side parameters', () => {
    expect(parseSideParams({ a: '1,2', b: '3', origin: 'queue', maps: 'x,y' })).toEqual({
      a: { patchIds: [1, 2], origin: 'queue', maps: ['x', 'y'] },
      b: { patchIds: [3], origin: 'queue', maps: ['x', 'y'] },
    });
    expect(parseSideParams({ a: '1', b: '2' })).toMatchObject({ a: { origin: 'all', maps: null } });
    expect(typeof parseSideParams({ a: '', b: '2' })).toBe('string');
    expect(typeof parseSideParams({ a: '1;DROP', b: '2' })).toBe('string');
    expect(typeof parseSideParams({ a: '1', b: '2', origin: 'pub' })).toBe('string');
  });
});
