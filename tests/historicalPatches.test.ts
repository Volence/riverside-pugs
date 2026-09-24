import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { applyHistoricalPatches, HISTORICAL_PATCHES } from '../src/historicalPatches.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
  const ins = db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at) VALUES (1, ?, 1, 'a', ?)");
  ins.run(0, '2026-09-11 10:00:00');   // baseline
  ins.run(1, '2026-09-21 21:00:00');   // after sky pounce
  ins.run(2, '2026-09-23 01:00:00');   // after saferoom lock
  return db;
}

describe('historical patches', () => {
  it('creates one patch per boundary and tags rounds by start time', () => {
    const db = setup();
    const r = applyHistoricalPatches(db);
    expect(r.created).toBe(HISTORICAL_PATCHES.length);
    expect(r.tagged).toBe(3);
    const names = db.prepare(`SELECT r.ordinal, p.name FROM match_rounds r JOIN balance_patches p ON p.id = r.patch_id ORDER BY r.ordinal`).all();
    expect(names).toEqual([
      { ordinal: 0, name: 'Baseline' },
      { ordinal: 1, name: 'Sky pounce fix' },
      { ordinal: 2, name: 'Saferoom lock' },
    ]);
  });

  it('is idempotent and never overwrites a detected tag', () => {
    const db = setup();
    db.prepare("INSERT INTO balance_patches (id, fingerprint, source, inputs_json, first_seen_at) VALUES (99, 'f', 'detected', '{}', '2026-09-23 00:30:00')").run();
    db.prepare('UPDATE match_rounds SET patch_id = 99 WHERE ordinal = 2').run();
    applyHistoricalPatches(db);
    const second = applyHistoricalPatches(db);
    expect(second).toEqual({ created: 0, tagged: 0 });
    expect(db.prepare('SELECT patch_id FROM match_rounds WHERE ordinal = 2').get()).toEqual({ patch_id: 99 });
  });

  it('dry run changes nothing', () => {
    const db = setup();
    const r = applyHistoricalPatches(db, { dryRun: true });
    expect(r.created).toBe(HISTORICAL_PATCHES.length);
    expect(db.prepare('SELECT COUNT(*) AS n FROM balance_patches').get()).toEqual({ n: 0 });
  });
});
