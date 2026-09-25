import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { loadCatalogue, watchKnobs, type Catalogue } from '../src/balanceCatalogue.js';
import { gameValues } from '../src/balanceValues.js';
import { renderWatchFile } from '../src/balanceWatch.js';
import { KNOBS, sight } from './balanceFixtures.js';

const CAT: Catalogue = {
  groups: [{ id: 'tank', label: 'Tank' }, { id: 'hunter', label: 'Hunter' }, { id: 'weapons', label: 'Weapon stats' }],
  values: [
    { id: 'z_tank_health', group: 'tank', label: 'Tank health', source: 'cvar', unit: 'HP', vanilla: '4000' },
    { id: 'z_new_thing', group: 'tank', label: 'New thing', source: 'cvar' },
    { id: 'tongue_drag_damage_amount', group: 'hunter', label: 'Drag', source: 'cvar', note: 'plugin', hideLive: true },
    { id: 'weapon_smg.Damage', group: 'weapons', label: 'Uzi damage', source: 'weapon', vanilla: '20' },
    { id: 'weapon_smg.SpreadPerShot', group: 'weapons', label: 'Uzi spread', source: 'weapon', vanilla: '0.32' },
  ],
  rules: [
    { id: 'sky', group: 'hunter', text: 'Sky pounce fix.', when: { plugin: 'l4d_skypounce.smx' }, reviewed: true },
    { id: 'draft', group: 'hunter', text: 'Draft rule.', when: { plugin: 'l4d_skypounce.smx' }, reviewed: false },
    { id: 'off', group: 'tank', text: 'Not loaded.', when: { plugin: 'nope.smx' }, reviewed: true },
    { id: 'cv', group: 'tank', text: 'Tank has {z_tank_health} HP.', when: { cvar: 'z_tank_health', equals: '8000' }, reviewed: true },
    { id: 'ne', group: 'tank', text: 'Not 7000.', when: { cvar: 'z_tank_health', notEquals: '7000' }, reviewed: true },
    { id: 'miss', group: 'tank', text: 'Needs {z_new_thing}.', when: { plugin: 'l4d_skypounce.smx' }, reviewed: true },
  ],
};

describe('loadCatalogue', () => {
  it('loads the real catalogue', () => {
    const c = loadCatalogue();
    expect(c.values.length).toBeGreaterThan(100);
    expect(c.rules.every((r) => r.reviewed === false)).toBe(true);
  });
  it('refuses bad entries', () => {
    const bad = (patch: Partial<Catalogue>) => () => loadCatalogue('', { ...CAT, ...patch });
    expect(bad({ values: [...CAT.values, CAT.values[0]] })).toThrow(/duplicate/);
    expect(bad({ values: [{ id: 'x', group: 'nope', label: 'X', source: 'cvar' }] })).toThrow(/unknown group/);
    expect(bad({ values: [{ id: 'weapon_smg', group: 'weapons', label: 'X', source: 'weapon' }] })).toThrow(/bad weapon/);
    expect(bad({ rules: [{ id: 'r', group: 'tank', text: 't', when: { cvar: 'x' } as never, reviewed: true }] })).toThrow(/when/);
    expect(bad({ rules: [{ id: 'r', group: 'tank', text: 'uses {nope}', when: { plugin: 'a.smx' }, reviewed: true }] })).toThrow(/not a catalogue value/);
  });
});

describe('watchKnobs', () => {
  it('adds catalogue cvars (deduplicated) and weapon keys to the watch file', () => {
    const text = renderWatchFile(watchKnobs(KNOBS, CAT));
    const cvars = text.split('\n').filter((l) => l.startsWith('cvar '));
    expect(cvars.filter((l) => l === 'cvar z_tank_health')).toHaveLength(1);
    expect(cvars).toContain('cvar z_new_thing');
    expect(text).toContain('weapon weapon_smg Damage\n');
  });
});

