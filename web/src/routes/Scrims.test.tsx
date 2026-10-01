import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import type { ScrimBoardPost, ScrimOptions } from '../api';

const { mockScrims } = vi.hoisted(() => ({
  mockScrims: {
    options: vi.fn(), board: vi.fn(), create: vi.fn(), withdraw: vi.fn(), accept: vi.fn(),
    withdrawAccept: vi.fn(), decline: vi.fn(), confirm: vi.fn(),
  },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, scrimsApi: mockScrims };
});
const { Scrims } = await import('./Scrims');
const { ApiError } = await import('../api');

const OPTIONS: ScrimOptions = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy', minutes: 70 }, { slug: 'death_toll', name: 'Death Toll', minutes: 60 }],
  limits: { minMinutes: 60, maxMinutes: 180, daysAhead: 14, playlistMax: 4, stepMinutes: 30, noteMax: 200, acceptCampaignsMax: 2 },
  myTeams: [{ id: 1, slug: 'mice', name: 'Mice', tag: 'MM' }],
  teams: [{ id: 1, slug: 'mice', name: 'Mice', tag: 'MM' }, { id: 2, slug: 'rats', name: 'Rats', tag: 'RT' }],
};

const OPEN_POST: ScrimBoardPost = {
  id: 5, status: 'open', side: { kind: 'team', teamId: 2, name: 'Rats', tag: 'RT', slug: 'rats', logoKey: null },
  sr: 1500, srRange: 200, startsAt: '2026-10-02T20:00:00.000Z', minutes: 120,
  campaigns: ['no_mercy'], note: 'gl hf', createdAt: '2026-10-01T10:00:00.000Z', challenge: null,
  acceptCount: 0, mine: false, myAcceptId: null, accepts: null,
};
const MY_POST: ScrimBoardPost = {
  id: 6, status: 'pending', side: { kind: 'team', teamId: 1, name: 'Mice', tag: 'MM', slug: 'mice', logoKey: null },
  sr: 1400, srRange: null, startsAt: '2026-10-03T20:00:00.000Z', minutes: 90,
  campaigns: ['death_toll'], note: '', createdAt: '2026-10-01T09:00:00.000Z', challenge: null,
  acceptCount: 1, mine: true, myAcceptId: null,
  accepts: [{
    id: 42, side: { kind: 'pickup', steamid: 'x9', name: 'p9' }, sr: 1420, fits: true, campaigns: ['no_mercy'], createdAt: '2026-10-01T11:00:00.000Z',
    proposed: { playlist: ['death_toll', 'no_mercy'], minutes: 130, fits: false },
  }],
};

const session = { kind: 'active', me: { steamid: '76561199000000300', name: 'me', avatar: null, status: 'active', isAdmin: false, teams: true } } as never;

const renderScrims = (path = '/scrims') => {
  history.replaceState(null, '', path);
  return render(<LocationProvider><Scrims session={session} /></LocationProvider>);
};

afterEach(() => { cleanup(); for (const f of Object.values(mockScrims)) f.mockReset(); history.replaceState(null, '', '/'); });
beforeEach(() => {
  mockScrims.options.mockResolvedValue(OPTIONS);
  mockScrims.board.mockImplementation((fitsOnly: boolean) => Promise.resolve({ posts: fitsOnly ? [MY_POST] : [OPEN_POST, MY_POST] }));
  mockScrims.accept.mockResolvedValue({ id: 99, sr: 1450, fits: true });
  mockScrims.decline.mockResolvedValue({ postId: 6, reopened: true });
  mockScrims.withdraw.mockResolvedValue({ acceptIds: [] });
  mockScrims.withdrawAccept.mockResolvedValue({ postId: 5, reopened: true });
});

describe('Scrims page', () => {
  it('renders the board and the fit toggle filters it', async () => {
    renderScrims();
    expect(await screen.findByText('Rats')).toBeTruthy();
    expect(screen.getAllByText('Mice').length).toBeGreaterThan(0);
    expect(mockScrims.board).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByLabelText('Fits my SR'));
    await waitFor(() => expect(mockScrims.board).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.queryByText('Rats')).toBeNull());
    expect(screen.getAllByText('Mice').length).toBeGreaterThan(0);
  });

  it('the accept form posts the chosen side and campaigns', async () => {
    renderScrims();
    await screen.findByText('Rats');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    fireEvent.click(screen.getByLabelText('No Mercy (post 5)'));
    fireEvent.click(screen.getByRole('button', { name: 'Send acceptance' }));
    await waitFor(() => expect(mockScrims.accept).toHaveBeenCalledWith(5, 1, ['no_mercy']));
  });

  it('confirm navigates to the booking on success, and shows the nearest slot on no_capacity', async () => {
    mockScrims.confirm.mockResolvedValueOnce({ bookingId: 77 });
    renderScrims();
    await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(location.pathname).toBe('/booking/77'));

    cleanup();
    mockScrims.confirm.mockReset();
    mockScrims.confirm.mockRejectedValueOnce(
      new ApiError(409, 'Not enough servers are free for that time. Try another slot.', '2026-10-03T19:00:00.000Z'),
    );
    renderScrims();
    await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Not enough servers are free/)).toBeTruthy();
    expect(screen.getByText(/Nearest free slot:/)).toBeTruthy();
  });

  it('?post= scrolls to and highlights that post, leaving the rest unhighlighted', async () => {
    const { container } = renderScrims('/scrims?post=5');
    await screen.findByText('Rats');
    const row = container.querySelector('#scrim-5');
    expect(row?.className).toContain('scrimrow--highlight');
    const other = container.querySelector('#scrim-6');
    expect(other?.className).not.toContain('scrimrow--highlight');
  });
});
