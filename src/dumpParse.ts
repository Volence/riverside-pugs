export interface DumpMap {
  map: string;
  a: number;
  b: number;
}

export interface DumpPlayer {
  steamid: string;
  team: 'a' | 'b';
  sidmg: number;
  sikill: number;
  ck: number;
  ff: number;
  rev: number;
}

export interface Dump {
  matchId: number;
  maps: DumpMap[];
  players: DumpPlayer[];
  winner: 'a' | 'b' | 'draw';
  totalA: number;
  totalB: number;
}

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
 * Parse the authoritative `sm_pug_dump` response. Strict: any malformed required
 * field yields null so the caller can retry the RCON pull rather than persist
 * garbage. Ignores unrelated console noise before the DUMP header.
 */
export function parseDump(body: string): Dump | null {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const start = lines.findIndex((l) => l.startsWith('DUMP '));
  if (start < 0) return null;

  const header = kv(lines[start].split(/\s+/).slice(1));
  const matchId = intOf(header.match);
  if (matchId === null) return null;

  const maps: DumpMap[] = [];
  const players: DumpPlayer[] = [];
  let end: { winner: 'a' | 'b' | 'draw'; totalA: number; totalB: number } | null = null;

  for (const line of lines.slice(start + 1)) {
    const parts = line.split(/\s+/);
    const verb = parts[0];
    const rest = kv(parts.slice(1));
    if (verb === 'MAP') {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (!rest.map || a === null || b === null) return null;
      maps.push({ map: rest.map, a, b });
    } else if (verb === 'STAT') {
      const nums = ['sidmg', 'sikill', 'ck', 'ff', 'rev'].map((k) => intOf(rest[k]));
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      if (rest.team !== 'a' && rest.team !== 'b') return null;
      if (nums.some((n) => n === null)) return null;
      const [sidmg, sikill, ck, ff, rev] = nums as number[];
      players.push({ steamid: rest.steamid, team: rest.team, sidmg, sikill, ck, ff, rev });
    } else if (verb === 'END') {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (a === null || b === null) return null;
      if (rest.winner !== 'a' && rest.winner !== 'b' && rest.winner !== 'draw') return null;
      end = { winner: rest.winner, totalA: a, totalB: b };
      break;
    }
  }

  if (!end) return null;
  return { matchId, maps, players, winner: end.winner, totalA: end.totalA, totalB: end.totalB };
}
