import { describe, it, expect } from 'vitest';
import { deltaLabel, finishLabel, groupByCampaign, isDefaultLook } from './Looks';
import type { LookStatRow } from '../../../api';

const row = (campaign: string, title: string, avgScore: number, rounds = 10): LookStatRow =>
  ({ campaign, title, matches: 1, rounds, avgScore, finishRate: null, avgAlive: null });

describe('survival by look', () => {
  it('reads a look against the campaign\'s Default as a signed percentage, and says nothing for Default itself', () => {
    const base = row('death_toll', 'Default', 400);
    expect(deltaLabel(row('death_toll', 'Storm', 300), base)).toBe('-25%');
    expect(deltaLabel(row('death_toll', 'Midnight', 460), base)).toBe('+15%');
    expect(deltaLabel(row('death_toll', 'Midnight', 400), base)).toBe('0%');
    expect(deltaLabel(base, base)).toBe('');
    expect(deltaLabel(row('death_toll', 'Storm', 300), null)).toBe('');
    expect(deltaLabel(row('death_toll', 'Storm', 300), row('death_toll', 'Default', 0))).toBe('');
  });

  it('knows the plugin\'s two spellings of the stock look', () => {
    expect(isDefaultLook('Default')).toBe(true);
    expect(isDefaultLook('default')).toBe(true);
    expect(isDefaultLook('Midnight')).toBe(false);
  });

  it('groups rows by campaign, Default first then by halves played, campaigns by display name', () => {
    const groups = groupByCampaign([
      row('no_mercy', 'Storm', 1, 4), row('death_toll', 'Storm', 1, 9), row('death_toll', 'Default', 1, 5), row('death_toll', 'Midnight', 1, 9),
    ]);
    expect(groups.map(([slug, rows]) => [slug, rows.map((r) => r.title)])).toEqual([
      ['death_toll', ['Default', 'Midnight', 'Storm']],
      ['no_mercy', ['Storm']],
    ]);
  });

  it('prints a finish rate as a percentage, n/a when none was recorded', () => {
    expect(finishLabel(null)).toBe('n/a');
    expect(finishLabel(0.5)).toBe('50%');
    expect(finishLabel(1)).toBe('100%');
  });
});
