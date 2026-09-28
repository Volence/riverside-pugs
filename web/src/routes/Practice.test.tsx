import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { Me, PracticeLease } from '../api';

const { mockApi, mockConfirm } = vi.hoisted(() => ({
  mockApi: { practiceLease: vi.fn(), endPractice: vi.fn() },
  mockConfirm: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});
vi.mock('../components/Confirm', () => ({ confirm: mockConfirm }));

const { Practice } = await import('./Practice');
const { ApiError } = await import('../api');

const ACTIVE = { kind: 'active' as const, me: { steamid: '76561199000000001' } as Me };

function lease(over: Partial<PracticeLease> = {}): PracticeLease {
  return {
    id: 4, kind: 'drill', server: 'Riverside #4',
    owner: { steamid: '76561199000000001', name: 'mayhem' },
    isOwner: true, canEnd: true, drillCode: 'K7QX',
    createdAt: new Date().toISOString(), readyAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 75 * 60_000).toISOString(),
    humans: 2, capacity: null, map: 'l4d_vs_hospital03_sewers', warnedAt: null,
    state: 'ready', endReason: null, endedAt: null,
    connect: { host: '66.59.208.5', port: 27016, password: 'abcd2345' },
    ...over,
  };
}

afterEach(cleanup);
beforeEach(() => { mockApi.practiceLease.mockReset(); mockApi.endPractice.mockReset(); mockConfirm.mockReset(); });

describe('Practice (invite page)', () => {
  it('shows the connect line with the password first, the password on its own, and the drill', async () => {
    mockApi.practiceLease.mockResolvedValue(lease());
    render(<Practice id="4" session={ACTIVE} />);
    expect(await screen.findByText('password abcd2345; connect 66.59.208.5:27016')).toBeTruthy();
    expect(screen.getByText('abcd2345')).toBeTruthy();
    expect(screen.getByText('K7QX')).toBeTruthy();
    expect(screen.getByText('!drill K7QX')).toBeTruthy();
    expect(screen.getByText(/^1h 1[45]m$/)).toBeTruthy();
    expect(mockApi.practiceLease).toHaveBeenCalledWith(4, expect.anything());
  });

  it('gives the drill owner an invite link, and nobody else', async () => {
    mockApi.practiceLease.mockResolvedValue(lease());
    render(<Practice id="4" session={ACTIVE} />);
    expect(await screen.findByText(`${location.origin}/practice/4`)).toBeTruthy();
    cleanup();
    mockApi.practiceLease.mockResolvedValue(lease({ isOwner: false, canEnd: false }));
    render(<Practice id="4" session={ACTIVE} />);
    await screen.findByText('abcd2345');
    expect(screen.queryByText(`${location.origin}/practice/4`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close this server' })).toBeNull();
  });

  it('closes it after asking, and shows the closing state', async () => {
    mockApi.practiceLease.mockResolvedValue(lease());
    mockConfirm.mockResolvedValue(true);
    mockApi.endPractice.mockResolvedValue(lease({ state: 'ending', endReason: 'owner', connect: null, canEnd: false }));
    render(<Practice id="4" session={ACTIVE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close this server' }));
    await waitFor(() => expect(mockApi.endPractice).toHaveBeenCalledWith(4));
    expect(await screen.findByText(/Closing because whoever started it closed it/)).toBeTruthy();
    expect(screen.queryByText('abcd2345')).toBeNull();
  });

  it('a park says it closes when everyone leaves, has no time limit, and no Close for a player', async () => {
    mockApi.practiceLease.mockResolvedValue(lease({ kind: 'park', isOwner: false, canEnd: false, capacity: 8, drillCode: null }));
    render(<Practice id="4" session={ACTIVE} />);
    expect(await screen.findByText('Practice Park, closes 5 minutes after everyone leaves.')).toBeTruthy();
    expect(screen.queryByText('Time left')).toBeNull();
    expect(screen.getByText('Started by')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close this server' })).toBeNull();
    expect(screen.queryByText(`${location.origin}/practice/4`)).toBeNull();
  });

  it('says when a PUG is taking the server back', async () => {
    mockApi.practiceLease.mockResolvedValue(lease({ warnedAt: new Date().toISOString() }));
    render(<Practice id="4" session={ACTIVE} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/A PUG needs this server/);
  });

  it('a closed server says why, with the idle time of its kind, and shows no connect line', async () => {
    mockApi.practiceLease.mockResolvedValue(lease({ state: 'ended', endReason: 'idle', connect: null, canEnd: false }));
    render(<Practice id="4" session={ACTIVE} />);
    expect(await screen.findByText('This practice server closed because nobody was on it for 10 minutes.')).toBeTruthy();
    cleanup();
    mockApi.practiceLease.mockResolvedValue(lease({ kind: 'park', state: 'ended', endReason: 'idle', connect: null, canEnd: false }));
    render(<Practice id="4" session={ACTIVE} />);
    expect(await screen.findByText('This practice server closed because nobody was on it for 5 minutes.')).toBeTruthy();
    expect(screen.queryByText(/connect 66/)).toBeNull();
  });

  it('asks a signed-out visitor to sign in and comes back here', () => {
    render(<Practice id="4" session={{ kind: 'anonymous' }} />);
    const link = screen.getByRole('link', { name: 'Sign in through Steam' });
    expect(link.getAttribute('href')).toBe(`/auth/steam?next=${encodeURIComponent('/practice/4')}`);
    expect(mockApi.practiceLease).not.toHaveBeenCalled();
  });

  it('a bad link says so', async () => {
    mockApi.practiceLease.mockRejectedValue(new ApiError(404, 'GET /api/practice/leases/99 → 404'));
    render(<Practice id="99" session={ACTIVE} />);
    expect((await screen.findByRole('alert')).textContent).toBe('There is no practice server with that link.');
  });
});
