import { describe, it, expect } from 'vitest';
import type { AdminEventOptions, StageSettings, VetoConfig } from '../../../api';
import { configOf, draftFrom, settingsFrom, staleValues } from './stageDraft';

const BAN_TO_ONE: VetoConfig = { games: 1, banTo: 1, firstBan: 'higher_chooses', firstPick: 'first', laterPicks: 'alternate', lateBans: 0, sides: 'non_picker' };

const OPTIONS: AdminEventOptions = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }, { slug: 'dead_air', name: 'Dead Air' }],
  defaultPool: ['no_mercy', 'dead_air'], rulesets: [
    { id: 1, name: 'PUG', summary: '3 pauses of 120 s · coin toss for sides · 10 min no-show grace' },
    { id: 2, name: 'Standard Cup', summary: '3 pauses of 120 s · higher seed picks sides · 15 min no-show grace' },
  ], defaultRulesetId: 2,
  gameConfigs: [{ key: 'standard', label: 'Standard' }],
  defaults: {
    eligibility: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null },
    checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
    roster: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null },
  },
};

describe('stage drafts', () => {
  it('a new stage starts as single elimination on the default ruleset and the site pool', () => {
    expect(settingsFrom(draftFrom(null, OPTIONS))).toEqual({
      type: 'single_elim', config: { thirdPlace: false }, rulesetId: 2, gameConfig: 'standard', campaignPool: ['no_mercy', 'dead_air'],
      vetoType: 'ban_to_one', veto: BAN_TO_ONE, chapters: null, scheduling: 'rolling', advanceCount: null,
    });
  });

  it('round-trips a saved stage, and sends only the chosen type settings', () => {
    const league: StageSettings = {
      type: 'league', config: { matches: 16, matchesPerWeek: 2, pairing: 'round_robin', seasonStart: '2026-10-12' }, rulesetId: 1, gameConfig: 'standard',
      campaignPool: ['dead_air'], vetoType: 'home_away', veto: { ...BAN_TO_ONE, games: 2, banTo: 1 }, chapters: 3, scheduling: 'window', advanceCount: 4,
    };
    expect(settingsFrom(draftFrom(league, OPTIONS))).toEqual(league);
    const d = { ...draftFrom(league, OPTIONS), type: 'swiss' as const, scheduling: 'rolling' as const };
    expect(configOf(d)).toEqual({ rounds: 4 });
  });

  it('a league is always sent as window scheduled', () => {
    const d = { ...draftFrom(null, OPTIONS), type: 'league' as const, scheduling: 'rolling' as const };
    expect(settingsFrom(d).scheduling).toBe('window');
  });

  it('names the saved values that are no longer offered, so the form can show them to be cleared', () => {
    const old: StageSettings = {
      type: 'swiss', config: { rounds: 4 }, rulesetId: 9, gameConfig: 'retired', campaignPool: ['no_mercy', 'hard_rain'],
      vetoType: 'ban_to_one', veto: BAN_TO_ONE, chapters: null, scheduling: 'rolling', advanceCount: 8,
    };
    expect(staleValues(old, OPTIONS)).toEqual({ rulesetId: 9, gameConfig: 'retired', campaigns: ['hard_rain'] });
    expect(staleValues({ ...old, rulesetId: 2, gameConfig: 'standard', campaignPool: ['dead_air'] }, OPTIONS))
      .toEqual({ rulesetId: null, gameConfig: null, campaigns: [] });
    expect(staleValues(null, OPTIONS)).toEqual({ rulesetId: null, gameConfig: null, campaigns: [] });
  });
});
