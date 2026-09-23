import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { balancePatches: vi.fn(), balanceCompare: vi.fn(), balanceMetric: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { Compare } = await import('./Compare');
// Several tests here assert `.not.toHaveBeenCalled()`; without clearing the
// mock, call history from earlier `it`s in this file leaks in (the mock is a
// single vi.fn() shared across the whole file, not reset by cleanup() alone).
// See EndorsePanel.test.tsx / LobbyNotice.test.tsx for the same pattern.
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const patches = [
  { id: 1, number: 1, name: 'Sky pounce fix', notes: '', source: 'historical', firstSeenAt: '2026-09-21 20:10:00', reviewed: true, rounds: 216, servers: [] },
  { id: 2, number: 2, name: 'Saferoom lock', notes: '', source: 'historical', firstSeenAt: '2026-09-22 21:36:00', reviewed: true, rounds: 136, servers: [] },
];
const side = { matches: 40, rounds: 80, meanMu: 25, meanGap: 0, olderEngineRounds: 0, historical: true };
const row = (metric: string, group: string, verdict: string, over = {}) => ({
  metric, group, description: `${metric} description`, phase: 'all', a: 0.18, b: 0.24, diff: 0.06, rel: 0.33, lo: 0.01, hi: 0.1,
  p: 0.01, verdict, moreMatches: verdict === 'too_early' ? 60 : null, excludedMaps: [], nA: 40, nB: 40, ...over,
});
const result = {
  a: side, b: side, ms: 5,
  rows: [row('hunter.skeet_rate', 'hunter', 'real'), row('tank.killed_rate', 'tank', 'too_early'), row('round.saferoom', 'outcomes', 'noise')],
  counts: { real: 1, too_early: 1, noise: 1, no_data: 0 },
  banners: { skill: null, approximate: true },
};

function renderAt(search = '') {
  history.replaceState(null, '', `/admin/balance${search}`);
  mockAdmin.balancePatches.mockResolvedValue({ patches });
  mockAdmin.balanceCompare.mockResolvedValue(result);
  return render(<LocationProvider><Compare /></LocationProvider>);
}

describe('Compare', () => {
  it('defaults to newest vs previous and shows the ranked rows with verdicts', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('hunter.skeet_rate description')).toBeTruthy());
    expect(mockAdmin.balanceCompare).toHaveBeenCalledWith(expect.objectContaining({ a: [1], b: [2] }), expect.anything());
    expect(screen.getByText('real change')).toBeTruthy();
    expect(screen.getByText(/about 60 more matches/)).toBeTruthy();
    expect(screen.getByText(/approximate/i)).toBeTruthy();
  });

  it('groups rows by topic', async () => {
    renderAt('?a=1&b=2&view=topic');
    await waitFor(() => expect(screen.getByText(/Hunter \(1 real/)).toBeTruthy());
    expect(screen.getByText(/Tank \(.*1 too early/)).toBeTruthy();
  });

  it('filters by a summary chip', async () => {
    renderAt();
    await waitFor(() => screen.getByText('hunter.skeet_rate description'));
    fireEvent.click(screen.getByText(/1 probably noise/));
    await waitFor(() => expect(screen.queryByText('hunter.skeet_rate description')).toBeNull());
    expect(screen.getByText('round.saferoom description')).toBeTruthy();
  });

  it('asks for patches on both sides when one is empty', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches: [patches[0]] });
    mockAdmin.balanceCompare.mockResolvedValue(result);
    history.replaceState(null, '', '/admin/balance');
    render(<LocationProvider><Compare /></LocationProvider>);
    await waitFor(() => expect(screen.getByText(/at least one patch on each side/i)).toBeTruthy());
    expect(mockAdmin.balanceCompare).not.toHaveBeenCalled();
  });
});
