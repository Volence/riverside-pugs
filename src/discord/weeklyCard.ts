import { escapeName } from '../identity.js';
import type { AwardGroup, AwardKind, AwardResult, Winner } from '../weeklyAwards.js';
import type { FrozenWeek } from '../weeklyStore.js';
import type { MessagePayload } from './transport.js';

/**
 * The two weekly messages: a recap written like the owner's hand-made
 * "Friday recap" (plain markdown, bold numbers, match numbers named), then
 * the awards as one embed. Two messages because a plain message is capped at
 * 2,000 characters and the two together are longer. No emoji anywhere, by
 * the owner's ruling. Names are escaped at the source (escapeName) and no
 * message may ping anyone.
 */

const RECAP_LIMIT = 2000;
const EMBED_LIMIT = 4096;
const DAMAGE = new Set(['si_damage', 'tank_damage', 'damage_as_si', 'pounce_damage', 'hunter_damage', 'smoker_damage', 'friendly_fire']);
const GROUPS: { group: AwardGroup; title: string }[] = [
  { group: 'survivor', title: 'Survivor' },
  { group: 'infected', title: 'Infected' },
  { group: 'overall', title: 'Overall' },
  { group: 'shame', title: 'Shame' },
];

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const n1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const b = (s: string | number) => `**${s}**`;
const name = (s: string) => escapeName(s);

export function weekLabel(week: string): string {
  return new Date(`${week}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatAwardValue(key: string, kind: AwardKind, w: Winner): string {
  if (kind === 'avg') return `${DAMAGE.has(key) ? n0(w.value) : n1(w.value)}/g`;
  if (kind === 'total') return `${n0(w.value)} total`;
  switch (key) {
    case 'sr_climb': return `+${n0(w.value)} SR`;
    case 'wins': return `${n0(w.value)} wins`;
    case 'win_streak': return `${n0(w.value)} in a row`;
    case 'matches': return `${n0(w.value)} games`;
    case 'win_rate': return w.detail ?? `${Math.round(w.value * 100)}%`;
    case 'slow_ready': return `${n0(w.value)}s per ready-up`;
    default: return `${DAMAGE.has(key) ? n0(w.value) : n1(w.value)}/g`;
  }
}

const names = (ws: Winner[]) => ws.map((w) => name(w.name)).join(' & ');
const sameSet = (a: Winner[], c: Winner[]) =>
  a.length === c.length && a.every((w) => c.some((x) => x.steamid === w.steamid));

function awardLine(label: string, parts: AwardResult[]): string {
  const avg = parts.find((p) => p.kind === 'avg');
  const tot = parts.find((p) => p.kind === 'total');
  const single = parts.find((p) => p.kind === 'single');
  const v = (p: AwardResult) => formatAwardValue(p.key, p.kind, p.winners[0]);
  if (single) return `${b(label)}: ${names(single.winners)} ${v(single)}`;
  if (avg && tot && sameSet(avg.winners, tot.winners)) return `${b(label)}: ${names(avg.winners)} (${v(avg)}, ${v(tot)})`;
  const bits = [avg, tot].filter((p): p is AwardResult => !!p).map((p) => `${names(p.winners)} ${v(p)}`);
  return `${b(label)}: ${bits.join(', ')}`;
}

export function renderAwards(f: FrozenWeek, publicUrl: string): MessagePayload | null {
  if (f.awards.length === 0) return null;
  const sections: string[] = [];
  for (const g of GROUPS) {
    const inGroup = f.awards.filter((a) => a.group === g.group);
    if (!inGroup.length) continue;
    const keys = [...new Set(inGroup.map((a) => a.key))];
    const lines = keys.map((k) => awardLine(inGroup.find((a) => a.key === k)!.label, inGroup.filter((a) => a.key === k)));
    sections.push(`${b(g.title)}\n${lines.join('\n')}`);
  }
  const footer = `Averages need a minimum number of games that week. Full list: ${publicUrl}/leaderboard?week=${f.week}`;
  let description = `${sections.join('\n\n')}\n\n${footer}`;
  if (description.length > EMBED_LIMIT) description = `${description.slice(0, EMBED_LIMIT - 2)}..`;
  return {
    embeds: [{ title: `Weekly awards, week of ${weekLabel(f.week)}`, description }],
    components: [],
    mentionUserIds: [],
  };
}

export function renderRecap(f: FrozenWeek, _publicUrl: string): MessagePayload {
  const r = f.recap;
  const title = b(`Weekly recap, week of ${weekLabel(f.week)}`);
  const payload = (content: string): MessagePayload => ({ content, embeds: [], components: [], mentionUserIds: [] });
  if (r.matches === 0) return payload(`${title}\n\nNo matches were played this week.`);

  const head = [
    `${b(`${n0(r.matches)} matches`)} this week with ${b(`${n0(r.players)} different players`)}`,
    r.peakConcurrent > 1 ? `up to ${b(r.peakConcurrent)} games running at once` : '',
    r.busiestDay ? `and the busiest day was ${new Date(`${r.busiestDay.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} with ${b(`${r.busiestDay.matches} matches`)}` : '',
  ].filter(Boolean).join(', ') + '. Thanks everyone who queued!';

  const highlightLines = r.highlights.map((h) => `- ${b(name(h.player.name))} ${h.verb} ${b(`${n0(h.value)} ${h.label}`)} in one game (match ${h.matchId})`);
  const tail: string[] = [];
  if (r.mostQuads) tail.push(`- Match ${r.mostQuads.matchId} had ${b(`${r.mostQuads.quads} quad caps`)}`);
  for (const t of r.totals) {
    if (t.value <= 0) continue;
    tail.push(`- ${b(`${n0(t.value)} ${t.label}`)} on the week${t.leader ? `, led by ${b(name(t.leader.name))} with ${b(n0(t.leader.value))}` : ''}`);
  }

  const rest: string[] = [];
  if (r.streaks.length) {
    rest.push(`${b('Hot streaks')}\n${r.streaks.map((s) => `${b(name(s.name))} went ${b(`${s.w}-${s.l}`)}`).join(', ')}`);
  }
  if (r.iron.length) {
    const top = r.iron.filter((x) => x.games === r.iron[0].games);
    const next = r.iron.filter((x) => x.games !== r.iron[0].games);
    const who = top.map((x) => b(name(x.name))).join(' and ');
    const line = `${who} ${top.length > 1 ? 'each ' : ''}played ${b(`${r.iron[0].games} games`)}`
      + (next.length ? `, with ${next.map((x) => b(name(x.name))).join(' and ')} close behind at ${next[0].games}` : '');
    rest.push(`${b('Iron players')}\n${line}`);
  }
  if (r.closest) {
    const hi = Math.max(r.closest.a, r.closest.b); const lo = Math.min(r.closest.a, r.closest.b);
    rest.push(`${b('Closest game:')} match ${r.closest.matchId} on ${r.closest.campaign}, ${b(`${hi} to ${lo}`)}`);
  }

  const build = (hl: string[]) => [
    title, head,
    hl.length + tail.length ? `${b('Highlights')}\n${[...hl, ...tail].join('\n')}` : '',
    ...rest,
  ].filter(Boolean).join('\n\n');
  let hl = highlightLines;
  let content = build(hl);
  while (content.length > RECAP_LIMIT && hl.length) { hl = hl.slice(0, -1); content = build(hl); }
  if (content.length > RECAP_LIMIT) content = `${content.slice(0, RECAP_LIMIT - 2)}..`;
  return payload(content);
}
