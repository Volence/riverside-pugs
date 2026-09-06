import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/preact';

/* Deliberately shallow. These assert that each route reaches its loaded state
 * and puts the right data on screen — not how it is marked up, so a design
 * change does not break the suite. The logic worth testing properly lives in
 * format.ts and useFetch.ts, which have their own tests. */

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    leaderboard: vi.fn(),
    matches: vi.fn(),
    match: vi.fn(),
    profile: vi.fn(),
  },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});

const { Leaderboard } = await import('./Leaderboard');
const { Matches } = await import('./Matches');
const { MatchDetail } = await import('./MatchDetail');
const { Profile } = await import('./Profile');
const { Play } = await import('./Play');

// Auto-cleanup only runs when vitest exposes globals, which this config does
// not; without it each render stacks another copy in document.body and every
// getByText finds duplicates.
afterEach(cleanup);

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

describe('Leaderboard', () => {
  it('renders ranked rows', async () => {
    mockApi.leaderboard.mockResolvedValue({
      season: { id: 1, name: 'Season 1' },
      rows: [
        { steamid: '1', name: 'alice', avatar: null, sr: 1200, wins: 3, losses: 1, games: 4 },
        { steamid: '2', name: 'bob', avatar: null, sr: 1100, wins: 1, losses: 3, games: 4 },
      ],
    });
    render(<Leaderboard me="2" />);
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy());
    expect(screen.getByText('Season 1')).toBeTruthy();
    expect(screen.getByText('1200')).toBeTruthy();
  });

  it('says so when nobody is rated yet', async () => {
    mockApi.leaderboard.mockResolvedValue({ season: { id: 1, name: 'Season 1' }, rows: [] });
    render(<Leaderboard me={null} />);
    await waitFor(() => expect(screen.getByText(/no rated players/i)).toBeTruthy());
  });
});

describe('Matches', () => {
  it('lists completed matches with campaign names, not slugs', async () => {
    mockApi.matches.mockResolvedValue({
      matches: [
        { id: 7, campaign: 'blood_harvest', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      ],
    });
    render(<Matches />);
    await waitFor(() => expect(screen.getByText('Blood Harvest')).toBeTruthy());
    expect(screen.getByText('Team A')).toBeTruthy();
  });
});

describe('MatchDetail', () => {
  it('renders per-map scores and both team tables', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300 }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
        { steamid: '2', name: 'bob', team: 'b', siDamage: 20, siKills: 2, commonKills: 3, ffDealt: 4, revives: 5, srDelta: -12 },
      ],
    });
    const { container } = render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(screen.getByText('l4d_hospital01_apartment')).toBeTruthy());
    // "Team A" appears twice here — as the winner and as a table heading.
    expect(screen.getAllByText('Team A').length).toBeGreaterThan(0);
    expect(screen.getByText('Team B')).toBeTruthy();
    // ordinal is a 0-based index in the DB but must read as map 1. Scoped to the
    // maps table, since a bare "1" also occurs among the per-player stats.
    const mapsTable = container.querySelectorAll('table')[0] as HTMLElement;
    expect(within(mapsTable).getByText('1')).toBeTruthy();
  });

  it('shows a not-found message instead of blowing up on a bad id', async () => {
    mockApi.match.mockRejectedValue(new Error('404'));
    render(<MatchDetail id="999" me={null} />);
    await waitFor(() => expect(screen.getByText(/match not found/i)).toBeTruthy());
  });
});

describe('Profile', () => {
  const profile = {
    player: { steamid: '1', name: 'alice', avatar: null, createdAt: '2026-01-01T00:00:00' },
    rating: { sr: 1200, mu: 25, sigma: 8, wins: 3, losses: 1 },
    totals: { games: 4, siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4 },
    matches: [
      { id: 7, campaign: 'dead_air', endedAt: '2026-09-06T04:00:00', teamAScore: 9, teamBScore: 8, winner: 'a' as const, team: 'a' as const, result: 'win' as const, srDelta: 12 },
    ],
    history: [{ matchId: 6, sr: 1100 }, { matchId: 7, sr: 1200 }],
  };

  it('renders rating, totals and recent matches', async () => {
    mockApi.profile.mockResolvedValue(profile);
    render(<Profile steamid="1" />);
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy());
    expect(screen.getByText('1200')).toBeTruthy();
    expect(screen.getByText('Dead Air')).toBeTruthy();
    // Shown twice by design: beside the rating hero, and in the match row.
    expect(screen.getAllByText('+12')).toHaveLength(2);
  });

  it('notes an unrated player rather than rendering a blank rating', async () => {
    mockApi.profile.mockResolvedValue({ ...profile, rating: null, matches: [], history: [] });
    render(<Profile steamid="1" />);
    await waitFor(() => expect(screen.getByText(/unrated this season/i)).toBeTruthy());
  });
});

describe('Play', () => {
  const noop = () => {};

  it('offers Steam sign-in when logged out', () => {
    render(<Play session={{ kind: 'anonymous' }} state={null} refresh={noop} />);
    expect(screen.getByText(/sign in through steam/i)).toBeTruthy();
  });

  it('asks for an invite code when registered but not active', () => {
    const me = { steamid: '1', name: 'alice', avatar: null, status: 'invited', isAdmin: false };
    render(<Play session={{ kind: 'pending', me }} state={null} refresh={noop} />);
    expect(screen.getByPlaceholderText('invite code')).toBeTruthy();
  });

  const active = {
    kind: 'active' as const,
    me: { steamid: '1', name: 'alice', avatar: null, status: 'active', isAdmin: false },
  };

  it('shows the queue when idle', () => {
    render(
      <Play session={active} state={{ queue: { count: 3, joined: false }, lobby: null, match: null }} refresh={noop} />,
    );
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText(/join queue/i)).toBeTruthy();
  });

  it('shows the ready check with the roster during a ready check', () => {
    render(
      <Play
        session={active}
        state={{
          queue: { count: 8, joined: true },
          lobby: {
            id: 'l1', phase: 'ready_check',
            players: [{ steamid: '1', name: 'alice' }, { steamid: '2', name: 'bob' }],
            ready: ['1'], options: [], votes: {}, deadline: Date.now() + 30_000, myVote: null,
          },
          match: null,
        }}
        refresh={noop}
      />,
    );
    expect(screen.getByText(/match found/i)).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
  });

  it('shows both rosters once a match exists', () => {
    render(
      <Play
        session={active}
        state={{
          queue: { count: 0, joined: false },
          lobby: null,
          match: {
            id: 1, state: 'live', campaign: 'no_mercy',
            teamA: [{ steamid: '1', name: 'alice' }],
            teamB: [{ steamid: '2', name: 'bob' }],
          },
        }}
        refresh={noop}
      />,
    );
    expect(screen.getByText('No Mercy')).toBeTruthy();
    expect(screen.getByText('Team A')).toBeTruthy();
    expect(screen.getByText('Team B')).toBeTruthy();
  });
});
