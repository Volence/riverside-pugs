import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';
import { diffInventories, fingerprintOf, formatDiff, listPatches, recordBalanceSighting, refingerprintPatches, withoutIgnored } from '../src/balancePatches.js';

const INV = { 'c:z_tank_health': '4000', 'p:l4d_skypounce.smx': '100.aaaa0001', 'p:pug-match.smx': '200.bbbb0001' };

describe('fingerprintOf', () => {
  it('ignores key order', () => {
    const b = { 'p:pug-match.smx': '200.bbbb0001', 'p:l4d_skypounce.smx': '100.aaaa0001', 'c:z_tank_health': '4000' };
    expect(fingerprintOf(INV, [])).toBe(fingerprintOf(b, []));
    expect(fingerprintOf(INV, [])).toMatch(/^[0-9a-f]{16}$/);
  });
  it('changes on any value change', () => {
    expect(fingerprintOf({ ...INV, 'c:z_tank_health': '3750' }, [])).not.toBe(fingerprintOf(INV, []));
  });
  it('ignores the version but not the presence of a versionless plugin', () => {
    const v = ['pug-match.smx'];
    expect(fingerprintOf({ ...INV, 'p:pug-match.smx': '999.ffff0000' }, v)).toBe(fingerprintOf(INV, v));
    const { ['p:pug-match.smx']: _gone, ...without } = INV;
    expect(fingerprintOf(without, v)).not.toBe(fingerprintOf(INV, v));
  });
});

describe('diffInventories', () => {
  it('reports added, removed and changed keys', () => {
    const d = diffInventories({ a: '1', b: '2' }, { b: '3', c: '4' });
    expect(d).toEqual({ added: ['c'], removed: ['a'], changed: [{ key: 'b', from: '2', to: '3' }] });
    expect(formatDiff(d)).toBe('added c; removed a; b 2 -> 3');
  });
});

