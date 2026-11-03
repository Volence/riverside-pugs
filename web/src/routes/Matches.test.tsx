import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { MatchList, Season } from '../api';

const { mockApi } = vi.hoisted(() => ({ mockApi: { matches: vi.fn(), seasons: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});
const { Matches } = await import('./Matches');

const season = (id: number, name: string, current: boolean): Season => ({
  id, name, current, startedAt: '2026-01-01', endedAt: current ? null : '2026-11-03', matches: 0, ranks: current, theme: null, endsAt: null,
});
const SEASONS = [season(2, 'Season 1: Wrong Way', true), season(1, 'Season 0', false)];

const row = (id: number, seasonId: number): MatchList['matches'][number] => ({
  id, seasonId, campaign: 'no_mercy', endedAt: '2026-11-03 12:00:00', teamAScore: 500, teamBScore: 400, winner: 'a',
  players: { a: [], b: [] },
});
const summary: MatchList['summary'] = {
  matches: 120, campaigns: 7, avgMargin: 88,
  closest: { id: 4, campaign: 'no_mercy', teamAScore: 600, teamBScore: 598 },
  widest: { id: 9, campaign: 'dead_air', teamAScore: 900, teamBScore: 100 },
};

beforeEach(() => {
  window.history.replaceState(null, '', '/matches');
  mockApi.seasons.mockResolvedValue({ seasons: SEASONS });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Matches', () => {
  it('defaults to the current season, offers every season and All, and shows the server summary', async () => {
    mockApi.matches.mockResolvedValue({
      matches: [row(11, 2), row(10, 2)], more: false, summary, season: { id: 2, name: 'Season 1: Wrong Way', current: true },
    });
    const { container } = render(<Matches />);
    const picker = await screen.findByRole('combobox', { name: 'Season' }) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Season 1: Wrong Way (current)', 'Season 0', 'All seasons']);
    expect(mockApi.matches.mock.calls[0][1]).toEqual({});
    await waitFor(() => expect(container.querySelector('.page-head__eyebrow')?.textContent).toBe('Season 1: Wrong Way'));
    // The whole season's count, not the two rows on the page.
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText('900 - 100')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();

    mockApi.matches.mockResolvedValue({ matches: [row(3, 1)], more: false, summary, season: { id: 1, name: 'Season 0', current: false } });
    fireEvent.change(picker, { target: { value: '1' } });
    await waitFor(() => expect(location.search).toBe('?season=1'));
    await waitFor(() => expect(mockApi.matches).toHaveBeenLastCalledWith(expect.anything(), { season: 1 }));
  });

  it('Show more appends the next page by cursor and goes away at the end', async () => {
    mockApi.matches.mockImplementation(async (_s: AbortSignal | undefined, opts: { before?: number }) => (
      opts.before === undefined
        ? { matches: [row(11, 2), row(10, 2)], more: true, summary, season: { id: 2, name: 'Season 1: Wrong Way', current: true } }
        : { matches: [row(9, 2), row(8, 2)], more: false, summary, season: { id: 2, name: 'Season 1: Wrong Way', current: true } }
    ));
    const { container } = render(<Matches />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(container.querySelectorAll('.mlist__row')).toHaveLength(4));
    expect(mockApi.matches).toHaveBeenLastCalledWith(undefined, { before: 10 });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('marks where one season gives way to the next across all seasons', async () => {
    window.history.replaceState(null, '', '/matches?season=all');
    mockApi.matches.mockResolvedValue({ matches: [row(11, 2), row(10, 2), row(9, 1), row(8, 1)], more: false, summary, season: null });
    const { container } = render(<Matches />);
    await waitFor(() => expect(container.querySelectorAll('.mlist__row')).toHaveLength(4));
    expect(mockApi.matches.mock.calls[0][1]).toEqual({ season: 'all' });
    const items = [...container.querySelectorAll('.mlist > li')].map((li) => li.classList.contains('mlist__season') ? li.textContent : 'row');
    expect(items).toEqual(['row', 'row', 'Season 1: Wrong Way starts', 'row', 'row']);
    expect(container.querySelector('.page-head__eyebrow')?.textContent).toBe('All seasons');
    expect((screen.getByRole('combobox', { name: 'Season' }) as HTMLSelectElement).value).toBe('all');
  });
});