describe('gameValues', () => {
  let db: ReturnType<typeof openDb>;
  let s1: number;
  const INV = (tank: string, extra: Record<string, string> = {}) => ({
    'c:z_tank_health': tank, 'c:tongue_drag_damage_amount': '0', 'p:optional/l4d_skypounce.smx': '1.a',
    'w:weapon_smg.Damage': 'default', 'w:weapon_smg.SpreadPerShot': '0.22', ...extra,
  });
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const a = sight(db, 1, s1, INV('7000'), 'queue', '2026-09-20 00:00:00');
    db.prepare("UPDATE balance_patches SET triage = 'balance', name = 'Base', published_at = '2026-09-20' WHERE id = ?").run(a.patchId);
    const b = sight(db, 2, s1, INV('8000'), 'queue', '2026-09-22 00:00:00');
    db.prepare("UPDATE balance_patches SET triage = 'balance', name = 'Tank 8000' WHERE id = ?").run(b.patchId);
  });

  it('reports current values, vanilla, hidden, not reported, and weapon defaults', () => {
    const g = gameValues(db, CAT, { admin: false });
    const tank = g.groups.find((x) => x.id === 'tank')!;
    expect(tank.values[0]).toMatchObject({ id: 'z_tank_health', value: '8000', vanilla: '4000', differsFromVanilla: true, status: 'reported' });
    expect(tank.values[1]).toMatchObject({ id: 'z_new_thing', value: null, status: 'not_reported' });
    const hunter = g.groups.find((x) => x.id === 'hunter')!;
    expect(hunter.values[0]).toMatchObject({ status: 'hidden', value: null, note: 'plugin' });
    const w = g.groups.find((x) => x.id === 'weapons')!;
    expect(w.values[0]).toMatchObject({ value: '20', differsFromVanilla: false });
    expect(w.values[1]).toMatchObject({ value: '0.22', differsFromVanilla: true });
  });

  it('dates the last change and names it only when published (public)', () => {
    const pub = gameValues(db, CAT, { admin: false }).groups[0].values[0];
    expect(pub.lastChange).toEqual({ at: '2026-09-22 00:00:00', patch: null });
    const adm = gameValues(db, CAT, { admin: true }).groups[0].values[0];
    expect(adm.lastChange).toMatchObject({ patch: { name: 'Tank 8000' } });
    db.prepare("UPDATE balance_patches SET published_at = 'x' WHERE name = 'Tank 8000'").run();
    expect(gameValues(db, CAT, { admin: false }).groups[0].values[0].lastChange!.patch).toMatchObject({ name: 'Tank 8000', number: 2 });
    expect(gameValues(db, CAT, { admin: false }).groups[2].values[1].lastChange).toBeNull();
  });

  it('dates a revert at the return: A, B, then A again reports the change back to A', () => {
    sight(db, 3, s1, INV('7000'), 'queue', '2026-09-23 00:00:00');
    const v = gameValues(db, CAT, { admin: true }).groups[0].values[0];
    expect(v.value).toBe('7000');
    expect(v.lastChange).toMatchObject({ at: '2026-09-23 00:00:00', patch: { name: 'Base' } });
  });

  it('keeps the settled balance value while a newer config waits for triage', () => {
    sight(db, 3, s1, INV('9000'), 'queue', '2026-09-23 00:00:00'); // a new patch, pending
    const g = gameValues(db, CAT, { admin: false });
    expect(g.groups[0].values[0]).toMatchObject({ value: '8000', lastChange: { at: '2026-09-22 00:00:00' } });
    expect(g.reviewing).toBe(true);
    expect(gameValues(db, CAT, { admin: false }).groups[0].rules.map((r) => r.text)).toContain('Tank has 8000 HP.');
    // Triaged as balance, it becomes the value.
    db.prepare("UPDATE balance_patches SET triage = 'balance' WHERE triage = 'pending'").run();
    const after = gameValues(db, CAT, { admin: false });
    expect(after.groups[0].values[0].value).toBe('9000');
    expect(after.reviewing).toBe(false);
  });

  it('with nothing settled yet, shows the newest reported config and says it is under review', () => {
    // Production before the first triage: every patch with reported values is pending.
    db.prepare("UPDATE balance_patches SET triage = 'pending'").run();
    const g = gameValues(db, CAT, { admin: false });
    expect(g.reviewing).toBe(true);
    expect(g.unsettled).toBe(true);
    expect(g.groups[0].values[0]).toMatchObject({ value: '8000', status: 'reported', lastChange: null });
  });

  it('reads a folded patch: its own reported values, credited to the patch it counts for', () => {
    // Watching one more value folds the new patch into Tank 8000 on sight.
    const r = sight(db, 3, s1, INV('8000', { 'c:z_new_thing': '5' }), 'queue', '2026-09-23 00:00:00');
    expect(r.patchId).not.toBe(r.effectivePatchId);
    const g = gameValues(db, CAT, { admin: true });
    expect(g.groups[0].values[1]).toMatchObject({ id: 'z_new_thing', value: '5', status: 'reported', lastChange: null });
    expect(g.groups[0].values[0].lastChange).toMatchObject({ at: '2026-09-22 00:00:00', patch: { name: 'Tank 8000' } });
    expect(g.reviewing).toBe(false);
  });

  it('never reports the admin-only patch pointer publicly', () => {
    expect(gameValues(db, CAT, { admin: false })).not.toHaveProperty('asOf');
    expect(gameValues(db, CAT, { admin: true }).asOf).toMatchObject({ number: 2 });
  });

  it('shows reviewed active rules publicly; every rule, tagged, for admins', () => {
    const pub = gameValues(db, CAT, { admin: false });
    expect(pub.groups.find((x) => x.id === 'hunter')!.rules.map((r) => r.id)).toEqual(['sky']);
    const tankRules = pub.groups.find((x) => x.id === 'tank')!.rules;
    expect(tankRules.map((r) => r.id)).toEqual(['cv', 'ne']); // 'miss' waits for its value
    expect(tankRules[0].text).toBe('Tank has 8000 HP.');
    const adm = gameValues(db, CAT, { admin: true });
    expect(adm.groups.find((x) => x.id === 'hunter')!.rules).toEqual([
      { id: 'sky', text: 'Sky pounce fix.', active: true, draft: false, missing: [] },
      { id: 'draft', text: 'Draft rule.', active: true, draft: true, missing: [] },
    ]);
    expect(adm.groups.find((x) => x.id === 'tank')!.rules.find((r) => r.id === 'off')).toMatchObject({ active: false });
    expect(adm.groups.find((x) => x.id === 'tank')!.rules.find((r) => r.id === 'miss')).toMatchObject({ text: 'Needs ?.', missing: ['z_new_thing'] });
  });
});

describe('values routes', () => {
  it('public and admin shapes', async () => {
    const { buildServer } = await import('../src/server.js');
    const { loadConfig } = await import('../src/config.js');
    const { authedCookie, stubOrchestrator } = await import('./helpers.js');
    const db = openDb(':memory:');
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const pub = await a.inject({ method: 'GET', url: '/api/balance/values' });
    expect(pub.statusCode).toBe(200);
    const body = pub.json() as { groups: { id: string; rules: unknown[] }[] };
    expect(body).not.toHaveProperty('asOf');
    expect(body.groups.find((g) => g.id === 'tank')).toBeTruthy();
    expect(body.groups.every((g) => g.rules.length === 0)).toBe(true); // every rule is a draft
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/values' })).statusCode).toBe(401);
    const cookies = await authedCookie(a, db, '76561198000000009');
    db.prepare("UPDATE players SET is_admin = 1 WHERE steamid = '76561198000000009'").run();
    const adm = (await a.inject({ method: 'GET', url: '/api/admin/balance/values', cookies })).json() as { groups: { rules: { draft: boolean }[] }[] };
    expect(adm.groups.flatMap((g) => g.rules).length).toBeGreaterThan(20);
  });
});
