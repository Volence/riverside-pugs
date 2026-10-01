import { describe, it, expect } from 'vitest';
import { STATUS_LABEL, fromLocalInput, toLocalInput, untilText } from './eventFormat';

const now = Date.parse('2026-10-01T12:00:00.000Z');
const at = (mins: number) => new Date(now + mins * 60_000).toISOString();

describe('untilText', () => {
  it('counts down in minutes, hours, then days', () => {
    expect(untilText(at(42), now)).toBe('in 42 min');
    expect(untilText(at(5 * 60 + 10), now)).toBe('in 5 h 10 min');
    expect(untilText(at(30 * 60), now)).toBe('in 30 h 0 min');
    expect(untilText(at(51 * 60), now)).toBe('in 2 days 3 h');
  });

  it('rounds a part minute up, and says starting now at or after the start', () => {
    expect(untilText(new Date(now + 20_000).toISOString(), now)).toBe('in 1 min');
    expect(untilText(at(0), now)).toBe('starting now');
    expect(untilText(at(-5), now)).toBe('starting now');
    expect(untilText('nonsense', now)).toBe('starting now');
  });
});

describe('datetime-local conversion', () => {
  it('reads back the same instant in whatever zone the viewer is in', () => {
    for (const iso of ['2026-10-10T20:00:00.000Z', '2026-03-08T18:30:00.000Z', '2026-11-01T18:15:00.000Z', '2026-12-31T23:59:00.000Z']) {
      expect(toLocalInput(iso)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    }
  });

  it('refuses anything that is not a datetime-local value', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('2026-10-10')).toBeNull();
    expect(fromLocalInput('tomorrow')).toBeNull();
    expect(toLocalInput('nonsense')).toBe('');
  });

  it('names every status', () => {
    expect(STATUS_LABEL.registration).toBe('Registration open');
    expect(Object.keys(STATUS_LABEL)).toHaveLength(7);
  });
});
