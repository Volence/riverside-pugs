import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { PublicEntry, PublicPatch } from '../../api';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { balancePatches: vi.fn(), balancePatch: vi.fn() },
}));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});

const { BalanceNotes } = await import('../BalanceNotes');
const { PatchEntryView } = await import('./PatchEntryView');

afterEach(cleanup);

const comparedEntry: PublicEntry = {
  id: 3, number: 3, name: 'Autumn balance patch', notes: 'Tank health reduced for pacing.',
  source: 'detected', approximate: false,
  firstRound: '2026-08-01T00:00:00', lastRound: '2026-08-31T00:00:00',
  matches: 120, rounds: 400, publishedAt: '2026-09-01T00:00:00',
  previous: { id: 2, name: 'Launch patch' }, status: 'compared',
  changes: {
    knobs: [{ label: 'Tank base health', from: '8000', to: '7500' }],
    pluginsAdded: [], pluginsRemoved: [], pluginsUpdated: [], files: [],
  },
  changesUnavailable: null, live: true,
  effect: {
    a: { matches: 60, rounds: 200 }, b: { matches: 60, rounds: 200 },
    skill: 'differs', approximate: false,
    rows: [
      { metric: 'tank.killed_rate', group: 'tank', label: 'Tanks killed by survivors',
        a: 0.62, b: 0.71, diff: 0.09, rel: 0.145, lo: 0.03, hi: 0.15,
        verdict: 'real', moreMatches: null, nA: 40, nB: 40, noSharedMaps: false },
      { metric: 'witch.crown_rate', group: 'witch', label: 'Witches crowned',
        a: 0.5, b: 0.55, diff: 0.05, rel: 0.1, lo: null, hi: null,
        verdict: 'too_early', moreMatches: 12, nA: 40, nB: 12, noSharedMaps: false },
      { metric: 'round.saferoom', group: 'outcomes', label: 'Rounds where survivors reached the saferoom',
        a: 0.8, b: 0.81, diff: 0.01, rel: 0.0125, lo: -0.02, hi: 0.04,
        verdict: 'noise', moreMatches: null, nA: 40, nB: 40, noSharedMaps: false },
      { metric: 'weapons.hold.smg', group: 'weapons', label: 'Time holding the Uzi',
        a: null, b: null, diff: null, rel: null, lo: null, hi: null,
        verdict: 'no_data', moreMatches: null, nA: 40, nB: 0, noSharedMaps: false },
      { metric: 'hunter.skeet_rate', group: 'hunter', label: 'Hunters skeeted',
        a: null, b: null, diff: null, rel: null, lo: null, hi: null,
        verdict: 'no_data', moreMatches: null, nA: 0, nB: 0, noSharedMaps: false },
      { metric: 'smoker.pull_rate', group: 'smoker', label: 'Smoker pulls per spawn',
        a: null, b: null, diff: null, rel: null, lo: null, hi: null,
        verdict: 'no_data', moreMatches: null, nA: 0, nB: 0, noSharedMaps: false },
    ],
  },
};

const historicalEntry: PublicEntry = {
  id: 2, number: 2, name: 'Launch patch', notes: 'Original release.',
  source: 'historical', approximate: true,
  firstRound: '2026-01-01T00:00:00', lastRound: '2026-01-01T00:00:00',
  matches: 30, rounds: 100, publishedAt: '2026-01-02T00:00:00',
  previous: null, status: 'first', changes: null, changesUnavailable: 'first', live: false, effect: null,
};

const noRoundsEntry: PublicEntry = {
  id: 1, number: 1, name: 'Winter tweak', notes: 'Scheduled patch, no rounds yet.',
  source: 'announced', approximate: false,
  firstRound: null, lastRound: null,
  matches: 0, rounds: 0, publishedAt: '2026-09-20T00:00:00',
  previous: { id: 2, name: 'Launch patch' }, status: 'no_rounds',
  changes: { knobs: [], pluginsAdded: [], pluginsRemoved: [], pluginsUpdated: [], files: [] },
  changesUnavailable: null, live: true,
  effect: null,
};

const summaryOf = (e: PublicEntry): PublicPatch => ({
  id: e.id, number: e.number, name: e.name, notes: e.notes, source: e.source,
  approximate: e.approximate, firstRound: e.firstRound, lastRound: e.lastRound,
  matches: e.matches, rounds: e.rounds, publishedAt: e.publishedAt,
});

