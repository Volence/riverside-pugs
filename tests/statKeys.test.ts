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

  // Owner's call, 2026-09-18: getting skeeted is part of the match, not a
  // private embarrassment, so it belongs in the main stat list like everything
  // else. Being high_bad still keeps it off every leaderboard, which is what
  // the visibility flag was really protecting against.
  it('shows the negative stats to everyone, while keeping them off leaderboards', () => {
    expect(statDef('times_skeeted')!.visibility).toBe('public');
    expect(statDef('times_deadstopped')!.visibility).toBe('public');
    expect(statDef('times_skeeted')!.direction).toBe('high_bad');
  });

  it('publicStatKeys now carries them', () => {
    expect(publicStatKeys()).toContain('times_skeeted');
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

describe('stat direction', () => {
  it('declares a direction for every stat', () => {
    const missing = STAT_DEFS.filter((d) => d.direction === undefined).map((d) => d.key);
    expect(missing).toEqual([]);
  });

  it('only uses the three known directions', () => {
    const allowed = new Set(['high_good', 'high_bad', 'neutral']);
    const bad = STAT_DEFS.filter((d) => !allowed.has(d.direction)).map((d) => d.key);
    expect(bad).toEqual([]);
  });

  it('marks achievements good and punishments bad', () => {
    expect(statDef('skeets')?.direction).toBe('high_good');
    expect(statDef('clears')?.direction).toBe('high_good');
    expect(statDef('times_skeeted')?.direction).toBe('high_bad');
  });

  it('marks a denominator neutral rather than good', () => {
    // boomer_spawns counts how many boomers you drew. Drawing more is not an
    // achievement, it is the denominator of boomer success rate.
    expect(statDef('boomer_spawns')?.direction).toBe('neutral');
  });

  it('marks weapon-specific skeet breakdowns neutral', () => {
    // These are subsets of `skeets`, not independent achievements. Marking the
    // total and its parts would count one good play several times.
    expect(statDef('skeets_shotgun')?.direction).toBe('neutral');
    expect(statDef('skeets_sniper')?.direction).toBe('neutral');
    expect(statDef('skeets_melee')?.direction).toBe('neutral');
  });
});
