import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import type { BlockEntry, ScrimBoardPost, ScrimOptions } from '../api';

const { mockScrims, mockTeams } = vi.hoisted(() => ({
  mockScrims: {
    options: vi.fn(), board: vi.fn(), create: vi.fn(), withdraw: vi.fn(), accept: vi.fn(),
    withdrawAccept: vi.fn(), decline: vi.fn(), confirm: vi.fn(),
    blocks: vi.fn(), block: vi.fn(), unblock: vi.fn(),
  },
  mockTeams: { search: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, scrimsApi: mockScrims, teamsApi: { ...actual.teamsApi, ...mockTeams } };
});
const { Scrims } = await import('./Scrims');
const { ApiError } = await import('../api');

const OPTIONS: ScrimOptions = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy', minutes: 70 }, { slug: 'death_toll', name: 'Death Toll', minutes: 45 }],
  limits: { daysAhead: 14, playlistMax: 4, noteMax: 200, acceptCampaignsMax: 2 },
  estimate: { perCampaign: { no_mercy: 70, death_toll: 45 }, base: 15, slack: 10, step: 30, min: 60 },
  myTeams: [{ id: 1, slug: 'mice', name: 'Mice', tag: 'MM' }],
  teams: [{ id: 1, slug: 'mice', name: 'Mice', tag: 'MM' }, { id: 2, slug: 'rats', name: 'Rats', tag: 'RT' }],
  showSr: false,
};

const OPEN_POST: ScrimBoardPost = {
  id: 5, status: 'open', side: { kind: 'team', teamId: 2, name: 'Rats', tag: 'RT', slug: 'rats', logoKey: null },
  sr: 1500, srRange: 200, startsAt: '2026-10-02T20:00:00.000Z', minutes: 120,
  campaigns: ['no_mercy'], campaignCount: 1, note: 'gl hf', createdAt: '2026-10-01T10:00:00.000Z', challenge: null,
  acceptCount: 0, night: false, mine: false, myAcceptId: null, accepts: null,
};
const MY_POST: ScrimBoardPost = {
  id: 6, status: 'pending', side: { kind: 'team', teamId: 1, name: 'Mice', tag: 'MM', slug: 'mice', logoKey: null },
  sr: 1400, srRange: null, startsAt: '2026-10-03T20:00:00.000Z', minutes: 90,
  campaigns: ['death_toll'], campaignCount: 1, note: '', createdAt: '2026-10-01T09:00:00.000Z', challenge: null,
  acceptCount: 1, night: false, mine: true, myAcceptId: null,
  accepts: [{
    id: 42, side: { kind: 'pickup', steamid: 'x9', name: 'p9' }, sr: 1420, fits: true, campaigns: ['no_mercy'], createdAt: '2026-10-01T11:00:00.000Z',
    proposed: { playlist: ['death_toll', 'no_mercy'], minutes: 150 },
  }],
};

const session = { kind: 'active', me: { steamid: '76561199000000300', name: 'me', avatar: null, status: 'active', isAdmin: false, teams: true } } as never;

const renderScrims = (path = '/scrims') => {
  history.replaceState(null, '', path);
  return render(<LocationProvider><Scrims session={session} /></LocationProvider>);
};

afterEach(() => {
  cleanup();
  for (const f of Object.values(mockScrims)) f.mockReset();
  for (const f of Object.values(mockTeams)) f.mockReset();
  history.replaceState(null, '', '/');
});
beforeEach(() => {
  mockScrims.options.mockResolvedValue(OPTIONS);
  mockScrims.board.mockResolvedValue({ posts: [OPEN_POST, MY_POST], night: null, showSr: false });
  mockScrims.accept.mockResolvedValue({ id: 99, sr: 1450, fits: true });
  mockScrims.decline.mockResolvedValue({ postId: 6, reopened: true });
  mockScrims.withdraw.mockResolvedValue({ acceptIds: [] });
  mockScrims.withdrawAccept.mockResolvedValue({ postId: 5, reopened: true });
  mockScrims.blocks.mockResolvedValue({ blocks: [] });
  mockScrims.block.mockResolvedValue({ added: true });
  mockScrims.unblock.mockResolvedValue({ removed: true });
  mockTeams.search.mockResolvedValue({ players: [] });
});

