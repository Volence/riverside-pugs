import { describe, expect, it } from 'vitest';
import { previewTheme, seasonProgress } from './seasonTheme';

describe('seasonProgress', () => {
  const season = { startedAt: '2026-11-03 00:00:00', endsAt: '2026-12-28' };
  it('counts an 8-week season from Tue Nov 3 to Mon Dec 28 as 8 weeks', () => {
    expect(seasonProgress(season, new Date('2026-11-03T12:00:00Z'))).toEqual({ week: 1, weeks: 8, daysLeft: 56 });
    expect(seasonProgress(season, new Date('2026-11-17T12:00:00Z'))).toMatchObject({ week: 3, weeks: 8 });
    expect(seasonProgress(season, new Date('2026-12-28T12:00:00Z'))).toMatchObject({ week: 8, daysLeft: 1 });
  });
  it('has no countdown without an end date', () => {
    expect(seasonProgress({ startedAt: season.startedAt, endsAt: null }, new Date('2026-11-10T01:00:00Z'))).toEqual({ week: 2, weeks: null, daysLeft: null });
  });
});

describe('previewTheme', () => {
  it('keeps a URL preview, honours standard, and clears on off', () => {
    localStorage.clear();
    expect(previewTheme('?theme=wrong-way')).toBe('wrong-way');
    expect(previewTheme('')).toBe('wrong-way');
    expect(previewTheme('?theme=standard')).toBe('standard');
    expect(previewTheme('?theme=off')).toBeNull();
    expect(previewTheme('')).toBeNull();
    expect(previewTheme('?theme=nonsense')).toBeNull();
  });
});
