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
