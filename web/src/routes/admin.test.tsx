import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

const { mockAdmin, mockApi } = vi.hoisted(() => ({
  mockAdmin: {
    players: vi.fn(), player: vi.fn(), ban: vi.fn(), overview: vi.fn(), settings: vi.fn(), saveSetting: vi.fn(),
    reports: vi.fn(), audit: vi.fn(),
    integrity: vi.fn(), integrityPlayer: vi.fn(), integrityReview: vi.fn(),
  },
  mockApi: { reportEligibility: vi.fn(), report: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin }, api: { ...actual.api, ...mockApi } };
});

const { Admin } = await import('./Admin');
const { QueuePanel } = await import('./Play');
const { ReportPlayer } = await import('../components/ReportPlayer');

afterEach(cleanup);
beforeEach(() => {
  for (const fn of [...Object.values(mockAdmin), ...Object.values(mockApi)]) fn.mockReset();
});

const me = { steamid: '1', name: 'boss', avatar: null, status: 'active', isAdmin: true };

describe('Admin page', () => {
  it('refuses a non-admin without calling the admin API', () => {
    render(<Admin session={{ kind: 'active', me: { ...me, isAdmin: false } }} />);
    expect(screen.getByText('Admins only.')).toBeTruthy();
    expect(mockAdmin.players).not.toHaveBeenCalled();
  });

  it('lists players, opens a detail and bans with a reason', async () => {
    const row = { steamid: '2', name: 'griefer', avatar: null, status: 'active', isAdmin: false, discordName: null, sr: 900, games: 4, createdAt: '2026-09-01', offenses: 2 };
    mockAdmin.players.mockResolvedValue({ players: [row] });
    mockAdmin.player.mockResolvedValue({
      ...row, discordId: null, activeBan: null, bans: [], notes: [], matches: [], penalties: [], timeout: null, reportsAgainst: [],
    });
    mockAdmin.ban.mockResolvedValue({ ok: true });
    window.confirm = () => true;
    render(<Admin session={{ kind: 'active', me }} />);
    await waitFor(() => expect(screen.getByText('griefer')).toBeTruthy());
    fireEvent.click(screen.getByText('griefer'));
    await waitFor(() => expect(screen.getByPlaceholderText('Reason (shown to them)')).toBeTruthy());
    fireEvent.input(screen.getByPlaceholderText('Reason (shown to them)'), { target: { value: 'throwing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(mockAdmin.ban).toHaveBeenCalledWith('2', 'throwing', null));
  });

  it('settings tab shows grouped settings', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.settings.mockResolvedValue({
      settings: [{ key: 'ready_seconds', label: 'Ready check seconds', help: 'h', group: 'Queue', value: '120', type: { kind: 'int', min: 15, max: 600 } }],
      campaigns: [],
    });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    await waitFor(() => expect(screen.getByText('Ready check seconds')).toBeTruthy());
    expect((screen.getByLabelText('Ready check seconds') as HTMLInputElement).value).toBe('120');
  });
});

describe('queue timeout', () => {
  it('disables Join queue and says when you can queue again', () => {
    const until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    render(<QueuePanel count={2} joined={false} players={[]} refresh={() => {}} timeout={{ until, offenses: 2 }} />);
    expect((screen.getByRole('button', { name: 'Join queue' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/queue again in/)).toBeTruthy();
  });
});

describe('ReportPlayer', () => {
  it('asks the server, then sends a report for a picked player and reason', async () => {
    mockApi.reportEligibility.mockResolvedValue({ canReport: true, targets: [{ steamid: '5', name: 'tino', alreadyReported: false }] });
    mockApi.report.mockResolvedValue({ ok: true });
    render(<ReportPlayer matchId={7} />);
    fireEvent.click(screen.getByText('Report a player'));
    await waitFor(() => expect(screen.getByLabelText('Player')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Player'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'afk' } });
    fireEvent.click(screen.getByText('Send report'));
    await waitFor(() => expect(mockApi.report).toHaveBeenCalledWith(7, '5', 'afk', ''));
    await waitFor(() => expect(screen.getByText(/An admin will look at it/)).toBeTruthy());
  });

  it('shows why reporting is closed', async () => {
    mockApi.reportEligibility.mockResolvedValue({ canReport: false, reason: 'reports close 48 hours after a match ends' });
    render(<ReportPlayer matchId={7} />);
    fireEvent.click(screen.getByText('Report a player'));
    await waitFor(() => expect(screen.getByText(/Reports close 48 hours/)).toBeTruthy());
  });
});

describe('AdminIntegrity', () => {
  it('ranks the higher composite first and calls the number theoretical, not a verdict', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({
      players: [
        { steamid: '10', rounds: 5, fidMax: 0.9, fidP95: 0.4, occZ: 3.1, teamGap: 2.2, pFid: 0.95, pOcc: 0.9, pGap: 0.8, composite: 0.98 },
        { steamid: '20', rounds: 5, fidMax: 0.2, fidP95: 0.1, occZ: null, teamGap: null, pFid: 0.1, pOcc: null, pGap: null, composite: 0.1 },
      ],
    });
    const { container } = render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    await waitFor(() => expect(screen.getByText('10')).toBeTruthy());

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    // First row is the higher composite (98% beats 10%), and it must never read as flat 0/100.
    expect(within(rows[0] as HTMLElement).getByText('98%')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('10%')).toBeTruthy();
    // A null occZ/pOcc/teamGap/pGap must render as "n/a", never as 0, since 0 would mean
    // "average" and null means "we don't know".
    expect(within(rows[1] as HTMLElement).getAllByText('n/a')).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getAllByText('(n/a)')).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).queryByText('0.00')).toBeNull();

    expect(screen.getByText(/theoretical/i)).toBeTruthy();
  });

  it('opens a player to a clip that links to its match and shows the flagged moment', async () => {
    mockAdmin.players.mockResolvedValue({ players: [] });
    mockAdmin.integrity.mockResolvedValue({
      players: [{ steamid: '10', rounds: 1, fidMax: 0.9, fidP95: 0.4, occZ: 3, teamGap: 2, pFid: 0.9, pOcc: 0.8, pGap: 0.7, composite: 0.8 }],
    });
    mockAdmin.integrityPlayer.mockResolvedValue({
      rounds: [],
      clips: [{ id: 1, matchId: 42, ordinal: 1, half: 1, slot: 0, startMs: 12000, endMs: 14000, kind: 'ghost_track', score: 0.9, detail: {} }],
    });
    render(<Admin session={{ kind: 'active', me }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    await waitFor(() => expect(screen.getByText('10')).toBeTruthy());
    fireEvent.click(screen.getByText('10'));
    await waitFor(() => expect(mockAdmin.integrityPlayer).toHaveBeenCalledWith('10', expect.anything()));

    // Evidence, not a URL that doesn't exist: /match/:id is a real route and the
    // replay viewer lives inside it, so the clip links there with the timestamp
    // as plain text alongside it rather than a fabricated /replay/ deep link.
    const link = await screen.findByRole('link', { name: /Match #42/ });
    expect(link.getAttribute('href')).toBe('/match/42');
    expect(screen.getByText(/12\.0s/)).toBeTruthy();
  });
});