describe('recordBalanceSighting', () => {
  let db: ReturnType<typeof openDb>;
  let problems: string[];
  let unsub: () => void;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'live', 'x', ?)").run('b'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a')").run();
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    problems = [];
    unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
  });
  afterEach(() => unsub());

  it('creates a detected patch, tags the round and alerts once', () => {
    const r = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    expect(r).toMatchObject({ newPatch: true, serverChanged: true });
    const round = db.prepare('SELECT patch_id FROM match_rounds WHERE match_id = 1').get() as { patch_id: number };
    expect(round.patch_id).toBe(r.patchId);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/dallas/);

    const again = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    expect(again).toMatchObject({ patchId: r.patchId, newPatch: false, serverChanged: false });
    expect(problems).toHaveLength(1);
  });

  it('reports what changed and which servers now differ', () => {
    recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: INV, versionless: [] });
    problems.length = 0;
    const changed = { ...INV, 'p:l4d_itemlimiter.smx': '50.cccc0001' };
    const r = recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: changed, versionless: [] });
    expect(r.newPatch).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/chicago/);
    expect(problems[0]).toMatch(/added p:l4d_itemlimiter\.smx/);
    expect(problems[0]).toMatch(/differs from dallas/);
  });

  it('alerts with the time-ordered patch number, not the row id', () => {
    // First sighting gets row id 1 but a LATER first_seen_at than the one below.
    recordBalanceSighting(db, {
      matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [], now: '2026-06-01 00:00:00',
    });
    problems.length = 0;

    // Second sighting is a different inventory (a new patch), so it gets row
    // id 2, but its first_seen_at is EARLIER, so it ranks #1 on the admin
    // page (ROW_NUMBER OVER (ORDER BY first_seen_at, id)). The alert must
    // name it #1, not #2.
    const changed = { ...INV, 'p:l4d_itemlimiter.smx': '50.cccc0001' };
    const r = recordBalanceSighting(db, {
      matchId: 1, serverId: 2, half: 1, inventory: changed, versionless: [], now: '2020-01-01 00:00:00',
    });
    expect(r.patchId).toBe(2);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/new patch \(#1,/);
    expect(problems[0]).not.toMatch(/#2/);
  });

  it('alerts on a versionless plugin update without making a new patch', () => {
    const v = ['pug-match.smx'];
    const first = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: v });
    problems.length = 0;
    const bumped = { ...INV, 'p:pug-match.smx': '201.bbbb0002' };
    const r = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: bumped, versionless: v });
    expect(r).toMatchObject({ patchId: first.patchId, newPatch: false, serverChanged: true });
    expect(problems[0]).toMatch(/pug-match\.smx/);
  });

  it('drops an ignored plugin: same patch, no alert, not stored', () => {
    const ig = ['l4d2_spec_stays_spec.smx'];
    const first = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [], ignored: ig });
    problems.length = 0;
    const withSpec = { ...INV, 'p:l4d2_spec_stays_spec.smx': '8284.82ba5f50' };
    const r = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: withSpec, versionless: [], ignored: ig });
    expect(r).toMatchObject({ patchId: first.patchId, newPatch: false, serverChanged: false });
    expect(problems).toHaveLength(0);
    const stored = db.prepare('SELECT inventory_json FROM balance_server_state WHERE server_id = 1').get() as { inventory_json: string };
    expect(stored.inventory_json).not.toMatch(/spec_stays/);
  });

  it('a new detected patch is pending, remembers where the server came from, and the alert says so with a link', () => {
    const events: { text: string; link?: { label: string; path: string } }[] = [];
    const off = subscribeAdminEvents((e) => { if (e.kind === 'problem') events.push(e); });
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    const b = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: { ...INV, 'p:l4d_tvwatch.smx': '1.a' }, versionless: [] });
    off();
    const row = db.prepare('SELECT triage, came_from_patch_id FROM balance_patches WHERE id = ?').get(b.patchId);
    expect(row).toEqual({ triage: 'pending', came_from_patch_id: a.patchId });
    expect(events[1].text).toMatch(/new patch \(#2, needs triage\)/);
    expect(events[1].link).toEqual({ label: 'Triage it', path: '/admin/balance/patches' });
  });

  it('a sighting of a folded patch tags the round with its target, keeping the sighted patch', () => {
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    const b = recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: { ...INV, 'c:z_tank_health': '1' }, versionless: [] });
    db.prepare("UPDATE balance_patches SET triage = 'folded', folded_into = ? WHERE id = ?").run(a.patchId, b.patchId);
    const again = recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: { ...INV, 'c:z_tank_health': '1' }, versionless: [] });
    expect(again).toMatchObject({ patchId: b.patchId, effectivePatchId: a.patchId });
    expect(db.prepare('SELECT patch_id, sighted_patch_id FROM match_rounds WHERE match_id = 1').get())
      .toEqual({ patch_id: a.patchId, sighted_patch_id: b.patchId });
  });

  it('a watch-list-only change folds into the previous patch without an alert, on every box', () => {
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: INV, versionless: [] });
    problems.length = 0;
    const grown = { ...INV, 'w:weapon_smg.SpreadPerShot': '0.22', 'c:z_new': '5' };
    const b = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: grown, versionless: [] });
    expect(b).toMatchObject({ newPatch: true, effectivePatchId: a.patchId });
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?').get(b.patchId)).toEqual({ triage: 'folded', folded_into: a.patchId });
    const c = recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: grown, versionless: [] });
    expect(c).toMatchObject({ patchId: b.patchId, effectivePatchId: a.patchId });
    expect(problems).toEqual([]);
  });

  it('a changed value or a new plugin still asks for triage', () => {
    recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    problems.length = 0;
    const v = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: { ...INV, 'c:z_tank_health': '1', 'c:z_new': '5' }, versionless: [] });
    expect(db.prepare('SELECT triage FROM balance_patches WHERE id = ?').get(v.patchId)).toEqual({ triage: 'pending' });
    const p = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: { ...INV, 'c:z_tank_health': '1', 'c:z_new': '5', 'p:x.smx': '1.a' }, versionless: [] });
    expect(db.prepare('SELECT triage FROM balance_patches WHERE id = ?').get(p.patchId)).toEqual({ triage: 'pending' });
    expect(problems).toHaveLength(2);
  });

  it('stays quiet for the patch a rollout expects on that server', () => {
    // server 1 seen on inventory A, then on B which is the expected patch
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: { 'c:a': '1' }, versionless: [] });
    expect(a.serverChanged).toBe(true);
    const events: string[] = [];
    const off = subscribeAdminEvents((e) => { if (e.kind === 'problem') events.push(e.text); });
    db.prepare("INSERT INTO balance_patches (id, fingerprint, source, inputs_json, first_seen_at) VALUES (99, ?, 'announced', '{\"c:a\":\"2\"}', '2026-09-24 00:00:00')")
      .run(fingerprintOf({ 'c:a': '2' }, []));
    const b = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: { 'c:a': '2' }, versionless: [], expectedPatchId: 99 });
    off();
    expect(b).toMatchObject({ patchId: 99, serverChanged: true, newPatch: false });
    expect(events).toEqual([]);
    expect(db.prepare('SELECT patch_id FROM balance_server_state WHERE server_id = 1').get()).toEqual({ patch_id: 99 });
  });
});

