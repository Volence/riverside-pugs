import { describe, it, expect } from 'vitest';
import { STAT_DEFS, statDef, isKnownStat, publicStatKeys, skillDetectStatKeys } from '../src/statKeys.js';

describe('stat registry', () => {
  it('has unique keys', () => {
    const keys = STAT_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('looks up a definition', () => {
    expect(statDef('skeets')).toMatchObject({ side: 'survivor', visibility: 'public', needsSkillDetect: true });
    expect(statDef('tank_damage')).toMatchObject({ side: 'survivor', visibility: 'public', needsSkillDetect: false });
    expect(statDef('nope')).toBeUndefined();
  });

  it('marks the two negative stats self-only', () => {
    expect(statDef('times_skeeted')!.visibility).toBe('self');
    expect(statDef('times_deadstopped')!.visibility).toBe('self');
  });

  it('publicStatKeys excludes self-only stats', () => {
    expect(publicStatKeys()).not.toContain('times_skeeted');
    expect(publicStatKeys()).toContain('skeets');
  });

  it('skillDetectStatKeys excludes the three natively captured stats', () => {
    const k = skillDetectStatKeys();
    expect(k).not.toContain('tank_damage');
    expect(k).not.toContain('damage_as_si');
    expect(k).not.toContain('tank_punches');
    expect(k).toContain('deadstops');
  });

  it('every key is snake_case and short enough for the wire format', () => {
    // The plugin stores keys in g_sStatKey[PS_MAX][24] (plugin/pug-stats.inc),
    // which holds 23 characters plus a NUL. {0,22} (24 total with the leading
    // char) matches that budget exactly; {0,23} would pass a 24-char key that
    // does not fit.
    for (const d of STAT_DEFS) {
      expect(d.key).toMatch(/^[a-z][a-z0-9_]{0,22}$/);
      expect(d.label.length).toBeGreaterThan(0);
    }
  });

  it('isKnownStat gates unknown keys', () => {
    expect(isKnownStat('skeets')).toBe(true);
    expect(isKnownStat('__proto__')).toBe(false);
  });
});
