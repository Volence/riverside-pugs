import { describe, it, expect } from 'vitest';
import * as V from '../src/events/validate.js';

const CTX: V.StageContext = {
  campaigns: new Set(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'dead_center', 'dark_carnival', 'swamp_fever', 'hard_rain']),
  rulesetIds: new Set([1, 2]),
  pugRulesetId: 3,
  gameConfigs: new Set(['standard']),
  defaultPool: ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest'],
};
const SEVEN = ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'dead_center', 'dark_carnival', 'swamp_fever'];
const bad = (r: V.Checked<unknown>): V.EventError | null => (r.ok ? null : r.error);
const stage = (over: Record<string, unknown> = {}) => ({ type: 'swiss', config: { rounds: 4 }, rulesetId: 2, ...over });

describe('names, slugs, descriptions, reasons, times', () => {
  it('trims and folds spaces, and holds a name to 3 to 60 characters of plain text', () => {
    expect(V.normalizeEventName('  Riverside   Cup  ')).toEqual({ ok: true, value: 'Riverside Cup' });
    expect(bad(V.normalizeEventName('ab'))).toBe('bad_name');
    expect(bad(V.normalizeEventName('x'.repeat(61)))).toBe('bad_name');
    expect(bad(V.normalizeEventName('⠀⠀⠀'))).toBe('bad_name');
    expect(bad(V.normalizeEventName(42))).toBe('bad_name');
  });

  it('makes a slug base from the name, with a fallback for a name of symbols', () => {
    expect(V.eventSlugBase('Riverside Cup #1!')).toBe('riverside-cup-1');
    expect(V.eventSlugBase('Café Clash')).toBe('cafe-clash');
    expect(V.eventSlugBase('!!!')).toBe('event');
    for (const w of ['new', 'edit', 'options']) expect(V.RESERVED_EVENT_SLUGS.has(w)).toBe(true);
  });

  it('keeps a description as typed, line breaks included, up to 4000 characters', () => {
    expect(V.normalizeDescription('Line one\r\nLine two\n')).toEqual({ ok: true, value: 'Line one\nLine two' });
    expect(V.normalizeDescription(undefined)).toEqual({ ok: true, value: '' });
    expect(V.normalizeDescription('<b>bold</b>')).toEqual({ ok: true, value: '<b>bold</b>' });
    expect(bad(V.normalizeDescription('x'.repeat(4001)))).toBe('bad_description');
    expect(bad(V.normalizeDescription(7))).toBe('bad_description');
  });

  it('a cancel reason is optional, one line and short', () => {
    expect(V.normalizeReason(undefined)).toEqual({ ok: true, value: null });
    expect(V.normalizeReason('   ')).toEqual({ ok: true, value: null });
    expect(V.normalizeReason(' Not enough\nteams ')).toEqual({ ok: true, value: 'Not enough teams' });
    expect(bad(V.normalizeReason('x'.repeat(301)))).toBe('bad_reason');
  });

  it('reads a time with a zone into UTC and refuses anything else', () => {
    expect(V.parseTime('2026-10-10T20:00:00+02:00')).toBe('2026-10-10T18:00:00.000Z');
    expect(V.parseTime('2026-10-10T20:00:00.000Z')).toBe('2026-10-10T20:00:00.000Z');
    expect(V.parseTime('2026-10-10')).toBeNull();
    expect(V.parseTime('soon')).toBeNull();
    expect(V.parseTime(0)).toBeNull();
  });

  it('refuses a time with no zone, which would be read in the server zone', () => {
    expect(V.parseTime('2026-10-10T20:00')).toBeNull();
    expect(V.parseTime('2026-10-10T20:00:00')).toBeNull();
    expect(V.parseTime('2026-10-10T20:00:00.000')).toBeNull();
    expect(V.parseTime('2026-10-10T20:00Z')).toBe('2026-10-10T20:00:00.000Z');
    expect(V.parseTime('2026-10-10T20:00:00-05:00')).toBe('2026-10-11T01:00:00.000Z');
    expect(V.parseTime('2026-10-10T20:00:00Z junk')).toBeNull();
  });
});

