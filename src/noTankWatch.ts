/**
 * Flags a half whose survivors are well past the tank % with no tank.
 *
 * Match 673 (2026-10-13, Death Toll 4, half 1): a dead infected bot left
 * over from a reconnect during a pause filled the infected team, and the
 * game kicked the tank bot the moment it spawned ("infected team is full").
 * Survivors walked on to 43% against a 30% tank before a spectating admin
 * noticed and restarted the map. l4d_dead_bot_sweep removes that cause on
 * the servers; this tells staff when a tank goes missing for any reason, in
 * time to restart the map.
 *
 * Everything comes from lines the site already trusts: LIVEHUD every 2 s
 * (prog = furthest survivor flow %, tank = the scheduled tank %, 0 none),
 * EVENT kind=tank_spawn, and ROUND_START (a new half, or a replayed one).
 * The rule: tank > 0, no tank_spawn this half, and prog at least MARGIN
 * points past the tank for HOLD_MS. tank_spawn arrives a few seconds after
 * the spawn (after the tank lottery), hence the hold. Backtested on all five
 * pool servers' logs 2026-09-27..10-13: 1 of 2,784 halves, match 673's.
 *
 * In memory only, like the caster live HUD: a web restart costs at most the
 * alert for a half already in progress.
 */

export const NO_TANK_MARGIN = 5;
export const NO_TANK_HOLD_MS = 15_000;

interface HalfState {
  map: string;
  half: number;
  tank: number | null;
  spawned: boolean;
  /** When prog first stood MARGIN past the tank, null when it does not. */
  pastSince: number | null;
  fired: boolean;
}

export interface NoTankAlert {
  map: string;
  half: number;
  tank: number;
  prog: number;
}

export class NoTankWatch {
  private halves = new Map<string, HalfState>();

  roundStart(token: string, map: string, half: number): void {
    this.halves.set(token, { map, half, tank: null, spawned: false, pastSince: null, fired: false });
  }

  event(token: string, kind: string): void {
    const s = this.halves.get(token);
    if (s && kind === 'tank_spawn') s.spawned = true;
  }

  /** Returns the alert the first time a half crosses the rule, else null. */
  hud(token: string, prog: number, tank: number, now: number): NoTankAlert | null {
    const s = this.halves.get(token);
    if (!s) return null;
    s.tank = tank;
    if (s.spawned || s.fired || tank <= 0 || prog < tank + NO_TANK_MARGIN) {
      s.pastSince = null;
      return null;
    }
    s.pastSince ??= now;
    if (now - s.pastSince < NO_TANK_HOLD_MS) return null;
    s.fired = true;
    return { map: s.map, half: s.half, tank, prog };
  }

  forget(token: string): void {
    this.halves.delete(token);
  }
}

export function noTankText(matchId: number, a: NoTankAlert): string {
  return `Match ${matchId}: no tank on ${a.map} half ${a.half}. Survivors are at ${a.prog}% and the tank was set for ${a.tank}%. ` +
    'The map probably needs a restart (changelevel to the same map).';
}
