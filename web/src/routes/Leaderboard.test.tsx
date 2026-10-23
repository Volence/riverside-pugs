import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { Leaderboard as LeaderboardData, WeeklyData } from '../api';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { leaderboard: vi.fn(), seasons: vi.fn(), weekly: vi.fn(), weeklyWeeks: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});
const { Leaderboard } = await import('./Leaderboard');

const leaderboardData: LeaderboardData = {
  season: { id: 1, name: 'Season 1' },
  matchesRated: 20,
  rows: [
    { steamid: '1', name: 'p1', avatar: null, sr: 1500, wins: 10, losses: 5, games: 15, ranked: true, stats: { skeets: 20 } },
  ],
};
const weeklyData: WeeklyData = {
  week: '2026-09-28', live: true, minGames: 5,
  recap: { matches: 0, players: 0, peakConcurrent: 0, busiestDay: null, highlights: [], mostQuads: null, totals: [], streaks: [], iron: [], closest: null },
  awards: [],
};

beforeEach(() => {
  mockApi.leaderboard.mockResolvedValue(leaderboardData);
  mockApi.seasons.mockResolvedValue({ seasons: [] });
  mockApi.weekly.mockResolvedValue(weeklyData);
  mockApi.weeklyWeeks.mockResolvedValue({ current: '2026-09-28', weeks: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Leaderboard', () => {
  it('shows season figures and stat leaders in season mode, but only the weekly board in weekly mode', async () => {
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => screen.getByRole('link', { name: 'p1' }));
    expect(container.querySelector('.figures')).toBeTruthy();
    expect(container.querySelector('.statleaders')).toBeTruthy();
    expect(container.querySelector('.lb-layout')).toBeTruthy();

    fireEvent.click(screen.getByText('This week'));
    await waitFor(() => screen.getByText('No awards yet this week.'));
    expect(container.querySelector('.figures')).toBeNull();
    expect(container.querySelector('.statleaders')).toBeNull();
    expect(container.querySelector('.lb-layout')).toBeNull();
  });
});

// Owner 2026-10-23: stat columns and leader cards per game by default, ranked
// from 10 games, placing players off the cards, no Top rated card.
describe('Leaderboard stats per game', () => {
  const rows: LeaderboardData['rows'] = [
    { steamid: '1', name: 'vet', avatar: null, sr: 1500, wins: 12, losses: 8, games: 20, statGames: 20, ranked: true, stats: { skeets: 30 } },
    { steamid: '2', name: 'grinder', avatar: null, sr: 1400, wins: 30, losses: 30, games: 60, statGames: 60, ranked: true, stats: { skeets: 60 } },
    { steamid: '3', name: 'fluke', avatar: null, sr: 1300, wins: 5, losses: 1, games: 6, statGames: 6, ranked: true, stats: { skeets: 30 } },
    { steamid: '4', name: 'placer', avatar: null, sr: null, wins: 3, losses: 0, games: 3, statGames: 12, ranked: false, placing: { played: 3, of: 5 }, stats: { skeets: 90 } },
  ];

  beforeEach(() => {
    mockApi.leaderboard.mockResolvedValue({ season: { id: 2, name: 'Season 1' }, matchesRated: 30, statMinGames: 10, rows });
  });

  const card = (container: Element) => container.querySelector('.statleader') as HTMLElement;

  it('leads with the best per-game figure among ranked players past the minimum', async () => {
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => screen.getByRole('link', { name: 'vet' }));
    // vet 1.5/game beats grinder 1.0; fluke (6 games) and placer (placing) are off the card.
    expect(card(container).textContent).toContain('Skeets / game');
    expect(card(container).querySelector('.statleader__name')!.textContent).toBe('vet');
    expect(card(container).querySelector('.statleader__value')!.textContent).toBe('1.5');
    expect(card(container).textContent).not.toContain('fluke');
    expect(card(container).textContent).not.toContain('placer');
  });

  it('switches cards to season totals, still for ranked players only', async () => {
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => screen.getByRole('link', { name: 'vet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Totals' }));
    expect(card(container).querySelector('.statleader__name')!.textContent).toBe('grinder');
    expect(card(container).textContent).not.toContain('placer');
  });

  it('keeps the table in SR order and has no Top rated card', async () => {
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => screen.getByRole('link', { name: 'vet' }));
    const names = [...container.querySelectorAll('tbody .pname a')].map((a) => a.textContent);
    expect(names).toEqual(['vet', 'grinder', 'fluke', 'placer']);
    expect(screen.queryByText('Top rated')).toBeNull();
  });

  it('greys a per-game cell under the minimum', async () => {
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => screen.getByRole('link', { name: 'fluke' }));
    const cell = container.querySelector('td[title^="Under 10 games"]');
    expect(cell?.textContent).toBe('5.0');
  });

  it('gives no place to a ranked player under the minimum when sorted by a stat', async () => {
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => screen.getByRole('link', { name: 'fluke' }));
    fireEvent.click(screen.getByTitle('Sort the table by Skeets'));
    const rows = [...container.querySelectorAll('tbody tr:not(.lb__group)')].map((tr) => [
      tr.querySelector('.pname a')?.textContent, tr.querySelector('td.rank')?.textContent,
    ]);
    // vet 1.5, grinder 1.0 ranked; fluke (6 games) listed with no place.
    expect(rows.slice(0, 3)).toEqual([['vet', '01'], ['grinder', '02'], ['fluke', '–']]);
  });
});
