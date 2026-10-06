import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MatchRoomView } from '../api';

const { mockEvents } = vi.hoisted(() => ({
  mockEvents: { room: vi.fn(), ready: vi.fn(), veto: vi.fn(), lineup: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
vi.mock('../hooks/useHubEvent', () => ({ useHubEvent: () => {} }));
const { EventMatchPage } = await import('./EventMatch');
const { ApiError } = await import('../api');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const view = (over: Partial<MatchRoomView> = {}): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'veto', higher: 'a', deadline: null, serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: '',
  pool: [], log: [], games: [], next: null, lineups: { a: null, b: null, aLocked: false, bLocked: false }, holdReason: null, result: null,
  me: { side: 'a', manager: true, playable: [], defaultFour: null }, ...over,
});

describe('EventMatchPage', () => {
  it('loads the room, shows the ready check, and readies up', async () => {
    mockEvents.room.mockResolvedValue(view({ phase: 'ready', ready: { a: false, b: true }, deadline: '2026-10-06T00:05:00.000Z', serverNow: '2026-10-06T00:00:00.000Z' }));
    mockEvents.ready.mockResolvedValue({});
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'active' } as never} />);
    expect(await screen.findByText('Rats vs Bats')).toBeTruthy();
    expect(screen.getByText('Bats: ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ready' }));
    await waitFor(() => expect(mockEvents.ready).toHaveBeenCalledWith('cup', 1));
    expect(mockEvents.room).toHaveBeenCalledTimes(2);
  });

  it('shows a refusal as an alert', async () => {
    mockEvents.room.mockResolvedValue(view({ phase: 'ready', ready: { a: false, b: false } }));
    mockEvents.ready.mockRejectedValue(new ApiError(409, 'The ready check for this match has closed.'));
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'active' } as never} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ready' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The ready check for this match has closed.');
  });

  it('says the match is not found', async () => {
    mockEvents.room.mockRejectedValue(new ApiError(404, 'not found'));
    render(<EventMatchPage slug="cup" id="9" session={{ kind: 'guest' } as never} />);
    expect(await screen.findByText('No such match.')).toBeTruthy();
  });

  it('renders a pending bracket match with no teams yet, without crashing', async () => {
    mockEvents.room.mockResolvedValue(view({ phase: 'pending', a: null, b: null, me: null, ready: { a: false, b: false } }));
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'guest' } as never} />);
    expect(await screen.findByText('TBD vs TBD')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ready' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Lock lineup/ })).toBeNull();
  });
});
