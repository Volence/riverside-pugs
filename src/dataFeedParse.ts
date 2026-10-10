/**
 * The grammar of pug-match's data feed lines (docs/data-feeds-2026-10-10.md),
 * kept out of logParse.ts so that file only gains one case per verb.
 *
 *   CONN steamid=<id64> stage=connect|ingame|team|ready|drop t=<unix s> map=<map> [team=<2|3>] [pre=<0|1> secs=<n>] [reason=<rest of line>]
 *   MAPLOAD map=<map> t=<unix s>
 *   DOWN half=<h> t=<ms> steamid=<id64> kind=incap|death cause=<code> by=<id64|0> flow=<%> prog=<%> pinned=<0|1>
 *   ROUND_FLOW half=<h> prog=<%> p=<id64>:<flow %>,...
 *   SILIFE half=<h> i=<first index> l=<record>,<record>,...
 *   SILIFE_END half=<h> lives=<n> dropped=<n>
 *   EVENT ... flow=<%> prog=<%> [cause=<code>]   (keys added to the existing line)
 *
 * Every parser here returns null for a line it cannot trust, and an unknown
 * optional key costs the key, never the line. A site that predates this file
 * returns null for the new verbs and ignores the new EVENT keys.
 */

export type ConnStage = 'connect' | 'ingame' | 'team' | 'ready' | 'drop';
export const CONN_STAGES: readonly ConnStage[] = ['connect', 'ingame', 'team', 'ready', 'drop'];

/** A survivor going down: what did it. Open-ended on the wire (a newer plugin
 *  may add a code); these are the ones pug-match sends today. */
export const DOWN_CAUSES = [
  'punch', 'rock', 'hittable', 'tank', 'hunter', 'smoker', 'boomer',
  'common', 'witch', 'fall', 'bleed', 'ff', 'other',
] as const;

/** How an SI life ended. `open` = still up when the round ended. */
export const SI_LIFE_ENDS = [
  'open', 'skeet', 'shot', 'shove', 'melee', 'fire', 'blast', 'other',
  'pass', 'tank', 'disc', 'team',
] as const;

export interface SiLife {
  steamid: string;
  /** m_zombieClass: 1 smoker, 2 boomer, 3 hunter, 5 tank. */
  zc: number;
  /** Round ms; null = none. ghostMs 0 = already a ghost when the half went live. */
  ghostMs: number | null;
  spawnMs: number | null;
  spawnFlow: number | null;
  spawnProg: number | null;
  firstHitMs: number | null;
  dmg: number;
  dmgIncapped: number;
  endMs: number | null;
  end: string;
  killer: string | null;
  respawnS: number | null;
}

export type DataFeedEvent =
  | { kind: 'conn'; token: string; steamid: string; stage: ConnStage; at: number; map: string;
      team: number | null; pre: boolean | null; secs: number | null; reason: string | null }
  | { kind: 'map_load'; token: string; map: string; at: number }
  | { kind: 'down'; token: string; half: 1 | 2; tMs: number; steamid: string; down: 'incap' | 'death';
      cause: string; by: string | null; flow: number | null; prog: number | null; pinned: boolean }
  | { kind: 'round_flow'; token: string; half: 1 | 2; prog: number | null; flows: { steamid: string; flow: number | null }[] }
  | { kind: 'si_lives'; token: string; half: 1 | 2; first: number; lives: SiLife[] }
  | { kind: 'si_lives_end'; token: string; half: 1 | 2; lives: number; dropped: number };

export const DATA_FEED_KINDS: ReadonlySet<string> = new Set(['conn', 'map_load', 'down', 'round_flow', 'si_lives', 'si_lives_end']);

export function isDataFeedEvent(ev: { kind: string }): ev is DataFeedEvent {
  return DATA_FEED_KINDS.has(ev.kind);
}

const ID_RE = /^\d{17}$/;
const MAP_RE = /^[A-Za-z0-9_]{1,63}$/;
const CODE_RE = /^[a-z_]{1,16}$/;

