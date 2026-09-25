import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { recordBalanceSighting, listPatches, serverDrift } from '../src/balancePatches.js';
import { describeChanges, triageBalance, triageFold, triageIgnore, triageInfo, triageUnfold } from '../src/balanceTriage.js';
import { siteIgnored } from '../src/balanceIgnore.js';

type DB = ReturnType<typeof openDb>;
const BASE = { 'c:z_tank_health': '8000', 'p:pug-match.smx': '1.a', 'p:l4d_skypounce.smx': '2.b', 'f:cfg/pug_match.cfg': '10.c' };
const LISTS = { versionless: ['pug-match.smx'], ignored: [] as string[] };

describe('describeChanges', () => {
  it('words each difference and spots plugin-only changes', () => {
    const plug = describeChanges(BASE, { ...BASE, 'p:l4d_tvwatch.smx': '3.c', 'p:pug-match.smx': '9.z' }, LISTS.versionless);
    expect(plug).toEqual({ lines: ['plugin added: l4d_tvwatch'], plugins: ['l4d_tvwatch.smx'], onlyPlugins: true });
    const mixed = describeChanges(BASE, { ...BASE, 'c:z_tank_health': '7500', 'f:cfg/pug_match.cfg': '11.d', 'p:l4d_skypounce.smx': '3.x' }, []);
    expect(mixed.lines).toEqual(['plugin updated: l4d_skypounce', 'z_tank_health 8000 -> 7500', 'file changed: pug_match.cfg']);
    expect(mixed.onlyPlugins).toBe(false);
    expect(describeChanges(BASE, BASE, []).onlyPlugins).toBe(false);
  });
});

describe('describeChanges, plugins in a subfolder', () => {
  it('skips a versionless one by file name and offers its file name for the ignore list', () => {
    const a = { ...BASE, 'p:optional/l4d_tankhud.smx': '1.a', 'p:optional/l4d_storm.smx': '1.a' };
    const d = describeChanges(a, { ...a, 'p:optional/l4d_tankhud.smx': '2.b', 'p:optional/l4d_storm.smx': '2.b' }, ['l4d_tankhud.smx']);
    expect(d).toEqual({ lines: ['plugin updated: l4d_storm'], plugins: ['l4d_storm.smx'], onlyPlugins: true });
  });
});

