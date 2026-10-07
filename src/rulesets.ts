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
  /** limit and seconds are the tactical pauses; techPauses and techSeconds the
   *  technical ones (plan T5 Rulings 4 to 6). A tournament box counts all of
   *  them per game; a PUG box per campaign, which is the same thing. */
  pause: { limit: number | null; seconds: number | null; mutualUnpause: boolean; techPauses: number; techSeconds: number };
  teamLock: boolean;
  playerMapControl: boolean;
  restartHalf: { allowed: boolean; lockAfterDamage: boolean };
  noShowGraceMinutes: number;
  penalties: boolean;
  bosses: 'random_published' | 'fixed' | 'voteboss';
  sideRule: 'higher_seed_chooses' | 'non_picker_chooses' | 'coin';
  spectate: { sideLocked: boolean };
  /** Tournaments plan T3c: substitutions a side may make per match (in-game
   *  !sub between chapters); plan T5: whether one may come in mid-chapter
   *  for a disconnected player, and what that costs the team's reconnect time. */
  subs: { perMatch: number; emergency: boolean; emergencyChargeSeconds: number };
  /** Plan T5, tournament boxes only: reconnect time per team per game. */
  disconnect: { teamSeconds: number };
  /** Plan T5, tournament boxes only: seconds between two !admin calls of one player. */
  staffCall: { cooldownSeconds: number };
  /** Plan T5: seconds between two games of a series. Plan T6: carryScore
   *  starts game 2 of a best of 2 with game 1's totals in the box's tally. */
  series: { nextGameSeconds: number; carryScore: boolean };
}

/** Plan T5 Ruling 3: what a ruleset or stage snapshot saved before these
 *  fields reads as, and what every template carries. */
export const MATCH_PLAY_DEFAULTS = {
  techSeconds: 300, teamSeconds: 600, emergency: true, emergencyChargeSeconds: 0, cooldownSeconds: 180, nextGameSeconds: 60, carryScore: false,
} as const;
/** Inclusive ranges, shared by parseRules and the editor (rulesetStore.ts). */
export const RULE_RANGES = {
  techPauses: [0, 5], techSeconds: [60, 1800], teamSeconds: [60, 3600], emergencyChargeSeconds: [0, 600], cooldownSeconds: [30, 600], nextGameSeconds: [30, 600],
} as const satisfies Record<string, readonly [number, number]>;

const BOSSES: MatchRules['bosses'][] = ['random_published', 'fixed', 'voteboss'];
const SIDE_RULES: MatchRules['sideRule'][] = ['higher_seed_chooses', 'non_picker_chooses', 'coin'];

