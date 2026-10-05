import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { StaffAppealDetail } from '../../api';

const { mock } = vi.hoisted(() => ({ mock: { get: vi.fn(), ask: vi.fn(), decide: vi.fn(), markFinal: vi.fn(), list: vi.fn() } }));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), appealStaffApi: mock }));
const { AdminAppeal } = await import('./AdminAppeal');

const detail: StaffAppealDetail = {
  id: 3, state: 'open', name: 'telltale', steamid: '76561198000000001', discordId: null, about: 'ban', filedAt: '2026-10-04T12:00:00.000Z', decidedAt: null,
  whatHappened: 'lag', whyLift: 'router', question: null, askedByName: null, askedAt: null, answer: null, answeredAt: null, answerBy: null,
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
    expect(await screen.findByText('lag')).toBeTruthy();
    for (const label of ['Ask one question', 'Accept', 'Shorten', 'Deny']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('No more appeals on this ban')).toBeNull();
  });

  it('no Ask once a question has been asked; nothing to press without canDecide', async () => {
    mock.get.mockResolvedValue({ ...detail, state: 'asked', question: 'Which map?', canDecide: false });
    render(<AdminAppeal id={3} />);
    expect(await screen.findByText('Which map?')).toBeTruthy();
    expect(screen.queryByText('Ask one question')).toBeNull();
    expect(screen.queryByText('Accept')).toBeNull();
  });
});
