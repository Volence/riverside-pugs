import type { PublicRow } from '../../api';
import { fmtValue, isShareMetric } from '../admin/balance/format';

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

export function verdictSentence(r: PublicRow): string {
  switch (r.verdict) {
    case 'real': {
      const range = r.lo !== null && r.hi !== null ? `, likely between ${publicDelta(r.metric, r.lo)} and ${publicDelta(r.metric, r.hi)}` : '';
      return `Measured change: ${r.label} went from ${publicValue(r.metric, r.a)} to ${publicValue(r.metric, r.b)} (${publicDelta(r.metric, r.diff)}${range}).`;
    }
    case 'noise': return 'No clear change: within normal variation.';
    case 'too_early':
      if (r.moreMatches === null) return 'Too early to tell: more matches needed.';
      if (r.moreMatches >= 500) return 'Too early to tell: about 500+ more matches needed.';
      return `Too early to tell: about ${r.moreMatches} more match${r.moreMatches === 1 ? '' : 'es'} needed.`;
    case 'no_data':
      if (r.noSharedMaps) return 'No maps in common with the previous patch, so no comparison.';
      if (r.nB === 0) return 'Not measured for this patch.';
      if (r.nA === 0) return 'Not measured for the previous patch.';
      return 'Not measured for this patch.';
  }
}

export function skillBannerText(s: 'differs' | 'unavailable' | null): string | null {
  if (s === 'differs') return 'The teams playing these two patches differed in skill on average, so part of any change may be the players, not the patch.';
  if (s === 'unavailable') return 'Player ratings were missing for one of the patches, so we could not check whether the teams were evenly matched.';
  return null;
}

export const APPROXIMATE_TEXT = 'Approximate: this comparison includes games from before patches were tracked automatically, so which games belong to which patch was reconstructed from dates.';

export const CHANGES_UNAVAILABLE_TEXT: Record<'historical' | 'previous_unrecorded' | 'first', string> = {
  historical: 'This patch was reconstructed from dates, so there is no recorded list of settings. See the notes above.',
  previous_unrecorded: 'The previous patch predates recorded settings, so the list of changes is not available. See the notes above.',
  first: 'First tracked patch: nothing earlier to compare with.',
};
