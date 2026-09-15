import { isKnownStat } from './statKeys.js';

export interface DumpMap {
  map: string;
  a: number;
  b: number;
}

export interface DumpPlayer {
  steamid: string;
  team: 'a' | 'b';
  /** Map ordinal the player was rostered on; 0 from the start. Optional so
   *  hand-built dumps (dev simulation, tests) need not set it; the parser
   *  always does, reading an absent key from an older plugin as 0. */
  joinedMap?: number;
  sidmg: number;
  sikill: number;
  ck: number;
  ff: number;
  rev: number;
}

export interface DumpSkill {
  steamid: string;
  /** Only keys present in the registry. Absent means not measured, which is
   *  different from zero: see skillDetect. */
  stats: Record<string, number>;
}

export interface Dump {
  matchId: number;
  maps: DumpMap[];
  players: DumpPlayer[];
  /** False when skill_detect was not loaded at MATCH_START. Skill-derived stats
   *  are then absent rather than zero, and must not be persisted as zeros. */
  skillDetect: boolean;
  skills: DumpSkill[];
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
  const skillDetect = header.skilldetect === '1';

  const maps: DumpMap[] = [];
  const players: DumpPlayer[] = [];
  const skills: DumpSkill[] = [];
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
      const joinedMap = Math.max(0, intOf(rest.joined_map) ?? 0);
      players.push({ steamid: rest.steamid, team: rest.team, joinedMap, sidmg, sikill, ck, ff, rev });
    } else if (verb === 'SKILL') {
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      const stats: Record<string, number> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (k === 'steamid') continue;
        // Unknown keys are ignored so a newer plugin degrades against an older
        // backend instead of failing the whole dump. Known keys must be valid.
        if (!isKnownStat(k)) continue;
        const n = intOf(v);
        if (n === null) return null;
        stats[k] = n;
      }
      skills.push({ steamid: rest.steamid, stats });
    } else if (verb === 'END') {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (a === null || b === null) return null;
      if (rest.winner !== 'a' && rest.winner !== 'b' && rest.winner !== 'draw') return null;
      end = { winner: rest.winner, totalA: a, totalB: b };
      break;
    }
  }

  if (!end) return null;
  return { matchId, maps, players, skillDetect, skills, winner: end.winner, totalA: end.totalA, totalB: end.totalB };
}
