// web/src/routes/event/StandinPanel.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MyStandinView } from '../../api';

const { mockEvents } = vi.hoisted(() => ({ mockEvents: { standins: vi.fn(), requestStandin: vi.fn(), cancelStandin: vi.fn(), answerStandin: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
vi.mock('../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { confirm } = await import('../../components/Confirm');
const { StandinPanel } = await import('./StandinPanel');

const captain = (over: Partial<NonNullable<MyStandinView['captain']>> = {}): MyStandinView['captain'] => ({
  entryId: 7, team: 'Night Owls', open: true, canMatch: true, requests: [],
  starters: [{ steamid: 'c', name: 'cap', captain: true }, { steamid: 'a', name: 'ann', captain: false }, { steamid: 'b', name: 'bob', captain: false }, { steamid: 'd', name: 'dee', captain: false }],
  ...over,
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('StandinPanel', () => {
  it('shows nothing to a player with no offer who captains nothing', async () => {
    mockEvents.standins.mockResolvedValue({ offer: null, captain: null });
    const { container } = render(<StandinPanel slug="cup" />);
    await waitFor(() => expect(mockEvents.standins).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('a bench player accepts or declines their offer', async () => {
    mockEvents.standins.mockResolvedValue({ offer: { offerId: 5, team: 'Night Owls', out: 'ann', scope: 'match', expiresAt: '2026-10-10T20:10:00.000Z' }, captain: null });
    mockEvents.answerStandin.mockResolvedValue({ ok: true });
    render(<StandinPanel slug="cup" />);
    expect(await screen.findByText(/Night Owls needs a stand-in for ann \(next match\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(mockEvents.answerStandin).toHaveBeenCalledWith('cup', 5, true));
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(mockEvents.answerStandin).toHaveBeenCalledWith('cup', 5, false));
  });

  it('a captain asks for the next match without a confirm, and for the rest of the event behind one', async () => {
    mockEvents.standins.mockResolvedValue({ offer: null, captain: captain() });
    mockEvents.requestStandin.mockResolvedValue({ requestId: 1 });
    render(<StandinPanel slug="cup" />);
    await screen.findByRole('heading', { name: 'Stand-ins' });
    fireEvent.change(screen.getByLabelText('Player'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask the bench' }));
    await waitFor(() => expect(mockEvents.requestStandin).toHaveBeenCalledWith('cup', { entryId: 7, out: 'a', scope: 'match' }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Rest of the event (they left)'));
    fireEvent.click(screen.getByRole('button', { name: 'Ask the bench' }));
    await waitFor(() => expect(mockEvents.requestStandin).toHaveBeenCalledWith('cup', { entryId: 7, out: 'a', scope: 'event' }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'ann has left the team?' }));
  });

  it('with no match left only the rest of the event is offered', async () => {
    mockEvents.standins.mockResolvedValue({ offer: null, captain: captain({ canMatch: false }) });
    render(<StandinPanel slug="cup" />);
    await screen.findByRole('heading', { name: 'Stand-ins' });
    expect((screen.getByLabelText('Next match') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Rest of the event (they left)') as HTMLInputElement).checked).toBe(true);
  });

  it('lists requests with their status, how many were asked, the stand-in once found, and Cancel on an open one', async () => {
    mockEvents.standins.mockResolvedValue({ offer: null, captain: captain({ requests: [
      { id: 1, out: { steamid: 'a', name: 'ann' }, scope: 'match', status: 'open', asked: 2, standin: null, requestedAt: 'x', marginOff: false },
      { id: 2, out: { steamid: 'b', name: 'bob' }, scope: 'event', status: 'filled', asked: 1, standin: 'zed', requestedAt: 'x', marginOff: false },
    ] }) });
    mockEvents.cancelStandin.mockResolvedValue({ ok: true });
    render(<StandinPanel slug="cup" />);
    expect(await screen.findByText(/ann · next match · Asking the bench \(2 asked\)/)).toBeTruthy();
    expect(screen.getByText(/bob · rest of the event · zed stands in/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the stand-in for ann' }));
    await waitFor(() => expect(mockEvents.cancelStandin).toHaveBeenCalledWith('cup', 1));
  });
});
