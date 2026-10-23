import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockApi, mockCommunity } = vi.hoisted(() => ({
  mockApi: { profile: vi.fn(), endorseState: vi.fn() },
  mockCommunity: { list: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi }, communityApi: { ...actual.communityApi, ...mockCommunity } };
});

const { Profile } = await import('./Profile');
const { LocationProvider, Router, Route, useLocation } = await import('preact-iso');

/** Owner 2026-10-23: every profile number follows the selected season, a
 *  Career view has the all-time ones, the page says which, and a season with
 *  no games yet gets a sentence rather than a wall of zeros. */

const seasonsPlayed = [
  { id: 2, name: 'Season 1', current: true, games: 0 },
  { id: 1, name: 'Season 0', current: false, games: 40 },
];
const base = {
  player: {
    steamid: '1', name: 'alice', avatar: null, createdAt: '2026-01-01T00:00:00',
    bio: null, pronouns: null, country: null, twitchName: null,
  },
  social: [],
  seasonsPlayed,
  matches: [],
  history: [],
  statTotals: {},
  privateStatTotals: null,
  statDefs: [],
  standings: {},
};
const dayOne = {
  ...base,
  scope: { kind: 'season', seasonId: 2, name: 'Season 1', current: true },
  rating: { sr: null, wins: 0, losses: 0 },
  record: { wins: 0, losses: 0 },
  season: { id: 2, name: 'Season 1', current: true, placementGames: 5, ranks: true, finalMinGames: 20, games: 0, sr: null, placing: { played: 0, of: 5 }, rank: null, peakSr: null, top10: false },
  totals: { games: 0, siDamage: 0, siKills: 0, commonKills: 0, ffDealt: 0, revives: 0 },
};
const career = {
  ...base,
  scope: { kind: 'career' },
  rating: null,
  record: { wins: 25, losses: 15 },
  season: null,
  totals: { games: 40, siDamage: 4000, siKills: 100, commonKills: 800, ffDealt: 30, revives: 12 },
};

beforeEach(() => {
  for (const fn of [...Object.values(mockApi), ...Object.values(mockCommunity)]) fn.mockReset();
  mockApi.endorseState.mockResolvedValue(null);
  mockCommunity.list.mockResolvedValue({ entries: [], page: 0, pageSize: 24, total: 0 });
  history.replaceState(null, '', '/player/1');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('profile scope', () => {
  it('opens on the current season and says so; day one is a sentence, not zeros', async () => {
    mockApi.profile.mockResolvedValue(dayOne);
    const { container } = render(<Profile steamid="1" />);
    await screen.findByText('No matches in Season 1 yet');
    expect(mockApi.profile).toHaveBeenCalledWith('1', expect.anything(), undefined);
    expect(screen.getByText('Every number here is for Season 1, the current season.')).toBeTruthy();
    expect(screen.getByText('Placing 0/5')).toBeTruthy();
    // No figures, totals or by-map panels full of zeros.
    expect(container.querySelector('.figures')).toBeNull();
    expect(screen.queryByText('Season 1 totals')).toBeNull();
    expect(container.querySelector('.headliner__stats')).toBeNull();
  });

  it('switches to the career from the empty season, and puts it in the URL', async () => {
    mockApi.profile.mockImplementation(async (_id: string, _s: unknown, scope?: unknown) => (scope === 'career' ? career : dayOne));
    render(<Profile steamid="1" />);
    fireEvent.click(await screen.findByText('See career numbers'));
    await screen.findByText('Career totals');
    expect(mockApi.profile).toHaveBeenLastCalledWith('1', expect.anything(), 'career');
    expect(location.search).toBe('?season=career');
    expect(screen.getByText('All seasons')).toBeTruthy();
    expect(screen.getByText(/Every number here is for all seasons together/)).toBeTruthy();
  });

  it('shows one game count, in the header, and no season badges in Career view', async () => {
    mockApi.profile.mockResolvedValue({ ...career, standings: { skeets: { rank: 1, of: 9 } } });
    history.replaceState(null, '', '/player/1?season=career');
    const { container } = render(<Profile steamid="1" />);
    await screen.findByText('Career totals');
    expect(mockApi.profile).toHaveBeenCalledWith('1', expect.anything(), 'career');
    expect(screen.getAllByText('Matches')).toHaveLength(1);
    expect(screen.queryByText('Games')).toBeNull();
    expect(container.querySelector('.standings')).toBeNull();
    // Win rate from the career record, the same one the header shows.
    expect(screen.getByText('63%')).toBeTruthy();
    expect(screen.getAllByText('25W 15L').length).toBeGreaterThan(0);
  });

  it('offers each played season and the career in the picker', async () => {
    mockApi.profile.mockResolvedValue(dayOne);
    render(<Profile steamid="1" />);
    const picker = await screen.findByLabelText('Show numbers for') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Season 1 (current)', 'Season 0', 'Career (all seasons)']);
    fireEvent.change(picker, { target: { value: '1' } });
    await waitFor(() => expect(mockApi.profile).toHaveBeenLastCalledWith('1', expect.anything(), 1));
  });
});

describe('profile scope: an abandon loss only', () => {
  it('shows the record rather than "No matches yet", and no zero stat panels', async () => {
    mockApi.profile.mockResolvedValue({ ...dayOne, rating: { sr: null, wins: 0, losses: 1 }, record: { wins: 0, losses: 1 } });
    const { container } = render(<Profile steamid="1" />);
    await screen.findByText('0W 1L');
    expect(screen.queryByText('No matches in Season 1 yet')).toBeNull();
    expect(container.querySelector('.figures')).toBeNull();
    expect(screen.queryByText('Season 1 totals')).toBeNull();
  });
});

describe('profile scope under the router', () => {
  /** A button that navigates, standing in for a link on the page. */
  function Go({ to }: { to: string }) {
    const { route } = useLocation();
    return <button type="button" onClick={() => route(to)}>{`go ${to}`}</button>;
  }
  const app = () => (
    <LocationProvider>
      <Go to="/player/2" />
      <Go to="/player/2?season=1" />
      <Router>
        <Route path="/player/:steamid" component={Profile} />
        <Route default component={() => null} />
      </Router>
    </LocationProvider>
  );

  it('does not carry one player\'s Career view onto the next, and follows a ?season link', async () => {
    mockApi.profile.mockImplementation(async (_id: string, _s: unknown, scope?: unknown) => (scope === 'career' ? career : dayOne));
    history.replaceState(null, '', '/player/1?season=career');
    render(app());
    await screen.findByText('Career totals');
    expect(mockApi.profile).toHaveBeenLastCalledWith('1', expect.anything(), 'career');

    fireEvent.click(screen.getByText('go /player/2'));
    await waitFor(() => expect(mockApi.profile).toHaveBeenLastCalledWith('2', expect.anything(), undefined));

    fireEvent.click(screen.getByText('go /player/2?season=1'));
    await waitFor(() => expect(mockApi.profile).toHaveBeenLastCalledWith('2', expect.anything(), 1));
  });

  it('drops a season id the server did not know, keeping the current season shown', async () => {
    mockApi.profile.mockResolvedValue(dayOne);
    history.replaceState(null, '', '/player/1?season=99');
    render(app());
    await screen.findByText('No matches in Season 1 yet');
    await waitFor(() => expect(location.search).toBe(''));
  });
});
