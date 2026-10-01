/**
 * Is a booked box still there (spec part 1 section 4, Crash recovery; plan 5)?
 *
 * rcon alone is never the signal: rcon to our boxes drops out now and then
 * while the game runs fine. A box that answers rcon has restarted when the
 * boot marker l4d_booking_id (l4d_booking 1.4.0, written only by setup and
 * recovery) is no longer this booking's. A box that does not answer rcon is
 * gone only when, for the whole limit, its live game has not heartbeated
 * either and it does not answer A2S, a separate UDP path.
 */
export type BoxVerdict =
  | { kind: 'ok' }
  | { kind: 'restarted' }
  | { kind: 'quiet' }
  | { kind: 'up_no_rcon'; players: number }
  | { kind: 'gone' };

export interface BoxSignals {
  rconOk: boolean;
  /** cvarValue(reply, 'l4d_booking_id'): null when the cvar does not exist (l4d_booking older than 1.4.0). */
  marker: string | null;
  bookingId: number;
  nowMs: number;
  lostSinceMs: number | null;
  /** match_live.last_seen of the live game, in ms; null when there is no live game or no heartbeat yet. */
  heartbeatMs: number | null;
  /** The A2S answer of this check: null for no answer, else the player count. Only asked when rcon failed. */
  a2sPlayers: number | null;
  goneMs: number;
}

export function classifyBox(s: BoxSignals): BoxVerdict {
  if (s.rconOk) {
    // No such cvar: an l4d_booking older than 1.4.0. Setup refuses that
    // plugin, so this only covers a box downgraded under a running booking:
    // never mistake it for a restart every minute.
    if (s.marker === null || s.marker === String(s.bookingId)) return { kind: 'ok' };
    return { kind: 'restarted' };
  }
  const since = s.lostSinceMs ?? s.nowMs;
  if (s.nowMs - since < s.goneMs) return { kind: 'quiet' };
  if (s.heartbeatMs !== null && s.nowMs - s.heartbeatMs < s.goneMs) return { kind: 'quiet' };
  if (s.a2sPlayers !== null) return { kind: 'up_no_rcon', players: s.a2sPlayers };
  return { kind: 'gone' };
}
