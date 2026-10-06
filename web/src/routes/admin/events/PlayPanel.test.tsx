import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminEventPlay, PlayMatch } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { eventPlay: vi.fn(), startEvent: vi.fn(), recordEventResult: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { PlayPanel } = await import('./PlayPanel');

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

  it('records a scored result for an open match', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play());
    mockAdmin.recordEventResult.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.input(await screen.findByLabelText('Rats score'), { target: { value: '1200' } });
    fireEvent.input(screen.getByLabelText('Bats score'), { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText('Winner'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save result' }));
    await waitFor(() => expect(mockAdmin.recordEventResult).toHaveBeenCalledWith(9, 7, { winner: 'a', scoreA: 1200, scoreB: 900, forfeit: false }));
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

  it('a mod reads matches with no controls', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play());
    render(<PlayPanel eventId={9} canEdit={false} />);
    expect(await screen.findByText('Rats')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Winner')).toBeNull();
  });
});
