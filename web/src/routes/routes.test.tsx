import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/preact';
import { StatTable } from '../components/StatTable';
import type { StatDef } from '../api';
import { roundsMessage } from './MatchDetail';
import type { MatchDetail } from '../api';

/* Deliberately shallow. These assert that each route reaches its loaded state
 * and puts the right data on screen, not how it is marked up, so a design
 * change does not break the suite. The logic worth testing properly lives in
 * format.ts and useFetch.ts, which have their own tests. */

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    leaderboard: vi.fn(),
    matches: vi.fn(),
    match: vi.fn(),
    map: vi.fn(),
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
const { MapDetail } = await import('./MapDetail');
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
    // Appears twice now: in the summary tiles and in the table row.
    await waitFor(() => expect(screen.getAllByText('Blood Harvest').length).toBeGreaterThan(0));
    expect(screen.getByText('Team A')).toBeTruthy();
    // The tile row is derived from the same fetch, so it must render too.
    expect(screen.getByText('Matches')).toBeTruthy();
  });
});

describe('MatchDetail', () => {
  it('renders match totals plus a per-map section with that map own stats', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{
        ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300,
        stats: { '1': { ck: 2, sidmg: 10 }, '2': { ck: 3, sidmg: 20 } },
      }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
        { steamid: '2', name: 'bob', team: 'b', siDamage: 20, siKills: 2, commonKills: 3, ffDealt: 4, revives: 5, srDelta: -12 },
      ],
      demos: [],
      events: [],
    });
    const { container } = render(<MatchDetail id="7" me="1" />);
    // The map name now sits in a heading alongside its score, so match on the
    // heading rather than on the bare name.
    await waitFor(() => expect(
      screen.getByText((_t, el) => el?.tagName === 'H3'
        && /Map 1 · l4d_hospital01_apartment/.test(el.textContent ?? '')),
    ).toBeTruthy());
    expect(screen.getByText('Match totals')).toBeTruthy();
    // Totals table and the map table both render both teams.
    expect(screen.getAllByText('Team A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Team B').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('table').length).toBe(2);
  });

  it('says so rather than faking zeros when a match has no per-map stats', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300, stats: {} }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
      ],
      demos: [], events: [],
    });
    render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(
      screen.getByText('Per-map stats were not captured for this match.'),
    ).toBeTruthy());
  });

  it('shows a not-found message instead of blowing up on a bad id', async () => {
    mockApi.match.mockRejectedValue(new Error('404'));
    render(<MatchDetail id="999" me={null} />);
    await waitFor(() => expect(screen.getByText(/match not found/i)).toBeTruthy());
  });

  it('says round data was not captured when rounds is an empty array', async () => {
    // Empty is not the same as "this match had no rounds" (Task 6 brief): it
    // means round capture did not exist yet, and must not render as a table.
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300, stats: {} }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
      ],
      demos: [], events: [], rounds: [],
    });
    render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(
      screen.getByText('Round data was not captured for this match.'),
    ).toBeTruthy());
  });

  it('renders a reliable round with a per-half score and stat table', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300, stats: {} }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
        { steamid: '2', name: 'bob', team: 'b', siDamage: 20, siKills: 2, commonKills: 3, ffDealt: 4, revives: 5, srDelta: -12 },
      ],
      demos: [], events: [],
      rounds: [{
        ordinal: 0, half: 1, survTeam: 'a', score: 300,
        endedAt: '2026-09-06 04:00', reliable: true,
        byPlayer: { '1': { ck: 5, sidmg: 0 }, '2': { sidmg: 40 } },
      }],
    });
    const { container } = render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(
      screen.getByText((_t, el) => el?.tagName === 'H4'
        && /Half 1/.test(el.textContent ?? '') && /300/.test(el.textContent ?? '')),
    ).toBeTruthy());
    // The round's own table renders both teams' players, in addition to the
    // match totals table (the per-map table is absent here since this match
    // has no per-map stats captured, per the mocked map's empty `stats`).
    expect(container.querySelectorAll('table').length).toBe(2);
  });

  it('shows an unreliable round as unavailable rather than guessing its attribution', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300, stats: {} }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
        { steamid: '2', name: 'bob', team: 'b', siDamage: 20, siKills: 2, commonKills: 3, ffDealt: 4, revives: 5, srDelta: -12 },
      ],
      demos: [], events: [],
      rounds: [{
        ordinal: 0, half: 1, survTeam: 'a', score: 300,
        endedAt: '2026-09-06 04:00', reliable: false, byPlayer: {},
      }],
    });
    const { container } = render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(
      screen.getByText('Attribution for this round is unreliable and is not shown.'),
    ).toBeTruthy());
    // No stat table for the unreliable round, and no per-map table either
    // (this match has no per-map stats captured): just the match totals.
    expect(container.querySelectorAll('table').length).toBe(1);
  });

  it('shows a round score as unavailable, not the stored 0, when the end message never arrived', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300, stats: {} }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
        { steamid: '2', name: 'bob', team: 'b', siDamage: 20, siKills: 2, commonKills: 3, ffDealt: 4, revives: 5, srDelta: -12 },
      ],
      demos: [], events: [],
      rounds: [{
        // The score column defaults to 0 in the database when the end-of-round
        // message never arrived; endedAt null is the only reliable signal.
        ordinal: 0, half: 1, survTeam: 'a', score: 0,
        endedAt: null, reliable: true, byPlayer: {},
      }],
    });
    render(<MatchDetail id="7" me="1" />);
    const heading = await screen.findByText((_t, el) => el?.tagName === 'H4'
      && /Half 1/.test(el.textContent ?? ''));
    expect(within(heading as HTMLElement).getByText('n/a')).toBeTruthy();
    expect(within(heading as HTMLElement).queryByText('0')).toBeNull();
  });
});

