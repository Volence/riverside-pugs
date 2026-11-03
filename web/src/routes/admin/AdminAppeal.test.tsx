import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { StaffAppealDetail } from '../../api';

const { mock, mockConfirm } = vi.hoisted(() => ({ mock: { get: vi.fn(), message: vi.fn(), decide: vi.fn(), markFinal: vi.fn(), list: vi.fn() }, mockConfirm: vi.fn() }));
vi.mock('../../components/Confirm', () => ({ confirm: mockConfirm }));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), appealStaffApi: mock }));
const { AdminAppeal } = await import('./AdminAppeal');

const detail: StaffAppealDetail = {
  id: 3, state: 'open', name: 'telltale', steamid: '76561198000000001', discordId: null, about: 'ban', filedAt: '2026-10-04T12:00:00.000Z', decidedAt: null,
  whatHappened: 'lag', whyLift: 'router', messages: [], answerBy: null,
  decidedByName: null, newExpiresAt: null, slurs: [],
  target: { reason: 'abandon', createdByName: 'automatic', createdAt: '2026-10-04T11:00:00.000Z', endsAt: null, ticketId: null, noAppeal: false, inForce: true },
  earlier: [], canDecide: true, canShorten: true, canMarkFinal: false,
};

beforeEach(() => { for (const f of Object.values(mock)) f.mockReset(); mockConfirm.mockReset(); mockConfirm.mockResolvedValue(true); });
afterEach(cleanup);

describe('AdminAppeal', () => {
  it('shows both answers and every control a deciding moderator has', async () => {
    mock.get.mockResolvedValue(detail);
    render(<AdminAppeal id={3} />);
    const whatHappened = await screen.findByText('lag');
    expect(whatHappened).toBeTruthy();
    expect(whatHappened.className).toContain('appeal-text');
    for (const label of ['Send to player', 'Accept', 'Shorten', 'Deny']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('No more appeals on this ban')).toBeNull();
  });

  it('shows the conversation with staff named, and staff can keep writing after the player replies', async () => {
    mock.get.mockResolvedValue({ ...detail, state: 'answered', messages: [
      { fromStaff: true, authorName: 'Hal', body: 'Which map?', at: '2026-10-04T12:00:00.000Z' },
      { fromStaff: false, authorName: null, body: 'Farm 3', at: '2026-10-04T13:00:00.000Z' },
    ] });
    mock.message.mockResolvedValue({ ok: true });
    render(<AdminAppeal id={3} />);
    expect(await screen.findByText('Which map?')).toBeTruthy();
    expect(screen.getByText('Farm 3')).toBeTruthy();
    expect(screen.getByText(/^Hal \(staff\)/)).toBeTruthy();
    fireEvent.input(screen.getByLabelText(/Message to the player/), { target: { value: 'Which round?' } });
    fireEvent.click(screen.getByText('Send to player'));
    await waitFor(() => expect(mock.message).toHaveBeenCalledWith(3, 'Which round?'));
  });

  it('nothing to press without canDecide', async () => {
    mock.get.mockResolvedValue({ ...detail, state: 'asked', canDecide: false });
    render(<AdminAppeal id={3} />);
    expect(await screen.findByText('lag')).toBeTruthy();
    expect(screen.queryByText('Send to player')).toBeNull();
    expect(screen.queryByText('Accept')).toBeNull();
  });

  // Staff asked (2026-11-03) to accept an appeal by lowering the ban to a
  // shorter length rather than lifting it.
  it('shortens a ban to a new total length counted from when it was issued', async () => {
    const issued = Date.now() - 3600_000;
    mock.get.mockResolvedValue({ ...detail, target: { ...detail.target,
      createdAt: new Date(issued).toISOString(), endsAt: new Date(issued + 7 * 86400_000).toISOString() } });
    mock.decide.mockResolvedValue({ ok: true });
    render(<AdminAppeal id={3} />);
    const select = await screen.findByRole('combobox', { name: 'Shorten the ban to' });
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent!.replace(/ in total.*/, ''));
    // 1 hour has already run out; 7 days is no shorter; Permanent never is.
    expect(options).toEqual(['Shorten to...', '6 hours', '12 hours', '1 day', '2 days', '3 days', '4 days', '5 days', 'Pick an end date']);
    fireEvent.change(select, { target: { value: '4320' } });
    fireEvent.click(screen.getByText('Shorten'));
    await waitFor(() => expect(mock.decide).toHaveBeenCalledWith(3, 'shorten', new Date(issued + 3 * 86400_000).toISOString()));
  });
});
