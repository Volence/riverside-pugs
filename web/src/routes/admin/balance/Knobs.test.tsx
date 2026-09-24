import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { KnobPreview, KnobsState } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { balanceKnobs: vi.fn(), balanceKnobsPreview: vi.fn(), balanceKnobsApply: vi.fn(), balanceKnobsRestore: vi.fn() },
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { Knobs } = await import('./Knobs');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const state: KnobsState = {
  knobs: [
    { cvar: 'z_tank_health', label: 'Tank base health', group: 'tank', type: 'int', min: 6000, max: 10000, step: 250, baseline: '8000' },
    { cvar: 'versus_boss_flow_min', label: 'Boss flow min', group: 'bosses', type: 'float', min: 0.1, max: 0.3, step: 0.05, baseline: '0.10' },
  ],
  current: { z_tank_health: '7500', versus_boss_flow_min: '0.10' },
  base: { patchId: 6, number: 6 }, missing: [], blocking: [],
  active: { id: 1, patchId: 8, patchNumber: 8, patchName: 'Tank 7500', values: {}, createdBy: 'a', createdByName: 'Admin', createdAt: '2026-09-24 10:00:00', supersededAt: null,
    servers: [{ serverId: 1, name: 'dallas', state: 'written', lastError: null, writtenAt: 'x', confirmedAt: null, seen: null, mismatch: null }] },
  restorable: [{ id: 6, number: 6, name: null, source: 'detected' }],
};
const preview = (over: Partial<KnobPreview> = {}): KnobPreview => ({
  values: { z_tank_health: '8000', versus_boss_flow_min: '0.15' }, errors: [], groupsChanged: ['tank', 'bosses'],
  diff: [{ cvar: 'z_tank_health', label: 'Tank base health', group: 'tank', from: '7500', to: '8000' },
    { cvar: 'versus_boss_flow_min', label: 'Boss flow min', group: 'bosses', from: '0.10', to: '0.15' }],
  base: { patchId: 6, number: 6 }, missing: [], blocking: [], fingerprint: 'abcdef0123456789', existingPatch: null, ...over,
});

describe('Knobs', () => {
  it('shows knobs by group with current and baseline, and the rollout state', async () => {
    mockAdmin.balanceKnobs.mockResolvedValue(state);
    render(<Knobs />);
    expect(await screen.findByText('Tank base health')).toBeTruthy();
    expect(screen.getByText('tank')).toBeTruthy();
    expect(screen.getByText(/baseline 8000/)).toBeTruthy();
    expect(screen.getByText(/dallas: written, awaiting first match/)).toBeTruthy();
  });

  it('reset to baseline fills the draft, preview warns about two groups', async () => {
    mockAdmin.balanceKnobs.mockResolvedValue(state);
    mockAdmin.balanceKnobsPreview.mockResolvedValue(preview());
    render(<Knobs />);
    await screen.findByText('Tank base health');
    fireEvent.click(screen.getByText('Reset to baseline'));
    expect((screen.getByLabelText('Tank base health') as HTMLInputElement).value).toBe('8000');
    fireEvent.click(screen.getByText('Preview'));
    await waitFor(() => expect(mockAdmin.balanceKnobsPreview).toHaveBeenCalledWith({ z_tank_health: '8000', versus_boss_flow_min: '0.10' }));
    expect(await screen.findByText(/more than one group/)).toBeTruthy();
  });

  it('apply needs the typed name and sends values, name and notes', async () => {
    mockAdmin.balanceKnobs.mockResolvedValue(state);
    mockAdmin.balanceKnobsPreview.mockResolvedValue(preview());
    mockAdmin.balanceKnobsApply.mockResolvedValue({ ok: true, rolloutId: 2, patchId: 9, reused: false });
    render(<Knobs />);
    await screen.findByText('Tank base health');
    fireEvent.click(screen.getByText('Preview'));
    await screen.findByText(/New patch/);
    fireEvent.input(screen.getByLabelText('Patch name'), { target: { value: 'Back to 8000' } });
    fireEvent.input(screen.getByLabelText('Patch notes'), { target: { value: 'revert' } });
    const apply = screen.getByText('Apply to all servers') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Type the patch name to confirm'), { target: { value: 'Back to 8000' } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => expect(mockAdmin.balanceKnobsApply).toHaveBeenCalledWith({
      values: { z_tank_health: '8000', versus_boss_flow_min: '0.15' }, name: 'Back to 8000', notes: 'revert' }));
  });

  it('blocking servers disable apply and are listed', async () => {
    mockAdmin.balanceKnobs.mockResolvedValue({ ...state, blocking: [{ serverId: 2, name: 'chicago', diff: 'added p:x.smx' }] });
    render(<Knobs />);
    expect(await screen.findByText(/chicago differs in more than knob values/)).toBeTruthy();
  });

  it('restore fills the draft from a patch and says plugins stay', async () => {
    mockAdmin.balanceKnobs.mockResolvedValue(state);
    mockAdmin.balanceKnobsRestore.mockResolvedValue({ values: { z_tank_health: '9000', versus_boss_flow_min: '0.20' }, notes: [] });
    render(<Knobs />);
    await screen.findByText('Tank base health');
    fireEvent.click(screen.getByText('Restore'));
    await waitFor(() => expect((screen.getByLabelText('Tank base health') as HTMLInputElement).value).toBe('9000'));
    expect(screen.getByText(/plugins and files stay as they are now/)).toBeTruthy();
  });
});
