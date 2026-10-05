import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MyEventView, MemberOptionView } from '../../api';

const { mockEvents } = vi.hoisted(() => ({
  mockEvents: { mine: vi.fn(), register: vi.fn(), setRoster: vi.fn(), withdraw: vi.fn(), checkIn: vi.fn(), leave: vi.fn() },
}));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
vi.mock('../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { EntryPanel } = await import('./EntryPanel');
const { ApiError } = await import('../../api');

const member = (n: number, over: Partial<MemberOptionView> = {}): MemberOptionView =>
  ({ steamid: `7656119900000080${n}`, name: `p${n}`, avatar: null, problems: [], elsewhere: null, onTeam: true, ...over });
const team = { teamId: 7, name: 'Rats', tag: 'RAT', logoKey: null, members: [1, 2, 3, 4, 5].map((n) => member(n)) };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EntryPanel', () => {
  it('registers a team with the first four members as starters by default', async () => {
    const view: MyEventView = { entries: [], register: [team], canRegister: true };
    mockEvents.register.mockResolvedValue({ id: 1 });
    const onChange = vi.fn();
    render(<EntryPanel slug="cup" view={view} maxSubs={2} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Register Rats' }));
    await waitFor(() => expect(mockEvents.register).toHaveBeenCalledWith('cup', 7, {
      starters: team.members.slice(0, 4).map((m) => m.steamid), subs: [], coach: null,
    }));
    expect(onChange).toHaveBeenCalled();
  });

  it('marks a member who cannot play and says why', () => {
    const view: MyEventView = { entries: [], register: [{ ...team, members: [member(1, { problems: ['2 of 5 completed PUGs'] }), ...team.members.slice(1)] }], canRegister: true };
    render(<EntryPanel slug="cup" view={view} maxSubs={2} onChange={() => {}} />);
    expect(screen.getByText('2 of 5 completed PUGs')).toBeTruthy();
  });

  it('shows the server refusal with each named player', async () => {
    mockEvents.register.mockRejectedValue(new ApiError(409, 'Someone on the roster does not meet the entry rules.', undefined,
      [{ steamid: '1', name: 'p3', problems: ['Discord is not linked'] }]));
    render(<EntryPanel slug="cup" view={{ entries: [], register: [team], canRegister: true }} maxSubs={2} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Register Rats' }));
    expect(await screen.findByText(/p3: Discord is not linked/)).toBeTruthy();
  });

  it('offers check-in, withdraw and leave only when the view allows them', async () => {
    const entry = {
      id: 3, name: 'Rats', tag: 'RAT', logoKey: null, status: 'registered', seed: null, waitlist: 2, checkedInAt: null,
      manage: true, onRoster: true, roster: [], rosterLocked: false, additionsLeft: null,
      canEditRoster: true, canCheckIn: true, canWithdraw: true, canLeave: false, leaveNeedsStaff: false, members: team.members,
    };
    mockEvents.checkIn.mockResolvedValue({});
    render(<EntryPanel slug="cup" view={{ entries: [entry], register: [], canRegister: false }} maxSubs={2} onChange={() => {}} />);
    expect(screen.getByText(/Waitlist, number 2/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Leave roster' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(mockEvents.checkIn).toHaveBeenCalledWith('cup', 3));
  });

  const myEntry = (over: Partial<MyEventView['entries'][number]> = {}): MyEventView['entries'][number] => ({
    id: 3, name: 'Rats', tag: 'RAT', logoKey: null, status: 'registered', seed: null, waitlist: null, checkedInAt: null,
    manage: true, onRoster: true, roster: [], rosterLocked: false, additionsLeft: null,
    canEditRoster: true, canCheckIn: false, canWithdraw: true, canLeave: true, leaveNeedsStaff: false, members: team.members, ...over,
  });

  it('lets a manager take a player who left the team off the roster', async () => {
    const gone = member(9, { name: 'leaver', onTeam: false });
    const starters = [1, 2, 3].map((n) => member(n));
    const entry = myEntry({
      roster: [...starters, gone].map((m) => ({ steamid: m.steamid, name: m.name, avatar: null, role: 'starter' as const, problems: [] })),
      members: [...team.members, gone],
    });
    mockEvents.setRoster.mockResolvedValue({});
    render(<EntryPanel slug="cup" view={{ entries: [entry], register: [], canRegister: false }} maxSubs={2} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit roster' }));
    expect(screen.getByText('No longer on the team')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Role for leaver'), { target: { value: 'out' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save roster' }));
    await waitFor(() => expect(mockEvents.setRoster).toHaveBeenCalledWith('cup', 3, {
      starters: starters.map((m) => m.steamid), subs: [], coach: null,
    }));
  });

  it('shows a checked-in team its waitlist number too', () => {
    render(<EntryPanel slug="cup" view={{ entries: [myEntry({ status: 'checked_in', waitlist: 2 })], register: [], canRegister: false }} maxSubs={2} onChange={() => {}} />);
    expect(screen.getByText('Checked in, waitlist number 2')).toBeTruthy();
  });

  it('tells a starter to ask staff once the list is final', () => {
    render(<EntryPanel slug="cup" view={{ entries: [myEntry({ canLeave: false, leaveNeedsStaff: true })], register: [], canRegister: false }} maxSubs={2} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Leave roster' })).toBeNull();
    expect(screen.getByText(/ask staff/)).toBeTruthy();
  });
});
