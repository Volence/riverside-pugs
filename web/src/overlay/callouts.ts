import { CALLOUT_MS, type CastEvent } from '../../../src/cast/types';

/**
 * Highlight cards (caster studio): what each live event's card says, and
 * auto-fire, the overlay's own queue that turns new events into cards when
 * the producer has switched it on. Shared by the producer panel (its
 * Highlights list) and every overlay.
 */

export interface CardText { title: string; text: string }

/** Live events worth a callout, with the card title each gets. */
export const CALLOUT_KINDS: Record<string, (e: CastEvent) => CardText> = {
  skeet: (e) => skeetCallout(e),
  dp: (e) => ({ title: 'DP', text: `${e.actor} pounced ${e.target ?? 'a survivor'} for ${e.value}` }),
  tank_death: (e) => ({ title: 'Tank down', text: `${e.actor} finished the tank` }),
  tank_spawn: (e) => ({ title: 'Tank', text: `${e.actor} becomes tank` }),
  witch_killed: (e) => ({ title: 'Witch down', text: `${e.actor} killed the witch` }),
  witch_aggro: (e) => ({ title: 'Witch!', text: `${e.actor} startled the witch` }),
  death: (e) => ({ title: 'Survivor down', text: `${e.actor} was killed by ${e.target ?? 'the infected'}` }),
  incap: (e) => ({ title: 'Incapped', text: `${e.actor} went down to ${e.target ?? 'the infected'}` }),
  boom: (e) => bileCallout(e),
  car_alarm: (e) => ({ title: 'Car alarm', text: `${e.actor} set off a car alarm` }),
};

/** One card per skeet run (the feed folds a run into its newest skeet):
 *  Skeet, then Double / Triple / Quad skeet as the same player keeps going,
 *  counted by the Discord streak rules. */
const STREAK_TITLES = ['Skeet', 'Double skeet', 'Triple skeet', 'Quad skeet'];
const BILE_TITLES = ['Boomed', 'Double bile', 'Triple bile', 'Quad bile'];

const listOf = (names: string[]): string =>
  names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** One card per bile: every survivor one boomer caught (a vomit or a pop). */
export function bileCallout(e: CastEvent): CardText {
  const n = e.streak?.count ?? 1;
  const targets = e.streak?.targets.length ? e.streak.targets : e.target ? [e.target] : [];
  return { title: BILE_TITLES[n - 1] ?? 'Quad bile', text: `${e.actor} boomed ${targets.length ? listOf(targets) : 'the survivors'}` };
}
export function skeetCallout(e: CastEvent): CardText {
  const n = e.streak?.count ?? 1;
  const title = STREAK_TITLES[n - 1] ?? `${n}x skeet`;
  const targets = e.streak?.targets.length ? e.streak.targets : e.target ? [e.target] : [];
  const who = targets.length === 0 ? (n > 1 ? `${n} hunters` : 'a hunter')
    : targets.length === 1 ? targets[0] : `${targets.slice(0, -1).join(', ')} and ${targets[targets.length - 1]}`;
  return { title, text: `${e.actor} skeeted ${who}` };
}

export function sideOfEvent(kind: string): 'survivor' | 'infected' {
  return ['skeet', 'tank_death', 'witch_killed', 'witch_aggro', 'death', 'incap', 'car_alarm'].includes(kind) ? 'survivor' : 'infected';
}

/* ---------- auto-fire ---------- */

/** Kinds whose list entry grows into a run (Double skeet, Triple bile): the
 *  card waits this long after the first sighting, so a run goes up once at
 *  its final count instead of Skeet, then Double, then Triple. It matches
 *  the streak window (src/skeetStreaks.ts). */
export const RUN_HOLD_MS = 5000;
const RUN_KINDS = new Set(['skeet', 'boom']);
/** A card still waiting this long after it became ready is old news. */
export const STALE_MS = 30_000;

export interface AutoCard extends CardText { team: 'a' | 'b' | null; key: string; at: number }

interface Pending extends CardText { team: 'a' | 'b' | null; key: string; actor: string; kind: string; readyAt: number }

export interface AutoQueue {
  /** The match this queue follows; a new match starts a fresh queue. */
  matchId: number | null;
  /** Highest event seq already taken in, or null before the first feed:
   *  whatever is in the list when an overlay loads is history, never fired. */
  seen: number | null;
  pending: Pending[];
  showing: AutoCard | null;
}

export const emptyQueue = (): AutoQueue => ({ matchId: null, seen: null, pending: [], showing: null });

/**
 * One step of auto-fire, run on every feed and clock tick. Takes in events
 * newer than `seen` whose kind is switched on, holds run kinds for
 * RUN_HOLD_MS (a newer entry of the same player's run replaces the held
 * one), and shows one card at a time for CALLOUT_MS. While the producer's
 * own card is up (`manualUntil`) nothing new goes up and the queue waits.
 */
export function stepAuto(
  q: AutoQueue,
  input: { matchId: number | null; events: CastEvent[]; on: boolean; kinds: string[]; manualUntil: number; now: number },
): AutoQueue {
  const { events, now } = input;
  if (!input.on || input.matchId === null) return q.matchId === null && q.seen === null ? q : emptyQueue();
  let next: AutoQueue = q.matchId === input.matchId ? q : { ...emptyQueue(), matchId: input.matchId };
  const top = events.reduce((m, e) => Math.max(m, e.seq), -1);
  if (next.seen === null) {
    next = { ...next, seen: top };
  } else if (top > next.seen) {
    const kinds = new Set(input.kinds);
    let pending = next.pending;
    // Oldest first, so the queue plays in the order things happened.
    for (const e of [...events].reverse()) {
      if (e.seq <= next.seen || !kinds.has(e.kind)) continue;
      const make = CALLOUT_KINDS[e.kind];
      if (!make) continue;
      const card = { ...make(e), team: e.actorTeam, key: `auto:${e.seq}`, actor: e.actor, kind: e.kind };
      if (RUN_KINDS.has(e.kind)) {
        // The list folds a run into its newest event, so a held card of
        // the same player's run is replaced, keeping its place and timer.
        const i = pending.findIndex((p) => p.kind === e.kind && p.actor === e.actor && p.readyAt > now);
        if (i >= 0) {
          pending = pending.map((p, j) => (j === i ? { ...card, readyAt: p.readyAt } : p));
          continue;
        }
        pending = [...pending, { ...card, readyAt: now + RUN_HOLD_MS }];
      } else {
        pending = [...pending, { ...card, readyAt: now }];
      }
    }
    next = { ...next, seen: top, pending };
  }
  let { showing, pending } = next;
  if (showing && now - showing.at >= CALLOUT_MS) showing = null;
  pending = pending.filter((p) => now - p.readyAt < STALE_MS);
  if (!showing && now >= input.manualUntil) {
    const i = pending.findIndex((p) => p.readyAt <= now);
    if (i >= 0) {
      const p = pending[i]!;
      showing = { title: p.title, text: p.text, team: p.team, key: p.key, at: now };
      pending = pending.filter((_, j) => j !== i);
    }
  }
  if (showing === next.showing && pending.length === next.pending.length) return next;
  return { ...next, showing, pending };
}
