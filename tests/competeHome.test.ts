import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { tournamentOpen } from '../src/events/events.js';
import { eventFixture, NOW } from './eventFixture.js';

// eventFixture's event starts 2026-10-10T20:00Z, nine days after NOW.
const DAYS_BEFORE_START = (d: number) => new Date(Date.parse('2026-10-10T20:00:00.000Z') - d * 86_400_000);

describe('tournamentOpen', () => {
  it('is false with no events at all', () => {
    expect(tournamentOpen(openDb(':memory:'), NOW)).toBe(false);
  });

  it('never counts a draft, which only staff can see', () => {
    const { db } = eventFixture('draft');
    expect(tournamentOpen(db, DAYS_BEFORE_START(1))).toBe(false);
  });

  it('counts an announced event only within three days of its start', () => {
    const { db } = eventFixture('announced');
    expect(tournamentOpen(db, NOW)).toBe(false);
    expect(tournamentOpen(db, DAYS_BEFORE_START(3.5))).toBe(false);
    expect(tournamentOpen(db, DAYS_BEFORE_START(2.9))).toBe(true);
  });

  it('counts registration, check-in and a live event however far the start is', () => {
    const { db, eventId } = eventFixture('registration');
    expect(tournamentOpen(db, NOW)).toBe(true);
    for (const status of ['checkin', 'live']) {
      db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, eventId);
      expect(tournamentOpen(db, NOW)).toBe(true);
    }
  });

  it('never counts a finished or cancelled event', () => {
    const { db, eventId } = eventFixture('registration');
    for (const status of ['finished', 'cancelled']) {
      db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, eventId);
      expect(tournamentOpen(db, DAYS_BEFORE_START(1))).toBe(false);
    }
  });
});
