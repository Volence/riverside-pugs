import type { MatchRules } from '../rulesets.js';
import type { StageConfig, StageConfigs, StageType, VetoType } from './validate.js';

/** What the event page and the desk say about a stage and its rules. */

export const STAGE_LABEL: Record<StageType, string> = {
  single_elim: 'Single elimination', double_elim: 'Double elimination', round_robin: 'Round robin', swiss: 'Swiss', league: 'League',
};
export const VETO_LABEL: Record<VetoType, string> = {
  ban_to_one: 'Ban to one (Bo1)', home_away: 'Home and away (Bo2 aggregate)', pick_ban: 'Pick and ban (Bo3)',
};

type AnyConfig = Partial<StageConfigs['single_elim'] & StageConfigs['double_elim'] & StageConfigs['round_robin'] & StageConfigs['swiss'] & StageConfigs['league']>;

export function stageSummary(type: StageType, config: StageConfig, advanceCount: number | null): string {
  const c = config as AnyConfig;
  const parts: string[] = [STAGE_LABEL[type]];
  if (type === 'single_elim' && c.thirdPlace) parts.push('third-place match');
  if (type === 'double_elim') parts.push(c.grandFinalReset ? 'grand final reset' : 'no grand final reset');
  if (type === 'round_robin' && (c.groups ?? 1) > 1) parts.push(`${c.groups} groups`);
  if (type === 'swiss') parts.push(`${c.rounds} rounds`);
  if (type === 'league') parts.push(`${c.weeks} weeks`, `${c.matchesPerWeek} a week`);
  if (advanceCount !== null) parts.push(`top ${advanceCount} advance`);
  return parts.join(', ');
}

export function chaptersLabel(chapters: number | null): string {
  return chapters === null ? 'Every chapter but the finale' : `${chapters} chapter${chapters === 1 ? '' : 's'}`;
}

const SIDE_RULE: Record<MatchRules['sideRule'], string> = {
  higher_seed_chooses: 'Higher seed picks sides',
  non_picker_chooses: 'The team that did not pick the campaign picks sides',
  coin: 'Sides by coin toss',
};
const BOSSES: Record<MatchRules['bosses'], string> = {
  random_published: 'Boss spawns: random, shown in game',
  fixed: 'Boss spawns: fixed',
  voteboss: 'Boss spawns: voted by the teams',
};

/** A ruleset as the lines a player reads. `rated` is left out: a tournament
 *  match is never rated (rulesForKind). */
export function rulesLines(r: MatchRules): string[] {
  const lines: string[] = [];
  lines.push(r.pause.limit === null
    ? 'Pauses: no limit'
    : `Pauses: ${r.pause.limit} per team${r.pause.seconds !== null ? `, up to ${r.pause.seconds} s each` : ''}`);
  if (r.pause.mutualUnpause) lines.push('Unpausing needs both teams');
  if (r.pause.techPauses > 0) lines.push(`Technical pauses: ${r.pause.techPauses} per team`);
  lines.push(`No-show grace: ${r.noShowGraceMinutes} minutes`);
  lines.push(SIDE_RULE[r.sideRule]);
  lines.push(BOSSES[r.bosses]);
  if (r.teamLock) lines.push('Teams are locked once the match is live');
  if (r.restartHalf.allowed) lines.push(r.restartHalf.lockAfterDamage ? 'A half can be restarted until damage is done' : 'A half can be restarted');
  if (r.spectate.sideLocked) lines.push('Team spectators see only their own side');
  return lines;
}

const SIDE_SHORT: Record<MatchRules['sideRule'], string> = {
  higher_seed_chooses: 'higher seed picks sides',
  non_picker_chooses: 'non-picker picks sides',
  coin: 'coin toss for sides',
};

/** A ruleset in one line, for a picker's help text and the Rulesets desk:
 *  the pauses, how sides are chosen and the no-show grace. */
export function rulesSummary(r: MatchRules): string {
  const each = r.pause.seconds === null ? '' : ` of ${r.pause.seconds} s`;
  const pauses = r.pause.limit === null
    ? `Unlimited pauses${each}`
    : r.pause.limit === 0 ? 'No pauses' : `${r.pause.limit} pause${r.pause.limit === 1 ? '' : 's'}${each}`;
  return `${pauses} · ${SIDE_SHORT[r.sideRule]} · ${r.noShowGraceMinutes} min no-show grace`;
}
