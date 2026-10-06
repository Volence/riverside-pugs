import { findSlurs } from '../slurs.js';
import { hasUnsafeChars } from '../profileFields.js';

/**
 * Every rule about an event's and a stage's settings (tournaments spec part
 * 2, sections 1 and 2; plan T1a). Pure: the lists a stage is checked against
 * (poolable campaigns, live rulesets, enabled game configs, the site pool)
 * come in as a StageContext, so the whole module is tested without a
 * database. src/events/events.ts calls it on every write, and again at
 * publish with the lists of that moment.
 */

export const EVENT_STATUSES = ['draft', 'announced', 'registration', 'checkin', 'live', 'finished', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const ENTRY_KINDS = ['team', 'draft'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const STAGE_TYPES = ['single_elim', 'double_elim', 'round_robin', 'swiss', 'league'] as const;
export type StageType = (typeof STAGE_TYPES)[number];
export const VETO_TYPES = ['ban_to_one', 'home_away', 'pick_ban'] as const;
export type VetoType = (typeof VETO_TYPES)[number];
export const SCHEDULING_KINDS = ['rolling', 'window'] as const;
export type Scheduling = (typeof SCHEDULING_KINDS)[number];

export const NAME_MIN = 3;
export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 4000;
export const CANCEL_REASON_MAX = 300;
export const POOL_MAX = 12;
export const LEAGUE_MATCHES_MAX = 40;
export const STAGES_MAX = 5;
/** ban, ban, pick, pick, ban, ban, decider (spec section 4, pick_ban). */
export const PICK_BAN_POOL = 7;
/** Words the routes use for themselves, or may later. */
export const RESERVED_EVENT_SLUGS: ReadonlySet<string> = new Set(['new', 'edit', 'mine', 'admin', 'logos', 'banners', 'options']);

export const EVENT_ERRORS = {
  bad_request: { status: 400, text: 'That request is not one this form sends.' },
  missing_fields: { status: 400, text: 'An event needs a name, a start time and an entry kind.' },
  bad_name: { status: 400, text: `An event name is ${NAME_MIN} to ${NAME_MAX} characters of plain text.` },
  name_not_allowed: { status: 400, text: 'That name is not allowed here.' },
  bad_description: { status: 400, text: `The description is at most ${DESCRIPTION_MAX} characters, with no control characters.` },
  bad_start: { status: 400, text: 'The start time is not a date and time.' },
  start_passed: { status: 400, text: 'The start time has to be in the future.' },
  bad_entry_kind: { status: 400, text: 'Entries are teams or a draft.' },
  bad_team_cap: { status: 400, text: 'A team cap is 2 to 256 teams, or none.' },
  bad_eligibility: { status: 400, text: 'Eligibility: minimum PUGs 0 to 1000, and an SR floor below the SR ceiling.' },
  bad_checkin: { status: 400, text: 'Check-in opens 10 to 1440 minutes before the start and closes at least 5 minutes after it opens.' },
  bad_roster: { status: 400, text: 'Roster rules: 4 starters, 0 to 4 subs, and a lock that points at a real stage and round.' },
  bad_stage_type: { status: 400, text: 'A stage is single elimination, double elimination, round robin, Swiss or league.' },
  bad_stage_config: { status: 400, text: 'Those stage settings are out of range.' },
  bad_ruleset: { status: 400, text: 'Pick a ruleset that is not archived.' },
  pug_ruleset: { status: 400, text: 'PUG rules are for PUGs; copy them into a new ruleset for scrims and events.' },
  bad_game_config: { status: 400, text: 'Pick a game config that is turned on.' },
  bad_pool: { status: 400, text: `A campaign pool is 1 to ${POOL_MAX} different campaigns from the poolable list.` },
  bad_pool_for_veto: { status: 400, text: `Home and away needs at least 2 campaigns; pick and ban needs exactly ${PICK_BAN_POOL}.` },
  bad_veto: { status: 400, text: 'The veto is ban to one, home and away, or pick and ban.' },
  bad_chapters: { status: 400, text: 'Chapters is standard, or 1 to 5.' },
  bad_scheduling: { status: 400, text: 'Scheduling is rolling or in windows.' },
  league_needs_window: { status: 400, text: 'A league stage is played in scheduled windows.' },
  bad_advance: { status: 400, text: 'An advance count is 2 to 128 teams.' },
  bad_chain: { status: 400, text: 'Every stage but the last needs an advance count, smaller than the stage before it and the team cap; the last stage has none.' },
  bad_order: { status: 400, text: 'The new order must list every stage of this event once.' },
  bad_reason: { status: 400, text: `A reason is one line of at most ${CANCEL_REASON_MAX} characters.` },
  no_stages: { status: 409, text: 'Add at least one stage first.' },
  too_many_stages: { status: 409, text: `An event has at most ${STAGES_MAX} stages.` },
  not_found: { status: 404, text: 'No such event.' },
  stage_not_found: { status: 404, text: 'No such stage on this event.' },
  wrong_status: { status: 409, text: 'The event is not at a step that allows that.' },
  stages_locked: { status: 409, text: 'Stages cannot change once the event is live.' },
  kind_locked: { status: 409, text: 'The entry kind can only change while the event is a draft.' },
  draft_signups_later: { status: 409, text: 'Signups for a draft event arrive with the draft plan.' },
  has_entries: { status: 409, text: 'This draft has entries, so it cannot be deleted.' },
  bad_entry_roster: { status: 400, text: 'A roster is exactly 4 starters, no more subs than the event allows and at most one coach, each player once.' },
  not_registration: { status: 409, text: 'Registration is not open for this event.' },
  team_not_found: { status: 404, text: 'No such team.' },
  not_manager: { status: 403, text: 'Only the team captain or a co-captain can do that.' },
  already_entered: { status: 409, text: 'This team already has an entry in this event.' },
  not_on_team: { status: 400, text: 'Everyone added to the roster has to be on the team.' },
  player_ineligible: { status: 409, text: 'Someone on the roster does not meet the entry rules.' },
  player_entered: { status: 409, text: 'Someone on the roster is already on another entry in this event.' },
  entry_not_found: { status: 404, text: 'No such entry in this event.' },
  entry_out: { status: 409, text: 'This entry is no longer in the event.' },
  roster_locked: { status: 409, text: 'Rosters are locked for this event; ask staff to change yours.' },
  additions_used: { status: 409, text: 'This entry has used all the roster additions the event allows.' },
  not_on_entry: { status: 400, text: 'You are not on this roster.' },
  entries_locked: { status: 409, text: 'The entry list is final now.' },
  no_checkin: { status: 409, text: 'This event has no check-in.' },
  not_checkin: { status: 409, text: 'Check-in is not open.' },
  need_starters: { status: 409, text: 'Check-in needs 4 starters on the roster.' },
  seeds_locked: { status: 409, text: 'Seeds can change only once the entry list is final and before the event goes live.' },
  bad_seed_order: { status: 400, text: 'The new seed order must list every seeded entry once.' },
  not_restorable: { status: 409, text: 'Only a dropped or disqualified entry can be restored, before the entry list is final.' },
  list_not_final: { status: 409, text: 'The entry list is not final yet.' },
  too_few_entries: { status: 409, text: 'A stage needs at least 2 teams to start.' },
  not_live: { status: 409, text: 'That stage is not being played.' },
  match_not_found: { status: 404, text: 'No such match in this event.' },
  match_not_open: { status: 409, text: 'That match does not have two teams to report on yet.' },
  bad_result: { status: 400, text: 'A result names the winner and gives both campaign scores with the winner ahead, or is a forfeit.' },
  result_locked: { status: 409, text: 'Later matches already depend on this result, so it can no longer be changed here.' },
  winner_out: { status: 409, text: 'That team is out of the event, so it cannot win a match.' },
  changed: { status: 409, text: 'The event changed while this was being saved. Reload and try again.' },
  elim_not_last: { status: 400, text: 'An elimination bracket is always the last stage.' },
  bad_group_advance: { status: 400, text: 'With groups, the advance count has to split evenly across the groups.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type EventError = keyof typeof EVENT_ERRORS;

/** One player a roster refusal is about, with the sentences of what is wrong
 *  (src/events/entryRules.ts problemText). The routes add the player's name. */
export interface EntryProblem { steamid: string; problems: string[] }
export type Checked<T> = { ok: true; value: T } | { ok: false; error: EventError; detail?: EntryProblem[] };
export const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
export const fail = (error: EventError, detail?: EntryProblem[]): { ok: false; error: EventError; detail?: EntryProblem[] } =>
  (detail ? { ok: false, error, detail } : { ok: false, error });

export interface Eligibility { minPugs: number; requireDiscord: boolean; srFloor: number | null; srCeiling: number | null }
export interface Checkin { enabled: boolean; opensMinutes: number; closesMinutes: number }
export type RosterLock = { kind: 'none' } | { kind: 'at'; at: string } | { kind: 'after_round'; stage: number; round: number };
export interface RosterRules { starters: 4; maxSubs: number; lock: RosterLock; maxAdditions: number | null }

export interface StageConfigs {
  single_elim: { thirdPlace: boolean };
  double_elim: { grandFinalReset: boolean };
  round_robin: { groups: number };
  swiss: { rounds: number };
  league: { matches: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin'; seasonStart: string | null };
}
export type StageConfig = StageConfigs[StageType];

export interface StageSettings {
  type: StageType; config: StageConfig; rulesetId: number; gameConfig: string; campaignPool: string[];
  vetoType: VetoType; chapters: number | null; scheduling: Scheduling; advanceCount: number | null;
}
export interface StageContext {
  campaigns: ReadonlySet<string>; rulesetIds: ReadonlySet<number>; pugRulesetId: number | null;
  gameConfigs: ReadonlySet<string>; defaultPool: string[];
}
export interface EventFields {
  name: string; startsAt: string; entryKind: EntryKind; official: boolean; teamCap: number | null; description: string;
  eligibility: Eligibility; checkin: Checkin; roster: RosterRules;
}

export const SCORE_MAX = 100000;
/** A match result as an admin enters it (plan T2 Ruling 1). */
export interface ResultInput { winner: 'a' | 'b'; scoreA: number | null; scoreB: number | null; forfeit: boolean }

export const defaultEligibility = (): Eligibility => ({ minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null });
export const defaultCheckin = (): Checkin => ({ enabled: true, opensMinutes: 60, closesMinutes: 15 });
export const defaultRoster = (): RosterRules => ({ starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Winner a or b. A forfeit carries no scores (any sent are dropped);
 *  otherwise both scores are integers 0..SCORE_MAX with the winner strictly
 *  ahead, as ties are replayed (spec section 3). */
export function parseResult(raw: unknown): Checked<ResultInput> {
  if (!isObj(raw) || (raw.winner !== 'a' && raw.winner !== 'b')) return fail('bad_result');
  const forfeit = raw.forfeit ?? false;
  if (typeof forfeit !== 'boolean') return fail('bad_result');
  if (forfeit) return ok({ winner: raw.winner, scoreA: null, scoreB: null, forfeit: true });
  if (!isInt(raw.scoreA, 0, SCORE_MAX) || !isInt(raw.scoreB, 0, SCORE_MAX)) return fail('bad_result');
  const ahead = raw.winner === 'a' ? raw.scoreA > raw.scoreB : raw.scoreB > raw.scoreA;
  return ahead ? ok({ winner: raw.winner, scoreA: raw.scoreA, scoreB: raw.scoreB, forfeit: false }) : fail('bad_result');
}

/** null (or absent) is null; an integer in range is itself; anything else undefined. */
const intOrNull = (v: unknown, min: number, max: number): number | null | undefined =>
  v === null || v === undefined ? null : isInt(v, min, max) ? v : undefined;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/** An ISO date and time with a zone (Z or +HH:MM / -HH:MM), as UTC; null
 *  for anything else. A time with no zone is refused, not read in the
 *  server's own zone. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export function parseTime(v: unknown): string | null {
  if (typeof v !== 'string' || !ISO_WITH_ZONE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Invisible-by-design code points; see the same rule in src/teams/teams.ts. */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

export function normalizeEventName(raw: unknown): Checked<string> {
  if (typeof raw !== 'string') return fail('bad_name');
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN || name.length > NAME_MAX || hasUnsafeChars(name) || DEFAULT_IGNORABLE.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
    return fail('bad_name');
  }
  if (findSlurs(name).length > 0) return fail('name_not_allowed');
  return ok(name);
}

/** Stored as typed, line breaks kept; the web formats it with the safe
 *  markdown subset (Ruling 1), so nothing here interprets it. */
export function normalizeDescription(raw: unknown): Checked<string> {
  if (raw === undefined || raw === null) return ok('');
  if (typeof raw !== 'string') return fail('bad_description');
  const text = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (text.length > DESCRIPTION_MAX || hasUnsafeChars(text, true)) return fail('bad_description');
  return ok(text);
}

export function normalizeReason(raw: unknown): Checked<string | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== 'string') return fail('bad_reason');
  const text = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (text.length > CANCEL_REASON_MAX || hasUnsafeChars(text)) return fail('bad_reason');
  return ok(text === '' ? null : text);
}

/** The slug a name would like; src/events/events.ts makes it unique. */
export function eventSlugBase(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48).replace(/-+$/, '') || 'event';
}

export function parseEligibility(raw: unknown): Checked<Eligibility> {
  if (raw === undefined) return ok(defaultEligibility());
  if (!isObj(raw)) return fail('bad_eligibility');
  const d = defaultEligibility();
  const minPugs = raw.minPugs ?? d.minPugs;
  const requireDiscord = raw.requireDiscord ?? d.requireDiscord;
  const srFloor = intOrNull(raw.srFloor, 0, 10000);
  const srCeiling = intOrNull(raw.srCeiling, 0, 10000);
  if (!isInt(minPugs, 0, 1000) || typeof requireDiscord !== 'boolean' || srFloor === undefined || srCeiling === undefined) {
    return fail('bad_eligibility');
  }
  if (srFloor !== null && srCeiling !== null && srFloor >= srCeiling) return fail('bad_eligibility');
  return ok({ minPugs, requireDiscord, srFloor, srCeiling });
}

export function parseCheckin(raw: unknown): Checked<Checkin> {
  if (raw === undefined) return ok(defaultCheckin());
  if (!isObj(raw)) return fail('bad_checkin');
  const d = defaultCheckin();
  const enabled = raw.enabled ?? d.enabled;
  const opensMinutes = raw.opensMinutes ?? d.opensMinutes;
  const closesMinutes = raw.closesMinutes ?? d.closesMinutes;
  if (typeof enabled !== 'boolean' || !isInt(opensMinutes, 10, 1440) || !isInt(closesMinutes, 0, 1440)) return fail('bad_checkin');
  if (closesMinutes > opensMinutes - 5) return fail('bad_checkin');
  return ok({ enabled, opensMinutes, closesMinutes });
}

function parseLock(raw: unknown): RosterLock | null {
  if (raw === undefined) return { kind: 'none' };
  if (!isObj(raw)) return null;
  if (raw.kind === 'none') return { kind: 'none' };
  if (raw.kind === 'at') {
    const at = parseTime(raw.at);
    return at ? { kind: 'at', at } : null;
  }
  if (raw.kind === 'after_round') {
    const stage = raw.stage;
    const round = raw.round;
    return isInt(stage, 1, STAGES_MAX) && isInt(round, 1, 20) ? { kind: 'after_round', stage, round } : null;
  }
  return null;
}

export function parseRoster(raw: unknown): Checked<RosterRules> {
  if (raw === undefined) return ok(defaultRoster());
  if (!isObj(raw)) return fail('bad_roster');
  if ((raw.starters ?? 4) !== 4) return fail('bad_roster');
  const maxSubs = raw.maxSubs ?? defaultRoster().maxSubs;
  const maxAdditions = intOrNull(raw.maxAdditions, 0, 20);
  const lock = parseLock(raw.lock);
  if (!isInt(maxSubs, 0, 4) || maxAdditions === undefined || lock === null) return fail('bad_roster');
  return ok({ starters: 4, maxSubs, lock, maxAdditions });
}

/**
 * A whole EventFields from a request body. With base null it is a create:
 * name, startsAt and entryKind are required and the rest take their
 * defaults. With a base it is an edit: only the keys present change.
 */
export function parseEventFields(raw: unknown, base: EventFields | null): Checked<EventFields> {
  if (!isObj(raw)) return fail('bad_request');
  const has = (k: string) => raw[k] !== undefined;
  if (!base && (!has('name') || !has('startsAt') || !has('entryKind'))) return fail('missing_fields');
  const out: EventFields = base ? { ...base } : {
    name: '', startsAt: '', entryKind: 'team', official: true, teamCap: null, description: '',
    eligibility: defaultEligibility(), checkin: defaultCheckin(), roster: defaultRoster(),
  };
  if (has('name')) {
    const r = normalizeEventName(raw.name);
    if (!r.ok) return r;
    out.name = r.value;
  }
  if (has('startsAt')) {
    const t = parseTime(raw.startsAt);
    if (!t) return fail('bad_start');
    out.startsAt = t;
  }
  if (has('entryKind')) {
    const k = raw.entryKind;
    if (!oneOf(ENTRY_KINDS, k)) return fail('bad_entry_kind');
    out.entryKind = k;
  }
  if (has('official')) {
    const o = raw.official;
    if (typeof o !== 'boolean') return fail('bad_request');
    out.official = o;
  }
  if ('teamCap' in raw) {
    const c = intOrNull(raw.teamCap, 2, 256);
    if (c === undefined) return fail('bad_team_cap');
    out.teamCap = c;
  }
  if (has('description')) {
    const r = normalizeDescription(raw.description);
    if (!r.ok) return r;
    out.description = r.value;
  }
  if (has('eligibility')) {
    const r = parseEligibility(raw.eligibility);
    if (!r.ok) return r;
    out.eligibility = r.value;
  }
  if (has('checkin')) {
    const r = parseCheckin(raw.checkin);
    if (!r.ok) return r;
    out.checkin = r.value;
  }
  if (has('roster')) {
    const r = parseRoster(raw.roster);
    if (!r.ok) return r;
    out.roster = r.value;
  }
  return ok(out);
}

/** A real calendar day written YYYY-MM-DD. Day 30 of February parses but
 *  rolls over to March, so the round trip refuses it; month 13 does not
 *  parse at all. Never throws. */
function isDay(v: unknown): boolean {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

export function parseStageConfig(type: StageType, raw: unknown): Checked<StageConfig> {
  const c = raw === undefined ? {} : raw;
  if (!isObj(c)) return fail('bad_stage_config');
  switch (type) {
    case 'single_elim': {
      const thirdPlace = c.thirdPlace ?? false;
      return typeof thirdPlace === 'boolean' ? ok({ thirdPlace }) : fail('bad_stage_config');
    }
    case 'double_elim': {
      const grandFinalReset = c.grandFinalReset ?? true;
      return typeof grandFinalReset === 'boolean' ? ok({ grandFinalReset }) : fail('bad_stage_config');
    }
    case 'round_robin': {
      const groups = c.groups ?? 1;
      return isInt(groups, 1, 8) ? ok({ groups }) : fail('bad_stage_config');
    }
    case 'swiss': {
      const rounds = c.rounds ?? 4;
      return isInt(rounds, 1, 9) ? ok({ rounds }) : fail('bad_stage_config');
    }
    case 'league': {
      const matches = c.matches ?? 16;
      const matchesPerWeek = c.matchesPerWeek ?? 1;
      const pairing = c.pairing ?? 'swiss';
      const seasonStart = c.seasonStart ?? null;
      return isInt(matches, 1, LEAGUE_MATCHES_MAX) && isInt(matchesPerWeek, 1, 3) && oneOf(['swiss', 'round_robin'] as const, pairing)
        && (seasonStart === null || isDay(seasonStart))
        ? ok({ matches, matchesPerWeek, pairing, seasonStart: seasonStart as string | null })
        : fail('bad_stage_config');
    }
  }
}

export function parsePool(raw: unknown, allowed: ReadonlySet<string>): Checked<string[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > POOL_MAX) return fail('bad_pool');
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== 'string' || !allowed.has(c) || out.includes(c)) return fail('bad_pool');
    out.push(c);
  }
  return ok(out);
}

/** Enough campaigns for the veto to run (spec section 4). */
export function poolFitsVeto(veto: VetoType, size: number): boolean {
  if (veto === 'home_away') return size >= 2;
  if (veto === 'pick_ban') return size === PICK_BAN_POOL;
  return size >= 1;
}

export function parseStage(raw: unknown, ctx: StageContext): Checked<StageSettings> {
  if (!isObj(raw)) return fail('bad_request');
  const type = raw.type;
  if (!oneOf(STAGE_TYPES, type)) return fail('bad_stage_type');
  const config = parseStageConfig(type, raw.config);
  if (!config.ok) return config;
  const rulesetId = raw.rulesetId;
  if (ctx.pugRulesetId !== null && rulesetId === ctx.pugRulesetId) return fail('pug_ruleset');
  if (!Number.isInteger(rulesetId) || !ctx.rulesetIds.has(rulesetId as number)) return fail('bad_ruleset');
  const gameConfig = raw.gameConfig ?? 'standard';
  if (typeof gameConfig !== 'string' || !ctx.gameConfigs.has(gameConfig)) return fail('bad_game_config');
  const pool = parsePool(raw.campaignPool ?? ctx.defaultPool, ctx.campaigns);
  if (!pool.ok) return pool;
  const vetoType = raw.vetoType ?? 'ban_to_one';
  if (!oneOf(VETO_TYPES, vetoType)) return fail('bad_veto');
  if (!poolFitsVeto(vetoType, pool.value.length)) return fail('bad_pool_for_veto');
  const chapters = intOrNull(raw.chapters, 1, 5);
  if (chapters === undefined) return fail('bad_chapters');
  const scheduling = raw.scheduling ?? (type === 'league' ? 'window' : 'rolling');
  if (!oneOf(SCHEDULING_KINDS, scheduling)) return fail('bad_scheduling');
  if (type === 'league' && scheduling !== 'window') return fail('league_needs_window');
  const advanceCount = intOrNull(raw.advanceCount, 2, 128);
  if (advanceCount === undefined) return fail('bad_advance');
  if (type === 'round_robin' && advanceCount !== null && advanceCount % (config.value as StageConfigs['round_robin']).groups !== 0) {
    return fail('bad_group_advance');
  }
  return ok({
    type, config: config.value, rulesetId: rulesetId as number, gameConfig, campaignPool: pool.value,
    vetoType, chapters, scheduling, advanceCount,
  });
}

/** The chain of stages as a whole (Ruling 16): checked at publish and at
 *  open registration, not on every edit. */
export function checkChain(stages: { type?: StageType; advanceCount: number | null }[], o: { teamCap: number | null; roster: RosterRules }): Checked<null> {
  if (stages.length === 0) return fail('no_stages');
  for (let i = 0; i < stages.length; i++) {
    const t = stages[i].type;
    if (i < stages.length - 1 && (t === 'single_elim' || t === 'double_elim')) return fail('elim_not_last');
    const a = stages[i].advanceCount;
    if (i === stages.length - 1) {
      if (a !== null) return fail('bad_chain');
      continue;
    }
    if (a === null) return fail('bad_chain');
    const before = i > 0 ? stages[i - 1].advanceCount : null;
    if (before !== null && a >= before) return fail('bad_chain');
    if (o.teamCap !== null && a >= o.teamCap) return fail('bad_chain');
  }
  if (o.roster.lock.kind === 'after_round' && o.roster.lock.stage > stages.length) return fail('bad_roster');
  return ok(null);
}

export const EVENT_EDITABLE: ReadonlySet<EventStatus> = new Set<EventStatus>(['draft', 'announced', 'registration']);
export const STAGES_LOCKED: ReadonlySet<EventStatus> = new Set<EventStatus>(['live', 'finished', 'cancelled']);

/** Where an event can be cancelled from. Never a draft: nobody outside
 *  staff has seen it, so it is deleted instead (deleteDraftEvent), and a
 *  cancelled event is public under Past. */
const CANCELLABLE: ReadonlySet<EventStatus> = new Set<EventStatus>(['announced', 'registration', 'checkin', 'live']);

/** The moves made so far: T1a's publish, open registration and cancel,
 *  T1b's open check-in, and T2's going live from registration or check-in
 *  and finishing once live. */
export function nextStatusAllowed(from: EventStatus, to: EventStatus): boolean {
  if (to === 'cancelled') return CANCELLABLE.has(from);
  return (from === 'draft' && to === 'announced') || (from === 'announced' && to === 'registration')
    || (from === 'registration' && to === 'checkin')
    || ((from === 'registration' || from === 'checkin') && to === 'live')
    || (from === 'live' && to === 'finished');
}
