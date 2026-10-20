import { api, type WrappedCommunity, type WrappedPlayer, type WrappedSeason } from './api';
import { campaignName, chapterOrdinal, mapName } from './format';

/**
 * Season Wrapped, the pure half: which cards a deck gets, and the small
 * calculations the cards print. The page (routes/Wrapped.tsx) only draws.
 *
 * Card order and wording follow the approved mockup; the gates follow the
 * spec (docs/season-wrapped.md): a card whose data is empty is skipped, never
 * shown with a zero.
 */

export type CardKey =
  // Before the deck: signed out, or signed in with no games that season.
  | 'login' | 'nodeck'
  // A player's own cards.
  | 'intro' | 'numbers' | 'standing' | 'streak' | 'campaign' | 'people' | 'rivals' | 'signature'
  | 'bestMap' | 'sides' | 'endorsed' | 'trophies' | 'when' | 'started' | 'closer' | 'dropin'
  // Everyone's.
  | 'c_numbers' | 'c_standings' | 'c_leaders' | 'c_moments' | 'next';

/** The player cards for one deck, in order. */
export function playerCards(p: WrappedPlayer): CardKey[] {
  if (p.tier === 'dropin') return ['dropin'];
  const has: Record<string, boolean> = {
    intro: true,
    numbers: true,
    standing: p.standing !== null,
    streak: p.streaks.win >= 3,
    campaign: Boolean(p.campaigns.best || p.maps.best),
    people: Boolean(p.people.mostWith || p.people.bestDuo),
    rivals: Boolean(p.rivals.nemesis || p.rivals.favourite),
    signature: Boolean(p.signature && p.signature.length > 0),
    bestMap: bestMapPick(p) !== null,
    sides: p.sides.survivorAvg !== null && p.sides.concededAvg !== null,
    // Endorsements started partway through Season 0, so a player with none
    // may simply have played before they existed: either way, no card.
    endorsed: endorseTotal(p) > 0,
    trophies: p.trophies.weekly.length > 0 || p.trophies.skeetTriples > 0,
    when: p.hours.some((n) => n > 0),
    started: true,
    closer: true,
  };
  const order: CardKey[] = p.tier === 'full'
    ? ['intro', 'numbers', 'standing', 'streak', 'campaign', 'people', 'rivals', 'signature', 'bestMap', 'sides', 'endorsed', 'trophies', 'when', 'started']
    // The short deck: the cards a handful of games can carry. People is the
    // most-played-with line only (a best duo needs more games together).
    : ['intro', 'numbers', 'standing', 'bestMap', 'sides', 'when', 'started', 'closer'];
  const short = p.tier === 'short';
  return order.filter((k) => (k === 'people' && short ? Boolean(p.people.mostWith) : has[k]));
}

export function communityCards(c: WrappedCommunity): CardKey[] {
  const out: CardKey[] = ['c_numbers'];
  if (c.top10.length > 0) out.push('c_standings');
  if (leaderPairs(c).length > 0) out.push('c_leaders');
  if (c.moments.closest.length > 0 || c.moments.blowout || Object.keys(c.moments.bestSingleMap).length > 0) out.push('c_moments');
  out.push('next');
  return out;
}

/** The whole deck: the viewer's (or the shared player's) cards, then the community's. */
export function buildDeck(
  player: WrappedPlayer | null, community: WrappedCommunity, opts: { loggedIn: boolean; shared?: boolean },
): CardKey[] {
  const lead: CardKey[] = player
    ? playerCards(player)
    : opts.shared ? [] : opts.loggedIn ? ['nodeck'] : ['login'];
  return [...lead, ...communityCards(community)];
}

/** Short decks keep only the most-played-with line on the people card. */
export const peopleShowsDuo = (p: WrappedPlayer): boolean => p.tier === 'full';

export const endorseTotal = (p: WrappedPlayer): number =>
  Object.values(p.endorsements.counts).reduce((a, b) => a + b, 0);

/** The single-map record a best-map card leads with: SI damage first, as in
 *  the mockup, then the other kinds of map in order. */
export function bestMapPick(p: WrappedPlayer): { key: string; label: string; matchId: number; map: string | null; value: number } | null {
  const order: [keyof WrappedPlayer['bestMap'], string][] = [
    ['sidmg', 'SI damage'], ['damage_as_si', 'damage as SI'], ['tank_damage', 'tank damage'], ['ck', 'common kills'], ['skeets', 'skeets'],
  ];
  for (const [key, label] of order) {
    const r = p.bestMap[key];
    if (r && r.value > 0) return { key, label, ...r };
  }
  return null;
}

