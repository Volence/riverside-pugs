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
  { id: 1, number: 1, name: 'Sky pounce fix', notes: '', source: 'historical', firstSeenAt: '2026-09-21 20:10:00', reviewed: true, rounds: 220, countedRounds: 216, servers: [] },
  { id: 2, number: 2, name: 'Saferoom lock', notes: '', source: 'historical', firstSeenAt: '2026-09-22 21:36:00', reviewed: true, rounds: 138, countedRounds: 136, servers: [] },
];
const side = { matches: 40, rounds: 80, meanMu: 25, meanGap: 0, olderEngineRounds: 0, historical: true };
const row = (metric: string, group: string, verdict: string, over = {}) => ({
  metric, group, description: `${metric} description`, phase: 'all', a: 0.18, b: 0.24, diff: 0.06, rel: 0.33, lo: 0.01, hi: 0.1,
  p: 0.01, verdict, moreMatches: verdict === 'too_early' ? 60 : null, excludedMaps: [], noSharedMaps: false, nA: 40, nB: 40, ...over,
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
  mockAdmin.balanceMetric.mockResolvedValue({ metric: 'x', phase: 'all', trend: [], boundaries: [], perMap: [], perPatch: [], examples: [] });
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

  // Regression: phaseFilter is local state applied as a hard filter, but its
  // select is only rendered while phases is split. Picking "Tank alive" and
  // then switching Phases back to whole-round-only used to leave every row
  // filtered out with no visible control to explain why.
  it('resets the phase filter instead of hiding whole-round rows when leaving split mode', async () => {
    const splitResult = {
      ...result,
      rows: [row('hunter.skeet_rate', 'hunter', 'real', { phase: 'all' }), row('tank.killed_rate', 'tank', 'real', { phase: 'tank' })],
      counts: { real: 2, too_early: 0, noise: 0, no_data: 0 },
    };
    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceCompare.mockResolvedValue(splitResult);
    history.replaceState(null, '', '/admin/balance?a=1&b=2&phases=split');
    render(<LocationProvider><Compare /></LocationProvider>);
    await waitFor(() => screen.getByText('hunter.skeet_rate description'));

    // Filtering to a phase with no matching rows shows the empty-filter message.
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'witch' } });
    await waitFor(() => expect(screen.queryByText('hunter.skeet_rate description')).toBeNull());
    expect(screen.getByText('No rows match these filters.')).toBeTruthy();

    // Filtering to tank shows only the tank row.
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'tank' } });
    await waitFor(() => expect(screen.getByText('tank.killed_rate description')).toBeTruthy());
    expect(screen.queryByText('hunter.skeet_rate description')).toBeNull();

    // Switching Phases back to whole-round-only must bring the whole-round
    // row back, not hide everything behind the stale "tank" filter.
    fireEvent.change(screen.getByLabelText('Phases'), { target: { value: 'all' } });
    await waitFor(() => expect(screen.getByText('hunter.skeet_rate description')).toBeTruthy());
    expect(screen.getByText('tank.killed_rate description')).toBeTruthy();

    // And the filter itself is reset, not just ignored: going back to split
    // shows "Every phase" again, not the old "tank" leftover.
    fireEvent.change(screen.getByLabelText('Phases'), { target: { value: 'split' } });
    await waitFor(() => expect((screen.getByLabelText('Show') as HTMLSelectElement).value).toBe('any'));
  });

  it('opens the quick check on Enter', async () => {
    renderAt();
    await waitFor(() => screen.getByText('hunter.skeet_rate description'));
    const tr = screen.getByText('hunter.skeet_rate description').closest('tr')!;
    fireEvent.keyDown(tr, { key: 'Enter' });
    await waitFor(() => expect(mockAdmin.balanceMetric).toHaveBeenCalledWith(
      expect.anything(), 'hunter.skeet_rate', 'all', expect.anything(),
    ));
    expect(document.querySelector('.balance-check')).toBeTruthy();
  });

  it('shows the older-metric-definition note on a side with older engine rounds', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceCompare.mockResolvedValue({ ...result, a: { ...side, olderEngineRounds: 7 } });
    history.replaceState(null, '', '/admin/balance');
    render(<LocationProvider><Compare /></LocationProvider>);
    await waitFor(() => screen.getByText('hunter.skeet_rate description'));
    expect(screen.getByText(/7 rounds use an older metric definition/)).toBeTruthy();
  });

  it('labels patches with the rounds the comparison counts', async () => {
    renderAt();
    await waitFor(() => screen.getByText('hunter.skeet_rate description'));
    expect(screen.getAllByText(/Sky pounce fix \(216 rounds counted\)/)).toHaveLength(2);
  });

  it('defaults to the two newest patches that have counted rounds', async () => {
    const fresh = { ...patches[1], id: 3, number: 3, name: 'Fresh', firstSeenAt: '2026-09-23 20:00:00', rounds: 6, countedRounds: 0 };
    mockAdmin.balancePatches.mockResolvedValue({ patches: [...patches, fresh] });
    mockAdmin.balanceCompare.mockResolvedValue(result);
    history.replaceState(null, '', '/admin/balance');
    render(<LocationProvider><Compare /></LocationProvider>);
    await waitFor(() => expect(mockAdmin.balanceCompare).toHaveBeenCalledWith(expect.objectContaining({ a: [1], b: [2] }), expect.anything()));
  });

  it('does not default to a patch that was merged into another', async () => {
    // Production 2026-09-24: patch 7 (one match) was merged into patch 6 when
    // l4d_tvwatch joined the ignored list. It keeps its rounds, but opening
    // the page on "6 vs 7" compares one config with itself.
    const merged = { ...patches[1], id: 3, number: 3, name: null, source: 'detected', firstSeenAt: '2026-09-24 05:41:10', rounds: 8, countedRounds: 8, merged: true };
    mockAdmin.balancePatches.mockResolvedValue({ patches: [...patches, merged] });
    mockAdmin.balanceCompare.mockResolvedValue(result);
    history.replaceState(null, '', '/admin/balance');
    render(<LocationProvider><Compare /></LocationProvider>);
    await waitFor(() => expect(mockAdmin.balanceCompare).toHaveBeenCalledWith(expect.objectContaining({ a: [1], b: [2] }), expect.anything()));
  });

  it('explains an empty side instead of showing chips and rows', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceCompare.mockResolvedValue({ ...result, b: { ...side, matches: 0, rounds: 0 }, rows: [], counts: { real: 0, too_early: 0, noise: 0, no_data: 0 } });
    history.replaceState(null, '', '/admin/balance?a=1&b=2');
    render(<LocationProvider><Compare /></LocationProvider>);
    await waitFor(() => expect(screen.getByText('Side B has no finished matches yet (live, voided and unfinished matches are not counted).')).toBeTruthy());
    expect(screen.queryByText(/real changes/)).toBeNull();
    expect(document.querySelector('.admin-table')).toBeNull();
  });

  it('warns when a side pools patches and when a patch is on both sides', async () => {
    renderAt('?a=1,2&b=2');
    await waitFor(() => screen.getByText('hunter.skeet_rate description'));
    expect(screen.getByText(/Side A pools 2 patches \(Sky pounce fix, Saferoom lock\)/)).toBeTruthy();
    expect(screen.getByText('Patch Saferoom lock is on both sides; the sides are no longer independent.')).toBeTruthy();
  });

  it('shows "no shared maps" and says "1 more match" in the verdict column', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceCompare.mockResolvedValue({
      ...result,
      rows: [
        row('hunter.skeet_rate', 'hunter', 'no_data', { noSharedMaps: true, a: null, b: null, diff: null, p: null }),
        row('tank.killed_rate', 'tank', 'too_early', { moreMatches: 1 }),
      ],
      counts: { real: 0, too_early: 1, noise: 0, no_data: 1 },
    });
    history.replaceState(null, '', '/admin/balance?a=1&b=2');
    render(<LocationProvider><Compare /></LocationProvider>);
    await waitFor(() => screen.getByText('hunter.skeet_rate description'));
    expect(screen.getByText('no shared maps')).toBeTruthy();
    expect(screen.getByText(/, about 1 more match$/)).toBeTruthy();
  });

  it('dims the table while the next comparison loads', async () => {
    renderAt('?a=1&b=2');
    await waitFor(() => screen.getByText('hunter.skeet_rate description'));
    expect(document.querySelector('.balance-table.is-stale')).toBeNull();
    let release: (v: unknown) => void = () => {};
    mockAdmin.balanceCompare.mockReturnValue(new Promise((r) => { release = r; }));
    fireEvent.change(screen.getByLabelText('Games'), { target: { value: 'queue' } });
    await waitFor(() => expect(document.querySelector('.balance-table.is-stale')).toBeTruthy());
    release(result);
    await waitFor(() => expect(document.querySelector('.balance-table.is-stale')).toBeNull());
  });
});