const round = (over: Partial<MatchDetail['rounds'][number]> = {}) => ({
  ordinal: 0, half: 1, survTeam: 'a' as const, score: 300,
  endedAt: '2026-09-11 12:00', reliable: true, byPlayer: {}, ...over,
});

describe('roundsMessage', () => {
  it('explains that an empty array means rounds were never captured', () => {
    // Empty means "this match predates round capture", which is NOT the same
    // as "this match had no rounds". It must never render as an empty table.
    expect(roundsMessage([])).toBe('Round data was not captured for this match.');
  });

  it('returns null when there is something to show', () => {
    expect(roundsMessage([round()])).toBeNull();
  });

  it('still returns null when the only round is unreliable', () => {
    // The section renders; the unreliable round inside it is what gets
    // suppressed, with its own note. Handled per round, not for the section.
    expect(roundsMessage([round({ reliable: false })])).toBeNull();
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

describe('skill stats display', () => {
  it('renders skill stat columns on the match page', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300 }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12,
          stats: { skeets: 2, deadstops: 1, tank_damage: 1699 } },
        { steamid: '2', name: 'bob', team: 'b', siDamage: 20, siKills: 2, commonKills: 3, ffDealt: 4, revives: 5, srDelta: -12,
          stats: {} },
      ],
    });
    render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(screen.getAllByText('Skeets').length).toBeGreaterThan(0));
    // Appears twice: alice's own row, and the team total row (the match totals
    // table now shows one, per task 5), since alice is the only source of it.
    expect(screen.getAllByText('1699')).toHaveLength(2);
  });

  it('renders an absent stat as n/a, not a fabricated 0, while a present zero still shows 0', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 9, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300 }],
      players: [
        // alice is the viewer; her self-only stat is present and genuinely 0.
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12,
          stats: { times_skeeted: 0 } },
        // bob is not the viewer, so the server stripped times_skeeted from his
        // row entirely; it must not render as if he were skeeted zero times.
        { steamid: '2', name: 'bob', team: 'b', siDamage: 20, siKills: 2, commonKills: 3, ffDealt: 4, revives: 5, srDelta: -12,
          stats: {} },
      ],
    });
    const { container } = render(<MatchDetail id="9" me="1" />);
    await waitFor(() => expect(screen.getAllByText('Times skeeted').length).toBeGreaterThan(0));
    const bobRow = container.querySelector('tr:has(a[href="/player/2"])') as HTMLElement;
    expect(within(bobRow).getByText('n/a')).toBeTruthy();
    expect(within(bobRow).queryByText('0')).toBeNull();
    const aliceRow = container.querySelector('tr:has(a[href="/player/1"])') as HTMLElement;
    expect(within(aliceRow).getByText('0')).toBeTruthy();
  });

  it('does not add skill columns for a match with no skill stats', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 8, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300 }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12, stats: {} },
      ],
    });
    render(<MatchDetail id="8" me="1" />);
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy());
    expect(screen.queryByText('Skeets')).toBeNull();
  });

  it('shows the private panel only when privateStatTotals is present', async () => {
    mockApi.profile.mockResolvedValue({
      player: { steamid: '1', name: 'alice', avatar: null, createdAt: '2026-01-01T00:00:00' },
      rating: { sr: 1500, mu: 25, sigma: 5, wins: 3, losses: 1 },
      totals: { games: 4, siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4 },
      matches: [],
      history: [],
      statTotals: { skeets: 12 },
      privateStatTotals: { times_skeeted: 7 },
      statDefs: [],
    });
    render(<Profile steamid="1" />);
    await waitFor(() => expect(screen.getByText('Times skeeted')).toBeTruthy());
  });

  it('hides the private panel when privateStatTotals is null', async () => {
    mockApi.profile.mockResolvedValue({
      player: { steamid: '2', name: 'bob', avatar: null, createdAt: '2026-01-01T00:00:00' },
      rating: { sr: 1500, mu: 25, sigma: 5, wins: 3, losses: 1 },
      totals: { games: 4, siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4 },
      matches: [],
      history: [],
      statTotals: { skeets: 12 },
      privateStatTotals: null,
      statDefs: [],
    });
    render(<Profile steamid="2" />);
    await waitFor(() => expect(screen.getByText('bob')).toBeTruthy());
    expect(screen.queryByText('Times skeeted')).toBeNull();
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

describe('Leaderboard sorting', () => {
  const rows = [
    { steamid: '1', name: 'alice', avatar: null, sr: 900, wins: 1, losses: 3, games: 4, stats: { ck: 10, tank_damage: 500 } },
    { steamid: '2', name: 'bob', avatar: null, sr: 1200, wins: 3, losses: 1, games: 4, stats: { ck: 99 } },
  ];

  it('defaults to SR descending and renders every stat column', async () => {
    mockApi.leaderboard.mockResolvedValue({ season: { id: 1, name: 'Season 1' }, rows });
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => expect(screen.getByText('bob')).toBeTruthy());

    const names = [...container.querySelectorAll('tbody tr .lb__pcol')].map((c) => c.textContent);
    expect(names).toEqual(['bob', 'alice']);
    // Stat columns are derived from the data, so tank_damage appears even
    // though only one player has it. Scoped to thead: the summary tiles above
    // the table carry the same label.
    const head = container.querySelector('thead') as HTMLElement;
    expect(within(head).getByText('Tank damage')).toBeTruthy();
  });

  it('re-sorts when a column header is clicked', async () => {
    mockApi.leaderboard.mockResolvedValue({ season: { id: 1, name: 'Season 1' }, rows });
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => expect(screen.getByText('bob')).toBeTruthy());

    // Commons descending puts bob first (99 vs 10); clicking again reverses.
    const head = container.querySelector('thead') as HTMLElement;
    (within(head).getByText('Commons') as HTMLElement).click();
    await waitFor(() => expect(
      [...container.querySelectorAll('tbody tr .lb__pcol')].map((c) => c.textContent),
    ).toEqual(['bob', 'alice']));

    (within(head).getByText('Commons') as HTMLElement).click();
    await waitFor(() => expect(
      [...container.querySelectorAll('tbody tr .lb__pcol')].map((c) => c.textContent),
    ).toEqual(['alice', 'bob']));
  });

  it('sorts a player with the stat absent LAST, not as a zero', async () => {
    // alice has no tank_damage at all. Ascending by tank_damage must not put
    // her first as though she had scored 0.
    mockApi.leaderboard.mockResolvedValue({ season: { id: 1, name: 'Season 1' }, rows });
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => expect(screen.getByText('bob')).toBeTruthy());

    const head = container.querySelector('thead') as HTMLElement;
    (within(head).getByText('Tank damage') as HTMLElement).click(); // desc
    (within(head).getByText('Tank damage') as HTMLElement).click(); // asc
    await waitFor(() => expect(
      [...container.querySelectorAll('tbody tr .lb__pcol')].map((c) => c.textContent),
    ).toEqual(['alice', 'bob']));
  });
});

