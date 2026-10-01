import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockBookings } = vi.hoisted(() => ({
  mockBookings: { options: vi.fn(), mine: vi.fn(), act: vi.fn(), setPref: vi.fn(), create: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, bookingsApi: mockBookings };
});
const { Bookings } = await import('./Bookings');

const OPTIONS = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy', minutes: 70 }, { slug: 'death_toll', name: 'Death Toll', minutes: 45 }],
  rulesets: [{ id: 3, name: 'Casual Scrim' }], gameConfigs: [{ key: 'standard', label: 'Standard' }],
  limits: { daysAhead: 14, playlistMax: 4 },
  estimate: { perCampaign: { no_mercy: 70, death_toll: 45 }, base: 15, slack: 10, step: 30, min: 60 },
  myTeams: [], teams: [{ id: 1, slug: 'mice', name: 'Mice', tag: 'MM' }],
};
const MINE = {
  open: [{ id: 7, state: 'scheduled', ending: false, startsAt: '2026-10-02T20:00:00.000Z', endsAt: '2026-10-02T22:00:00.000Z', aName: "p0's group", bName: 'Mice', mySide: 'b', needs: 'confirm' }],
  recent: [], prefs: [{ type: 'booking_ready', label: 'My booked server is ready', enabled: true }],
};
const session = { kind: 'active', me: { steamid: '76561199000000300', name: 'me', avatar: null, status: 'active', isAdmin: false, teams: true } } as never;

afterEach(() => { cleanup(); for (const f of Object.values(mockBookings)) f.mockReset(); });
beforeEach(() => {
  mockBookings.options.mockResolvedValue(OPTIONS);
  mockBookings.mine.mockResolvedValue(MINE);
  mockBookings.act.mockResolvedValue({});
  mockBookings.setPref.mockResolvedValue({ prefs: MINE.prefs });
});

describe('Bookings page', () => {
  it('shows what needs me with a Confirm button', async () => {
    render(<Bookings session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockBookings.act).toHaveBeenCalledWith(7, 'confirm'));
  });

  it('the form has no length picker and shows the estimated slot as campaigns are ticked', async () => {
    render(<Bookings session={session} />);
    fireEvent.click(await screen.findByLabelText('No Mercy'));
    expect(screen.queryByLabelText('Length')).toBeNull();
    expect(screen.getByText('About 2 h for 1 campaign')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Death Toll'));
    expect(screen.getByText('About 2 h 30 for 2 campaigns')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Book the server' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('submits the campaigns without a length', async () => {
    mockBookings.create.mockResolvedValue({ id: 9 });
    const { LocationProvider } = await import('preact-iso');
    render(<LocationProvider><Bookings session={session} /></LocationProvider>);
    fireEvent.change(await screen.findByLabelText('Opponent team'), { target: { value: '1' } });
    fireEvent.input(screen.getByLabelText('Start'), { target: { value: '2026-10-02T20:00' } });
    fireEvent.click(screen.getByLabelText('No Mercy'));
    fireEvent.click(screen.getByRole('button', { name: 'Book the server' }));
    await waitFor(() => expect(mockBookings.create).toHaveBeenCalled());
    const sent = mockBookings.create.mock.calls[0][0];
    expect(sent.playlist).toEqual(['no_mercy']);
    expect('minutes' in sent).toBe(false);
    history.replaceState(null, '', '/');
  });

  it('the notification toggle posts the change', async () => {
    render(<Bookings session={session} />);
    fireEvent.click(await screen.findByLabelText('My booked server is ready'));
    await waitFor(() => expect(mockBookings.setPref).toHaveBeenCalledWith('booking_ready', false));
  });

  it('a captain with pickup bookings sees their own pickup record; "New" under 3 booked', async () => {
    mockBookings.mine.mockResolvedValue({ ...MINE, record: { shown: 1, booked: 2, noShows: 0, lateCancels: 0, excused: 0 } });
    render(<Bookings session={session} />);
    expect(await screen.findByText('Your pickup record')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    cleanup();
    mockBookings.mine.mockResolvedValue({ ...MINE, record: { shown: 4, booked: 5, noShows: 1, lateCancels: 0, excused: 0 } });
    render(<Bookings session={session} />);
    expect(await screen.findByText('Shown 4 of 5 · No-shows 1')).toBeTruthy();
  });

  it('says who sees the pickup record, by whether it is public', async () => {
    mockBookings.mine.mockResolvedValue({ ...MINE, record: { shown: 4, booked: 5, noShows: 1, lateCancels: 0, excused: 0 }, recordPublic: false });
    render(<Bookings session={session} />);
    expect(await screen.findByText(/Only you and staff see it\./)).toBeTruthy();
    cleanup();
    mockBookings.mine.mockResolvedValue({ ...MINE, record: { shown: 4, booked: 5, noShows: 1, lateCancels: 0, excused: 0 }, recordPublic: true });
    render(<Bookings session={session} />);
    expect(await screen.findByText(/Records are public, so everyone sees it as a badge on your board posts\./)).toBeTruthy();
    expect(screen.queryByText(/Only you and staff see it/)).toBeNull();
  });

  it('no pickup record section without a record', async () => {
    render(<Bookings session={session} />);
    await screen.findByRole('button', { name: 'Confirm' });
    expect(screen.queryByText('Your pickup record')).toBeNull();
  });

  it('a closed switch says so', async () => {
    const { ApiError } = await import('../api');
    mockBookings.mine.mockRejectedValue(new ApiError(404, 'not found'));
    render(<Bookings session={session} />);
    expect(await screen.findByText('Booked servers are not open yet.')).toBeTruthy();
  });
});
