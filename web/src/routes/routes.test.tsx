import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { StatTable, EventFeed } from '../components/StatTable';
import type { StatDef } from '../api';
import { statGroupStarts } from '../format';
import { initialOrdinal, sideNote } from './MatchDetail';
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
    maps: vi.fn(),
    profile: vi.fn(),
    queue: vi.fn(),
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
const { Maps } = await import('./Maps');
const { Profile } = await import('./Profile');
const { Play, QueuePanel } = await import('./Play');

// Auto-cleanup only runs when vitest exposes globals, which this config does
// not; without it each render stacks another copy in document.body and every
// getByText finds duplicates.
afterEach(cleanup);

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  // Every anonymous render of Play reaches SignIn, which polls this on mount.
  // A sensible default here keeps the other describes from hitting the real
  // network the way "offers Steam sign-in when logged out" did before this
  // mock existed; tests that care about the queue panel override it.
  mockApi.queue.mockResolvedValue({ count: 0, players: [], phase: null });
});

describe('Leaderboard', () => {
  it('renders ranked rows', async () => {
    mockApi.leaderboard.mockResolvedValue({
      season: { id: 1, name: 'Season 1' },
      matchesRated: 4,
      rows: [
        { steamid: '1', name: 'alice', avatar: null, sr: 1200, wins: 3, losses: 1, games: 4, ranked: true },
        { steamid: '2', name: 'bob', avatar: null, sr: 1100, wins: 1, losses: 3, games: 4, ranked: true },
      ],
    });
    render(<Leaderboard me="2" />);
    // alice is also the top-rated headliner (1200 beats bob's 1100), so her
    // name and rating each appear twice: the table row and the side card.
    await waitFor(() => expect(screen.getAllByText('alice')).toHaveLength(2));
    expect(screen.getByText('Season 1')).toBeTruthy();
    expect(screen.getAllByText('1200')).toHaveLength(2);
  });

  it('says so when nobody is rated yet', async () => {
    mockApi.leaderboard.mockResolvedValue({ season: { id: 1, name: 'Season 1' }, matchesRated: 0, rows: [] });
    render(<Leaderboard me={null} />);
    await waitFor(() => expect(screen.getByText(/no rated players/i)).toBeTruthy());
  });

  it('lists players under three games after the ranked ones, as provisional, and reads the rated count from the API', async () => {
    // carol has the highest SR after one game. She is not the leader: her
    // row goes below the ranked group under a "Provisional" eyebrow with no
    // rank number, and the top-rated card ignores her. "Matches rated" is
    // the API's distinct-match count, not the top player's game count.
    mockApi.leaderboard.mockResolvedValue({
      season: { id: 1, name: 'Season 1' },
      matchesRated: 5,
      rows: [
        { steamid: '3', name: 'carol', avatar: null, sr: 1500, wins: 1, losses: 0, games: 1, ranked: false },
        { steamid: '1', name: 'alice', avatar: null, sr: 1200, wins: 3, losses: 1, games: 4, ranked: true },
        { steamid: '2', name: 'bob', avatar: null, sr: 1100, wins: 1, losses: 3, games: 4, ranked: true },
      ],
    });
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => expect(screen.getAllByText('alice')).toHaveLength(2));
    // carol appears once: in the table, not as the headliner.
    expect(screen.getAllByText('carol')).toHaveLength(1);
    const names = [...container.querySelectorAll('tbody tr .lb__pcol')].map((c) => c.textContent);
    expect(names).toEqual(['alice', 'bob', 'carol']);
    expect(screen.getByText(/provisional, under 3 games/i)).toBeTruthy();
    const ranks = [...container.querySelectorAll('tbody td.rank')].map((c) => c.textContent);
    expect(ranks).toEqual(['01', '02', '–']);
    expect(container.querySelector('tbody tr.is-provisional')?.textContent).toMatch(/carol/);
    // The figure reads the API count (5), not max games (4).
    const figure = screen.getByText('Matches rated').parentElement as HTMLElement;
    expect(figure.textContent).toMatch(/5/);
    expect(figure.textContent).not.toMatch(/4/);
  });

  it('shows no top-rated card when nobody is ranked yet', async () => {
    mockApi.leaderboard.mockResolvedValue({
      season: { id: 1, name: 'Season 1' },
      matchesRated: 1,
      rows: [
        { steamid: '3', name: 'carol', avatar: null, sr: 1500, wins: 1, losses: 0, games: 1, ranked: false },
      ],
    });
    render(<Leaderboard me={null} />);
    await waitFor(() => expect(screen.getAllByText('carol')).toHaveLength(1));
    expect(screen.queryByText('Top rated')).toBeNull();
  });

  it('marks the identity columns and the W, L, Win % columns so a phone can pin and hide them', async () => {
    mockApi.leaderboard.mockResolvedValue({
      season: { id: 1, name: 'Season 1' },
      matchesRated: 4,
      rows: [{ steamid: '1', name: 'alice', avatar: null, sr: 1200, wins: 3, losses: 1, games: 4, ranked: true, stats: { skeets: 2 } }],
    });
    const { container } = render(<Leaderboard me={null} />);
    await waitFor(() => expect(container.querySelector('tbody tr')).toBeTruthy());
    // Header and body agree cell for cell, or the sticky offsets would not
    // line up and a hidden column would leave its header behind.
    const headCls = [...container.querySelectorAll('thead th')].map((th) => th.className);
    const bodyCls = [...container.querySelectorAll('tbody td')].map((td) => td.className);
    for (const cls of [headCls, bodyCls]) {
      expect(cls[0]).toMatch(/\blb__rank\b/);
      expect(cls[1]).toMatch(/\blb__pcol\b/);
      expect(cls[2]).toMatch(/\blb__sr\b/);
      expect(cls.filter((c) => /\blb__wl\b/.test(c))).toHaveLength(3);
      expect(cls[3]).toMatch(/\blb__wl\b/);   // W
      expect(cls[4]).toMatch(/\blb__wl\b/);   // L
      expect(cls[5]).not.toMatch(/\blb__wl\b/); // Games stays
      expect(cls[6]).toMatch(/\blb__wl\b/);   // Win %
    }
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

  it('summarises with facts that outlive a single match, not per-match team labels', async () => {
    mockApi.matches.mockResolvedValue({
      matches: [
        { id: 7, campaign: 'blood_harvest', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
        { id: 8, campaign: 'dead_air', endedAt: '2026-09-07T04:00:00', teamAScore: 400, teamBScore: 100, winner: 'a' },
      ],
    });
    render(<Matches />);
    await waitFor(() => expect(screen.getByText('Matches')).toBeTruthy());
    // "Team A" is reassigned every match, so counting wins under it aggregates
    // different people from match to match and means nothing.
    expect(screen.queryByText('Team A wins')).toBeNull();
    expect(screen.queryByText('Team B wins')).toBeNull();
    // Margins of 100 and 300 average to 200.
    expect(screen.getByText('Avg margin')).toBeTruthy();
    expect(screen.getByText('200')).toBeTruthy();
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

  it('shows one map at a time, with a chip row to pick another', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [
        { ordinal: 0, map: 'l4d_vs_farm01_hilltop', teamAScore: 54, teamBScore: 51, stats: { '1': { ck: 2 } } },
        { ordinal: 1, map: 'l4d_vs_farm02_traintunnel', teamAScore: 300, teamBScore: 20, stats: { '1': { ck: 9 } } },
      ],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
      ],
      demos: [], events: [], rounds: [],
    });
    render(<MatchDetail id="7" me="1" />);
    const heading = (re: RegExp) => (_t: string, el: Element | null) =>
      el?.tagName === 'H3' && re.test(el.textContent ?? '');
    await waitFor(() => expect(screen.getByText(heading(/Map 1 · l4d_vs_farm01_hilltop/))).toBeTruthy());
    // One viewer, not one per map: a single round switch on the page.
    expect(screen.getAllByText('Round 1')).toHaveLength(1);
    expect(screen.queryByText(heading(/Map 2 · l4d_vs_farm02_traintunnel/))).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Map 2/ }));
    await waitFor(() => expect(screen.getByText(heading(/Map 2 · l4d_vs_farm02_traintunnel/))).toBeTruthy());
    expect(screen.queryByText(heading(/Map 1 · l4d_vs_farm01_hilltop/))).toBeNull();
    expect(location.hash).toBe('#map-2');
  });

  it('names which team held which side under the map instead of per-half tables', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300, stats: {} }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
      ],
      demos: [], events: [],
      rounds: [
        { ordinal: 0, half: 2, survTeam: 'b', score: 250, endedAt: null, reliable: true, byPlayer: {} },
        { ordinal: 0, half: 1, survTeam: 'a', score: 300, endedAt: '2026-09-06 04:00', reliable: true, byPlayer: {} },
      ],
    });
    const { container } = render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(
      screen.getByText('Half 1: Team A survivors · Half 2: Team B survivors'),
    ).toBeTruthy());
    // Only the match totals table: no per-map stats here, and no round tables any more.
    expect(container.querySelectorAll('table').length).toBe(1);
    expect(screen.queryByText(/Round data was not captured/)).toBeNull();
  });

  it('says "not recorded" for a map whose score cannot be trusted, never 0 - 0', async () => {
    // Match 18 (2026-09-14): the plugin could not attribute two round scores
    // and the dump carried 0 for them. The API flags such a map recorded:
    // false, and the chip and heading must both say so instead of showing a
    // scoreline that never happened.
    mockApi.match.mockResolvedValue({
      match: { id: 18, campaign: 'dead_air', state: 'completed', endedAt: '2026-09-14T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [
        { ordinal: 0, map: 'l4d_vs_airport01_greenhouse', teamAScore: 0, teamBScore: 0, stats: {}, recorded: false },
        { ordinal: 1, map: 'l4d_vs_airport02_offices', teamAScore: 300, teamBScore: 200, stats: {}, recorded: true },
      ],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
      ],
      demos: [], events: [], rounds: [],
    });
    // The chip-row test above leaves #map-2 in the URL; this one must open
    // on map 1 to read its heading.
    history.replaceState(null, '', location.pathname);
    render(<MatchDetail id="18" me="1" />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Map 1/ })).toBeTruthy());
    // Chip and heading for the unrecorded map.
    expect(screen.getByRole('tab', { name: /Map 1/ }).textContent).toMatch(/not recorded/);
    expect(screen.getByRole('tab', { name: /Map 1/ }).textContent).not.toMatch(/0 - 0/);
    const h3 = screen.getByText((_t, el) => el?.tagName === 'H3' && /Map 1 ·/.test(el.textContent ?? ''));
    expect(h3.textContent).toMatch(/not recorded/);
    expect(h3.textContent).not.toMatch(/0 - 0/);
    // The recorded map keeps its scoreline.
    expect(screen.getByRole('tab', { name: /Map 2/ }).textContent).toMatch(/300 - 200/);
  });

  it('still renders its stats when the replay endpoints 404, a map with no replay row', async () => {
    // A map played before recording existed has no match_replays row. The
    // viewer renders its own error state for that; the page must not add a
    // second one, and must not throw getting there.
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300, stats: {} }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12 },
      ],
      demos: [], events: [],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, json: async () => ({ error: 'no such replay' }),
      headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0),
    }));
    try {
      render(<MatchDetail id="7" me="1" />);
      await waitFor(() => expect(screen.getByText('Match totals')).toBeTruthy());
      // The round switch is the page's own markup, not the viewer's, so it
      // renders regardless of whether the viewer itself could load anything.
      expect(screen.getByText('Round 1')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
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
    // history's peak (1200) equals the current rating, so the same number
    // appears twice: the rating hero and the "Peak" stat tile.
    expect(screen.getAllByText('1200')).toHaveLength(2);
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

  it('renders a headline card as present-against-absent when only one team recorded the stat', async () => {
    // sideTotals (matchTotals.ts) needs the registry to know tank_damage is a
    // survivor-side stat; without it the headline card would not appear at
    // all, which is a different bug than the one this pins: that a team with
    // no recorded value reads as "n/a", not as a fabricated 0 to compare
    // against the other team's real number.
    mockApi.match.mockResolvedValue({
      match: { id: 10, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300 }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12,
          stats: { tank_damage: 1699 } },
        { steamid: '2', name: 'bob', team: 'b', siDamage: 20, siKills: 2, commonKills: 3, ffDealt: 4, revives: 5, srDelta: -12,
          stats: {} },
      ],
      statDefs: [
        { key: 'tank_damage', side: 'survivor', visibility: 'public', label: 'Tank damage',
          needsSkillDetect: true, direction: 'high_good' },
      ],
    });
    render(<MatchDetail id="10" me="1" />);
    await waitFor(() => expect(screen.getByText('1699 - n/a')).toBeTruthy());
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
    // Appears twice now: in the versus header roster and in the totals table.
    await waitFor(() => expect(screen.getAllByText('alice')).toHaveLength(2));
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

  // Regression guard. /auth/steam is a backend route, not an SPA route, so
  // preact-iso must NOT intercept the click: it only leaves a same-origin link
  // alone when the target is something other than _self (router.js:45).
  // Without it the router renders its own "No such page" and only a manual
  // refresh reaches the server, which is how sign-in was broken from 2b42626
  // until 2026-09-16 without anyone noticing.
  it('lets the browser navigate to Steam sign-in instead of the SPA router', () => {
    render(<Play session={{ kind: 'anonymous' }} state={null} refresh={noop} />);
    const link = screen.getByText(/sign in through steam/i) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/auth/steam');
    const target = link.getAttribute('target');
    expect(target).toBeTruthy();
    // The exact values preact-iso would still swallow.
    expect(/^(_?self)?$/i.test(target ?? '')).toBe(false);
    // and it must stay in this tab, or the Steam redirect comes back to an
    // orphaned window rather than the page the user started from.
    expect(target).not.toBe('_blank');
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
      <Play session={active} state={{ queue: { count: 3, joined: false, players: [] }, lobby: null, match: null }} refresh={noop} />,
    );
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText(/join queue/i)).toBeTruthy();
  });

  it('shows the ready check with the roster during a ready check', () => {
    render(
      <Play
        session={active}
        state={{
          queue: { count: 8, joined: true, players: [] },
          lobby: {
            id: 'l1', phase: 'ready_check',
            players: [
              { steamid: '1', name: 'alice', avatar: null },
              { steamid: '2', name: 'bob', avatar: null },
            ],
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
          queue: { count: 0, joined: false, players: [] },
          lobby: null,
          match: {
            id: 1, state: 'live', campaign: 'no_mercy',
            teamA: [{ steamid: '1', name: 'alice', avatar: null }],
            teamB: [{ steamid: '2', name: 'bob', avatar: null }],
            connect: null, waitingForServer: false,
          },
        }}
        refresh={noop}
      />,
    );
    expect(screen.getByText('No Mercy')).toBeTruthy();
    expect(screen.getByText('Team A')).toBeTruthy();
    expect(screen.getByText('Team B')).toBeTruthy();
  });

  it('shows the connect panel and an in-progress eyebrow for a live match with connect details', () => {
    render(
      <Play
        session={active}
        state={{
          queue: { count: 0, joined: false, players: [] },
          lobby: null,
          match: {
            id: 1, state: 'live', campaign: 'no_mercy',
            teamA: [{ steamid: '1', name: 'alice', avatar: null }],
            teamB: [{ steamid: '2', name: 'bob', avatar: null }],
            connect: { host: '45.32.199.85', port: 27015, password: 'pug_a1b2c3d4' },
            waitingForServer: false,
          },
        }}
        refresh={noop}
      />,
    );
    expect(screen.getByText(/match in progress/i)).toBeTruthy();
    // Assert on the console line, not the steam:// link: that line is the one
    // path confirmed to actually get a player in, and it is what the panel
    // leads with. Keyed on the password appearing BEFORE the connect.
    expect(
      screen.getByText('password pug_a1b2c3d4; connect 45.32.199.85:27015'),
    ).toBeTruthy();
  });

  // The important one: sv_password makes the connect panel the only door into
  // the server, so it must not render at all until connect is real, no matter
  // what state the match is in.
  it('renders no connect panel when connect is null', () => {
    render(
      <Play
        session={active}
        state={{
          queue: { count: 0, joined: false, players: [] },
          lobby: null,
          match: {
            // 'configuring' is the real pre-live state (db.ts's CHECK
            // constraint: 'configuring' | 'live' | 'completed' | 'aborted').
            // waitingForServer stays false here: a server has been claimed,
            // just not finished setting up yet.
            id: 1, state: 'configuring', campaign: 'no_mercy',
            teamA: [{ steamid: '1', name: 'alice', avatar: null }],
            teamB: [{ steamid: '2', name: 'bob', avatar: null }],
            connect: null, waitingForServer: false,
          },
        }}
        refresh={noop}
      />,
    );
    // No console line and no steam:// link: the panel must not render at all.
    expect(screen.queryByText(/password pug_/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/setting up server/i)).toBeTruthy();
  });

  it('shows the waiting-for-server message and its own eyebrow when waitingForServer is true', () => {
    render(
      <Play
        session={active}
        state={{
          queue: { count: 0, joined: false, players: [] },
          lobby: null,
          match: {
            // The server only ever sets waitingForServer while the match is
            // still configuring (matchmaker.ts), never once it is live, so
            // this fixture uses 'configuring' rather than 'live' to exercise
            // a state the backend can actually produce.
            id: 1, state: 'configuring', campaign: 'no_mercy',
            teamA: [{ steamid: '1', name: 'alice', avatar: null }],
            teamB: [{ steamid: '2', name: 'bob', avatar: null }],
            connect: null, waitingForServer: true,
          },
        }}
        refresh={noop}
      />,
    );
    expect(screen.getByText(/waiting for a server/i)).toBeTruthy();
    expect(screen.getByText(/waiting for a free server/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /join server/i })).toBeNull();
  });

  it('does not show the public queue panel while api.queue() is still pending', () => {
    let resolveQueue: (v: unknown) => void = () => {};
    mockApi.queue.mockReturnValue(new Promise((r) => { resolveQueue = r; }));
    render(<Play session={{ kind: 'anonymous' }} state={null} refresh={noop} />);
    expect(screen.queryByText('Queue')).toBeNull();
    // Settle the promise so it does not leak into the next test.
    resolveQueue({ count: 0, players: [], phase: null });
  });

  it('shows the public queue panel once api.queue() resolves', async () => {
    mockApi.queue.mockResolvedValue({
      count: 1,
      players: [{ steamid: '1', name: 'dizzy', avatar: null }],
      phase: null,
    });
    render(<Play session={{ kind: 'anonymous' }} state={null} refresh={noop} />);
    await waitFor(() => expect(screen.getByText('dizzy')).toBeTruthy());
    expect(screen.getByText('Queue')).toBeTruthy();
  });

  it('shows who is in the queue and keeps the empty slots visible', () => {
    const players = [
      { steamid: '1', name: 'dizzy', avatar: 'http://a/1.jpg' },
      { steamid: '2', name: 'mayhem', avatar: null },
    ];
    render(<QueuePanel count={2} joined={false} players={players} refresh={() => {}} />);

    expect(screen.getByText('dizzy')).toBeTruthy();
    expect(screen.getByText('mayhem')).toBeTruthy();
    expect(document.querySelectorAll('.slot').length).toBe(8);
  });
});

