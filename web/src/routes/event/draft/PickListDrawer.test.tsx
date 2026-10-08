// web/src/routes/event/draft/PickListDrawer.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { PlayerCardView } from '../../../api';

const { mockEvents } = vi.hoisted(() => ({ mockEvents: { draftCards: vi.fn(), draftList: vi.fn(), saveDraftList: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
const { PickListDrawer } = await import('./PickListDrawer');
const { ApiError } = await import('../../../api');

const card = (steamid: string, name: string, sr: number) => ({ steamid, name, sr } as PlayerCardView);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PickListDrawer', () => {
  it('reorders, removes, adds and saves the list in order', async () => {
    mockEvents.draftCards.mockResolvedValue({ cards: [card('p1', 'Bob', 1200), card('p2', 'Cy', 1350), card('p3', 'Di', 1100)], notes: {}, chemistry: null });
    mockEvents.draftList.mockResolvedValue({ list: ['p1', 'p2'] });
    mockEvents.saveDraftList.mockResolvedValue({ list: ['p2', 'p3'] });
    render(<PickListDrawer slug="night" onClose={() => {}} />);
    expect(await screen.findByText('1. Bob')).toBeTruthy();
    expect(screen.getByText(/used if captains pick live/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move Cy up' }));
    expect(screen.getByText('1. Cy')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob' }));
    fireEvent.change(screen.getByLabelText('Add a player'), { target: { value: 'p3' } });
    expect(screen.getByText('2. Di')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));
    await waitFor(() => expect(mockEvents.saveDraftList).toHaveBeenCalledWith('night', ['p2', 'p3']));
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('shows the server sentence when saving is refused', async () => {
    mockEvents.draftCards.mockResolvedValue({ cards: [card('p1', 'Bob', 1200)], notes: {}, chemistry: null });
    mockEvents.draftList.mockResolvedValue({ list: [] });
    mockEvents.saveDraftList.mockRejectedValue(new ApiError(409, 'The draft is over, so pick lists no longer change.'));
    render(<PickListDrawer slug="night" onClose={() => {}} />);
    await screen.findByLabelText('Add a player'); // Save is disabled until the cards load
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The draft is over, so pick lists no longer change.');
  });
});
