import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminDraftTeamsView } from '../../../api';

const { mockAdmin, confirmMock, hub } = vi.hoisted(() => ({
  mockAdmin: { draftTeamsView: vi.fn(), draftMode: vi.fn(), draftBalance: vi.fn(), draftMove: vi.fn(), draftPublishTeams: vi.fn(), draftRoom: vi.fn(), draftRoomAct: vi.fn(), draftRoomDelegate: vi.fn(), draftRoomSettings: vi.fn() },
  confirmMock: vi.fn(async () => true),
  hub: { names: [] as string[], fns: [] as Array<() => void> },
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: confirmMock }));
vi.mock('../../../hooks/useHubEvent', () => ({ useHubEvent: (names: string[], fn: () => void) => { hub.names = names; hub.fns.push(fn); } }));
const { DraftTeamsPanel } = await import('./DraftTeamsPanel');
const { ApiError } = await import('../../../api');

const made = (over: Partial<AdminDraftTeamsView> = {}): AdminDraftTeamsView => ({
  mode: 'auto', teamsMadeAt: null,
  teams: [
    { captain: { steamid: '1', name: 'Ann' }, players: [{ steamid: '2', name: 'Bob', sr: 1200.4 }, { steamid: '3', name: 'Cy', sr: 1000 }, { steamid: '4', name: 'Di', sr: 900 }], short: false },
    { captain: { steamid: '5', name: 'Eve' }, players: [{ steamid: '6', name: 'Fay', sr: 1100 }, { steamid: '7', name: 'Gus', sr: 1050 }, { steamid: '8', name: 'Hal', sr: 998.6 }], short: false },
  ],
  fairness: {
    teams: [
      { captain: '1', captainName: 'Ann', names: ['Ann', 'Bob', 'Cy', 'Di'], avgSr: 1087.5, totalSr: 4350 },
      { captain: '5', captainName: 'Eve', names: ['Eve', 'Fay', 'Gus', 'Hal'], avgSr: 1062.3, totalSr: 4249 },
    ],
    spread: 25.2, forecasts: [{ a: 0, b: 1, winA: 0.5234 }],
  },
  ...over,
});

const SOON = new Date(Date.now() + 3_600_000).toISOString();
const AGO = new Date(Date.now() - 60_000).toISOString();

afterEach(() => { cleanup(); vi.clearAllMocks(); hub.fns.length = 0; });

