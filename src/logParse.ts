const TOKEN_RE = /^[0-9a-f]{32}$/;

export type LogEvent =
  | { kind: 'match_start'; token: string; map: string }
  | { kind: 'map_result'; token: string; map: string; a: number; b: number }
  | { kind: 'heartbeat'; token: string }
  | { kind: 'player'; token: string; steamid: string; event: 'connect' | 'disconnect' }
  | { kind: 'match_end'; token: string; a: number; b: number; winner: 'a' | 'b' | 'draw' };

/** Parse `key=val key=val` pairs from the remainder of a PUG line. */
function kv(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

function intOf(s: string | undefined): number | null {
  if (s === undefined || !/^-?\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * Decode a raw srcds log UDP datagram into a typed PUG event, or null if it is
 * not one of ours or is malformed. Never throws. Tolerant of the engine framing
 * being present or absent — it locates the `PUG ` marker rather than assuming an
 * offset.
 */
export function parseLogDatagram(buf: Buffer): LogEvent | null {
  const text = buf.toString('utf8');
  const idx = text.indexOf('PUG ');
  if (idx < 0) return null;
  const line = text.slice(idx).split('\n', 1)[0].trim();
  const parts = line.split(/\s+/);
  if (parts.length < 3) return null;
  const token = parts[1];
  if (!TOKEN_RE.test(token)) return null;
  const verb = parts[2];
  const rest = kv(parts.slice(3));

  switch (verb) {
    case 'MATCH_START': {
      if (!rest.map) return null;
      return { kind: 'match_start', token, map: rest.map };
    }
    case 'MAP_RESULT': {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (!rest.map || a === null || b === null) return null;
      return { kind: 'map_result', token, map: rest.map, a, b };
    }
    case 'HEARTBEAT':
      return { kind: 'heartbeat', token };
    case 'PLAYER': {
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      if (rest.event !== 'connect' && rest.event !== 'disconnect') return null;
      return { kind: 'player', token, steamid: rest.steamid, event: rest.event };
    }
    case 'MATCH_END': {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (a === null || b === null) return null;
      if (rest.winner !== 'a' && rest.winner !== 'b' && rest.winner !== 'draw') return null;
      return { kind: 'match_end', token, a, b, winner: rest.winner };
    }
    default:
      return null;
  }
}
