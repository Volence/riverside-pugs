import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { MatchRoomView } from '../../../api';
import { LineupPanel } from './LineupPanel';

vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
afterEach(cleanup);
const players = ['p1', 'p2', 'p3', 'p4', 'p5'].map((n) => ({ steamid: n, name: n.toUpperCase() }));
const v = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'lineup', higher: 'a', deadline: null, serverNow: '', ready: { a: true, b: true }, vetoSummary: '', pool: [], log: [], games: [], next: null,
  lineups: { a: null, b: null, aLocked: false, bLocked: true }, holdReason: null, result: null,
  me: { side: 'a', manager: true, playable: players, defaultFour: ['p2', 'p3', 'p4', 'p5'] }, ...over,
});

describe('LineupPanel', () => {
  it('preselects the default four and locks exactly four', async () => {
    const lock = vi.fn(async () => {});
    render(<LineupPanel v={v({})} busy={false} onLock={lock} />);
    const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
    expect(box('P1').checked).toBe(false);
    expect(box('P5').checked).toBe(true);
    fireEvent.click(box('P5'));
    expect((screen.getByRole('button', { name: 'Lock lineup' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box('P1'));
    fireEvent.click(screen.getByRole('button', { name: 'Lock lineup' }));
    await vi.waitFor(() => expect(lock).toHaveBeenCalledWith(['p1', 'p2', 'p3', 'p4']));
  });

  it('shows the other team as locked but not who, and both fours once revealed', () => {
    render(<LineupPanel v={v({ me: null })} busy={false} onLock={async () => {}} />);
    expect(screen.getByText('Bats: locked')).toBeTruthy();
    expect(screen.getByText('Rats: picking')).toBeTruthy();
    cleanup();
    render(<LineupPanel v={v({ me: null, phase: 'server', lineups: { a: players.slice(0, 4), b: players.slice(1), aLocked: true, bLocked: true } })} busy={false} onLock={async () => {}} />);
    expect(screen.getAllByText('P2')).toHaveLength(2);
  });
});
