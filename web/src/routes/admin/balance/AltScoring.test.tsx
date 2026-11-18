import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AltReport, AltReportHalf } from '../../../api';
import { parseAdminPath } from '../adminRoutes';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { altScoring: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { AltScoring } = await import('./AltScoring');
afterEach(() => {
  cleanup();
  mockAdmin.altScoring.mockReset();
});

const half = (ordinal: number, h: number, survTeam: 'a' | 'b', walk: number, tank: number, door: number): AltReportHalf => ({
  ordinal, half: h, map: 'l4d_vs_hospital01_apartment', survTeam, real: 400 + walk, walk, tank, door,
  total: walk + tank + door, tankPct: tank > 0 ? 62 : null, tankBy: tank > 0 ? 'surv' : null, survivorsIn: 3,
});

const report: AltReport = {
  summary: { matchesWithData: 2, complete: 1, differentWinner: 1, share: { walk: 0.5555, tank: 0.1234, door: 0.3211 } },
  maps: [{ map: 'l4d_vs_hospital01_apartment', halves: 4, avgWalkRaw: 512.6, suggestedWalkMult: 1 }],
  matches: [
    {
      id: 902, endedAt: '2026-11-18 03:10:00', campaign: 'no_mercy', realA: 820, realB: 790, realWinner: 'a',
      altA: 1201, altB: 1350, altWinner: 'b', complete: true, differs: true, counted: true,
      halves: [half(0, 1, 'a', 601, 0, 600), half(0, 2, 'b', 650, 200, 500)],
    },
    {
      id: 901, endedAt: '2026-11-17 22:00:00', campaign: 'death_toll', realA: 300, realB: 0, realWinner: 'a',
      altA: 700, altB: 0, altWinner: 'a', complete: false, differs: null, counted: false,
      halves: [half(0, 1, 'a', 333, 0, 367)],
    },
  ],
};

describe('AltScoring', () => {
  it('shows the summary, the map table and the match list, and opens a match to its halves', async () => {
    mockAdmin.altScoring.mockResolvedValue(report);
    const { container } = render(<AltScoring />);
    await waitFor(() => expect(screen.getByText(/Health-run scoring, computed in the background/)).toBeTruthy());

    const summary = screen.getByTestId('alt-summary').textContent ?? '';
    expect(summary).toMatch(/Matches with data\s*2/);
    expect(summary).toMatch(/Complete matches counted\s*1/);
    expect(summary).toMatch(/Different winner\s*1 of 1/);
    expect(summary).toMatch(/Walking 56%, tank 12%, saferoom 32%/);

    // Per-map walking: integer average, no suggestion below 100 halves.
    const maps = screen.getByTestId('alt-maps').textContent ?? '';
    expect(maps).toMatch(/Apartment/);
    expect(maps).toMatch(/513/);

    const rows = container.querySelectorAll('[data-testid="alt-matches"] tbody > tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/#902/);
    expect(rows[0].textContent).toMatch(/820 - 790/);
    expect(rows[0].textContent).toMatch(/1201 - 1350/);
    expect(rows[0].textContent).toMatch(/different/);
    expect(rows[1].textContent).toMatch(/incomplete/);
    expect(screen.getByText(/the match ended early/)).toBeTruthy();

    // No halves until a row is opened.
    expect(screen.queryByTestId('alt-halves-902')).toBeNull();
    fireEvent.click(rows[0]);
    const halves = screen.getByTestId('alt-halves-902');
    const halfRows = halves.querySelectorAll('tbody > tr');
    expect(halfRows).toHaveLength(2);
    expect(halfRows[0].textContent).toMatch(/Team A/);
    expect(halfRows[1].textContent).toMatch(/Team B/);
    expect(halfRows[1].textContent).toMatch(/650.*200.*500.*1350/);
    expect(halfRows[1].textContent).toMatch(/62%/);
    expect(halves.textContent).toMatch(/Saferoom/);

    // Enter toggles it closed again.
    fireEvent.keyDown(rows[0], { key: 'Enter' });
    expect(screen.queryByTestId('alt-halves-902')).toBeNull();
  });

  it('says when no match has reported alt scores yet', async () => {
    mockAdmin.altScoring.mockResolvedValue({
      summary: { matchesWithData: 0, complete: 0, differentWinner: 0, share: { walk: 0, tank: 0, door: 0 } },
      maps: [], matches: [],
    });
    render(<AltScoring />);
    await waitFor(() => expect(screen.getByText(/No match has reported alt scores yet/)).toBeTruthy());
    expect(screen.getByText(/new scoring plugin/)).toBeTruthy();
    expect(screen.queryByTestId('alt-summary')).toBeNull();
  });

  it('shows loading, then the error state', async () => {
    let fail: (e: Error) => void = () => {};
    mockAdmin.altScoring.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    render(<AltScoring />);
    expect(screen.getByText('Loading...')).toBeTruthy();
    fail(new Error('boom'));
    await waitFor(() => expect(screen.getByText('Could not load the alt scoring report.')).toBeTruthy());
  });

  it('is the alt tab on the Balance desk', () => {
    expect(parseAdminPath('/admin/balance/alt', { isAdmin: true })).toEqual({ desk: 'balance', section: 'alt', param: null });
  });
});
