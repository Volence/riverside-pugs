import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';

const { mockApi, mockCommunity } = vi.hoisted(() => ({
  mockApi: { profile: vi.fn(), endorseState: vi.fn() },
  mockCommunity: { list: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi }, communityApi: { ...actual.communityApi, ...mockCommunity } };
});

const { Profile } = await import('./Profile');

const profile = (teams?: unknown[]) => ({
  player: {
    steamid: '1', name: 'alice', avatar: null, createdAt: '2026-01-01T00:00:00',
    bio: null, pronouns: null, country: null, twitchName: null,
  },
  social: [],
  rating: { sr: 1200, mu: 25, sigma: 8, wins: 3, losses: 1 },
  totals: { games: 4, siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4 },
  matches: [],
  history: [],
  ...(teams ? { teams } : {}),
});

beforeEach(() => {
  for (const fn of [...Object.values(mockApi), ...Object.values(mockCommunity)]) fn.mockReset();
  mockApi.endorseState.mockResolvedValue(null);
  mockCommunity.list.mockResolvedValue({ entries: [], page: 0, pageSize: 24, total: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('team chips on a profile', () => {
  it('shows a chip per team in the header, linking to the team page', async () => {
    mockApi.profile.mockResolvedValue(profile([{ slug: 'rats', name: 'Riverside Rats', tag: 'RR', logoKey: null, role: 'captain' }]));
    render(<Profile steamid="1" />);
    const chip = (await screen.findByText('Riverside Rats')).closest('a') as HTMLAnchorElement;
    expect(chip.getAttribute('href')).toBe('/team/rats');
    expect(chip.closest('.headliner')).toBeTruthy();
    expect(chip.textContent).toContain('Captain');
  });

  it('shows no chips when the server sends none, or a server from before the field', async () => {
    mockApi.profile.mockResolvedValue(profile([]));
    const { container, unmount } = render(<Profile steamid="1" />);
    await screen.findByText('alice');
    expect(container.querySelector('.teamchips')).toBeNull();
    unmount();
    mockApi.profile.mockResolvedValue(profile());
    const second = render(<Profile steamid="1" />);
    await screen.findByText('alice');
    expect(second.container.querySelector('.teamchips')).toBeNull();
  });
});