describe('Scrims page', () => {
  it('with scrim_show_sr on: the SR range, the fit filter, SR on rows and the fit chip on offers', async () => {
    mockScrims.options.mockResolvedValue({ ...OPTIONS, showSr: true });
    mockScrims.board.mockImplementation((fitsOnly: boolean) =>
      Promise.resolve({ posts: fitsOnly ? [MY_POST] : [OPEN_POST, MY_POST], night: null, showSr: true }));
    renderScrims();
    await screen.findByText('Rats');
    expect(document.querySelector('#scrim-5 .scrimcard__meta')?.textContent).toBe('1 campaign · about 2 h · SR 1500 (± 200)');
    expect(document.querySelector('#scrim-6 .scrimcard__meta')?.textContent).toBe('1 campaign · about 1 h 30 · SR 1400 (Open)');
    expect(screen.getByText('SR 1420 · fits')).toBeTruthy();

    fireEvent.input(screen.getByLabelText('Start'), { target: { value: '2026-10-02T20:00' } });
    fireEvent.click(screen.getByLabelText('No Mercy'));
    fireEvent.change(screen.getByLabelText('SR range'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post the scrim' }));
    await waitFor(() => expect(mockScrims.create).toHaveBeenCalled());
    expect(mockScrims.create.mock.calls[0][0].srRange).toBe(200);

    fireEvent.click(screen.getByLabelText('Fits my SR'));
    await waitFor(() => expect(mockScrims.board).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.queryByText('Rats')).toBeNull());
    expect(screen.getAllByText('Mice').length).toBeGreaterThan(0);
  });

  it('renders the board unfiltered, with no SR fit toggle', async () => {
    renderScrims();
    expect(await screen.findByText('Rats')).toBeTruthy();
    expect(screen.getAllByText('Mice').length).toBeGreaterThan(0);
    expect(mockScrims.board).toHaveBeenCalledWith(false);
    expect(mockScrims.board).not.toHaveBeenCalledWith(true);
    expect(screen.queryByLabelText('Fits my SR')).toBeNull();
  });

  it('with scrim_show_sr off, shows no SR anywhere: not on rows, offers, the post form or the board', async () => {
    const { container } = renderScrims();
    await screen.findByText('Rats');
    await screen.findByRole('heading', { name: 'Post a scrim' });
    await screen.findByRole('button', { name: 'Confirm' });
    expect(container.textContent).not.toMatch(/\bSR\b/);
    expect(screen.queryByLabelText('SR range')).toBeNull();
    for (const el of container.querySelectorAll('[aria-label]')) expect(el.getAttribute('aria-label')).not.toMatch(/\bSR\b/);
  });

  it('with scrim_show_sr off, the post form never sends an SR range', async () => {
    renderScrims();
    await screen.findByRole('heading', { name: 'Post a scrim' });
    fireEvent.input(screen.getByLabelText('Start'), { target: { value: '2026-10-02T20:00' } });
    fireEvent.click(screen.getByLabelText('No Mercy'));
    fireEvent.click(screen.getByRole('button', { name: 'Post the scrim' }));
    await waitFor(() => expect(mockScrims.create).toHaveBeenCalled());
    expect('srRange' in mockScrims.create.mock.calls[0][0]).toBe(false);
  });

  it('the accept form posts the chosen side and campaigns', async () => {
    renderScrims();
    await screen.findByText('Rats');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    fireEvent.click(screen.getByLabelText('No Mercy (post 5)'));
    fireEvent.click(screen.getByRole('button', { name: 'Send acceptance' }));
    await waitFor(() => expect(mockScrims.accept).toHaveBeenCalledWith(5, 1, ['no_mercy']));
  });

  it('a row leads with the side and start time, lists its campaigns in order, then the count and estimate', async () => {
    renderScrims();
    await screen.findByText('Rats');
    const row = document.querySelector('#scrim-5')!;
    const head = row.querySelector('.scrimcard__head')!;
    expect(head.textContent).toContain('Rats');
    expect(head.querySelector('time')?.getAttribute('datetime')).toBe(OPEN_POST.startsAt);
    const items = [...row.querySelectorAll('ol.scrimcard__list > li')].map((li) => li.textContent);
    expect(items).toEqual(['No Mercy']);
    expect(row.querySelector('.scrimcard__meta')?.textContent).toBe('1 campaign · about 2 h');
  });

  it('an offer shows the proposed playlist as the same numbered list, with Confirm and Decline', async () => {
    renderScrims();
    const list = await screen.findByRole('list', { name: 'Proposed playlist (offer 42)' });
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Death Toll', 'No Mercy']);
    const offer = list.closest('li')!;
    expect(offer.querySelector('.scrimcard__head')?.textContent).toContain('p9');
    expect(offer.querySelector('.scrimcard__meta')?.textContent).toBe('Proposed · 2 campaigns · about 2 h 30');
    expect(offer.querySelector('button')?.textContent).toBe('Confirm');
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
  });

  it('the accept form estimate grows with the accepter\'s campaigns', async () => {
    renderScrims();
    await screen.findByText('Rats');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(screen.getByText('About 1 h 10 of play for 1 campaign. The server is held for up to 2 h and closes when you finish.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Death Toll (post 5)'));
    expect(screen.getByText('About 1 h 55 of play for 2 campaigns. The server is held for up to 2 h 30 and closes when you finish.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send acceptance' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the post form has no length picker and shows the estimate', async () => {
    renderScrims();
    await screen.findByRole('heading', { name: 'Post a scrim' });
    const form = screen.getByRole('button', { name: 'Post the scrim' }).closest('form')!;
    expect(form.querySelector('[aria-label="Length"]')).toBeNull();
    fireEvent.input(screen.getByLabelText('Start'), { target: { value: '2026-10-02T20:00' } });
    fireEvent.click(screen.getByLabelText('No Mercy'));
    expect(screen.getByText('About 1 h 10 of play for 1 campaign. The server is held for up to 2 h and closes when you finish.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Death Toll'));
    expect(screen.getByText('About 1 h 55 of play for 2 campaigns. The server is held for up to 2 h 30 and closes when you finish.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Post the scrim' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Post the scrim' }));
    await waitFor(() => expect(mockScrims.create).toHaveBeenCalled());
    expect('minutes' in mockScrims.create.mock.calls[0][0]).toBe(false);
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

  it('a board row shows the reliability badge only when the server sends a record', async () => {
    mockScrims.board.mockResolvedValue({ posts: [OPEN_POST, MY_POST], night: null, showSr: false });
    renderScrims();
    await screen.findByText('Rats');
    expect(screen.queryByText(/Reliable:/)).toBeNull();
    expect(screen.queryByText('New')).toBeNull();
    cleanup();
    mockScrims.board.mockResolvedValue({ posts: [
      { ...OPEN_POST, record: { shown: 5, booked: 6, noShows: 1, lateCancels: 0, excused: 0 } },
      { ...MY_POST, mine: false, accepts: null, id: 8, record: { shown: 1, booked: 1, noShows: 0, lateCancels: 0, excused: 0 } },
    ], night: null, showSr: false });
    renderScrims();
    expect(await screen.findByText('Reliable: 5 of 6 shown')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
  });

  it('shows the scrim night banner, with "On now" only while the window is running', async () => {
    mockScrims.board.mockResolvedValue({
      posts: [OPEN_POST, MY_POST],
      night: { startsAt: '2026-10-08T21:00:00.000Z', endsAt: '2026-10-09T01:00:00.000Z' },
      showSr: false,
    });
    renderScrims();
    await screen.findByText('Rats');
    expect(await screen.findByText(/^Scrim night: /)).toBeTruthy();
    expect(screen.queryByText('On now')).toBeNull();

    cleanup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T22:00:00.000Z'));
    mockScrims.board.mockResolvedValue({
      posts: [OPEN_POST, MY_POST],
      night: { startsAt: '2026-10-08T21:00:00.000Z', endsAt: '2026-10-09T01:00:00.000Z' },
      showSr: false,
    });
    renderScrims();
    await screen.findByText('Rats');
    expect(await screen.findByText('On now')).toBeTruthy();
    vi.useRealTimers();
  });

  it('highlights a board row inside the scrim night window, with a tag', async () => {
    mockScrims.board.mockResolvedValue({
      posts: [{ ...OPEN_POST, night: true }, MY_POST],
      night: { startsAt: '2026-10-08T21:00:00.000Z', endsAt: '2026-10-09T01:00:00.000Z' },
      showSr: false,
    });
    const { container } = renderScrims();
    await screen.findByText('Rats');
    const row = container.querySelector('#scrim-5');
    expect(row?.className).toContain('scrimrow--night');
    const other = container.querySelector('#scrim-6');
    expect(other?.className).not.toContain('scrimrow--night');
    expect(screen.getAllByText('Scrim night').length).toBeGreaterThan(0);
  });
});

describe('the Blocked panel', () => {
  it('lists the side\'s blocks and unblocks posts the remove', async () => {
    const blocks: BlockEntry[] = [
      { target: { kind: 'team', id: 2, name: 'Rats', tag: 'RT' }, createdAt: '2026-09-30T00:00:00.000Z' },
      { target: { kind: 'player', steamid: '76561199000000400', name: 'Eve' }, createdAt: '2026-09-29T00:00:00.000Z' },
    ];
    mockScrims.blocks.mockResolvedValue({ blocks });
    renderScrims();
    await screen.findByText('Rats');
    await screen.findByText('Eve');
    expect(mockScrims.blocks).toHaveBeenCalledWith(1, expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Eve' }));
    await waitFor(() => expect(mockScrims.unblock).toHaveBeenCalledWith(1, { steamid: '76561199000000400' }));
  });

  it('adding a team block and a player block posts the right body', async () => {
    renderScrims();
    await screen.findByText('Rats');

    fireEvent.change(screen.getByLabelText('Team to block'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block team' }));
    await waitFor(() => expect(mockScrims.block).toHaveBeenCalledWith(1, { teamId: 2 }));

    fireEvent.click(screen.getByRole('button', { name: 'Player' }));
    mockTeams.search.mockResolvedValue({ players: [{ steamid: '76561199000000500', name: 'Mallory', avatar: null }] });
    fireEvent.input(screen.getByLabelText('Find a player to block'), { target: { value: 'mal' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Block Mallory' }));
    await waitFor(() => expect(mockScrims.block).toHaveBeenCalledWith(1, { steamid: '76561199000000500' }));
  });

  it('switching the side reloads the block list', async () => {
    renderScrims();
    await screen.findByText('Rats');
    await waitFor(() => expect(mockScrims.blocks).toHaveBeenCalledWith(1, expect.anything()));

    fireEvent.change(screen.getByLabelText('Your side for blocks'), { target: { value: '' } });
    await waitFor(() => expect(mockScrims.blocks).toHaveBeenCalledWith(null, expect.anything()));
  });

  it('a slow response for the old side does not render after switching sides', async () => {
    let resolveOld: ((r: { blocks: BlockEntry[] }) => void) | null = null;
    mockScrims.blocks.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    renderScrims();
    await screen.findByText('Rats');
    await waitFor(() => expect(mockScrims.blocks).toHaveBeenCalledWith(1, expect.anything()));

    const newBlocks: BlockEntry[] = [{ target: { kind: 'player', steamid: '76561199000000400', name: 'Eve' }, createdAt: '2026-09-29T00:00:00.000Z' }];
    mockScrims.blocks.mockResolvedValueOnce({ blocks: newBlocks });
    fireEvent.change(screen.getByLabelText('Your side for blocks'), { target: { value: '' } });
    await waitFor(() => expect(mockScrims.blocks).toHaveBeenCalledWith(null, expect.anything()));
    await screen.findByText('Eve');

    // The old side's response arrives late; it must not replace the new side's list.
    resolveOld!({ blocks: [{ target: { kind: 'team', id: 2, name: 'Rats', tag: 'RT' }, createdAt: '2026-09-30T00:00:00.000Z' }] });
    await Promise.resolve();
    await Promise.resolve();
    const panel = screen.getByRole('heading', { name: 'Blocked' }).closest('section')!;
    const blockList = panel.querySelector('ul.teamlist');
    expect(blockList?.textContent).not.toContain('Rats');
    expect(blockList?.textContent).toContain('Eve');
  });

  it('is absent for someone who cannot post', async () => {
    mockScrims.options.mockRejectedValue(new ApiError(404, 'not found'));
    mockScrims.board.mockResolvedValue({ posts: [], night: null, showSr: false });
    renderScrims();
    await screen.findByRole('heading', { name: 'Board' });
    await waitFor(() => expect(mockScrims.options).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Post a scrim' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Blocked' })).toBeNull();
    expect(mockScrims.blocks).not.toHaveBeenCalled();
  });
});
