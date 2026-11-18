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
  mismatch: false,
});

const report: AltReport = {
  summary: { matchesWithData: 2, complete: 1, differentWinner: 1, share: { walk: 0.5555, tank: 0.1234, door: 0.3211 }, mismatchedHalves: 0 },
  maps: [
    { map: 'l4d_vs_airport05_runway', halves: 120, avgWalkRaw: 600, suggestedWalkMult: 0.85 },
    { map: 'l4d_vs_hospital01_apartment', halves: 4, avgWalkRaw: 512.6, suggestedWalkMult: null },
  ],
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
    const mapRows = screen.getByTestId('alt-maps').querySelectorAll('tbody > tr');
    expect(mapRows[0].textContent).toMatch(/Runway/);
    expect(mapRows[0].querySelectorAll('td')[3].textContent).toBe('0.85');
    expect(mapRows[1].textContent).toMatch(/Apartment/);
    expect(mapRows[1].querySelectorAll('td')[2].textContent).toBe('513');
    expect(mapRows[1].querySelectorAll('td')[3].textContent).toBe('-');
    expect(screen.getByText(/The alt score is what a match would have scored under the new health-run scoring/)).toBeTruthy();
    expect(screen.getByText(/most recent 100 matches/).textContent).toMatch(/"0 of 0" is expected at first/);

    const rows = container.querySelectorAll('[data-testid="alt-matches"] tbody > tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/#902/);
    expect(rows[0].textContent).toMatch(/820 - 790/);
    expect(rows[0].textContent).toMatch(/1201 - 1350/);
    expect(rows[0].textContent).toMatch(/different/);
    expect(rows[1].textContent).toMatch(/incomplete/);
    expect(screen.getByText(/Incomplete: some halves of the match have a real score but no alt score/).textContent).toMatch(/Not counted: not a ranked PUG, voided, or not finished yet/);

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
    // No tank fight ended in the first half: a dash, not a claim there was no tank.
    expect(halfRows[0].querySelectorAll('td')[8].textContent).toBe('-');
    expect(halves.textContent).toMatch(/Team health % when the tank fight ended/);
    expect(halves.textContent).toMatch(/Survivors in saferoom/);
    expect(halves.textContent).toMatch(/Saferoom/);

    // No mismatch: no warning line and no mark on any half.
    expect(screen.queryByTestId('alt-mismatch')).toBeNull();
    expect(halves.textContent).not.toMatch(/mismatch/);

    // Enter toggles it closed again.
    fireEvent.keyDown(rows[0], { key: 'Enter' });
    expect(screen.queryByTestId('alt-halves-902')).toBeNull();
  });

  it('draws one health curve chart per map in the match detail, and says when a map has none', async () => {
    const make = [100, 100, 100, 100, 88, 88, 88, 88, 23, 23, 23, 22, 23, 20, 20, 20, 20, 19, 19, 19, 19];
    const wipe = [100, 100, 100, 100, 86, 84, 84, 67, 67, ...Array(12).fill(-1)];
    const map2 = 'l4d_vs_hospital02_subway';
    mockAdmin.altScoring.mockResolvedValue({
      ...report,
      matches: [{
        ...report.matches[0],
        halves: [
          { ...half(0, 1, 'a', 321, 68, 97), curve: make, tankOpen: 37, tankClose: 54 },
          { ...half(0, 2, 'b', 248, 0, 0), curve: wipe, tankOpen: -1, tankClose: -1 },
          // A wipe with the tank still up, then a half from an older plugin (no curve fields at all).
          { ...half(1, 1, 'a', 175, 0, 0), map: map2, curve: [90, 90, 90, 100, 100, 100, ...Array(15).fill(-1)], tankOpen: 27, tankClose: -1 },
          { ...half(1, 2, 'b', 420, 266, 0), map: map2 },
          // A third map recorded entirely without curves.
          { ...half(2, 1, 'a', 300, 0, 300), map: 'l4d_vs_hospital03_sewers', curve: null, tankOpen: null, tankClose: null },
        ],
      }],
    });
    const { container } = render(<AltScoring />);
    await waitFor(() => expect(screen.getByTestId('alt-matches')).toBeTruthy());
    expect(screen.queryByTestId('alt-curve')).toBeNull();
    fireEvent.click(container.querySelectorAll('[data-testid="alt-matches"] tbody > tr')[0]);

    const charts = screen.getAllByTestId('alt-curve');
    expect(charts).toHaveLength(2);
    const [first, second] = charts;
    expect(first.textContent).toMatch(/The Apartments: team health as the map goes on/);
    expect(first.textContent).toMatch(/Team A \(half 1\).*Team B \(half 2\)/);
    expect(first.querySelector('svg')?.getAttribute('aria-label')).toMatch(/team health % against % of the map covered/);

    // Team A's make: one unbroken line over all 21 points, in team A's colour.
    const lineA = first.querySelector('[data-testid="alt-curve-line-a-1"]')!;
    expect(lineA.querySelectorAll('polyline')).toHaveLength(1);
    expect(lineA.querySelector('polyline')!.getAttribute('class')).toBe('altcurve__line altcurve__line--a');
    expect(lineA.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(21);
    const dotsA = lineA.querySelectorAll('circle');
    expect(dotsA).toHaveLength(21);
    expect(dotsA[8].querySelector('title')!.textContent).toBe('Team A (half 1): 40% of the map covered, team health 23%');
    expect(dotsA[20].querySelector('title')!.textContent).toBe('Team A (half 1): 100% of the map covered, team health 19%');

    // Team B's wipe stops at 40%: nine points, nothing drawn past them.
    const lineB = first.querySelector('[data-testid="alt-curve-line-b-2"]')!;
    expect(lineB.querySelector('polyline')!.getAttribute('class')).toBe('altcurve__line altcurve__line--b');
    expect(lineB.querySelectorAll('circle')).toHaveLength(9);
    expect(lineB.querySelectorAll('circle')[8].querySelector('title')!.textContent).toBe('Team B (half 2): 40% of the map covered, team health 67%');

    // Tank fight band for A (37% to 54%); none for B, which had no tank.
    const bandA = first.querySelector('[data-testid="alt-curve-tank-a-1"]')!;
    expect(bandA.tagName.toLowerCase()).toBe('rect');
    expect(bandA.querySelector('title')!.textContent).toBe('Team A (half 1): tank fight from 37% to 54% of the map');
    expect(first.querySelector('[data-testid="alt-curve-tank-b-2"]')).toBeNull();

    // Map 2: the half from an older plugin is named in the legend as having no curve; the tank still up at the end is a marker.
    expect(second.textContent).toMatch(/Subway/);
    expect(second.textContent).toMatch(/Team B \(half 2\) \(no curve recorded\)/);
    expect(second.querySelector('[data-testid="alt-curve-line-b-2"]')).toBeNull();
    const endA = second.querySelector('[data-testid="alt-curve-tank-a-1"]')!;
    expect(endA.tagName.toLowerCase()).toBe('line');
    expect(endA.querySelector('title')!.textContent).toBe('Team A (half 1): tank came at 27% of the map and was still up when the half ended');

    // Map 3 has no curve at all.
    expect(screen.getByTestId('alt-curve-none').textContent).toBe('No curve recorded for The Sewer.');
  });

  it('warns about halves whose stored score does not match their breakdown, and marks them', async () => {
    const bad = { ...half(0, 2, 'b', 650, 200, 500), mismatch: true };
    mockAdmin.altScoring.mockResolvedValue({
      ...report,
      summary: { ...report.summary, mismatchedHalves: 3 },
      matches: [{ ...report.matches[0], halves: [half(0, 1, 'a', 601, 0, 600), bad] }],
    });
    const { container } = render(<AltScoring />);
    await waitFor(() => expect(screen.getByTestId('alt-mismatch')).toBeTruthy());
    expect(screen.getByTestId('alt-mismatch').textContent).toBe(
      "3 halves have a stored score that does not match their own breakdown. That points at a bug in the game server's scoring, not in the match.",
    );
    fireEvent.click(container.querySelectorAll('[data-testid="alt-matches"] tbody > tr')[0]);
    const halfRows = screen.getByTestId('alt-halves-902').querySelectorAll('tbody > tr');
    expect(halfRows[0].textContent).not.toMatch(/mismatch/);
    expect(halfRows[1].textContent).toMatch(/mismatch/);
  });

  it('words the mismatch line for a single half', async () => {
    mockAdmin.altScoring.mockResolvedValue({ ...report, summary: { ...report.summary, mismatchedHalves: 1 } });
    render(<AltScoring />);
    await waitFor(() => expect(screen.getByTestId('alt-mismatch')).toBeTruthy());
    expect(screen.getByTestId('alt-mismatch').textContent).toBe(
      "1 half has a stored score that does not match its own breakdown. That points at a bug in the game server's scoring, not in the match.",
    );
  });

  it('says when no match has reported alt scores yet', async () => {
    mockAdmin.altScoring.mockResolvedValue({
      summary: { matchesWithData: 0, complete: 0, differentWinner: 0, share: { walk: 0, tank: 0, door: 0 }, mismatchedHalves: 0 },
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