describe('BalanceNotes', () => {
  it('lists patches newest first and renders each patch panel', async () => {
    mockApi.balancePatches.mockResolvedValue({
      patches: [summaryOf(comparedEntry), summaryOf(historicalEntry), summaryOf(noRoundsEntry)],
    });
    mockApi.balancePatch.mockImplementation((id: number) => Promise.resolve(
      [comparedEntry, historicalEntry, noRoundsEntry].find((e) => e.id === id),
    ));

    const { container } = render(<BalanceNotes />);

    await waitFor(() => expect(screen.getByText('Autumn balance patch')).toBeTruthy());
    expect(screen.getByText('Launch patch')).toBeTruthy();
    expect(screen.getByText('Winter tweak')).toBeTruthy();
    const names = [...container.querySelectorAll('h3')].map((h) => h.textContent);
    expect(names).toEqual(['Autumn balance patch', 'Launch patch', 'Winter tweak']);

    // The compared entry.
    expect(screen.getByText(/Measured change: Tanks killed by survivors went from 62% to 71%/)).toBeTruthy();
    expect(screen.getByText('No clear change: within normal variation.')).toBeTruthy();
    expect(screen.getByText(/about 12 more matches needed/)).toBeTruthy();
    expect(screen.getByText('120 matches, 400 rounds', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Compared with Launch patch: 60 matches before, 60 matches after\./)).toBeTruthy();
    expect(screen.getByText('Not measured for this patch.')).toBeTruthy();
    expect(screen.getByText(/players, not the patch/)).toBeTruthy();
    expect(screen.getByText('Tank base health: from 8000 to 7500')).toBeTruthy();

    // Rows measured on neither side leave the tables for one muted line, and a
    // topic left with no rows gets no table; a row with one side stays.
    const tableText = [...container.querySelectorAll('table.patch-table')].map((t) => t.textContent).join('|');
    expect(tableText).not.toMatch(/Hunters skeeted|Smoker pulls per spawn/);
    expect(tableText).toMatch(/Time holding the Uzi/);
    expect(screen.getByText('Not measured for either patch: Hunters skeeted, Smoker pulls per spawn.')).toBeTruthy();
    const topics = [...container.querySelectorAll('h5')].map((h) => h.textContent);
    expect(topics).not.toContain('Hunter');
    expect(topics).not.toContain('Smoker');

    // The historical entry: a separate chip after a gap.
    const chip = container.querySelector('.patch-meta .chip')!;
    expect(chip.textContent).toBe('approximate');
    expect(chip.parentElement!.textContent).toMatch(/100 rounds approximate$/);
    // "What changed" and "Measured effect" each say it their own way.
    expect(screen.getByText('First tracked patch, so there is no earlier patch to list changes against.')).toBeTruthy();
    expect(screen.getByText('First tracked patch: nothing earlier to compare with.')).toBeTruthy();

    // The no-rounds entry.
    expect(screen.getByText('No rounds yet.')).toBeTruthy();

    expect(container.textContent).not.toMatch(/caus/i);
  });

  it('says so when there are no patches', async () => {
    mockApi.balancePatches.mockResolvedValue({ patches: [] });
    render(<BalanceNotes />);
    await waitFor(() => expect(screen.getByText('No patch notes yet.')).toBeTruthy());
  });

  it('says a patch could not load on error', async () => {
    mockApi.balancePatches.mockResolvedValue({ patches: [summaryOf(comparedEntry)] });
    mockApi.balancePatch.mockRejectedValue(new Error('boom'));
    render(<BalanceNotes />);
    await waitFor(() => expect(screen.getByText('Could not load this patch.')).toBeTruthy());
  });
});

describe('PatchEntryView', () => {
  it('says the previous patch predates recorded settings when changesUnavailable is previous_unrecorded', () => {
    const entry: PublicEntry = {
      id: 9, number: 9, name: 'Old patch', notes: 'x',
      source: 'detected', approximate: false,
      firstRound: null, lastRound: null, matches: 0, rounds: 0, publishedAt: '2026-01-01T00:00:00',
      previous: { id: 8, name: 'Even older' }, status: 'no_rounds',
      changes: null, changesUnavailable: 'previous_unrecorded', live: false, effect: null,
    };
    render(<PatchEntryView entry={entry} />);
    expect(screen.getByText(/previous patch predates recorded settings/)).toBeTruthy();
  });

  it('says no settings were recorded for an unrecorded patch', () => {
    render(<PatchEntryView entry={{ ...comparedEntry, changes: null, changesUnavailable: 'unrecorded' }} />);
    expect(screen.getByText('No list of settings was recorded for this patch. See the notes above.')).toBeTruthy();
  });

  it('a compared entry no longer live says too few matches were measured, not a countdown', () => {
    render(<PatchEntryView entry={{ ...comparedEntry, live: false }} />);
    expect(screen.getByText('Too early to tell: too few matches were measured on these patches to tell.')).toBeTruthy();
    expect(screen.queryByText(/more matches needed/)).toBeNull();
  });

  it('says 1 match, not 1 matches', () => {
    const effect = { ...comparedEntry.effect!, a: { matches: 1, rounds: 2 }, b: { matches: 53, rounds: 106 } };
    const { container } = render(<PatchEntryView entry={{ ...comparedEntry, matches: 1, rounds: 8, effect }} />);
    expect(container.querySelector('.patch-meta')!.textContent).toMatch(/1 match, 8 rounds/);
    expect(screen.getByText('Compared with Launch patch: 1 match before, 53 matches after.')).toBeTruthy();
    render(<PatchEntryView entry={{ ...noRoundsEntry, matches: 1, rounds: 1 }} />);
    expect(screen.getByText(/1 match, 1 round$/)).toBeTruthy();
  });

  it('stacks rows on phones: every cell carries its column label', () => {
    const { container } = render(<PatchEntryView entry={comparedEntry} />);
    const cells = [...container.querySelectorAll('table.patch-table tbody td')];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((td) => td.getAttribute('data-label'))).toBe(true);
  });
});
