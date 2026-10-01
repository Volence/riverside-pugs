import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';

const { mockBookings } = vi.hoisted(() => ({ mockBookings: { get: vi.fn(), act: vi.fn(), cancel: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, bookingsApi: mockBookings };
});
const { Booking } = await import('./Booking');

const VIEW = (over: Record<string, unknown> = {}) => ({
  id: 7, purpose: 'scrim', state: 'ready', ending: false, startsAt: '2026-10-02T20:00:00.000Z', endsAt: '2026-10-02T22:00:00.000Z',
  extendedMinutes: 0, extendMinutes: 30, createdAt: '2026-10-01T12:00:00.000Z', playlist: [{ slug: 'no_mercy', name: 'No Mercy' }], rules: null,
  gameConfig: { key: 'standard', label: 'Standard' }, server: { name: 'Riverside #3' },
  connect: { host: '1.2.3.4', port: 27015, password: 'abcd2345' }, cancel: null, endReason: null, noShowFrom: '2026-10-02T20:15:00.000Z',
  sides: [
    { side: 'a', name: "p0's group", team: null, captain: { steamid: 'x0', name: 'p0' }, confirmed: true, peakPresent: 0, noShow: false, people: [{ steamid: 'x0', name: 'p0', avatar: null, role: 'player', status: 'accepted' }] },
    { side: 'b', name: 'Mice', team: { id: 1, slug: 'mice', name: 'Mice', tag: 'MM', logoKey: null }, captain: { steamid: 'x1', name: 'p1' }, confirmed: true, peakPresent: 0, noShow: false, people: [] },
  ],
  viewer: { side: 'a', manages: ['a'], staff: false, invited: false },
  ...over,
});
const session = { kind: 'active', me: { steamid: 'x0', name: 'p0', avatar: null, status: 'active', isAdmin: false, teams: true } } as never;

afterEach(() => { cleanup(); for (const f of Object.values(mockBookings)) f.mockReset(); });
beforeEach(() => { mockBookings.get.mockResolvedValue(VIEW()); });

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
});
