import type { DB } from '../../db.js';
import { metricsGeneration } from '../store.js';
import { triageGeneration } from '../../balanceFold.js';
import type { Origin, SideQuery } from './types.js';

const MAX_ENTRIES = 50;
const entries = new Map<string, { stamp: string; value: unknown }>();

/** A cheap fingerprint of everything a comparison reads that can change
 *  without this process's writeRoundMetrics running: a void (voided_at set),
 *  a round frozen or recomputed by another process (the backfill script),
 *  which all move the round_metric_context count or its newest computed_at,
 *  or the voided-match count, or a fold or unfold (the triage generation). Combined with the in-process generation
 *  counter, which still catches same-second rewrites. */
export function dataStamp(db: DB): string {
  const c = db.prepare('SELECT COUNT(*) AS n, MAX(computed_at) AS t FROM round_metric_context').get() as { n: number; t: string | null };
  const v = db.prepare('SELECT COUNT(*) AS n FROM matches WHERE voided_at IS NOT NULL').get() as { n: number };
  return `${metricsGeneration()}|${triageGeneration()}|${c.n}|${c.t ?? ''}|${v.n}`;
}

/** Caches `compute()` under `key` for as long as dataStamp(db) stays the
 *  same; a metrics write, a void or an out-of-process recompute changes the
 *  stamp and invalidates every cached entry at once. Keeps at most
 *  MAX_ENTRIES, dropping the oldest. */
export function memo<T>(db: DB, key: string, compute: () => T): T {
  const stamp = dataStamp(db);
  const hit = entries.get(key);
  if (hit && hit.stamp === stamp) return hit.value as T;
  const value = compute();
  entries.delete(key);
  entries.set(key, { stamp, value });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  return value;
}

const IDS_RE = /^\d{1,9}(,\d{1,9}){0,99}$/;
const MAP_RE = /^[A-Za-z0-9_()\- ]{1,64}$/;
const ORIGINS: Origin[] = ['all', 'queue', 'in_game'];
const MAX_PATCH_IDS = 20;

/** Validates and parses the a/b/origin/maps query params shared by the
 *  compare and metric-detail routes. Returns an error message string on any
 *  bad input rather than throwing, so the route can turn it into a 400. */
export function parseSideParams(q: Record<string, unknown>): { a: SideQuery; b: SideQuery } | string {
  const ids = (v: unknown) => (typeof v === 'string' && IDS_RE.test(v) ? v.split(',').map(Number) : null);
  const a = ids(q.a), b = ids(q.b);
  if (!a || !b) return 'a and b must be comma-separated patch ids';
  if (a.length > MAX_PATCH_IDS || b.length > MAX_PATCH_IDS) return 'at most 20 patches per side';
  const origin = (q.origin ?? 'all') as Origin;
  if (!ORIGINS.includes(origin)) return 'origin must be all, queue or in_game';
  let maps: string[] | null = null;
  if (typeof q.maps === 'string' && q.maps !== '') {
    maps = q.maps.split(',');
    if (maps.length > 50 || !maps.every((m) => MAP_RE.test(m))) return 'maps must be a comma-separated list of map names';
  }
  return { a: { patchIds: a, origin, maps }, b: { patchIds: b, origin, maps } };
}
