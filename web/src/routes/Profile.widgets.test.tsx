import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { Session } from '../hooks/useLiveState';

const { mockApi, mockCommunity } = vi.hoisted(() => ({
  mockApi: { profile: vi.fn(), endorseState: vi.fn(), widget: vi.fn(), myReports: vi.fn() },
  mockCommunity: { list: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi }, communityApi: { ...actual.communityApi, ...mockCommunity } };
});

const { Profile } = await import('./Profile');

const profile = {
  player: {
    steamid: '1', name: 'alice', avatar: null, createdAt: '2026-01-01T00:00:00',
    bio: null, pronouns: null, country: null, twitchName: null,
  },
  social: [],
  seasonsPlayed: [{ id: 2, name: 'Season 1', current: true, games: 0 }],
  matches: [],
  history: [],
  statTotals: {},
  privateStatTotals: null,
  statDefs: [],
  standings: {},
  scope: { kind: 'season', seasonId: 2, name: 'Season 1', current: true },
  rating: { sr: null, wins: 0, losses: 0 },
  record: { wins: 0, losses: 0 },
  season: { id: 2, name: 'Season 1', current: true, placementGames: 5, ranks: true, finalMinGames: 20, games: 0, sr: null, placing: { played: 0, of: 5 }, rank: null, peakSr: null, top10: false },
  totals: { games: 0, siDamage: 0, siKills: 0, commonKills: 0, ffDealt: 0, revives: 0 },
};

const sessionFor = (steamid: string): Session => ({
  kind: 'active',
  me: { steamid, name: 'me', avatar: null, status: 'active', isAdmin: false },
} as Session);

beforeEach(() => {
  for (const fn of [...Object.values(mockApi), ...Object.values(mockCommunity)]) fn.mockReset();
  mockApi.profile.mockResolvedValue(profile);
  mockApi.endorseState.mockResolvedValue(null);
  mockApi.myReports.mockResolvedValue({ reports: [] });
  mockApi.widget.mockReturnValue(new Promise(() => {}));
  mockCommunity.list.mockResolvedValue({ entries: [], page: 0, pageSize: 24, total: 0 });
  history.replaceState(null, '', '/player/1');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('profile stream widgets', () => {
  it('Profile shows Stream widgets only on your own profile', async () => {
    const own = render(<Profile steamid="1" session={sessionFor('1')} />);
    await screen.findByText('No matches in Season 1 yet');
    expect(screen.getByRole('heading', { name: 'Stream widgets' })).toBeTruthy();
    own.unmount();

    render(<Profile steamid="1" session={sessionFor('2')} />);
    await screen.findByText('No matches in Season 1 yet');
    expect(screen.queryByRole('heading', { name: 'Stream widgets' })).toBeNull();
  });

  it('is not shown to a visitor who is not signed in', async () => {
    render(<Profile steamid="1" />);
    await screen.findByText('No matches in Season 1 yet');
    expect(screen.queryByRole('heading', { name: 'Stream widgets' })).toBeNull();
  });
});
