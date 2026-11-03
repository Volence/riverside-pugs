import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { COMMUNITY, DROPIN, FULL, SHORT } from '../wrapped.fixture';

const { mockApi, mockAdmin } = vi.hoisted(() => ({
  mockApi: { wrappedSeasons: vi.fn(), wrapped: vi.fn(), wrappedPlayer: vi.fn() },
  mockAdmin: { wrappedPreview: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi }, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { Wrapped } = await import('./Wrapped');

const SEASONS = { seasons: [{ id: 1, name: 'Season 0', frozenAt: '2026-11-03 17:00:00' }] };

beforeEach(() => {
  for (const f of [...Object.values(mockApi), ...Object.values(mockAdmin)]) f.mockReset();
  mockApi.wrappedSeasons.mockResolvedValue(SEASONS);
});
afterEach(cleanup);

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next card' }));
const card = () => document.querySelector('.wrapped-card') as HTMLElement;
/** Step forward until a card with this data-card key shows. */
async function goTo(key: string) {
  for (let i = 0; i < 30 && card().dataset.card !== key; i++) next();
  await waitFor(() => expect(card().dataset.card).toBe(key));
}

describe('Wrapped page', () => {
  it('signed in: the viewer\'s own deck, then the community deck, ending in cyan', async () => {
    mockApi.wrapped.mockResolvedValue({ community: COMMUNITY, me: FULL, loggedIn: true });
    render(<Wrapped />);
    expect(await screen.findByText('Bone Breaker')).toBeTruthy();
    expect(mockApi.wrapped).toHaveBeenCalledWith(1, expect.anything());
    expect(screen.getByText('1 / 19')).toBeTruthy();
    expect(card().getAttribute('aria-live')).toBe('polite');

    next();
    expect(screen.getByText('188')).toBeTruthy();
    expect(screen.getByText('107-81 (57%)')).toBeTruthy();
    expect(screen.getByText(/2nd most matches of 260 players/)).toBeTruthy();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('#3')).toBeTruthy();
    expect(screen.getByText('Peak 3760')).toBeTruthy();
    expect(screen.getByText(/the highest anyone reached all season/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('188')).toBeTruthy();

    await goTo('rivals');
    expect(screen.getByText('diz')).toBeTruthy();
    expect(screen.getByText('0-11')).toBeTruthy();

    await goTo('signature');
    expect(screen.getByText('Top 3%')).toBeTruthy();
    expect(screen.getByText('0.94 per match, #3 of 103 regulars.')).toBeTruthy();

    await goTo('endorsed');
    expect(screen.getByText('The most endorsed player of Season 0.')).toBeTruthy();
    // Never who endorsed them.
    expect(card().textContent).not.toMatch(/VII|KoRn/);

    await goTo('started');
    expect(screen.getByText(/the first ranked PUG ever played on Riverside\. You won it\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Match 8' }).getAttribute('href')).toBe('/match/8');

    await goTo('c_standings');
    expect(screen.getByText('20 matches needed for a final place.')).toBeTruthy();

    await goTo('next');
    expect(screen.getByText('Season 1')).toBeTruthy();
    expect(screen.getByText('Wrong Way')).toBeTruthy();
    expect(document.querySelector('.wrapped-phone')!.classList.contains('is-cyan')).toBe(true);
    expect((screen.getByRole('button', { name: 'Next card' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a short deck says climbing, never peak', async () => {
    mockApi.wrapped.mockResolvedValue({ community: COMMUNITY, me: SHORT, loggedIn: true });
    render(<Wrapped />);
    await screen.findByText('Duckzy');
    await goTo('standing');
    expect(screen.getByText('833 to 893, climbing')).toBeTruthy();
    expect(card().textContent).not.toMatch(/peak/i);
    expect(screen.getByText(/20 matches are needed for a final place; you played 6/)).toBeTruthy();
    await goTo('closer');
    expect(screen.getByText('Season 1 is yours')).toBeTruthy();
  });

  it('a drop-in gets one first-match card', async () => {
    mockApi.wrapped.mockResolvedValue({ community: COMMUNITY, me: DROPIN, loggedIn: true });
    render(<Wrapped />);
    expect(await screen.findByText(/Your first match/)).toBeTruthy();
    expect(screen.getByText('1 / 6')).toBeTruthy();
    next();
    expect(card().dataset.card).toBe('c_numbers');
  });

  it('signed out: a sign-in card, then the community deck', async () => {
    mockApi.wrapped.mockResolvedValue({ community: COMMUNITY, me: null, loggedIn: false });
    render(<Wrapped />);
    expect(await screen.findByText('Log in to see yours')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in through Steam' }).getAttribute('href')).toBe('/auth/steam?next=%2Fwrapped');
    next();
    expect(screen.getByText('Season 0, all of us')).toBeTruthy();
    expect(screen.getByText('11,084')).toBeTruthy();
  });

  it('before any season closes: the waiting state', async () => {
    mockApi.wrappedSeasons.mockResolvedValue({ seasons: [] });
    render(<Wrapped />);
    expect(await screen.findByText(/Wrapped opens when the season ends/)).toBeTruthy();
    expect(mockApi.wrapped).not.toHaveBeenCalled();
  });

  it('a shared deck reads that player, and Share copies its link', async () => {
    mockApi.wrappedPlayer.mockResolvedValue({ community: COMMUNITY, player: FULL });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Wrapped season="1" steamid={FULL.steamid} />);
    expect(await screen.findByText('Bone Breaker')).toBeTruthy();
    expect(mockApi.wrappedPlayer).toHaveBeenCalledWith(1, FULL.steamid, expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Share this Wrapped' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${location.origin}/wrapped/1/${FULL.steamid}`));
    expect(await screen.findByText('Link copied.')).toBeTruthy();
  });

  it('shows the link itself when the clipboard refuses', async () => {
    mockApi.wrappedPlayer.mockResolvedValue({ community: COMMUNITY, player: FULL });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    render(<Wrapped season="1" steamid={FULL.steamid} />);
    await screen.findByText('Bone Breaker');
    fireEvent.click(screen.getByRole('button', { name: 'Share this Wrapped' }));
    expect(await screen.findByText(`${location.origin}/wrapped/1/${FULL.steamid}`)).toBeTruthy();
  });

  it('staff preview reads the admin route and says it is not frozen', async () => {
    mockAdmin.wrappedPreview.mockResolvedValue({ community: { ...COMMUNITY, season: { ...COMMUNITY.season, endedAt: null } }, player: FULL, preview: true });
    render(<Wrapped season="1" steamid={FULL.steamid} preview />);
    expect(await screen.findByText('Preview, not frozen')).toBeTruthy();
    expect(mockAdmin.wrappedPreview).toHaveBeenCalledWith(1, FULL.steamid, expect.anything());
    expect(screen.queryByRole('button', { name: 'Share this Wrapped' })).toBeNull();
  });
});

describe('Wrapped autoplay', () => {
  const fill = () => document.querySelector('.wrapped-phone__fill') as HTMLElement | null;
  afterEach(() => vi.unstubAllGlobals());

  it('the current bar fills and moves on; Pause and a held press stop it; the last card stays', async () => {
    mockApi.wrapped.mockResolvedValue({ community: COMMUNITY, me: FULL, loggedIn: true });
    render(<Wrapped />);
    await screen.findByText('Bone Breaker');
    expect(fill()!.style.animationPlayState).toBe('running');
    fireEvent.animationEnd(fill()!);
    expect(screen.getByText('2 / 19')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(fill()!.style.animationPlayState).toBe('paused');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(fill()!.style.animationPlayState).toBe('running');

    fireEvent.pointerDown(card());
    expect(fill()!.style.animationPlayState).toBe('paused');
    fireEvent.pointerUp(card());
    expect(fill()!.style.animationPlayState).toBe('running');

    await goTo('next');
    expect(fill()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('does not play for reduced motion', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    mockApi.wrapped.mockResolvedValue({ community: COMMUNITY, me: FULL, loggedIn: true });
    render(<Wrapped />);
    await screen.findByText('Bone Breaker');
    expect(fill()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });
});
