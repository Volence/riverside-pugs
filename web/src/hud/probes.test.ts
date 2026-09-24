import { describe, it, expect, afterEach } from 'vitest';
import { PROBES, probe, _setProbe, type ProbeId } from './probes';

describe('the probe gates', () => {
  afterEach(() => { for (const id of Object.keys(PROBES) as ProbeId[]) _setProbe(id, null); });
  it('lists every open question, each passed or open as spec section 4 records it, each naming its batch', () => {
    // Q5 failed (the game ignores the cross colour) and was retired, not kept as a closed gate (slice 2.F G4).
    const expected: Record<string, boolean> = { Q1: true, Q2: true, Q3: true, Q8: true, Q24: true };
    expect(Object.keys(PROBES).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, p] of Object.entries(PROBES)) {
      expect(p.passed, id).toBe(expected[id]);
      expect(p.batch, id).toMatch(/^B\d+ \(/);
      expect(p.question.length, id).toBeGreaterThan(10);
    }
  });
  it('can be forced in a test and put back', () => {
    expect(probe('Q2')).toBe(true);
    _setProbe('Q2', false);
    expect(probe('Q2')).toBe(false);
    _setProbe('Q2', null);
    expect(probe('Q2')).toBe(true);
  });
  it('words Q1 as the whole-panel colour the probe proved', () => {
    expect(PROBES.Q1.question).toBe('monochrome_color on a HealthPanel recolours the whole panel (fill, outline, number, cross, scratches) in every state');
  });
  it('passes Q24 as B14 answered it: the bar alone takes the colour on the infected panels', () => {
    // /home/volence/l4d/hud/probe-phase2-infected/RESULTS.md, B14: b14/crops/si-b-zoom.png, card-b.png.
    expect(PROBES.Q24.passed).toBe(true);
    expect(PROBES.Q24.batch).toMatch(/^B14 \(/);
    expect(PROBES.Q24.question).toBe('monochrome_color on the SI Health and the card HealthPanel recolours the bar (fill and outline) only, not the number, name or icon');
  });
});
