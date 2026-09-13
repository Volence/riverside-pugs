import { ZOMBIE_CLASSES } from '../../../src/replayFormat';

/** Which side of the event the plugin puts in `actor`.
 *
 *  Most kinds put the doer first: "volence pounced tino". `death` and `incap`
 *  put the survivor it happened to first so the live feed reads "tino died
 *  to volence", which is why a player's role in an event is decided per kind
 *  and never by which field their id is in. */
export type ActorRole = 'doer' | 'victim';

export interface EventKind {
  /** Between actor and target: "volence pounced tino". */
  verb: string;
  /** Between verb and target when there is one: "died TO volence". */
  link?: string;
  /** Between target and value when the value is meaningful: "FOR 22". */
  unit?: string;
  actorIs: ActorRole;
  /** Group headings in the bookmark rail, from the selected player's side. */
  did: string;
  suffered: string;
}

/**
 * How each kind reads. Adding a kind here is the only frontend change needed
 * when the plugin starts emitting a new one; an unknown kind still renders
 * with its slug as the verb.
 */
export const EVENT_KINDS: Record<string, EventKind> = {
  dp:           { verb: 'pounced', unit: 'for', actorIs: 'doer', did: 'Pounces', suffered: 'Got pounced' },
  skeet:        { verb: 'skeeted', actorIs: 'doer', did: 'Skeets', suffered: 'Got skeeted' },
  boom:         { verb: 'boomed', actorIs: 'doer', did: 'Booms', suffered: 'Got boomed' },
  pinned:       { verb: 'pinned', actorIs: 'doer', did: 'Pins', suffered: 'Got pinned' },
  cleared:      { verb: 'cleared', actorIs: 'doer', did: 'Clears', suffered: 'Got cleared' },
  ff:           { verb: 'friendly fired', unit: 'for', actorIs: 'doer', did: 'FF dealt', suffered: 'FF taken' },
  revive:       { verb: 'revived', actorIs: 'doer', did: 'Revives', suffered: 'Got revived' },
  death:        { verb: 'died', link: 'to', actorIs: 'victim', did: 'Kills', suffered: 'Deaths' },
  incap:        { verb: 'went down', link: 'to', actorIs: 'victim', did: 'Incaps dealt', suffered: 'Incaps' },
  si_spawn:     { verb: 'spawned as', actorIs: 'doer', did: 'Spawns', suffered: 'Spawns' },
  tank_spawn:   { verb: 'became the tank', actorIs: 'doer', did: 'Tank', suffered: 'Tank' },
  tank_death:   { verb: 'killed the tank', actorIs: 'doer', did: 'Tank kills', suffered: 'Tank kills' },
  tank_take:    { verb: 'took the tank', actorIs: 'doer', did: 'Tank', suffered: 'Tank' },
  tank_give:    { verb: 'gave up the tank', actorIs: 'doer', did: 'Tank', suffered: 'Tank' },
  witch_aggro:  { verb: 'startled the witch', actorIs: 'doer', did: 'Witch', suffered: 'Witch' },
  witch_killed: { verb: 'killed the witch', actorIs: 'doer', did: 'Witch kills', suffered: 'Witch kills' },
  car_alarm:    { verb: 'set off a car alarm', actorIs: 'doer', did: 'Car alarms', suffered: 'Car alarms' },
};

/** The fields a sentence needs. Both the timeline entry and the live feed's
 *  event satisfy it structurally. */
export interface EventLike {
  event: string;
  actor: string;
  target: string | null;
  value: number;
}

/** The value as words, or null when it carries nothing worth saying.
 *
 *  `si_spawn` is the one kind whose value is a code rather than a quantity:
 *  it is the `m_zombieClass` index, and zero is a real (if unnamed) class
 *  rather than "no value". */
export function valueText(event: string, value: number): string | null {
  if (event === 'si_spawn') return ZOMBIE_CLASSES[value] || `class ${value}`;
  if (value <= 0) return null;
  const unit = EVENT_KINDS[event]?.unit;
  return unit ? `${unit} ${value}` : String(value);
}

/** Everything after the actor: "pounced tino for 22". */
export function eventPhrase(e: EventLike, nameOf: (id: string) => string): string {
  const k = EVENT_KINDS[e.event];
  const parts = [k?.verb ?? e.event];
  if (e.target) {
    if (k?.link) parts.push(k.link);
    parts.push(nameOf(e.target));
  }
  const v = valueText(e.event, e.value);
  if (v) parts.push(v);
  return parts.join(' ');
}

export function eventSentence(e: EventLike, nameOf: (id: string) => string): string {
  return `${nameOf(e.actor)} ${eventPhrase(e, nameOf)}`;
}

export type Role = 'did' | 'suffered';

/** Which side of the event a player was on, or null if they were not in it. */
export function roleOf(e: EventLike, steamid: string): Role | null {
  const actorIs = EVENT_KINDS[e.event]?.actorIs ?? 'doer';
  if (e.actor === steamid) return actorIs === 'doer' ? 'did' : 'suffered';
  if (e.target === steamid) return actorIs === 'doer' ? 'suffered' : 'did';
  return null;
}

export function groupLabel(event: string, role: Role): string {
  const k = EVENT_KINDS[event];
  if (!k) return event;
  return role === 'did' ? k.did : k.suffered;
}
