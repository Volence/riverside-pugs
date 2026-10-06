import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { TEMPLATES, parseRules, rulesForKind } from '../src/rulesets.js';

describe('rulesets', () => {
  it('seeds the three templates once', () => {
    const db = openDb(':memory:');
    const rows = db.prepare('SELECT name, rules_json, template FROM rulesets ORDER BY name').all() as { name: string; rules_json: string; template: number }[];
    expect(rows.map((r) => r.name)).toEqual(['Casual Scrim', 'PUG', 'Standard Cup']);
    for (const r of rows) {
      expect(r.template).toBe(1);
      expect(parseRules(r.rules_json)).toEqual(TEMPLATES[r.name as keyof typeof TEMPLATES]);
    }
  });

  it('the templates are copies of nothing', () => {
    const db = openDb(':memory:');
    expect(db.prepare('SELECT DISTINCT based_on FROM rulesets').all()).toEqual([{ based_on: null }]);
  });

  it('only the PUG template is rated', () => {
    expect(TEMPLATES.PUG.rated).toBe(true);
    expect(TEMPLATES['Standard Cup'].rated).toBe(false);
    expect(TEMPLATES['Casual Scrim'].rated).toBe(false);
  });

  it('rulesForKind forces unrated outside pug', () => {
    expect(rulesForKind('scrim', TEMPLATES.PUG).rated).toBe(false);
    expect(rulesForKind('tournament', TEMPLATES.PUG).rated).toBe(false);
    expect(rulesForKind('pug', TEMPLATES.PUG).rated).toBe(true);
  });

  it('parseRules rejects a missing or mistyped field', () => {
    const { pause, ...noPause } = TEMPLATES.PUG;
    expect(() => parseRules(JSON.stringify(noPause))).toThrow(/invalid rules: pause/);
    expect(() => parseRules(JSON.stringify({ ...TEMPLATES.PUG, bosses: 'sometimes' }))).toThrow(/invalid rules: bosses/);
    expect(() => parseRules('not json')).toThrow(/invalid rules/);
  });

  it('reads subs.perMatch and defaults it to 2 for rules saved before the field (plan T3c)', () => {
    const old = JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: undefined });
    expect(parseRules(old).subs).toEqual({ perMatch: 2 });
    expect(parseRules(JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 1 } })).subs).toEqual({ perMatch: 1 });
    expect(() => parseRules(JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 9 } }))).toThrow('invalid rules: subs.perMatch');
    expect(() => parseRules(JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 'two' } }))).toThrow('invalid rules: subs.perMatch');
    for (const t of Object.values(TEMPLATES)) expect(t.subs).toEqual({ perMatch: 2 });
  });
});