function kvOf(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

function int(s: string | undefined): number | null {
  if (s === undefined || !/^-?\d{1,10}$/.test(s)) return null;
  return Number(s);
}

/** A flow percentage: 0..100, and -1 (or anything else) is "unknown". */
function pct(s: string | undefined): number | null {
  const n = int(s);
  return n === null || n < 0 || n > 100 ? null : n;
}

/** -1 is the plugin's "none"; a real round time is 0 or more. */
function ms(n: number | null): number | null {
  return n === null || n < 0 ? null : n;
}

function half(s: string | undefined): 1 | 2 | null {
  return s === '1' ? 1 : s === '2' ? 2 : null;
}

/** Unix seconds that could be now: after 2020, before 2100. The server's
 *  clock, kept as sent; a wildly wrong one is refused rather than stored. */
function unixOf(s: string | undefined): number | null {
  const n = int(s);
  return n === null || n < 1_577_836_800 || n > 4_102_444_800 ? null : n;
}

/** `line` is the whole line (from `PUG `), `verb` the word after the token. */
export function parseDataFeedLine(token: string, verb: string, line: string): DataFeedEvent | null | undefined {
  // The fields after `PUG <token> <VERB>`.
  const tail = (cut?: number) => (cut === undefined ? line : line.slice(0, cut)).split(/\s+/).slice(3);
  switch (verb) {
    case 'CONN': {
      // reason= runs to the end of the line: a client writes its own
      // disconnect reason, so nothing after it may be read as a key, and
      // the keys come only from what precedes it.
      const at = line.indexOf(' reason=');
      const rest = kvOf(tail(at < 0 ? undefined : at));
      const stage = rest.stage as ConnStage;
      if (!ID_RE.test(rest.steamid ?? '') || !CONN_STAGES.includes(stage)) return null;
      const t = unixOf(rest.t);
      if (t === null || !MAP_RE.test(rest.map ?? '')) return null;
      const team = int(rest.team);
      const secs = int(rest.secs);
      const reason = stage === 'drop' && at >= 0 ? line.slice(at + ' reason='.length).trim().slice(0, 128) : null;
      return {
        kind: 'conn', token, steamid: rest.steamid, stage, at: t, map: rest.map,
        team: team === 2 || team === 3 ? team : null,
        pre: rest.pre === '1' ? true : rest.pre === '0' ? false : null,
        secs: secs !== null && secs >= 0 ? secs : null,
        reason,
      };
    }
    case 'MAPLOAD': {
      const rest = kvOf(tail());
      const t = unixOf(rest.t);
      if (t === null || !MAP_RE.test(rest.map ?? '')) return null;
      return { kind: 'map_load', token, map: rest.map, at: t };
    }
    case 'DOWN': {
      const rest = kvOf(tail());
      const h = half(rest.half);
      const tMs = int(rest.t);
      if (h === null || tMs === null || tMs < 0 || !ID_RE.test(rest.steamid ?? '')) return null;
      if (rest.kind !== 'incap' && rest.kind !== 'death') return null;
      const cause = CODE_RE.test(rest.cause ?? '') ? rest.cause : 'other';
      return {
        kind: 'down', token, half: h, tMs, steamid: rest.steamid, down: rest.kind, cause,
        by: ID_RE.test(rest.by ?? '') ? rest.by : null,
        flow: pct(rest.flow), prog: pct(rest.prog), pinned: rest.pinned === '1',
      };
    }
    case 'ROUND_FLOW': {
      const rest = kvOf(tail());
      const h = half(rest.half);
      if (h === null) return null;
      const flows: { steamid: string; flow: number | null }[] = [];
      for (const part of (rest.p ?? '').split(',')) {
        const m = /^(\d{17}):(-?\d{1,3})$/.exec(part);
        if (m) flows.push({ steamid: m[1]!, flow: pct(m[2]) });
      }
      return { kind: 'round_flow', token, half: h, prog: pct(rest.prog), flows: flows.slice(0, 12) };
    }
    case 'SILIFE': {
      const rest = kvOf(tail());
      const h = half(rest.half);
      const first = int(rest.i);
      if (h === null || first === null || first < 0 || first > 1000) return null;
      const lives: SiLife[] = [];
      for (const rec of (rest.l ?? '').split(',')) {
        const life = siLifeOf(rec);
        // One bad record would shift every index after it, so a line with
        // one is refused whole rather than stored out of place.
        if (!life) return null;
        lives.push(life);
      }
      if (lives.length === 0) return null;
      return { kind: 'si_lives', token, half: h, first, lives };
    }
    case 'SILIFE_END': {
      const rest = kvOf(tail());
      const h = half(rest.half);
      const lives = int(rest.lives);
      const dropped = int(rest.dropped);
      if (h === null || lives === null || lives < 0 || dropped === null || dropped < 0) return null;
      return { kind: 'si_lives_end', token, half: h, lives, dropped };
    }
    default:
      return undefined;
  }
}

/** id:zc:ghost:spawn:sflow:sprog:hit:dmg:dmginc:end_t:end:killer:resp */
export function siLifeOf(rec: string): SiLife | null {
  const f = rec.split(':');
  if (f.length !== 13) return null;
  const [id, zcS, g, s, sf, sp, h, d, di, e, end, killer, r] = f;
  if (!ID_RE.test(id!)) return null;
  const zc = int(zcS);
  const nums = [g, s, sf, sp, h, d, di, e, r].map(int);
  if (zc === null || zc < 1 || zc > 8 || nums.some((n) => n === null)) return null;
  if (!CODE_RE.test(end!)) return null;
  if (killer !== '0' && !ID_RE.test(killer!)) return null;
  const [ghost, spawn, sflow, sprog, hit, dmg, dmgInc, endT, resp] = nums as number[];
  if (dmg! < 0 || dmgInc! < 0) return null;
  return {
    steamid: id!, zc, ghostMs: ms(ghost!), spawnMs: ms(spawn!),
    spawnFlow: sflow! >= 0 && sflow! <= 100 ? sflow! : null,
    spawnProg: sprog! >= 0 && sprog! <= 100 ? sprog! : null,
    firstHitMs: ms(hit!), dmg: dmg!, dmgIncapped: dmgInc!, endMs: ms(endT!), end: end!,
    killer: killer === '0' ? null : killer!, respawnS: resp! >= 0 ? resp! : null,
  };
}

/** The keys pug-match's data feeds add to an EVENT line. Absent from an older
 *  plugin, and then every field is undefined, which the store reads as NULL. */
export function eventExtrasOf(rest: Record<string, string>): { flow?: number | null; prog?: number | null; cause?: string } {
  const out: { flow?: number | null; prog?: number | null; cause?: string } = {};
  if (rest.flow !== undefined) out.flow = pct(rest.flow);
  if (rest.prog !== undefined) out.prog = pct(rest.prog);
  if (rest.cause !== undefined && CODE_RE.test(rest.cause)) out.cause = rest.cause;
  return out;
}
