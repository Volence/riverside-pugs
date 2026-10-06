import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { MatchRoomView } from '../../../api';
import { VetoBoard } from './VetoBoard';

afterEach(cleanup);
const base = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'veto', higher: 'a', deadline: null, serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: 'Bo1: ban down to 1.',
  pool: [
    { slug: 'no_mercy', name: 'No Mercy', state: 'open', by: null, game: null },
    { slug: 'dead_air', name: 'Dead Air', state: 'banned', by: 'b', game: null },
  ],
  log: [], games: [], next: { kind: 'ban', by: 'a', game: null, step: 2 }, lineups: { a: null, b: null, aLocked: false, bLocked: false },
  holdReason: null, result: null, me: { side: 'a', manager: true, playable: [], defaultFour: null },
  series: null, server: null, confirm: null, dispute: null, frozen: false, schedule: null, ...over,
});

describe('VetoBoard', () => {
  it('lets the manager whose turn it is ban an open campaign, sending the step it saw', () => {
    const act = vi.fn();
    render(<VetoBoard v={base({})} busy={false} onAct={act} />);
    expect(screen.getByText('Rats: ban a campaign')).toBeTruthy();
    expect(screen.getByText('Banned by Bats')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ban No Mercy' }));
    expect(act).toHaveBeenCalledWith(2, 'ban', 'no_mercy');
  });

  it('shows no buttons to the other team, a member, or a viewer', () => {
    for (const me of [{ side: 'b' as const, manager: true, playable: [], defaultFour: null }, { side: 'a' as const, manager: false, playable: [], defaultFour: null }, null]) {
      render(<VetoBoard v={base({ me })} busy={false} onAct={() => {}} />);
      expect(screen.queryByRole('button', { name: 'Ban No Mercy' })).toBeNull();
      cleanup();
    }
  });

  it('offers go first or second, and survivors or infected first', () => {
    const act = vi.fn();
    const { rerender } = render(<VetoBoard v={base({ next: { kind: 'order', by: 'a', game: null, step: 0 } })} busy={false} onAct={act} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go second' }));
    expect(act).toHaveBeenCalledWith(0, 'second', null);
    rerender(<VetoBoard v={base({ next: { kind: 'side', by: 'a', game: 1, step: 3 } })} busy={false} onAct={act} />);
    fireEvent.click(screen.getByRole('button', { name: 'Infected first' }));
    expect(act).toHaveBeenCalledWith(3, 'infected', null);
  });
});
