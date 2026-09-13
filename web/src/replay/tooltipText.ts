import { ENTITY_KIND, STATE, SURVIVOR_CHARACTERS, ZOMBIE_CLASSES, type PlayerSample } from '../../../src/replayFormat';
import type { HitItem } from './hitTest';
import { isSurvivor, slotLabel } from './draw';
import { statusFlags } from './hud';
import { eventSentence } from './eventText';
import { formatTime } from './ReplayControls';
import type { TimelineEntry } from './timeline';

export interface TooltipContext {
  players: PlayerSample[];
  slots: string[];
  names: Record<string, string>;
  version: number;
  timeline: TimelineEntry[];
  witchStartled: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const ENTITY_NAMES: Record<number, string> = {
  [ENTITY_KIND.COMMON]: 'Common', [ENTITY_KIND.WITCH]: 'Witch', [ENTITY_KIND.TANK_ROCK]: 'Rock',
  [ENTITY_KIND.TANK_AI]: 'AI tank', [ENTITY_KIND.SURVIVOR_BOT]: 'Survivor bot',
  [ENTITY_KIND.SMOKER_AI]: 'AI smoker', [ENTITY_KIND.BOOMER_AI]: 'AI boomer', [ENTITY_KIND.HUNTER_AI]: 'AI hunter',
};

/** One line for the hover tooltip, or null when there is nothing to say.
 *  Names resolve through the roster and fall back to the slot label; a
 *  SteamID64 is never printed. */
export function tooltipText(hit: HitItem, c: TooltipContext): string | null {
  if (hit.kind === 'marker') {
    const e = c.timeline.find((t) => t.kind === 'event' && t.seq === hit.seq);
    if (!e || e.kind !== 'event') return null;
    const nameOf = (id: string) => {
      if (c.names[id]) return c.names[id];
      const i = c.slots.indexOf(id);
      // An id that is not in `slots` at all is not slot 0 either: falling
      // back to `slotLabel(0)` (the old `Math.max(0, -1)`) misattributed an
      // unrostered actor to "S1"'s label. Say plainly that it is unknown.
      return i === -1 ? 'unknown' : slotLabel(i);
    };
    return `${formatTime(e.tMs)} · ${eventSentence(e, nameOf)}`;
  }
  if (hit.kind === 'entity') {
    const parts = [ENTITY_NAMES[hit.entityKind] ?? 'Entity'];
    if (hit.entityKind === ENTITY_KIND.WITCH && c.witchStartled) parts.push('startled');
    if (hit.entityKind === ENTITY_KIND.TANK_AI) parts.push(String(hit.health));
    return parts.join(' · ');
  }
  const p = c.players.find((pl) => pl.slot === hit.slot);
  if (!p) return null;
  const name = c.names[c.slots[p.slot]] || slotLabel(p.slot);
  if ((p.state & STATE.GHOST) !== 0) {
    const cls = ZOMBIE_CLASSES[p.cls];
    return [name, cls ? cap(cls) : null, 'unspawned'].filter(Boolean).join(' · ');
  }
  const parts = [name];
  if (isSurvivor(p)) {
    if (c.version >= 2 && SURVIVOR_CHARACTERS[p.cls]) parts.push(cap(SURVIVOR_CHARACTERS[p.cls]));
  } else if (ZOMBIE_CLASSES[p.cls]) {
    parts.push(cap(ZOMBIE_CLASSES[p.cls]));
  }
  // Flags mean something only for a player still alive to carry them; a dead
  // player is just "Dead", and statusFlags is not even called for one (it
  // would only ever return ['Dead'] again, which is what we are about to say
  // once, not compute twice for nothing).
  if ((p.state & STATE.ALIVE) === 0) {
    parts.push('Dead');
  } else {
    const flags = statusFlags(p.state);
    if (flags.length) parts.push(...flags);
    parts.push(p.temp > 0 ? `${p.health} + ${p.temp}` : String(p.health));
  }
  return parts.join(' · ');
}
