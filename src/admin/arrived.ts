import { isEvidence, type TimelineItem } from './timeline/types.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STEAM_KIND: Record<string, string> = {
  recent_ban: 'recent VAC or game ban',
  banned_lender: 'game borrowed from a banned account',
};

/**
 * One plain sentence saying what is new on a file since someone last marked
 * it looked at, so the queue can be read without opening every file.
 *
 * It names what arrived and how much, never a score: the analyzer's rank used
 * to sit beside this and read like a verdict. Order is fixed (input, LilAC,
 * client setting, analyzer, Steam, drops) so two rows compare at a glance.
 */
export function arrivedSince(items: readonly TimelineItem[], since: string | null): string {
  const fresh = items.filter((i) => isEvidence(i) && (since === null || i.at > since));
  const by = (source: TimelineItem['source']) => fresh.filter((i) => i.source === source);
  const parts: string[] = [];

  const input = by('input');
  if (input.length > 0) {
    const sigs = [...new Set(input.map((i) => i.kind))].sort().join(', ');
    const steady = input.some((i) => i.summary.includes('fixed rate'));
    parts.push(`${plural(input.length, 'input flag')} (${sigs})${steady ? ', steady taps' : ''}`);
  }
  const lilac = by('lilac');
  if (lilac.length > 0) {
    const counts = new Map<string, number>();
    for (const i of lilac) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
    parts.push(`Little Anti-Cheat: ${[...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ')}`);
  }
  const cvar = by('cvar');
  if (cvar.length > 0) {
    const kinds = [...new Set(cvar.map((i) => i.kind))].join(', ');
    const matches = new Set(cvar.map((i) => i.matchId ?? 'none')).size;
    parts.push(`client setting ${kinds} 0 (${plural(matches, 'match', 'matches')})`);
  }
  const analyzer = by('analyzer');
  if (analyzer.length > 0) parts.push(plural(analyzer.length, 'flagged replay moment'));
  const steam = by('steam');
  if (steam.length > 0) {
    parts.push(`Steam: ${[...new Set(steam.map((i) => STEAM_KIND[i.kind] ?? i.kind))].join(', ')}`);
  }
  if (by('drop').length > 0) parts.push('repeated connect drops');
  const conduct = by('conduct');
  if (conduct.length > 0) {
    const chat = conduct.filter((i) => i.kind === 'chat').length;
    const names = conduct.length - chat;
    const what = [chat ? plural(chat, 'chat line') : '', names ? plural(names, 'name') : ''].filter(Boolean);
    parts.push(`slurs: ${what.join(', ')}`);
  }

  return parts.join(' · ');
}
