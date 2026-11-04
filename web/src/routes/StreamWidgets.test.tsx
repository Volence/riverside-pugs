import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { WidgetPayload } from '../../../src/widgetTypes';

const { mockApi } = vi.hoisted(() => ({ mockApi: { widget: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});

const { StreamWidgets } = await import('./StreamWidgets');

const ID = '76561198000000001';

const payload = (patch: Partial<WidgetPayload> = {}): WidgetPayload => ({
  serverNow: Date.now(),
  theme: null,
  player: { steamid: ID, name: 'Mox' },
  live: null,
  rating: { sr: 1842, rank: 'Gold II', placing: null, position: 12, wins: 34, losses: 21, todayDelta: 38 },
  session: { since: Date.now(), srDelta: 0, wins: 0, losses: 0 },
  last: null,
  queue: { count: 0, size: 8, inQueue: false },
  ...patch,
});

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockApi.widget.mockReset();
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const pick = (group: string, label: string) =>
  fireEvent.click(within(screen.getByRole('group', { name: group })).getByRole('button', { name: label }));

describe('stream widgets setup', () => {
  it('changing kind and style updates the copied URL', async () => {
    mockApi.widget.mockResolvedValue(payload());
    render(<StreamWidgets steamid={ID} />);
    expect(screen.getByRole('heading', { name: 'Stream widgets' })).toBeTruthy();
    pick('Widget', 'Rating');
    pick('Style', 'Corner');
    const url = `${location.origin}/widget/${ID}/rating?style=corner`;
    expect((screen.getByLabelText('Widget link') as HTMLInputElement).value).toBe(url);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
    await screen.findByRole('button', { name: 'Copied' });
    // Corner at medium: the suggested OBS size follows the preset.
    expect(screen.getByText('Suggested size in OBS: 320 x 100')).toBeTruthy();
  });

  it('style choices follow the kind', () => {
    mockApi.widget.mockResolvedValue(payload());
    render(<StreamWidgets steamid={ID} />);
    pick('Widget', 'Queue');
    const styles = within(screen.getByRole('group', { name: 'Style' })).getAllByRole('button').map((b) => b.textContent);
    expect(styles).toEqual(['Corner', 'Bar']);
    // Corner is the queue's default, so the link carries no style.
    expect((screen.getByLabelText('Widget link') as HTMLInputElement).value).toBe(`${location.origin}/widget/${ID}/queue`);
    // If idle is offered for live and queue only.
    expect(screen.getByRole('group', { name: 'If idle' })).toBeTruthy();
    pick('Widget', 'Rating');
    expect(screen.queryByRole('group', { name: 'If idle' })).toBeNull();
  });

  it('a style the new kind lacks falls back to its default', () => {
    mockApi.widget.mockResolvedValue(payload());
    render(<StreamWidgets steamid={ID} />);
    pick('Style', 'Scoreboard');
    pick('Widget', 'Last match');
    expect(within(screen.getByRole('group', { name: 'Style' })).getByRole('button', { name: 'Card' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Widget link') as HTMLInputElement).value).toBe(`${location.origin}/widget/${ID}/last`);
  });

  it('the preview uses sample data when not in a match', async () => {
    mockApi.widget.mockResolvedValue(payload());
    const { container } = render(<StreamWidgets steamid={ID} />);
    await screen.findByText("Sample: shows your match when you're in one");
    expect(mockApi.widget).toHaveBeenCalledWith(ID, expect.any(Number));
    const teams = container.querySelectorAll('.w-game [data-team]');
    expect(teams).toHaveLength(2);
    // The sample still wears the player's own name.
    expect(teams[0].textContent).toContain('Mox');
  });

  it('the preview shows the real match when there is one', async () => {
    const live = {
      matchId: 9, campaign: 'death_toll', currentMap: 'l4d_vs_smalltown02_drainage', mapsPlayed: 1, mapsTotal: 5,
      mine: { side: 'a' as const, names: ['Mox'], score: 777, mine: true },
      theirs: { side: 'b' as const, names: ['Rex'], score: 555, mine: false },
      maps: [{ ordinal: 0, map: 'l4d_vs_smalltown01_caves', mine: 777, theirs: 555 }],
      halfTime: null, final: false,
    };
    mockApi.widget.mockResolvedValue(payload({ live }));
    const { container } = render(<StreamWidgets steamid={ID} />);
    await waitFor(() => expect(container.querySelector('.w-game')?.textContent).toContain('777'));
    expect(screen.queryByText("Sample: shows your match when you're in one")).toBeNull();
  });

  it('refreshes the preview every 20 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    mockApi.widget.mockResolvedValue(payload());
    render(<StreamWidgets steamid={ID} />);
    await vi.waitFor(() => expect(mockApi.widget).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockApi.widget).toHaveBeenCalledTimes(2);
  });

  it('says what OBS refresh and ?reset=1 do', () => {
    mockApi.widget.mockResolvedValue(payload());
    render(<StreamWidgets steamid={ID} />);
    expect(screen.getByText('Show your Riverside numbers on stream. In OBS: Sources, +, Browser, then paste the link.')).toBeTruthy();
    expect(screen.getByText(/Refresh browser when scene becomes active" is optional/)).toBeTruthy();
    // ?reset=1 belongs to This stream, the one widget with a session count.
    const resetNote = () => screen.queryByText((_, el) => el?.tagName === 'P' && /\?reset=1 on the end/.test(el.textContent ?? ''));
    expect(resetNote()).toBeNull();
    pick('Widget', 'This stream');
    expect(resetNote()?.textContent).toMatch(/new count.*then remove it: while it is in the link, every load starts the count again/);
  });
});
