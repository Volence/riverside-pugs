import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { TeamView } from '../api';

const { mockTeams } = vi.hoisted(() => ({
  mockTeams: {
    get: vi.fn(), search: vi.fn(), invite: vi.fn(), cancelInvite: vi.fn(), joinLink: vi.fn(), leave: vi.fn(),
    kick: vi.fn(), setRole: vi.fn(), makeCaptain: vi.fn(), rename: vi.fn(), disband: vi.fn(), logo: vi.fn(),
  },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, teamsApi: mockTeams };
});
vi.mock('../teamLogo', () => ({ toLogoPng: vi.fn(async () => 'BASE64') }));

const { Team } = await import('./Team');
afterEach(() => { cleanup(); for (const f of Object.values(mockTeams)) f.mockReset(); });

const view = (over: Partial<TeamView> = {}): TeamView => ({
  slug: 'rats', name: 'Riverside Rats', tag: 'RR', logoKey: null, createdAt: '2026-10-01T00:00:00.000Z', disbandedAt: null,
  captain: '1',
  members: [
    { steamid: '1', name: 'cap', avatar: null, role: 'captain', joinedAt: '2026-10-01T00:00:00.000Z' },
    { steamid: '2', name: 'bob', avatar: null, role: 'member', joinedAt: '2026-10-02T00:00:00.000Z' },
  ],
  former: [{ steamid: '3', name: 'old', leftAt: '2026-10-03T00:00:00.000Z' }],
  viewer: { role: null, staff: false },
  manage: null,
  ...over,
});
const session = (steamid: string) => ({ kind: 'active', me: { steamid, name: 'x', avatar: null, status: 'active', isAdmin: false, teams: true } }) as never;

describe('Team', () => {
  it('shows the roster and former players to anyone, with no controls', async () => {
    mockTeams.get.mockResolvedValue(view());
    render(<Team slug="rats" session={session('9')} />);
    expect(await screen.findByText('Riverside Rats')).toBeTruthy();
    expect(screen.getByText('cap')).toBeTruthy();
    expect(screen.getByText('Captain')).toBeTruthy();
    expect(screen.getByText('old')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave team' })).toBeNull();
  });

  it('gives the captain invite, roles, kick, captaincy, join link, logo, rename, disband', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'captain', staff: false }, manage: { invites: [], joinLinkToken: null } }));
    render(<Team slug="rats" session={session('1')} />);
    await screen.findByText('Riverside Rats');
    for (const name of ['Make co-captain', 'Kick', 'Make captain', 'Turn on join link', 'Rename', 'Disband team']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByLabelText('Find a player')).toBeTruthy();
    expect(screen.getByLabelText('Logo')).toBeTruthy();
  });

  it('a staff viewer not on the team gets only the controls the server lets staff use', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: null, staff: true }, manage: { invites: [], joinLinkToken: 'tok' } }));
    render(<Team slug="rats" session={session('9')} />);
    await screen.findByText('Riverside Rats');
    for (const name of ['Rename', 'Disband team', 'Make captain']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByLabelText('Logo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kick' })).toBeNull();
    expect(screen.queryByLabelText('Find a player')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Turn on join link' })).toBeNull();
  });

  it('searches players and invites one', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'captain', staff: false }, manage: { invites: [], joinLinkToken: null } }));
    mockTeams.search.mockResolvedValue({ players: [{ steamid: '5', name: 'newguy', avatar: null }] });
    mockTeams.invite.mockResolvedValue({ inviteId: 1 });
    render(<Team slug="rats" session={session('1')} />);
    fireEvent.input(await screen.findByLabelText('Find a player'), { target: { value: 'new' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Invite newguy' }));
    await waitFor(() => expect(mockTeams.invite).toHaveBeenCalledWith('rats', '5'));
  });

  it('disband needs a second press', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'captain', staff: false }, manage: { invites: [], joinLinkToken: null } }));
    mockTeams.disband.mockResolvedValue({});
    render(<Team slug="rats" session={session('1')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disband team' }));
    expect(mockTeams.disband).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disband Riverside Rats' }));
    await waitFor(() => expect(mockTeams.disband).toHaveBeenCalledWith('rats'));
  });

  it('a member can leave; a disbanded team says so and offers nothing', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'member', staff: false } }));
    render(<Team slug="rats" session={session('2')} />);
    expect(await screen.findByRole('button', { name: 'Leave team' })).toBeTruthy();
    cleanup();
    mockTeams.get.mockResolvedValue(view({ disbandedAt: '2026-10-04T00:00:00.000Z', members: [], viewer: { role: null, staff: true } }));
    render(<Team slug="rats" session={session('9')} />);
    expect(await screen.findByText(/Disbanded/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
