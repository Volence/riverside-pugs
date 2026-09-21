import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockApi } = vi.hoisted(() => ({ mockApi: { endorsePending: vi.fn() } }));
vi.mock('../api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: mockApi }));

const { EndorseBar } = await import('./EndorseBar');

beforeEach(() => {
  localStorage.clear();
  mockApi.endorsePending.mockResolvedValue({ pending: [{ matchId: 12, remaining: 2 }] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EndorseBar', () => {
  it('asks nothing and shows nothing for a signed-out viewer', () => {
    const { container } = render(<EndorseBar me={null} path="/" />);
    expect(mockApi.endorsePending).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('links to the match you can still endorse on', async () => {
    render(<EndorseBar me="76561198000000001" path="/leaderboard" />);
    const a = await waitFor(() => screen.getByRole('link'));
    expect(a.getAttribute('href')).toBe('/match/12#endorse');
    expect(a.textContent).toMatch(/2 endorsements to give from PUG #12/);
  });

  it('says "1 endorsement", not "1 endorsements"', async () => {
    mockApi.endorsePending.mockResolvedValue({ pending: [{ matchId: 12, remaining: 1 }] });
    render(<EndorseBar me="76561198000000001" path="/" />);
    const a = await waitFor(() => screen.getByRole('link'));
    expect(a.textContent).toMatch(/1 endorsement to give/);
  });

  it('stays out of the way on the match page it points at', async () => {
    const { container } = render(<EndorseBar me="76561198000000001" path="/match/12" />);
    await waitFor(() => expect(mockApi.endorsePending).toHaveBeenCalled());
    expect(container.querySelector('.endorsebar')).toBeNull();
  });

  it('can be dismissed for that match, and stays dismissed', async () => {
    const first = render(<EndorseBar me="76561198000000001" path="/" />);
    await waitFor(() => screen.getByRole('link'));
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(first.container.querySelector('.endorsebar')).toBeNull();
    cleanup();
    const second = render(<EndorseBar me="76561198000000001" path="/" />);
    await waitFor(() => expect(mockApi.endorsePending).toHaveBeenCalledTimes(2));
    expect(second.container.querySelector('.endorsebar')).toBeNull();
  });

  it('shows nothing when the request fails', async () => {
    mockApi.endorsePending.mockRejectedValue(new Error('403'));
    const { container } = render(<EndorseBar me="76561198000000001" path="/" />);
    await waitFor(() => expect(mockApi.endorsePending).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
