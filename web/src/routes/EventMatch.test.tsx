import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { MatchRoomView } from '../api';

const { mockEvents } = vi.hoisted(() => ({
  mockEvents: { room: vi.fn(), ready: vi.fn(), veto: vi.fn(), lineup: vi.fn(), confirmResult: vi.fn(), dispute: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
vi.mock('../hooks/useHubEvent', () => ({ useHubEvent: () => {} }));
vi.mock('../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { EventMatchPage } = await import('./EventMatch');
const { ApiError } = await import('../api');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const view = (over: Partial<MatchRoomView> = {}): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'veto', higher: 'a', deadline: null, serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: '',
  pool: [], log: [], games: [], next: null, lineups: { a: null, b: null, aLocked: false, bLocked: false }, holdReason: null, result: null,
  me: { side: 'a', manager: true, playable: [], defaultFour: null },
  series: null, server: null, confirm: null, dispute: null, frozen: false, ...over,
});

describe('EventMatchPage', () => {
  it('loads the room, shows the ready check, and readies up', async () => {
    mockEvents.room.mockResolvedValue(view({ phase: 'ready', ready: { a: false, b: true }, deadline: '2026-10-06T00:05:00.000Z', serverNow: '2026-10-06T00:00:00.000Z' }));
    mockEvents.ready.mockResolvedValue({});
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'active' } as never} />);
    expect(await screen.findByRole('heading', { name: 'Rats vs Bats' })).toBeTruthy();
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
    expect(await screen.findByRole('heading', { name: 'TBD vs TBD' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ready' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Lock lineup/ })).toBeNull();
  });

  it('shows a team logo next to its name in the header only once it has one', async () => {
    mockEvents.room.mockResolvedValue(view({ a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: 'abc', seed: 1, out: false } }));
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'guest' } as never} />);
    const heading = await screen.findByRole('heading', { name: 'Rats vs Bats' });
    expect(within(heading).getAllByRole('img')).toHaveLength(1);
  });

  it.each(['waiting', 'server', 'hold'] as const)('refetches every 10 s in the %s phase, since a result can close the room with no push', async (phase) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      mockEvents.room.mockResolvedValue(view({ phase, holdReason: null }));
      render(<EventMatchPage slug="cup" id="1" session={{ kind: 'guest' } as never} />);
      await screen.findByRole('heading', { name: 'Rats vs Bats' });
      expect(mockEvents.room).toHaveBeenCalledTimes(1);
      // Preact runs effects after paint (real timers), so advance until the poll is set.
      await vi.waitFor(() => {
        vi.advanceTimersByTime(10_000);
        expect(mockEvents.room).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops refetching once the match is done', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      mockEvents.room.mockResolvedValue(view({ phase: 'done' }));
      render(<EventMatchPage slug="cup" id="1" session={{ kind: 'guest' } as never} />);
      await screen.findByRole('heading', { name: 'Rats vs Bats' });
      await new Promise((r) => setTimeout(r, 100));
      vi.advanceTimersByTime(30_000);
      expect(mockEvents.room).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a team logo in the ready check the same way as in the header', async () => {
    mockEvents.room.mockResolvedValue(view({ phase: 'ready', ready: { a: false, b: true }, a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: 'abc', seed: 1, out: false } }));
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'guest' } as never} />);
    const ready = (await screen.findByText('Rats: waiting')).closest('li')!;
    expect(ready.querySelector('.roomteam img')).toBeTruthy();
    expect(screen.getByText('Bats: ready').closest('.roomteam')).toBeTruthy();
  });

  it('shows the server panel with the connect line in the connect phase, and the series with a live score (plan T3b)', async () => {
    mockEvents.room.mockResolvedValue(view({
      phase: 'live', deadline: null,
      server: { state: 'ready', name: 'box', since: '2026-10-06T00:00:00.000Z', connect: { host: '10.0.0.1', port: 27015, password: 'pw' }, present: { a: 4, b: 4 }, graceEndsAt: null },
      series: { bestOf: 1, totalScore: false, winsA: 0, winsB: 0, totalA: 0, totalB: 0, over: false, winner: null },
      games: [{ id: 1, game: 1, ordinal: 1, tiebreak: false, campaign: 'no_mercy', campaignName: 'No Mercy', map: null, pickedBy: null, sideBy: 'b', firstSurvivors: 'b', matchId: 7, state: 'live', scoreA: null, scoreB: null, winner: null, forfeit: null, live: { map: 'l4d_vs_hospital02_subway', scoreA: 80, scoreB: 120 } }],
    }));
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'active' } as never} />);
    expect(await screen.findByText('connect 10.0.0.1:27015; password pw')).toBeTruthy();
    expect(screen.getByText('Game 1 · No Mercy · live on l4d_vs_hospital02_subway · Rats 80 - 120 Bats')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
  });

  it('confirms and disputes from the confirm panel (plan T3b)', async () => {
    mockEvents.room.mockResolvedValue(view({
      phase: 'confirming', deadline: '2026-10-06T00:15:00.000Z',
      me: { side: 'b', manager: true, playable: [], defaultFour: null },
      series: { bestOf: 1, totalScore: false, winsA: 1, winsB: 0, totalA: 0, totalB: 0, over: true, winner: 'a' },
      confirm: { deadline: '2026-10-06T00:15:00.000Z', a: false, b: false },
    }));
    mockEvents.confirmResult.mockResolvedValue({});
    mockEvents.dispute.mockResolvedValue({});
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'active' } as never} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm the result' }));
    await waitFor(() => expect(mockEvents.confirmResult).toHaveBeenCalledWith('cup', 1));
    fireEvent.input(screen.getByRole('textbox', { name: 'Why you dispute the result' }), { target: { value: 'They had five' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dispute the result' }));
    await waitFor(() => expect(mockEvents.dispute).toHaveBeenCalledWith('cup', 1, 'They had five'));
  });
});
