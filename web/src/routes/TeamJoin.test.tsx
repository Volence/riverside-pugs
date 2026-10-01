import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';

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
    mockTeams.joinInfo.mockResolvedValue({ slug: 'rats', name: 'Rats', tag: 'RR', logoKey: null });
    render(<TeamJoin token="abc123" session={signedIn} />);
    expect(await screen.findByText(/Join Rats/)).toBeTruthy();
  });
});
