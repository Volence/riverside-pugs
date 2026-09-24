import { describe, it, expect, afterEach } from 'vitest';
import { PROBES, probe, _setProbe, type ProbeId } from './probes';

describe('the probe gates', () => {
  afterEach(() => { for (const id of Object.keys(PROBES) as ProbeId[]) _setProbe(id, null); });
  it('lists every gate this phase uses, none passed yet, each naming its batch', () => {
    expect(Object.keys(PROBES).sort()).toEqual(['Q1', 'Q2', 'Q3', 'Q5', 'Q8']);
    for (const [id, p] of Object.entries(PROBES)) {
      expect(p.passed, id).toBe(false);
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