describe('DraftTeamsPanel', () => {
  it('offers the two methods before one is chosen, and Let captains pick chooses the live room', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue({ mode: null, teamsMadeAt: null, teams: null, fairness: null });
    mockAdmin.draftMode.mockResolvedValue({});
    render(<DraftTeamsPanel eventId={9} slug="night" status="registration" startsAt={SOON} canEdit />);
    expect(await screen.findByRole('heading', { name: 'Make teams' })).toBeTruthy();
    expect(screen.queryByText('Coming soon: the live draft room')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Let captains pick' }));
    await waitFor(() => expect(mockAdmin.draftMode).toHaveBeenCalledWith(9, 'live'));
    fireEvent.click(screen.getByRole('button', { name: 'Auto-balance by SR' }));
    await waitFor(() => expect(mockAdmin.draftMode).toHaveBeenCalledWith(9, 'auto'));
  });

  const doneRoom = () => ({
    eventId: 9, slug: 'night', eventName: 'Draft Night', status: 'done', teamsMadeAt: null, settings: { firstPick: 'lowest_sr', pickSeconds: 75 },
    serverNow: new Date().toISOString(), deadlineAt: null, pausedLeftMs: null, totalPicks: 6, order: [], onClock: null, picks: [], delegates: {},
    teams: [], pool: [], notes: null, me: { role: null, team: null, onClock: false, list: null, chemistry: null }, lists: {}, staff: true,
  });

  it('in live mode shows the room controls, and the drafted teams with no swaps once the room is done', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue(made({ mode: 'live' }));
    mockAdmin.draftRoom.mockResolvedValue(doneRoom());
    render(<DraftTeamsPanel eventId={9} slug="night" status="registration" startsAt={SOON} canEdit />);
    expect(await screen.findByText('The draft is over. Check the teams below and publish them.')).toBeTruthy();
    expect(screen.queryByLabelText('Swap Bob with')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebalance' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Publish teams' })).toBeTruthy();
  });

  it('in live mode reloads the teams when the room broadcasts draft:<id>', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue(made({ mode: 'live', teams: null, fairness: null }));
    mockAdmin.draftRoom.mockResolvedValue(doneRoom());
    render(<DraftTeamsPanel eventId={9} slug="night" status="registration" startsAt={SOON} canEdit />);
    await screen.findByText('The draft is over. Check the teams below and publish them.');
    expect(hub.names).toContain('draft:9');
    expect(screen.queryByRole('button', { name: 'Publish teams' })).toBeNull();
    mockAdmin.draftTeamsView.mockResolvedValue(made({ mode: 'live' }));
    for (const fn of hub.fns) fn();
    expect(await screen.findByRole('button', { name: 'Publish teams' })).toBeTruthy();
    expect(screen.getByText(/Spread: 25 SR/)).toBeTruthy();
  });

  it('balances with no confirm the first time, and Rebalance asks first', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue({ mode: 'auto', teamsMadeAt: null, teams: null, fairness: null });
    mockAdmin.draftBalance.mockResolvedValue({});
    render(<DraftTeamsPanel eventId={9} status="registration" startsAt={SOON} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Balance teams' }));
    await waitFor(() => expect(mockAdmin.draftBalance).toHaveBeenCalledWith(9));
    expect(confirmMock).not.toHaveBeenCalled();

    cleanup();
    mockAdmin.draftBalance.mockClear();
    mockAdmin.draftTeamsView.mockResolvedValue(made());
    render(<DraftTeamsPanel eventId={9} status="registration" startsAt={SOON} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rebalance' }));
    await waitFor(() => expect(mockAdmin.draftBalance).toHaveBeenCalledWith(9));
    expect(confirmMock).toHaveBeenCalledWith('Rebalance from scratch? Hand moves are lost.');
  });

  it('shows team cards with rounded SR and the fairness readout', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue(made());
    render(<DraftTeamsPanel eventId={9} status="registration" startsAt={SOON} canEdit />);
    expect(await screen.findByText('Bob', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('1200')).toBeTruthy();
    expect(screen.getByText('1000')).toBeTruthy();
    expect(screen.getByText('Average SR 1088')).toBeTruthy();
    expect(screen.getByText('Average SR 1062')).toBeTruthy();
    expect(screen.getByText('Spread: 25 SR between the strongest and weakest team')).toBeTruthy();
    expect(screen.getByText('Ann vs Eve: 52% / 48%')).toBeTruthy();
    expect(screen.getByText('Unrated players count at the default SR here; the win forecast treats them as an unknown rating, so the two can disagree.')).toBeTruthy();
  });

  it('swaps a pool player with one from another team', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue(made());
    mockAdmin.draftMove.mockResolvedValue({});
    render(<DraftTeamsPanel eventId={9} status="registration" startsAt={SOON} canEdit />);
    const sel = await screen.findByLabelText('Swap Bob with');
    fireEvent.change(sel, { target: { value: '6' } });
    await waitFor(() => expect(mockAdmin.draftMove).toHaveBeenCalledWith(9, '2', '6'));
    const own = (sel as HTMLSelectElement).options;
    expect([...own].map((o) => o.value)).toEqual(['', '6', '7', '8']);
  });

  it('marks a short team', async () => {
    const v = made();
    v.teams![1]!.players.pop();
    v.teams![1]!.short = true;
    mockAdmin.draftTeamsView.mockResolvedValue(v);
    render(<DraftTeamsPanel eventId={9} status="registration" startsAt={SOON} canEdit />);
    expect(await screen.findByText('This team is short a player; publishing will be refused until it has 4.')).toBeTruthy();
    expect(screen.getAllByText('This team is short a player; publishing will be refused until it has 4.')).toHaveLength(1);
  });

  it('publishes after confirming with the exact title and body, and shows the refusal sentence', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue(made());
    mockAdmin.draftPublishTeams.mockRejectedValue(new ApiError(409, 'The teams changed since they were balanced.'));
    render(<DraftTeamsPanel eventId={9} status="registration" startsAt={SOON} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish teams' }));
    await waitFor(() => expect(mockAdmin.draftPublishTeams).toHaveBeenCalledWith(9));
    expect(confirmMock).toHaveBeenCalledWith({
      title: 'Publish the teams?',
      body: 'Entries are created, every player gets a DM with their team, and captains can name their team until the event starts. Teams cannot be changed afterwards.',
    });
    expect(await screen.findByText('The teams changed since they were balanced.')).toBeTruthy();
  });

  it('Change method asks, then clears the mode', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue(made());
    mockAdmin.draftMode.mockResolvedValue({});
    render(<DraftTeamsPanel eventId={9} status="registration" startsAt={SOON} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change method' }));
    await waitFor(() => expect(mockAdmin.draftMode).toHaveBeenCalledWith(9, null));
    expect(confirmMock).toHaveBeenCalled();
  });

  it('after publishing shows when, with no controls', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue(made({ teamsMadeAt: '2026-10-07T20:00:00.000Z' }));
    render(<DraftTeamsPanel eventId={9} status="registration" startsAt={SOON} canEdit />);
    expect(await screen.findByText(/^Teams published /)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Swap Bob with')).toBeNull();
  });

  it('a mod sees the teams and no buttons or swap selects', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue(made());
    render(<DraftTeamsPanel eventId={9} status="registration" startsAt={SOON} canEdit={false} />);
    expect(await screen.findByText('Bob', { selector: 'span' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Swap Bob with')).toBeNull();
  });

  it('warns in the publish confirm when the start time has passed', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue(made());
    mockAdmin.draftPublishTeams.mockResolvedValue({});
    render(<DraftTeamsPanel eventId={9} status="registration" startsAt={AGO} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish teams' }));
    await waitFor(() => expect(mockAdmin.draftPublishTeams).toHaveBeenCalledWith(9));
    expect(confirmMock).toHaveBeenCalledWith({
      title: 'Publish the teams?',
      body: 'Entries are created, every player gets a DM with their team, and captains can name their team until the event starts. Teams cannot be changed afterwards.'
        + ' The start time has passed, so the event starts within a minute of publishing and team names lock then.',
    });
  });

  for (const status of ['cancelled', 'finished']) {
    it(`an admin gets no write controls once the event is ${status}`, async () => {
      mockAdmin.draftTeamsView.mockResolvedValue(made());
      render(<DraftTeamsPanel eventId={9} status={status} startsAt={AGO} canEdit />);
      expect(await screen.findByText('Bob', { selector: 'span' })).toBeTruthy();
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByLabelText('Swap Bob with')).toBeNull();
      expect(screen.queryByText('Read only: admins run events.')).toBeNull();
    });

    it(`an admin gets no method buttons on a ${status} event with no method chosen`, async () => {
      mockAdmin.draftTeamsView.mockResolvedValue({ mode: null, teamsMadeAt: null, teams: null, fairness: null });
      render(<DraftTeamsPanel eventId={9} status={status} startsAt={AGO} canEdit />);
      expect(await screen.findByRole('heading', { name: 'Make teams' })).toBeTruthy();
      expect(screen.queryByRole('button')).toBeNull();
    });
  }
});
