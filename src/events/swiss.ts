import { standings, type TableResult } from './standings.js';

/**
 * Pairs one Swiss round (tournaments spec section 3; plan T2). Pure. Round 1
 * (no result among these entries yet) pairs seed order top half against
 * bottom half. Later rounds take the Swiss standings order and pair from the
 * top, each team with the first one below it it has not met, backtracking
 * when the rest cannot be paired; only when no repeat-free pairing exists at
 * all is a rematch allowed (Ruling 11). With an odd count the bye goes first,
 * to the lowest-ranked entry among those with the fewest byes (Ruling 10);
 * when that bye leaves no repeat-free pairing, the next such entry up takes
 * it instead, and only when none does are rematches allowed, as few as the
 * top-down pass can manage rather than straight 1v2, 3v4.
 */

export interface Pairing { pairs: [number, number][]; bye: number | null }

/** Enough for any field this site will see; past it, rematches are allowed. */
const STEP_CAP = 200_000;

export function pairSwiss(entries: { id: number; seed: number }[], results: TableResult[], rounds: number): Pairing {
  if (entries.length === 0) return { pairs: [], bye: null };
  const ids = new Set(entries.map((e) => e.id));
  // Keeps results against opponents no longer in the field: the match happened, and a removed opponent adds 0 Buchholz.
  const mine = results.filter((r) => ids.has(r.a) || (r.b !== null && ids.has(r.b)));
  const first = mine.length === 0;
  const order = first
    ? [...entries].sort((x, y) => x.seed - y.seed).map((e) => e.id)
    : standings('swiss', entries.map((e) => ({ ...e, out: false })), mine, { rounds }).map((s) => s.entryId);

  // Bye candidates, best first: the fewest byes, lowest-ranked first.
  let candidates: (number | null)[] = [null];
  if (order.length % 2 === 1) {
    const byes = new Map<number, number>();
    for (const r of mine) if (r.b === null) byes.set(r.a, (byes.get(r.a) ?? 0) + 1);
    const fewest = Math.min(...order.map((id) => byes.get(id) ?? 0));
    candidates = [...order].reverse().filter((id) => (byes.get(id) ?? 0) === fewest);
  }
  const without = (bye: number | null) => (bye === null ? order : order.filter((id) => id !== bye));

  if (first) {
    const bye = candidates[0]!;
    const rest = without(bye);
    const half = rest.length / 2;
    return { pairs: rest.slice(0, half).map((a, i): [number, number] => [a, rest[half + i]!]), bye };
  }
  const met = new Set<string>();
  for (const r of mine) if (r.b !== null) { met.add(`${r.a}:${r.b}`); met.add(`${r.b}:${r.a}`); }
  for (const bye of candidates) {
    const pairs = pairOff(without(bye), met);
    if (pairs) return { pairs, bye };
  }
  return { pairs: fewestRematches(without(candidates[0]!), met), bye: candidates[0]! };
}

/** Top down, each team with the first one below it it has not met, else
 *  the first one left: used only when no repeat-free pairing exists. */
function fewestRematches(order: number[], met: Set<string>): [number, number][] {
  const left = [...order];
  const out: [number, number][] = [];
  while (left.length > 1) {
    const a = left.shift()!;
    const k = left.findIndex((b) => !met.has(`${a}:${b}`));
    const [b] = left.splice(k === -1 ? 0 : k, 1);
    out.push([a, b!]);
  }
  return out;
}

function pairOff(order: number[], met: Set<string>): [number, number][] | null {
  let steps = 0;
  const used = order.map(() => false);
  const out: [number, number][] = [];
  const go = (): boolean => {
    if (++steps > STEP_CAP) return false;
    const i = used.indexOf(false);
    if (i === -1) return true;
    used[i] = true;
    for (let j = i + 1; j < order.length; j++) {
      if (used[j] || met.has(`${order[i]}:${order[j]}`)) continue;
      used[j] = true;
      out.push([order[i]!, order[j]!]);
      if (go()) return true;
      used[j] = false;
      out.pop();
    }
    used[i] = false;
    return false;
  };
  return go() ? out : null;
}
