import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ReleaseOverview, ReleaseReviewView } from '../../api';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: {
  releases: vi.fn(), releasesRefresh: vi.fn(), releaseStage: vi.fn(), release: vi.fn(),
  releaseDeploy: vi.fn(), releaseContinue: vi.fn(), releaseUndo: vi.fn(),
} }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../components/Confirm', () => ({ confirm: async () => true }));
const { AdminDeploy } = await import('./AdminDeploy');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const boxes = [{ serverId: 1, name: 'Dallas', state: 'staged', error: null, updatedAt: 'x' }, { serverId: 2, name: 'Chicago', state: 'staged', error: null, updatedAt: 'x' }];
const summary = { id: 5, kind: 'deploy' as const, undoOf: null, commit: 'abc1234def', short: 'abc1234', state: 'staged', createdBy: '1', createdAt: '2026-09-24 10:00:00',
  deployedBy: null, deployedAt: null, canaryServerId: null, balance: null, backupsExpired: false, boxes };
const overview: ReleaseOverview = {
  commits: [{ hash: 'abc1234def', short: 'abc1234', subject: 'Tank 7500', author: 'Volence', at: '2026-09-24T10:00:00Z', releaseId: null }],
  releases: [{ ...summary, id: 4, state: 'done', deployedAt: '2026-09-23 10:00:00', boxes: boxes.map((b) => ({ ...b, state: 'restarted' })) }],
  inFlight: null, devMode: false, fetchError: null,
};
const review: ReleaseReviewView = { ...summary, subject: 'Tank 7500', github: 'https://github.com/x/y/commit/abc', invalid: [], suggestion: 'possibly_balance',
  perBox: [
    { serverId: 1, name: 'Dallas', lines: ['cfg changed: cfg/pug_match.cfg', '  z_tank_health 8000 → 7500'], warnings: [], deployable: true },
    { serverId: 2, name: 'Chicago', lines: ['cfg changed: cfg/pug_match.cfg', '  z_tank_health 8000 → 7500'], warnings: ['reading is over 24 hours old: check it now first'], deployable: true },
  ],
  groups: [{ servers: ['Dallas', 'Chicago'], lines: ['cfg changed: cfg/pug_match.cfg', '  z_tank_health 8000 → 7500'] }] };

describe('AdminDeploy', () => {
  beforeEach(() => {
    mockAdmin.releases.mockResolvedValue(overview);
    mockAdmin.releaseStage.mockResolvedValue({ id: 5 });
    mockAdmin.release.mockResolvedValue(review);
    mockAdmin.releaseDeploy.mockResolvedValue({ ok: true });
    mockAdmin.releaseUndo.mockResolvedValue({ id: 6 });
  });

  it('stages a commit and shows the review grouped by box with warnings', async () => {
    render(<AdminDeploy />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review abc1234' }));
    await waitFor(() => expect(mockAdmin.releaseStage).toHaveBeenCalledWith('abc1234def'));
    expect(await screen.findByText('Dallas, Chicago')).toBeTruthy();
    expect(screen.getAllByText(/z_tank_health 8000 → 7500/).length).toBe(1);
    expect(screen.getByText(/Chicago: reading is over 24 hours old/)).toBeTruthy();
  });

  it('deploys to the picked boxes with a balance decision; balance needs a name', async () => {
    render(<AdminDeploy />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review abc1234' }));
    await screen.findByText('Dallas, Chicago');
    fireEvent.click(screen.getByLabelText('Chicago'));           // untick
    fireEvent.click(screen.getByLabelText('Balance patch'));
    const deploy = screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement;
    expect(deploy.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Patch name'), { target: { value: 'Tank 7500' } });
    fireEvent.click(deploy);
    await waitFor(() => expect(mockAdmin.releaseDeploy).toHaveBeenCalledWith(5, {
      targets: [1], canary: null, balance: { decision: 'balance', name: 'Tank 7500', notes: '' } }));
  });

  it('shows history with per-box states and undoes one box', async () => {
    render(<AdminDeploy />);
    expect(await screen.findByText(/Release 4/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo release 4 on Dallas' }));
    await waitFor(() => expect(mockAdmin.releaseUndo).toHaveBeenCalledWith(4, [1]));
  });

  it('says deploys are off in dev mode', async () => {
    mockAdmin.releases.mockResolvedValue({ ...overview, devMode: true });
    render(<AdminDeploy />);
    expect(await screen.findByText(/disabled in dev mode/)).toBeTruthy();
  });
});
