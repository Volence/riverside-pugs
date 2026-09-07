import type { MatchResult, Winner } from './api';

export const CAMPAIGN_NAMES: Record<string, string> = {
  no_mercy: 'No Mercy',
  death_toll: 'Death Toll',
  dead_air: 'Dead Air',
  blood_harvest: 'Blood Harvest',
};

export function campaignName(slug: string): string {
  return CAMPAIGN_NAMES[slug] ?? slug;
}

export const RESULT_LABEL: Record<MatchResult, string> = { win: 'W', loss: 'L', draw: 'D' };

export function winnerLabel(winner: Winner): string {
  return winner === 'draw' ? 'Draw' : `Team ${winner.toUpperCase()}`;
}

/** `2026-09-06T04:12:33.000Z` → `2026-09-06 04:12`. Matches the previous
 *  frontend's formatting exactly: these are already local-ish strings from
 *  SQLite and are not re-zoned here. */
export function fmtDate(iso: string | null | undefined): string {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '';
}

/** An SR delta, always signed, using a real minus (U+2212) rather than a hyphen
 *  so a column of deltas aligns and reads as arithmetic. Zero prints as ±0 so
 *  "rating did not move" is visibly different from a missing value. */
export function fmtDelta(d: number): string {
  if (d > 0) return `+${d}`;
  if (d < 0) return `−${Math.abs(d)}`;
  return '±0';
}

export function deltaClass(d: number): string {
  return d > 0 ? 'delta delta--up' : d < 0 ? 'delta delta--down' : 'delta';
}

/** `mm:ss` for the ready-check/vote countdown and the document title. */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function secondsLeft(deadline: number, now: number = Date.now()): number {
  return Math.max(0, Math.round((deadline - now) / 1000));
}

/** Human labels for skill stat keys. Duplicates the registry in
 *  src/statKeys.ts rather than importing it, because web/ cannot import
 *  server code. Kept here so MatchDetail and Profile share one copy. */
export const STAT_LABELS: Record<string, string> = {
  skeets: 'Skeets', team_skeets: 'Team skeets', skeets_hurt: 'Hurt skeets',
  skeet_assists: 'Skeet assists', skeets_shotgun: 'Shotgun skeets',
  skeets_sniper: 'Sniper skeets', skeets_melee: 'Melee skeets',
  deadstops: 'Deadstops', boomer_pops: 'Boomer pops', crowns: 'Crowns',
  draw_crowns: 'Draw crowns', tongue_cuts: 'Tongue cuts', self_clears: 'Self clears',
  rock_skeets: 'Rock skeets', clears: 'Clears', insta_clears: 'Insta clears',
  dps_landed: 'DPs landed', pounce_damage_high: 'High pounce damage',
  biles_landed: 'Biles landed', survivors_biled: 'Survivors biled',
  tank_rocks_landed: 'Tank rocks landed', times_skeeted: 'Times skeeted',
  times_deadstopped: 'Times deadstopped', tank_damage: 'Tank damage',
  damage_as_si: 'Damage as SI', tank_punches: 'Tank punches',
};

export function labelFor(key: string): string {
  return STAT_LABELS[key] ?? key;
}

/** SVG polyline points for the SR-over-time graph.
 *
 *  Returns null when there are fewer than two points, because a one-match
 *  "graph" is a dot that implies a trend it cannot support, so callers render a
 *  note instead. A flat series (span 0) is drawn as a centered horizontal line
 *  rather than dividing by zero. */
export function sparklinePoints(values: number[], w: number, h: number, pad = 5): string | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const usable = h - pad * 2;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = span === 0 ? h / 2 : h - pad - ((v - min) / span) * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
