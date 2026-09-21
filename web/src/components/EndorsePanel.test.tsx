import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { EndorseState } from '../api';
import { hoursLeft } from '../endorse';

const { mockApi } = vi.hoisted(() => ({ mockApi: { endorseState: vi.fn(), endorse: vi.fn() } }));
vi.mock('../api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: mockApi }));

const { EndorsePanel } = await import('./EndorsePanel');

const state = (over: Partial<EndorseState> = {}): EndorseState => ({
  eligible: true, reason: null, closesAt: '2099-01-01 00:00:00', budget: 2, remaining: 2, given: [],
  candidates: [
    { steamid: '76561198000000002', name: 'ann', team: 'a' },
    { steamid: '76561198000000003', name: 'bob', team: 'b' },
  ],
  ...over,
});

beforeEach(() => { mockApi.endorseState.mockResolvedValue(state()); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EndorsePanel', () => {
  it('offers the three kinds for each other player, and no negative one', async () => {
    render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(screen.getByText('ann')).toBeTruthy());
    expect(screen.getAllByRole('button', { name: 'Caller' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Clutch' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Good vibes' })).toHaveLength(2);
    expect(screen.getByText(/2 of 2 left/)).toBeTruthy();
    expect(screen.getByText(/anonymous/i)).toBeTruthy();
  });

  it('renders nothing for a viewer who may not endorse here', async () => {
    mockApi.endorseState.mockResolvedValue(state({ eligible: false, reason: 'not_rostered', candidates: [] }));
    const { container } = render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(mockApi.endorseState).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the request fails, such as for a signed-out viewer', async () => {
    mockApi.endorseState.mockRejectedValue(new Error('401'));
    const { container } = render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(mockApi.endorseState).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('gives one on a click and redraws from the state the server sends back', async () => {
    mockApi.endorse.mockResolvedValue({
      ok: true, remaining: 1,
      state: state({ remaining: 1, given: [{ to: '76561198000000002', kind: 'clutch' }] }),
    });
    render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(screen.getByText('ann')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Clutch' })[0]);
    await waitFor(() => expect(screen.getByText(/1 of 2 left/)).toBeTruthy());
    expect(mockApi.endorse).toHaveBeenCalledWith(7, '76561198000000002', 'clutch');
    // ann is settled: her row shows the kind and offers no more buttons.
    expect(screen.getAllByRole('button', { name: 'Clutch' })).toHaveLength(1);
  });

  it('locks the remaining players once the budget is spent', async () => {
    mockApi.endorseState.mockResolvedValue(state({ remaining: 0, given: [{ to: '76561198000000002', kind: 'caller' }] }));
    render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(screen.getByText('bob')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Clutch' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/given all/i)).toBeTruthy();
  });

  it('shows the server sentence when a click is refused', async () => {
    mockApi.endorse.mockRejectedValue(new Error('Endorsing for this match has closed.'));
    render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(screen.getByText('ann')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Caller' })[0]);
    await waitFor(() => expect(screen.getByText('Endorsing for this match has closed.')).toBeTruthy());
  });
});

describe('hoursLeft', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  it('reads the server timestamp as UTC and rounds up', () => {
    expect(hoursLeft('2026-09-21 14:30:00', now)).toBe(3);
  });
  it('never goes below zero, and is null for nothing', () => {
    expect(hoursLeft('2026-09-20 00:00:00', now)).toBe(0);
    expect(hoursLeft(null, now)).toBeNull();
    expect(hoursLeft('garbage', now)).toBeNull();
  });
});