describe('eligibility, check-in and roster rules', () => {
  it('fills defaults, and holds the SR floor below the ceiling', () => {
    expect(V.parseEligibility(undefined)).toEqual({ ok: true, value: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null } });
    expect(V.parseEligibility({ minPugs: 0, srFloor: 1000 })).toEqual({ ok: true, value: { minPugs: 0, requireDiscord: true, srFloor: 1000, srCeiling: null } });
    expect(bad(V.parseEligibility({ srFloor: 2000, srCeiling: 1500 }))).toBe('bad_eligibility');
    expect(bad(V.parseEligibility({ minPugs: -1 }))).toBe('bad_eligibility');
    expect(bad(V.parseEligibility({ requireDiscord: 'yes' }))).toBe('bad_eligibility');
    expect(bad(V.parseEligibility([]))).toBe('bad_eligibility');
  });

  it('check-in is on by default, 60 to 15 minutes before, and closes at least 5 minutes after it opens', () => {
    expect(V.parseCheckin(undefined)).toEqual({ ok: true, value: { enabled: true, opensMinutes: 60, closesMinutes: 15 } });
    expect(V.parseCheckin({ enabled: false })).toEqual({ ok: true, value: { enabled: false, opensMinutes: 60, closesMinutes: 15 } });
    expect(bad(V.parseCheckin({ opensMinutes: 30, closesMinutes: 26 }))).toBe('bad_checkin');
    expect(V.parseCheckin({ opensMinutes: 30, closesMinutes: 25 }).ok).toBe(true);
    expect(bad(V.parseCheckin({ opensMinutes: 5 }))).toBe('bad_checkin');
  });

  it('a roster has 4 starters, 0 to 4 subs and one of the three locks', () => {
    expect(V.parseRoster(undefined)).toEqual({ ok: true, value: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null } });
    expect(V.parseRoster({ lock: { kind: 'at', at: '2026-10-20T00:00:00+00:00' } })).toEqual({
      ok: true, value: { starters: 4, maxSubs: 2, lock: { kind: 'at', at: '2026-10-20T00:00:00.000Z' }, maxAdditions: null },
    });
    expect(V.parseRoster({ maxSubs: 4, lock: { kind: 'after_round', stage: 1, round: 3 }, maxAdditions: 2 }).ok).toBe(true);
    expect(bad(V.parseRoster({ starters: 5 }))).toBe('bad_roster');
    expect(bad(V.parseRoster({ maxSubs: 5 }))).toBe('bad_roster');
    expect(bad(V.parseRoster({ lock: { kind: 'at', at: 'later' } }))).toBe('bad_roster');
    expect(bad(V.parseRoster({ lock: { kind: 'after_round', stage: 0, round: 1 } }))).toBe('bad_roster');
    expect(bad(V.parseRoster({ lock: { kind: 'forever' } }))).toBe('bad_roster');
  });
});

describe('event fields', () => {
  const START = '2026-10-10T20:00:00.000Z';
  it('a new event needs a name, a start and an entry kind, and takes the defaults for the rest', () => {
    expect(V.parseEventFields({ name: 'Cup', startsAt: START, entryKind: 'team' }, null)).toEqual({
      ok: true,
      value: {
        name: 'Cup', startsAt: START, entryKind: 'team', official: true, teamCap: null, description: '',
        eligibility: V.defaultEligibility(), checkin: V.defaultCheckin(), roster: V.defaultRoster(),
      },
    });
    expect(bad(V.parseEventFields({ name: 'Cup' }, null))).toBe('missing_fields');
    expect(bad(V.parseEventFields('Cup', null))).toBe('bad_request');
    expect(bad(V.parseEventFields({ name: 'Cup', startsAt: START, entryKind: 'solo' }, null))).toBe('bad_entry_kind');
    expect(bad(V.parseEventFields({ name: 'Cup', startsAt: 'later', entryKind: 'team' }, null))).toBe('bad_start');
  });

  it('an edit changes only what it carries, and null clears the team cap', () => {
    const base = V.parseEventFields({ name: 'Cup', startsAt: START, entryKind: 'team', teamCap: 16 }, null);
    if (!base.ok) throw new Error(base.error);
    expect(V.parseEventFields({ description: 'Hi' }, base.value)).toEqual({ ok: true, value: { ...base.value, description: 'Hi' } });
    expect(V.parseEventFields({ teamCap: null }, base.value)).toEqual({ ok: true, value: { ...base.value, teamCap: null } });
    expect(bad(V.parseEventFields({ teamCap: 1 }, base.value))).toBe('bad_team_cap');
    expect(bad(V.parseEventFields({ official: 'yes' }, base.value))).toBe('bad_request');
  });
});