describe('triage decisions', () => {
  let db: DB;
  let base: number, noisy: number, real: number;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('a'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a'), (1, 0, 2, 'b')").run();
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const s = (inv: Record<string, string>, half: 1 | 2, now: string) =>
      recordBalanceSighting(db, { matchId: 1, serverId: 1, half, inventory: inv, versionless: LISTS.versionless, now }).patchId;
    base = s(BASE, 1, '2026-09-20 00:00:00');
    db.prepare("UPDATE balance_patches SET triage = 'balance', name = 'Base' WHERE id = ?").run(base);
    noisy = s({ ...BASE, 'p:l4d_tvwatch.smx': '3.c' }, 2, '2026-09-21 00:00:00');
    real = Number(db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage) VALUES ('r', 'detected', ?, '2026-09-22 00:00:00', 'pending')")
      .run(JSON.stringify({ ...BASE, 'c:z_tank_health': '7500' })).lastInsertRowid);
  });

  it('the card info: base is where the server came from, changes worded, plugin-only hint', () => {
    expect(triageInfo(db, noisy, LISTS)).toEqual({
      base: { id: base, number: 1, name: 'Base' }, changes: ['plugin added: l4d_tvwatch'],
      plugins: ['l4d_tvwatch.smx'], onlyPluginsChanged: true,
    });
    // No came_from: falls back to the newest earlier balance patch with inputs.
    expect(triageInfo(db, real, LISTS).base?.id).toBe(base);
  });

  it('the base is always a balance patch: a pending one it came from is skipped', () => {
    // noisy (pending) came from base; a patch coming from noisy is judged against base.
    const later = Number(db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage, came_from_patch_id) VALUES ('l', 'detected', ?, '2026-09-23 00:00:00', 'pending', ?)")
      .run(JSON.stringify({ ...BASE, 'c:z_tank_health': '7000' }), noisy).lastInsertRowid);
    expect(triageInfo(db, later, LISTS).base?.id).toBe(base);
    expect(triageInfo(db, real, LISTS).base?.id).toBe(base);
  });

  it('balance needs a name and only applies to a pending patch', () => {
    expect(triageBalance(db, noisy, { name: ' ', notes: '' })).toMatchObject({ ok: false, status: 400 });
    expect(triageBalance(db, noisy, { name: 'Tv', notes: 'n' })).toEqual({ ok: true });
    expect(db.prepare('SELECT triage, name, notes, reviewed FROM balance_patches WHERE id = ?').get(noisy))
      .toEqual({ triage: 'balance', name: 'Tv', notes: 'n', reviewed: 1 });
    expect(triageBalance(db, noisy, { name: 'Tv', notes: '' })).toMatchObject({ ok: false, status: 409 });
  });

  it('fold moves rounds to a balance target; refuses a pending target, announced source, active rollout', () => {
    expect(triageFold(db, noisy, real)).toMatchObject({ ok: false, status: 400 });
    expect(triageFold(db, noisy, base)).toEqual({ ok: true, target: base });
    expect(db.prepare('SELECT patch_id FROM match_rounds WHERE half = 2').get()).toEqual({ patch_id: base });
    expect(listPatches(db, LISTS).find((p) => p.id === noisy)).toMatchObject({
      triage: 'folded', foldedInto: base, merged: true, changes: ['plugin added: l4d_tvwatch'],
    });
    const ann = Number(db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage) VALUES ('an', 'announced', '{}', '2026-09-23 00:00:00', 'balance')").run().lastInsertRowid);
    expect(triageFold(db, ann, base)).toMatchObject({ ok: false, status: 400 });
    db.prepare("INSERT INTO balance_rollouts (patch_id, values_json, content, created_by, created_at) VALUES (?, '{}', '', '1', 'x')").run(real);
    db.prepare("UPDATE balance_patches SET triage = 'balance', name = 'R' WHERE id = ?").run(real);
    expect(triageFold(db, real, base)).toMatchObject({ ok: false, status: 409 });
  });

  it('unfold restores and returns to pending', () => {
    triageFold(db, noisy, base);
    expect(triageUnfold(db, noisy)).toEqual({ ok: true });
    expect(db.prepare('SELECT patch_id FROM match_rounds WHERE half = 2').get()).toEqual({ patch_id: noisy });
    expect(triageUnfold(db, noisy)).toMatchObject({ ok: false, status: 409 });
  });

  it('ignore: plugin-only diffs only, adds the plugins, refingerprints and folds', () => {
    expect(triageIgnore(db, real, { into: base, plugins: [], versionless: LISTS.versionless, knobsIgnored: [], adminId: '1' }))
      .toMatchObject({ ok: false, status: 400 });
    expect(triageIgnore(db, noisy, { into: base, plugins: ['other.smx'], versionless: LISTS.versionless, knobsIgnored: [], adminId: '1' }))
      .toMatchObject({ ok: false, status: 400 });
    expect(triageIgnore(db, noisy, { into: base, plugins: ['l4d_tvwatch.smx'], versionless: LISTS.versionless, knobsIgnored: [], adminId: '1' }))
      .toEqual({ ok: true, target: base });
    expect(siteIgnored(db)).toEqual(['l4d_tvwatch.smx']);
    expect(db.prepare('SELECT triage, folded_into, fingerprint IS NULL AS merged FROM balance_patches WHERE id = ?').get(noisy))
      .toEqual({ triage: 'folded', folded_into: base, merged: 1 });
    // A new sighting with the plugin now lands on the base patch.
    const again = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: { ...BASE, 'p:l4d_tvwatch.smx': '3.c' },
      versionless: LISTS.versionless, ignored: ['l4d_tvwatch.smx'] });
    expect(again.patchId).toBe(base);
  });

  it('drift uses the ignored list it is given', () => {
    addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: BASE, versionless: LISTS.versionless });
    expect(serverDrift(db, []).find((s) => s.name === 'dallas')!.differsFrom).toHaveLength(1);
    expect(serverDrift(db, ['l4d_tvwatch.smx']).find((s) => s.name === 'dallas')!.differsFrom).toEqual([]);
  });
});