describe('refingerprintPatches', () => {
  let db: ReturnType<typeof openDb>;
  let problems: string[];
  let unsub: () => void;
  const SPEC = 'l4d2_spec_stays_spec.smx';
  const withSpec = { ...INV, [`p:${SPEC}`]: '10.aaaa0001' };
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'live', 'x', ?)").run('e'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a'), (1, 0, 2, 'b')").run();
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    problems = [];
    unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
  });
  afterEach(() => unsub());

  it('collapses patches that differ only by a now-ignored plugin into the older one, once', () => {
    // Recorded before the plugin was on the ignored list: two patches.
    const older = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [], now: '2026-09-01 00:00:00' });
    const newer = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: withSpec, versionless: [], now: '2026-09-02 00:00:00' });
    expect(newer.newPatch).toBe(true);
    problems.length = 0;

    const r = refingerprintPatches(db, [], [SPEC]);
    expect(r.merged).toEqual([{ keep: older.patchId, into: [newer.patchId] }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`#2 \\(id ${newer.patchId}\\) into #1 \\(id ${older.patchId}\\)`));
    const fp = (id: number) => (db.prepare('SELECT fingerprint FROM balance_patches WHERE id = ?').get(id) as { fingerprint: string | null }).fingerprint;
    expect(fp(older.patchId)).toBe(fingerprintOf(withoutIgnored(INV, [SPEC]), []));
    expect(fp(newer.patchId)).toBeNull();
    // The merged patch is folded: its rounds count for the keeper.
    expect(db.prepare('SELECT patch_id, sighted_patch_id FROM match_rounds WHERE half = 2').get())
      .toEqual({ patch_id: older.patchId, sighted_patch_id: newer.patchId });
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?').get(newer.patchId))
      .toEqual({ triage: 'folded', folded_into: older.patchId });

    // A second run with the same lists is a no-op.
    const before = db.prepare('SELECT id, fingerprint FROM balance_patches ORDER BY id').all();
    expect(refingerprintPatches(db, [], [SPEC])).toEqual({ updated: 0, merged: [] });
    expect(db.prepare('SELECT id, fingerprint FROM balance_patches ORDER BY id').all()).toEqual(before);
    expect(problems).toHaveLength(1);

    // The next sighting of the unchanged box lands on the keeper, and the
    // server's state row follows it without an alert.
    const next = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: withSpec, versionless: [], ignored: [SPEC] });
    expect(next).toMatchObject({ patchId: older.patchId, newPatch: false, serverChanged: false });
    expect(db.prepare('SELECT patch_id FROM balance_server_state WHERE server_id = 1').get()).toEqual({ patch_id: older.patchId });
    expect(problems).toHaveLength(1);
  });

  it('a balance patch keeps the fingerprint over an older pending one', () => {
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: withSpec, versionless: [] });
    const b = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: INV, versionless: [] });
    db.prepare("UPDATE balance_patches SET triage = 'balance', name = 'Real' WHERE id = ?").run(b.patchId);
    const r = refingerprintPatches(db, [], [SPEC], () => {});
    expect(r.merged).toEqual([{ keep: b.patchId, into: [a.patchId] }]);
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?').get(a.patchId))
      .toEqual({ triage: 'folded', folded_into: b.patchId });
  });

  it('the active rollout patch and a published patch keep the fingerprint over an older balance one', () => {
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: withSpec, versionless: [] });
    const b = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: INV, versionless: [] });
    db.prepare("UPDATE balance_patches SET triage = 'balance'").run();
    db.prepare("UPDATE balance_patches SET published_at = '2026-09-24 00:00:00' WHERE id = ?").run(b.patchId);
    expect(refingerprintPatches(db, [], [SPEC], () => {}).merged).toEqual([{ keep: b.patchId, into: [a.patchId] }]);
    expect(db.prepare('SELECT published_at FROM balance_patches WHERE id = ?').get(b.patchId)).toEqual({ published_at: '2026-09-24 00:00:00' });
  });

  it('resolves a merged patch left by the backfill: folded into the holder, else balance', () => {
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    const ins = db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage) VALUES (NULL, 'detected', ?, '2026-09-24 00:00:00', NULL)");
    const merged = Number(ins.run(JSON.stringify(withSpec)).lastInsertRowid);
    const orphan = Number(ins.run(JSON.stringify({ 'c:x': '1' })).lastInsertRowid);
    refingerprintPatches(db, [], [SPEC], () => {});
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?').get(merged)).toEqual({ triage: 'folded', folded_into: a.patchId });
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?').get(orphan)).toEqual({ triage: 'balance', folded_into: null });
  });

  it('updates a still-unique fingerprint in place without an alert', () => {
    const only = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: withSpec, versionless: [] });
    problems.length = 0;
    const r = refingerprintPatches(db, [], [SPEC]);
    expect(r).toEqual({ updated: 1, merged: [] });
    expect(db.prepare('SELECT fingerprint FROM balance_patches WHERE id = ?').get(only.patchId))
      .toEqual({ fingerprint: fingerprintOf(withoutIgnored(withSpec, [SPEC]), []) });
    expect(problems).toHaveLength(0);
  });
});

