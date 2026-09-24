import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { CommunityEntry } from '../api';

const { mockApi, mockCommunity } = vi.hoisted(() => ({
  mockApi: { profile: vi.fn(), endorseState: vi.fn() },
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
  rating: { sr: 1200, mu: 25, sigma: 8, wins: 3, losses: 1 },
  totals: { games: 4, siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4 },
  matches: [],
  history: [],
};
const entry = (id: number, kind: 'hud' | 'crosshair', title: string): CommunityEntry => ({
  id, kind, title, description: '', createdAt: '2026-09-24T01:00:00.000Z',
  author: { steamid: '1', name: 'alice', avatar: null }, likes: 0, likedByMe: false,
  ...(kind === 'hud'
    ? { preset: 'modern', aspect: '16:9', advanced: false, importName: null, previewUrl: `/api/community/files/previews/${'a'.repeat(64)}.png` }
    : { art: { kind: 'built', state: { shape: 'dot' } } }),
});
const page = (entries: CommunityEntry[]) => ({ entries, page: 0, pageSize: 24, total: entries.length });

beforeEach(() => {
  for (const fn of [...Object.values(mockApi), ...Object.values(mockCommunity)]) fn.mockReset();
  mockApi.profile.mockResolvedValue(profile);
  mockApi.endorseState.mockResolvedValue(null);
  // happy-dom has no 2D context; the crosshair card draws nothing here.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the Shared panel on a profile', () => {
  it("shows the player's shared entries as compact cards linking to their pages", async () => {
    mockCommunity.list.mockImplementation(({ kind }: { kind: string }) => Promise.resolve(
      kind === 'hud' ? page([entry(4, 'hud', 'Clean Modern')]) : page([entry(9, 'crosshair', 'Tiny dot')]),
    ));
    render(<Profile steamid="1" />);
    await screen.findByRole('heading', { name: 'Shared' });
    expect(mockCommunity.list).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hud', author: '1' }), expect.anything());
    expect(mockCommunity.list).toHaveBeenCalledWith(expect.objectContaining({ kind: 'crosshair', author: '1' }), expect.anything());
    const links = [...document.querySelectorAll('a.ccard--compact')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/community/4', '/community/9']);
    expect(screen.getByText('Clean Modern')).toBeTruthy();
    expect(screen.getByText('Tiny dot')).toBeTruthy();
  });

  it('has no Shared heading when the player shares nothing', async () => {
    mockCommunity.list.mockResolvedValue(page([]));
    render(<Profile steamid="1" />);
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy());
    await waitFor(() => expect(mockCommunity.list).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('heading', { name: 'Shared' })).toBeNull();
  });

  it('hides the panel when the list fails, and the profile still renders', async () => {
    mockCommunity.list.mockRejectedValue(new Error('down'));
    render(<Profile steamid="1" />);
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy());
    await waitFor(() => expect(mockCommunity.list).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('heading', { name: 'Shared' })).toBeNull();
  });
});