describe('Leaderboard sorting', () => {
  const rows = [
    { steamid: '1', name: 'alice', avatar: null, sr: 900, wins: 1, losses: 3, games: 4, ranked: true, stats: { ck: 10, tank_damage: 500 } },
    { steamid: '2', name: 'bob', avatar: null, sr: 1200, wins: 3, losses: 1, games: 4, ranked: true, stats: { ck: 99 } },
  ];

  it('defaults to SR descending and renders every stat column', async () => {
    mockApi.leaderboard.mockResolvedValue({ season: { id: 1, name: 'Season 1' }, matchesRated: 4, rows });
    const { container } = render(<Leaderboard me={null} />);
    // bob is also the top-rated headliner now, so this appears twice.
    await waitFor(() => expect(screen.getAllByText('bob')).toHaveLength(2));

    const names = [...container.querySelectorAll('tbody tr .lb__pcol')].map((c) => c.textContent);
    expect(names).toEqual(['bob', 'alice']);
    // Stat columns are derived from the data, so tank_damage appears even
    // though only one player has it. Scoped to thead: the summary tiles above
    // the table carry the same label.
    const head = container.querySelector('thead') as HTMLElement;
    expect(within(head).getByText('Tank damage')).toBeTruthy();
  });

  it('re-sorts when a column header is clicked', async () => {
    mockApi.leaderboard.mockResolvedValue({ season: { id: 1, name: 'Season 1' }, matchesRated: 4, rows });
    const { container } = render(<Leaderboard me={null} />);
    // bob is also the top-rated headliner, so this appears twice.
    await waitFor(() => expect(screen.getAllByText('bob')).toHaveLength(2));

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
    mockApi.leaderboard.mockResolvedValue({ season: { id: 1, name: 'Season 1' }, matchesRated: 4, rows });
    const { container } = render(<Leaderboard me={null} />);
    // bob is also the top-rated headliner, so this appears twice.
    await waitFor(() => expect(screen.getAllByText('bob')).toHaveLength(2));

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
    avgScore: 190,
    avgStats: { ck: 6.7, tank_damage: 150 },
    rounds: { attempts: 6, fastestSec: 120, avgSec: 210, slowestSec: 300, survivalPct: 50 },
    players: [
      { steamid: '1', name: 'alice', games: 3, wins: 3, losses: 0,
        stats: { ck: 30, tank_damage: 900 }, avgStats: { ck: 10, tank_damage: 300 } },
      { steamid: '2', name: 'bob', games: 3, wins: 0, losses: 3,
        stats: { ck: 10 }, avgStats: { ck: 3.3 } },
    ],
  };

  it('shows the map summary and a win-rate bar per player', async () => {
    mockApi.map.mockResolvedValue(mapData);
    const { container } = render(<MapDetail map="l4d_vs_airport01_greenhouse" />);
    await waitFor(() => expect(screen.getByText('Compare')).toBeTruthy());

    expect(screen.getByText('190')).toBeTruthy();
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

  it('says "not recorded" for the average when no playing of the map has a real score', async () => {
    mockApi.map.mockResolvedValue({ ...mapData, avgScore: null });
    render(<MapDetail map="l4d_vs_airport01_greenhouse" />);
    await waitFor(() => expect(screen.getByText('Compare')).toBeTruthy());
    expect(screen.getByText('not recorded')).toBeTruthy();
    expect(screen.queryByText(/null/)).toBeNull();
  });

  it('says so rather than erroring for a map nobody has played', async () => {
    mockApi.map.mockRejectedValue(new Error('404'));
    render(<MapDetail map="nope" />);
    await waitFor(() => expect(screen.getByText('Nobody has played that map yet.')).toBeTruthy());
  });

  it('shows per-map averages by default, not career totals', async () => {
    // A total mostly reports who has played the most. What a player usually
    // gets on a map is the number that compares across people.
    mockApi.map.mockResolvedValue(mapData);
    const { container } = render(<MapDetail map="l4d_vs_airport01_greenhouse" />);
    await waitFor(() => expect(screen.getByText('Records on this map')).toBeTruthy());
    const body = container.querySelector('.lb tbody') as HTMLElement;
    expect(within(body).getByText('10')).toBeTruthy();
    expect(within(body).queryByText('30')).toBeNull();
  });

  it('switches the records table to totals when asked', async () => {
    mockApi.map.mockResolvedValue(mapData);
    const { container } = render(<MapDetail map="l4d_vs_airport01_greenhouse" />);
    await waitFor(() => expect(screen.getByText('Records on this map')).toBeTruthy());
    const strip = container.querySelectorAll('.tabs')[1] as HTMLElement;
    (within(strip).getByText('Totals') as HTMLElement).click();
    const body = container.querySelector('.lb tbody') as HTMLElement;
    await waitFor(() => expect(within(body).getByText('30')).toBeTruthy());
  });

  it('carries the map baseline as a footer row', async () => {
    // "What does anyone usually get here", so a player line has something to
    // be read against.
    mockApi.map.mockResolvedValue(mapData);
    const { container } = render(<MapDetail map="l4d_vs_airport01_greenhouse" />);
    await waitFor(() => expect(screen.getByText('Records on this map')).toBeTruthy());
    const foot = container.querySelector('.lb tfoot') as HTMLElement;
    expect(foot).toBeTruthy();
    expect(within(foot).getByText('6.7')).toBeTruthy();
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
    // The same fixture also produces a bad mark, on the column's low end
    // (skeets is high_good, so the fewest skeets is the weak link). An
    // implementation that emitted is-bad unconditionally, or swapped the two
    // marks, would still pass the is-good assertion above.
    const badCells = container.querySelectorAll('.is-bad');
    expect(badCells).toHaveLength(1);
    expect(badCells[0].textContent).toBe('1');
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

  it('shows dashes for a player whose stats were never captured, and leaves them out of marks and totals', () => {
    // The uncaptured row carries values in its bag (the match page derives
    // zeros from the fixed columns), so the only thing that can keep it out
    // of the comparison is the flag.
    const ghost = { steamid: 'g', name: 'ghost', stats: { skeets: 5 }, captured: false };
    const { container } = render(
      <StatTable teamA={markRows([1, 2])} teamB={[...markRows([3, 40]), ghost]}
                 cols={['skeets']} statDefs={markDefs} showTotals />,
    );
    const row = screen.getByText('ghost').closest('tr')!;
    const cells = [...row.querySelectorAll('td.num')];
    expect(cells.map((c) => c.textContent)).toEqual(['–']);
    expect(cells.every((c) => c.classList.contains('is-dim'))).toBe(true);
    expect(row.getAttribute('title')).toMatch(/not captured/);
    // 1 is still the weak link: the ghost's 5 (or a real 0) never competes.
    const badCells = container.querySelectorAll('.is-bad');
    expect(badCells).toHaveLength(1);
    expect(badCells[0].textContent).toBe('1');
    expect(row.querySelector('.is-bad')).toBeNull();
    // Team B totals 43, not 48.
    const totals = screen.getAllByText('Team total').map((el) => el.closest('tr')!.querySelector('td.num')!.textContent);
    expect(totals).toEqual(['3', '43']);
  });
});

describe('MatchDetail uncaptured players', () => {
  const player = (steamid: string, name: string, team: 'a' | 'b', over: Record<string, unknown> = {}) => ({
    steamid, name, team, siDamage: 0, siKills: 0, commonKills: 0, ffDealt: 0, revives: 0, srDelta: 0, stats: {}, ...over,
  });

  it('dashes out a player with no skill stats and nothing in the fixed columns, not one who just has no skill stats', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [],
      players: [
        player('1', 'alice', 'a', { siDamage: 10, commonKills: 2, stats: { skeets: 3 } }),
        // Played before skill_detect: no bag, but the fixed columns are real.
        player('2', 'bob', 'a', { commonKills: 7 }),
        // Never rostered in time: nothing was captured at all.
        player('3', 'carol', 'b'),
      ],
      demos: [],
      events: [],
    });
    render(<MatchDetail id="7" me="1" />);
    // Names also appear in the versus header, so find the table's own link.
    const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr')!;
    await waitFor(() => expect(screen.getByRole('link', { name: 'carol' })).toBeTruthy());
    const carol = rowOf('carol');
    const carolCells = [...carol.querySelectorAll('td.num')].map((c) => c.textContent);
    expect(carolCells.length).toBeGreaterThan(0);
    expect(new Set(carolCells)).toEqual(new Set(['–']));
    expect(carol.getAttribute('title')).toMatch(/not captured/);
    const bob = rowOf('bob');
    expect(bob.getAttribute('title')).toBeNull();
    expect([...bob.querySelectorAll('td.num')].map((c) => c.textContent)).toContain('7');
  });
});

describe('MatchDetail column order', () => {
  const def = (key: string, side: 'survivor' | 'infected'): StatDef =>
    ({ key, side, visibility: 'public', label: key, needsSkillDetect: true, direction: 'high_good' });

  it('groups survivor columns ahead of infected ones instead of interleaving them', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12,
          stats: { crowns: 1, draw_crowns: 2, biles_landed: 3 } },
        { steamid: '2', name: 'bob', team: 'b', siDamage: 20, siKills: 2, commonKills: 3, ffDealt: 4, revives: 5, srDelta: -12,
          stats: { crowns: 1, draw_crowns: 2, biles_landed: 3 } },
      ],
      demos: [],
      events: [],
      statDefs: [def('crowns', 'survivor'), def('draw_crowns', 'survivor'), def('biles_landed', 'infected')],
    });
    const { container } = render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(screen.getAllByText('Crowns').length).toBeGreaterThan(0));

    // Under the old ordering anything outside the curated live list was
    // appended alphabetically, so infected "Biles" sorted ahead of survivor
    // "Draw crowns". Grouping by side must put both survivor columns first.
    const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers.indexOf('Draw crowns')).toBeGreaterThan(-1);
    expect(headers.indexOf('Draw crowns')).toBeLessThan(headers.indexOf('Biles'));
  });

  it('drops columns for stats that cannot happen on L4D1', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12,
          stats: { crowns: 1, skeets_melee: 0, tongue_cuts: 0 } },
      ],
      demos: [],
      events: [],
      statDefs: [def('crowns', 'survivor'), def('skeets_melee', 'survivor'), def('tongue_cuts', 'survivor')],
    });
    const { container } = render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(screen.getAllByText('Crowns').length).toBeGreaterThan(0));

    const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).not.toContain('Melee skeets');
    expect(headers).not.toContain('Tongue cuts');
  });
});

