import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { fingerprintOf } from '../src/balancePatches.js';
import {
  baseInventory, blockingServers, currentValues, missingKnobs, predictInventory, previewKnobs,
  renderBalanceCfg, restoreValues, validateDraft,
} from '../src/balanceControl.js';
import { KNOBS, LIVE, sight } from './balanceFixtures.js';

type DB = ReturnType<typeof openDb>;

let db: DB;
let s1: number;
let s2: number;
beforeEach(() => {
  db = openDb(':memory:');
  s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
});

describe('baseInventory', () => {
  it('is the patch of the latest queue round, never an in-game one', () => {
    expect(baseInventory(db)).toBeNull();
    const q = sight(db, 1, s1, LIVE);
    sight(db, 2, s1, { ...LIVE, 'c:z_tank_health': '3480' }, 'in_game', '2026-09-24 02:00:00');
    expect(baseInventory(db)?.patchId).toBe(q.patchId);
    expect(baseInventory(db)?.inventory['c:z_tank_health']).toBe('8000');
  });
});

describe('prediction', () => {
  it('equals the fingerprint of a real sighting with the same values', () => {
    const predicted = predictInventory(LIVE, KNOBS, { z_tank_health: '7500', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' });
    const real = sight(db, 1, s1, { ...LIVE, 'c:z_tank_health': '7500', 'p:pug-match.smx': '9.zzzz', 'p:l4d_tvwatch.smx': '1.1' });
    const fp = db.prepare('SELECT fingerprint FROM balance_patches WHERE id = ?').get(real.patchId) as { fingerprint: string };
    expect(fingerprintOf(predicted, KNOBS.versionless)).toBe(fp.fingerprint);
  });

  it('a changed value changes the fingerprint; "0.1" and "0.10" differ', () => {
    const v = { z_tank_health: '8000', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' };
    const a = fingerprintOf(predictInventory(LIVE, KNOBS, v), KNOBS.versionless);
    expect(a).toBe(fingerprintOf(LIVE, KNOBS.versionless));
    expect(fingerprintOf(predictInventory(LIVE, KNOBS, { ...v, z_tank_health: '7750' }), KNOBS.versionless)).not.toBe(a);
    expect(fingerprintOf(predictInventory(LIVE, KNOBS, { ...v, versus_boss_flow_min: '0.1' }), KNOBS.versionless)).not.toBe(a);
  });

  it('names a knob the servers do not report', () => {
    const { ['c:z_tank_health']: _gone, ...rest } = LIVE;
    expect(missingKnobs({ ...rest, 'x:z_tank_health': 'missing' }, KNOBS)).toEqual(['z_tank_health']);
  });
});

describe('blockingServers', () => {
  it('ignores knob values and versionless builds, reports anything else', () => {
    sight(db, 1, s1, LIVE);
    sight(db, 2, s2, { ...LIVE, 'c:z_tank_health': '7500', 'p:pug-match.smx': '5.ffff' });
    expect(blockingServers(db, LIVE, KNOBS)).toEqual([]);
    sight(db, 3, s2, { ...LIVE, 'p:l4d_itemlimiter.smx': '3.cccc' });
    expect(blockingServers(db, LIVE, KNOBS)).toEqual([{ serverId: s2, name: 'chicago', diff: 'added p:l4d_itemlimiter.smx' }]);
  });

  it('skips a disabled server', () => {
    sight(db, 1, s2, { ...LIVE, 'p:l4d_itemlimiter.smx': '3.cccc' });
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    expect(blockingServers(db, LIVE, KNOBS)).toEqual([]);
  });
});

describe('validateDraft', () => {
  const cur = { z_tank_health: '8000', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' };
  it('fills missing knobs from current values and normalises', () => {
    expect(validateDraft(KNOBS, { versus_boss_flow_min: 0.15 }, cur)).toEqual({ values: { ...cur, versus_boss_flow_min: '0.15' }, errors: [] });
  });
  it('rejects unknown and watch-only knobs, bad values and a broken pair', () => {
    expect(validateDraft(KNOBS, { z_witch_health: '900' }, cur).errors).toEqual(['z_witch_health is not an adjustable knob']);
    expect(validateDraft(KNOBS, { z_tank_health: '5000' }, cur).errors[0]).toMatch(/outside/);
    expect(validateDraft(KNOBS, { versus_boss_flow_min: '0.30', versus_boss_flow_max: '0.20' }, cur).errors)
      .toEqual(['Flow min must not be above Flow max']);
    expect(validateDraft(KNOBS, 'nope', cur).errors).toEqual(['values must be an object']);
  });
  it('re-validates a value carried over from current, unless the draft sets it', () => {
    const bad = { ...cur, z_tank_health: '12000' };
    expect(validateDraft(KNOBS, { versus_boss_flow_min: '0.15' }, bad).errors)
      .toEqual(['Tank health: current value 12000 is outside the safe range; set it in this draft']);
    expect(validateDraft(KNOBS, { z_tank_health: '9000' }, bad)).toEqual({ values: { ...cur, z_tank_health: '9000' }, errors: [] });
  });
});

describe('renderBalanceCfg', () => {
  it('writes a header and every adjustable knob, quoted, in knobs.json order', () => {
    expect(renderBalanceCfg(KNOBS, { z_tank_health: '7500', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' }, { number: 9, name: 'Tank\n7500' }))
      .toBe([
        '// Generated by riversidepug.com (Admin > Balance > Knobs). Do not edit: the site rewrites this file.',
        '// Values here override the deploy repo. Patch #9 Tank 7500.',
        'sm_cvar z_tank_health "7500"',
        'sm_cvar versus_boss_flow_min "0.10"',
        'sm_cvar versus_boss_flow_max "0.90"',
        '',
      ].join('\n'));
  });

  it('strips anything but plain text from the patch name in the header', () => {
    const v = { z_tank_health: '7500', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' };
    const lines = renderBalanceCfg(KNOBS, v, { number: 3, name: 'x; quit "y' }).split('\n');
    expect(lines[1]).toBe('// Values here override the deploy repo. Patch #3 x quit y.');
    const all = lines.join('\n');
    expect(all).not.toContain(';');
    expect(all.split('"').length - 1).toBe(6); // only the three sm_cvar value pairs
    expect(renderBalanceCfg(KNOBS, v, { number: 3, name: ' ;"\n ' }).split('\n')[1])
      .toBe('// Values here override the deploy repo. Patch #3 unnamed.');
  });
});

describe('previewKnobs', () => {
  it('diffs against current, predicts, and finds the existing patch on a no-op', () => {
    const r = sight(db, 1, s1, LIVE);
    const p = previewKnobs(db, KNOBS, {});
    expect(p.errors).toEqual([]);
    expect(p.diff).toEqual([]);
    expect(p.existingPatch?.id).toBe(r.patchId);
    const q = previewKnobs(db, KNOBS, { z_tank_health: 7500, versus_boss_flow_min: '0.15' });
    expect(q.diff.map((d) => `${d.cvar} ${d.from}->${d.to}`)).toEqual(['z_tank_health 8000->7500', 'versus_boss_flow_min 0.10->0.15']);
    expect(q.groupsChanged).toEqual(['tank', 'bosses']);
    expect(q.existingPatch).toBeNull();
    expect(q.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('has no fingerprint and no existing patch when a knob is missing from the base', () => {
    const { ['c:z_tank_health']: _gone, ...rest } = LIVE;
    sight(db, 1, s1, rest);
    const p = previewKnobs(db, KNOBS, {});
    expect(p.missing).toEqual(['z_tank_health']);
    expect(p.fingerprint).toBeNull();
    expect(p.existingPatch).toBeNull();
  });

  it('numbers the base and the existing patch in time order, not by id', () => {
    // Patch id 1 is first seen last (03:00), patch id 2 first (01:00): numbers #2 and #1.
    const later = sight(db, 1, s1, { ...LIVE, 'c:z_tank_health': '7500' }, 'queue', '2026-09-24 03:00:00');
    const earlier = sight(db, 2, s2, LIVE, 'queue', '2026-09-24 01:00:00');
    expect([later.patchId, earlier.patchId]).toEqual([1, 2]);
    const p = previewKnobs(db, KNOBS, {});
    expect(p.base).toEqual({ patchId: later.patchId, number: 2 });
    expect(p.existingPatch?.id).toBe(earlier.patchId);
    expect(p.existingPatch?.number).toBe(1);
  });

  it('has no fingerprint without a base', () => {
    const p = previewKnobs(db, KNOBS, {});
    expect(p.base).toBeNull();
    expect(p.fingerprint).toBeNull();
  });

  it('current values come from the latest rollout, else baselines', () => {
    expect(currentValues(db, KNOBS)).toEqual({ z_tank_health: '8000', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' });
    const r = sight(db, 1, s1, LIVE);
    db.prepare("INSERT INTO balance_rollouts (patch_id, values_json, content, created_by, created_at) VALUES (?, ?, 'x', 'a', 'now')")
      .run(r.patchId, JSON.stringify({ z_tank_health: '7500' }));
    expect(currentValues(db, KNOBS).z_tank_health).toBe('7500');
  });
});

describe('restoreValues', () => {
  it('takes adjustable c: values, keeps current for absent ones, notes ignored knobs', () => {
    const r = sight(db, 1, s1, { ...LIVE, 'c:z_tank_health': '7000' });
    const out = restoreValues(db, KNOBS, r.patchId);
    expect(out).toEqual({ ok: true, values: { z_tank_health: '7000', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' },
      notes: ['Knobs that are not adjustable (1) are left as they are.'] });
  });

  it('refuses a patch with no recorded inputs', () => {
    db.prepare("INSERT INTO balance_patches (id, source, first_seen_at) VALUES (50, 'historical', '2026-01-01 00:00:00')").run();
    expect(restoreValues(db, KNOBS, 50)).toEqual({ ok: false, error: 'This patch has no recorded values (historical patches cannot be restored).' });
  });
});
