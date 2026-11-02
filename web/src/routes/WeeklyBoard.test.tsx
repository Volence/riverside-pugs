import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { WeeklyData } from '../api';

const { mockApi } = vi.hoisted(() => ({ mockApi: { weekly: vi.fn(), weeklyWeeks: vi.fn(), weeklyPlayer: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});
const { WeeklyBoard, ordinal } = await import('./WeeklyBoard');

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
    // "Skeets" also names a glossary entry now, so wait for at least one hit.
    await waitFor(() => screen.getAllByText('Skeets'));
    expect(screen.getByText('Survivor')).toBeTruthy();
    expect(screen.getByText('Shame')).toBeTruthy();
    expect(screen.getByText('VII')).toBeTruthy();
    expect(screen.getByText('epx')).toBeTruthy();
    expect(screen.getByText('15-4')).toBeTruthy();
    expect(screen.getByText(/final Monday 12:00 UTC/)).toBeTruthy();
  });

  it('gives every winner line a face, the name and the value in a fixed row', async () => {
    const { container } = render(<WeeklyBoard onWeek={() => {}} />);
    await waitFor(() => screen.getAllByText('Skeets'));
    const rows = [...container.querySelectorAll('.wk__row')];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.querySelector('.wk__face')).toBeTruthy();
      expect(r.querySelector('.wk__who a')).toBeTruthy();
      expect(r.querySelector('.wk__value')!.textContent).not.toBe('');
    }
    expect(container.querySelector('.wk__live')!.textContent).toBe('Live');
  });

  it('offers past weeks in the picker', async () => {
    render(<WeeklyBoard onWeek={() => {}} />);
    await waitFor(() => screen.getByRole('combobox', { name: 'Week' }));
    expect(screen.getByRole('option', { name: 'Week of Sep 21' })).toBeTruthy();
  });

  it('still shows the week picker when the week fails to load', async () => {
    mockApi.weekly.mockClear();
    mockApi.weekly.mockRejectedValue(new Error('boom'));
    render(<WeeklyBoard onWeek={() => {}} />);
    // It retries once quietly (a deploy restart), then gives up with Try again.
    await waitFor(() => screen.getByText(/Could not load this week\./), { timeout: 4000 });
    expect(mockApi.weekly).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
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

  it('shows the glossary, with the live minimum filled in', async () => {
    render(<WeeklyBoard onWeek={() => {}} />);
    await waitFor(() => screen.getByText('What these mean'));
    expect(screen.getByText('Iron man')).toBeTruthy();
    expect(screen.getByText(/among players with at least 5\+ games that week/)).toBeTruthy();
  });

  it('still shows the glossary when the week has no awards yet', async () => {
    mockApi.weekly.mockResolvedValue({ ...data, awards: [] });
    render(<WeeklyBoard onWeek={() => {}} />);
    await waitFor(() => screen.getByText('No awards yet this week.'));
    expect(screen.getByText('What these mean')).toBeTruthy();
    expect(screen.getByText('Iron man')).toBeTruthy();
  });

  it('shows the signed-in viewer their week and a You row under each card', async () => {
    mockApi.weeklyPlayer.mockResolvedValue({
      week: '2026-09-28', games: 3, minGames: 5, qualifies: false, players: 41,
      stats: [{
        key: 'skeets', label: 'Skeets', group: 'survivor',
        avg: { value: 3.66, rank: null, of: 12, leader: 4.6, gap: 0.94 },
        total: { value: 11, rank: 7, of: 41, leader: 187, gap: 176 },
      }],
    });
    const { container } = render(<WeeklyBoard onWeek={() => {}} me="76561199000000001" />);
    await waitFor(() => screen.getByText('Your week'));
    expect(mockApi.weeklyPlayer).toHaveBeenCalledWith('76561199000000001', expect.anything(), undefined);
    expect(screen.getByText(/2 more games to qualify for averages/)).toBeTruthy();
    expect(screen.getByText('not ranked yet')).toBeTruthy();
    expect(screen.getByText('7th of 41, 176 behind')).toBeTruthy();
    expect(container.querySelector('.wk__you--close')).toBeNull();
  });

  it('marks the leader and the close ones', async () => {
    mockApi.weeklyPlayer.mockResolvedValue({
      week: '2026-09-28', games: 6, minGames: 5, qualifies: true, players: 41,
      stats: [{
        key: 'skeets', label: 'Skeets', group: 'survivor',
        avg: { value: 4.6, rank: 1, of: 12, leader: 4.6, gap: 0 },
        total: { value: 180, rank: 4, of: 41, leader: 187, gap: 7 },
      }],
    });
    const { container } = render(<WeeklyBoard onWeek={() => {}} me="76561199000000001" />);
    await waitFor(() => screen.getByText('1st of 12, you lead'));
    expect(container.querySelector('.wk__you--lead')).toBeTruthy();
    // 4th, but within a tenth of the leader's 187.
    expect(container.querySelector('.wk__you--close')!.textContent).toContain('4th of 41, 7 behind');
  });

  it('asks nothing for a signed-out reader', async () => {
    mockApi.weeklyPlayer.mockClear();
    render(<WeeklyBoard onWeek={() => {}} me={null} />);
    await waitFor(() => screen.getAllByText('Skeets'));
    expect(mockApi.weeklyPlayer).not.toHaveBeenCalled();
    expect(screen.queryByText('Your week')).toBeNull();
  });

  it('writes ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  });
});
