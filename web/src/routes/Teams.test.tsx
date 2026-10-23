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
    mockTeams.list.mockResolvedValue({ teams: [
      { slug: 'rats', name: 'Riverside Rats', tag: 'RR', logoKey: null, members: 5, captainName: 'cap' },
      { slug: 'owls', name: 'Owls', tag: 'OW', logoKey: null, members: 2, captainName: 'hoot' },
    ] });
    mockTeams.mine.mockResolvedValue({
      teams: [{ slug: 'mice', name: 'Mice', tag: 'MM', logoKey: null, role: 'captain', members: 3 }],
      invites: [{ id: 7, slug: 'rats', name: 'Riverside Rats', tag: 'RR', invitedByName: 'cap', createdAt: '2026-10-01T00:00:00.000Z' }],
      canCreate: true,
    });
    render(<Teams session={signedIn} />);
    const rats = await screen.findByText('Riverside Rats', { selector: 'a.tmcard__link .tmcard__name' });
    expect(rats.closest('a')!.getAttribute('href')).toBe('/team/rats');
    const ratsCard = rats.closest('.tmcard') as HTMLElement;
    expect(ratsCard.textContent).toContain('Captain cap');
    expect(ratsCard.textContent).toContain('Ready for events');
    const owls = screen.getByText('Owls', { selector: '.tmcard__name' }).closest('.tmcard') as HTMLElement;
    expect(owls.textContent).toContain('2 more to enter');
    expect(owls.textContent).toContain('Needs players');
    expect(screen.getByText(/cap invited you/)).toBeTruthy();
    const mice = screen.getByText('Mice', { selector: '.tmcard__name' }).closest('.tmcard') as HTMLElement;
    expect(mice.textContent).toContain('1 more to enter');
    expect(mice.textContent).toContain('Captain');
  });

  it('shows the roster as faces, captain first, with +N for the rest', async () => {
    const roster = Array.from({ length: 7 }, (_, i) => ({ steamid: String(i), name: `p${i}`, avatar: i === 0 ? 'https://example.test/a.png' : null }));
    mockTeams.list.mockResolvedValue({ teams: [{ slug: 'rats', name: 'Riverside Rats', tag: 'RR', logoKey: null, members: 7, captainName: 'p0', roster }] });
    mockTeams.mine.mockResolvedValue({ teams: [], invites: [], canCreate: false });
    render(<Teams session={signedIn} />);
    const faces = await screen.findByLabelText(/^7 players: p0, p1/);
    expect(faces.querySelectorAll('.tmfaces__face').length).toBe(6);
    expect(faces.textContent).toContain('+2');
  });

  it('the start form waits behind a button for someone already on a team, and opens at once for someone on none', async () => {
    mockTeams.list.mockResolvedValue({ teams: [] });
    mockTeams.mine.mockResolvedValue({ teams: [{ slug: 'mice', name: 'Mice', tag: 'MM', logoKey: null, role: 'member', members: 4 }], invites: [], canCreate: true });
    render(<Teams session={signedIn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start a team' }));
    expect(screen.getByLabelText('Team name')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Team name')).toBeNull();
    cleanup();
    mockTeams.mine.mockResolvedValue({ teams: [], invites: [], canCreate: true });
    render(<Teams session={signedIn} />);
    expect(await screen.findByText(/You are not on a team yet/)).toBeTruthy();
    expect(screen.getByLabelText('Team name')).toBeTruthy();
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

  it('heads the page with the Compete tabs, Teams current, and none while closed', async () => {
    mockTeams.list.mockResolvedValue({ teams: [] });
    mockTeams.mine.mockResolvedValue({ teams: [], invites: [], canCreate: true });
    const { unmount } = render(<Teams session={signedIn} />);
    const strip = await screen.findByRole('navigation', { name: 'Compete' });
    const current = [...strip.querySelectorAll('a')].filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Teams']);
    unmount();
    mockTeams.list.mockRejectedValue(new ApiError(404, 'not found'));
    mockTeams.mine.mockRejectedValue(new ApiError(404, 'not found'));
    render(<Teams session={signedIn} />);
    await screen.findByText('Teams are not open yet.');
    expect(screen.queryByRole('navigation', { name: 'Compete' })).toBeNull();
  });

  it('shows nothing but a not-found line when the switch is closed', async () => {
    mockTeams.list.mockRejectedValue(new ApiError(404, 'not found'));
    mockTeams.mine.mockRejectedValue(new ApiError(404, 'not found'));
    render(<Teams session={signedIn} />);
    expect(await screen.findByText(/not open yet/i)).toBeTruthy();
  });
});
