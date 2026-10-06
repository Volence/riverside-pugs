import type { DB } from './db.js';
import type { MatchKind } from './matchKinds.js';

/**
 * Named match-rule profiles (spec: foundation section 1, Rulesets).
 *
 * A match copies the ruleset it was played under into matches.rules_json at
 * creation, so editing a named ruleset later never rewrites history for a
 * match already played. TEMPLATES are the three starting profiles, seeded
 * into the rulesets table once by seedRulesetTemplates; staff can add more
 * from the admin panel later, but this module only knows about the shape and
 * the three built-ins.
 */
export interface MatchRules {
  rated: boolean;
  pause: { limit: number | null; seconds: number | null; mutualUnpause: boolean; techPauses: number };
  teamLock: boolean;
  playerMapControl: boolean;
  restartHalf: { allowed: boolean; lockAfterDamage: boolean };
  noShowGraceMinutes: number;
  penalties: boolean;
  bosses: 'random_published' | 'fixed' | 'voteboss';
  sideRule: 'higher_seed_chooses' | 'non_picker_chooses' | 'coin';
  spectate: { sideLocked: boolean };
  /** Tournaments plan T3c: substitutions a side may make per match (in-game !sub between chapters). */
  subs: { perMatch: number };
}

const BOSSES: MatchRules['bosses'][] = ['random_published', 'fixed', 'voteboss'];
const SIDE_RULES: MatchRules['sideRule'][] = ['higher_seed_chooses', 'non_picker_chooses', 'coin'];

// PUG mirrors today's live cfg exactly: sm_pug_pause_limit (plugin/pug-pause.inc)
// defaults to 3, sm_pug_pause_seconds defaults to 120, and neither is overridden
// by overrides/left4dead/cfg/pug_match.cfg or rotoblin_pug_4v4.cfg (checked
// 2026-09-30). noShowGraceMinutes 10 is DEFAULT_SETTINGS.noshow_minutes in
// src/db.ts, the live no-show deadline every PUG uses today.
export const TEMPLATES: Record<'PUG' | 'Standard Cup' | 'Casual Scrim', MatchRules> = {
  PUG: {
    rated: true,
    pause: { limit: 3, seconds: 120, mutualUnpause: false, techPauses: 0 },
    teamLock: true,
    playerMapControl: false,
    restartHalf: { allowed: false, lockAfterDamage: false },
    noShowGraceMinutes: 10,
    penalties: true,
    bosses: 'random_published',
    sideRule: 'coin',
    spectate: { sideLocked: false },
    subs: { perMatch: 2 },
  },
  'Standard Cup': {
    rated: false,
    pause: { limit: 3, seconds: 120, mutualUnpause: true, techPauses: 2 },
    teamLock: true,
    playerMapControl: false,
    restartHalf: { allowed: false, lockAfterDamage: false },
    noShowGraceMinutes: 15,
    penalties: false,
    bosses: 'random_published',
    sideRule: 'higher_seed_chooses',
    spectate: { sideLocked: true },
    subs: { perMatch: 2 },
  },
  'Casual Scrim': {
    rated: false,
    pause: { limit: null, seconds: null, mutualUnpause: true, techPauses: 0 },
    teamLock: true,
    playerMapControl: true,
    restartHalf: { allowed: true, lockAfterDamage: false },
    noShowGraceMinutes: 15,
    penalties: false,
    bosses: 'random_published',
    sideRule: 'non_picker_chooses',
    spectate: { sideLocked: false },
    subs: { perMatch: 2 },
  },
};

function fail(field: string): never {
  throw new Error(`invalid rules: ${field}`);
}

function numberOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number') fail(field);
  return value as number;
}

/**
 * Parse and validate a rules_json blob into a MatchRules. Every field is
 * checked by hand (no schema library elsewhere in this codebase); a bad or
 * missing field throws 'invalid rules: <dotted field>' naming the field.
 */
