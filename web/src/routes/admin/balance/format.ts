import type { CompareQuery, Verdict } from '../../../api';

export const VERDICT_LABEL: Record<Verdict, string> = {
  real: 'real change', too_early: 'too early', noise: 'probably noise', no_data: 'no data',
};
export const GROUP_LABEL: Record<string, string> = {
  outcomes: 'Outcomes', tank: 'Tank', witch: 'Witch', hunter: 'Hunter', smoker: 'Smoker',
  boomer: 'Boomer', si: 'Special infected', weapons: 'Weapons', pace: 'Pace',
};

export function isShareMetric(id: string): boolean {
  if (id.startsWith('weapons.')) return true;
  return ['round.saferoom', 'round.phase_share', 'tank.killed_rate', 'witch.startle_rate', 'witch.kill_rate', 'witch.crown_rate', 'witch.draw_crown_rate', 'smoker.kill_clear_share'].includes(id);
}
const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));
const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '');

export function fmtValue(id: string, v: number | null): string {
  if (v === null) return 'n/a';
  if (isShareMetric(id)) return `${Math.round(v * 100)}%`;
  if (id.endsWith('_s')) return `${Math.round(v)} s`;
  if (id.endsWith('_min')) return `${trim(v, 1)} min`;
  return trim(v, 2);
}

export function fmtChange(id: string, r: { diff: number | null; rel: number | null; lo: number | null; hi: number | null }): { main: string; range: string } {
  if (r.diff === null) return { main: 'n/a', range: '' };

  const formatUnit = (v: number): string => {
    if (id.endsWith('_s')) {
      const rounded = Math.round(Math.abs(v));
      return `${sign(rounded)}${rounded} s`;
    }
    if (id.endsWith('_min')) {
      const rounded = Number(trim(Math.abs(v), 1));
      return `${sign(rounded)}${rounded} min`;
    }
    const rounded = Number(trim(Math.abs(v), 2));
    return `${sign(rounded)}${rounded}`;
  };

  if (isShareMetric(id)) {
    const formatPoints = (v: number): string => {
      const rounded = Math.round(v * 100);
      return `${sign(rounded)}${Math.abs(rounded)}`;
    };
    const main = `${formatPoints(r.diff)} pts`;
    const range = r.lo === null || r.hi === null ? '' : `[${formatPoints(r.lo)}, ${formatPoints(r.hi)}]`;
    return { main, range };
  }

  if (r.rel === null) {
    const main = formatUnit(r.diff);
    const range = r.lo === null || r.hi === null ? '' : `[${formatUnit(r.lo)}, ${formatUnit(r.hi)}]`;
    return { main, range };
  }

  const roundedPercent = Math.round(r.rel * 100);
  const main = `${sign(roundedPercent)}${Math.abs(roundedPercent)}%`;
  const range = r.lo === null || r.hi === null ? '' : `[${formatUnit(r.lo)}, ${formatUnit(r.hi)}]`;
  return { main, range };
}

type View = 'ranked' | 'topic';
export function readCompareQuery(search: string, patchIds: number[]): CompareQuery & { view: View } {
  const p = new URLSearchParams(search);
  const known = new Set(patchIds);
  const ids = (k: string) => (p.get(k) ?? '').split(',').filter(Boolean).map(Number).filter((n) => known.has(n));
  const newest = patchIds[patchIds.length - 1];
  const prev = patchIds[patchIds.length - 2];
  const a = ids('a'), b = ids('b');
  const origin = p.get('origin');
  return {
    a: a.length ? a : prev !== undefined ? [prev] : [],
    b: b.length ? b : newest !== undefined ? [newest] : [],
    origin: origin === 'queue' || origin === 'in_game' ? origin : 'all',
    maps: (p.get('maps') ?? '').split(',').filter(Boolean),
    phases: p.get('phases') === 'split' ? 'split' : 'all',
    view: p.get('view') === 'topic' ? 'topic' : 'ranked',
  };
}

export function writeCompareQuery(q: CompareQuery & { view: View }): string {
  const p = new URLSearchParams({ a: q.a.join(','), b: q.b.join(',') });
  if (q.origin !== 'all') p.set('origin', q.origin);
  if (q.maps.length) p.set('maps', q.maps.join(','));
  if (q.phases !== 'all') p.set('phases', q.phases);
  if (q.view !== 'ranked') p.set('view', q.view);
  return `?${p.toString()}`;
}
