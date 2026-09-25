import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { mergeBalancePatches } from '../src/balanceMerge.js';

type DB = ReturnType<typeof openDb>;

// Prod-like: 6 live, 7 merged into 6 by the refingerprint (fingerprint NULL,
// rounds still on 7), 8 detected. match_rounds.sighted_patch_id references the
// patches, so the old repoint-then-DELETE failed with a foreign key error.
function seed(db: DB) {
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('a'.repeat(32));
  addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  const ins = db.prepare("INSERT INTO balance_patches (id, fingerprint, source, inputs_json, first_seen_at, triage) VALUES (?, ?, 'detected', ?, ?, ?)");
  ins.run(6, 'f6', '{"c:a":"1"}', '2026-09-20 00:00:00', 'balance');
  ins.run(7, null, '{"c:a":"1","p:t.smx":"1"}', '2026-09-24 05:41:10', 'pending');
  ins.run(8, 'f8', '{"c:a":"2"}', '2026-09-24 07:00:00', 'pending');
  const r = db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, patch_id, sighted_patch_id) VALUES (1, ?, ?, 'a', ?, ?)");
  r.run(0, 1, 6, 6); r.run(0, 2, 7, 7); r.run(1, 1, 7, 7);
  db.prepare("INSERT INTO balance_patch_servers (patch_id, server_id, first_seen_at, last_seen_at) VALUES (7, 1, 'x', 'y')").run();
  db.prepare("INSERT INTO balance_server_state (server_id, patch_id, inventory_json, since) VALUES (1, 7, '{\"c:a\":\"1\",\"p:t.smx\":\"1\"}', 'x')").run();
}

describe('mergeBalancePatches', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); seed(db); });
  const rounds = () => db.prepare('SELECT patch_id, sighted_patch_id FROM match_rounds ORDER BY ordinal, half').all();

  it('dry run by default: reports the moves and changes nothing', () => {
    const r = mergeBalancePatches(db, 6, [7], { apply: false });
    expect(r).toMatchObject({ ok: true, applied: false, roundsMoved: 2 });
    expect(rounds()).toEqual([{ patch_id: 6, sighted_patch_id: 6 }, { patch_id: 7, sighted_patch_id: 7 }, { patch_id: 7, sighted_patch_id: 7 }]);
    expect(db.prepare('SELECT triage FROM balance_patches WHERE id = 7').get()).toEqual({ triage: 'pending' });
  });

  it('apply folds, never deletes: rounds count for the kept patch, the dropped patch stays', () => {
    const r = mergeBalancePatches(db, 6, [7], { apply: true });
    expect(r).toMatchObject({ ok: true, applied: true, roundsMoved: 2 });
    expect(rounds()).toEqual([{ patch_id: 6, sighted_patch_id: 6 }, { patch_id: 6, sighted_patch_id: 7 }, { patch_id: 6, sighted_patch_id: 7 }]);
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = 7').get()).toEqual({ triage: 'folded', folded_into: 6 });
    // Server state and sightings are left alone: no spurious "config changed".
    expect(db.prepare('SELECT patch_id FROM balance_server_state').get()).toEqual({ patch_id: 7 });
    expect(db.prepare('SELECT patch_id FROM balance_patch_servers').get()).toEqual({ patch_id: 7 });
  });

  it('refuses to apply while a match is live or configuring', () => {
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (2, 1, 'configuring', 'x', ?)").run('b'.repeat(32));
    expect(mergeBalancePatches(db, 6, [7], { apply: true })).toMatchObject({ ok: false, error: expect.stringMatching(/live/) });
    expect(mergeBalancePatches(db, 6, [7], { apply: false })).toMatchObject({ ok: true });
  });

  it('refuses a missing patch, keeping a dropped one, and the active rollout', () => {
    expect(mergeBalancePatches(db, 6, [99], { apply: true })).toMatchObject({ ok: false, error: expect.stringMatching(/99/) });
    expect(mergeBalancePatches(db, 6, [6], { apply: true })).toMatchObject({ ok: false });
    db.prepare("INSERT INTO balance_rollouts (patch_id, values_json, content, created_by, created_at) VALUES (8, '{}', '', '1', 'x')").run();
    expect(mergeBalancePatches(db, 6, [8], { apply: true })).toMatchObject({ ok: false, error: expect.stringMatching(/rollout/) });
    expect(db.prepare('SELECT triage FROM balance_patches WHERE id = 8').get()).toEqual({ triage: 'pending' });
  });

  it('refuses a kept patch that is itself folded: keep its chain end instead', () => {
    db.prepare("UPDATE balance_patches SET triage = 'folded', folded_into = 8 WHERE id = 6").run();
    expect(mergeBalancePatches(db, 6, [7], { apply: true })).toMatchObject({ ok: false, error: expect.stringMatching(/#?8/) });
    expect(db.prepare('SELECT triage FROM balance_patches WHERE id = 7').get()).toEqual({ triage: 'pending' });
  });
});
