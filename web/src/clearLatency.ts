import type { LiveEvent } from './api';

/** One pin that was ended by a clear, and how long it took.
 *
 *  Clear latency is the single number the pinned/cleared pair exists to
 *  produce: no counter can express how fast a teammate got freed, only that
 *  they were. */
export interface ClearPair {
  /** seq of the `cleared` event, so a caller rendering that row can look up
   *  its own latency without re-deriving the pairing. */
  seq: number;
  clearer: string;
  victim: string;
  mapOrdinal: number;
  half: number;
  latencyMs: number;
}

/** Pair each `cleared` with the pin it ended, and measure the gap.
 *
 *  Pairing is by victim, never by adjacency. Two survivors can be pinned at
 *  once, and then the most recent pin is not the one the clear ended; matching
 *  on order would silently report the wrong duration rather than none.
 *
 *  A clear whose victim was never seen pinned is dropped rather than guessed
 *  at. That is the common case when testing against bots, which are not
 *  rostered and so reach the feed with an empty target, but it is rare in a
 *  real match where every player is rostered. */
export function clearLatencies(events: LiveEvent[]): ClearPair[] {
  // The API serves newest-first; pairing has to walk forwards in time.
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const openPins = new Map<string, LiveEvent>();
  const out: ClearPair[] = [];

  const key = (e: LiveEvent, victim: string) => `${e.mapOrdinal}|${e.half}|${victim}`;

  for (const e of ordered) {
    // -1 means the event carried no round timing, so nothing it takes part in
    // can be measured. Those come from matches played before round capture.
    if (e.half < 0 || e.tMs < 0) continue;
    const victim = e.target?.steamid;
    if (!victim) continue;

    if (e.kind === 'pinned') { openPins.set(key(e, victim), e); continue; }
    if (e.kind !== 'cleared') continue;

    const pin = openPins.get(key(e, victim));
    if (!pin) continue;
    // Spent: a pin frees one person once, so a later clear on the same victim
    // belongs to a pin we have not seen rather than to this one again.
    openPins.delete(key(e, victim));
    const latencyMs = e.tMs - pin.tMs;
    if (latencyMs < 0) continue;
    out.push({
      seq: e.seq, clearer: e.actor.steamid, victim,
      mapOrdinal: e.mapOrdinal, half: e.half, latencyMs,
    });
  }
  return out;
}

export interface ClearLatencyRow {
  steamid: string;
  name: string;
  avgMs: number;
  count: number;
}

/** Average clear latency per player who did the clearing, fastest first.
 *
 *  `count` rides along deliberately: an average over one or two clears is
 *  noise, and the caller needs to be able to say so rather than present it as
 *  a rating. */
export function clearLatencyByPlayer(events: LiveEvent[]): ClearLatencyRow[] {
  const names = new Map<string, string>();
  for (const e of events) names.set(e.actor.steamid, e.actor.name);

  const totals = new Map<string, { sum: number; count: number }>();
  for (const pair of clearLatencies(events)) {
    const t = totals.get(pair.clearer) ?? { sum: 0, count: 0 };
    t.sum += pair.latencyMs;
    t.count += 1;
    totals.set(pair.clearer, t);
  }

  return [...totals.entries()]
    .map(([steamid, t]) => ({
      steamid,
      name: names.get(steamid) ?? steamid,
      avgMs: Math.round(t.sum / t.count),
      count: t.count,
    }))
    .sort((a, b) => a.avgMs - b.avgMs);
}
