import { describe, it, expect } from 'vitest';
import { fitWarning, toUtcIso } from './bookingTime';

describe('booking time helpers', () => {
  it('reads a datetime-local value in the viewer zone', () => {
    const iso = toUtcIso('2026-10-02T20:00');
    expect(iso).toBe(new Date(2026, 9, 2, 20, 0).toISOString());
    expect(toUtcIso('')).toBeNull();
    expect(toUtcIso('nonsense')).toBeNull();
  });

  it('warns when the playlist will not fit', () => {
    expect(fitWarning(120, 110)).toBeNull();
    expect(fitWarning(60, 130)).toBe('These campaigns usually take about 130 minutes; the booking is 60. Extend later, or pick fewer.');
  });
});
