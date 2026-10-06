import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { AdminEventPlay, PlayMatch } from '../../../api';
import { ApiError } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: {
    eventPlay: vi.fn(), startEvent: vi.fn(), recordEventResult: vi.fn(),
    openEventRoom: vi.fn(), resetEventRoom: vi.fn(), holdEventMatch: vi.fn(),
    actForTeam: vi.fn(), reopenEventVeto: vi.fn(), replayEventChapter: vi.fn(), moveEventServer: vi.fn(),
    extendEventGrace: vi.fn(), releaseEventHold: vi.fn(), freezeEventMatch: vi.fn(), unfreezeEventMatch: vi.fn(),
    setEventMatchTime: vi.fn(),
  },
}));
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
  scoreA: null, scoreB: null, forfeit: false, bye: false, phase: 'waiting', scheduledAt: null, scheduleSource: null, ...over,
});
const play = (over: Partial<AdminEventPlay> = {}): AdminEventPlay => ({
  status: 'live', lockedAt: 'x', startsAt: '2026-10-10T20:00:00.000Z', seeded: 2, ...over,
  stages: over.stages ?? [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null, pairsAsItGoes: false,
    rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [m()] }] }],
});

const twoMatches = () => play({
  stages: [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null, pairsAsItGoes: false,
    rounds: [{ group: 1, round: 1, label: 'Semifinals', dates: null, defaultAt: null, window: null, matches: [
      m(),
      m({ id: 8, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'lineup', phase: 'lineup' }),
      m({ id: 9, slot: 3, a: team(5, 'Emus'), b: team(6, 'Foxes'), status: 'live', phase: 'live' }),
    ] }] }],
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

  it('records a scored result for an open match after confirming the winner and score', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play());
    mockAdmin.recordEventResult.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.input(await screen.findByLabelText('Rats score'), { target: { value: '1200' } });
    fireEvent.input(screen.getByLabelText('Bats score'), { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText('Winner'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save result' }));
    await waitFor(() => expect(mockAdmin.recordEventResult).toHaveBeenCalledWith(9, 7, { winner: 'a', scoreA: 1200, scoreB: 900, forfeit: false }));
    expect(confirm).toHaveBeenCalledWith({ title: 'Rats wins 1200 : 900?' });
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
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'swiss', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null, pairsAsItGoes: true,
      rounds: [{ group: 1, round: 1, label: 'Round 1', dates: null, defaultAt: null, window: null, matches: [m(), m({ id: 8, slot: 2, status: 'done', winner: 'b', scoreA: 1, scoreB: 2 })] }] }] }));
    mockAdmin.recordEventResult.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    const forfeit = (await screen.findAllByLabelText('Forfeit'))[0]!;
    fireEvent.click(forfeit);
    fireEvent.change(screen.getAllByLabelText('Winner')[0]!, { target: { value: 'b' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save result' })[0]!);
    await waitFor(() => expect(mockAdmin.recordEventResult).toHaveBeenCalledWith(9, 7, { winner: 'b', forfeit: true }));
    expect(confirm).toHaveBeenCalledWith({ title: 'Bats wins by forfeit?' });
    expect(screen.getByRole('button', { name: 'Correct' })).toBeTruthy();
  });

  it('closes the correction form and brings Correct back once a correction succeeds, with its own confirm', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [m({ status: 'done', winner: 'a', scoreA: 2, scoreB: 1 })] }] }] }));
    mockAdmin.recordEventResult.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('Winner'), { target: { value: 'b' } });
    fireEvent.input(screen.getByLabelText('Rats score'), { target: { value: '1' } });
    fireEvent.input(screen.getByLabelText('Bats score'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save result' }));
    await waitFor(() => expect(mockAdmin.recordEventResult).toHaveBeenCalledWith(9, 7, { winner: 'b', scoreA: 1, scoreB: 2, forfeit: false }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith({ title: 'Bats wins 1 : 2?', body: expect.stringContaining('This changes the result of Rats vs Bats.') });
    expect(screen.getByRole('button', { name: 'Correct' })).toBeTruthy();
    expect(screen.queryByLabelText('Winner')).toBeNull();
  });

  it('keeps the correction form open with what was typed when the save fails', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [m({ status: 'done', winner: 'a', scoreA: 2, scoreB: 1 })] }] }] }));
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

  it('names each team in its score box', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play());
    render(<PlayPanel eventId={9} canEdit />);
    expect((await screen.findByLabelText('Rats score')).getAttribute('placeholder')).toBe('Rats');
    expect(screen.getByLabelText('Bats score').getAttribute('placeholder')).toBe('Bats');
  });

  it('hides Correct where the server would refuse it: a paired-as-it-goes round with a later round, and a forfeit against an out team', async () => {
    const done = m({ status: 'done', winner: 'a', scoreA: 2, scoreB: 1 });
    const later = { group: 1, round: 2, label: 'Round 2', dates: null, defaultAt: null, window: null, matches: [m({ id: 9, round: 2 })] };
    const table = (pairsAsItGoes: boolean) => play({ stages: [{ ordinal: 1, type: pairsAsItGoes ? 'swiss' : 'league', status: 'live', layout: 'table',
      groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null, pairsAsItGoes,
      rounds: [{ group: 1, round: 1, label: 'Round 1', dates: null, defaultAt: null, window: null, matches: [done] }, later] }] });
    mockAdmin.eventPlay.mockResolvedValue(table(true));
    render(<PlayPanel eventId={9} canEdit />);
    await screen.findAllByLabelText('Winner');
    expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
    cleanup();

    mockAdmin.eventPlay.mockResolvedValue(table(false));
    render(<PlayPanel eventId={9} canEdit />);
    expect(await screen.findByRole('button', { name: 'Correct' })).toBeTruthy();
    cleanup();

    const out = { ...team(2, 'Bats'), out: true };
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [m({ b: out, status: 'forfeit', winner: 'a', forfeit: true })] }] }] }));
    render(<PlayPanel eventId={9} canEdit />);
    expect(await screen.findByText(/forfeit, Rats wins/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
  });

  it('labels a third place match once, not "Third place, Third place"', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket',
      groups: [{ number: 1, label: 'Bracket' }, { number: 2, label: 'Third place' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 2, label: 'Final', dates: null, defaultAt: null, window: null, matches: [m()] }, { group: 2, round: 1, label: 'Third place', dates: null, defaultAt: null, window: null, matches: [m({ id: 8, group: 2 })] }] }] }));
    render(<PlayPanel eventId={9} canEdit={false} />);
    expect(await screen.findByText('Third place')).toBeTruthy();
    expect(screen.getByText('Bracket, Final')).toBeTruthy();
    expect(screen.queryByText(/Third place, Third place/)).toBeNull();
  });

  it('tells the editor after a successful Start, so the rest of the page refreshes', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ status: 'checkin', stages: [] }));
    mockAdmin.startEvent.mockResolvedValue({});
    const onChange = vi.fn();
    render(<PlayPanel eventId={9} canEdit onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start the event now' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    cleanup();
    mockAdmin.startEvent.mockRejectedValue(new ApiError(409, 'An elimination bracket is always the last stage.'));
    const quiet = vi.fn();
    render(<PlayPanel eventId={9} canEdit onChange={quiet} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start the event now' }));
    expect(await screen.findByText('An elimination bracket is always the last stage.')).toBeTruthy();
    expect(quiet).not.toHaveBeenCalled();
  });

  it('opens a waiting match\'s room, and resets or holds an open one (plan T3a)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(twoMatches());
    for (const f of [mockAdmin.openEventRoom, mockAdmin.resetEventRoom, mockAdmin.holdEventMatch]) f.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open room: Rats vs Bats' }));
    await waitFor(() => expect(mockAdmin.openEventRoom).toHaveBeenCalledWith(9, 7));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset room: Cats vs Dogs' }));
    await waitFor(() => expect(mockAdmin.resetEventRoom).toHaveBeenCalledWith(9, 8));
    fireEvent.click(await screen.findByRole('button', { name: 'Hold: Cats vs Dogs' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Hold reason' }), { target: { value: 'Server trouble' } });
    fireEvent.click(screen.getByRole('button', { name: 'Put on hold' }));
    await waitFor(() => expect(mockAdmin.holdEventMatch).toHaveBeenCalledWith(9, 8, 'Server trouble'));
  });

  it('offers the result form on a match in a room phase, and no room buttons to a mod (plan T3a)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(twoMatches());
    render(<PlayPanel eventId={9} canEdit />);
    expect(await screen.findByLabelText('Cats score')).toBeTruthy();
    cleanup();
    render(<PlayPanel eventId={9} canEdit={false} />);
    await screen.findByText('Semifinals');
    expect(screen.queryByRole('button', { name: /Open room|Reset room|Hold:/ })).toBeNull();
  });

  it('asks before resetting a room that holds a server, and offers Hold and a result there (plan T3b)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(twoMatches());
    mockAdmin.resetEventRoom.mockResolvedValue({});
    const ask = confirm as Mock;
    ask.mockResolvedValueOnce(false);
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset room: Emus vs Foxes' }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('cancels the match\'s server booking') })));
    expect(mockAdmin.resetEventRoom).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset room: Emus vs Foxes' }));
    await waitFor(() => expect(mockAdmin.resetEventRoom).toHaveBeenCalledWith(9, 9));
    expect(screen.getByText(/Live/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hold: Emus vs Foxes' })).toBeTruthy();
    expect(screen.getByLabelText('Emus score')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset room: Cats vs Dogs' }));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining('Ready, veto and lineups are cleared') })));
  });

  const desk = (over: Partial<NonNullable<PlayMatch['desk']>> = {}): NonNullable<PlayMatch['desk']> => ({
    holdReason: null, holdFrom: null, dispute: null, frozen: false, graceEndsAt: null, booking: null, liveGame: null, subs: { a: 0, b: 0 }, schedule: null, ...over,
  });

  it('shows the hold reason, the dispute and the freeze on the desk (plan T3c)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [
      m({ status: 'admin_hold', phase: 'hold', desk: desk({ holdReason: 'dispute', holdFrom: 'confirming', dispute: { side: 'b', byName: 'Bob', reason: 'They had five', at: '2026-10-10T21:00:00.000Z' } }) }),
      m({ id: 8, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'live', phase: 'live', desk: desk({ frozen: true, subs: { a: 1, b: 0 } }) }),
    ] }] }] }));
    render(<PlayPanel eventId={9} canEdit={false} />);
    expect(await screen.findByText(/On hold \(dispute, from Confirming\)/)).toBeTruthy();
    expect(screen.getByText(/Disputed by Bob for Bats: They had five/)).toBeTruthy();
    expect(screen.getByText(/Frozen by staff/)).toBeTruthy();
    expect(screen.getByText(/Subs: Cats 1, Dogs 0/)).toBeTruthy();
    expect(screen.queryByText(/Staff tools/)).toBeNull();
  });

  it('offers the tools an admin may use in each phase and calls the right routes (plan T3c)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [
      m({ status: 'live', phase: 'live', desk: desk({ liveGame: { matchId: 44, campaign: 'no_mercy', chapters: [{ ordinal: 0, map: 'l4d_vs_hospital01_apartment' }, { ordinal: 1, map: 'l4d_vs_hospital02_subway' }] } }) }),
    ] }] }] }));
    for (const fn of Object.values(mockAdmin)) if (fn !== mockAdmin.eventPlay) (fn as Mock).mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    fireEvent.click(screen.getByRole('button', { name: 'Freeze' }));
    await waitFor(() => expect(mockAdmin.freezeEventMatch).toHaveBeenCalledWith(9, 7));
    fireEvent.change(screen.getByLabelText('Chapter to replay'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replay chapter' }));
    await waitFor(() => expect(mockAdmin.replayEventChapter).toHaveBeenCalledWith(9, 7, 1));
    expect(await screen.findByText('Replay started; the result will appear in the staff feed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move server' }));
    await waitFor(() => expect(mockAdmin.moveEventServer).toHaveBeenCalledWith(9, 7));
    fireEvent.change(screen.getByLabelText('Act as'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText('Veto step'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Veto action'), { target: { value: 'pick' } });
    fireEvent.input(screen.getByLabelText('Campaign'), { target: { value: 'dead_air' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take the veto step' }));
    await waitFor(() => expect(mockAdmin.actForTeam).toHaveBeenCalledWith(9, 7, { kind: 'veto', side: 'b', step: 7, action: 'pick', campaign: 'dead_air' }));
    expect(screen.queryByRole('button', { name: 'Extend grace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release hold' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reopen veto' })).toBeNull();
    expect(confirm).toHaveBeenCalled();
  });

  it('offers Extend grace in connect, Release hold on a hold, and Reopen veto before a game (plan T3c)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [
      m({ status: 'connect', phase: 'connect', desk: desk({ graceEndsAt: '2026-10-10T21:00:00.000Z' }) }),
      m({ id: 8, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'admin_hold', phase: 'hold', desk: desk({ holdReason: 'no_show_both', holdFrom: 'connect' }) }),
      m({ id: 9, slot: 3, a: team(5, 'Emus'), b: team(6, 'Foxes'), status: 'lineup', phase: 'lineup', desk: desk() }),
    ] }] }] }));
    for (const fn of Object.values(mockAdmin)) if (fn !== mockAdmin.eventPlay) (fn as Mock).mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    fireEvent.input(screen.getByLabelText('Minutes'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Extend grace' }));
    await waitFor(() => expect(mockAdmin.extendEventGrace).toHaveBeenCalledWith(9, 7, 10));
    fireEvent.click(screen.getByText('Staff tools: Cats vs Dogs'));
    fireEvent.click(screen.getByRole('button', { name: 'Release hold' }));
    await waitFor(() => expect(mockAdmin.releaseEventHold).toHaveBeenCalledWith(9, 8));
    fireEvent.click(screen.getByText('Staff tools: Emus vs Foxes'));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen veto' }));
    await waitFor(() => expect(mockAdmin.reopenEventVeto).toHaveBeenCalledWith(9, 9));
    fireEvent.input(screen.getByLabelText('Four SteamID64s'), { target: { value: '76561199000000821 76561199000000822, 76561199000000823 76561199000000824' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lock the lineup' }));
    await waitFor(() => expect(mockAdmin.actForTeam).toHaveBeenCalledWith(9, 9, { kind: 'lineup', side: 'a', steamids: ['76561199000000821', '76561199000000822', '76561199000000823', '76561199000000824'] }));
  });
  it('points a hold over an aborted or lost game at the result or a reset, with no Release hold (plan T3c final review)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [
      m({ status: 'admin_hold', phase: 'hold', desk: desk({ holdReason: 'game_aborted', holdFrom: 'live' }) }),
      m({ id: 8, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'admin_hold', phase: 'hold', desk: desk({ holdReason: 'game_lost', holdFrom: 'live' }) }),
    ] }] }] }));
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    expect(screen.getByText(/The game on the server was aborted or lost: enter the result, or reset the room/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Release hold' })).toBeNull();
    fireEvent.click(screen.getByText('Staff tools: Cats vs Dogs'));
    expect(screen.queryByRole('button', { name: 'Release hold' })).toBeNull();
  });

  it('says a freeze in ready-up lands when the next half goes live (plan T3c final review)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [
      m({ status: 'connect', phase: 'connect', desk: desk() }),
      m({ id: 8, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'live', phase: 'live', desk: desk() }),
    ] }] }] }));
    mockAdmin.freezeEventMatch.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    fireEvent.click(screen.getByRole('button', { name: 'Freeze' }));
    await waitFor(() => expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining('the pause lands when the next half goes live') })));
    fireEvent.click(screen.getByText('Staff tools: Cats vs Dogs'));
    fireEvent.click(screen.getByRole('button', { name: 'Freeze' }));
    await waitFor(() => expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.not.stringContaining('next half') })));
  });

  it('shows no staff tools on a match where none applies, as one being confirmed (plan T3c Task 9 review)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [
      m({ status: 'confirming', phase: 'confirming', desk: desk() }),
    ] }] }] }));
    render(<PlayPanel eventId={9} canEdit />);
    expect(await screen.findByRole('button', { name: 'Reset room: Rats vs Bats' })).toBeTruthy();
    expect(screen.queryByText(/Staff tools/)).toBeNull();
  });

  it('keeps one match\'s tools open per panel, leaving another panel\'s open tools alone (plan T3c Task 9 review)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [
      m({ status: 'live', phase: 'live', desk: desk() }),
      m({ id: 8, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'connect', phase: 'connect', desk: desk() }),
    ] }] }] }));
    const one = render(<PlayPanel eventId={9} canEdit />).container as HTMLElement;
    const two = render(<PlayPanel eventId={9} canEdit />).container as HTMLElement;
    const summary = async (root: HTMLElement, text: string) => within(root).findByText(text);
    const details = (el: HTMLElement) => el.closest('details') as HTMLDetailsElement;
    const twoRats = await summary(two, 'Staff tools: Rats vs Bats');
    details(twoRats).open = true;
    fireEvent(details(twoRats), new Event('toggle'));
    const oneRats = await summary(one, 'Staff tools: Rats vs Bats');
    details(oneRats).open = true;
    fireEvent(details(oneRats), new Event('toggle'));
    const oneCats = await summary(one, 'Staff tools: Cats vs Dogs');
    details(oneCats).open = true;
    fireEvent(details(oneCats), new Event('toggle'));
    await waitFor(() => expect(details(oneRats).open).toBe(false));
    expect(details(oneCats).open).toBe(true);
    expect(details(twoRats).open).toBe(true);
  });

  it('shows a window match\'s time, window and open proposal, and sets a time (plan T4)', async () => {
    const desk2 = {
      holdReason: null, holdFrom: null, dispute: null, frozen: false, graceEndsAt: null, booking: null, liveGame: null, subs: { a: 0, b: 0 },
      schedule: { windowStart: '2026-10-12T00:00:00.000Z', windowEnd: '2026-10-18T23:59:59.000Z', proposal: { side: 'b' as const, byName: 'bob', time: '2026-10-16T20:00:00.000Z', autoAcceptAt: null }, proposals: 2 },
    };
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'league', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Week 1', dates: null, defaultAt: null, window: null, matches: [m({ scheduledAt: '2026-10-14T21:00:00.000Z', scheduleSource: 'default', desk: desk2 })] }] }] }));
    mockAdmin.setEventMatchTime.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit slug="cup" />);
    expect((await screen.findByText(/Proposal open: bob \(Bats\)/)).textContent).toContain('2 proposals');
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    fireEvent.input(screen.getByLabelText('Match time'), { target: { value: '2026-10-17T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set time' }));
    await waitFor(() => expect(mockAdmin.setEventMatchTime).toHaveBeenCalledWith(9, 7, new Date('2026-10-17T21:00').toISOString()));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect((screen.getByLabelText('Match time') as HTMLInputElement).value).toBe(''));
  });

  it('shows "1 proposal" in the singular (plan T4 review)', async () => {
    const desk2 = {
      holdReason: null, holdFrom: null, dispute: null, frozen: false, graceEndsAt: null, booking: null, liveGame: null, subs: { a: 0, b: 0 },
      schedule: { windowStart: '2026-10-12T00:00:00.000Z', windowEnd: '2026-10-18T23:59:59.000Z', proposal: { side: 'b' as const, byName: 'bob', time: '2026-10-16T20:00:00.000Z', autoAcceptAt: null }, proposals: 1 },
    };
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'league', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Week 1', dates: null, defaultAt: null, window: null, matches: [m({ desk: desk2 })] }] }] }));
    render(<PlayPanel eventId={9} canEdit slug="cup" />);
    expect((await screen.findByText(/Proposal open: bob \(Bats\)/)).textContent).toContain('1 proposal');
    expect((await screen.findByText(/Proposal open: bob \(Bats\)/)).textContent).not.toContain('1 proposals');
  });

  it('offers Set time on a match held at its window end, and says a release leaves it waiting for a time (final review)', async () => {
    const desk2 = {
      holdReason: 'window_expired', holdFrom: 'waiting', dispute: null, frozen: false, graceEndsAt: null, booking: null, liveGame: null, subs: { a: 0, b: 0 },
      schedule: { windowStart: '2026-10-12T00:00:00.000Z', windowEnd: '2026-10-18T23:59:59.000Z', proposal: null, proposals: 1 },
    };
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'league', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Week 1', dates: null, defaultAt: null, window: null, matches: [m({ status: 'admin_hold', phase: 'hold', desk: desk2 })] }] }] }));
    mockAdmin.setEventMatchTime.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit slug="cup" />);
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    fireEvent.input(screen.getByLabelText('Match time'), { target: { value: '2026-10-20T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set time' }));
    await waitFor(() => expect(mockAdmin.setEventMatchTime).toHaveBeenCalledWith(9, 7, new Date('2026-10-20T21:00').toISOString()));
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining('hold is released') }));
    fireEvent.click(screen.getByRole('button', { name: 'Release hold' }));
    await waitFor(() => expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining('set a time') })));
  });

  it('does not clear the Set time input when the save fails', async () => {
    const desk2 = {
      holdReason: null, holdFrom: null, dispute: null, frozen: false, graceEndsAt: null, booking: null, liveGame: null, subs: { a: 0, b: 0 },
      schedule: { windowStart: '2026-10-12T00:00:00.000Z', windowEnd: '2026-10-18T23:59:59.000Z', proposal: null, proposals: 0 },
    };
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'league', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Week 1', dates: null, defaultAt: null, window: null, matches: [m({ desk: desk2 })] }] }] }));
    mockAdmin.setEventMatchTime.mockRejectedValue(new ApiError(409, 'Refused.'));
    render(<PlayPanel eventId={9} canEdit slug="cup" />);
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    fireEvent.input(screen.getByLabelText('Match time'), { target: { value: '2026-10-17T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set time' }));
    await waitFor(() => expect(mockAdmin.setEventMatchTime).toHaveBeenCalled());
    expect((screen.getByLabelText('Match time') as HTMLInputElement).value).toBe('2026-10-17T21:00');
  });
});
