import type { DB } from './db.js';
import { MATCH_PLAY_DEFAULTS, RULE_RANGES, parseRules, type MatchRules } from './rulesets.js';
import { rulesSummary } from './events/format.js';
import { OPEN_STATES_SQL } from './bookings/rules.js';
import { logAdmin } from './admin/audit.js';

/**
 * The Rulesets desk's reads and every write to the rulesets table after the
 * templates are seeded (src/rulesets.ts seedRulesetTemplates).
 *
 * Each write is one better-sqlite3 transaction that re-reads the row, checks,
 * writes and adds its logAdmin row with the before and after, so the audit
 * row cannot be missing for a write that landed. Bookings and event stages
 * keep their own copy of the rules (bookings.rules_json, event_stages.
 * rules_json), so nothing here ever touches them: an edit applies to the
 * next booking or publish only.
 *
 * PUG is read only: it mirrors the live PUG cfg, and it is the only ruleset
 * that is rated or has penalties. Every other ruleset is written with rated
 * and penalties false whatever is sent. The three templates keep their
 * names and are never archived, because code finds them by name (the
 * booking default 'Casual Scrim', the event default 'Standard Cup') and the
 * seed would add a renamed one back on the next start.
 */

export const RULESET_ERRORS = {
  not_found: { status: 404, text: 'No such ruleset.' },
  read_only: { status: 409, text: 'The PUG ruleset mirrors the live PUG config and cannot be changed here.' },
  template_locked: { status: 409, text: 'A built-in ruleset keeps its name and cannot be archived.' },
  bad_name: { status: 400, text: 'A name is 3 to 40 characters.' },
  name_taken: { status: 409, text: 'Another ruleset already has that name.' },
  bad_rules: { status: 400, text: 'Every rule needs a value.' },
  bad_pause_limit: { status: 400, text: 'Pauses per team is a whole number from 0 to 10, or blank for no limit.' },
  bad_pause_seconds: { status: 400, text: 'Pause length is 30 to 600 seconds, or blank for no limit.' },
  bad_tech_pauses: { status: 400, text: 'Technical pauses is a whole number from 0 to 5.' },
  bad_grace: { status: 400, text: 'No-show grace is 5 to 60 minutes.' },
  bad_choice: { status: 400, text: 'Pick one of the listed options.' },
  bad_tech_seconds: { status: 400, text: 'Technical time is 60 to 1800 seconds per team per game.' },
  bad_reconnect: { status: 400, text: 'Reconnect time is 60 to 3600 seconds per team per game.' },
  bad_subs: { status: 400, text: 'Subs per match is a whole number from 0 to 4.' },
  bad_sub_charge: { status: 400, text: 'An emergency sub costs 0 to 600 seconds of reconnect time.' },
  bad_call_cooldown: { status: 400, text: 'The !admin cooldown is 30 to 600 seconds.' },
  bad_next_game: { status: 400, text: 'The next game follows after 30 to 600 seconds.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type RulesetError = keyof typeof RULESET_ERRORS;
export type RulesetResult<T> = { ok: true; value: T } | { ok: false; error: RulesetError };
const ok = <T>(value: T): RulesetResult<T> => ({ ok: true, value });
const fail = (error: RulesetError): { ok: false; error: RulesetError } => ({ ok: false, error });

/** What the editor may change: everything but rated and penalties. */
export type EditableRules = Omit<MatchRules, 'rated' | 'penalties'>;

export interface RulesetRow {
  id: number; name: string; rules_json: string; template: number; based_on: number | null;
  created_by: string | null; created_at: string; archived_at: string | null;
}

export interface RulesetListItem {
  id: number; name: string; template: boolean; basedOn: string | null; readOnly: boolean; archived: boolean;
  summary: string; rules: MatchRules | null; inUse: { bookings: number; events: number };
}

const BOSSES: readonly MatchRules['bosses'][] = ['random_published', 'fixed', 'voteboss'];
const SIDE_RULES: readonly MatchRules['sideRule'][] = ['higher_seed_chooses', 'non_picker_chooses', 'coin'];
export const NAME_MIN = 3;
export const NAME_MAX = 40;

export const isPug = (r: Pick<RulesetRow, 'template' | 'name'>): boolean => r.template === 1 && r.name === 'PUG';
const whole = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export function getRuleset(db: DB, id: number): RulesetRow | undefined {
  return db.prepare('SELECT * FROM rulesets WHERE id = ?').get(id) as RulesetRow | undefined;
}

function rulesOf(row: RulesetRow): MatchRules | null {
  try { return parseRules(row.rules_json); } catch { return null; }
}

/** Open bookings made under it, and events not finished or cancelled with a stage on it. */
export function rulesetInUse(db: DB, id: number): { bookings: number; events: number } {
  const bookings = (db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE ruleset_id = ? AND state IN ${OPEN_STATES_SQL}`).get(id) as { n: number }).n;
  const events = (db.prepare(
    `SELECT COUNT(DISTINCT e.id) AS n FROM event_stages s JOIN events e ON e.id = s.event_id
     WHERE s.ruleset_id = ? AND e.status NOT IN ('finished', 'cancelled')`,
  ).get(id) as { n: number }).n;
  return { bookings, events };
}

export function rulesetList(db: DB): RulesetListItem[] {
  const rows = db.prepare('SELECT * FROM rulesets ORDER BY archived_at IS NOT NULL, id').all() as RulesetRow[];
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return rows.map((r) => {
    const rules = rulesOf(r);
    return {
      id: r.id, name: r.name, template: r.template === 1, basedOn: r.based_on === null ? null : names.get(r.based_on) ?? null,
      readOnly: isPug(r), archived: r.archived_at !== null, summary: rules ? rulesSummary(rules) : '', rules, inUse: rulesetInUse(db, r.id),
    };
  });
}

/** Trimmed, 3 to 40 characters, no control characters. */
export function readRulesetName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** The editable fields from a request body, checked by hand like parseRules,
 *  each range refused with its own sentence. Blank pause limit or length is
 *  null (no limit), never 0. */
export function readEditableRules(raw: unknown): RulesetResult<EditableRules> {
  if (typeof raw !== 'object' || raw === null) return fail('bad_rules');
  const r = raw as Record<string, unknown>;
  const pause = r.pause as Record<string, unknown> | null | undefined;
  const restartHalf = r.restartHalf as Record<string, unknown> | null | undefined;
  const spectate = r.spectate as Record<string, unknown> | null | undefined;
  if (typeof pause !== 'object' || pause === null || typeof restartHalf !== 'object' || restartHalf === null
    || typeof spectate !== 'object' || spectate === null) return fail('bad_rules');
  if (pause.limit !== null && !whole(pause.limit, 0, 10)) return fail('bad_pause_limit');
  if (pause.seconds !== null && !whole(pause.seconds, 30, 600)) return fail('bad_pause_seconds');
  if (!whole(pause.techPauses, 0, 5)) return fail('bad_tech_pauses');
  if (!whole(r.noShowGraceMinutes, 5, 60)) return fail('bad_grace');
  if (!BOSSES.includes(r.bosses as MatchRules['bosses']) || !SIDE_RULES.includes(r.sideRule as MatchRules['sideRule'])) return fail('bad_choice');
  for (const b of [pause.mutualUnpause, r.teamLock, r.playerMapControl, restartHalf.allowed, restartHalf.lockAfterDamage, spectate.sideLocked]) {
    if (typeof b !== 'boolean') return fail('bad_rules');
  }
  // Plan T3c subs and the plan T5 fields: a body without one reads as the
  // default (updateRuleset fills in the stored value first); one with it is
  // range-checked, each with its own sentence.
  const within = (v: unknown, range: readonly [number, number]) => whole(v, range[0], range[1]);
  if (pause.techSeconds !== undefined && !within(pause.techSeconds, RULE_RANGES.techSeconds)) return fail('bad_tech_seconds');
  const subs = r.subs as Record<string, unknown> | null | undefined;
  if (subs !== undefined && (typeof subs !== 'object' || subs === null || !whole(subs.perMatch, 0, 4))) return fail('bad_subs');
  if (subs && subs.emergency !== undefined && typeof subs.emergency !== 'boolean') return fail('bad_rules');
  if (subs && subs.emergencyChargeSeconds !== undefined && !within(subs.emergencyChargeSeconds, RULE_RANGES.emergencyChargeSeconds)) return fail('bad_sub_charge');
  const field = (key: 'disconnect' | 'staffCall' | 'series', name: string): unknown => {
    const v = r[key];
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[name] : v === undefined ? undefined : null;
  };
  const teamSeconds = field('disconnect', 'teamSeconds');
  if (teamSeconds !== undefined && !within(teamSeconds, RULE_RANGES.teamSeconds)) return fail('bad_reconnect');
  const cooldownSeconds = field('staffCall', 'cooldownSeconds');
  if (cooldownSeconds !== undefined && !within(cooldownSeconds, RULE_RANGES.cooldownSeconds)) return fail('bad_call_cooldown');
  const nextGameSeconds = field('series', 'nextGameSeconds');
  if (nextGameSeconds !== undefined && !within(nextGameSeconds, RULE_RANGES.nextGameSeconds)) return fail('bad_next_game');
  return ok({
    pause: {
      limit: pause.limit as number | null, seconds: pause.seconds as number | null, mutualUnpause: pause.mutualUnpause as boolean, techPauses: pause.techPauses as number,
      techSeconds: (pause.techSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.techSeconds,
    },
    teamLock: r.teamLock as boolean,
    playerMapControl: r.playerMapControl as boolean,
    restartHalf: { allowed: restartHalf.allowed as boolean, lockAfterDamage: (restartHalf.allowed as boolean) && (restartHalf.lockAfterDamage as boolean) },
    noShowGraceMinutes: r.noShowGraceMinutes as number,
    bosses: r.bosses as MatchRules['bosses'],
    sideRule: r.sideRule as MatchRules['sideRule'],
    spectate: { sideLocked: spectate.sideLocked as boolean },
    subs: {
      perMatch: subs ? (subs.perMatch as number) : 2,
      emergency: (subs?.emergency as boolean | undefined) ?? MATCH_PLAY_DEFAULTS.emergency,
      emergencyChargeSeconds: (subs?.emergencyChargeSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.emergencyChargeSeconds,
    },
    disconnect: { teamSeconds: (teamSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.teamSeconds },
    staffCall: { cooldownSeconds: (cooldownSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.cooldownSeconds },
    series: { nextGameSeconds: (nextGameSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.nextGameSeconds },
  });
}

/** A non-PUG ruleset as stored: never rated, never penalties, in MatchRules
 *  field order so the JSON reads the same as the seeded templates. */
export function unratedRules(e: EditableRules): MatchRules {
  return {
    rated: false, pause: e.pause, teamLock: e.teamLock, playerMapControl: e.playerMapControl, restartHalf: e.restartHalf,
    noShowGraceMinutes: e.noShowGraceMinutes, penalties: false, bosses: e.bosses, sideRule: e.sideRule, spectate: e.spectate,
    subs: e.subs, disconnect: e.disconnect, staffCall: e.staffCall, series: e.series,
  };
}

function nameTaken(db: DB, name: string, exceptId: number | null): boolean {
  const key = name.toLowerCase();
  return (db.prepare('SELECT id, name FROM rulesets').all() as { id: number; name: string }[])
    .some((r) => r.id !== exceptId && r.name.toLowerCase() === key);
}

/** A new ruleset copied from an existing one (archived ones too), under a
 *  new unique name. A copy of PUG is unrated and has no penalties. */
export function createRuleset(db: DB, o: { by: string; copyFrom: unknown; name: unknown; now?: Date }): RulesetResult<{ id: number }> {
  const now = o.now ?? new Date();
  return db.transaction((): RulesetResult<{ id: number }> => {
    const source = Number.isInteger(o.copyFrom) ? getRuleset(db, o.copyFrom as number) : undefined;
    if (!source) return fail('not_found');
    const rules = rulesOf(source);
    if (!rules) return fail('bad_rules');
    const name = readRulesetName(o.name);
    if (!name) return fail('bad_name');
    if (nameTaken(db, name, null)) return fail('name_taken');
    const { rated: _r, penalties: _p, ...editable } = rules;
    const json = JSON.stringify(unratedRules(editable));
    const id = Number(db.prepare(
      'INSERT INTO rulesets (name, rules_json, template, based_on, created_by, created_at) VALUES (?, ?, 0, ?, ?, ?)',
    ).run(name, json, source.id, o.by, now.toISOString()).lastInsertRowid);
    logAdmin(db, o.by, 'ruleset_create', id, { copyFrom: { id: source.id, name: source.name }, after: { name, rules: JSON.parse(json) } });
    return ok({ id });
  })();
}

/** A body's missing rule objects and fields filled from the stored rules, so
 *  an editor that does not send them (an older web bundle, or a field the
 *  form leaves out) never resets them to the defaults (plan T3c subs, plan T5). */
function mergeStored(body: unknown, stored: MatchRules | null): unknown {
  if (typeof body !== 'object' || body === null || stored === null) return body;
  const b = { ...(body as Record<string, unknown>) };
  for (const key of ['subs', 'disconnect', 'staffCall', 'series'] as const) if (!(key in b)) b[key] = stored[key];
  if (typeof b.subs === 'object' && b.subs !== null) b.subs = { emergency: stored.subs.emergency, emergencyChargeSeconds: stored.subs.emergencyChargeSeconds, ...(b.subs as object) };
  if (typeof b.pause === 'object' && b.pause !== null && !('techSeconds' in (b.pause as object))) b.pause = { ...(b.pause as object), techSeconds: stored.pause.techSeconds };
  return b;
}

/** Change a ruleset's name and rules. PUG is refused; a template keeps its name. */
export function updateRuleset(db: DB, o: { by: string; id: number; name: unknown; rules: unknown }): RulesetResult<null> {
  return db.transaction((): RulesetResult<null> => {
    const row = getRuleset(db, o.id);
    if (!row) return fail('not_found');
    if (isPug(row)) return fail('read_only');
    const name = readRulesetName(o.name);
    if (!name) return fail('bad_name');
    if (row.template === 1 && name !== row.name) return fail('template_locked');
    if (nameTaken(db, name, row.id)) return fail('name_taken');
    // A body without a field keeps the ruleset's stored value (plan T3c subs, plan T5).
    const body = mergeStored(o.rules, rulesOf(row));
    const edited = readEditableRules(body);
    if (!edited.ok) return edited;
    const json = JSON.stringify(unratedRules(edited.value));
    db.prepare('UPDATE rulesets SET name = ?, rules_json = ? WHERE id = ?').run(name, json, row.id);
    logAdmin(db, o.by, 'ruleset_update', row.id, {
      before: { name: row.name, rules: rulesOf(row) }, after: { name, rules: JSON.parse(json) },
    });
    return ok(null);
  })();
}

/** Archive (hide from every picker) or bring back. A booking or stage that
 *  already uses it keeps its copy; a draft stage on it is refused at publish. */
export function setRulesetArchived(db: DB, o: { by: string; id: number; archived: boolean; now?: Date }): RulesetResult<null> {
  const now = o.now ?? new Date();
  return db.transaction((): RulesetResult<null> => {
    const row = getRuleset(db, o.id);
    if (!row) return fail('not_found');
    if (row.template === 1) return fail('template_locked');
    const archivedAt = o.archived ? row.archived_at ?? now.toISOString() : null;
    db.prepare('UPDATE rulesets SET archived_at = ? WHERE id = ?').run(archivedAt, row.id);
    logAdmin(db, o.by, o.archived ? 'ruleset_archive' : 'ruleset_unarchive', row.id, {
      name: row.name, before: { archivedAt: row.archived_at }, after: { archivedAt },
    });
    return ok(null);
  })();
}

/** The live rulesets a picker offers, each with its one-line summary. PUG is
 *  left out: it is for PUGs, not bookings or events, and is not offered as a
 *  source to pick (ruleset_store Ruling: PUG stays out of every picker). */
export function rulesetOptions(db: DB): { id: number; name: string; summary: string }[] {
  const rows = db.prepare('SELECT * FROM rulesets WHERE archived_at IS NULL ORDER BY id').all() as RulesetRow[];
  return rows.filter((r) => !isPug(r)).map((r) => {
    const rules = rulesOf(r);
    return { id: r.id, name: r.name, summary: rules ? rulesSummary(rules) : '' };
  });
}
