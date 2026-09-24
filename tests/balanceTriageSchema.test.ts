import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { TRIAGE_BACKFILL_SQL } from '../src/db.js';

describe('triage schema and backfill', () => {
  it('backfills states and sighted_patch_id, and leaves merged detected patches for the boot step', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('a'.repeat(32));
    const ins = db.prepare('INSERT INTO balance_patches (id, fingerprint, name, source, inputs_json, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(1, null, 'Baseline', 'historical', null, '2000-01-01 00:00:00');
    ins.run(2, 'f2', 'Named', 'detected', '{}', '2026-09-23 00:00:00');
    ins.run(3, 'f3', null, 'detected', '{}', '2026-09-24 00:00:00');
    ins.run(4, null, null, 'detected', '{}', '2026-09-24 01:00:00');
    ins.run(5, 'f5', 'Panel', 'announced', '{}', '2026-09-24 02:00:00');
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, patch_id) VALUES (1, 0, 1, 'a', 3), (1, 0, 2, 'b', NULL)").run();
    // The columns exist because openDb ran; simulate a database from before them.
    db.exec('UPDATE balance_patches SET triage = NULL; UPDATE match_rounds SET sighted_patch_id = NULL');
    for (const sql of TRIAGE_BACKFILL_SQL) db.prepare(sql).run();

    const states = db.prepare('SELECT id, triage FROM balance_patches ORDER BY id').all();
    expect(states).toEqual([
      { id: 1, triage: 'balance' }, { id: 2, triage: 'balance' }, { id: 3, triage: 'pending' },
      { id: 4, triage: null }, { id: 5, triage: 'balance' },
    ]);
    const rounds = db.prepare('SELECT half, patch_id, sighted_patch_id FROM match_rounds ORDER BY half').all();
    expect(rounds).toEqual([{ half: 1, patch_id: 3, sighted_patch_id: 3 }, { half: 2, patch_id: null, sighted_patch_id: null }]);
  });

  it('refuses an unknown triage state and has the ignored plugins table', () => {
    const db = openDb(':memory:');
    expect(() => db.prepare("INSERT INTO balance_patches (source, first_seen_at, triage) VALUES ('detected', 'x', 'maybe')").run()).toThrow();
    db.prepare("INSERT INTO balance_ignored_plugins (file, added_by, added_at) VALUES ('l4d_tvwatch.smx', '1', 'x')").run();
    expect(db.prepare('SELECT reason FROM balance_ignored_plugins').get()).toEqual({ reason: '' });
  });

  it('historical patches are balance and their rounds get a sighted patch', async () => {
    const { applyHistoricalPatches } = await import('../src/historicalPatches.js');
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('a'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at) VALUES (1, 0, 1, 'a', '2026-09-01 00:00:00')").run();
    applyHistoricalPatches(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM balance_patches WHERE triage != 'balance'").get()).toEqual({ n: 0 });
    const r = db.prepare('SELECT patch_id, sighted_patch_id FROM match_rounds').get() as { patch_id: number; sighted_patch_id: number };
    expect(r.sighted_patch_id).toBe(r.patch_id);
  });
});
