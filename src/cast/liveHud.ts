import type { CastLiveRound, LiveHud } from './types.js';

/**
 * The plugin's LIVEHUD line (pug-match 0.3.20, Timer_LiveHud): survivor map
 * progress, held items, damage this half and the boss flow %, every 2 s
 * while a half is live. None of it is in the replay frames.
 *
 * Undelayed game state, so it is kept in memory only, keyed by match token,
 * and read only by the caster studio feed (behind the overlay key and the
 * caster gate). It never reaches the database or the public live page. A web
 * restart loses it for 2 s, which is all it is worth.
 */

export interface LiveHudPlayer {
  steamid: string;
  /** Own map progress %, -1 for infected, the dead and unknown nav. */
  flow: number;
  /** ITEM bits (survivors), 0 for infected. */
  items: number;
  /** Damage this half: SI damage dealt (survivor) or damage as SI (infected). */
  dmg: number;
}

export interface LiveHudLine {
  /** The furthest survivor's flow %, -1 unknown. */
  prog: number;
  /** -1 when l4d_boss_percent is absent, 0 none; witch -2 is a witch party. */
  tank: number;
  witch: number;
  players: LiveHudPlayer[];
}

/** A line older than this is a half that ended or a box that stopped
 *  sending: shown as nothing rather than as a frozen bar. */
export const LIVE_HUD_FRESH_MS = 6000;
/** Tokens nobody has updated for this long are dropped. */
const FORGET_MS = 10 * 60_000;

export class LiveHudStore {
  private byToken = new Map<string, { at: number; line: LiveHudLine }>();

  record(token: string, line: LiveHudLine, nowMs = Date.now()): void {
    this.byToken.set(token, { at: nowMs, line });
    if (this.byToken.size > 64) {
      for (const [k, v] of this.byToken) if (nowMs - v.at > FORGET_MS) this.byToken.delete(k);
    }
  }

  /** The newest line for `token` if it is fresh, else null. */
  get(token: string, nowMs = Date.now()): LiveHudLine | null {
    const hit = this.byToken.get(token);
    if (!hit || nowMs - hit.at > LIVE_HUD_FRESH_MS || nowMs < hit.at - 1000) return null;
    return hit.line;
  }
}

/** The one store the log listener writes and the caster feed reads. */
export const liveHudStore = new LiveHudStore();

const pctOrNull = (n: number): number | null => (n >= 0 && n <= 100 ? n : null);

/** The round with the LIVEHUD numbers filled in, matched by steamid. */
export function applyLiveHud(live: CastLiveRound, line: LiveHudLine | null): CastLiveRound {
  if (!line) return live;
  const by = new Map(line.players.map((p) => [p.steamid, p]));
  const hud: LiveHud = {
    progress: pctOrNull(line.prog),
    tank: line.tank >= 0 && line.tank <= 100 ? line.tank : null,
    witch: (line.witch >= 0 && line.witch <= 100) || line.witch === -2 ? line.witch : null,
  };
  return {
    ...live,
    hud,
    survivors: live.survivors.map((s) => {
      const p = s.steamid ? by.get(s.steamid) : undefined;
      if (!p) return s;
      return { ...s, flow: pctOrNull(p.flow), items: p.items, dmg: p.dmg };
    }),
    infected: live.infected.map((i) => {
      const p = by.get(i.steamid);
      return p ? { ...i, dmg: p.dmg } : i;
    }),
  };
}
