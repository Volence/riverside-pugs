import { describe, it, expect } from 'vitest';
import type { AdminEventOptions, StageSettings } from '../../../api';
import { configOf, draftFrom, settingsFrom } from './stageDraft';

const OPTIONS: AdminEventOptions = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }, { slug: 'dead_air', name: 'Dead Air' }],
  defaultPool: ['no_mercy', 'dead_air'], rulesets: [{ id: 1, name: 'PUG' }, { id: 2, name: 'Standard Cup' }], defaultRulesetId: 2,
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
      vetoType: 'ban_to_one', chapters: null, scheduling: 'rolling', advanceCount: null,
    });
  });

  it('round-trips a saved stage, and sends only the chosen type settings', () => {
    const league: StageSettings = {
      type: 'league', config: { weeks: 8, matchesPerWeek: 2, pairing: 'round_robin' }, rulesetId: 1, gameConfig: 'standard',
      campaignPool: ['dead_air'], vetoType: 'home_away', chapters: 3, scheduling: 'window', advanceCount: 4,
    };
    expect(settingsFrom(draftFrom(league, OPTIONS))).toEqual(league);
    const d = { ...draftFrom(league, OPTIONS), type: 'swiss' as const, scheduling: 'rolling' as const };
    expect(configOf(d)).toEqual({ rounds: 4 });
  });

  it('a league is always sent as window scheduled', () => {
    const d = { ...draftFrom(null, OPTIONS), type: 'league' as const, scheduling: 'rolling' as const };
    expect(settingsFrom(d).scheduling).toBe('window');
  });
});
