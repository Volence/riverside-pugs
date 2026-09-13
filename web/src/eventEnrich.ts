import { ZOMBIE_CLASSES } from '../../src/replayFormat';
import type { LiveEvent } from './api';
import type { TimelineEntry } from './replay/timeline';

/**
 * What the event stream can say about an event beyond its own line, derived
 * by reading the stream around it. Nothing here is recorded by the plugin;
 * it is all pairing and memory over events that already exist:
 *
 * - `via`: the attacker's class when they downed or killed someone, from
 *   their most recent spawn (or tank) event. "went down to Heart and Soul"
 *   becomes "went down to Heart and Soul (smoker)".
 * - `from`: who a clear freed the victim from, from the pin the clear ended.
 * - `pin`: how a pin ended and how long it lasted, from the clear or the
 *   victim's death that followed it.
 *
 * What it cannot say, because the plugin does not record it: HOW someone went
 * down (claw, choke, pounce, punch, friendly fire, commons), the death cause,
 * pills and kits, rock hits. Those need a `via` field on the wire.
 */
export interface Enrichment {
  via?: string;
  /** Who the clear freed the victim from, and how long they had been held. */
  from?: { pinner: string; afterMs: number };
  pin?: { durationMs: number; outcome: 'cleared' | 'died'; by: string | null };
}

/** The one shape both event sources reduce to. Actor and target are
 *  SteamID64 strings; the renderers resolve names themselves. */
export interface EnrichableEvent {
  seq: number;
  tMs: number;
  half: number;
  mapOrdinal: number;
  kind: string;
  actor: string;
  target: string | null;
  value: number;
}

export function fromLiveEvents(events: LiveEvent[]): EnrichableEvent[] {
  return events.map((e) => ({
    seq: e.seq, tMs: e.tMs, half: e.half, mapOrdinal: e.mapOrdinal, kind: e.kind,
    actor: e.actor.steamid, target: e.target?.steamid ?? null, value: e.value,
  }));
}

/** A replay timeline is one round of one map, so map and half are constant. */
export function fromTimeline(entries: TimelineEntry[]): EnrichableEvent[] {
  const out: EnrichableEvent[] = [];
  for (const e of entries) {
    if (e.kind !== 'event') continue;
    out.push({
      seq: e.seq, tMs: e.tMs, half: 1, mapOrdinal: 0, kind: e.event,
      actor: e.actor, target: e.target, value: e.value,
    });
  }
  return out;
}

const scope = (e: EnrichableEvent) => `${e.mapOrdinal}|${e.half}`;

/**
 * Walk the stream in seq order, remembering per round who is what class and
 * who is holding whom, and emit an Enrichment for every event that gains
 * something. Scoped per map and half: a class or a pin never survives a
 * round change, because the round change killed everyone.
 */
export function enrichEvents(events: EnrichableEvent[]): Map<number, Enrichment> {
  const out = new Map<number, Enrichment>();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  // Per scope: steamid -> class name, and victim steamid -> open pin.
  const classes = new Map<string, Map<string, string>>();
  const pins = new Map<string, Map<string, { seq: number; tMs: number; pinner: string }>>();
  const bag = <T>(m: Map<string, Map<string, T>>, key: string) => {
    let b = m.get(key);
    if (!b) { b = new Map(); m.set(key, b); }
    return b;
  };
  const add = (seq: number, patch: Enrichment) => out.set(seq, { ...(out.get(seq) ?? {}), ...patch });

  for (const e of ordered) {
    const cls = bag(classes, scope(e));
    const open = bag(pins, scope(e));
    switch (e.kind) {
      case 'si_spawn': {
        const name = ZOMBIE_CLASSES[e.value];
        if (name) cls.set(e.actor, name);
        break;
      }
      case 'tank_spawn':
      case 'tank_take':
        cls.set(e.actor, 'tank');
        break;
      case 'tank_give':
        cls.delete(e.actor);
        break;
      case 'incap':
      case 'death': {
        // Victim-first kinds: the attacker is the target.
        if (e.target) {
          const via = cls.get(e.target);
          if (via) add(e.seq, { via });
        }
        // A survivor dying while held ends the pin.
        if (e.kind === 'death') {
          const pin = open.get(e.actor);
          if (pin && e.tMs >= pin.tMs) {
            add(pin.seq, { pin: { durationMs: e.tMs - pin.tMs, outcome: 'died', by: null } });
            open.delete(e.actor);
          }
        }
        break;
      }
      case 'pinned':
        if (e.target) open.set(e.target, { seq: e.seq, tMs: e.tMs, pinner: e.actor });
        break;
      case 'cleared': {
        if (!e.target) break;
        const pin = open.get(e.target);
        if (!pin || e.tMs < pin.tMs) break;
        add(e.seq, { from: { pinner: pin.pinner, afterMs: e.tMs - pin.tMs } });
        add(pin.seq, { pin: { durationMs: e.tMs - pin.tMs, outcome: 'cleared', by: e.actor } });
        open.delete(e.target);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Durations in words. "1.3s" after a name read as a clock time to the
 *  owner ("no one will know what time it is"); "1.3 seconds" cannot. */
export function fmtSeconds(ms: number): string {
  const s = (ms / 1000).toFixed(1);
  return `${s} second${s === '1.0' ? '' : 's'}`;
}

/**
 * The words appended after the event's own sentence, or '' when there is
 * nothing to add. `victim` is the pinned player's name for the pin line's
 * "until X died" reading.
 */
export function enrichmentText(
  kind: string, en: Enrichment | undefined, nameOf: (id: string) => string, victim: string | null,
): string {
  if (!en) return '';
  const parts: string[] = [];
  if (en.via && (kind === 'incap' || kind === 'death')) parts.push(`(${en.via})`);
  if (en.from && kind === 'cleared') parts.push(`from ${nameOf(en.from.pinner)} after ${fmtSeconds(en.from.afterMs)}`);
  if (en.pin && kind === 'pinned') {
    const how = en.pin.outcome === 'cleared'
      ? (en.pin.by ? `cleared by ${nameOf(en.pin.by)}` : 'cleared')
      : `until ${victim ?? 'they'} died`;
    parts.push(`for ${fmtSeconds(en.pin.durationMs)}, ${how}`);
  }
  return parts.join(' ');
}
