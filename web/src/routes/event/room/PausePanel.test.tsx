import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { MatchRoomView, RoomPause } from '../../../api';
import { PausePanel } from './PausePanel';

afterEach(() => cleanup());
const pause = (over: Partial<RoomPause> = {}): RoomPause => ({
  id: 1, game: 1, tiebreak: false, side: 'a', cause: 'call', reason: 'router restarted', startedAt: '2026-10-10T21:00:00.000Z', endedAt: '2026-10-10T21:02:00.000Z',
  usedS: 120, budgetS: 300, overrun: false, flagged: false, flagNote: null, penalty: null, ...over,
});
const v = (pauses: RoomPause[]) => ({ a: { name: 'Rats' }, b: { name: 'Bats' }, pauses }) as unknown as MatchRoomView;

describe('PausePanel', () => {
  it('renders nothing without pauses', () => {
    const { container } = render(<PausePanel v={v([])} />);
    expect(container.textContent).toBe('');
  });

  it('lists each pause with its team, kind, time, reason when known, flag and ruling', () => {
    render(<PausePanel v={v([
      pause(),
      pause({ id: 2, side: 'b', cause: 'disconnect', reason: null, usedS: 75, budgetS: 600, endedAt: null }),
      pause({ id: 3, game: 2, reason: null, overrun: true, flagged: true, penalty: 'forfeit', usedS: 300 }),
    ])} />);
    expect(screen.getByText(/Game 1 · Rats · technical · 2:00 of 5:00/)).toBeTruthy();
    expect(screen.getByText(/router restarted/, { selector: 'q' })).toBeTruthy();
    expect(screen.getByText(/Game 1 · Bats · disconnect · 1:15 of 10:00 · still paused/)).toBeTruthy();
    expect(screen.getByText(/Game 2 · Rats · technical · 5:00 of 5:00 · ran into tactical pauses · flagged by the other team · staff ruled the game forfeited/)).toBeTruthy();
  });
});
