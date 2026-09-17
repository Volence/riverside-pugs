import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockAdmin, mockApi } = vi.hoisted(() => ({
  mockAdmin: {
    players: vi.fn(), player: vi.fn(), ban: vi.fn(), overview: vi.fn(), settings: vi.fn(), saveSetting: vi.fn(),
    reports: vi.fn(), audit: vi.fn(),
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
