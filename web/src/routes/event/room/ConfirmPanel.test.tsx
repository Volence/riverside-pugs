import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MatchRoomView } from '../../../api';

vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { ConfirmPanel } = await import('./ConfirmPanel');
const { confirm } = await import('../../../components/Confirm');

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const view = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'confirming', higher: 'a', deadline: '2026-10-06T00:15:00.000Z', serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: '',
  pool: [], log: [], games: [], next: null, lineups: { a: null, b: null, aLocked: true, bLocked: true }, holdReason: null, result: null,
  me: { side: 'b', manager: true, playable: [], defaultFour: null },
  series: { bestOf: 3, totalScore: false, winsA: 2, winsB: 1, totalA: 0, totalB: 0, over: true, winner: 'a' }, server: null,
  confirm: { deadline: '2026-10-06T00:15:00.000Z', a: true, b: false }, dispute: null, frozen: false, schedule: null, ...over,
});
const NOW = Date.parse('2026-10-06T00:05:00.000Z');

describe('ConfirmPanel', () => {
  it('shows the result, who confirmed and the countdown, and lets a manager confirm or dispute with a reason', async () => {
    const onConfirm = vi.fn();
    const onDispute = vi.fn();
    render(<ConfirmPanel v={view({})} now={NOW} busy={false} onConfirm={onConfirm} onDispute={onDispute} />);
    expect(screen.getByText('Rats beat Bats 2 games to 1.')).toBeTruthy();
    expect(screen.getByText('Rats confirmed. Bats have not confirmed yet.')).toBeTruthy();
    expect(screen.getByText(/10:00 left/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm the result' }));
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.input(screen.getByRole('textbox', { name: 'Why you dispute the result' }), { target: { value: 'Rats had five on map 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dispute the result' }));
    await waitFor(() => expect(onDispute).toHaveBeenCalledWith('Rats had five on map 2'));
    expect(confirm).toHaveBeenCalled();
  });

  it('offers nothing to a player who is not a manager, and says a team already confirmed', () => {
    render(<ConfirmPanel v={view({ me: { side: 'a', manager: true, playable: [], defaultFour: null } })} now={NOW} busy={false} onConfirm={() => {}} onDispute={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Confirm the result' })).toBeNull();
    expect(screen.getByText('Your team has confirmed.')).toBeTruthy();
    cleanup();
    render(<ConfirmPanel v={view({ me: null })} now={NOW} busy={false} onConfirm={() => {}} onDispute={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
