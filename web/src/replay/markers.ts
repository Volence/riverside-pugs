import type { Frame } from '../../../src/replayFormat';
import { STATE } from '../../../src/replayFormat';
import { bracket, interpolatePlayers } from './interpolate';
import { roleOf } from './eventText';
import type { TimelineEntry, TimelineEvent } from './timeline';

export const MARKER_COLORS = {
  boom: '#a85cf0', red: '#de4e40', white: '#f2f2f2', green: '#7aa65f', grey: '#c9c9c9', gold: '#e0b654',
} as const;

export interface MarkerKind {
  kind: string;
  letter: string;
  color: string;
  label: string;
  /** Part of "All events". ff and revive are not: an FF tag on every tick is
   *  noise, and both are there when asked for by name. */
  inAll: boolean;
}

/** Kinds with a place on the map. Spawns and tank hand-offs have none. */
export const MARKER_KINDS: readonly MarkerKind[] = [
  { kind: 'boom', letter: 'B', color: MARKER_COLORS.boom, label: 'Boom', inAll: true },
  { kind: 'dp', letter: 'P', color: MARKER_COLORS.red, label: 'Pounce', inAll: true },
  { kind: 'skeet', letter: 'S', color: MARKER_COLORS.white, label: 'Skeet', inAll: true },
  { kind: 'cleared', letter: 'C', color: MARKER_COLORS.white, label: 'Clear', inAll: true },
  { kind: 'incap', letter: 'X', color: MARKER_COLORS.red, label: 'Incap', inAll: true },
  { kind: 'death', letter: '†', color: MARKER_COLORS.grey, label: 'Death', inAll: true },
  { kind: 'pinned', letter: 'T', color: MARKER_COLORS.green, label: 'Pin', inAll: true },
  { kind: 'tank_death', letter: 'K', color: MARKER_COLORS.white, label: 'Tank kill', inAll: true },
  { kind: 'witch_aggro', letter: 'W', color: MARKER_COLORS.white, label: 'Witch startled', inAll: true },
  { kind: 'witch_killed', letter: 'W', color: MARKER_COLORS.white, label: 'Witch killed', inAll: true },
  { kind: 'car_alarm', letter: 'A', color: MARKER_COLORS.gold, label: 'Car alarm', inAll: true },
  { kind: 'ff', letter: 'F', color: MARKER_COLORS.red, label: 'Friendly fire', inAll: false },
  { kind: 'revive', letter: 'R', color: MARKER_COLORS.green, label: 'Revive', inAll: false },
];

const BY_KIND = new Map(MARKER_KINDS.map((k) => [k.kind, k]));

export function markerKind(kind: string): MarkerKind | null {
  return BY_KIND.get(kind) ?? null;
}

/** The kinds this timeline actually has, with counts, in table order: what
 *  the Show select lists. */
export function markerKindsPresent(timeline: TimelineEntry[]): { kind: MarkerKind; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of timeline) {
    if (e.kind !== 'event' || !BY_KIND.has(e.event)) continue;
    counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
  }
  return MARKER_KINDS.filter((k) => counts.has(k.kind)).map((k) => ({ kind: k, count: counts.get(k.kind)! }));
}

/**
 * The events to tag on the map, in round order.
 *
 * `selected` follows tickEntries' contract: null is everyone, '' is an
 * unrostered slot and matches nothing, a SteamID64 matches events it was
 * actor or target of.
 */
