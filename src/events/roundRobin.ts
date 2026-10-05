import type { Pairing } from './swiss.js';

/**
 * A full round robin by the circle method (league stages with round robin
 * pairing; plan T2). Pure. The first team stays put and the rest rotate; an
 * odd field gets a bye seat, so each round one team sits out. Sides
 * alternate for the fixed team so it is not always first.
 */
export function circleRounds(ids: number[]): Pairing[] {
  const seats: (number | null)[] = [...ids];
  if (seats.length % 2 === 1) seats.push(null);
  const n = seats.length;
  const rounds: Pairing[] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [number, number][] = [];
    let bye: number | null = null;
    for (let i = 0; i < n / 2; i++) {
      const x = seats[i]!;
      const y = seats[n - 1 - i]!;
      if (x === null) bye = y;
      else if (y === null) bye = x;
      else pairs.push(i === 0 && r % 2 === 1 ? [y, x] : [x, y]);
    }
    rounds.push({ pairs, bye });
    seats.splice(1, 0, seats.pop()!);
  }
  return rounds;
}
