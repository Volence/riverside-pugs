import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { GameValues as GV } from '../../api';

const { mockApi, mockAdmin } = vi.hoisted(() => ({ mockApi: { gameValues: vi.fn() }, mockAdmin: { gameValues: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi }, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { GameValues } = await import('./GameValues');
const { Values } = await import('../admin/balance/Values');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const data: GV = {
  asOf: { patchId: 6, number: 6 },
  reviewing: false,
  groups: [
    { id: 'tank', label: 'Tank', values: [
      { id: 'z_tank_health', label: 'Tank health', unit: 'HP', note: null, value: '8000', vanilla: '4000', differsFromVanilla: true, status: 'reported',
        lastChange: { at: '2026-09-22 00:00:00', patch: { id: 7, number: 7, name: 'Tank 8000' } } },
      { id: 'z_new', label: 'New thing', unit: null, note: null, value: null, vanilla: null, differsFromVanilla: false, status: 'not_reported', lastChange: null },
    ], rules: [{ id: 'r', text: 'Fire damage to the tank is capped.', active: true, draft: false }] },
    { id: 'smoker', label: 'Smoker', values: [
      { id: 'tongue_drag_damage_amount', label: 'Drag damage', unit: 'HP', note: 'Applied by a plugin.', value: null, vanilla: '3', differsFromVanilla: false, status: 'hidden', lastChange: null },
    ], rules: [{ id: 'd', text: 'Draft wording.', active: false, draft: true }] },
  ],
};

describe('GameValues', () => {
  it('renders groups, values against vanilla, the last change linked to its patch, and rules', async () => {
    mockApi.gameValues.mockResolvedValue({ ...data, groups: [data.groups[0]] });
    render(<GameValues />);
    expect(await screen.findByText('Tank health')).toBeTruthy();
    expect(screen.getByText('8000').closest('tr')!.className).toContain('values-differs');
    expect((screen.getByText('Tank 8000') as HTMLAnchorElement).getAttribute('href')).toBe('/balance#patch-7');
    expect(screen.getByText('not reported yet')).toBeTruthy();
    expect(screen.getByText('unchanged since tracking began')).toBeTruthy();
    expect(screen.getByText('Fire damage to the tank is capped.')).toBeTruthy();
  });

  it('says when a newer config is being reviewed, and not otherwise', async () => {
    mockApi.gameValues.mockResolvedValue({ ...data, reviewing: true });
    render(<GameValues />);
    expect(await screen.findByText(/A newer server config is being reviewed/)).toBeTruthy();
    cleanup();
    mockApi.gameValues.mockResolvedValue(data);
    render(<GameValues />);
    await screen.findByText('Tank health');
    expect(screen.queryByText(/being reviewed/)).toBeNull();
  });

  it('stacks rows on phones: every value cell carries its column label', async () => {
    mockApi.gameValues.mockResolvedValue(data);
    const { container } = render(<GameValues />);
    await screen.findByText('Tank health');
    const cells = [...container.querySelectorAll('table.values-table tbody td')];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((td) => td.getAttribute('data-label'))).toBe(true);
  });

  it('the admin preview tags draft and inactive rules and shows a hidden value\'s note', async () => {
    mockAdmin.gameValues.mockResolvedValue(data);
    render(<Values />);
    expect(await screen.findByText('Applied by a plugin.')).toBeTruthy();
    expect(screen.getByText('draft rule')).toBeTruthy();
    expect(screen.getByText('not active')).toBeTruthy();
  });
});
