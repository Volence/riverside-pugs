import { describe, expect, it } from 'vitest';
import { computeRound, ENGINE, METRICS } from '../../src/metrics/registry.js';
import type { MetricDef } from '../../src/metrics/types.js';
import { input } from './fixtures.js';

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
