import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminEventPlay, PlayMatch } from '../../../api';
import { ApiError } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { eventPlay: vi.fn(), startEvent: vi.fn(), recordEventResult: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { PlayPanel } = await import('./PlayPanel');
const { confirm } = await import('../../../components/Confirm');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const team = (id: number, name: string) => ({ id, name, tag: '', logoKey: null, seed: id, out: false });
const m = (over: Partial<PlayMatch> = {}): PlayMatch => ({
  id: 7, group: 1, round: 1, slot: 1, a: team(1, 'Rats'), b: team(2, 'Bats'), status: 'waiting', winner: null,
  scoreA: null, scoreB: null, forfeit: false, bye: false, ...over,
});
const play = (over: Partial<AdminEventPlay> = {}): AdminEventPlay => ({
  status: 'live', lockedAt: 'x', startsAt: '2026-10-10T20:00:00.000Z', seeded: 2, ...over,
  stages: over.stages ?? [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null,
    rounds: [{ group: 1, round: 1, label: 'Final', dates: null, matches: [m()] }] }],
});

describe('PlayPanel', () => {
  it('offers Start once the list is final and before the event is live', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ status: 'checkin', stages: [] }));
    mockAdmin.startEvent.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start the event now' }));
    await waitFor(() => expect(mockAdmin.startEvent).toHaveBeenCalledWith(9));
  });

  it('says why Start is not offered when the list is not final', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ status: 'registration', lockedAt: null, stages: [] }));
    render(<PlayPanel eventId={9} canEdit />);
    expect(await screen.findByText(/once the entry list is final/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('records a scored result for an open match, with no confirm for a first result', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play());
    mockAdmin.recordEventResult.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.input(await screen.findByLabelText('Rats score'), { target: { value: '1200' } });
    fireEvent.input(screen.getByLabelText('Bats score'), { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText('Winner'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save result' }));
    await waitFor(() => expect(mockAdmin.recordEventResult).toHaveBeenCalledWith(9, 7, { winner: 'a', scoreA: 1200, scoreB: 900, forfeit: false }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('disables Save until both scores are filled with a winner picked', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play());
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.change(await screen.findByLabelText('Winner'), { target: { value: 'a' } });
    fireEvent.input(screen.getByLabelText('Rats score'), { target: { value: '1200' } });
    const save = screen.getByRole('button', { name: 'Save result' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(mockAdmin.recordEventResult).not.toHaveBeenCalled();
    fireEvent.input(screen.getByLabelText('Bats score'), { target: { value: '900' } });
    expect(save.disabled).toBe(false);
  });

  it('records a forfeit without scores, and offers Correct on a finished match', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'swiss', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null,
      rounds: [{ group: 1, round: 1, label: 'Round 1', dates: null, matches: [m(), m({ id: 8, slot: 2, status: 'done', winner: 'b', scoreA: 1, scoreB: 2 })] }] }] }));
    mockAdmin.recordEventResult.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    const forfeit = (await screen.findAllByLabelText('Forfeit'))[0]!;
    fireEvent.click(forfeit);
    fireEvent.change(screen.getAllByLabelText('Winner')[0]!, { target: { value: 'b' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save result' })[0]!);
    await waitFor(() => expect(mockAdmin.recordEventResult).toHaveBeenCalledWith(9, 7, { winner: 'b', forfeit: true }));
    expect(screen.getByRole('button', { name: 'Correct' })).toBeTruthy();
  });

  it('closes the correction form and brings Correct back once a correction succeeds, with its own confirm', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null,
      rounds: [{ group: 1, round: 1, label: 'Final', dates: null, matches: [m({ status: 'done', winner: 'a', scoreA: 2, scoreB: 1 })] }] }] }));
    mockAdmin.recordEventResult.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('Winner'), { target: { value: 'b' } });
    fireEvent.input(screen.getByLabelText('Rats score'), { target: { value: '1' } });
    fireEvent.input(screen.getByLabelText('Bats score'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save result' }));
    await waitFor(() => expect(mockAdmin.recordEventResult).toHaveBeenCalledWith(9, 7, { winner: 'b', scoreA: 1, scoreB: 2, forfeit: false }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Correct' })).toBeTruthy();
    expect(screen.queryByLabelText('Winner')).toBeNull();
  });

  it('keeps the correction form open with what was typed when the save fails', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null,
      rounds: [{ group: 1, round: 1, label: 'Final', dates: null, matches: [m({ status: 'done', winner: 'a', scoreA: 2, scoreB: 1 })] }] }] }));
    mockAdmin.recordEventResult.mockRejectedValue(new ApiError(409, 'A result that later matches already depend on is refused.'));
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('Winner'), { target: { value: 'b' } });
    fireEvent.input(screen.getByLabelText('Rats score'), { target: { value: '1' } });
    fireEvent.input(screen.getByLabelText('Bats score'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save result' }));
    await waitFor(() => expect(mockAdmin.recordEventResult).toHaveBeenCalled());
    expect(await screen.findByText('A result that later matches already depend on is refused.')).toBeTruthy();
    expect(screen.getByLabelText('Winner')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
  });

  it('a mod reads matches with no controls', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play());
    render(<PlayPanel eventId={9} canEdit={false} />);
    expect(await screen.findByText('Rats')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Winner')).toBeNull();
  });
});
