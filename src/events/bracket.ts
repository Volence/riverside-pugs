import { BracketsManager } from 'brackets-manager';
import { InMemoryDatabase } from 'brackets-memory-db';
import type { ResultInput, StageConfigs } from './validate.js';

/**
 * brackets-manager.js over its in-memory store (plan T2 Ruling 15). A stage's
 * whole bracket is one plain JSON value, BracketData. Each call copies it
 * into a fresh store, lets the library work, and returns a new copy, so
 * src/events/play.ts can write it in the same synchronous transaction as the
 * match row and the audit row. Participants are named by entry id. One stage
 * per store, always stage id 0.
 *
 * Library facts this module leans on (pinned by tests/bracket.test.ts): the
 * field must be a power of two for elimination, padded with null seeds (byes)
 * that the default inner_outer ordering gives to the top seeds; a match with
 * a null opponent is a bye; status 2 or 3 means both teams are known, and 4 or
 * more means done; a double elimination grand final reset stays "ready" even
 * when the upper winner took the first grand final, so it is hidden unless the
 * lower side won it; a result on a match whose next match is done throws
 * "locked".
 */

export type BracketType = 'single_elim' | 'double_elim' | 'round_robin';
export interface BracketData { v: 1; tables: Record<string, unknown[]> }
export interface BracketMatch {
  bmId: number; group: number; round: number; number: number; a: number | null; b: number | null;
  state: 'pending' | 'ready' | 'done'; winner: number | null; scoreA: number | null; scoreB: number | null; forfeit: boolean;
}

export class BracketError extends Error {
  constructor(readonly code: 'locked' | 'not_ready' | 'too_few') { super(`bracket: ${code}`); }
}

interface BmOpponent { id: number | null; score?: number; result?: 'win' | 'loss' | 'draw'; forfeit?: boolean }
interface BmMatch { id: number; group_id: number; round_id: number; number: number; status: number; opponent1: BmOpponent | null; opponent2: BmOpponent | null }
interface Tables {
  participant: { id: number; name: string }[]; stage: { type: string }[]; group: { id: number; number: number }[];
  round: { id: number; number: number }[]; match: BmMatch[];
}

const STAGE = 0;
const DONE = 4;

function open(data: BracketData | null): { store: InMemoryDatabase; manager: BracketsManager } {
  const store = new InMemoryDatabase();
  if (data) store.setData(structuredClone(data.tables) as never);
  return { store, manager: new BracketsManager(store) };
}
const tablesOf = (store: InMemoryDatabase): Tables => (store as unknown as { data: Tables }).data;
const snapshot = (store: InMemoryDatabase): BracketData => ({ v: 1, tables: structuredClone(tablesOf(store)) as unknown as Record<string, unknown[]> });

/**
 * The double elimination grand final reset (group 3, round 2) is created by
 * the library with both opponents set and status "ready" the moment grand
 * final 1 is played, whether or not it is actually needed: it is only a
 * real match once the lower bracket side won grand final 1. Shared by
 * bracketMatches (to hide it) and reportResult (to refuse a result for it).
 */
function isHiddenGrandFinalReset(t: Tables, m: BmMatch): boolean {
  if (t.stage[0]?.type !== 'double_elimination') return false;
  const groupNo = new Map(t.group.map((g) => [g.id, g.number]));
  const roundNo = new Map(t.round.map((r) => [r.id, r.number]));
  if (groupNo.get(m.group_id) !== 3 || roundNo.get(m.round_id) !== 2) return false;
  const first = t.match.find((x) => x.group_id === m.group_id && roundNo.get(x.round_id) === 1);
  return first?.opponent2?.result !== 'win';
}

/**
 * A snapshot of every already-decided REAL match but `exceptId` (both
 * opponents present; a bye, where one opponent is null, is left out since
 * the library resolves and re-resolves those itself whenever a correction
 * legitimately changes who drops onto one), keyed by id, as a string of its
 * opponents. brackets-manager's own lock check (reset.js) only looks at the
 * direct next matches of the one being corrected, and misses one that a bye
 * carried a result past (a winner bracket round 1 loser can drop straight
 * onto a loser bracket bye and land in a later loser bracket match in one
 * step). When that later match was already played, the library accepts the
 * correction and silently overwrites that match's opponent instead of
 * refusing it. Comparing this snapshot before and after the write is how
 * reportResult catches that and refuses it too.
 */
function doneElsewhere(t: Tables, exceptId: number): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of t.match) {
    if (m.id !== exceptId && m.status >= DONE && m.opponent1 !== null && m.opponent2 !== null) {
      out.set(m.id, JSON.stringify({ opponent1: m.opponent1, opponent2: m.opponent2 }));
    }
  }
  return out;
}