/** "Top X%": the place within the pool, rounded up so #1 of 103 is Top 1%. */
export const topPct = (rank: number, of: number): number => Math.max(1, Math.ceil((rank / Math.max(1, of)) * 100));

/** Season 0's every player started at 833 SR (the default rating). Later
 *  seasons start from a soft reset, so the first rated point stands in. */
export const SEASON0_START_SR = 833;

/** Where the standing card puts its weight. A peak only gets its own beat
 *  when it was at least 100 above where they finished; otherwise SR is
 *  mu - 2 sigma and still climbing as sigma shrinks, so the climb is the story. */
export function standingBeat(
  s: NonNullable<WrappedPlayer['standing']>, seasonId: number,
): { kind: 'peak' } | { kind: 'climb'; from: number; to: number } | { kind: 'flat' } {
  if (s.peakSr - s.sr >= 100) return { kind: 'peak' };
  const from = seasonId === 1 ? SEASON0_START_SR : (s.spark[0] ?? s.sr);
  return s.sr > from ? { kind: 'climb', from, to: s.sr } : { kind: 'flat' };
}

/** Survivor or infected: team numbers, never personal credit. */
export function sidesVerdict(s: WrappedPlayer['sides']): { surv: number; inf: number; verdict: string } | null {
  if (s.survivorAvg === null || s.concededAvg === null) return null;
  const surv = Math.round(s.survivorAvg - s.communityAvg);
  const inf = Math.round(s.communityAvg - s.concededAvg);
  const verdict = surv - inf >= 15 ? 'A survivor main.' : inf - surv >= 15 ? 'An infected main.' : 'Even on both sides.';
  return { surv, inf, verdict };
}

/** Per-match figures: whole numbers once they are big, two places when small. */
export function fmtPerMatch(v: number): string {
  if (v >= 100) return Math.round(v).toLocaleString('en-US');
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** Big season totals in a phone-width row: 1,258,662 reads as 1.26M. */
export function fmtBig(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 100_000) return `${Math.round(v / 1000)}K`;
  return Math.round(v).toLocaleString('en-US');
}

export const fmtNum = (v: number): string => v.toLocaleString('en-US');

