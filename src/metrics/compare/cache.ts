import { metricsGeneration } from '../store.js';
import type { Origin, SideQuery } from './types.js';

const MAX_ENTRIES = 50;
const entries = new Map<string, { gen: number; value: unknown }>();

/** Caches `compute()` under `key` for as long as `metricsGeneration()` stays
 *  the same; a metrics write bumps the generation and invalidates every
 *  cached entry at once. Keeps at most MAX_ENTRIES, dropping the oldest. */
export function memo<T>(key: string, compute: () => T): T {
  const gen = metricsGeneration();
  const hit = entries.get(key);
  if (hit && hit.gen === gen) return hit.value as T;
  const value = compute();
  entries.delete(key);
  entries.set(key, { gen, value });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  return value;
}

const IDS_RE = /^\d{1,9}(,\d{1,9}){0,99}$/;
const MAP_RE = /^[A-Za-z0-9_()\- ]{1,64}$/;
const ORIGINS: Origin[] = ['all', 'queue', 'in_game'];

/** Validates and parses the a/b/origin/maps query params shared by the
 *  compare and metric-detail routes. Returns an error message string on any
 *  bad input rather than throwing, so the route can turn it into a 400. */
export function parseSideParams(q: Record<string, unknown>): { a: SideQuery; b: SideQuery } | string {
  const ids = (v: unknown) => (typeof v === 'string' && IDS_RE.test(v) ? v.split(',').map(Number) : null);
  const a = ids(q.a), b = ids(q.b);
  if (!a || !b) return 'a and b must be comma-separated patch ids';
  const origin = (q.origin ?? 'all') as Origin;
  if (!ORIGINS.includes(origin)) return 'origin must be all, queue or in_game';
  let maps: string[] | null = null;
  if (typeof q.maps === 'string' && q.maps !== '') {
    maps = q.maps.split(',');
    if (maps.length > 50 || !maps.every((m) => MAP_RE.test(m))) return 'maps must be a comma-separated list of map names';
  }
  return { a: { patchIds: a, origin, maps }, b: { patchIds: b, origin, maps } };
}
