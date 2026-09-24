import type { PublicRow } from '../../api';
import { fmtValue, isShareMetric } from '../admin/balance/format';

/** Mirrors REAL_MIN_MATCHES in src/metrics/compare/stats.ts: the minimum
 *  matches a side needs for a "real" change to be possible. A finished
 *  previous patch cannot gain more matches, so a too_early row whose
 *  previous side (nA) is already short of this reads as a flat statement
 *  rather than a countdown that will never finish. */
const MIN_MATCHES = 10;

/** Per-spawn rates that cannot exceed one per spawn, read as shares by their public labels. */
const PUBLIC_PERCENT = new Set(['hunter.skeet_rate', 'boomer.pop_rate']);
const isPercent = (id: string) => isShareMetric(id) || PUBLIC_PERCENT.has(id);
const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '');

export function publicValue(metric: string, v: number | null): string {
  if (v === null) return 'n/a';
  return isPercent(metric) ? `${Math.round(v * 100)}%` : fmtValue(metric, v);
}

export function publicDelta(metric: string, d: number | null): string {
  if (d === null) return '';
  if (isPercent(metric)) { const r = Math.round(d * 100); return `${sign(r)}${Math.abs(r)} pts`; }
  const s = fmtValue(metric, Math.abs(d));
  return /^0(\.0+)?( |$)/.test(s) ? s : `${sign(d)}${s}`;
}

/** "1 match", "0 matches", "8 rounds". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `live`: this patch is still being played (PublicEntry.live), so a too_early
 *  row can still gain matches. */
export function verdictSentence(r: PublicRow, live: boolean): string {
  switch (r.verdict) {
    case 'real': {
      const range = r.lo !== null && r.hi !== null ? `, likely between ${publicDelta(r.metric, r.lo)} and ${publicDelta(r.metric, r.hi)}` : '';
      return `Measured change: ${r.label} went from ${publicValue(r.metric, r.a)} to ${publicValue(r.metric, r.b)} (${publicDelta(r.metric, r.diff)}${range}).`;
    }
    case 'noise': return 'No clear change: within normal variation.';
    case 'too_early':
      if (!live) return 'Too early to tell: too few matches were measured on these patches to tell.';
      if (r.nA < MIN_MATCHES) return 'Too early to tell: the previous patch has too few measured matches to compare against.';
      if (r.moreMatches === null) return 'Too early to tell: more matches needed.';
      if (r.moreMatches >= 500) return 'Too early to tell: about 500+ more matches needed.';
      return `Too early to tell: about ${r.moreMatches} more match${r.moreMatches === 1 ? '' : 'es'} needed.`;
    case 'no_data':
      if (r.noSharedMaps) return 'No maps in common with the previous patch, so no comparison.';
      if (r.nB === 0) return 'Not measured for this patch.';
      if (r.nA === 0) return 'Not measured for the previous patch.';
      // Unreachable today (a two-sided row without values is noSharedMaps), kept as a safe default.
      return 'Not measured for this patch.';
  }
}

export function skillBannerText(s: 'differs' | 'unavailable' | null): string | null {
  if (s === 'differs') return 'The teams playing these two patches differed in skill on average, so part of any change may be the players, not the patch.';
  if (s === 'unavailable') return 'Player ratings were missing for one of the patches, so we could not check whether the teams were evenly matched.';
  return null;
}

export const APPROXIMATE_TEXT = 'Approximate: this comparison includes games from before patches were tracked automatically, so which games belong to which patch was reconstructed from dates.';

export const CHANGES_UNAVAILABLE_TEXT: Record<'historical' | 'unrecorded' | 'previous_unrecorded' | 'first', string> = {
  historical: 'This patch was reconstructed from dates, so there is no recorded list of settings. See the notes above.',
  unrecorded: 'No list of settings was recorded for this patch. See the notes above.',
  previous_unrecorded: 'The previous patch predates recorded settings, so the list of changes is not available. See the notes above.',
  first: 'First tracked patch: nothing earlier to compare with.',
};

/** "What changed" for the first tracked patch; CHANGES_UNAVAILABLE_TEXT.first reads under "Measured effect". */
export const FIRST_CHANGES_TEXT = 'First tracked patch, so there is no earlier patch to list changes against.';
