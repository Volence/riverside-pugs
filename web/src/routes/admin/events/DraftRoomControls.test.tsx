import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { DraftRoomView } from '../../../api';

const { mockAdmin, confirmMock } = vi.hoisted(() => ({
  mockAdmin: { draftRoom: vi.fn(), draftRoomAct: vi.fn(), draftRoomDelegate: vi.fn(), draftRoomSettings: vi.fn(), draftMode: vi.fn() },
  confirmMock: vi.fn(async () => true),
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: confirmMock }));
vi.mock('../../../hooks/useHubEvent', () => ({ useHubEvent: () => {} }));
const { DraftRoomControls } = await import('./DraftRoomControls');

const room = (over: Partial<DraftRoomView> = {}): DraftRoomView => ({
  eventId: 9, slug: 'night', eventName: 'Draft Night', status: 'ready', teamsMadeAt: null,
  settings: { firstPick: 'lowest_sr', pickSeconds: 75 }, serverNow: new Date().toISOString(), deadlineAt: null, pausedLeftMs: null, totalPicks: 6,
  order: [{ steamid: 'c1', name: 'Ann' }, { steamid: 'c2', name: 'Eve' }], onClock: null, picks: [], delegates: {},
  teams: [{ captain: { steamid: 'c1', name: 'Ann' }, players: [] }, { captain: { steamid: 'c2', name: 'Eve' }, players: [] }],
  pool: [], notes: null, me: { role: null, team: null, onClock: false, list: null, chemistry: null }, lists: { c1: [], c2: [] }, staff: true,
  ...over,
});
const running = (over: Partial<DraftRoomView> = {}) => room({
  status: 'running', deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  onClock: { pickNo: 2, round: 1, captain: 'c2', picker: 'c2' },
  picks: [{ pickNo: 1, round: 1, captain: 'c1', steamid: 'p9', name: 'Gus', auto: false, at: '2026-10-08T10:00:00.000Z' }],
  teams: [{ captain: { steamid: 'c1', name: 'Ann' }, players: [{ steamid: 'p9', name: 'Gus' }] }, { captain: { steamid: 'c2', name: 'Eve' }, players: [] }],
  ...over,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DraftRoomControls', () => {
  it('before Start: links the room, saves settings, starts with a confirm and can change the method', async () => {
    mockAdmin.draftRoom.mockResolvedValue(room());
    for (const fn of [mockAdmin.draftRoomSettings, mockAdmin.draftRoomAct, mockAdmin.draftMode]) fn.mockResolvedValue({});
    render(<DraftRoomControls eventId={9} slug="night" canEdit />);
    expect((await screen.findByRole('link', { name: 'Open the draft room' })).getAttribute('href')).toBe('/event/night/draft');
    expect(screen.getByText('Ready: captains are building their pick lists.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('First pick'), { target: { value: 'random' } });
    fireEvent.input(screen.getByLabelText('Pick clock (seconds)'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(mockAdmin.draftRoomSettings).toHaveBeenCalledWith(9, 'random', 60));
    fireEvent.click(screen.getByRole('button', { name: 'Start draft' }));
    await waitFor(() => expect(mockAdmin.draftRoomAct).toHaveBeenCalledWith(9, 'start'));
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Start the live draft?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change method' }));
    await waitFor(() => expect(mockAdmin.draftMode).toHaveBeenCalledWith(9, null));
  });

  it('while running: says who is up, pauses, undoes with a confirm and hands a team to its first pick', async () => {
    mockAdmin.draftRoom.mockResolvedValue(running());
    mockAdmin.draftRoomAct.mockResolvedValue({});
    mockAdmin.draftRoomDelegate.mockResolvedValue({});
    render(<DraftRoomControls eventId={9} slug="night" canEdit />);
    expect(await screen.findByText('Pick 2 of 6: Eve is on the clock.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(mockAdmin.draftRoomAct).toHaveBeenCalledWith(9, 'pause'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo last pick' }));
    await waitFor(() => expect(mockAdmin.draftRoomAct).toHaveBeenCalledWith(9, 'undo'));
    expect(confirmMock).toHaveBeenCalledWith('Undo the last pick? The player goes back to the pool and that pick gets a full clock.');
    expect(screen.queryByRole('button', { name: /Hand Eve's picking/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: "Hand Ann's picking to Gus" }));
    await waitFor(() => expect(mockAdmin.draftRoomDelegate).toHaveBeenCalledWith(9, 'c1', true));
  });

  it('gives picking back, resumes a paused room and resets with a confirm', async () => {
    mockAdmin.draftRoom.mockResolvedValue(running({ status: 'paused', onClock: null, deadlineAt: null, pausedLeftMs: 30_000, delegates: { c1: 'p9' } }));
    mockAdmin.draftRoomAct.mockResolvedValue({});
    mockAdmin.draftRoomDelegate.mockResolvedValue({});
    render(<DraftRoomControls eventId={9} slug="night" canEdit />);
    expect(await screen.findByText('Paused at pick 2 of 6.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Give picking back to Ann' }));
    await waitFor(() => expect(mockAdmin.draftRoomDelegate).toHaveBeenCalledWith(9, 'c1', false));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(mockAdmin.draftRoomAct).toHaveBeenCalledWith(9, 'resume'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset room' }));
    await waitFor(() => expect(mockAdmin.draftRoomAct).toHaveBeenCalledWith(9, 'reset'));
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reset the draft room?' }));
  });

  it('when done: says to publish below and still offers undo', async () => {
    mockAdmin.draftRoom.mockResolvedValue(running({ status: 'done', onClock: null, deadlineAt: null }));
    render(<DraftRoomControls eventId={9} slug="night" canEdit />);
    expect(await screen.findByText('The draft is over. Check the teams below and publish them.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo last pick' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('is read only for a mod', async () => {
    mockAdmin.draftRoom.mockResolvedValue(running());
    render(<DraftRoomControls eventId={9} slug="night" canEdit={false} />);
    expect(await screen.findByRole('link', { name: 'Open the draft room' })).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
