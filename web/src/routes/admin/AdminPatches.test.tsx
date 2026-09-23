import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { DriftRow, PatchDetail, PatchSummary } from '../../api';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { balancePatches: vi.fn(), balanceDrift: vi.fn(), balancePatch: vi.fn(), editBalancePatch: vi.fn() },
}));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});

const { AdminPatches } = await import('./AdminPatches');

afterEach(cleanup);

const patches: PatchSummary[] = [
  { id: 1, number: 1, name: 'Baseline', notes: '', source: 'historical', firstSeenAt: '2000-01-01 00:00:00', reviewed: true, rounds: 900, servers: [] },
  { id: 2, number: 2, name: null, notes: '', source: 'detected', firstSeenAt: '2026-09-24 01:00:00', reviewed: false, rounds: 3, servers: [] },
];

const drift: DriftRow[] = [
  { serverId: 2, name: 'chicago', patchId: 2, since: 'x', differsFrom: [{ name: 'dallas', diff: 'added p:l4d_itemlimiter.smx' }] },
];

describe('AdminPatches', () => {
  it('lists patches with an approximate badge and shows drift', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: drift });

    render(<AdminPatches />);

    await waitFor(() => expect(screen.getByText('Baseline')).toBeTruthy());
    expect(screen.getByText('approximate')).toBeTruthy();
    expect(screen.getByText('Unnamed patch 2')).toBeTruthy();
    expect(screen.getByText(/chicago differs from dallas/)).toBeTruthy();
  });

  it('shows all-clear when no server differs from another', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches: [] });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });

    render(<AdminPatches />);

    expect(await screen.findByText('All servers are running the same balance config.')).toBeTruthy();
  });

  it('opens a patch detail panel, renames it and marks it reviewed on save', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    const detail: PatchDetail = {
      ...patches[1],
      inputs: { 'p:l4d_itemlimiter.smx': '1.0' },
      diffVsPrevious: { added: ['p:l4d_itemlimiter.smx'], removed: [], changed: [{ key: 'p:pug-match.smx', from: '1', to: '2' }] },
    };
    mockAdmin.balancePatch.mockResolvedValue(detail);
    mockAdmin.editBalancePatch.mockResolvedValue({ ok: true });
    mockAdmin.balancePatches.mockResolvedValueOnce({ patches }).mockResolvedValue({ patches: [{ ...patches[1], name: 'Fall patch', reviewed: true }] });

    render(<AdminPatches />);
    await waitFor(() => expect(screen.getByText('Unnamed patch 2')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[1]);
    await waitFor(() => expect(mockAdmin.balancePatch).toHaveBeenCalledWith(2));
    expect(await screen.findByText('added p:l4d_itemlimiter.smx')).toBeTruthy();
    expect(screen.getByText('p:pug-match.smx: 1 to 2')).toBeTruthy();

    fireEvent.input(screen.getByLabelText('Patch name'), { target: { value: 'Fall patch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and mark reviewed' }));

    await waitFor(() => expect(mockAdmin.editBalancePatch).toHaveBeenCalledWith(2, { name: 'Fall patch', reviewed: true }));
  });
});
