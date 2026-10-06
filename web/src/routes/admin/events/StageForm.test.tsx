import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { AdminEventOptions, StageSettings } from '../../../api';
import { StageForm } from './StageForm';

const CUP = '3 pauses of 120 s · higher seed picks sides · 15 min no-show grace';
const SCRIM = 'Unlimited pauses · non-picker picks sides · 15 min no-show grace';
const OPTIONS: AdminEventOptions = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }], defaultPool: ['no_mercy'],
  rulesets: [{ id: 2, name: 'Standard Cup', summary: CUP }, { id: 3, name: 'Casual Scrim', summary: SCRIM }], defaultRulesetId: 2,
  gameConfigs: [{ key: 'standard', label: 'Standard' }],
  defaults: {
    eligibility: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null },
    checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
    roster: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null },
  },
};
const show = (initial: StageSettings | null = null) =>
  render(<StageForm options={OPTIONS} initial={initial} busy={false} onSave={() => {}} onCancel={() => {}} />);

afterEach(() => cleanup());

describe('StageForm pickers', () => {
  it('says what a ruleset and a game config are, and reads the chosen ruleset in one line', () => {
    show();
    expect(screen.getByText(/Match rules: pauses, side choice, no-show grace\./)).toBeTruthy();
    expect(screen.getByText('What the server runs (the cfg it loads).')).toBeTruthy();
    expect(screen.getByText(CUP)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Ruleset'), { target: { value: '3' } });
    expect(screen.getByText(SCRIM)).toBeTruthy();
    expect(screen.queryByText(CUP)).toBeNull();
  });

  it('a saved ruleset no longer offered has no summary line', () => {
    show({
      type: 'single_elim', config: { thirdPlace: false }, rulesetId: 9, gameConfig: 'standard', campaignPool: ['no_mercy'],
      vetoType: 'ban_to_one',
      veto: { games: 1, banTo: 1, firstBan: 'higher_chooses', firstPick: 'first', laterPicks: 'alternate', lateBans: 0, sides: 'non_picker' },
      chapters: null, scheduling: 'rolling', advanceCount: null,
    });
    expect(screen.queryByText(CUP)).toBeNull();
    expect(screen.queryByText(SCRIM)).toBeNull();
  });
});

describe('StageForm league', () => {
  it('saves matches, matches a week, pairing and the season start', () => {
    const onSave = vi.fn();
    render(<StageForm options={OPTIONS} initial={null} busy={false} onSave={onSave} onCancel={() => {}} teamCap={8} />);
    fireEvent.change(screen.getByLabelText('Stage type'), { target: { value: 'league' } });
    fireEvent.input(screen.getByLabelText('Matches per team'), { target: { value: '14' } });
    fireEvent.input(screen.getByLabelText('Matches a week'), { target: { value: '2' } });
    fireEvent.input(screen.getByLabelText('Season start'), { target: { value: '2026-10-12' } });
    expect(screen.getByText('14 matches at 2 a week: 7 weeks, Oct 12 to Nov 29.')).toBeTruthy();
    fireEvent.submit(screen.getByLabelText('Matches per team').closest('form')!);
    expect(onSave.mock.calls[0]![0].config).toEqual({ matches: 14, matchesPerWeek: 2, pairing: 'swiss', seasonStart: '2026-10-12' });
  });
});
