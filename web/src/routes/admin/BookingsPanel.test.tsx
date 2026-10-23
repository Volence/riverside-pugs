import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminBookingRow } from '../../api';

const { mockAdmin, mockConfirm } = vi.hoisted(() => ({
  mockAdmin: { bookings: vi.fn(), cancelBooking: vi.fn(), extendBooking: vi.fn(), endBooking: vi.fn() },
  mockConfirm: vi.fn(),
}));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../components/Confirm', () => ({ confirm: mockConfirm }));
const { BookingsPanel, endReasonText } = await import('./BookingsPanel');

const ROW: AdminBookingRow = {
  id: 4, purpose: 'scrim', state: 'active', ending: false, startsAt: '2026-10-02T20:00:00.000Z', endsAt: '2026-10-02T22:00:00.000Z',
  aName: 'Rats', bName: "p1's group", server: 'Riverside #3', peak: { a: 4, b: 3 }, endReason: null,
  toxic: { a: false, b: false }, eventId: null,
};

afterEach(cleanup);
beforeEach(() => { for (const fn of [...Object.values(mockAdmin), mockConfirm]) fn.mockReset(); });

describe('BookingsPanel', () => {
  it('lists bookings with their server and turnout, with Cancel, +1 campaign and End', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [ROW] });
    render(<BookingsPanel nudge={0} />);
    expect(await screen.findByText("Rats vs p1's group")).toBeTruthy();
    expect(screen.getByText('Riverside #3')).toBeTruthy();
    expect(screen.getByText('4 / 3')).toBeTruthy();
    for (const name of ['Cancel', '+1 campaign', 'End']) expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('a tournament booking has no Cancel, +1 campaign or End: it links to its event desk and shows no booked end', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [{ ...ROW, purpose: 'tournament', eventId: 3 }] });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText("Rats vs p1's group");
    for (const name of ['Cancel', '+1 campaign', 'End']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByRole('link', { name: 'Event desk' }).getAttribute('href')).toBe('/admin/events/3');
    expect(screen.getByText(/^From /)).toBeTruthy();
  });

  it('Cancel asks first, then cancels', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [ROW] });
    mockConfirm.mockResolvedValue(true);
    mockAdmin.cancelBooking.mockResolvedValue({ ok: true });
    render(<BookingsPanel nudge={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(mockAdmin.cancelBooking).toHaveBeenCalledWith(4, ''));
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('renders nothing with no bookings', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [] });
    const { container } = render(<BookingsPanel nudge={0} />);
    await waitFor(() => expect(mockAdmin.bookings).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('shows a Toxic tags chip only on flagged sides (plan 2 Ruling 6)', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [{ ...ROW, toxic: { a: true, b: false } }] });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText("Rats vs p1's group");
    const chips = screen.getAllByText('Toxic tags');
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute('title')).toBe('Rats: repeated toxic tags');
  });

  it('has no Toxic tags chip for a clean booking', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [ROW] });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText("Rats vs p1's group");
    expect(screen.queryByText('Toxic tags')).toBeNull();
  });

  it('shows each booking\'s priority, the scrim cap line and a bumped scrim (server priority Ruling 9)', async () => {
    mockAdmin.bookings.mockResolvedValue({
      bookings: [
        ROW,
        { ...ROW, id: 5, purpose: 'tournament', aName: 'Owls', bName: 'Rats', state: 'scheduled', server: null },
        { ...ROW, id: 6, aName: 'Owls', bName: "p1's group", state: 'cancelled', endReason: 'bumped', server: null },
      ],
      priority: { scrimMax: 2, pugReserve: 2, regions: [{ region: 'na', scrimsHolding: 1 }] },
    });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText('Owls vs Rats');
    expect(screen.getByText('Match')).toBeTruthy();
    expect(screen.getAllByText('Scrim')).toHaveLength(2);
    expect(screen.getByTestId('booking-priority').textContent).toBe('Priority: Match, then Scrim, then PUG, then practice and side games. Scrims hold 1 of 2 servers they may hold at once; 2 always left for PUGs. A match with no free server bumps a scrim that has not started.');
    const bumped = screen.getByText('bumped by a match');
    expect(bumped.closest('td')!.textContent).toBe('Cancelled bumped by a match');
    // Both the scrim (ROW, active) and the scheduled tournament match are
    // still open, so each still gets its own +1 campaign button; queryByRole
    // throws on more than one match, so this checks for at least one instead.
    expect(screen.queryAllByRole('button', { name: '+1 campaign' })[0]).toBeTruthy();
  });

  it('with more than one region, counts scrims against the cap per region (final review minor)', async () => {
    mockAdmin.bookings.mockResolvedValue({
      bookings: [ROW],
      priority: { scrimMax: 2, pugReserve: 2, regions: [{ region: 'eu', scrimsHolding: 0 }, { region: 'na', scrimsHolding: 2 }] },
    });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText("Rats vs p1's group");
    expect(screen.getByTestId('booking-priority').textContent).toBe('Priority: Match, then Scrim, then PUG, then practice and side games. Scrims hold 0 of 2 servers they may hold at once in EU, 2 of 2 in NA; 2 always left for PUGs. A match with no free server bumps a scrim that has not started.');
  });

  it('shows no priority line when the answer carries none', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [ROW] });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText("Rats vs p1's group");
    expect(screen.queryByTestId('booking-priority')).toBeNull();
  });

  it('names every end reason in words, as a state chip then the reason', async () => {
    mockAdmin.bookings.mockResolvedValue({
      bookings: [
        { ...ROW, id: 7, aName: 'Idle', state: 'ended', endReason: 'idle' },
        { ...ROW, id: 8, aName: 'Timed', state: 'ended', endReason: 'time' },
        { ...ROW, id: 9, aName: 'Gone', state: 'no_show', endReason: 'no_show' },
        { ...ROW, id: 10, aName: 'Odd', state: 'cancelled', endReason: 'some_new_code' },
      ],
    });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText("Idle vs p1's group");
    const cell = (name: string) => screen.getByText(`${name} vs p1's group`).closest('tr')!.querySelectorAll('td')[2];
    expect(cell('Idle').textContent).toBe('Over nobody was on it');
    expect(cell('Idle').querySelector('.teamchip.teamchip--ended')).toBeTruthy();
    expect(cell('Timed').textContent).toBe('Over time ran out');
    // A no-show's reason would only repeat the chip.
    expect(cell('Gone').textContent).toBe('No-show');
    expect(cell('Odd').textContent).toBe('Cancelled some new code');
    expect(endReasonText('setup_failed')).toBe('setup failed');
  });
});