describe('stages', () => {
  it('fills defaults per type and takes the site pool when none is sent', () => {
    expect(V.parseStage(stage(), CTX)).toEqual({
      ok: true,
      value: {
        type: 'swiss', config: { rounds: 4 }, rulesetId: 2, gameConfig: 'standard', campaignPool: CTX.defaultPool,
        vetoType: 'ban_to_one', chapters: null, scheduling: 'rolling', advanceCount: null,
      },
    });
    expect(V.parseStageConfig('double_elim', undefined)).toEqual({ ok: true, value: { grandFinalReset: true } });
    expect(V.parseStageConfig('league', {})).toEqual({ ok: true, value: { weeks: 6, matchesPerWeek: 1, pairing: 'swiss' } });
    expect(V.parseStageConfig('round_robin', { groups: 2 })).toEqual({ ok: true, value: { groups: 2 } });
  });

  it('holds each type config to its range', () => {
    expect(bad(V.parseStageConfig('swiss', { rounds: 10 }))).toBe('bad_stage_config');
    expect(bad(V.parseStageConfig('round_robin', { groups: 0 }))).toBe('bad_stage_config');
    expect(bad(V.parseStageConfig('league', { pairing: 'random' }))).toBe('bad_stage_config');
    expect(bad(V.parseStageConfig('single_elim', { thirdPlace: 1 }))).toBe('bad_stage_config');
  });

  it('refuses an unknown type, an archived ruleset, a config that is off, and a bad chapter count', () => {
    expect(bad(V.parseStage(stage({ type: 'ladder' }), CTX))).toBe('bad_stage_type');
    expect(bad(V.parseStage(stage({ rulesetId: 9 }), CTX))).toBe('bad_ruleset');
    expect(bad(V.parseStage(stage({ rulesetId: 3 }), CTX))).toBe('pug_ruleset');
    expect(bad(V.parseStage(stage({ gameConfig: 'zonemod' }), CTX))).toBe('bad_game_config');
    expect(bad(V.parseStage(stage({ chapters: 6 }), CTX))).toBe('bad_chapters');
    expect(V.parseStage(stage({ chapters: 3 }), CTX).ok).toBe(true);
    expect(bad(V.parseStage(stage({ advanceCount: 1 }), CTX))).toBe('bad_advance');
    expect(bad(V.parseStage([], CTX))).toBe('bad_request');
  });

  it('a pool is 1 to 12 different poolable campaigns, sized for its veto', () => {
    expect(bad(V.parseStage(stage({ campaignPool: [] }), CTX))).toBe('bad_pool');
    expect(bad(V.parseStage(stage({ campaignPool: ['no_mercy', 'no_mercy'] }), CTX))).toBe('bad_pool');
    expect(bad(V.parseStage(stage({ campaignPool: ['not_a_campaign'] }), CTX))).toBe('bad_pool');
    expect(V.parseStage(stage({ campaignPool: ['no_mercy'] }), CTX).ok).toBe(true);
    expect(bad(V.parseStage(stage({ campaignPool: ['no_mercy'], vetoType: 'home_away' }), CTX))).toBe('bad_pool_for_veto');
    expect(bad(V.parseStage(stage({ campaignPool: SEVEN.slice(0, 6), vetoType: 'pick_ban' }), CTX))).toBe('bad_pool_for_veto');
    expect(V.parseStage(stage({ campaignPool: SEVEN, vetoType: 'pick_ban' }), CTX).ok).toBe(true);
    expect(bad(V.parseStage(stage({ vetoType: 'coin' }), CTX))).toBe('bad_veto');
  });

  it('a league is always played in windows', () => {
    const r = V.parseStage(stage({ type: 'league', config: {} }), CTX);
    expect(r.ok && r.value.scheduling).toBe('window');
    expect(bad(V.parseStage(stage({ type: 'league', config: {}, scheduling: 'rolling' }), CTX))).toBe('league_needs_window');
    expect(bad(V.parseStage(stage({ scheduling: 'weekly' }), CTX))).toBe('bad_scheduling');
  });
});

