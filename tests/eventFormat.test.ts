import { describe, it, expect } from 'vitest';
import { chaptersLabel, rulesLines, rulesSummary, stageSummary } from '../src/events/format.js';
import { TEMPLATES } from '../src/rulesets.js';

describe('stage summary', () => {
  it('reads each type with its settings and the advance count', () => {
    expect(stageSummary('swiss', { rounds: 4 }, 8)).toBe('Swiss, 4 rounds, top 8 advance');
    expect(stageSummary('single_elim', { thirdPlace: true }, null)).toBe('Single elimination, third-place match');
    expect(stageSummary('single_elim', { thirdPlace: false }, null)).toBe('Single elimination');
    expect(stageSummary('double_elim', { grandFinalReset: false }, null)).toBe('Double elimination, no grand final reset');
    expect(stageSummary('round_robin', { groups: 1 }, 4)).toBe('Round robin, top 4 advance');
    expect(stageSummary('round_robin', { groups: 2 }, 4)).toBe('Round robin, 2 groups, top 4 advance');
    expect(stageSummary('league', { weeks: 6, matchesPerWeek: 2, pairing: 'swiss' }, 4)).toBe('League, 6 weeks, 2 a week, top 4 advance');
  });

  it('labels chapters', () => {
    expect(chaptersLabel(null)).toBe('Every chapter but the finale');
    expect(chaptersLabel(1)).toBe('1 chapter');
    expect(chaptersLabel(3)).toBe('3 chapters');
  });
});

describe('rules lines', () => {
  it('reads the Standard Cup template', () => {
    expect(rulesLines(TEMPLATES['Standard Cup'])).toEqual([
      'Pauses: 3 per team, up to 120 s each',
      'Unpausing needs both teams',
      'Technical pauses: 2 per team',
      'No-show grace: 15 minutes',
      'Higher seed picks sides',
      'Boss spawns: random, shown in game',
      'Teams are locked once the match is live',
      'Team spectators see only their own side',
    ]);
  });

  it('reads the Casual Scrim template', () => {
    expect(rulesLines(TEMPLATES['Casual Scrim'])).toEqual([
      'Pauses: no limit',
      'Unpausing needs both teams',
      'No-show grace: 15 minutes',
      'The team that did not pick the campaign picks sides',
      'Boss spawns: random, shown in game',
      'Teams are locked once the match is live',
      'A half can be restarted',
    ]);
  });
});

describe('rules summary', () => {
  it('says the pauses, the side rule and the no-show grace in one line', () => {
    expect(rulesSummary(TEMPLATES.PUG)).toBe('3 pauses of 120 s · coin toss for sides · 10 min no-show grace');
    expect(rulesSummary(TEMPLATES['Standard Cup'])).toBe('3 pauses of 120 s · higher seed picks sides · 15 min no-show grace');
    expect(rulesSummary(TEMPLATES['Casual Scrim'])).toBe('Unlimited pauses · non-picker picks sides · 15 min no-show grace');
  });

  it('reads one pause, no pauses, and unlimited pauses with a length', () => {
    const one = { ...TEMPLATES.PUG, pause: { ...TEMPLATES.PUG.pause, limit: 1, seconds: null } };
    expect(rulesSummary(one)).toBe('1 pause · coin toss for sides · 10 min no-show grace');
    const none = { ...TEMPLATES.PUG, pause: { ...TEMPLATES.PUG.pause, limit: 0 } };
    expect(rulesSummary(none)).toBe('No pauses · coin toss for sides · 10 min no-show grace');
    const long = { ...TEMPLATES.PUG, pause: { ...TEMPLATES.PUG.pause, limit: null, seconds: 60 } };
    expect(rulesSummary(long)).toBe('Unlimited pauses of 60 s · coin toss for sides · 10 min no-show grace');
  });
});
