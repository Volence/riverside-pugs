// web/src/routes/admin/events/StandinsPanel.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminStandinsView } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { eventStandins: vi.fn(), requestStandinFor: vi.fn(), cancelStandinFor: vi.fn(), standinMarginOff: vi.fn(), setStandinMargin: vi.fn() },
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { StandinsPanel } = await import('./StandinsPanel');

const view = (): AdminStandinsView => ({
  margin: 100, open: true,
  teams: [{ entryId: 7, name: 'Night Owls', starters: [{ steamid: 'c', name: 'cap' }, { steamid: 'a', name: 'ann' }] }],
  requests: [{
    id: 1, entryId: 7, team: 'Night Owls', out: { steamid: 'a', name: 'ann' }, scope: 'event', status: 'unfilled', asked: 2, standin: null,
    requestedAt: '2026-10-10T20:00:00.000Z', marginOff: false, margin: 100,
    offers: [{ steamid: 'z', name: 'zed', sr: 1300, answer: 'decline', offeredAt: '2026-10-10T20:00:00.000Z', expiresAt: '2026-10-10T20:10:00.000Z' }],
  }],
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('StandinsPanel', () => {
  it('shows every request with its offers and SR, and no controls for a mod', async () => {
    mockAdmin.eventStandins.mockResolvedValue(view());
    render(<StandinsPanel eventId={9} canEdit={false} />);
    expect(await screen.findByText(/Night Owls · ann · rest of the event · Nobody took it/)).toBeTruthy();
    expect(screen.getByText(/zed · SR 1300 · Declined/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an admin sets the margin, lifts the limit, cancels and asks for a team', async () => {
    mockAdmin.eventStandins.mockResolvedValue(view());
    for (const f of [mockAdmin.setStandinMargin, mockAdmin.standinMarginOff, mockAdmin.requestStandinFor, mockAdmin.cancelStandinFor]) f.mockResolvedValue({});
    render(<StandinsPanel eventId={9} canEdit />);
    await screen.findByText(/Night Owls · ann/);
    fireEvent.input(screen.getByLabelText('SR margin'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save margin' }));
    await waitFor(() => expect(mockAdmin.setStandinMargin).toHaveBeenCalledWith(9, 150));
    fireEvent.click(screen.getByRole('button', { name: 'Offer without the SR limit' }));
    await waitFor(() => expect(mockAdmin.standinMarginOff).toHaveBeenCalledWith(9, 1));
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Player'), { target: { value: 'a' } });
    fireEvent.click(screen.getByLabelText('Rest of the event'));
    fireEvent.click(screen.getByRole('button', { name: 'Ask the bench' }));
    await waitFor(() => expect(mockAdmin.requestStandinFor).toHaveBeenCalledWith(9, { entryId: 7, out: 'a', scope: 'event' }));
  });

  it('an empty margin cannot be saved as 0', async () => {
    mockAdmin.eventStandins.mockResolvedValue(view());
    render(<StandinsPanel eventId={9} canEdit />);
    await screen.findByText(/Night Owls · ann/);
    fireEvent.input(screen.getByLabelText('SR margin'), { target: { value: '' } });
    const save = screen.getByRole('button', { name: 'Save margin' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(mockAdmin.setStandinMargin).not.toHaveBeenCalled();
    fireEvent.input(screen.getByLabelText('SR margin'), { target: { value: '0' } });
    expect(save.disabled).toBe(false);
  });
});
