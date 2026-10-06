import type { AdminEventOptions, Scheduling, StageConfig, StageConfigs, StageSettings, StageType, VetoType } from '../../../api';

/**
 * The stage form's own state: every type's settings at once, so switching the
 * type back and forth keeps what was typed. settingsFrom sends only the
 * chosen type's settings; the server (src/events/validate.ts) is the judge of
 * every range.
 */
export interface StageDraft {
  type: StageType;
  thirdPlace: boolean; grandFinalReset: boolean; groups: number; rounds: number;
  matches: number; seasonStart: string | null; matchesPerWeek: number; pairing: 'swiss' | 'round_robin';
  rulesetId: number; gameConfig: string; campaignPool: string[]; vetoType: VetoType;
  chapters: number | null; scheduling: Scheduling; advanceCount: number | null;
}

type AnyConfig = Partial<StageConfigs['single_elim'] & StageConfigs['double_elim'] & StageConfigs['round_robin'] & StageConfigs['swiss'] & StageConfigs['league']>;

export function draftFrom(s: StageSettings | null, o: AdminEventOptions): StageDraft {
  const c = (s?.config ?? {}) as AnyConfig;
  return {
    type: s?.type ?? 'single_elim',
    thirdPlace: c.thirdPlace ?? false, grandFinalReset: c.grandFinalReset ?? true, groups: c.groups ?? 1, rounds: c.rounds ?? 4,
    matches: c.matches ?? 16, seasonStart: c.seasonStart ?? null, matchesPerWeek: c.matchesPerWeek ?? 1, pairing: c.pairing ?? 'swiss',
    rulesetId: s?.rulesetId ?? o.defaultRulesetId ?? o.rulesets[0]?.id ?? 0,
    gameConfig: s?.gameConfig ?? 'standard',
    campaignPool: s ? [...s.campaignPool] : [...o.defaultPool],
    vetoType: s?.vetoType ?? 'ban_to_one',
    chapters: s?.chapters ?? null,
    scheduling: s?.scheduling ?? 'rolling',
    advanceCount: s?.advanceCount ?? null,
  };
}

export function configOf(d: StageDraft): StageConfig {
  switch (d.type) {
    case 'single_elim': return { thirdPlace: d.thirdPlace };
    case 'double_elim': return { grandFinalReset: d.grandFinalReset };
    case 'round_robin': return { groups: d.groups };
    case 'swiss': return { rounds: d.rounds };
    case 'league': return { matches: d.matches, matchesPerWeek: d.matchesPerWeek, pairing: d.pairing, seasonStart: d.seasonStart };
  }
}

export function settingsFrom(d: StageDraft): StageSettings {
  return {
    type: d.type, config: configOf(d), rulesetId: d.rulesetId, gameConfig: d.gameConfig, campaignPool: d.campaignPool,
    vetoType: d.vetoType, chapters: d.chapters, scheduling: d.type === 'league' ? 'window' : d.scheduling, advanceCount: d.advanceCount,
  };
}

/** Saved values the options no longer offer: an archived ruleset, a game
 *  config turned off, a campaign no longer poolable. StageForm shows each as
 *  "(no longer available)" so the admin sees it and can change or untick it,
 *  instead of a select quietly showing its first option while the old value
 *  is what gets sent. */
export interface StaleValues { rulesetId: number | null; gameConfig: string | null; campaigns: string[] }

export function staleValues(s: StageSettings | null, o: AdminEventOptions): StaleValues {
  if (!s) return { rulesetId: null, gameConfig: null, campaigns: [] };
  const offered = new Set(o.campaigns.map((c) => c.slug));
  return {
    rulesetId: o.rulesets.some((r) => r.id === s.rulesetId) ? null : s.rulesetId,
    gameConfig: o.gameConfigs.some((g) => g.key === s.gameConfig) ? null : s.gameConfig,
    campaigns: s.campaignPool.filter((c) => !offered.has(c)),
  };
}
