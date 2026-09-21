import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { reportEligibility: vi.fn(), report: vi.fn(), fileReport: vi.fn(), myReports: vi.fn() },
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
});
