import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';

const { mockBookings, mockAdmin, mockScrims, mockConfirm } = vi.hoisted(() => ({
  mockBookings: {
    get: vi.fn(), act: vi.fn(), cancel: vi.fn(), options: vi.fn(), next: vi.fn(), stay: vi.fn(),
    casters: vi.fn(), inviteCaster: vi.fn(), withdrawCaster: vi.fn(), excuse: vi.fn(), review: vi.fn(),
  },
  mockAdmin: { cancelBooking: vi.fn(), extendBooking: vi.fn(), endBooking: vi.fn(), excuseBooking: vi.fn() },
  mockScrims: { repost: vi.fn() },
  mockConfirm: vi.fn(),
}));
vi.mock('../components/Confirm', () => ({ confirm: mockConfirm }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, bookingsApi: mockBookings, adminApi: { ...actual.adminApi, ...mockAdmin }, scrimsApi: mockScrims };
});
const { Booking } = await import('./Booking');

const VIEW = (over: Record<string, unknown> = {}) => ({
  id: 7, purpose: 'scrim', state: 'ready', ending: false, ended: false, startsAt: '2026-10-02T20:00:00.000Z', endsAt: '2026-10-02T22:00:00.000Z',
  extendedMinutes: 0, extendMinutes: 30, createdAt: '2026-10-01T12:00:00.000Z', playlist: [{ slug: 'no_mercy', name: 'No Mercy' }], rules: null,
  gameConfig: { key: 'standard', label: 'Standard' }, server: { name: 'Riverside #3' },
  connect: { host: '1.2.3.4', port: 27015, password: 'abcd2345' }, cancel: null, endReason: null, noShowFrom: '2026-10-02T20:15:00.000Z',
  sides: [
    { side: 'a', name: "p0's group", team: null, captain: { steamid: 'x0', name: 'p0' }, confirmed: true, peakPresent: 0, noShow: false, people: [{ steamid: 'x0', name: 'p0', avatar: null, role: 'player', status: 'accepted' }] },
    { side: 'b', name: 'Mice', team: { id: 1, slug: 'mice', name: 'Mice', tag: 'MM', logoKey: null }, captain: { steamid: 'x1', name: 'p1' }, confirmed: true, peakPresent: 0, noShow: false, people: [] },
  ],
  viewer: { side: 'a', manages: ['a'], staff: false, invited: false },
  games: [],
  casters: [],
  repost: { allowed: false },
  ...over,
});
const session = { kind: 'active', me: { steamid: 'x0', name: 'p0', avatar: null, status: 'active', isAdmin: false, teams: true } } as never;
const OPTIONS = { campaigns: [{ slug: 'no_mercy', name: 'No Mercy', minutes: 60 }, { slug: 'death_toll', name: 'Death Toll', minutes: 65 }] };

afterEach(() => {
  cleanup();
  for (const f of Object.values(mockBookings)) f.mockReset();
  for (const f of Object.values(mockAdmin)) f.mockReset();
  for (const f of Object.values(mockScrims)) f.mockReset();
  mockConfirm.mockReset();
  history.replaceState(null, '', '/');
});
beforeEach(() => {
  mockBookings.get.mockResolvedValue(VIEW());
  mockBookings.options.mockResolvedValue(OPTIONS);
  mockBookings.casters.mockResolvedValue({ casters: [{ steamid: 'c1', name: 'Caster One', avatar: null }, { steamid: 'c2', name: 'Caster Two', avatar: null }] });
});

