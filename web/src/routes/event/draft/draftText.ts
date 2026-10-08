// web/src/routes/event/draft/draftText.ts
import type { DraftPickView, PlayerCardView } from '../../../api';

/** The room's status lines (drafts plan D2b1 Ruling 1 and 22). */
export const STATUS_TEXT = {
  none: 'Staff have not chosen live picking for this draft. Captains can still read the player cards and build a pick list, used if captains pick live.',
  ready: 'The draft starts when staff press Start. Captains: build your pick list now. It is used if you are away when your turn comes or your clock runs out.',
  paused: 'Paused by staff.',
  done: 'The draft is over. Staff publish the teams next.',
} as const;

export const CLASS_NAME = { hunter: 'Hunter', smoker: 'Smoker', boomer: 'Boomer', tank: 'Tank' } as const;

/** A pick's identity for the reveal: the same slot picked again after an
 *  undo is a new pick. */
export const pickKey = (p: DraftPickView): string => `${p.pickNo}:${p.at}:${p.steamid}`;

/** The picks this page has not shown yet. The first load (seen null) marks
 *  everything seen and reveals nothing. */
export function freshPicks(seen: ReadonlySet<string> | null, picks: DraftPickView[]): { seen: Set<string>; fresh: DraftPickView[] } {
  const next = new Set(picks.map(pickKey));
  return { seen: next, fresh: seen === null ? [] : picks.filter((p) => !seen.has(pickKey(p))) };
}

export type PoolSort = 'sr' | 'name';
export function sortedPool(cards: PlayerCardView[], filter: string, sort: PoolSort): PlayerCardView[] {
  const f = filter.trim().toLowerCase();
  const byName = (a: PlayerCardView, b: PlayerCardView) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return cards.filter((c) => f === '' || c.name.toLowerCase().includes(f))
    .sort((a, b) => (sort === 'sr' ? b.sr - a.sr || byName(a, b) : byName(a, b)));
}

/** How far SR moved across the card's trend; null with under two points. */
export function trendText(trend: number[]): string | null {
  if (trend.length < 2) return null;
  const d = trend[trend.length - 1]! - trend[0]!;
  return `${d >= 0 ? '+' : ''}${d} SR across the last ${trend.length} rated games`;
}
