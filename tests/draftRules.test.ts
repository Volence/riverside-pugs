import { describe, it, expect } from 'vitest';
import { cutProblems, defaultRoles, maxTeams, nextOfferee } from '../src/events/draftRules.js';

const ids = Array.from({ length: 21 }, (_, i) => `s${i}`);

describe('maxTeams', () => {
  it('is one team per four signups, rounded down', () => {
    expect(maxTeams(0)).toBe(0);
    expect(maxTeams(7)).toBe(1);
    expect(maxTeams(8)).toBe(2);
    expect(maxTeams(21)).toBe(5);
  });
});

describe('defaultRoles', () => {
  it('keeps the captains, puts the first teams x 3 non-captains in the pool by signup order, the rest on the bench', () => {
    const roles = defaultRoles(ids.map((steamid) => ({ steamid })), new Set(['s3', 's10']), 5);
    expect([...roles.keys()]).toEqual(ids);
    expect(roles.get('s3')).toBe('captain');
    expect(roles.get('s10')).toBe('captain');
    const nonCaptains = ids.filter((s) => s !== 's3' && s !== 's10');
    expect(ids.filter((s) => roles.get(s) === 'pool')).toEqual(nonCaptains.slice(0, 15));
    expect(ids.filter((s) => roles.get(s) === 'bench')).toEqual(nonCaptains.slice(15));
    expect(nonCaptains.slice(15)).toHaveLength(4);
  });

  it('ignores a captain who is not signed up, and puts everyone on the bench with no teams', () => {
    const roles = defaultRoles(ids.slice(0, 3).map((steamid) => ({ steamid })), new Set(['gone']), 0);
    expect([...roles.values()]).toEqual(['bench', 'bench', 'bench']);
  });
});

describe('cutProblems', () => {
  const good = { teams: 5, active: 21, captains: 5, pool: 15, unassigned: 0, ineligible: 0 };
  it('is empty for a publishable cut', () => {
    expect(cutProblems(good)).toEqual([]);
  });
  it('names each problem, in order', () => {
    expect(cutProblems({ ...good, teams: null })).toContain('too_few_teams');
    expect(cutProblems({ ...good, teams: 1, captains: 1, pool: 3 })).toEqual(['too_few_teams']);
    expect(cutProblems({ ...good, teams: 6, captains: 6, pool: 18 })).toEqual(['too_many_teams']);
    expect(cutProblems({ ...good, captains: 4 })).toEqual(['too_few_captains']);
    expect(cutProblems({ ...good, captains: 6 })).toEqual(['too_many_captains']);
    expect(cutProblems({ ...good, pool: 14 })).toEqual(['pool_size']);
    expect(cutProblems({ ...good, unassigned: 1 })).toEqual(['unassigned']);
    expect(cutProblems({ ...good, ineligible: 2 })).toEqual(['ineligible']);
    expect(cutProblems({ teams: 6, active: 21, captains: 0, pool: 14, unassigned: 1, ineligible: 1 }))
      .toEqual(['too_many_teams', 'too_few_captains', 'pool_size', 'unassigned', 'ineligible']);
  });
});

describe('nextOfferee', () => {
  const row = (steamid: string, sr: number, o: Partial<{ captainPref: 'want' | 'willing' | 'no'; role: 'captain' | 'pool' | 'bench' | null; eligible: boolean }> = {}) =>
    ({ steamid, sr, captainPref: o.captainPref ?? 'willing', role: o.role ?? 'pool', eligible: o.eligible ?? true });
  it('is the highest SR willing signup, never a want, a no, a captain, an ineligible one or one offered before', () => {
    const rows = [
      row('a', 1200), row('b', 1900, { captainPref: 'no' }), row('c', 1800, { captainPref: 'want' }), row('d', 1700, { role: 'captain' }),
      row('e', 1600, { eligible: false }), row('f', 1500), row('g', 1400, { role: 'bench' }),
    ];
    expect(nextOfferee(rows, new Set())).toBe('f');
    expect(nextOfferee(rows, new Set(['f']))).toBe('g');
    expect(nextOfferee(rows, new Set(['f', 'g']))).toBe('a');
    expect(nextOfferee(rows, new Set(['f', 'g', 'a']))).toBeNull();
  });
  it('breaks an SR tie by signup order (input order)', () => {
    expect(nextOfferee([row('x', 1500), row('y', 1500)], new Set())).toBe('x');
    expect(nextOfferee([row('y', 1500), row('x', 1500)], new Set())).toBe('y');
  });
});