describe('StatTable group dividers', () => {
  const rows = (id: string) => [{ steamid: id, name: 'p' + id, stats: { ck: 1, boomer_pops: 2, crowns: 3 } }];

  it('rules a line before each family, using the grouping the caller passes', () => {
    // boomer_pops and crowns share the live card's single "skill" group, so
    // liveGroupStarts rules a line before boomer_pops only. They are separate
    // families here (a survivor odd-job versus witch work), so crowns must get
    // its own divider. That difference is what this asserts.
    const { container } = render(
      <StatTable teamA={rows('1')} teamB={rows('2')}
                 cols={['ck', 'boomer_pops', 'crowns']}
                 groupStarts={statGroupStarts} />,
    );
    const headers = Array.from(container.querySelectorAll('th'));
    const cls = (label: string) =>
      headers.find((th) => th.textContent === label)?.className ?? '';
    expect(cls('Commons')).not.toContain('is-groupstart');
    expect(cls('Boomer pops')).toContain('is-groupstart');
    expect(cls('Crowns')).toContain('is-groupstart');
  });
});

describe('clear latency surfaces', () => {
  const ce = (seq: number, kind: string, actor: string, target: string | null, tMs: number) => ({
    seq, kind, mapOrdinal: 0, half: 1, tMs,
    actor: { steamid: actor, name: actor, avatar: null },
    target: target ? { steamid: target, name: target, avatar: null } : null,
    value: 0,
  });

  it('annotates a cleared row in the feed with how long it took', () => {
    const { container } = render(
      <EventFeed
        events={[ce(2, 'cleared', 'mal', 'zoey', 1910), ce(1, 'pinned', 'tami', 'zoey', 1000)]}
        maps={[{ ordinal: 0, map: 'l4d_hospital01_apartment' }]}
      />,
    );
    expect(container.textContent).toContain('cleared zoey from tami after 0.9 seconds');
    expect(container.textContent).not.toMatch(/\d\.\ds\b/);
  });

  it('reads a spawn as its class, not "spawned as for 3"', () => {
    const { container } = render(
      <EventFeed events={[{ ...ce(1, 'si_spawn', 'tami', null, 1000), value: 3 }]} maps={[]} />,
    );
    expect(container.textContent).toContain('spawned as hunter');
    expect(container.textContent).not.toContain('for 3');
  });

  it('says who a clear freed the victim from, what class downed someone, and how a pin ended', () => {
    const { container } = render(
      <EventFeed
        events={[
          ce(5, 'incap', 'zoey', 'tami', 9000),
          ce(4, 'cleared', 'mal', 'zoey', 5200),
          ce(3, 'pinned', 'tami', 'zoey', 1000),
          { ...ce(1, 'si_spawn', 'tami', null, 500), value: 1 },
        ]}
        maps={[]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('from tami after 4.2 seconds');
    expect(text).toContain('for 4.2 seconds, cleared by mal');
    expect(text).toContain('(smoker)');
  });

  it('leaves a clear with no pairable pin unannotated rather than guessing', () => {
    const { container } = render(
      <EventFeed events={[ce(1, 'cleared', 'mal', null, 1910)]} maps={[]} />,
    );
    // Nothing to pair with, so no "from" and no duration may be invented.
    expect(container.querySelector('.feed__detail')).toBeNull();
    expect(container.textContent).not.toContain('seconds');
  });

  it('shows a clear latency panel on the match page', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 0, siKills: 0, commonKills: 0, ffDealt: 0, revives: 0, srDelta: 0, stats: {} },
      ],
      demos: [],
      statDefs: [],
      events: [ce(2, 'cleared', '1', 'zoey', 1910), ce(1, 'pinned', 'tami', 'zoey', 1000)],
    });
    render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(screen.getByText('Clear latency')).toBeTruthy());
    // The feed shows the same number, so scope to the panel to prove it is the
    // panel rendering the row and not the feed being found twice.
    const panel = screen.getByText('Clear latency').closest('.panel') as HTMLElement;
    expect(within(panel).getByText('0.9s')).toBeTruthy();
    expect(within(panel).getByText('alice')).toBeTruthy();
  });
});

