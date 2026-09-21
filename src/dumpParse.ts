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
  /** The backend's nonce as the plugin echoed it, on BOTH the DUMP and the END
   *  line, or null from a plugin older than 0.3.3, which echoes nothing.
   *  Optional so hand-built dumps (dev simulation, tests) need not set it. */
  nonce?: string | null;
  /** The plugin's match state when it answered: `ended` is the only one a
   *  result may be taken from. Null whenever `nonce` is. */
  state?: DumpState | null;
}

/** StateName() in pug-match.sp, less `none`: with no match configured
 *  sm_pug_dump answers PUGERR and there is no dump at all. */
export const DUMP_STATES = ['pending', 'live', 'ended'] as const;
export type DumpState = typeof DUMP_STATES[number];

export interface ParseDumpOpts {
  /** The nonce sent as sm_pug_dump's second argument. */
  nonce?: string;
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
 *
 * WHICH block is read depends on whether the plugin echoes the nonce.
 *
 * An RCON response carries whatever else reached the console while the
 * command ran (see the `ready` probe in src/server.ts, whose first answer
 * after a boot was another plugin's output and nothing else), so "the first
 * line that starts with DUMP" is not necessarily the plugin answering THIS
 * request. pug-match 0.3.3 repeats the caller's nonce on the DUMP and the END
 * line. Given a nonce, the block read is the LAST one that carries it, and its
 * END line has to carry it too; an answer in which some block has a nonce and
 * none has ours is refused.
 *
 * An answer with no nonce anywhere is an older plugin, and is read exactly as
 * it always was: first DUMP, first END after it. Web deploys before plugins
 * and plugins roll out a box at a time, so that path has to keep working.
 */
export function parseDump(body: string, opts: ParseDumpOpts = {}): Dump | null {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const headers: { i: number; nonce: string | null }[] = [];
  lines.forEach((l, i) => {
    if (l.startsWith('DUMP ')) headers.push({ i, nonce: kv(l.split(/\s+/).slice(1)).nonce ?? null });
  });
  if (headers.length === 0) return null;

  let start = headers[0].i;
  let nonce: string | null = null;
  if (opts.nonce !== undefined) {
    const ours = headers.filter((h) => h.nonce === opts.nonce);
    if (ours.length > 0) {
      start = ours[ours.length - 1].i;
      nonce = opts.nonce;
    } else if (headers.some((h) => h.nonce !== null)) {
      return null;
    }
  }

  const header = kv(lines[start].split(/\s+/).slice(1));
  const matchId = intOf(header.match);
  if (matchId === null) return null;
  const skillDetect = header.skilldetect === '1';
  // Only believed alongside our nonce: without one the line could be anybody's.
  let state: DumpState | null = null;
  if (nonce !== null) {
    if (!(DUMP_STATES as readonly string[]).includes(header.state ?? '')) return null;
    state = header.state as DumpState;
  }

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
      // The END line closes the block only if it is the same answer: a block
      // that opens with our nonce and ends without it was spliced.
      if (nonce !== null && (rest.nonce !== nonce || rest.state !== state)) return null;
      end = { winner: rest.winner, totalA: a, totalB: b };
      break;
    }
  }

  if (!end) return null;
  return { matchId, maps, players, skillDetect, skills, winner: end.winner, totalA: end.totalA, totalB: end.totalB, nonce, state };
}
