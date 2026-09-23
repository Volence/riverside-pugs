import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';

const cols = (db: ReturnType<typeof openDb>, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe('metrics schema', () => {
  it('creates round_metrics and round_metric_context', () => {
    const db = openDb(':memory:');
    expect(cols(db, 'round_metrics')).toEqual(
      ['match_id', 'ordinal', 'half', 'metric', 'phase', 'num', 'den']);
    expect(cols(db, 'round_metric_context')).toEqual(expect.arrayContaining([
      'match_id', 'ordinal', 'half', 'map', 'origin', 'server_id', 'patch_id',
      'surv_mu', 'inf_mu', 'has_replay', 'has_stats', 'engine', 'computed_at']));
    const idx = (db.prepare('PRAGMA index_list(round_metrics)').all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain('round_metrics_metric');
  });

  it('rejects an unknown phase', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
    expect(() => db.prepare(
      "INSERT INTO round_metrics VALUES (1, 0, 1, 'm', 'lunch', 1, 1)").run()).toThrow();
  });
});
