import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { FleetCellView, FleetState } from '../../api';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { fleet: vi.fn(), fleetCheck: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { AdminFleet } = await import('./AdminFleet');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const P = 'left4dead/addons/sourcemod/plugins/pug-match.smx';
const C = 'left4dead/cfg/server.cfg';
const cell = (label: FleetCellView['label'], highlight: boolean, size = 81241, sha = 'a3e924c6aaaa'): FleetCellView => ({ sig: { size, sha256: sha }, label, highlight, sizeOnly: false });
const state: FleetState = {
  repo: { label: '57add2c', at: '2026-09-24T12:00:00Z' },
  base: { label: 'Rotoblin-AZMod v8.6.4', at: '2026-09-24T12:00:00Z' },
  boxes: [
    { serverId: 1, name: 'Dallas', enabled: true, readAt: '2026-09-24 11:00:00', attemptAt: '2026-09-24 11:00:00', error: null, pending: false },
    { serverId: 2, name: 'Chicago', enabled: true, readAt: '2026-09-23 11:00:00', attemptAt: '2026-09-24 11:00:00', error: 'timed out after 600 s', pending: false },
  ],
  rows: [
    { path: P, area: 'plugins', repo: { size: 81241, sha256: 'a3e924c6aaaa' }, base: null, patchedEverywhere: false, differs: true,
      cells: { 1: cell('neither', true, 81639, 'f7ee35c3bbbb'), 2: cell('repo', false) } },
    { path: C, area: 'configs', repo: null, base: { size: 5, sha256: 'b' }, patchedEverywhere: true, differs: false,
      cells: { 1: cell('neither', false, 6, 'c'), 2: cell('neither', false, 6, 'c') } },
  ],
};

describe('AdminFleet', () => {
  beforeEach(() => { mockAdmin.fleet.mockResolvedValue(state); mockAdmin.fleetCheck.mockResolvedValue({ states: { 1: 'queued' } }); });

  it('shows the references, box chips with errors, and a summary of differences', async () => {
    render(<AdminFleet />);
    expect(await screen.findByText(/Repo: 57add2c/)).toBeTruthy();
    expect(screen.getByText(/Rotoblin-AZMod v8.6.4/)).toBeTruthy();
    expect(screen.getByText(/timed out after 600 s/)).toBeTruthy();
    expect(screen.getByText(/1 difference: pug-match.smx \(Dallas\)/)).toBeTruthy();
  });

  it('shows differences only by default and everything on request', async () => {
    render(<AdminFleet />);
    await screen.findByText(P);
    expect(screen.queryByText(C)).toBeNull();
    fireEvent.click(screen.getByLabelText('Differences only'));
    expect(screen.getByText(C)).toBeTruthy();
    expect(screen.getAllByText(/patched on all boxes/).length).toBeGreaterThan(0);
  });

  it('marks a highlighted cell and checks a box or all', async () => {
    render(<AdminFleet />);
    const hi = await screen.findByText(/81639 · f7ee35c3/);
    expect(hi.closest('td')!.className).toContain('admin-warn');
    fireEvent.click(screen.getByRole('button', { name: 'Check Dallas now' }));
    await waitFor(() => expect(mockAdmin.fleetCheck).toHaveBeenCalledWith({ serverId: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Check all' }));
    await waitFor(() => expect(mockAdmin.fleetCheck).toHaveBeenCalledWith({ all: true }));
  });

  it('filters by area', async () => {
    render(<AdminFleet />);
    await screen.findByText(P);
    fireEvent.click(screen.getByLabelText('Differences only'));
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'configs' } });
    expect(screen.queryByText(P)).toBeNull();
    expect(screen.getByText(C)).toBeTruthy();
  });
});
