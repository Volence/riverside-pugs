import { describe, it, expect } from 'vitest';
import { fitWarning, nightRangeLabel, toUtcIso } from './bookingTime';

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

  it('labels the scrim night window with its weekday and local start-end', () => {
    const start = new Date(2026, 9, 1, 17, 0);
    const end = new Date(2026, 9, 1, 21, 0);
    const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(nightRangeLabel(start.toISOString(), end.toISOString()))
      .toBe(`${start.toLocaleDateString(undefined, { weekday: 'long' })} ${time(start)}-${time(end)}`);
  });
});