describe('listPatches countedRounds', () => {
  it('counts only computed rounds of completed, non-voided matches; rounds counts everything', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (1, 'P', 'detected', '2026-09-01 00:00:00')").run();
    const match = db.prepare("INSERT INTO matches (id, season_id, state, campaign, voided_at) VALUES (?, 1, ?, 'x', ?)");
    match.run(1, 'completed', null);
    match.run(2, 'completed', '2026-09-02 00:00:00');
    match.run(3, 'live', null);
    for (const id of [1, 2, 3]) {
      db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, patch_id) VALUES (?, 0, 1, 'a', 1), (?, 0, 2, 'b', 1)").run(id, id);
      db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, patch_id, has_replay, has_stats, engine, computed_at)
        VALUES (?, 0, 1, 1, 0, 0, 'e', 'n'), (?, 0, 2, 1, 0, 0, 'e', 'n')`).run(id, id);
    }
    const [p] = listPatches(db);
    expect(p.rounds).toBe(6);
    expect(p.countedRounds).toBe(2);
  });
});

describe('listPatches merged', () => {
  it('marks a folded patch as merged', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO balance_patches (id, fingerprint, name, source, inputs_json, first_seen_at, triage, folded_into) VALUES
      (1, NULL, 'Old', 'historical', NULL, '2026-09-01 00:00:00', 'balance', NULL),
      (2, 'aaaa', NULL, 'detected', '{}', '2026-09-23 20:41:53', 'pending', NULL),
      (3, NULL, NULL, 'detected', '{}', '2026-09-24 05:41:10', 'folded', 2)`).run();
    expect(listPatches(db).map((p) => [p.id, p.merged])).toEqual([[1, false], [2, false], [3, true]]);
  });
});
