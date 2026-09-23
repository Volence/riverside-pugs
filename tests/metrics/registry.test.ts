import { describe, expect, it } from 'vitest';
import { computeRound, ENGINE, METRICS } from '../../src/metrics/registry.js';
import { input } from './fixtures.js';

describe('metric registry', () => {
  it('has unique ids and an engine string that names every metric version', () => {
    const ids = METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of METRICS) expect(ENGINE).toContain(`${m.id}:${m.version}`);
    expect(METRICS.every((m) => /^[a-z]+\.[a-z0-9_.]+$/.test(m.id))).toBe(true);
    expect(METRICS.every((m) => m.description.length > 10 && !m.description.includes('—'))).toBe(true);
  });

  it('computes rows for a bare round without throwing, and never a non-finite value', () => {
    const rows = computeRound(input());
    expect(rows.every((r) => Number.isFinite(r.num) && Number.isFinite(r.den) && r.den > 0)).toBe(true);
  });

  it('drops a metric that throws instead of failing the round', () => {
    const rows = computeRound(input({ events: [{ kind: 'si_spawn', actor: 'i1', target: null, value: 3, tMs: -1 }] }));
    expect(Array.isArray(rows)).toBe(true);
  });
});
