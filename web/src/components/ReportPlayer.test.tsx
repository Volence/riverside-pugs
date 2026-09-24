import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { reportEligibility: vi.fn(), report: vi.fn(), fileReport: vi.fn(), myReports: vi.fn(), reportChat: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});

const { ReportPlayer } = await import('./ReportPlayer');
const { MyReports } = await import('./MyReports');

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.fileReport.mockResolvedValue({ ok: true });
});

describe('ReportPlayer on a profile', () => {
  const target = { steamid: '7', name: 'Walls' };

  it('reports a fixed player with no match and never asks for eligibility', async () => {
    render(<ReportPlayer target={target} />);
    fireEvent.click(screen.getByRole('button', { name: 'Report Walls' }));
    expect(screen.queryByLabelText('Player')).toBeNull();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'toxicity' } });
    fireEvent.input(screen.getByLabelText('Details'), { target: { value: 'in voice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(mockApi.fileReport).toHaveBeenCalledWith({ targetId: '7', category: 'toxicity', text: 'in voice' }));
    expect(mockApi.reportEligibility).not.toHaveBeenCalled();
    await screen.findByText(/moderators will look at it/i);
  });

  it('the safety category explains itself and needs details', async () => {
    render(<ReportPlayer target={target} />);
    fireEvent.click(screen.getByRole('button', { name: 'Report Walls' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'unsafe' } });
    expect(screen.getByText(/seen only by the people who run the community/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send report' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Details'), { target: { value: 'what happened' } });
    expect((screen.getByRole('button', { name: 'Send report' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ReportPlayer on a match page', () => {
  it('keeps a player you already reported selectable, so a safety report can still name that match', async () => {
    mockApi.reportEligibility.mockResolvedValue({ canReport: true, targets: [{ steamid: '7', name: 'Walls', alreadyReported: true }] });
    mockApi.report.mockResolvedValue({ ok: true });
    render(<ReportPlayer matchId={66} />);
    fireEvent.click(screen.getByRole('button', { name: 'Report a player' }));
    const option = await screen.findByRole('option', { name: 'Walls (reported)' }) as HTMLOptionElement;
    expect(option.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Player'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'unsafe' } });
    fireEvent.input(screen.getByLabelText('Details'), { target: { value: 'what happened' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(mockApi.report).toHaveBeenCalledWith(66, '7', 'unsafe', 'what happened'));
  });

  it('opens itself when a replay moment is handed to it, says what is attached, and sends it', async () => {
    mockApi.reportEligibility.mockResolvedValue({ canReport: true, targets: [{ steamid: '7', name: 'Walls', alreadyReported: false }] });
    mockApi.report.mockResolvedValue({ ok: true });
    const cleared = vi.fn();
    render(<ReportPlayer matchId={66} moment={{ ordinal: 2, half: 1, tMs: 61500 }} onClearMoment={cleared} />);
    await screen.findByText(/map 3, round 1, at 1:01/);
    fireEvent.change(await screen.findByLabelText('Player'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'cheating' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(mockApi.report).toHaveBeenCalledWith(66, '7', 'cheating', '', { ordinal: 2, half: 1, tMs: 61500 }));
    await waitFor(() => expect(cleared).toHaveBeenCalled());
  });

  it('a moment can be taken off again before sending', async () => {
    mockApi.reportEligibility.mockResolvedValue({ canReport: true, targets: [] });
    const cleared = vi.fn();
    render(<ReportPlayer matchId={66} moment={{ ordinal: 0, half: 2, tMs: 5000 }} onClearMoment={cleared} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Detach' }));
    expect(cleared).toHaveBeenCalled();
  });
});

describe('MyReports', () => {
  it('lists what you filed and whether it is open, and nothing about the outcome', async () => {
    mockApi.myReports.mockResolvedValue({ reports: [
      { id: 1, targetId: '7', targetName: 'Walls', category: 'cheating', matchId: 66, createdAt: '2026-09-21T10:00:00.000Z', status: 'closed' },
    ] });
    render(<MyReports />);
    await screen.findByText('Walls');
    expect(screen.getByText(/closed/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '#66' }).getAttribute('href')).toBe('/match/66');
  });

  it('renders nothing when you have filed none', async () => {
    mockApi.myReports.mockResolvedValue({ reports: [] });
    const { container } = render(<MyReports />);
    await waitFor(() => expect(mockApi.myReports).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('offers a chat on an open report and shows the link it gets back, or the reason it cannot', async () => {
    mockApi.myReports.mockResolvedValue({ reports: [
      { id: 3, targetId: '7', targetDiscordId: null, targetName: 'Walls', category: 'cheating', matchId: null, createdAt: '2026-09-21T10:00:00.000Z', status: 'open' },
      { id: 4, targetId: '8', targetDiscordId: null, targetName: 'Gone', category: 'afk', matchId: null, createdAt: '2026-09-20T10:00:00.000Z', status: 'closed' },
    ] });
    mockApi.reportChat.mockResolvedValue({ ok: true, url: 'https://discord.com/channels/g1/5' });
    render(<MyReports />);
    const buttons = await screen.findAllByRole('button', { name: 'Chat with the moderators' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(mockApi.reportChat).toHaveBeenCalledWith(3));
    expect((await screen.findByText('Open the chat in Discord')).getAttribute('href')).toBe('https://discord.com/channels/g1/5');
  });
});