describe('MapDetail', () => {
  const mapData = {
    map: 'l4d_vs_airport01_greenhouse',
    played: 3,
    avgTeamA: 200,
    avgTeamB: 180,
    players: [
      { steamid: '1', name: 'alice', games: 3, wins: 3, losses: 0, stats: { ck: 30, tank_damage: 900 } },
      { steamid: '2', name: 'bob', games: 3, wins: 0, losses: 3, stats: { ck: 10 } },
    ],
  };

  it('shows the map summary and a win-rate bar per player', async () => {
    mockApi.map.mockResolvedValue(mapData);
    const { container } = render(<MapDetail map="l4d_vs_airport01_greenhouse" />);
    await waitFor(() => expect(screen.getByText('Compare')).toBeTruthy());

    expect(screen.getByText('200 - 180')).toBeTruthy();
    // One bar per player, and the 100% winner is toned as good.
    expect(container.querySelectorAll('.bar').length).toBe(2);
    expect(container.querySelector('.bar__value--good')).toBeTruthy();
    expect(container.querySelector('.bar__value--bad')).toBeTruthy();
  });

  it('switches the bars to a stat when its tab is picked', async () => {
    mockApi.map.mockResolvedValue(mapData);
    const { container } = render(<MapDetail map="l4d_vs_airport01_greenhouse" />);
    await waitFor(() => expect(screen.getByText('Compare')).toBeTruthy());

    // Scoped to the tab strip: the table below carries the same column label.
    const strip = container.querySelector('.tabs') as HTMLElement;
    (within(strip).getByText('Tank damage') as HTMLElement).click();
    await waitFor(() => expect(
      [...container.querySelectorAll('.bar__value')].map((e) => e.textContent),
    ).toEqual(['900', 'n/a']));
  });

  it('says so rather than erroring for a map nobody has played', async () => {
    mockApi.map.mockRejectedValue(new Error('404'));
    render(<MapDetail map="nope" />);
    await waitFor(() => expect(screen.getByText('Nobody has played that map yet.')).toBeTruthy());
  });
});

