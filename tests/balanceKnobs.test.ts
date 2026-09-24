import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadBalanceKnobs, renderBalanceListInc, BALANCE_KNOBS_PATH } from '../src/balanceKnobs.js';
import { adjustableKnobs, formatKnobValue, normalizeKnobValue, stepDecimals, type AdjustableKnob } from '../src/balanceKnobs.js';

describe('balance knobs', () => {
  it('loads and validates the checked-in list', () => {
    const k = loadBalanceKnobs(BALANCE_KNOBS_PATH);
    expect(k.cvars.length).toBeGreaterThan(10);
    expect(k.cvars.every((c) => /^[a-z0-9_]{1,63}$/.test(c.cvar))).toBe(true);
    expect(new Set(k.cvars.map((c) => c.cvar)).size).toBe(k.cvars.length);
  });

  it('rejects a path with a space or a leading slash', () => {
    const bad = { cvars: [], files: [{ path: '/etc/passwd', label: 'x' }], dirs: [], versionless: [] };
    expect(() => loadBalanceKnobs(undefined, bad)).toThrow(/path/);
  });

  it('rejects a knobs file missing the versionless array', () => {
    const bad = { cvars: [], files: [], dirs: [] };
    expect(() => loadBalanceKnobs(undefined, bad)).toThrow(/versionless/);
  });

  it('the checked-in plugin include matches knobs.json', () => {
    const k = loadBalanceKnobs(BALANCE_KNOBS_PATH);
    const onDisk = readFileSync(new URL('../plugin/pug-balance-list.inc', import.meta.url), 'utf8');
    expect(onDisk).toBe(renderBalanceListInc(k));
  });
});

const base = { files: [], dirs: [], versionless: [] };
const knob = (over: Record<string, unknown> = {}) => ({
  cvar: 'z_tank_health', label: 'Tank', group: 'tank', type: 'int', min: 6000, max: 10000, step: 250, baseline: '8000', ...over,
});

describe('adjustable knobs', () => {
  it('the shipped knobs.json has the 16 v1 knobs with the live baselines', () => {
    const adj = adjustableKnobs(loadBalanceKnobs());
    expect(adj.map((k) => `${k.cvar}=${k.baseline}`)).toEqual([
      'z_tank_health=8000', 'z_tank_speed_vs=210', 'z_witch_damage_per_kill_hit=30', 'z_pounce_damage=2',
      'z_pounce_damage_interrupt=150', 'z_vomit_interval=20', 'tongue_hit_delay=13', 'tongue_break_from_damage_amount=300',
      'z_mob_spawn_min_size=28', 'z_mob_spawn_max_size=28', 'z_mob_spawn_min_interval_normal=30',
      'z_mob_spawn_max_interval_normal=30', 'l4d_antibaiter_delay=15', 'rotoblin_limit_smg=3',
      'versus_boss_flow_min=0.10', 'versus_boss_flow_max=0.90',
    ]);
  });

  it('a knob without type/range stays watch-only', () => {
    const k = loadBalanceKnobs(undefined, { ...base, cvars: [{ cvar: 'a', label: 'A', group: 'g' }] });
    expect(adjustableKnobs(k)).toEqual([]);
  });

  it('rejects a partial set of range fields', () => {
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ step: undefined })] })).toThrow(/go together/);
  });

  it('rejects a baseline outside the range or off the step grid', () => {
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ baseline: '11000' })] })).toThrow(/baseline/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ baseline: '8100' })] })).toThrow(/baseline/);
  });

  it('rejects a max off the grid, a zero step, min over max and a non-integer int range', () => {
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ max: 10100 })] })).toThrow(/max/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ step: 0 })] })).toThrow(/step/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ min: 11000 })] })).toThrow(/min/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ step: 0.5 })] })).toThrow(/whole/);
  });

  it('rejects a float baseline not written with the decimals of step', () => {
    const f = { cvar: 'versus_boss_flow_min', label: 'Flow', group: 'b', type: 'float', min: 0.1, max: 0.3, step: 0.05 };
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [{ ...f, baseline: '0.1' }] })).toThrow(/0\.10/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [{ ...f, baseline: '0.10' }] })).not.toThrow();
  });

  it('rejects a pair that is invalid at baseline or points at a watch-only cvar', () => {
    const lo = knob({ cvar: 'lo', min: 20, max: 34, step: 2, baseline: '30', pairMax: 'hi' });
    const hi = knob({ cvar: 'hi', min: 20, max: 34, step: 2, baseline: '28' });
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [lo, hi] })).toThrow(/pair/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [lo, { cvar: 'hi', label: 'H', group: 'g' }] })).toThrow(/pair/);
  });
});

describe('knob values', () => {
  const tank = knob() as AdjustableKnob;
  const flow = { cvar: 'f', label: 'Flow', group: 'b', type: 'float', min: 0.1, max: 0.3, step: 0.05, baseline: '0.10' } as AdjustableKnob;

  it('formats ints plainly and floats with the decimals of step', () => {
    expect(stepDecimals(0.05)).toBe(2);
    expect(stepDecimals(250)).toBe(0);
    expect(formatKnobValue(tank, 7500)).toBe('7500');
    expect(formatKnobValue(flow, 0.1)).toBe('0.10');
    expect(formatKnobValue(flow, 0.15000000000000002)).toBe('0.15');
  });

  it('normalises numbers and numeric strings to the exact string written', () => {
    expect(normalizeKnobValue(flow, '0.1')).toEqual({ ok: true, value: '0.10' });
    expect(normalizeKnobValue(flow, 0.25)).toEqual({ ok: true, value: '0.25' });
    expect(normalizeKnobValue(tank, '7500')).toEqual({ ok: true, value: '7500' });
  });

  it('refuses out of range, off grid, non-numeric and fractional int values', () => {
    expect(normalizeKnobValue(tank, 5750)).toMatchObject({ ok: false });
    expect(normalizeKnobValue(tank, 7600)).toMatchObject({ ok: false });
    expect(normalizeKnobValue(tank, '8000; quit')).toMatchObject({ ok: false });
    expect(normalizeKnobValue(tank, '7500.5')).toMatchObject({ ok: false });
    expect(normalizeKnobValue(flow, '0.12')).toMatchObject({ ok: false });
  });
});
