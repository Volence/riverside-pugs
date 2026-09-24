import { describe, it, expect, afterEach } from 'vitest';
import { PROBES, probe, _setProbe, type ProbeId } from './probes';

describe('the probe gates', () => {
  afterEach(() => { for (const id of Object.keys(PROBES) as ProbeId[]) _setProbe(id, null); });
  it('lists every open question, each passed or open as spec section 4 records it, each naming its batch', () => {
    // Q5 failed (the game ignores the cross colour) and was retired, not kept as a closed gate (slice 2.F G4).
    const expected: Record<string, boolean> = { Q1: false, Q2: false, Q3: false, Q8: true };
    expect(Object.keys(PROBES).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, p] of Object.entries(PROBES)) {
      expect(p.passed, id).toBe(expected[id]);
      expect(p.batch, id).toMatch(/^B\d+ \(/);
      expect(p.question.length, id).toBeGreaterThan(10);
    }
  });
  it('can be forced in a test and put back', () => {
    expect(probe('Q1')).toBe(false);
    _setProbe('Q1', true);
    expect(probe('Q1')).toBe(true);
    _setProbe('Q1', null);
    expect(probe('Q1')).toBe(false);
  });
});
