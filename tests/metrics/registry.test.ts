import { describe, expect, it } from 'vitest';
import { computeRound, ENGINE, METRICS, PUBLIC_METRICS } from '../../src/metrics/registry.js';
import type { MetricDef } from '../../src/metrics/types.js';
import { input } from './fixtures.js';

const ALLOWLIST: Record<string, string> = {
  'round.saferoom': 'Rounds where survivors reached the saferoom',
  'round.score': 'Survivor distance score',
  'round.length_min': 'Round length',
  'tank.killed_rate': 'Tanks killed by survivors',
  'tank.lifetime_killed_s': 'How long a killed tank lasted',
  'tank.damage_per_tank': 'Damage dealt per tank',
  'tank.incaps_caused': 'Survivor incaps per tank',
  'witch.crown_rate': 'Witches crowned',
  'witch.startle_rate': 'Witches startled',
  'hunter.skeet_rate': 'Hunters skeeted',
  'hunter.damage_per_spawn': 'Hunter damage per spawn',
  'smoker.pull_rate': 'Smoker pulls per spawn',
  'boomer.boomed_per_spawn': 'Survivors boomed per boomer',
  'boomer.pop_rate': 'Boomers popped before vomiting',
  'pace.si_damage_per_min': 'Special infected damage per minute',
  'si.pins_per_min': 'Pins per minute',
  'weapons.hold.pumpshotgun': 'Time holding the pump shotgun',
  'weapons.hold.smg': 'Time holding the Uzi',
};

describe('metric registry', () => {
  it('has unique ids and an engine string that names every metric version', () => {
    const ids = METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of METRICS) expect(ENGINE).toContain(`${m.id}:${m.version}`);
    expect(METRICS.every((m) => /^[a-z]+\.[a-z0-9_.]+$/.test(m.id))).toBe(true);
    expect(METRICS.every((m) => m.description.length > 10 && !m.description.includes('\u2014'))).toBe(true);
  });

  it('computes rows for a bare round without throwing, and never a non-finite value', () => {
    const rows = computeRound(input());
    expect(rows.every((r) => Number.isFinite(r.num) && Number.isFinite(r.den) && r.den > 0)).toBe(true);
  });

  it('drops a metric that throws instead of failing the round', () => {
    const throwing: MetricDef = { id: 'test.throws', group: 'pace', version: 1, description: 'Always throws, for this test.',
      compute: () => { throw new Error('boom'); } };
    const i = input();
    const expected = computeRound(i);
    expect(expected.length).toBeGreaterThan(0);
    METRICS.unshift(throwing);
    const origError = console.error;
    let errors = 0;
    console.error = (() => { errors++; }) as typeof console.error;
    try {
      const rows = computeRound(i);
      expect(rows.some((r) => r.metric === 'test.throws')).toBe(false);
      expect(rows).toEqual(expected);
      expect(errors).toBe(1);
    } finally {
      console.error = origError;
      METRICS.splice(METRICS.indexOf(throwing), 1);
    }
    expect(METRICS.some((m) => m.id === 'test.throws')).toBe(false);
  });
});

describe('public allowlist', () => {
  it('every allowlisted id exists in the registry', () => {
    const ids = new Set(METRICS.map((m) => m.id));
    for (const id of Object.keys(ALLOWLIST)) expect(ids.has(id), id).toBe(true);
  });
  it('is exactly the approved list, with the approved non-empty labels', () => {
    expect(Object.fromEntries(PUBLIC_METRICS.map((m) => [m.id, m.public!.label]))).toEqual(ALLOWLIST);
    expect(PUBLIC_METRICS.every((m) => m.public!.label.trim().length > 0 && !m.public!.label.includes('\u2014'))).toBe(true);
  });
});
