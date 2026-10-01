import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { RecordLine, recordText, reliableBadge } from './ScrimRecord';

const r = (shown: number, booked: number, noShows = 0, lateCancels = 0) => ({ shown, booked, noShows, lateCancels, excused: 0 });

afterEach(cleanup);

describe('the record line', () => {
  it('reads "New" under 3 booked, whatever the marks', () => {
    expect(recordText(r(0, 0))).toBe('New');
    expect(recordText(r(0, 2, 2))).toBe('New');
    expect(reliableBadge(r(2, 2))).toBe('New');
  });

  it('shows the marks only when they are not zero', () => {
    expect(recordText(r(3, 3))).toBe('Shown 3 of 3');
    expect(recordText(r(3, 5, 1, 1))).toBe('Shown 3 of 5 · No-shows 1 · Late cancels 1');
    expect(recordText(r(4, 5, 0, 1))).toBe('Shown 4 of 5 · Late cancels 1');
    expect(reliableBadge(r(4, 5, 0, 1))).toBe('Reliable: 4 of 5 shown');
  });

  it('renders with its label', () => {
    render(<RecordLine record={r(1, 1)} label="Record" />);
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Record:', { exact: false })).toBeTruthy();
  });
});