describe('sideNote', () => {
  const round = (over: Partial<MatchDetail['rounds'][number]> = {}) => ({
    ordinal: 0, half: 1, survTeam: 'a' as const, score: 300,
    endedAt: '2026-09-11 12:00', reliable: true, byPlayer: {}, ...over,
  });

  it('is null with no rounds, and null when the only round is unreliable', () => {
    expect(sideNote([], 0)).toBeNull();
    expect(sideNote([round({ reliable: false })], 0)).toBeNull();
  });

  it('lists the halves in order for the asked map only', () => {
    expect(sideNote([
      round({ ordinal: 1, half: 1, survTeam: 'b' }),
      round({ half: 2, survTeam: 'b' }),
      round({ half: 1, survTeam: 'a' }),
    ], 0)).toBe('Half 1: Team A survivors · Half 2: Team B survivors');
  });
});

describe('initialOrdinal', () => {
  const maps = [{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 3 }];
  it('opens on the first map without a hash, and on the hashed map when it exists', () => {
    expect(initialOrdinal(maps, '')).toBe(0);
    expect(initialOrdinal(maps, '#map-2')).toBe(1);
    expect(initialOrdinal(maps, '#map-4')).toBe(3);
  });
  it('falls back to the first map for a hash that names no map, and null with no maps', () => {
    expect(initialOrdinal(maps, '#map-3')).toBe(0);
    expect(initialOrdinal(maps, '#other')).toBe(0);
    expect(initialOrdinal([], '#map-1')).toBeNull();
  });
});

describe('Maps', () => {
  it('lists averages, and says "not recorded" for a map with no recorded score', async () => {
    mockApi.maps.mockResolvedValue({
      maps: [
        { map: 'l4d_vs_airport01_greenhouse', campaign: 'dead_air', played: 2, avgScore: 200,
          rounds: { attempts: 4, fastestSec: 120, avgSec: 210, slowestSec: 300, survivalPct: 50 } },
        { map: 'l4d_vs_airport02_offices', campaign: 'dead_air', played: 1, avgScore: null,
          rounds: { attempts: 0, fastestSec: null, avgSec: null, slowestSec: null, survivalPct: null } },
      ],
    });
    render(<Maps />);
    await waitFor(() => expect(screen.getByText('l4d_vs_airport02_offices')).toBeTruthy());
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByText('not recorded')).toBeTruthy();
    expect(screen.queryByText(/null/)).toBeNull();
  });
});