const markDefs = [
  { key: 'skeets', side: 'survivor', visibility: 'public', label: 'Skeets',
    needsSkillDetect: true, direction: 'high_good' },
] as unknown as StatDef[];

const markRows = (vals: number[]) => vals.map((v, i) => ({
  steamid: `s${i}`, name: `p${i}`, stats: { skeets: v },
}));

describe('StatTable comparison', () => {
  it('marks the standout cell when given the registry', () => {
    const { container } = render(
      <StatTable teamA={markRows([1, 2])} teamB={markRows([3, 40])}
                 cols={['skeets']} statDefs={markDefs} />,
    );
    expect(container.querySelectorAll('.is-good')).toHaveLength(1);
  });

  it('marks nothing without the registry, so the live page is unchanged', () => {
    const { container } = render(
      <StatTable teamA={markRows([1, 2])} teamB={markRows([3, 40])} cols={['skeets']} />,
    );
    expect(container.querySelectorAll('.is-good')).toHaveLength(0);
  });

  it('renders a team total row per team when asked', () => {
    render(
      <StatTable teamA={markRows([1, 2])} teamB={markRows([3, 4])}
                 cols={['skeets']} showTotals />,
    );
    expect(screen.getAllByText('Team total')).toHaveLength(2);
  });

  it('omits total rows by default', () => {
    render(<StatTable teamA={markRows([1])} teamB={markRows([2])} cols={['skeets']} />);
    expect(screen.queryByText('Team total')).toBeNull();
  });
});
