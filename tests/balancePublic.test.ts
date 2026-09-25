import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { adminDefaultCompare, listPublished, patchTimeline, publicChanges, publicEntry, publishPatch } from '../src/balancePublic.js';
import { listPatches } from '../src/balancePatches.js';
import { compareSides } from '../src/metrics/compare/compare.js';
import { PUBLIC_METRICS, ENGINE } from '../src/metrics/registry.js';

type DBT = ReturnType<typeof openDb>;
/** Adds `n` completed matches with two counted rounds each on `patch`, ended on `day`. */
function addMatches(db: DBT, patch: number, n: number, day: string, opts: { voided?: boolean; startId?: number } = {}) {
  const match = db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin, ended_at, voided_at) VALUES (?, 1, 'completed', 'x', 'queue', ?, ?)");
  const ctx = db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, surv_mu, inf_mu, has_replay, has_stats, engine, computed_at)
    VALUES (?, 0, ?, 'mapA', 'queue', ?, 25, 25, 0, 0, 'e', 'n')`);
  let id = opts.startId ?? ((db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM matches').get() as { m: number }).m + 1);
  for (let i = 0; i < n; i++, id++) {
    match.run(id, `${day} 10:${String(i % 60).padStart(2, '0')}:00`, opts.voided ? '2026-09-30 00:00:00' : null);
    for (const half of [1, 2]) ctx.run(id, half, patch);
  }
}

let db: DBT;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare(`INSERT INTO balance_patches (id, fingerprint, name, notes, source, inputs_json, first_seen_at) VALUES
    (1, NULL, 'Old', 'old notes', 'historical', NULL, '2000-01-01 00:00:00'),
    (2, 'fp2', 'Mid', 'mid notes', 'detected', '{}', '2026-09-10 00:00:00'),
    (3, 'fp3', NULL, '', 'detected', '{}', '2026-09-20 00:00:00')`).run();
});

describe('patchTimeline', () => {
  it('orders by first counted round, not first_seen_at, and counts only counted rounds', () => {
    addMatches(db, 2, 2, '2026-09-11');
    addMatches(db, 1, 3, '2026-09-12');           // historical patch whose rounds come later
    addMatches(db, 1, 1, '2026-09-13', { voided: true });
    const t = patchTimeline(db);
    expect(t.map((p) => p.id)).toEqual([2, 1, 3]);
    const old = t.find((p) => p.id === 1)!;
    expect(old).toMatchObject({ matches: 3, rounds: 6, approximate: true, firstRound: '2026-09-12 10:00:00', lastRound: '2026-09-12 10:02:00' });
    expect(t.find((p) => p.id === 3)).toMatchObject({ matches: 0, rounds: 0, firstRound: null, name: 'Patch 3' });
  });
});

describe('publishPatch', () => {
  it('refuses a patch without a name, notes or counted rounds, naming what is missing', () => {
    expect(publishPatch(db, 3, true)).toEqual({ ok: false, status: 400, error: expect.stringMatching(/name/) });
    db.prepare("UPDATE balance_patches SET name = 'New', notes = '  ' WHERE id = 3").run();
    expect(publishPatch(db, 3, true)).toEqual({ ok: false, status: 400, error: expect.stringMatching(/notes/) });
    db.prepare("UPDATE balance_patches SET notes = 'why' WHERE id = 3").run();
    expect(publishPatch(db, 3, true)).toEqual({ ok: false, status: 400, error: expect.stringMatching(/counted round/) });
    expect(publishPatch(db, 99, true)).toEqual({ ok: false, status: 404, error: 'no such patch' });
  });
  it('refuses a pending patch: triage it first', () => {
    db.prepare("UPDATE balance_patches SET name = 'New', notes = 'n', triage = 'pending' WHERE id = 3").run();
    addMatches(db, 3, 1, '2026-09-21');
    expect(publishPatch(db, 3, true)).toEqual({ ok: false, status: 400, error: expect.stringMatching(/triage it first/) });
  });
  it('refuses a folded patch: its config counts as the one it was folded into, so it would compare a config with itself', () => {
    db.prepare("UPDATE balance_patches SET name = 'Dup', notes = 'n', triage = 'folded', folded_into = 2 WHERE id = 3").run();
    addMatches(db, 3, 1, '2026-09-21');
    expect(listPatches(db).find((p) => p.id === 3)!.merged).toBe(true);
    expect(publishPatch(db, 3, true)).toEqual({ ok: false, status: 400, error: expect.stringMatching(/folded/) });
    expect(listPublished(db)).toEqual([]);
    // Unpublishing one published before it was merged still works.
    db.prepare("UPDATE balance_patches SET published_at = '2026-09-22 00:00:00' WHERE id = 3").run();
    expect(publishPatch(db, 3, false)).toEqual({ ok: true });
  });
  it('publishes, keeps the first publish time on a repeat, and unpublishes', () => {
    addMatches(db, 2, 1, '2026-09-11');
    expect(publishPatch(db, 2, true, '2026-09-24 01:00:00')).toEqual({ ok: true });
    expect(publishPatch(db, 2, true, '2026-09-25 01:00:00')).toEqual({ ok: true });
    expect(listPublished(db).map((p) => [p.id, p.publishedAt])).toEqual([[2, '2026-09-24 01:00:00']]);
    expect(listPatches(db).find((p) => p.id === 2)!.publishedAt).toBe('2026-09-24 01:00:00');
    expect(publishPatch(db, 2, false)).toEqual({ ok: true });
    expect(listPublished(db)).toEqual([]);
  });
  it('lists published patches newest first', () => {
    addMatches(db, 1, 1, '2026-09-05');
    addMatches(db, 2, 1, '2026-09-11');
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    expect(listPublished(db).map((p) => p.id)).toEqual([2, 1]);
    expect(JSON.stringify(listPublished(db))).not.toMatch(/inputs|fingerprint|hasInputs/);
  });
});

const KNOBS = {
  cvars: [{ cvar: 'z_tank_health', label: 'Tank base health', group: 'tank' }],
  files: [{ path: 'cfg/pug_match.cfg', label: 'PUG match config' }],
  dirs: [{ path: 'addons/stripper/Roto-AZMod/maps', ext: '.cfg', label: 'Stripper per-map configs' }],
  versionless: ['pug-match.smx'],
  ignored: ['l4d_tvwatch.smx'],
};

describe('publicChanges', () => {
  const prev = {
    'c:z_tank_health': '8000', 'c:tongue_hit_delay': '13', 'c:only_prev': '1',
    'p:l4d_skypounce.smx': '100.aaaaaaaa', 'p:old_thing.smx': '5.bbbbbbbb', 'p:pug-match.smx': '9.cccccccc',
    'f:cfg/pug_match.cfg': '10.dddddddd', 'f:cfg/other.cfg': '11.eeeeeeee',
    'd:addons/stripper/Roto-AZMod/maps': '138.ffffffff',
  };
  const cur = {
    'c:z_tank_health': '7500', 'c:tongue_hit_delay': '10', 'c:only_cur': '2',
    'p:l4d_skypounce.smx': '101.11111111', 'p:new_thing.smx': '7.22222222', 'p:pug-match.smx': '9.33333333',
    'p:l4d_tvwatch.smx': '1.44444444',
    'f:cfg/pug_match.cfg': '10.55555555', 'f:cfg/other.cfg': '11.eeeeeeee',
    'd:addons/stripper/Roto-AZMod/maps': '139.66666666',
  };
  it('labels knobs, names plugins without .smx and files by label, and never leaks hashes', () => {
    const c = publicChanges(prev, cur, KNOBS);
    expect(c).toEqual({
      knobs: [{ label: 'Tank base health', from: '8000', to: '7500' }, { label: 'tongue_hit_delay', from: '13', to: '10' }],
      pluginsAdded: ['new_thing'], pluginsRemoved: ['old_thing'], pluginsUpdated: ['l4d_skypounce'],
      files: ['PUG match config', 'Stripper per-map configs'],
    });
    expect(JSON.stringify(c)).not.toMatch(/[0-9a-f]{8}|\.smx|cfg\/|c:|p:|f:|d:/);
  });
  it('ignores versionless plugin rebuilds and ignored plugins, but shows a versionless plugin appearing', () => {
    const c = publicChanges({ 'p:pug-match.smx': '1.aaaaaaaa' }, { 'p:pug-match.smx': '2.bbbbbbbb', 'p:l4d_tvwatch.smx': '1.cccccccc' }, KNOBS);
    expect(c.pluginsUpdated).toEqual([]); expect(c.pluginsAdded).toEqual([]);
    expect(publicChanges({}, { 'p:pug-match.smx': '1.aaaaaaaa' }, KNOBS).pluginsAdded).toEqual(['pug-match']);
  });
  it('lists weapon stat changes by label, like cvars, and skips a key on one side only', () => {
    const k = { ...KNOBS, weapons: [{ weapon: 'weapon_smg', key: 'Damage', label: 'Uzi damage' }] };
    const c = publicChanges(
      { 'w:weapon_smg.Damage': '24', 'w:weapon_pumpshotgun.Damage': 'default', 'w:weapon_only.Prev': '1' },
      { 'w:weapon_smg.Damage': 'default', 'w:weapon_pumpshotgun.Damage': '25', 'w:weapon_only.Cur': '1' }, k);
    expect(c.knobs).toEqual([
      { label: 'Uzi damage', from: '24', to: 'game default' },
      { label: 'weapon_pumpshotgun.Damage', from: 'game default', to: '25' },
    ]);
  });
  it('lists a watched file that appears or disappears, and falls back to raw names without knobs', () => {
    expect(publicChanges({}, { 'f:cfg/new.cfg': '1.aaaaaaaa' }, KNOBS).files).toEqual(['cfg/new.cfg']);
    expect(publicChanges({ 'c:z_tank_health': '1' }, { 'c:z_tank_health': '2' }, null).knobs).toEqual([{ label: 'z_tank_health', from: '1', to: '2' }]);
  });
});

/** Patch 1: 40 matches, saferoom 20%. Patch 2: 40 matches, saferoom 80%.
 *  tank.spawns identical trend on both, an admin-only metric that must never
 *  leak to the public entry. One map. Notes and inputs_json set so both
 *  publishing and the change list work (see tests/metrics/compare.test.ts setup()). */
// The compare-result cache (src/metrics/compare/cache.ts memo()) is a
// module-level Map keyed by cache key + dataStamp, shared by every test in
// this process. A dataStamp is just the round_metric_context row count plus
// its MAX(computed_at), so two different :memory: dbs built by compareDb()
// with the same shape would otherwise collide on the same cache entry across
// tests. Tagging each build's rows with a unique computed_at (as a real
// recompute would naturally have a unique timestamp) keeps every test's
// adminDefaultCompare call looking at its own db.
let compareDbSeq = 0;

function compareDb(nA = 40, nB = 40) {
  const db = openDb(':memory:');
  const computedAt = `n${++compareDbSeq}`;
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare(`INSERT INTO balance_patches (id, fingerprint, name, notes, source, inputs_json, first_seen_at) VALUES
    (1, 'fp1', 'Old', 'old notes', 'detected', '{"c:z_tank_health":"8000"}', '2026-09-01 00:00:00'),
    (2, 'fp2', 'New', 'new notes', 'detected', '{"c:z_tank_health":"7500"}', '2026-09-10 00:00:00')`).run();
  const match = db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin, ended_at) VALUES (?, 1, 'completed', 'x', 'queue', ?)");
  const ctx = db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, surv_mu, inf_mu, has_replay, has_stats, engine, computed_at)
    VALUES (?, 0, ?, 'mapA', 'queue', ?, 25, 25, 0, 0, ?, '${computedAt}')`);
  const row = db.prepare('INSERT INTO round_metrics VALUES (?, 0, ?, ?, ?, ?, ?)');
  let id = 1;
  const add = (patch: number, n: number, safeEvery: number, day: number) => {
    for (let i = 0; i < n; i++, id++) {
      match.run(id, `2026-09-${String(day).padStart(2, '0')} 10:${String(i).padStart(2, '0')}:00`);
      for (const half of [1, 2]) {
        ctx.run(id, half, patch, ENGINE);
        row.run(id, half, 'round.saferoom', 'all', (i * 2 + half) % safeEvery === 0 ? 1 : 0, 1);
        row.run(id, half, 'tank.spawns', 'all', (i + half) % 3 === 0 || (patch === 2 && i % 7 === 0) ? 2 : 1, 1);
        row.run(id, half, 'round.saferoom', 'tank', (i * 2 + half) % safeEvery === 0 ? 1 : 0, 1);
        row.run(id, half, 'tank.spawns', 'tank', 1, 1);
        row.run(id, half, 'round.saferoom', 'witch', (i + half) % 3 === 0 ? 1 : 0, 1);
      }
    }
  };
  add(1, nA, 5, 5);   // 1 in 5 rounds safe
  add(2, nB, 1, 15);  // x % 1 === 0 always holds: every side B round is safe
  return db;
}