export async function createBracket(type: BracketType, config: StageConfigs[BracketType], seeded: number[]): Promise<BracketData> {
  if (seeded.length < 2) throw new BracketError('too_few');
  const { store, manager } = open(null);
  const names = seeded.map(String);
  if (type === 'round_robin') {
    const groupCount = Math.max(1, Math.min((config as StageConfigs['round_robin']).groups, Math.floor(seeded.length / 2)));
    await manager.create.stage({ tournamentId: 0, name: 'stage', type: 'round_robin', seeding: names, settings: { groupCount } });
  } else {
    const size = 2 ** Math.ceil(Math.log2(seeded.length));
    const seeding = [...names, ...Array<null>(size - names.length).fill(null)];
    if (type === 'single_elim') {
      const thirdPlace = (config as StageConfigs['single_elim']).thirdPlace && seeded.length >= 4;
      await manager.create.stage({ tournamentId: 0, name: 'stage', type: 'single_elimination', seeding, settings: { consolationFinal: thirdPlace } });
    } else {
      const reset = (config as StageConfigs['double_elim']).grandFinalReset;
      await manager.create.stage({ tournamentId: 0, name: 'stage', type: 'double_elimination', seeding, settings: { grandFinal: reset ? 'double' : 'simple' } });
    }
  }
  return snapshot(store);
}

export async function reportResult(data: BracketData, bmId: number, r: ResultInput): Promise<BracketData> {
  const { store, manager } = open(data);
  const tables = tablesOf(store);
  const cur = tables.match.find((m) => m.id === bmId);
  if (!cur || cur.opponent1?.id == null || cur.opponent2?.id == null) throw new BracketError('not_ready');
  if (isHiddenGrandFinalReset(tables, cur)) throw new BracketError('not_ready');
  const before = doneElsewhere(tables, bmId);
  const side = (me: 'a' | 'b', score: number | null) => {
    const won = r.winner === me;
    if (r.forfeit) return won ? {} : { forfeit: true };
    return won ? { score: score!, result: 'win' as const } : { score: score! };
  };
  try {
    if (cur.status >= DONE) await manager.reset.matchResults(bmId);
    await manager.update.match({ id: bmId, opponent1: side('a', r.scoreA), opponent2: side('b', r.scoreB) });
  } catch (err) {
    if (err instanceof Error && /locked/i.test(err.message)) throw new BracketError('locked');
    throw err;
  }
  const after = doneElsewhere(tables, bmId);
  for (const [id, snap] of before) {
    const now = after.get(id);
    if (now !== undefined && now !== snap) throw new BracketError('locked');
  }
  return snapshot(store);
}

export function bracketMatches(data: BracketData): BracketMatch[] {
  const t = data.tables as unknown as Tables;
  const entryOf = new Map(t.participant.map((p) => [p.id, Number(p.name)]));
  const groupNo = new Map(t.group.map((g) => [g.id, g.number]));
  const roundNo = new Map(t.round.map((r) => [r.id, r.number]));
  const out: BracketMatch[] = [];
  for (const m of t.match) {
    if (m.opponent1 === null || m.opponent2 === null) continue;
    if (isHiddenGrandFinalReset(t, m)) continue;
    const group = groupNo.get(m.group_id)!;
    const round = roundNo.get(m.round_id)!;
    const a = m.opponent1.id === null ? null : entryOf.get(m.opponent1.id) ?? null;
    const b = m.opponent2.id === null ? null : entryOf.get(m.opponent2.id) ?? null;
    const done = m.status >= DONE;
    const winner = m.opponent1.result === 'win' ? a : m.opponent2.result === 'win' ? b : null;
    out.push({
      bmId: m.id, group, round, number: m.number, a, b,
      state: done ? 'done' : a !== null && b !== null ? 'ready' : 'pending',
      winner: done ? winner : null,
      scoreA: done ? m.opponent1.score ?? null : null, scoreB: done ? m.opponent2.score ?? null : null,
      forfeit: done && (m.opponent1.forfeit === true || m.opponent2.forfeit === true),
    });
  }
  return out;
}

export function bracketComplete(data: BracketData): boolean {
  const ms = bracketMatches(data);
  return ms.length > 0 && ms.every((m) => m.state === 'done');
}

export async function bracketRanks(data: BracketData): Promise<{ entryId: number; rank: number }[]> {
  const { manager } = open(data);
  const rows = (await manager.get.finalStandings(STAGE)) as { name: string; rank: number }[];
  return rows.map((r) => ({ entryId: Number(r.name), rank: r.rank }));
}

export function bracketGroups(data: BracketData): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of bracketMatches(data)) {
    if (m.a !== null) out.set(m.a, m.group);
    if (m.b !== null) out.set(m.b, m.group);
  }
  return out;
}
