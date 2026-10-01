import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';

const { mockTeams } = vi.hoisted(() => ({ mockTeams: { joinInfo: vi.fn(), join: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, teamsApi: mockTeams };
});

const { TeamJoin } = await import('./TeamJoin');

afterEach(() => { cleanup(); for (const f of Object.values(mockTeams)) f.mockReset(); });

const signedOut = { kind: 'anonymous' } as never;
const signedIn = { kind: 'active', me: { steamid: '1', name: 'me', avatar: null, status: 'active', isAdmin: false, teams: true } } as never;

describe('TeamJoin', () => {
  it('tells a signed-out visitor to sign in, with a link back to this join page, and never calls the API', async () => {
    render(<TeamJoin token="abc123" session={signedOut} />);
    expect(await screen.findByText('Sign in to join this team.')).toBeTruthy();
    const link = screen.getByRole('link', { name: /sign in/i });
    expect(link.getAttribute('href')).toBe(`/auth/steam?next=${encodeURIComponent('/team/join/abc123')}`);
    expect(mockTeams.joinInfo).not.toHaveBeenCalled();
  });

  it('loads and shows the team for a signed-in visitor', async () => {
    mockTeams.joinInfo.mockResolvedValue({ slug: 'rats', name: 'Rats', tag: 'RR', logoKey: null, members: 3, captainName: 'cap' });
    render(<TeamJoin token="abc123" session={signedIn} />);
    expect(await screen.findByRole('button', { name: 'Join Rats' })).toBeTruthy();
    expect(screen.getByText('Captain cap · 3 / 8 players')).toBeTruthy();
  });

  it('a full roster cannot be joined from the link page', async () => {
    mockTeams.joinInfo.mockResolvedValue({ slug: 'rats', name: 'Rats', tag: 'RR', logoKey: null, members: 8, captainName: 'cap' });
    render(<TeamJoin token="abc123" session={signedIn} />);
    expect(((await screen.findByRole('button', { name: 'Join Rats' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The roster is full right now.')).toBeTruthy();
  });

  it('a signed-in account that is not active yet is not told to sign in', async () => {
    const pending = { kind: 'pending', me: { steamid: '1', name: 'me', avatar: null, status: 'invited', isAdmin: false } } as never;
    render(<TeamJoin token="abc123" session={pending} />);
    expect(await screen.findByText(/not active yet/)).toBeTruthy();
    expect(screen.queryByText('Sign in to join this team.')).toBeNull();
    expect(mockTeams.joinInfo).not.toHaveBeenCalled();
  });

  it('shows why a join was refused (a kicked player)', async () => {
    const { ApiError } = await import('../api');
    mockTeams.joinInfo.mockResolvedValue({ slug: 'rats', name: 'Rats', tag: 'RR', logoKey: null, members: 3, captainName: 'cap' });
    mockTeams.join.mockRejectedValue(new ApiError(403, 'You were removed from this team. Ask the captain for an invite.'));
    render(<TeamJoin token="abc123" session={signedIn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Join Rats' }));
    expect(await screen.findByText(/You were removed from this team/)).toBeTruthy();
  });
});