export function parseRules(json: string): MatchRules {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('invalid rules: json');
  }
  if (typeof raw !== 'object' || raw === null) fail('root');
  const r = raw as Record<string, unknown>;

  if (typeof r.rated !== 'boolean') fail('rated');

  if (typeof r.pause !== 'object' || r.pause === null) fail('pause');
  const pause = r.pause as Record<string, unknown>;
  const pauseLimit = numberOrNull(pause.limit, 'pause.limit');
  const pauseSeconds = numberOrNull(pause.seconds, 'pause.seconds');
  if (typeof pause.mutualUnpause !== 'boolean') fail('pause.mutualUnpause');
  if (typeof pause.techPauses !== 'number') fail('pause.techPauses');

  if (typeof r.teamLock !== 'boolean') fail('teamLock');
  if (typeof r.playerMapControl !== 'boolean') fail('playerMapControl');

  if (typeof r.restartHalf !== 'object' || r.restartHalf === null) fail('restartHalf');
  const restartHalf = r.restartHalf as Record<string, unknown>;
  if (typeof restartHalf.allowed !== 'boolean') fail('restartHalf.allowed');
  if (typeof restartHalf.lockAfterDamage !== 'boolean') fail('restartHalf.lockAfterDamage');

  if (typeof r.noShowGraceMinutes !== 'number') fail('noShowGraceMinutes');
  if (typeof r.penalties !== 'boolean') fail('penalties');

  if (typeof r.bosses !== 'string' || !BOSSES.includes(r.bosses as MatchRules['bosses'])) fail('bosses');
  if (typeof r.sideRule !== 'string' || !SIDE_RULES.includes(r.sideRule as MatchRules['sideRule'])) fail('sideRule');

  if (typeof r.spectate !== 'object' || r.spectate === null) fail('spectate');
  const spectate = r.spectate as Record<string, unknown>;
  if (typeof spectate.sideLocked !== 'boolean') fail('spectate.sideLocked');

  // Tournaments plan T3c. Absent in every ruleset and stage snapshot saved
  // before the field existed: read as the default rather than failing them.
  let subsPerMatch = 2;
  if (r.subs !== undefined) {
    if (typeof r.subs !== 'object' || r.subs === null) fail('subs');
    const subs = r.subs as Record<string, unknown>;
    if (!Number.isInteger(subs.perMatch) || (subs.perMatch as number) < 0 || (subs.perMatch as number) > 4) fail('subs.perMatch');
    subsPerMatch = subs.perMatch as number;
  }

  return {
    rated: r.rated,
    pause: { limit: pauseLimit, seconds: pauseSeconds, mutualUnpause: pause.mutualUnpause, techPauses: pause.techPauses },
    teamLock: r.teamLock,
    playerMapControl: r.playerMapControl,
    restartHalf: { allowed: restartHalf.allowed, lockAfterDamage: restartHalf.lockAfterDamage },
    noShowGraceMinutes: r.noShowGraceMinutes,
    penalties: r.penalties,
    bosses: r.bosses as MatchRules['bosses'],
    sideRule: r.sideRule as MatchRules['sideRule'],
    spectate: { sideLocked: spectate.sideLocked },
    subs: { perMatch: subsPerMatch },
  };
}

// Second rated guard (spec): whatever a ruleset says, only a pug match ever
// scores SR. A scrim or tournament match copies a ruleset's other fields
// verbatim but is always unrated.
export function rulesForKind(kind: MatchKind, rules: MatchRules): MatchRules {
  return { ...rules, rated: kind === 'pug' ? rules.rated : false };
}

export function seedRulesetTemplates(db: DB): void {
  const insert = db.prepare('INSERT OR IGNORE INTO rulesets (name, rules_json, template) VALUES (?, ?, 1)');
  for (const [name, rules] of Object.entries(TEMPLATES)) {
    insert.run(name, JSON.stringify(rules));
  }
}