export function markerEntries(
  timeline: TimelineEntry[], showKind: string, selected: string | null,
): TimelineEvent[] {
  if (selected === '') return [];
  const out: TimelineEvent[] = [];
  for (const e of timeline) {
    if (e.kind !== 'event') continue;
    const k = BY_KIND.get(e.event);
    if (!k) continue;
    if (showKind === 'all' ? !k.inAll : e.event !== showKind) continue;
    if (selected !== null && roleOf(e, selected) === null) continue;
    out.push(e);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export interface WorldPos { x: number; y: number; z: number }

/**
 * Where an event happened: the target's position at that moment, else the
 * actor's, interpolated between the two frames around the event time. Null
 * when neither resolves to an occupied slot, in which case the rail still
 * shows the event and the map does not.
 */
export function eventPosition(frames: Frame[], slots: string[], e: TimelineEvent): WorldPos | null {
  const pair = bracket(frames, e.tMs);
  if (!pair) return null;
  const players = interpolatePlayers(pair.a, pair.b, pair.f);
  for (const id of [e.target, e.actor]) {
    if (!id) continue;
    const slot = slots.indexOf(id);
    if (slot < 0) continue;
    const p = players[slot];
    if (!p || (p.state & STATE.PRESENT) === 0 || p.x === 0) continue;
    return { x: p.x, y: p.y, z: p.z };
  }
  return null;
}

/**
 * The actor's position only, ignoring the target. Used by Task 8 for painting
 * actor-positioned bursts.
 */
export function actorPosition(frames: Frame[], slots: string[], e: TimelineEvent): WorldPos | null {
  return eventPosition(frames, slots, { ...e, target: null });
}

/** Victim SteamID64 to the SteamID64 of whoever pinned them most recently at
 *  or before `tMs`. Whether the pin is still on is the victim's PINNED bit,
 *  read from the frame by the caller; this only answers "by whom". */
export function pinnersAt(timeline: TimelineEntry[], tMs: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of timeline) {
    if (e.kind !== 'event' || e.event !== 'pinned' || e.tMs > tMs || !e.target) continue;
    out.set(e.target, e.actor);
  }
  return out;
}

/** A witch_aggro at or before `tMs` with no witch_killed after it. */
export function witchStartledAt(timeline: TimelineEntry[], tMs: number): boolean {
  let startled = false;
  for (const e of [...timeline].sort((a, b) => a.seq - b.seq)) {
    if (e.kind !== 'event' || e.tMs > tMs) continue;
    if (e.event === 'witch_aggro') startled = true;
    else if (e.event === 'witch_killed') startled = false;
  }
  return startled;
}

export interface BurstStyle {
  kind: 'pulse' | 'flash' | 'burst' | 'line';
  color: string;
  lifeMs: number;
  at: 'actor' | 'target';
}

/** What flashes on the map in the second an event happens. Wall-clock
 *  lived, drawn under the medallions, indifferent to the marker filters. */
export const BURSTS: Record<string, BurstStyle> = {
  boom: { kind: 'pulse', color: MARKER_COLORS.boom, lifeMs: 1000, at: 'target' },
  dp: { kind: 'flash', color: MARKER_COLORS.red, lifeMs: 500, at: 'target' },
  incap: { kind: 'flash', color: MARKER_COLORS.red, lifeMs: 500, at: 'target' },
  death: { kind: 'flash', color: MARKER_COLORS.red, lifeMs: 500, at: 'target' },
  skeet: { kind: 'burst', color: MARKER_COLORS.white, lifeMs: 600, at: 'target' },
  cleared: { kind: 'burst', color: MARKER_COLORS.white, lifeMs: 600, at: 'target' },
  pinned: { kind: 'line', color: MARKER_COLORS.green, lifeMs: 300, at: 'target' },
  witch_aggro: { kind: 'burst', color: MARKER_COLORS.white, lifeMs: 600, at: 'actor' },
  witch_killed: { kind: 'burst', color: MARKER_COLORS.white, lifeMs: 600, at: 'actor' },
  tank_death: { kind: 'burst', color: MARKER_COLORS.white, lifeMs: 600, at: 'actor' },
  car_alarm: { kind: 'burst', color: MARKER_COLORS.gold, lifeMs: 600, at: 'actor' },
};

export interface ActiveBurst { entry: TimelineEvent; style: BurstStyle; startedAt: number }

/** A forward step larger than this is a seek, not playback, and starts
 *  nothing: a seek to the finale must not fire every burst of the round. */
export const BURST_MAX_STEP_MS = 2000;

/**
 * Turns the playhead into bursts. Kept as an object because the crossing
 * test needs the previous playhead, and the age needs wall time.
 */
export class BurstClock {
  private lastTMs = Number.NaN;
  private active: ActiveBurst[] = [];

  advance(tMs: number, nowMs: number, timeline: TimelineEntry[]): ActiveBurst[] {
    const prev = this.lastTMs;
    this.lastTMs = tMs;
    const step = tMs - prev;
    if (Number.isFinite(step) && step > 0 && step <= BURST_MAX_STEP_MS) {
      for (const e of timeline) {
        if (e.kind !== 'event' || e.tMs <= prev || e.tMs > tMs) continue;
        const style = BURSTS[e.event];
        if (style) this.active.push({ entry: e, style, startedAt: nowMs });
      }
    }
    this.active = this.active.filter((b) => nowMs - b.startedAt <= b.style.lifeMs);
    return this.active;
  }
}