describe('the stage chain', () => {
  const roster = V.defaultRoster();
  it('needs a stage, an advance count on every stage but the last, each smaller than the one before and the cap', () => {
    expect(bad(V.checkChain([], { teamCap: null, roster }))).toBe('no_stages');
    expect(V.checkChain([{ advanceCount: null }], { teamCap: null, roster })).toEqual({ ok: true, value: null });
    expect(V.checkChain([{ advanceCount: 8 }, { advanceCount: 4 }, { advanceCount: null }], { teamCap: 16, roster }).ok).toBe(true);
    expect(bad(V.checkChain([{ advanceCount: 8 }], { teamCap: null, roster }))).toBe('bad_chain');
    expect(bad(V.checkChain([{ advanceCount: null }, { advanceCount: null }], { teamCap: null, roster }))).toBe('bad_chain');
    expect(bad(V.checkChain([{ advanceCount: 4 }, { advanceCount: 8 }, { advanceCount: null }], { teamCap: null, roster }))).toBe('bad_chain');
    expect(bad(V.checkChain([{ advanceCount: 16 }, { advanceCount: null }], { teamCap: 16, roster }))).toBe('bad_chain');
  });

  it('a roster lock after a round must point at a stage that exists', () => {
    const late: V.RosterRules = { ...roster, lock: { kind: 'after_round', stage: 2, round: 1 } };
    expect(bad(V.checkChain([{ advanceCount: null }], { teamCap: null, roster: late }))).toBe('bad_roster');
    expect(V.checkChain([{ advanceCount: 4 }, { advanceCount: null }], { teamCap: null, roster: late }).ok).toBe(true);
  });
});

describe('status rules', () => {
  it('T1a moves draft to announced to registration, and cancels anything published and not over', () => {
    expect(V.nextStatusAllowed('draft', 'announced')).toBe(true);
    expect(V.nextStatusAllowed('announced', 'registration')).toBe(true);
    expect(V.nextStatusAllowed('draft', 'registration')).toBe(false);
    expect(V.nextStatusAllowed('registration', 'checkin')).toBe(true);
    for (const s of ['announced', 'registration', 'checkin', 'live'] as const) expect(V.nextStatusAllowed(s, 'cancelled')).toBe(true);
    expect(V.nextStatusAllowed('draft', 'cancelled')).toBe(false);
    expect(V.nextStatusAllowed('finished', 'cancelled')).toBe(false);
    expect(V.nextStatusAllowed('cancelled', 'cancelled')).toBe(false);
  });

  it('events are edited until registration closes; stages until the event is live', () => {
    expect([...V.EVENT_EDITABLE]).toEqual(['draft', 'announced', 'registration']);
    expect([...V.STAGES_LOCKED]).toEqual(['live', 'finished', 'cancelled']);
  });

  it('every error has a status and a sentence', () => {
    for (const [k, e] of Object.entries(V.EVENT_ERRORS)) {
      expect([400, 403, 404, 409]).toContain(e.status);
      expect(e.text.length, k).toBeGreaterThan(10);
      expect(e.text.includes(String.fromCharCode(0x2014)), k).toBe(false);
    }
  });
});
