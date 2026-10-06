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
const { BookingsPanel } = await import('./BookingsPanel');

const ROW: AdminBookingRow = {
  id: 4, purpose: 'scrim', state: 'active', ending: false, startsAt: '2026-10-02T20:00:00.000Z', endsAt: '2026-10-02T22:00:00.000Z',
  aName: 'Rats', bName: "p1's group", server: 'Riverside #3', peak: { a: 4, b: 3 }, endReason: null,
  toxic: { a: false, b: false },
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
      priority: { scrimMax: 2, scrimsHolding: 1, pugReserve: 2 },
    });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText('Owls vs Rats');
    expect(screen.getByText('Match')).toBeTruthy();
    expect(screen.getAllByText('Scrim')).toHaveLength(2);
    expect(screen.getByTestId('booking-priority').textContent).toBe('Priority: Match, then Scrim, then PUG, then practice and side games. Scrims hold 1 of 2 servers they may hold at once; 2 always left for PUGs. A match with no free server bumps a scrim that has not started.');
    expect(screen.getByText('cancelled (bumped by a match)')).toBeTruthy();
    // Both the scrim (ROW, active) and the scheduled tournament match are
    // still open, so each still gets its own +1 campaign button; queryByRole
    // throws on more than one match, so this checks for at least one instead.
    expect(screen.queryAllByRole('button', { name: '+1 campaign' })[0]).toBeTruthy();
  });

  it('shows no priority line when the answer carries none', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [ROW] });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText("Rats vs p1's group");
    expect(screen.queryByTestId('booking-priority')).toBeNull();
  });
});
