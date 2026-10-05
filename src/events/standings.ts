/**
 * Ranks a table stage (tournaments spec section 3; plan T2). Pure. Swiss
 * orders by points, Buchholz (median from 5 rounds), campaign score
 * difference, head-to-head, seed. League and round robin order by wins,
 * head-to-head, score difference, Buchholz, seed. Head-to-head is counted
 * among the teams still tied at that step only. A bye is a win worth a point,
 * with no opponent and no score; a forfeit counts as a win and a loss with no
 * score. Entries that are out (disqualified) are ranked after everyone else.
 */

export type TableKind = 'swiss' | 'league' | 'round_robin';
export interface TableResult { a: number; b: number | null; winner: number; scoreA: number | null; scoreB: number | null }
export interface TableEntry { id: number; seed: number; out: boolean }
export interface StandingRow {
  entryId: number; rank: number; played: number; wins: number; losses: number; byes: number; points: number;
  buchholz: number; scoreDiff: number; out: boolean;
}

type Key = (ids: number[]) => Map<number, number>;

export function standings(kind: TableKind, entries: TableEntry[], results: TableResult[], o: { rounds: number }): StandingRow[] {
  const rows = new Map<number, StandingRow>(entries.map((e) => [e.id, {
    entryId: e.id, rank: 0, played: 0, wins: 0, losses: 0, byes: 0, points: 0, buchholz: 0, scoreDiff: 0, out: e.out,
  }]));
  const seed = new Map(entries.map((e) => [e.id, e.seed]));
  const opponents = new Map<number, number[]>(entries.map((e) => [e.id, []]));
  const beat = new Map<string, number>();

  for (const r of results) {
    if (r.b === null) {
      const row = rows.get(r.a);
      if (row) { row.byes++; row.wins++; row.points++; }
      continue;
    }
    const sides: [number, number, number | null, number | null][] = [[r.a, r.b, r.scoreA, r.scoreB], [r.b, r.a, r.scoreB, r.scoreA]];
    for (const [me, them, mine, theirs] of sides) {
      const row = rows.get(me);
      if (!row) continue;
      row.played++;
      if (r.winner === me) { row.wins++; row.points++; } else row.losses++;
      if (mine !== null && theirs !== null) row.scoreDiff += mine - theirs;
      opponents.get(me)!.push(them);
    }
    const loser = r.winner === r.a ? r.b : r.a;
    beat.set(`${r.winner}:${loser}`, (beat.get(`${r.winner}:${loser}`) ?? 0) + 1);
  }

  for (const row of rows.values()) {
    let pts = opponents.get(row.entryId)!.map((id) => rows.get(id)?.points ?? 0);
    if (kind === 'swiss' && o.rounds >= 5 && pts.length >= 3) pts = [...pts].sort((x, y) => x - y).slice(1, -1);
    row.buchholz = pts.reduce((s, p) => s + p, 0);
  }

  const by = (f: (r: StandingRow) => number): Key => (ids) => new Map(ids.map((id) => [id, f(rows.get(id)!)]));
  const headToHead: Key = (ids) => new Map(ids.map((id) => [id, ids.reduce((n, other) => n + (other === id ? 0 : beat.get(`${id}:${other}`) ?? 0), 0)]));
  const bySeed: Key = (ids) => new Map(ids.map((id) => [id, -(seed.get(id) ?? 0)]));
  const keys: Key[] = kind === 'swiss'
    ? [by((r) => r.points), by((r) => r.buchholz), by((r) => r.scoreDiff), headToHead, bySeed]
    : [by((r) => r.wins), headToHead, by((r) => r.scoreDiff), by((r) => r.buchholz), bySeed];

  const sort = (ids: number[], ks: Key[]): number[] => {
    if (ids.length <= 1 || ks.length === 0) return ids;
    const values = ks[0](ids);
    const bands = new Map<number, number[]>();
    for (const id of ids) {
      const v = values.get(id)!;
      bands.set(v, [...(bands.get(v) ?? []), id]);
    }
    return [...bands.keys()].sort((x, y) => y - x).flatMap((v) => sort(bands.get(v)!, ks.slice(1)));
  };

  const ids = entries.map((e) => e.id);
  const ranked = [...sort(ids.filter((id) => !rows.get(id)!.out), keys), ...sort(ids.filter((id) => rows.get(id)!.out), keys)];
  return ranked.map((id, i) => ({ ...rows.get(id)!, rank: i + 1 }));
}
