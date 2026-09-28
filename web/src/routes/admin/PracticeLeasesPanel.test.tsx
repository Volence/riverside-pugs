import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminPracticeLease } from '../../api';

const { mockAdmin, mockApi, mockConfirm } = vi.hoisted(() => ({
  mockAdmin: { practiceLeases: vi.fn() },
  mockApi: { endPractice: vi.fn() },
  mockConfirm: vi.fn(),
}));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi }, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../components/Confirm', () => ({ confirm: mockConfirm }));

const { PracticeLeasesPanel } = await import('./PracticeLeasesPanel');

const ROW: AdminPracticeLease = {
  id: 2, kind: 'park', server: 'Riverside #4', owner: { steamid: '76561199000000001', name: 'mayhem' },
  state: 'ready', humans: 6, map: 'l4d_vs_hospital01_apartment', createdAt: '', endsAt: '', warnedAt: null, endReason: null,
};

afterEach(cleanup);
beforeEach(() => { mockAdmin.practiceLeases.mockReset(); mockApi.endPractice.mockReset(); mockConfirm.mockReset(); });

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
