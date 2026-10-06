import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { MATCH_PLAY_DEFAULTS, TEMPLATES, parseRules, rulesForKind } from '../src/rulesets.js';

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
    expect(parseRules(old).subs).toEqual({ perMatch: 2, emergency: true, emergencyChargeSeconds: 0 });
    expect(parseRules(JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 1 } })).subs).toEqual({ perMatch: 1, emergency: true, emergencyChargeSeconds: 0 });
    expect(() => parseRules(JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 9 } }))).toThrow('invalid rules: subs.perMatch');
    expect(() => parseRules(JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 'two' } }))).toThrow('invalid rules: subs.perMatch');
    for (const t of Object.values(TEMPLATES)) expect(t.subs.perMatch).toBe(2);
  });

  it('reads the plan T5 match-play fields, defaulting each one a ruleset saved before them lacks', () => {
    const cup = TEMPLATES['Standard Cup'];
    const old = JSON.parse(JSON.stringify(cup)) as Record<string, unknown>;
    delete (old.pause as Record<string, unknown>).techSeconds;
    delete old.disconnect;
    delete old.staffCall;
    delete old.series;
    old.subs = { perMatch: 1 };
    const r = parseRules(JSON.stringify(old));
    expect(r.pause.techSeconds).toBe(MATCH_PLAY_DEFAULTS.techSeconds);
    expect(r.disconnect).toEqual({ teamSeconds: 600 });
    expect(r.staffCall).toEqual({ cooldownSeconds: 180 });
    expect(r.series).toEqual({ nextGameSeconds: 60 });
    expect(r.subs).toEqual({ perMatch: 1, emergency: true, emergencyChargeSeconds: 0 });
    const custom = { ...cup, pause: { ...cup.pause, techSeconds: 120 }, disconnect: { teamSeconds: 900 }, staffCall: { cooldownSeconds: 60 }, series: { nextGameSeconds: 120 }, subs: { perMatch: 2, emergency: false, emergencyChargeSeconds: 30 } };
    expect(parseRules(JSON.stringify(custom))).toEqual(custom);
    for (const [field, bad] of [['pause.techSeconds', { ...cup, pause: { ...cup.pause, techSeconds: 30 } }], ['disconnect.teamSeconds', { ...cup, disconnect: { teamSeconds: 4000 } }],
      ['staffCall.cooldownSeconds', { ...cup, staffCall: { cooldownSeconds: 'x' } }], ['series.nextGameSeconds', { ...cup, series: { nextGameSeconds: 10 } }],
      ['subs.emergency', { ...cup, subs: { perMatch: 2, emergency: 'yes' } }], ['subs.emergencyChargeSeconds', { ...cup, subs: { perMatch: 2, emergencyChargeSeconds: 601 } }]] as const) {
      expect(() => parseRules(JSON.stringify(bad))).toThrow(`invalid rules: ${field}`);
    }
  });

  it('gives every template the defaults, PUG included, and keeps PUG\'s own values (plan T5 Ruling 3)', () => {
    for (const t of Object.values(TEMPLATES)) {
      expect(t.pause.techSeconds).toBe(300);
      expect(t.disconnect).toEqual({ teamSeconds: 600 });
      expect(t.staffCall).toEqual({ cooldownSeconds: 180 });
      expect(t.series).toEqual({ nextGameSeconds: 60 });
      expect(t.subs).toEqual({ perMatch: 2, emergency: true, emergencyChargeSeconds: 0 });
    }
    expect(TEMPLATES.PUG.pause).toEqual({ limit: 3, seconds: 120, mutualUnpause: false, techPauses: 0, techSeconds: 300 });
    expect(TEMPLATES['Standard Cup'].pause.techPauses).toBe(2);
    expect(TEMPLATES['Casual Scrim'].pause.techPauses).toBe(0);
  });
});