export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** sqlite UTC text (YYYY-MM-DD HH:MM:SS, or a bare date) to epoch ms. */
export function utcMs(s: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00Z`);
  return Date.parse(s.includes('T') ? (s.endsWith('Z') ? s : `${s}Z`) : `${s.replace(' ', 'T')}Z`);
}

/** "Sep 11". A bare date (a night, already bucketed by the server) is read
 *  as a calendar day; a timestamp is shown in the viewer's own zone. */
export function fmtDay(s: string | null | undefined): string {
  if (!s) return '';
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(s);
  return new Date(utcMs(s)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(bare ? { timeZone: 'UTC' } : {}) });
}

/** A map id as "No Mercy 2" for the four stock campaigns, whose map names
 *  carry the campaign word; anything else reads as its chapter title. */
const STOCK_WORDS: Record<string, string> = { hospital: 'no_mercy', smalltown: 'death_toll', airport: 'dead_air', farm: 'blood_harvest' };
export function wrappedMapName(map: string | null): string {
  if (!map) return '';
  const word = /^l4d_(?:vs_)?([a-z]+)\d+_/.exec(map.toLowerCase())?.[1];
  const campaign = word ? STOCK_WORDS[word] : undefined;
  const n = chapterOrdinal(map);
  return campaign && n !== null ? `${campaignName(campaign)} ${n}` : mapName(map);
}

// ---------- When you play ----------

/** The viewer's UTC offset in hours at a moment (east positive). Fractional
 *  zones round to the nearest hour: the histogram is hourly. */
export function zoneShiftHours(at: Date): number {
  return Math.round(-at.getTimezoneOffset() / 60);
}

/** Rotate a 168-slot UTC hour-of-week histogram (index = day * 24 + hour,
 *  day 0 = Sunday) into a zone `shift` hours east of UTC. */
export function rotateHours(hours: readonly number[], shift: number): number[] {
  const out = new Array<number>(168).fill(0);
  hours.forEach((n, i) => { out[(((i + shift) % 168) + 168) % 168] += n; });
  return out;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Peak hour, share after midnight (midnight to 5 am) and the top day, from a
 *  histogram already in local time. Null when it is empty. */
export function whenYouPlay(local: readonly number[]): { peakHour: number; peakShare: number; afterMidnight: number; topDay: number; total: number } | null {
  const total = local.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const byHour = Array.from({ length: 24 }, (_, h) => [0, 1, 2, 3, 4, 5, 6].reduce((s, d) => s + local[d * 24 + h], 0));
  const byDay = Array.from({ length: 7 }, (_, d) => local.slice(d * 24, d * 24 + 24).reduce((a, b) => a + b, 0));
  // Ties go to the later evening hour, where nearly all of the play is.
  let peakHour = 0;
  for (let h = 0; h < 24; h++) if (byHour[h] > byHour[peakHour]) peakHour = h;
  let topDay = 0;
  for (let d = 0; d < 7; d++) if (byDay[d] > byDay[topDay]) topDay = d;
  const after = byHour.slice(0, 5).reduce((a, b) => a + b, 0);
  return { peakHour, peakShare: Math.round((byHour[peakHour] / total) * 100), afterMidnight: Math.round((after / total) * 100), topDay, total };
}

export function hourLabel(h: number): string {
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

/** The viewer's zone as a short name (EDT), else its IANA id. */
export function zoneName(at: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
    return part?.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch { return 'your time'; }
}

/** The moment a season's play is read at for the zone: its midpoint, so a
 *  season that crosses a clock change uses the side most of it was on. */
export function seasonMidpoint(c: WrappedCommunity): Date {
  const a = utcMs(c.overview.first ?? c.season.startedAt);
  const b = utcMs(c.overview.last ?? c.season.endedAt ?? c.season.startedAt);
  return new Date(Number.isNaN(a) || Number.isNaN(b) ? Date.now() : (a + b) / 2);
}

// ---------- Trophy shelf ----------

/** Weekly awards grouped by label, most won first. */
export function groupAwards(weekly: WrappedPlayer['trophies']['weekly']): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const w of weekly) m.set(w.label, (m.get(w.label) ?? 0) + 1);
  return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function totalChips(t: WrappedPlayer['trophies']['totals']): { label: string; value: number }[] {
  return ([
    ['common kills', t.ck], ['skeets', t.skeets], ['witch crowns', t.crowns], ['rock skeets', t.rockSkeets],
    ['quad caps', t.quadCaps], ['revives', t.revives], ['damage pounces', t.dps],
  ] as [string, number][]).filter(([, v]) => v > 0).map(([label, value]) => ({ label, value }));
}

// ---------- Community leaders ----------

/** Season leaders: each total beside its per-match leader, so the board is
 *  not the same two volume players on every line. */
const LEADER_PAIRS: [total: string, perMatch: string | null, label: string][] = [
  ['skeets', 'skeets_pm', 'Skeets'],
  ['sidmg', 'sidmg_pm', 'SI damage'],
  ['crowns', 'crowns_pm', 'Witch crowns'],
  ['damage_as_si', 'damage_as_si_pm', 'Damage as SI'],
  ['matches', null, 'Most matches'],
];
export function leaderPairs(c: WrappedCommunity): { label: string; total: { steamid: string; name: string; value: number }; perMatch: { steamid: string; name: string; value: number } | null }[] {
  return LEADER_PAIRS.flatMap(([t, pm, label]) => {
    const total = c.leaders[t]?.[0];
    if (!total) return [];
    return [{ label, total, perMatch: (pm && c.leaders[pm]?.[0]) || null }];
  });
}

// ---------- Entry points ----------

/** How long the home page points at a new Wrapped. */
export const WRAPPED_FRESH_DAYS = 30;

let seasons: Promise<WrappedSeason[]> | null = null;
/** GET /api/wrapped once per page load, shared by the home strip and the
 *  profile link. An error reads as "none yet" and is tried again next time. */
export function loadWrappedSeasons(): Promise<WrappedSeason[]> {
  seasons ??= api.wrappedSeasons().then((r) => r.seasons).catch(() => { seasons = null; return []; });
  return seasons;
}
/** Tests only. */
export function resetWrappedSeasons(): void { seasons = null; }

/** The newest Wrapped while it is still news, else null. */
export function freshWrapped(list: readonly WrappedSeason[], now = Date.now()): WrappedSeason | null {
  const latest = list[0];
  if (!latest) return null;
  const t = utcMs(latest.frozenAt);
  return !Number.isNaN(t) && now - t < WRAPPED_FRESH_DAYS * 86_400_000 ? latest : null;
}
