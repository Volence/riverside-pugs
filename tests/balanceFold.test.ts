import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { chainOf, foldInto, resolvePatch, retagRounds, triageGeneration, unfoldPatch } from '../src/balanceFold.js';
import { dataStamp } from '../src/metrics/compare/cache.js';

type DB = ReturnType<typeof openDb>;

function seed(db: DB) {
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('a'.repeat(32));
  const ins = db.prepare("INSERT INTO balance_patches (id, fingerprint, source, inputs_json, first_seen_at, triage, published_at) VALUES (?, ?, 'detected', '{}', ?, ?, ?)");
  ins.run(1, 'f1', '2026-09-20 00:00:00', 'balance', null);
  ins.run(2, 'f2', '2026-09-21 00:00:00', 'pending', null);
  ins.run(3, 'f3', '2026-09-22 00:00:00', 'balance', '2026-09-22 00:00:00');
  const r = db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, patch_id, sighted_patch_id) VALUES (1, ?, ?, 'a', ?, ?)");
  r.run(0, 1, 1, 1); r.run(0, 2, 2, 2); r.run(1, 1, 3, 3);
  db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, patch_id, has_replay, has_stats, engine, computed_at)
    VALUES (1, 0, 2, 2, 1, 1, 'e', '2026-09-24 00:00:00')`).run();
}

describe('balanceFold', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); seed(db); });

  const roundPatch = (half: number, ordinal = 0) =>
    (db.prepare('SELECT patch_id, sighted_patch_id FROM match_rounds WHERE ordinal = ? AND half = ?').get(ordinal, half));
  const ctxPatch = () => (db.prepare('SELECT patch_id FROM round_metric_context').get() as { patch_id: number }).patch_id;

  it('folds a patch: rounds and metric context move, sighted stays', () => {
    expect(foldInto(db, 2, 1)).toEqual({ ok: true, target: 1 });
    expect(roundPatch(2)).toEqual({ patch_id: 1, sighted_patch_id: 2 });
    expect(ctxPatch()).toBe(1);
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = 2').get()).toEqual({ triage: 'folded', folded_into: 1 });
  });

  it('unfold restores patch_id from sighted_patch_id and returns to pending', () => {
    foldInto(db, 2, 1);
    unfoldPatch(db, 2);
    expect(roundPatch(2)).toEqual({ patch_id: 2, sighted_patch_id: 2 });
    expect(ctxPatch()).toBe(2);
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = 2').get()).toEqual({ triage: 'pending', folded_into: null });
  });

  it('folding into a folded patch follows the chain to its end', () => {
    foldInto(db, 2, 1);
    expect(foldInto(db, 3, 2)).toEqual({ ok: true, target: 1 });
    expect(db.prepare('SELECT folded_into FROM balance_patches WHERE id = 3').get()).toEqual({ folded_into: 1 });
    expect(roundPatch(1, 1)).toEqual({ patch_id: 1, sighted_patch_id: 3 });
  });

  it('a patch folded into one that is later folded moves with it', () => {
    foldInto(db, 2, 3);
    foldInto(db, 3, 1);
    expect(chainOf(db, 2)).toEqual([2, 3, 1]);
    expect(resolvePatch(db, 2)).toBe(1);
    expect(roundPatch(2)).toEqual({ patch_id: 1, sighted_patch_id: 2 });
  });

  it('refuses a loop and folding into itself', () => {
    foldInto(db, 2, 3);
    expect(foldInto(db, 3, 2)).toEqual({ ok: false, error: expect.stringMatching(/loop/) });
    expect(foldInto(db, 1, 1)).toEqual({ ok: false, error: expect.stringMatching(/itself/) });
    expect(db.prepare('SELECT triage FROM balance_patches WHERE id = 3').get()).toEqual({ triage: 'balance' });
  });

  it('folding unpublishes', () => {
    foldInto(db, 3, 1);
    expect(db.prepare('SELECT published_at FROM balance_patches WHERE id = 3').get()).toEqual({ published_at: null });
  });

  it('unfolding a published patch restores its publication and its balance state', () => {
    foldInto(db, 3, 1);
    unfoldPatch(db, 3);
    expect(db.prepare('SELECT triage, folded_into, published_at FROM balance_patches WHERE id = 3').get())
      .toEqual({ triage: 'balance', folded_into: null, published_at: '2026-09-22 00:00:00' });
    // An unpublished patch goes back to pending as before.
    foldInto(db, 2, 1);
    unfoldPatch(db, 2);
    expect(db.prepare('SELECT triage, published_at FROM balance_patches WHERE id = 2').get()).toEqual({ triage: 'pending', published_at: null });
  });

  it('a mid-chain unfold leaves the patches folded into it pointed at the chain end', () => {
    foldInto(db, 2, 3);
    foldInto(db, 3, 1);
    unfoldPatch(db, 3);
    expect(db.prepare('SELECT folded_into FROM balance_patches WHERE id = 2').get()).toEqual({ folded_into: 1 });
    expect(resolvePatch(db, 2)).toBe(1);
    expect(roundPatch(2)).toEqual({ patch_id: 1, sighted_patch_id: 2 });
    expect(roundPatch(1, 1)).toEqual({ patch_id: 3, sighted_patch_id: 3 });
  });

  it('retagging bumps the generation and the compare data stamp', () => {
    const g = triageGeneration(), s = dataStamp(db);
    retagRounds(db);
    expect(triageGeneration()).toBe(g + 1);
    expect(dataStamp(db)).not.toBe(s);
  });
});