describe('Booking page', () => {
  it('shows the connect line when ready', async () => {
    render(<Booking id="7" session={session} />);
    expect(await screen.findByText('connect 1.2.3.4:27015; password abcd2345')).toBeTruthy();
  });

  it('a manager sees Cancel and no connect line before ready, but not Extend (the booking is not running yet)', async () => {
    mockBookings.get.mockResolvedValue(VIEW({ state: 'scheduled', connect: null, server: null }));
    render(<Booking id="7" session={session} />);
    expect(await screen.findByRole('button', { name: 'Cancel booking' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Extend 30 min' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End now' })).toBeNull();
    expect(screen.queryByText(/connect /)).toBeNull();
  });

  it('a manager sees Extend once the booking is running', async () => {
    mockBookings.get.mockResolvedValue(VIEW({ state: 'ready' }));
    render(<Booking id="7" session={session} />);
    expect(await screen.findByRole('button', { name: 'Cancel booking' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Extend 30 min' })).toBeTruthy();
  });

  it('an invited person sees Accept', async () => {
    mockBookings.get.mockResolvedValue(VIEW({ viewer: { side: 'a', manages: [], staff: false, invited: true }, connect: null }));
    render(<Booking id="7" session={session} />);
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('an unconfirmed side only sees Confirm and Decline, never Cancel or Extend', async () => {
    mockBookings.get.mockResolvedValue(VIEW({
      state: 'scheduled', connect: null, server: null,
      sides: [
        { side: 'a', name: "p0's group", team: null, captain: { steamid: 'x0', name: 'p0' }, confirmed: true, peakPresent: 0, noShow: false, people: [{ steamid: 'x0', name: 'p0', avatar: null, role: 'player', status: 'accepted' }] },
        { side: 'b', name: 'Mice', team: { id: 1, slug: 'mice', name: 'Mice', tag: 'MM', logoKey: null }, captain: { steamid: 'x1', name: 'p1' }, confirmed: false, peakPresent: 0, noShow: false, people: [] },
      ],
      viewer: { side: 'b', manages: ['b'], staff: false, invited: false },
    }));
    render(<Booking id="7" session={session} />);
    expect(await screen.findByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Extend 30 min' })).toBeNull();
  });

  // A staff viewer who does not themselves manage a confirmed side (the
  // admin-desk case) has to go through the admin routes: the player routes
  // never pass a staff flag, so those buttons would just fail with
  // "not a manager".
  it('a staff-only viewer sees Cancel and Extend on a scheduled booking, no No-show, and uses the admin routes', async () => {
    const staffView = VIEW({ state: 'scheduled', connect: null, server: null, viewer: { side: null, manages: [], staff: true, invited: false } });
    mockBookings.get.mockResolvedValueOnce(staffView).mockResolvedValueOnce({ ...staffView, state: 'cancelled' });
    mockAdmin.cancelBooking.mockResolvedValue({ ok: true });
    render(<Booking id="7" session={session} />);
    expect(await screen.findByRole('button', { name: 'Cancel booking' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Extend 30 min' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'They did not show' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    await waitFor(() => expect(mockAdmin.cancelBooking).toHaveBeenCalledWith(7, ''));
    await waitFor(() => expect(mockBookings.get).toHaveBeenCalledTimes(2));
  });

  describe('games (plan 4b, Task 7)', () => {
    const GAME = {
      matchId: 55, campaign: 'no_mercy', state: 'completed', scoreA: 3, scoreB: 5, sideA: 'b' as const,
      startedAt: '2026-10-02T20:00:00.000Z', endedAt: '2026-10-02T20:30:00.000Z',
    };

    it('renders a game and orients its score to the booking sides, with a link to the match', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ games: [GAME] }));
      render(<Booking id="7" session={session} />);
      // sideA is 'b': booking side b was match team A (score 3), so booking
      // side a (p0's group) shows the other score, 5.
      expect(await screen.findByText("p0's group 5 : 3 Mice")).toBeTruthy();
      expect(screen.getByText('completed')).toBeTruthy();
      const link = screen.getByRole('link', { name: 'View' }) as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('/match/55');
      expect(link.closest('li')?.textContent).toContain('No Mercy');
    });

    it('hides the next-campaign controls while a game is live, even for a manager of a confirmed side', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ games: [{ ...GAME, state: 'live' }] }));
      render(<Booking id="7" session={session} />);
      await screen.findByText('No Mercy');
      expect(screen.queryByRole('button', { name: 'Play this next' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Replay last campaign' })).toBeNull();
    });

    it('a manager of a confirmed side can pick a campaign or replay the last one', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ games: [GAME] }));
      mockBookings.next.mockResolvedValue(VIEW({ games: [GAME] }));
      mockBookings.stay.mockResolvedValue(VIEW({ games: [GAME] }));
      render(<Booking id="7" session={session} />);
      const select = await screen.findByLabelText('Campaign') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'death_toll' } });
      fireEvent.click(screen.getByRole('button', { name: 'Play this next' }));
      await waitFor(() => expect(mockBookings.next).toHaveBeenCalledWith(7, 'death_toll'));
      fireEvent.click(screen.getByRole('button', { name: 'Replay last campaign' }));
      await waitFor(() => expect(mockBookings.stay).toHaveBeenCalledWith(7));
    });

    it('a staff-only viewer who manages no side still sees the controls', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ viewer: { side: null, manages: [], staff: true, invited: false } }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByRole('button', { name: 'Play this next' })).toBeTruthy();
    });

    it('hides the controls for a player who manages nothing and is not staff', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ viewer: { side: 'a', manages: [], staff: false, invited: false } }));
      render(<Booking id="7" session={session} />);
      await waitFor(() => expect(mockBookings.get).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: 'Play this next' })).toBeNull();
    });
  });

  describe('casters (plan 4c)', () => {
    const C1 = { steamid: 'c1', name: 'Caster One', a: true, b: false };

    it("shows each caster's status per side to a manager of a confirmed side", async () => {
      mockBookings.get.mockResolvedValue(VIEW({ casters: [C1] }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText('Casters')).toBeTruthy();
      expect(screen.getByText("· p0's group ✓ / Mice pending", { exact: false })).toBeTruthy();
    });

    it('invites a picked caster, leaving out those this side already invited', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ casters: [C1] }));
      mockBookings.inviteCaster.mockResolvedValue(VIEW({ casters: [C1, { steamid: 'c2', name: 'Caster Two', a: true, b: false }] }));
      render(<Booking id="7" session={session} />);
      const select = await screen.findByLabelText('Caster') as HTMLSelectElement;
      await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
      expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Pick a caster', 'Caster Two']);
      fireEvent.change(select, { target: { value: 'c2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
      await waitFor(() => expect(mockBookings.inviteCaster).toHaveBeenCalledWith(7, 'c2'));
      expect(await screen.findByText('Caster Two')).toBeTruthy();
    });

    it("withdraws only this side's half: no Withdraw on a caster only the other side invited", async () => {
      mockBookings.get.mockResolvedValue(VIEW({ casters: [C1, { steamid: 'c2', name: 'Caster Two', a: false, b: true }] }));
      mockBookings.withdrawCaster.mockResolvedValue(VIEW({ casters: [{ steamid: 'c2', name: 'Caster Two', a: false, b: true }] }));
      render(<Booking id="7" session={session} />);
      await screen.findByText('Caster One');
      const withdraws = screen.getAllByRole('button', { name: 'Withdraw' });
      expect(withdraws).toHaveLength(1);
      expect(withdraws[0].closest('li')?.textContent).toContain('Caster One');
      fireEvent.click(withdraws[0]);
      await waitFor(() => expect(mockBookings.withdrawCaster).toHaveBeenCalledWith(7, 'c1'));
    });

    it('acts for side b when the viewer manages side b', async () => {
      mockBookings.get.mockResolvedValue(VIEW({
        casters: [C1], viewer: { side: 'b', manages: ['b'], staff: false, invited: false },
      }));
      render(<Booking id="7" session={session} />);
      const select = await screen.findByLabelText('Caster') as HTMLSelectElement;
      // Side a's invite of Caster One leaves them invitable for side b.
      await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(3));
      expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    });

    it('has no casters panel for a player who manages nothing, nor for a staff-only viewer', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ casters: [C1], viewer: { side: 'a', manages: [], staff: false, invited: false } }));
      render(<Booking id="7" session={session} />);
      await waitFor(() => expect(mockBookings.get).toHaveBeenCalled());
      await screen.findByText(/The server is ready/);
      expect(screen.queryByText('Casters')).toBeNull();
      cleanup();
      mockBookings.get.mockResolvedValue(VIEW({ casters: [C1], viewer: { side: null, manages: [], staff: true, invited: false } }));
      render(<Booking id="7" session={session} />);
      await screen.findByText(/The server is ready/);
      expect(screen.queryByText('Casters')).toBeNull();
    });

    it('once the booking is over, offers no invite but still lets a side withdraw its own half', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ state: 'ended', connect: null, casters: [C1, { steamid: 'c2', name: 'Caster Two', a: false, b: true }] }));
      mockBookings.withdrawCaster.mockResolvedValue(VIEW({ state: 'ended', connect: null, casters: [{ steamid: 'c2', name: 'Caster Two', a: false, b: true }] }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText('Caster One')).toBeTruthy();
      expect(screen.queryByLabelText('Caster')).toBeNull();
      const withdraws = screen.getAllByRole('button', { name: 'Withdraw' });
      expect(withdraws).toHaveLength(1);
      fireEvent.click(withdraws[0]);
      await waitFor(() => expect(mockBookings.withdrawCaster).toHaveBeenCalledWith(7, 'c1'));
    });
  });

  describe('late cancels and the record (plan 2)', () => {
    const SIDE_A = { side: 'a', name: "p0's group", team: null, captain: { steamid: 'x0', name: 'p0' }, confirmed: true, peakPresent: 0, noShow: false, people: [], lateCancel: false, excused: false, canExcuse: false };
    const SIDE_B = { side: 'b', name: 'Mice', team: { id: 1, slug: 'mice', name: 'Mice', tag: 'MM', logoKey: null }, captain: { steamid: 'x1', name: 'p1' }, confirmed: true, peakPresent: 0, noShow: false, people: [], lateCancel: false, excused: false, canExcuse: false };
    const cancelled = (a: object, b: object = {}, over: Record<string, unknown> = {}) => VIEW({
      state: 'cancelled', ending: true, connect: null, server: null, cancel: { side: 'a', reason: null },
      sides: [{ ...SIDE_A, ...a }, { ...SIDE_B, ...b }], viewer: { side: 'b', manages: ['b'], staff: false, invited: false }, ...over,
    });

    it('the other side sees the late cancel and excuses it with one tap', async () => {
      mockBookings.get.mockResolvedValue(cancelled({ lateCancel: true, canExcuse: true }));
      mockBookings.excuse.mockResolvedValue(cancelled({ lateCancel: true, excused: true }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText("Late cancel by p0's group")).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'All good, no hard feelings' }));
      await waitFor(() => expect(mockBookings.excuse).toHaveBeenCalledWith(7));
      expect(await screen.findByText('Excused')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'All good, no hard feelings' })).toBeNull();
    });

    it('no button when the viewer may not excuse it', async () => {
      mockBookings.get.mockResolvedValue(cancelled({ lateCancel: true }, {}, { viewer: { side: 'a', manages: ['a'], staff: false, invited: false } }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText("Late cancel by p0's group")).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'All good, no hard feelings' })).toBeNull();
    });

    it('staff excuse each marked side with an optional note through the admin route', async () => {
      const staffView = cancelled({ lateCancel: true }, {}, { viewer: { side: null, manages: [], staff: true, invited: false } });
      mockBookings.get.mockResolvedValueOnce(staffView).mockResolvedValueOnce(cancelled({ lateCancel: true, excused: true }, {}, { viewer: { side: null, manages: [], staff: true, invited: false } }));
      mockAdmin.excuseBooking.mockResolvedValue({ ok: true });
      render(<Booking id="7" session={session} />);
      const note = await screen.findByLabelText("Excuse note (p0's group)");
      // Only side a has a mark, so only one Excuse control.
      expect(screen.getAllByRole('button', { name: 'Excuse' })).toHaveLength(1);
      fireEvent.input(note, { target: { value: 'server crashed' } });
      fireEvent.click(screen.getByRole('button', { name: 'Excuse' }));
      await waitFor(() => expect(mockAdmin.excuseBooking).toHaveBeenCalledWith(7, 'a', 'server crashed'));
      expect(await screen.findByText('Excused')).toBeTruthy();
    });

    it('staff also get Excuse on a no-show side', async () => {
      mockBookings.get.mockResolvedValue(VIEW({
        state: 'no_show', connect: null, sides: [{ ...SIDE_A }, { ...SIDE_B, noShow: true }],
        viewer: { side: null, manages: [], staff: true, invited: false },
      }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByLabelText('Excuse note (Mice)')).toBeTruthy();
    });

    it('staff get Excuse on a short side of an ended booking with no no-show claimed, and see it excused after', async () => {
      const staff = { viewer: { side: null, manages: [], staff: true, invited: false } };
      const over = (b: object) => VIEW({ state: 'ended', ending: true, ended: true, connect: null, sides: [{ ...SIDE_A, peakPresent: 4 }, { ...SIDE_B, short: true, ...b }], ...staff });
      mockBookings.get.mockResolvedValueOnce(over({})).mockResolvedValueOnce(over({ excused: true }));
      mockAdmin.excuseBooking.mockResolvedValue({ ok: true });
      render(<Booking id="7" session={session} />);
      expect(await screen.findByLabelText('Excuse note (Mice)')).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Excuse' })).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Excuse' }));
      await waitFor(() => expect(mockAdmin.excuseBooking).toHaveBeenCalledWith(7, 'b', ''));
      expect(await screen.findByText('Excused')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Excuse' })).toBeNull();
    });

    it('a short side shows no Excuse control to a non-staff viewer', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ state: 'ended', ending: true, ended: true, connect: null, sides: [{ ...SIDE_A }, { ...SIDE_B, short: true }] }));
      render(<Booking id="7" session={session} />);
      await screen.findByText('Over.');
      expect(screen.queryByRole('button', { name: 'Excuse' })).toBeNull();
    });

    it('shows a side\'s record line when the server sends one, "New" under 3 booked', async () => {
      mockBookings.get.mockResolvedValue(VIEW({
        sides: [
          { ...SIDE_A, record: { shown: 1, booked: 2, noShows: 1, lateCancels: 0, excused: 0 } },
          { ...SIDE_B, record: { shown: 5, booked: 7, noShows: 1, lateCancels: 1, excused: 0 } },
        ],
      }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText('New')).toBeTruthy();
      expect(screen.getByText('Shown 5 of 7 · No-shows 1 · Late cancels 1')).toBeTruthy();
    });

    const renderAt = (path: string) => {
      history.replaceState(null, '', path);
      return render(<LocationProvider><Booking id="7" session={session} /></LocationProvider>);
    };

    describe('re-posting a cancelled scrim (plan 2, Task 3)', () => {
      it('no button when repost is not allowed', async () => {
        mockBookings.get.mockResolvedValue(cancelled({}, {}, { repost: { allowed: false } }));
        render(<Booking id="7" session={session} />);
        expect(await screen.findByText('Cancelled.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Re-post this scrim' })).toBeNull();
      });

      it('routes to the board on success', async () => {
        mockBookings.get.mockResolvedValue(cancelled({}, {}, { repost: { allowed: true } }));
        mockScrims.repost.mockResolvedValue({ id: 123 });
        renderAt('/booking/7');
        fireEvent.click(await screen.findByRole('button', { name: 'Re-post this scrim' }));
        await waitFor(() => expect(mockScrims.repost).toHaveBeenCalledWith(7));
        await waitFor(() => expect(location.pathname + location.search).toBe('/scrims?post=123'));
      });

      it('shows the refusal text on failure, without navigating', async () => {
        mockBookings.get.mockResolvedValue(cancelled({}, {}, { repost: { allowed: true } }));
        mockScrims.repost.mockRejectedValue(new Error('Too close to the start: an acceptance needs at least 30 minutes to be answered.'));
        renderAt('/booking/7');
        fireEvent.click(await screen.findByRole('button', { name: 'Re-post this scrim' }));
        expect(await screen.findByText('Too close to the start: an acceptance needs at least 30 minutes to be answered.')).toBeTruthy();
        expect(location.pathname).toBe('/booking/7');
      });
    });

    it('?cancel=1 opens the cancel confirm at once for a manager, and cancels on yes', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ state: 'scheduled', connect: null, server: null }));
      mockBookings.cancel.mockResolvedValue(VIEW({ state: 'cancelled', ending: true, connect: null, server: null }));
      mockConfirm.mockResolvedValue(true);
      renderAt('/booking/7?cancel=1');
      await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
      expect(mockConfirm.mock.calls[0][0]).toMatchObject({ confirmLabel: 'Cancel booking', danger: true });
      await waitFor(() => expect(mockBookings.cancel).toHaveBeenCalledWith(7, ''));
    });

    it('?cancel=1 does nothing on no, and is ignored for a viewer who may not cancel', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ state: 'scheduled', connect: null, server: null }));
      mockConfirm.mockResolvedValue(false);
      renderAt('/booking/7?cancel=1');
      await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
      expect(mockBookings.cancel).not.toHaveBeenCalled();
      cleanup();
      mockConfirm.mockReset();
      mockBookings.get.mockResolvedValue(VIEW({ state: 'scheduled', connect: null, server: null, viewer: { side: 'a', manages: [], staff: false, invited: false } }));
      renderAt('/booking/7?cancel=1');
      await screen.findByText(/Booked\./);
      expect(mockConfirm).not.toHaveBeenCalled();
    });
  });

  describe('the state line while closing and once closed', () => {
    it('"Closing." only while the close is still running, then the plain state line', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ state: 'ended', ending: true, ended: false, connect: null }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText('Closing.')).toBeTruthy();
      cleanup();
      mockBookings.get.mockResolvedValue(VIEW({ state: 'ended', ending: true, ended: true, connect: null }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText('Over.')).toBeTruthy();
      expect(screen.queryByText('Closing.')).toBeNull();
    });
  });

  describe('private reviews (plan 2 Ruling 5, Task 5)', () => {
    it('has no review card when review is missing', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ state: 'ended', connect: null }));
      render(<Booking id="7" session={session} />);
      await screen.findByText('Over.');
      expect(screen.queryByText(/^Review /)).toBeNull();
    });

    it('shows the review card when open, pre-filled from mine, and posts thumbs and tags', async () => {
      mockBookings.get.mockResolvedValue(VIEW({
        state: 'ended', connect: null, review: { open: true, mine: { thumbs: 1, tags: ['on_time'] } },
      }));
      mockBookings.review.mockResolvedValue(VIEW({
        state: 'ended', connect: null, review: { open: true, mine: { thumbs: 1, tags: ['on_time', 'good_comms'] } },
      }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText('Review Mice')).toBeTruthy();
      const up = screen.getByRole('button', { name: 'Thumbs up' });
      expect(up.getAttribute('aria-pressed')).toBe('true');
      const onTime = screen.getByRole('button', { name: 'On time' });
      expect(onTime.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'Good comms' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(mockBookings.review).toHaveBeenCalledWith(7, 1, ['on_time', 'good_comms']));
      expect(await screen.findByText('Saved. Only staff see single reviews.')).toBeTruthy();
    });

    it('no review card once the window has closed', async () => {
      mockBookings.get.mockResolvedValue(VIEW({
        state: 'ended', connect: null, review: { open: false, mine: { thumbs: 1, tags: [] } },
      }));
      render(<Booking id="7" session={session} />);
      await screen.findByText('Over.');
      expect(screen.queryByText(/^Review /)).toBeNull();
    });

    it('the staff block shows only when reviews is present, listing both sides', async () => {
      mockBookings.get.mockResolvedValue(VIEW({
        state: 'ended', connect: null, viewer: { side: null, manages: [], staff: true, invited: false },
        reviews: [
          { side: 'a', reviewer: 'x1', reviewerName: 'p1', thumbs: 1, tags: ['on_time'], createdAt: '2026-10-02T22:00:00.000Z', updatedAt: '2026-10-02T22:00:00.000Z' },
        ],
      }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText('Reviews (staff only)')).toBeTruthy();
      expect(screen.getByText('by p1')).toBeTruthy();
      expect(screen.getByText('On time')).toBeTruthy();
    });

    it('no staff block when reviews is absent', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ state: 'ended', connect: null }));
      render(<Booking id="7" session={session} />);
      await screen.findByText('Over.');
      expect(screen.queryByText('Reviews (staff only)')).toBeNull();
    });
  });
});
