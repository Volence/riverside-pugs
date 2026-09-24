import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { listPublished, patchTimeline, publicChanges, publishPatch } from '../src/balancePublic.js';
import { listPatches } from '../src/balancePatches.js';

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
  db.prepare(`INSERT INTO balance_patches (id, name, notes, source, inputs_json, first_seen_at) VALUES
    (1, 'Old', 'old notes', 'historical', NULL, '2000-01-01 00:00:00'),
    (2, 'Mid', 'mid notes', 'detected', '{}', '2026-09-10 00:00:00'),
    (3, NULL, '', 'detected', '{}', '2026-09-20 00:00:00')`).run();
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
  it('lists a watched file that appears or disappears, and falls back to raw names without knobs', () => {
    expect(publicChanges({}, { 'f:cfg/new.cfg': '1.aaaaaaaa' }, KNOBS).files).toEqual(['cfg/new.cfg']);
    expect(publicChanges({ 'c:z_tank_health': '1' }, { 'c:z_tank_health': '2' }, null).knobs).toEqual([{ label: 'z_tank_health', from: '1', to: '2' }]);
  });
});
