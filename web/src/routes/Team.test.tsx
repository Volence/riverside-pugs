import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { TeamScrim, TeamView } from '../api';

const { mockTeams } = vi.hoisted(() => ({
  mockTeams: {
    get: vi.fn(), search: vi.fn(), invite: vi.fn(), cancelInvite: vi.fn(), joinLink: vi.fn(), leave: vi.fn(),
    kick: vi.fn(), setRole: vi.fn(), makeCaptain: vi.fn(), rename: vi.fn(), disband: vi.fn(), logo: vi.fn(),
    scrims: vi.fn(),
  },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, teamsApi: mockTeams };
});
vi.mock('../teamLogo', () => ({ toLogoPng: vi.fn(async () => 'BASE64') }));

const { Team } = await import('./Team');
// Only the scrims-focused tests care about this call; everyone else gets an
// empty list so the panel's own fetch never breaks an unrelated test.
beforeEach(() => { mockTeams.scrims.mockResolvedValue({ scrims: [] }); });
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

  it('make captain warns the captain they give it up, and can be backed out of', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'captain', staff: false }, manage: { invites: [], joinLinkToken: null } }));
    mockTeams.makeCaptain.mockResolvedValue({});
    render(<Team slug="rats" session={session('1')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make captain' }));
    expect(mockTeams.makeCaptain).not.toHaveBeenCalled();
    expect(screen.getByText(/You will become a co-captain/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep captaincy' }));
    expect(screen.queryByText(/You will become a co-captain/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make captain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, make bob captain' }));
    await waitFor(() => expect(mockTeams.makeCaptain).toHaveBeenCalledWith('rats', '2'));
  });

  it('kick and leave each need a second press', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'captain', staff: false }, manage: { invites: [], joinLinkToken: null } }));
    mockTeams.kick.mockResolvedValue({});
    render(<Team slug="rats" session={session('1')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kick' }));
    expect(mockTeams.kick).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot rejoin through the join link/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, kick bob' }));
    await waitFor(() => expect(mockTeams.kick).toHaveBeenCalledWith('rats', '2'));
    cleanup();
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'member', staff: false } }));
    mockTeams.leave.mockResolvedValue({ disbanded: false, captain: '1' });
    render(<Team slug="rats" session={session('2')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Leave team' }));
    expect(mockTeams.leave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, leave Riverside Rats' }));
    await waitFor(() => expect(mockTeams.leave).toHaveBeenCalledWith('rats'));
  });

  it('a co-captain can change the logo but not rename', async () => {
    mockTeams.get.mockResolvedValue(view({
      viewer: { role: 'cocaptain', staff: false }, manage: { invites: [], joinLinkToken: null },
      members: [
        { steamid: '1', name: 'cap', avatar: null, role: 'captain', joinedAt: '2026-10-01T00:00:00.000Z' },
        { steamid: '2', name: 'bob', avatar: null, role: 'cocaptain', joinedAt: '2026-10-02T00:00:00.000Z' },
      ],
    }));
    render(<Team slug="rats" session={session('2')} />);
    expect(await screen.findByLabelText('Logo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
  });

  it('staff making someone captain are told it replaces the current captain', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: null, staff: true }, manage: { invites: [], joinLinkToken: null } }));
    render(<Team slug="rats" session={session('9')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make captain' }));
    expect(screen.getByText(/cap stops being captain/)).toBeTruthy();
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

  const scrim = (over: Partial<TeamScrim> = {}): TeamScrim => ({
    bookingId: 42, opponent: 'Other Crew', startsAt: '2026-10-05T20:00:00.000Z', state: 'ended', canView: true,
    games: [{ matchId: 7, campaign: 'no_mercy', state: 'completed', us: 2, them: 1 }],
    ...over,
  });

  it('fetches and shows the Scrims panel for a member', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'member', staff: false } }));
    mockTeams.scrims.mockResolvedValue({ scrims: [scrim()] });
    render(<Team slug="rats" session={session('2')} />);
    await screen.findByText('Riverside Rats');
    await waitFor(() => expect(mockTeams.scrims).toHaveBeenCalledWith('rats', expect.anything()));
    expect(await screen.findByText('vs Other Crew')).toBeTruthy();
    expect(screen.getByText('Over')).toBeTruthy();
    expect(screen.getByText('No Mercy')).toBeTruthy();
    expect(screen.getByText('2 : 1')).toBeTruthy();
    const matchLink = screen.getByRole('link', { name: 'View' }) as HTMLAnchorElement;
    expect(matchLink.getAttribute('href')).toBe('/match/7');
    const bookingLink = screen.getByText('vs Other Crew').closest('a') as HTMLAnchorElement;
    expect(bookingLink.getAttribute('href')).toBe('/booking/42');
  });

  it('a scrim whose booking page the viewer cannot open shows no booking link, but its game links stay', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'member', staff: false } }));
    mockTeams.scrims.mockResolvedValue({ scrims: [scrim({ canView: false })] });
    render(<Team slug="rats" session={session('2')} />);
    expect(await screen.findByText('vs Other Crew')).toBeTruthy();
    expect(screen.getByText('vs Other Crew').closest('a')).toBeNull();
    expect((screen.getByRole('link', { name: 'View' }) as HTMLAnchorElement).getAttribute('href')).toBe('/match/7');
  });

  it('shows the Scrims panel for staff not on the team', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: null, staff: true }, manage: { invites: [], joinLinkToken: 'tok' } }));
    mockTeams.scrims.mockResolvedValue({ scrims: [scrim({ games: [] })] });
    render(<Team slug="rats" session={session('9')} />);
    await screen.findByText('Riverside Rats');
    expect(await screen.findByText('vs Other Crew')).toBeTruthy();
  });

  it('shows the team\'s record line in the Scrims panel for a member', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'member', staff: false }, record: { shown: 6, booked: 7, noShows: 1, lateCancels: 0, excused: 0 } }));
    render(<Team slug="rats" session={session('2')} />);
    expect(await screen.findByText('Shown 6 of 7 · No-shows 1')).toBeTruthy();
    expect(screen.getByText('Shown 6 of 7 · No-shows 1').closest('section')?.textContent).toContain('Scrims');
  });

  it('a member\'s team under 3 booked reads "New"', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'member', staff: false }, record: { shown: 0, booked: 0, noShows: 0, lateCancels: 0, excused: 0 } }));
    render(<Team slug="rats" session={session('2')} />);
    expect(await screen.findByText('New')).toBeTruthy();
  });

  it('never fetches or shows the Scrims panel for a non-member, non-staff viewer', async () => {
    mockTeams.get.mockResolvedValue(view());
    render(<Team slug="rats" session={session('9')} />);
    await screen.findByText('Riverside Rats');
    expect(mockTeams.scrims).not.toHaveBeenCalled();
    expect(screen.queryByText('Scrims')).toBeNull();
  });

  it('shows the opponents\' review aggregate in the Scrims panel for a member (plan 2 Ruling 5)', async () => {
    mockTeams.get.mockResolvedValue(view({
      viewer: { role: 'member', staff: false },
      reviews: { count: 3, positivePct: 92, topTag: 'on_time' },
    }));
    render(<Team slug="rats" session={session('2')} />);
    const line = await screen.findByText("Opponents' reviews: 92% positive, top tag: On time");
    expect(line.closest('section')?.textContent).toContain('Scrims');
  });

  it('reads "Not enough reviews yet" under 3 reviews', async () => {
    mockTeams.get.mockResolvedValue(view({
      viewer: { role: 'member', staff: false },
      reviews: { count: 1, positivePct: null, topTag: null },
    }));
    render(<Team slug="rats" session={session('2')} />);
    expect(await screen.findByText('Not enough reviews yet')).toBeTruthy();
  });

  it('shows no review aggregate line when the server sends none', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'member', staff: false } }));
    render(<Team slug="rats" session={session('2')} />);
    await screen.findByText('Riverside Rats');
    expect(screen.queryByText(/Opponents' reviews/)).toBeNull();
    expect(screen.queryByText('Not enough reviews yet')).toBeNull();
  });
});
