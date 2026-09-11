/** Single source of truth for live event kinds.
 *
 *  Same hazard as src/statKeys.ts, same mitigation. `match_live_events.kind`
 *  is free text, so the plugin emitting `witch_agro` while the web looks for
 *  `witch_aggro` is not a DB error, it is a timeline that is quietly missing
 *  every witch forever. The plugin, the parser and the UI all resolve kinds
 *  through here, and tests/eventKindsParity.test.ts holds the plugin to it.
 *
 *  Events carry TIMING, never TOTALS. The feed rides lossy UDP, so counting
 *  rows here would disagree with match_player_stats and create a second,
 *  wrong source of truth for "how many skeets". */

/** Which side the ACTOR was on when this happened. */
export type EventSide = 'survivor' | 'infected';

export interface EventKindDef {
  kind: string;
  side: EventSide;
  /** Feed verb: "<actor> <verb> <target>". */
  verb: string;
  /** Unit word before a non-zero value, e.g. "for 22". */
  unit?: string;
  /** True when this kind has a target player. */
  hasTarget: boolean;
}

const def = (
  kind: string, side: EventSide, verb: string,
  hasTarget: boolean, unit?: string,
): EventKindDef => ({ kind, side, verb, hasTarget, unit });

export const EVENT_KINDS: readonly EventKindDef[] = [
  // The pin cycle. `pinned` and `cleared` are the pair that makes clear
  // latency computable, which is the single most actionable number the
  // analytics produce and which no counter can express.
  def('pinned', 'infected', 'pinned', true),
  def('cleared', 'survivor', 'cleared', true),

  // Round shape.
  def('incap', 'survivor', 'was incapped by', true),
  def('death', 'survivor', 'was killed by', true),
  def('revive', 'survivor', 'revived', true),

  // Friendly fire carries damage as its value.
  def('ff', 'survivor', 'shot', true, 'for'),

  // Infected pressure.
  def('si_spawn', 'infected', 'spawned as', false),
  def('dp', 'infected', 'pounced', true, 'for'),
  def('boom', 'infected', 'boomed', true),

  // Tank. Control passes in this ruleset, so tank_pass has a target.
  def('tank_spawn', 'infected', 'became the tank', false),
  def('tank_pass', 'infected', 'passed the tank to', true),
  def('tank_death', 'survivor', 'killed the tank', false),

  // Survivor answers.
  def('skeet', 'survivor', 'skeeted', true),

  // Map hazards. Both are blame stats: who woke her up, who set it off.
  def('witch_aggro', 'survivor', 'startled the witch', false),
  def('witch_killed', 'survivor', 'killed the witch', false),
  def('car_alarm', 'survivor', 'set off a car alarm', false),
];

const BY_KIND = new Map(EVENT_KINDS.map((d) => [d.kind, d]));

export function eventKindDef(kind: string): EventKindDef | undefined {
  return BY_KIND.get(kind);
}

export function isKnownEventKind(kind: string): boolean {
  return BY_KIND.has(kind);
}

export function eventKindKeys(): string[] {
  return EVENT_KINDS.map((d) => d.kind);
}
