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

  it('prod-like: a merged patch (fingerprint NULL, rounds still on it) ends folded into its keeper, not pending', async () => {
    const { refingerprintPatches, fingerprintOf } = await import('../src/balancePatches.js');
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('a'.repeat(32));
    const versionless = ['pug-match.smx'], ignored = ['l4d_tvwatch.smx'];
    const six = { 'c:z_tank_health': '8000', 'p:pug-match.smx': '1.a' };
    const seven = { ...six, 'p:pug-match.smx': '2.b', 'p:l4d_tvwatch.smx': '1.c' };
    const eight = { ...six, 'c:z_tank_health': '7500' };
    const ins = db.prepare('INSERT INTO balance_patches (id, fingerprint, name, source, inputs_json, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= 5; i++) ins.run(i, null, `Historical ${i}`, 'historical', null, `2026-0${i}-01 00:00:00`);
    ins.run(6, fingerprintOf(six, versionless), null, 'detected', JSON.stringify(six), '2026-09-23 00:00:00');
    ins.run(7, null, null, 'detected', JSON.stringify(seven), '2026-09-24 05:41:10');
    ins.run(8, fingerprintOf(eight, versionless), null, 'detected', JSON.stringify(eight), '2026-09-24 07:00:00');
    const r = db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, patch_id) VALUES (1, ?, ?, 'a', ?)");
    r.run(0, 1, 6); r.run(0, 2, 7); r.run(1, 1, 7); r.run(1, 2, 8);
    db.exec('UPDATE balance_patches SET triage = NULL; UPDATE match_rounds SET sighted_patch_id = NULL');
    for (const sql of TRIAGE_BACKFILL_SQL) db.prepare(sql).run();
    refingerprintPatches(db, versionless, ignored, () => {});

    expect(db.prepare('SELECT id, triage, folded_into FROM balance_patches ORDER BY id').all()).toEqual([
      ...[1, 2, 3, 4, 5].map((id) => ({ id, triage: 'balance', folded_into: null })),
      { id: 6, triage: 'pending', folded_into: null },
      { id: 7, triage: 'folded', folded_into: 6 },
      { id: 8, triage: 'pending', folded_into: null },
    ]);
    expect(db.prepare('SELECT ordinal, half, patch_id, sighted_patch_id FROM match_rounds ORDER BY ordinal, half').all()).toEqual([
      { ordinal: 0, half: 1, patch_id: 6, sighted_patch_id: 6 }, { ordinal: 0, half: 2, patch_id: 6, sighted_patch_id: 7 },
      { ordinal: 1, half: 1, patch_id: 6, sighted_patch_id: 7 }, { ordinal: 1, half: 2, patch_id: 8, sighted_patch_id: 8 },
    ]);
  });

  it('a merged patch left pending by an older backfill is folded into its keeper too', async () => {
    const { refingerprintPatches, fingerprintOf } = await import('../src/balancePatches.js');
    const db = openDb(':memory:');
    const six = { 'c:z_tank_health': '8000' };
    const ins = db.prepare("INSERT INTO balance_patches (id, fingerprint, source, inputs_json, first_seen_at, triage) VALUES (?, ?, 'detected', ?, ?, ?)");
    ins.run(6, fingerprintOf(six, []), JSON.stringify(six), '2026-09-23 00:00:00', 'pending');
    ins.run(7, null, JSON.stringify({ ...six, 'p:l4d_tvwatch.smx': '1' }), '2026-09-24 00:00:00', 'pending');
    refingerprintPatches(db, [], ['l4d_tvwatch.smx'], () => {});
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = 7').get()).toEqual({ triage: 'folded', folded_into: 6 });
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
