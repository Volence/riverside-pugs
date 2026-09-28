import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { WeeklyData } from '../api';

const { mockApi } = vi.hoisted(() => ({ mockApi: { weekly: vi.fn(), weeklyWeeks: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});
const { WeeklyBoard } = await import('./WeeklyBoard');

const w = (steamid: string, name: string, value: number, detail: string | null = null) => ({ steamid, name, value, games: 5, detail });
const data: WeeklyData = {
  week: '2026-09-28', live: true, minGames: 5,
  recap: { matches: 3, players: 6, peakConcurrent: 1, busiestDay: null, highlights: [], mostQuads: null, totals: [], streaks: [], iron: [], closest: null },
  awards: [
    { key: 'skeets', label: 'Skeets', group: 'survivor', kind: 'avg', winners: [w('1', 'VII', 4.6)] },
    { key: 'skeets', label: 'Skeets', group: 'survivor', kind: 'total', winners: [w('2', 'epx', 187)] },
    { key: 'win_rate', label: 'Best win rate', group: 'overall', kind: 'single', winners: [w('3', 'mado', 0.79, '15-4')] },
    { key: 'slow_ready', label: 'Slowest ready-up', group: 'shame', kind: 'single', winners: [w('4', 'slow', 53.8)] },
  ],
};

beforeEach(() => {
  mockApi.weekly.mockResolvedValue(data);
  mockApi.weeklyWeeks.mockResolvedValue({ current: '2026-09-28', weeks: ['2026-09-21'] });
});
afterEach(cleanup);

describe('WeeklyBoard', () => {
  it('shows each section, both winners of a stat award, and the live note', async () => {
    render(<WeeklyBoard onWeek={() => {}} />);
    await waitFor(() => screen.getByText('Skeets'));
    expect(screen.getByText('Survivor')).toBeTruthy();
    expect(screen.getByText('Shame')).toBeTruthy();
    expect(screen.getByText('VII')).toBeTruthy();
    expect(screen.getByText('epx')).toBeTruthy();
    expect(screen.getByText('15-4')).toBeTruthy();
    expect(screen.getByText(/final Monday 12:00 UTC/)).toBeTruthy();
  });

  it('offers past weeks in the picker', async () => {
    render(<WeeklyBoard onWeek={() => {}} />);
    await waitFor(() => screen.getByRole('combobox', { name: 'Week' }));
    expect(screen.getByRole('option', { name: 'Week of Sep 21' })).toBeTruthy();
  });

  it('still shows the week picker when the week fails to load', async () => {
    mockApi.weekly.mockRejectedValue(new Error('boom'));
    render(<WeeklyBoard onWeek={() => {}} />);
    await waitFor(() => screen.getByText('Could not load this week.'));
    expect(screen.getByRole('combobox', { name: 'Week' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Week of Sep 21' })).toBeTruthy();
  });

  it('treats the linked week as live once it is the current week again', async () => {
    // A stale Discord link or profile chip points at ?week=<its Monday>. Once
    // that week becomes the current one, it must read as "This week" (live),
    // not as a request for a week id that means nothing special any more.
    render(<WeeklyBoard week="2026-09-28" onWeek={() => {}} />);
    await waitFor(() => expect(mockApi.weekly).toHaveBeenCalledWith(expect.anything(), undefined));
  });
});
