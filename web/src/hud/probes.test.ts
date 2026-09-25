import { describe, it, expect, afterEach } from 'vitest';
import { PROBES, probe, _setProbe, type ProbeId } from './probes';

describe('the probe gates', () => {
  afterEach(() => { for (const id of Object.keys(PROBES) as ProbeId[]) _setProbe(id, null); });
  it('lists every open question, each passed or open as spec section 4 records it, each naming its batch', () => {
    // Q5 failed (the game ignores the cross colour) and was retired, not kept as a closed gate (slice 2.F G4).
    // TS2 failed (code colours the versus scores) and was retired the same way (tab screen spec section 7).
    const expected: Record<string, boolean> = { Q1: true, Q2: true, Q3: true, Q8: true, Q24: true, K5: true, C2: false, Z3: true, T1: true, P2: false,
      TS1: true, TS3: true, TS4: true, TS5: true, TS5b: false, TS6: true, TS7: true, TS8: true };
    expect(Object.keys(PROBES).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, p] of Object.entries(PROBES)) {
      expect(p.passed, id).toBe(expected[id]);
      expect(p.batch, id).toMatch(/^([BRV]\d+[a-z]?|TAB-\d) \(/);
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
  it('answers the Tab screen gates as TAB-1 to TAB-3 did (tab screen spec section 7)', () => {
    // /home/volence/l4d/hud/probe-tab/RESULTS.md. TS2 failed and is not a gate; TS5 and TS6 were split.
    expect(Object.keys(PROBES).filter((id) => id.startsWith('TS')).sort()).toEqual(['TS1', 'TS3', 'TS4', 'TS5', 'TS5b', 'TS6', 'TS7', 'TS8']);
    expect(PROBES.TS5b.passed).toBe(false);
    expect(PROBES.TS5.question).toMatch(/PlayerBackground_Selected/);
    expect(PROBES.TS5b.question).toMatch(/PlayerBackground\b(?!_)/);
    // The survivor names stayed white whatever the file said: TS6 is the infected file's names only.
    expect(PROBES.TS6.question).toMatch(/scoreboardinfectedplayer\.res/);
    expect(PROBES.TS6.question).not.toMatch(/SurvivorStats/);
    for (const id of ['TS1', 'TS3', 'TS4', 'TS7', 'TS8'] as const) expect(PROBES[id].batch, id).toMatch(/^TAB-[123] \(/);
  });
});
