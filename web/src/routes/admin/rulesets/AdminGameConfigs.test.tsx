import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminGameConfig } from '../../../api';

const { mockAdmin, mockConfirm } = vi.hoisted(() => ({
  mockAdmin: { gameConfigs: vi.fn(), createGameConfig: vi.fn(), updateGameConfig: vi.fn(), deleteGameConfig: vi.fn() },
  mockConfirm: vi.fn(),
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: mockConfirm }));
const { AdminGameConfigs } = await import('./AdminGameConfigs');
const { ApiError } = await import('../../../api');

const ROWS: AdminGameConfig[] = [
  { key: 'standard', label: 'Standard (Rotoblin PUG 4v4)', cfg: 'pug_match', enabled: true, locked: true, inUse: { bookings: 3, events: 0 } },
  { key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4', enabled: true, locked: false, inUse: { bookings: 0, events: 1 } },
  { key: 'spare', label: 'Spare config', cfg: 'spare', enabled: false, locked: false, inUse: { bookings: 0, events: 0 } },
];
const rowOf = (label: string) => screen.getByText(label, { selector: 'strong' }).closest('li') as HTMLElement;
const button = (el: HTMLElement, name: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent === name) ?? null;

afterEach(() => cleanup());
beforeEach(() => {
  for (const f of [...Object.values(mockAdmin), mockConfirm]) f.mockReset();
  mockAdmin.gameConfigs.mockResolvedValue({ gameConfigs: ROWS });
  for (const f of [mockAdmin.createGameConfig, mockAdmin.updateGameConfig, mockAdmin.deleteGameConfig]) f.mockResolvedValue({ ok: true });
  mockConfirm.mockResolvedValue(true);
});

describe('AdminGameConfigs', () => {
  it('shows each config with the cfg it execs and what uses it; standard can only be relabelled', async () => {
    render(<AdminGameConfigs />);
    await screen.findByText('ZoneMod 4v4', { selector: 'strong' });
    expect(rowOf('Standard (Rotoblin PUG 4v4)').textContent).toContain('exec pug_match');
    expect(rowOf('Standard (Rotoblin PUG 4v4)').textContent).toContain('In use: 3 open bookings');
    expect(button(rowOf('Standard (Rotoblin PUG 4v4)'), 'Turn off')).toBeNull();
    expect(button(rowOf('Standard (Rotoblin PUG 4v4)'), 'Delete')).toBeNull();
    expect(button(rowOf('ZoneMod 4v4'), 'Delete')).toBeNull();
    expect(rowOf('Spare config').textContent).toContain('Off');
    expect(button(rowOf('Spare config'), 'Turn on')).toBeTruthy();
  });

  it('relabels, turns off and deletes (after asking)', async () => {
    render(<AdminGameConfigs />);
    await screen.findByText('ZoneMod 4v4', { selector: 'strong' });
    fireEvent.input(screen.getByLabelText('Label for zonemod'), { target: { value: 'ZoneMod' } });
    fireEvent.click(button(rowOf('ZoneMod 4v4'), 'Save label')!);
    await waitFor(() => expect(mockAdmin.updateGameConfig).toHaveBeenCalledWith('zonemod', { label: 'ZoneMod', enabled: true }));
    fireEvent.click(button(rowOf('ZoneMod 4v4'), 'Turn off')!);
    await waitFor(() => expect(mockAdmin.updateGameConfig).toHaveBeenCalledWith('zonemod', { label: 'ZoneMod 4v4', enabled: false }));
    fireEvent.click(button(rowOf('Spare config'), 'Delete')!);
    await waitFor(() => expect(mockAdmin.deleteGameConfig).toHaveBeenCalledWith('spare'));
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete Spare config?', danger: true }));
  });

  it('adds a config, warning that the cfg must be on every pool server, and shows a refusal', async () => {
    mockAdmin.createGameConfig.mockRejectedValueOnce(new ApiError(400, 'A cfg name is lowercase letters, digits and underscores, without .cfg.'));
    render(<AdminGameConfigs />);
    await screen.findByText('ZoneMod 4v4', { selector: 'strong' });
    fireEvent.input(screen.getByLabelText('Key'), { target: { value: 'confogl' } });
    fireEvent.input(screen.getByLabelText('Label'), { target: { value: 'Confogl 4v4' } });
    fireEvent.input(screen.getByLabelText('Cfg'), { target: { value: 'confogl.cfg' } });
    expect(screen.getByText(/must already be on every pool server/).textContent).toContain('exec confogl.cfg');
    fireEvent.click(screen.getByRole('button', { name: 'Add config' }));
    expect(await screen.findByText('A cfg name is lowercase letters, digits and underscores, without .cfg.')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Cfg'), { target: { value: 'confogl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add config' }));
    await waitFor(() => expect(mockAdmin.createGameConfig).toHaveBeenLastCalledWith({ key: 'confogl', label: 'Confogl 4v4', cfg: 'confogl' }));
  });
});
