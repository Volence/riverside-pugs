import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { EndorseBoard as EndorseBoardData } from '../api';

const { mockApi } = vi.hoisted(() => ({ mockApi: { endorseBoard: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});
const { EndorseBoard } = await import('./EndorseBoard');

const row = (steamid: string, name: string, caller: number, clutch: number, vibes: number, givers: number) =>
  ({ steamid, name, games: 10, caller, clutch, vibes, total: caller + clutch + vibes, givers });
const data: EndorseBoardData = {
  season: { id: 1, name: 'Season 1' },
  rows: [row('1', 'vibey', 0, 1, 9, 6), row('2', 'shotcaller', 6, 1, 1, 5), row('3', 'duo', 0, 0, 10, 1)],
};
const names = () => screen.getAllByRole('link').map((a) => a.textContent);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EndorseBoard', () => {
  it('ranks by total, breaking ties on how many different people, and sorts by any kind', async () => {
    mockApi.endorseBoard.mockResolvedValue(data);
    render(<EndorseBoard me={null} />);
    await waitFor(() => screen.getByRole('link', { name: 'vibey' }));
    // vibey and duo both have 10; vibey's came from 6 people, duo's from 1.
    expect(names()).toEqual(['vibey', 'duo', 'shotcaller']);
    fireEvent.click(screen.getByText('Caller'));
    expect(names()[0]).toBe('shotcaller');
    fireEvent.click(screen.getByText('People'));
    expect(names()).toEqual(['vibey', 'shotcaller', 'duo']);
  });

  it('says so when nobody has been endorsed', async () => {
    mockApi.endorseBoard.mockResolvedValue({ season: data.season, rows: [] });
    render(<EndorseBoard me={null} />);
    await waitFor(() => screen.getByText('Nobody has been endorsed this season yet.'));
  });
});
