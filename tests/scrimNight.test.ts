import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { inNight, nightWindow } from '../src/scrims/night.js';

function thursdayNight(db: DB): void {
  setSetting(db, 'scrim_night_day', 'thursday');
  setSetting(db, 'scrim_night_start_utc', '21:00');
  setSetting(db, 'scrim_night_hours', '4');
}

describe('nightWindow', () => {
  it('is null while scrim_night_day is off', () => {
    const db = openDb(':memory:');
    expect(nightWindow(db, Date.parse('2026-10-01T12:00:00.000Z'))).toBeNull();
  });

  it('finds the coming Thursday 21:00-01:00 UTC window from a Wednesday', () => {
    const db = openDb(':memory:');
    thursdayNight(db);
    // 2026-09-30 is a Wednesday; 2026-10-01 is the following Thursday.
    const w = nightWindow(db, Date.parse('2026-09-30T12:00:00.000Z'));
    expect(w).toEqual({ startsAt: '2026-10-01T21:00:00.000Z', endsAt: '2026-10-02T01:00:00.000Z' });
  });

  it('returns the current window from inside it, just after midnight Friday UTC', () => {
    const db = openDb(':memory:');
    thursdayNight(db);
    const w = nightWindow(db, Date.parse('2026-10-02T00:30:00.000Z'));
    expect(w).toEqual({ startsAt: '2026-10-01T21:00:00.000Z', endsAt: '2026-10-02T01:00:00.000Z' });
  });

  it('moves on to next week once the window has ended', () => {
    const db = openDb(':memory:');
    thursdayNight(db);
    const w = nightWindow(db, Date.parse('2026-10-02T01:01:00.000Z'));
    expect(w).toEqual({ startsAt: '2026-10-08T21:00:00.000Z', endsAt: '2026-10-09T01:00:00.000Z' });
  });

  it('is null when the start time does not parse', () => {
    const db = openDb(':memory:');
    setSetting(db, 'scrim_night_day', 'thursday');
    setSetting(db, 'scrim_night_start_utc', 'nine pm');
    setSetting(db, 'scrim_night_hours', '4');
    expect(nightWindow(db, Date.parse('2026-10-01T12:00:00.000Z'))).toBeNull();
  });
});

describe('inNight', () => {
  it('is true for a start inside the window, including across the midnight wrap', () => {
    const db = openDb(':memory:');
    thursdayNight(db);
    expect(inNight(db, '2026-10-01T22:00:00.000Z')).toBe(true); // Thursday evening
    expect(inNight(db, '2026-10-02T00:30:00.000Z')).toBe(true); // just after midnight Friday
  });

  it('is false for a start outside the window, on either side', () => {
    const db = openDb(':memory:');
    thursdayNight(db);
    expect(inNight(db, '2026-10-01T20:59:00.000Z')).toBe(false); // just before it opens
    expect(inNight(db, '2026-10-02T01:00:00.000Z')).toBe(false); // right at the end (exclusive)
    expect(inNight(db, '2026-10-03T20:00:00.000Z')).toBe(false); // a different day entirely
  });

  it('is false while off', () => {
    const db = openDb(':memory:');
    expect(inNight(db, '2026-10-01T22:00:00.000Z')).toBe(false);
  });
});
