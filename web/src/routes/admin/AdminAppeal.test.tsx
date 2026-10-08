import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { StaffAppealDetail } from '../../api';

const { mock } = vi.hoisted(() => ({ mock: { get: vi.fn(), message: vi.fn(), decide: vi.fn(), markFinal: vi.fn(), list: vi.fn() } }));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), appealStaffApi: mock }));
const { AdminAppeal } = await import('./AdminAppeal');

const detail: StaffAppealDetail = {
  id: 3, state: 'open', name: 'telltale', steamid: '76561198000000001', discordId: null, about: 'ban', filedAt: '2026-10-04T12:00:00.000Z', decidedAt: null,
  whatHappened: 'lag', whyLift: 'router', messages: [], answerBy: null,
  decidedByName: null, newExpiresAt: null, slurs: [],
  target: { reason: 'abandon', createdByName: 'automatic', createdAt: '2026-10-04T11:00:00.000Z', endsAt: null, ticketId: null, noAppeal: false, inForce: true },
  earlier: [], canDecide: true, canShorten: true, canMarkFinal: false,
};

beforeEach(() => { for (const f of Object.values(mock)) f.mockReset(); });
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
});