describe('publicEntry', () => {
  it('is null for unknown or unpublished ids unless previewing', () => {
    const db = compareDb();
    expect(publicEntry(db, 99, { knobs: null })).toBeNull();
    expect(publicEntry(db, 2, { knobs: null })).toBeNull();
    expect(publicEntry(db, 2, { knobs: null, preview: true })).not.toBeNull();
  });

  it('first published patch: no baseline, no comparison', () => {
    const db = compareDb();
    publishPatch(db, 1, true);
    expect(publicEntry(db, 1, { knobs: null })).toMatchObject({ status: 'first', previous: null, effect: null, changes: null, changesUnavailable: 'first' });
  });

  it('parity: public rows equal the admin default rows filtered to the allowlist', () => {
    const db = compareDb();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    const e = publicEntry(db, 2, { knobs: null })!;
    expect(e.status).toBe('compared');
    expect(e.previous).toEqual({ id: 1, name: 'Old' });
    expect(e.changes!.knobs).toEqual([{ label: 'z_tank_health', from: '8000', to: '7500' }]);
    const admin = compareSides(db, { patchIds: [1], origin: 'all', maps: null }, { patchIds: [2], origin: 'all', maps: null }, { phases: 'all' });
    const pub = new Set(PUBLIC_METRICS.map((m) => m.id));
    const adminRows = admin.rows.filter((r) => pub.has(r.metric));
    for (const r of adminRows) {
      const p = e.effect!.rows.find((x) => x.metric === r.metric)!;
      expect({ v: p.verdict, a: p.a, b: p.b, lo: p.lo, hi: p.hi }).toEqual({ v: r.verdict, a: r.a, b: r.b, lo: r.lo, hi: r.hi });
    }
    expect(e.effect!.rows.find((x) => x.metric === 'round.saferoom')!.verdict).toBe('real');
    // Admin-only metrics never leak.
    expect(e.effect!.rows.some((x) => x.metric === 'tank.spawns')).toBe(false);
    // Every allowlisted metric is listed, missing ones as no data.
    expect(e.effect!.rows.map((x) => x.metric).sort()).toEqual([...pub].sort());
    expect(e.effect!.rows.find((x) => x.metric === 'witch.crown_rate')).toMatchObject({ verdict: 'no_data', a: null, b: null, nA: 0, nB: 0 });
    expect(JSON.stringify(e)).not.toMatch(/meanMu|meanGap|fingerprint|inputs_json|"p":/);
  });

  it('parity fixture row order: the real saferoom row first, every no_data row after every other row', () => {
    const db = compareDb();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    const rows = publicEntry(db, 2, { knobs: null })!.effect!.rows;
    expect(rows[0]).toMatchObject({ metric: 'round.saferoom', verdict: 'real' });
    const firstNoData = rows.findIndex((r) => r.verdict === 'no_data');
    expect(firstNoData).toBeGreaterThan(0);
    expect(rows.slice(firstNoData).every((r) => r.verdict === 'no_data')).toBe(true);
  });

  it('shares the admin cache entry', () => {
    const db = compareDb();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    const first = adminDefaultCompare(db, 1, 2);
    expect(adminDefaultCompare(db, 1, 2)).toBe(first);
  });

  it('skips a published baseline with no counted rounds, and diffs across an unpublished patch', () => {
    const db = compareDb();
    // Patch 3: published, no rounds, between 1 and 2 by first_seen_at.
    db.prepare(`INSERT INTO balance_patches (id, fingerprint, name, notes, source, inputs_json, first_seen_at, published_at)
      VALUES (3, 'fp3', 'Empty', 'n', 'detected', '{"c:z_tank_health":"7000"}', '2026-09-09 00:00:00', '2026-09-24 00:00:00')`).run();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    const e = publicEntry(db, 2, { knobs: null })!;
    expect(e.previous!.id).toBe(1);
    expect(e.changes!.knobs[0]).toMatchObject({ from: '8000', to: '7500' });
    expect(publicEntry(db, 3, { knobs: null })).toMatchObject({ status: 'no_rounds', effect: null, matches: 0 });
  });

  it('historical patch: approximate, no change list; a baseline without inputs gives previous_unrecorded', () => {
    const db = compareDb();
    db.prepare("UPDATE balance_patches SET source = 'historical', inputs_json = NULL WHERE id = 1").run();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    expect(publicEntry(db, 1, { knobs: null })).toMatchObject({ approximate: true, changes: null, changesUnavailable: 'first' });
    const e = publicEntry(db, 2, { knobs: null })!;
    expect(e).toMatchObject({ changes: null, changesUnavailable: 'previous_unrecorded' });
    expect(e.effect!.approximate).toBe(true);
  });

  it('a later historical patch shows changesUnavailable historical, not previous_unrecorded', () => {
    const db = compareDb();
    db.prepare("UPDATE balance_patches SET source = 'historical' WHERE id = 2").run();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    const e = publicEntry(db, 2, { knobs: null })!;
    expect(e).toMatchObject({ approximate: true, changes: null, changesUnavailable: 'historical' });
  });

  it('live: the newest published patch is live, an older one is not', () => {
    const db = compareDb();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    expect(publicEntry(db, 2, { knobs: null })!.live).toBe(true);
    expect(publicEntry(db, 1, { knobs: null })!.live).toBe(false);
  });

  it('live: an older patch a server is currently on is live', () => {
    const db = compareDb();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    db.prepare("INSERT INTO balance_server_state (server_id, patch_id, inventory_json, since) VALUES (7, 1, '{}', '2026-09-20 00:00:00')").run();
    expect(publicEntry(db, 1, { knobs: null })!.live).toBe(true);
  });

  it('live: a preview counts as newest among the published patches plus itself', () => {
    const db = compareDb();
    publishPatch(db, 1, true);
    expect(publicEntry(db, 2, { knobs: null, preview: true })!.live).toBe(true);
    expect(publicEntry(db, 1, { knobs: null })!.live).toBe(true);
  });

  it('a non-historical patch without recorded inputs gives unrecorded, or first without a baseline', () => {
    const db = compareDb();
    db.prepare('UPDATE balance_patches SET inputs_json = NULL').run();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    expect(publicEntry(db, 2, { knobs: null })).toMatchObject({ changes: null, changesUnavailable: 'unrecorded' });
    expect(publicEntry(db, 1, { knobs: null })).toMatchObject({ changes: null, changesUnavailable: 'first' });
  });
});