// PUG mirrors today's live cfg exactly: sm_pug_pause_limit (plugin/pug-pause.inc)
// defaults to 3, sm_pug_pause_seconds defaults to 120, and neither is overridden
// by overrides/left4dead/cfg/pug_match.cfg or rotoblin_pug_4v4.cfg (checked
// 2026-09-30). noShowGraceMinutes 10 is DEFAULT_SETTINGS.noshow_minutes in
// src/db.ts, the live no-show deadline every PUG uses today.
// Plan T5: the match-play defaults below act only on a tournament box
// (sm_pug_tournament 1); a PUG box never receives them.
export const TEMPLATES: Record<'PUG' | 'Standard Cup' | 'Casual Scrim', MatchRules> = {
  PUG: {
    rated: true,
    pause: { limit: 3, seconds: 120, mutualUnpause: false, techPauses: 0, techSeconds: 300 },
    teamLock: true,
    playerMapControl: false,
    restartHalf: { allowed: false, lockAfterDamage: false },
    noShowGraceMinutes: 10,
    penalties: true,
    bosses: 'random_published',
    sideRule: 'coin',
    spectate: { sideLocked: false },
    subs: { perMatch: 2, emergency: true, emergencyChargeSeconds: 0 },
    disconnect: { teamSeconds: 600 },
    staffCall: { cooldownSeconds: 180 },
    series: { nextGameSeconds: 60, carryScore: false },
  },
  'Standard Cup': {
    rated: false,
    pause: { limit: 3, seconds: 120, mutualUnpause: true, techPauses: 2, techSeconds: 300 },
    teamLock: true,
    playerMapControl: false,
    restartHalf: { allowed: false, lockAfterDamage: false },
    noShowGraceMinutes: 15,
    penalties: false,
    bosses: 'random_published',
    sideRule: 'higher_seed_chooses',
    spectate: { sideLocked: true },
    subs: { perMatch: 2, emergency: true, emergencyChargeSeconds: 0 },
    disconnect: { teamSeconds: 600 },
    staffCall: { cooldownSeconds: 180 },
    series: { nextGameSeconds: 60, carryScore: false },
  },
  'Casual Scrim': {
    rated: false,
    pause: { limit: null, seconds: null, mutualUnpause: true, techPauses: 0, techSeconds: 300 },
    teamLock: true,
    playerMapControl: true,
    restartHalf: { allowed: true, lockAfterDamage: false },
    noShowGraceMinutes: 15,
    penalties: false,
    bosses: 'random_published',
    sideRule: 'non_picker_chooses',
    spectate: { sideLocked: false },
    subs: { perMatch: 2, emergency: true, emergencyChargeSeconds: 0 },
    disconnect: { teamSeconds: 600 },
    staffCall: { cooldownSeconds: 180 },
    series: { nextGameSeconds: 60, carryScore: false },
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
  const inRange = (v: unknown, range: readonly [number, number]): v is number => Number.isInteger(v) && (v as number) >= range[0] && (v as number) <= range[1];
  // The editor's limit (rulesetStore.ts); the plugin cvar would clamp anything past it.
  if (!inRange(pause.techPauses, RULE_RANGES.techPauses)) fail('pause.techPauses');
  // Plan T5: absent in every ruleset and snapshot saved before the field.
  if (pause.techSeconds !== undefined && !inRange(pause.techSeconds, RULE_RANGES.techSeconds)) fail('pause.techSeconds');

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

  // Tournaments plan T3c, extended by plan T5. Absent in every ruleset and
  // stage snapshot saved before the field: read as the default.
  let subs: MatchRules['subs'] = { perMatch: 2, emergency: MATCH_PLAY_DEFAULTS.emergency, emergencyChargeSeconds: MATCH_PLAY_DEFAULTS.emergencyChargeSeconds };
  if (r.subs !== undefined) {
    if (typeof r.subs !== 'object' || r.subs === null) fail('subs');
    const s = r.subs as Record<string, unknown>;
    if (!Number.isInteger(s.perMatch) || (s.perMatch as number) < 0 || (s.perMatch as number) > 4) fail('subs.perMatch');
    if (s.emergency !== undefined && typeof s.emergency !== 'boolean') fail('subs.emergency');
    if (s.emergencyChargeSeconds !== undefined && !inRange(s.emergencyChargeSeconds, RULE_RANGES.emergencyChargeSeconds)) fail('subs.emergencyChargeSeconds');
    subs = {
      perMatch: s.perMatch as number,
      emergency: (s.emergency as boolean | undefined) ?? MATCH_PLAY_DEFAULTS.emergency,
      emergencyChargeSeconds: (s.emergencyChargeSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.emergencyChargeSeconds,
    };
  }
  /** One plan T5 object of a single whole-number field: absent reads as the default. */
  const one = (key: 'disconnect' | 'staffCall', field: string, range: readonly [number, number], fallback: number): number => {
    const v = r[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'object' || v === null) fail(key);
    const n = (v as Record<string, unknown>)[field];
    if (!inRange(n, range)) fail(`${key}.${field}`);
    return n as number;
  };
  const teamSeconds = one('disconnect', 'teamSeconds', RULE_RANGES.teamSeconds, MATCH_PLAY_DEFAULTS.teamSeconds);
  const cooldownSeconds = one('staffCall', 'cooldownSeconds', RULE_RANGES.cooldownSeconds, MATCH_PLAY_DEFAULTS.cooldownSeconds);
  let series: MatchRules['series'] = { nextGameSeconds: MATCH_PLAY_DEFAULTS.nextGameSeconds, carryScore: MATCH_PLAY_DEFAULTS.carryScore };
  if (r.series !== undefined) {
    if (typeof r.series !== 'object' || r.series === null) fail('series');
    const s = r.series as Record<string, unknown>;
    if (!inRange(s.nextGameSeconds, RULE_RANGES.nextGameSeconds)) fail('series.nextGameSeconds');
    if (s.carryScore !== undefined && typeof s.carryScore !== 'boolean') fail('series.carryScore');
    series = { nextGameSeconds: s.nextGameSeconds as number, carryScore: (s.carryScore as boolean | undefined) ?? MATCH_PLAY_DEFAULTS.carryScore };
  }

  return {
    rated: r.rated,
    pause: {
      limit: pauseLimit, seconds: pauseSeconds, mutualUnpause: pause.mutualUnpause, techPauses: pause.techPauses,
      techSeconds: (pause.techSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.techSeconds,
    },
    teamLock: r.teamLock,
    playerMapControl: r.playerMapControl,
    restartHalf: { allowed: restartHalf.allowed, lockAfterDamage: restartHalf.lockAfterDamage },
    noShowGraceMinutes: r.noShowGraceMinutes,
    penalties: r.penalties,
    bosses: r.bosses as MatchRules['bosses'],
    sideRule: r.sideRule as MatchRules['sideRule'],
    spectate: { sideLocked: spectate.sideLocked },
    subs,
    disconnect: { teamSeconds },
    staffCall: { cooldownSeconds },
    series,
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
