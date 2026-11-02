import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';

const { mockApi } = vi.hoisted(() => ({ mockApi: { weeklyPlayer: vi.fn(), weeklyPlayerHistory: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});
const { ProfileWeekly } = await import('./ProfileWeekly');

afterEach(cleanup);

const row = (week: string, extra: object = {}) => ({ week, live: false, games: 6, skeets: 12, commonKills: 900, damageAsSi: 2500, awards: [], ...extra });

describe('ProfileWeekly', () => {
  it('shows this week\'s best boards and the weeks played, each linking to its board', async () => {
    mockApi.weeklyPlayer.mockResolvedValue({
      week: '2026-09-28', games: 3, minGames: 5, qualifies: false, players: 41,
      stats: [
        { key: 'skeets', label: 'Skeets', group: 'survivor', avg: null, total: { value: 11, rank: 2, of: 41, leader: 20, gap: 9 } },
        { key: 'rock_skeets', label: 'Rock skeets', group: 'survivor', avg: null, total: { value: 0, rank: 9, of: 41, leader: 3, gap: 3 } },
      ],
    });
    mockApi.weeklyPlayerHistory.mockResolvedValue({ weeks: [
      row('2026-09-28', { live: true, games: 3 }),
      row('2026-09-21', { awards: [{ key: 'skeets', label: 'Skeets', kind: 'total' }] }),
    ] });
    const { container } = render(<ProfileWeekly steamid="76561199000000001" />);
    await waitFor(() => screen.getByText('Weekly'));
    await waitFor(() => screen.getByText('2nd of 41'));
    expect(screen.getByText(/2 more to qualify for averages/)).toBeTruthy();
    // A board with nothing on it this week is left out.
    expect(screen.queryByText('Rock skeets')).toBeNull();
    expect(screen.getByText('Skeets (total)')).toBeTruthy();
    const links = [...container.querySelectorAll('tbody a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/leaderboard?week=2026-09-28', '/leaderboard?week=2026-09-21']);
  });

  it('folds weeks past eight behind Show all', async () => {
    mockApi.weeklyPlayer.mockResolvedValue({ week: '2026-09-28', games: 0, minGames: 5, qualifies: false, players: 41, stats: [] });
    mockApi.weeklyPlayerHistory.mockResolvedValue({ weeks: Array.from({ length: 10 }, (_, i) => row(`2026-0${i % 9 + 1}-0${(i % 7) + 1}`)) });
    const { container } = render(<ProfileWeekly steamid="76561199000000001" />);
    await waitFor(() => screen.getByText('Show all 10 weeks'));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(8);
  });

  it('renders nothing for someone who never played', async () => {
    mockApi.weeklyPlayer.mockResolvedValue({ week: '2026-09-28', games: 0, minGames: 5, qualifies: false, players: 41, stats: [] });
    mockApi.weeklyPlayerHistory.mockResolvedValue({ weeks: [] });
    const { container } = render(<ProfileWeekly steamid="76561199000000001" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });

  it('leaves the awards column out when no week has an award', async () => {
    mockApi.weeklyPlayer.mockResolvedValue({ week: '2026-10-19', games: 0, minGames: 5, qualifies: false, players: 41, stats: [] });
    mockApi.weeklyPlayerHistory.mockResolvedValue({ weeks: [row('2026-10-12'), row('2026-10-05')] });
    const { container } = render(<ProfileWeekly steamid="1" />);
    await screen.findByText('Commons');
    expect(container.querySelector('.pweek__awards')).toBeNull();
    expect([...container.querySelectorAll('th')].map((t) => t.textContent)).not.toContain('Awards');
  });
});
