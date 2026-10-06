import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { PrefsView } from '../../api';

const { mockEvents } = vi.hoisted(() => ({
  mockEvents: { prefs: vi.fn(), savePrefs: vi.fn() },
}));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
const { PrepPanel } = await import('./PrepPanel');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const prefs: PrefsView = {
  entryId: 5, defaultFour: null, side: null,
  roster: ['p1', 'p2', 'p3', 'p4', 'p5'].map((s) => ({ steamid: s, name: s.toUpperCase() })),
  stages: [{ stageId: 9, ordinal: 1, pool: [{ slug: 'no_mercy', name: 'No Mercy' }, { slug: 'dead_air', name: 'Dead Air' }, { slug: 'death_toll', name: 'Death Toll' }], order: ['dead_air'] }],
};

describe('PrepPanel', () => {
  it('loads the saved order, reorders, and saves the whole thing', async () => {
    mockEvents.prefs.mockResolvedValue(prefs);
    mockEvents.savePrefs.mockResolvedValue({});
    render(<PrepPanel slug="cup" entryId={5} teamName="Rats" />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Dead Air'), expect.stringContaining('No Mercy'), expect.stringContaining('Death Toll')]);
    fireEvent.click(screen.getByRole('button', { name: 'Move Death Toll up' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Side' }), { target: { value: 'infected' } });
    ['P1', 'P2', 'P3', 'P5'].forEach((n) => fireEvent.click(screen.getByRole('checkbox', { name: n })));
    fireEvent.click(screen.getByRole('button', { name: 'Save match prep' }));
    await waitFor(() => expect(mockEvents.savePrefs).toHaveBeenCalledWith('cup', 5, {
      defaultFour: ['p1', 'p2', 'p3', 'p5'], side: 'infected', campaigns: { 9: ['dead_air', 'death_toll', 'no_mercy'] },
    }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('will not save a default four of three', async () => {
    mockEvents.prefs.mockResolvedValue(prefs);
    render(<PrepPanel slug="cup" entryId={5} teamName="Rats" />);
    await screen.findByRole('checkbox', { name: 'P1' });
    ['P1', 'P2', 'P3'].forEach((n) => fireEvent.click(screen.getByRole('checkbox', { name: n })));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save match prep' }) as HTMLButtonElement).disabled).toBe(true));
  });
});
