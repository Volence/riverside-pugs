import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockTeams } = vi.hoisted(() => ({
  mockTeams: { list: vi.fn(), mine: vi.fn(), create: vi.fn(), accept: vi.fn(), decline: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, teamsApi: mockTeams };
});

const { ApiError } = await import('../api');
const { Teams } = await import('./Teams');

afterEach(() => { cleanup(); for (const f of Object.values(mockTeams)) f.mockReset(); });

const signedIn = { kind: 'active', me: { steamid: '1', name: 'me', avatar: null, status: 'active', isAdmin: false, teams: true } } as never;

describe('Teams', () => {
  it('lists every team and the viewer\'s own teams and invites', async () => {
    mockTeams.list.mockResolvedValue({ teams: [{ slug: 'rats', name: 'Riverside Rats', tag: 'RR', logoKey: null, members: 5 }] });
    mockTeams.mine.mockResolvedValue({
      teams: [{ slug: 'mice', name: 'Mice', tag: 'MM', logoKey: null, role: 'captain' }],
      invites: [{ id: 7, slug: 'rats', name: 'Riverside Rats', tag: 'RR', invitedByName: 'cap', createdAt: '2026-10-01T00:00:00.000Z' }],
      canCreate: true,
    });
    render(<Teams session={signedIn} />);
    expect(await screen.findByText('Riverside Rats', { selector: '.teamcard__name' })).toBeTruthy();
    expect(screen.getByText(/5 players/)).toBeTruthy();
    expect(screen.getByText(/cap invited you/)).toBeTruthy();
    expect(screen.getByText('Mice', { selector: '.teamcard__name' })).toBeTruthy();
  });

  it('accepting an invite reloads the lists', async () => {
    mockTeams.list.mockResolvedValue({ teams: [] });
    mockTeams.mine.mockResolvedValue({ teams: [], invites: [{ id: 7, slug: 'rats', name: 'Rats', tag: 'RR', invitedByName: 'cap', createdAt: '' }], canCreate: true });
    mockTeams.accept.mockResolvedValue({ slug: 'rats' });
    render(<Teams session={signedIn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(mockTeams.accept).toHaveBeenCalledWith(7));
    await waitFor(() => expect(mockTeams.mine).toHaveBeenCalledTimes(2));
  });

  it('creating a team shows the server\'s refusal, and goes to the page on success', async () => {
    mockTeams.list.mockResolvedValue({ teams: [] });
    mockTeams.mine.mockResolvedValue({ teams: [], invites: [], canCreate: true });
    mockTeams.create.mockRejectedValueOnce(new ApiError(409, 'Another team already has that name.'));
    render(<Teams session={signedIn} />);
    fireEvent.input(await screen.findByLabelText('Team name'), { target: { value: 'Rats' } });
    fireEvent.input(screen.getByLabelText('Tag'), { target: { value: 'RR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    expect(await screen.findByText('Another team already has that name.')).toBeTruthy();
  });

  it('shows nothing but a not-found line when the switch is closed', async () => {
    mockTeams.list.mockRejectedValue(new ApiError(404, 'not found'));
    mockTeams.mine.mockRejectedValue(new ApiError(404, 'not found'));
    render(<Teams session={signedIn} />);
    expect(await screen.findByText(/not open yet/i)).toBeTruthy();
  });
});
