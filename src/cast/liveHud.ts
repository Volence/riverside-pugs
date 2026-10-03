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

/** A tank's recap (TANKDONE): each survivor's damage to it. */
export interface TankDone {
  aliveS: number;
  /** The tank's player at death, or null for an AI tank. */
  controller: string | null;
  /** Damage the tank dealt to survivors over its life. */
  dealt: number;
  /** More than 1: overlapping tanks, one combined recap (damage cannot be
   *  split per tank), sent when the last of them died. */
  tanks: number;
  /** How many times the tank was passed (frustration or handoff). */
  passes: number;
  /** How the window closed (pug-match 0.3.21): the tank died, the round
   *  ended with it up and every survivor down (`wipe`), or the survivors made
   *  the saferoom past it (`safe`). 0.3.20 sends none, which reads as dead. */
  end: 'dead' | 'wipe' | 'safe';
  players: { steamid: string; dmg: number }[];
}

/** A witch's recap (WITCHDONE, pug-match 0.3.21): each survivor's damage to
 *  her, who startled her, who killed her. */
export interface WitchDone {
  /** Seconds from the startle to her death, null when she was never startled. */
  aliveS: number | null;
  startled: string | null;
  killer: string | null;
  /** Killed with one shot (witch_killed oneshot). */
  crown: boolean;
  /** Survivors she put down. */
  incaps: number;
  players: { steamid: string; dmg: number }[];
}

/** How long the witch card stays up. */
export const WITCH_RECAP_MS = 10_000;

/** How long the recap card stays up after a tank dies. */
export const TANK_RECAP_MS = 12_000;

/** A line older than this is a half that ended or a box that stopped
 *  sending: shown as nothing rather than as a frozen bar. */
export const LIVE_HUD_FRESH_MS = 6000;
/** Tokens nobody has updated for this long are dropped. */
const FORGET_MS = 10 * 60_000;

export class LiveHudStore {
  private byToken = new Map<string, { at: number; line: LiveHudLine; reach: Map<string, number> }>();
  private tanks = new Map<string, { at: number; recap: TankDone }>();
  private witches = new Map<string, { at: number; recap: WitchDone }>();

  recordWitch(token: string, recap: WitchDone, nowMs = Date.now()): void {
    this.witches.set(token, { at: nowMs, recap });
    if (this.witches.size > 64) for (const [k, v] of this.witches) if (nowMs - v.at > FORGET_MS) this.witches.delete(k);
  }

  /** The last witch's recap while it is still worth showing. */
  witch(token: string, nowMs = Date.now()): { recap: WitchDone; agoMs: number } | null {
    const t = this.witches.get(token);
    if (!t || nowMs - t.at > WITCH_RECAP_MS || nowMs < t.at - 1000) return null;
    return { recap: t.recap, agoMs: Math.max(0, nowMs - t.at) };
  }

  recordTank(token: string, recap: TankDone, nowMs = Date.now()): void {
    this.tanks.set(token, { at: nowMs, recap });
    if (this.tanks.size > 64) for (const [k, v] of this.tanks) if (nowMs - v.at > FORGET_MS) this.tanks.delete(k);
  }

  /** The last tank's recap while it is still worth showing, with how long ago
   *  it died. */
  tank(token: string, nowMs = Date.now()): { recap: TankDone; agoMs: number } | null {
    const t = this.tanks.get(token);
    if (!t || nowMs - t.at > TANK_RECAP_MS || nowMs < t.at - 1000) return null;
    return { recap: t.recap, agoMs: Math.max(0, nowMs - t.at) };
  }

  /** `round` is the half the line belongs to (the server knows it at ingest);
   *  with it, the furthest progress of each half is kept for the opponent's
   *  mark (how far the other team got on this map). */
  record(token: string, line: LiveHudLine, nowMs = Date.now(), round: { ordinal: number; half: number } | null = null): void {
    const reach = this.byToken.get(token)?.reach ?? new Map<string, number>();
    if (round && line.prog >= 0 && line.prog <= 100) {
      const k = `${round.ordinal}:${round.half}`;
      reach.set(k, Math.max(reach.get(k) ?? 0, line.prog));
    }
    this.byToken.set(token, { at: nowMs, line, reach });
    if (this.byToken.size > 64) {
      for (const [k, v] of this.byToken) if (nowMs - v.at > FORGET_MS) this.byToken.delete(k);
    }
  }

  /** A half (re)started: forget its reach, so a replayed half never takes
   *  its opponent's mark from the abandoned attempt. */
  resetReach(token: string, ordinal: number, half: number): void {
    this.byToken.get(token)?.reach.delete(`${ordinal}:${half}`);
  }

  /** The furthest progress seen in one half, or null if none was recorded
   *  (memory only: a web restart during that half loses it). */
  reach(token: string, ordinal: number, half: number): number | null {
    return this.byToken.get(token)?.reach.get(`${ordinal}:${half}`) ?? null;
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

/** The round with the LIVEHUD numbers filled in, matched by steamid.
 *  `rivalReach` is how far the other team got on this map in the first half
 *  (second half only). */
export function applyLiveHud(live: CastLiveRound, line: LiveHudLine | null, rivalReach: number | null = null): CastLiveRound {
  if (!line) return live;
  const by = new Map(line.players.map((p) => [p.steamid, p]));
  const hud: LiveHud = {
    progress: pctOrNull(line.prog),
    tank: line.tank >= 0 && line.tank <= 100 ? line.tank : null,
    witch: (line.witch >= 0 && line.witch <= 100) || line.witch === -2 ? line.witch : null,
    rivalReach: live.half === 2 ? rivalReach : null,
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
