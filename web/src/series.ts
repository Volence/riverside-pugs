/** Mirrors src/bookings/series.ts's seriesLine and its rule for which games
 *  count: completed and not voided; a live game is simply not over yet. */
export function seriesLine(first: string, firstWins: number, secondWins: number, second: string, draws: number): string {
  const tail = draws === 0 ? '' : draws === 1 ? ', 1 draw' : `, ${draws} draws`;
  return `${first} ${firstWins} - ${secondWins} ${second}${tail}`;
}

export function notCountedLabel(g: { state: string; voided?: boolean }): string | null {
  if (g.voided) return 'Voided, not counted';
  if (g.state === 'completed' || g.state === 'live') return null;
  return 'Not finished, not counted';
}
