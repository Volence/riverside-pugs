import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminPracticeLease, AdminPracticePlayer } from '../../api';

const { mockAdmin, mockApi, mockConfirm } = vi.hoisted(() => ({
  mockAdmin: { practiceLeases: vi.fn(), practicePlayers: vi.fn(), practiceKick: vi.fn() },
  mockApi: { endPractice: vi.fn() },
  mockConfirm: vi.fn(),
}));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi }, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../components/Confirm', () => ({ confirm: mockConfirm }));

const { PracticeLeasesPanel, playersCell } = await import('./PracticeLeasesPanel');
const { ApiError } = await import('../../api');

const ROW: AdminPracticeLease = {
  id: 2, kind: 'park', server: 'Riverside #4', owner: { steamid: '76561199000000001', name: 'mayhem' },
  state: 'ready', humans: 6, map: 'l4d_vs_hospital01_apartment', createdAt: '', endsAt: '', warnedAt: null, endReason: null,
};

afterEach(cleanup);
beforeEach(() => {
  for (const fn of [...Object.values(mockAdmin), ...Object.values(mockApi), mockConfirm]) fn.mockReset();
  mockAdmin.practicePlayers.mockResolvedValue({ players: [] });
});

const P = (over: Partial<AdminPracticePlayer> = {}): AdminPracticePlayer => ({
  userid: 7, name: 'Dust', steamid64: '76561198030413993', connectedFor: '05:09', ping: 33, team: 2, trainer: 1, onSite: true, ...over,
});

describe('PracticeLeasesPanel', () => {
  it('lists open practice servers and ends one after asking', async () => {
    mockAdmin.practiceLeases.mockResolvedValue({ leases: [ROW] });
    mockConfirm.mockResolvedValue(true);
    mockApi.endPractice.mockResolvedValue({});
    render(<PracticeLeasesPanel nudge={0} />);
    expect((await screen.findByRole('link', { name: 'Riverside #4' })).getAttribute('href')).toBe('/practice/2');
    expect(screen.getByText('Practice Park')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await waitFor(() => expect(mockApi.endPractice).toHaveBeenCalledWith(2));
    expect(mockConfirm.mock.calls[0][0].title).toBe("Close mayhem's practice park on Riverside #4?");
  });

  it('renders nothing when no lease is open', async () => {
    mockAdmin.practiceLeases.mockResolvedValue({ leases: [] });
    const { container } = render(<PracticeLeasesPanel nudge={0} />);
    await waitFor(() => expect(mockAdmin.practiceLeases).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('PracticeLeasesPanel players', () => {
  it('shows the count and names in the row without opening it', async () => {
    mockAdmin.practiceLeases.mockResolvedValue({ leases: [ROW] });
    mockAdmin.practicePlayers.mockResolvedValue({ players: [P(), P({ userid: 9, name: 'RollingSix', steamid64: null, onSite: false })] });
    render(<PracticeLeasesPanel nudge={0} />);
    expect(await screen.findByText('2: Dust, RollingSix')).toBeTruthy();
    expect(mockAdmin.practicePlayers).toHaveBeenCalledWith(2, expect.anything());
  });

  it('opens into who is on it: profile and file links for known players, team, trainer, time, ping', async () => {
    mockAdmin.practiceLeases.mockResolvedValue({ leases: [ROW] });
    mockAdmin.practicePlayers.mockResolvedValue({ players: [P(), P({ userid: 9, name: 'RollingSix', steamid64: null, onSite: false, team: null, trainer: null })] });
    render(<PracticeLeasesPanel nudge={0} />);
    fireEvent.click(await screen.findByText('2: Dust, RollingSix'));
    expect((await screen.findByRole('link', { name: 'Dust' })).getAttribute('href')).toBe('/player/76561198030413993');
    expect(screen.getByRole('link', { name: 'file' }).getAttribute('href')).toBe('/admin/people/76561198030413993');
    expect(screen.queryByRole('link', { name: 'RollingSix' })).toBeNull();
    expect(screen.getByText('Survivor')).toBeTruthy();
    expect(screen.getByText('Skeet trainer')).toBeTruthy();
    expect(screen.getAllByText('05:09')).toHaveLength(2);
    // Opening reads again at once.
    await waitFor(() => expect(mockAdmin.practicePlayers.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('kicks with the typed reason, no dialog, then re-reads; a refusal shows inline', async () => {
    mockAdmin.practiceLeases.mockResolvedValue({ leases: [ROW] });
    mockAdmin.practicePlayers.mockResolvedValue({ players: [P()] });
    mockAdmin.practiceKick.mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new ApiError(404, 'That player is not on this server any more.'));
    render(<PracticeLeasesPanel nudge={0} />);
    fireEvent.click(await screen.findByText('1: Dust'));
    const input = await screen.findByLabelText('Reason to kick Dust');
    fireEvent.input(input, { target: { value: 'spawn camping' } });
    const before = mockAdmin.practicePlayers.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Kick' }));
    await waitFor(() => expect(mockAdmin.practiceKick).toHaveBeenCalledWith(2, 7, 'spawn camping'));
    expect(mockConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(mockAdmin.practicePlayers.mock.calls.length).toBeGreaterThan(before));
    fireEvent.click(screen.getByRole('button', { name: 'Kick' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That player is not on this server any more.');
  });

  it('writes the players cell', () => {
    expect(playersCell(null, 3)).toBe('3');
    expect(playersCell([], 3)).toBe('0');
    expect(playersCell([P(), P({ name: 'B' })], 0)).toBe('2: Dust, B');
  });
});
