import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { balanceMetric: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { QuickCheck } = await import('./QuickCheck');
afterEach(cleanup);

const query = { a: [1], b: [2], origin: 'all' as const, maps: [], phases: 'all' as const };
const row = {
  metric: 'round.saferoom', group: 'outcomes', description: 'Saferoom', phase: 'all' as const, a: 0.23, b: 0.29, diff: 0.06,
  rel: 0.26, lo: -0.03, hi: 0.15, p: 0.2, verdict: 'too_early' as const, moreMatches: 60, excludedMaps: ['l4d_vs_airport05_runway'], nA: 40, nB: 38,
};

describe('QuickCheck', () => {
  it('shows the numbers, chart, map bars and replay links', async () => {
    mockAdmin.balanceMetric.mockResolvedValue({
      metric: 'round.saferoom', phase: 'all',
      trend: [
        { matchId: 1, endedAt: '2026-09-21 21:00:00', patchId: 1, side: 'a', value: 0.5 },
        { matchId: 2, endedAt: '2026-09-23 01:00:00', patchId: 2, side: 'b', value: 0 },
      ],
      boundaries: [{ patchId: 1, label: 'Sky pounce fix', at: '2026-09-21 20:10:00' }, { patchId: 2, label: 'Saferoom lock', at: '2026-09-22 21:36:00' }],
      perMap: [{ map: 'l4d_vs_hospital01_apartment', a: 0.2, b: 0.3, roundsA: 20, roundsB: 18 }],
      examples: [{ matchId: 2, ordinal: 0, half: 1, map: 'l4d_vs_hospital01_apartment', value: 1 }],
    });
    const { container } = render(<QuickCheck query={query} row={row} />);
    await waitFor(() => expect(screen.getByText(/Excluded maps/)).toBeTruthy());
    expect(screen.getByText(/about 60 more matches/)).toBeTruthy();
    expect(container.querySelector('svg')).toBeTruthy();
    const boundaryLines = container.querySelectorAll('svg line');
    expect(boundaryLines.length).toBe(2);
    boundaryLines.forEach((line) => {
      const x1 = Number(line.getAttribute('x1'));
      expect(x1).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(800);
    });
    expect(screen.getByText(/l4d_vs_hospital01_apartment/, { selector: '.balance-map *, .balance-map' })).toBeTruthy();
    const link = container.querySelector('a[href="/match/2?ordinal=0&half=1"]');
    expect(link).toBeTruthy();
  });
});
