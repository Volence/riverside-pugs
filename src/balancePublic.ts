import type { DB } from './db.js';
import { withoutIgnored } from './balancePatches.js';
import type { BalanceKnobs } from './balanceKnobs.js';
import { compareSides } from './metrics/compare/compare.js';
import { memo, parseSideParams } from './metrics/compare/cache.js';
import type { CompareResult } from './metrics/compare/types.js';
import { PUBLIC_METRICS } from './metrics/registry.js';
import type { Verdict } from './metrics/compare/stats.js';

export interface PublicPatch {
  id: number; number: number; name: string; notes: string;
  source: 'announced' | 'detected' | 'historical';
  /** The patch itself is a historical reconstruction. */
  approximate: boolean;
  /** First and last counted round (match_rounds.started_at, falling back to matches.ended_at). */
  firstRound: string | null; lastRound: string | null;
  matches: number; rounds: number;
  publishedAt: string | null;
}

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Every patch with its counted-round stats, ordered for the public timeline:
 *  by first counted round, else first_seen_at, then id. */
export function patchTimeline(db: DB): (PublicPatch & { hasInputs: boolean })[] {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.notes, p.source, p.first_seen_at, p.published_at, p.inputs_json IS NOT NULL AS has_inputs,
           ROW_NUMBER() OVER (ORDER BY p.first_seen_at, p.id) AS number,
           s.matches, s.rounds, s.first_round, s.last_round
    FROM balance_patches p
    LEFT JOIN (
      SELECT c.patch_id, COUNT(DISTINCT c.match_id) AS matches, COUNT(*) AS rounds,
             MIN(COALESCE(r.started_at, m.ended_at)) AS first_round, MAX(COALESCE(r.started_at, m.ended_at)) AS last_round
      FROM round_metric_context c
      JOIN matches m ON m.id = c.match_id
      LEFT JOIN match_rounds r ON r.match_id = c.match_id AND r.ordinal = c.ordinal AND r.half = c.half
      WHERE m.state = 'completed' AND m.voided_at IS NULL AND c.patch_id IS NOT NULL
      GROUP BY c.patch_id
    ) s ON s.patch_id = p.id`).all() as {
      id: number; name: string | null; notes: string; source: PublicPatch['source']; first_seen_at: string;
      published_at: string | null; has_inputs: number; number: number;
      matches: number | null; rounds: number | null; first_round: string | null; last_round: string | null }[];
  rows.sort((x, y) => (x.first_round ?? x.first_seen_at).localeCompare(y.first_round ?? y.first_seen_at) || x.id - y.id);
  return rows.map((r) => ({
    id: r.id, number: r.number,
    // A published patch whose name was later cleared still needs a heading.
    name: r.name?.trim() ? r.name : `Patch ${r.number}`,
    notes: r.notes, source: r.source, approximate: r.source === 'historical',
    firstRound: r.first_round, lastRound: r.last_round, matches: r.matches ?? 0, rounds: r.rounds ?? 0,
    publishedAt: r.published_at, hasInputs: r.has_inputs === 1,
  }));
}

const strip = ({ hasInputs: _h, ...p }: PublicPatch & { hasInputs: boolean }): PublicPatch => p;

/** Published patches newest first. */
export function listPublished(db: DB): PublicPatch[] {
  return patchTimeline(db).filter((p) => p.publishedAt !== null).reverse().map(strip);
}

export type PublishResult = { ok: true } | { ok: false; status: 400 | 404; error: string };

export function publishPatch(db: DB, id: number, published: boolean, now: string = nowSql()): PublishResult {
  const row = db.prepare('SELECT name, notes, published_at FROM balance_patches WHERE id = ?').get(id) as
    { name: string | null; notes: string; published_at: string | null } | undefined;
  if (!row) return { ok: false, status: 404, error: 'no such patch' };
  if (!published) {
    db.prepare('UPDATE balance_patches SET published_at = NULL WHERE id = ?').run(id);
    return { ok: true };
  }
  const p = patchTimeline(db).find((x) => x.id === id)!;
  const missing = [
    !row.name?.trim() && 'a name', !row.notes.trim() && 'notes', p.rounds === 0 && 'at least one counted round',
  ].filter(Boolean);
  if (missing.length) return { ok: false, status: 400, error: `publishing needs ${missing.join(', ')}` };
  if (row.published_at === null) db.prepare('UPDATE balance_patches SET published_at = ? WHERE id = ?').run(now, id);
  return { ok: true };
}

export interface PublicChanges {
  knobs: { label: string; from: string; to: string }[];
  pluginsAdded: string[]; pluginsRemoved: string[]; pluginsUpdated: string[];
  /** Watched config files and the per-map stripper directory that differ, by label. */
  files: string[];
}
export type KnobLabels = Pick<BalanceKnobs, 'cvars' | 'files' | 'dirs' | 'versionless'> & { ignored?: string[] };

/** The public-facing diff between two stored inventories: cvar changes by
 *  label, plugins added/removed/updated by bare name, and watched files or
 *  dirs by label. Never leaks a hash, size, raw inventory key or path outside
 *  the knob list. */
export function publicChanges(prevRaw: Record<string, string>, curRaw: Record<string, string>, knobs: KnobLabels | null): PublicChanges {
  const ignored = knobs?.ignored ?? [];
  const prev = withoutIgnored(prevRaw, ignored), cur = withoutIgnored(curRaw, ignored);
  const versionless = new Set(knobs?.versionless ?? []);
  const cvarLabel = new Map((knobs?.cvars ?? []).map((c) => [c.cvar, c.label]));
  const pathLabel = new Map([...(knobs?.files ?? []), ...(knobs?.dirs ?? [])].map((f) => [f.path, f.label]));
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(cur)])].sort();
  const out: PublicChanges = { knobs: [], pluginsAdded: [], pluginsRemoved: [], pluginsUpdated: [], files: [] };
  const byLabel = (a: string, b: string) => a.localeCompare(b);
  for (const k of keys) {
    const kind = k.slice(0, 2), name = k.slice(2);
    const a = prev[k], b = cur[k];
    if (a === b) continue;
    if (kind === 'c:') {
      // Present on one side only: the watch list changed, not the game.
      if (a !== undefined && b !== undefined) out.knobs.push({ label: cvarLabel.get(name) ?? name, from: a, to: b });
    } else if (kind === 'p:') {
      const plugin = name.replace(/\.smx$/, '');
      if (a === undefined) out.pluginsAdded.push(plugin);
      else if (b === undefined) out.pluginsRemoved.push(plugin);
      else if (!versionless.has(name)) out.pluginsUpdated.push(plugin);
    } else if (kind === 'f:' || kind === 'd:') {
      out.files.push(pathLabel.get(name) ?? name);
    }
    // Any other prefix is dropped on purpose (e.g. `x:<cvar>=missing` markers; the plugin change itself is listed).
  }
  out.knobs.sort((x, y) => byLabel(x.label, y.label));
  for (const l of [out.pluginsAdded, out.pluginsRemoved, out.pluginsUpdated, out.files]) l.sort(byLabel);
  return out;
}

export interface PublicRow {
  metric: string; group: string; label: string;
  a: number | null; b: number | null; diff: number | null; rel: number | null; lo: number | null; hi: number | null;
  verdict: Verdict; moreMatches: number | null; nA: number; nB: number; noSharedMaps: boolean;
}

export interface PublicEntry extends PublicPatch {
  /** The baseline: nearest earlier published patch with counted rounds. */
  previous: { id: number; name: string } | null;
  status: 'compared' | 'first' | 'no_rounds';
  changes: PublicChanges | null;
  /** Why `changes` is null: this patch is historical, this patch or the baseline
   *  has no recorded inputs, or there is no baseline. */
  changesUnavailable: 'historical' | 'unrecorded' | 'previous_unrecorded' | 'first' | null;
  /** The newest patch in the public timeline (a preview counts itself as
   *  published), or a patch some server is running right now. */
  live: boolean;
  effect: {
    a: { matches: number; rounds: number }; b: { matches: number; rounds: number };
    skill: 'differs' | 'unavailable' | null; approximate: boolean; rows: PublicRow[];
  } | null;
}

const ORDER: Verdict[] = ['real', 'too_early', 'noise', 'no_data'];

/** The admin compare route's exact cache key and query for "A vs B", so the
 *  public page and the admin default view share one computation. */
export function adminDefaultCompare(db: DB, a: number, b: number): CompareResult {
  const sides = parseSideParams({ a: String(a), b: String(b) });
  if (typeof sides === 'string') throw new Error(sides);
  // Must stay byte-identical to the key in routes/admin.ts '/api/admin/balance/compare'
  // for phases=all, so both pages read one cached result.
  const key = `compare|${JSON.stringify(sides)}|all`;
  return memo(db, key, () => {
    const result = compareSides(db, sides.a, sides.b, { phases: 'all' });
    if (result.ms > 2000) console.warn(`[balance] compare took ${result.ms} ms for ${key}`);
    return result;
  });
}

/** Null for an unknown id, or an unpublished one unless `preview` (the admin
 *  preview treats the patch as published). */
export function publicEntry(db: DB, id: number, opts: { knobs: KnobLabels | null; preview?: boolean }): PublicEntry | null {
  const all = patchTimeline(db);
  const self = all.find((p) => p.id === id);
  if (!self || (self.publishedAt === null && !opts.preview)) return null;
  const line = all.filter((p) => p.publishedAt !== null || p.id === id);
  const idx = line.findIndex((p) => p.id === id);
  const base = line.slice(0, idx).reverse().find((p) => p.rounds > 0) ?? null;

  const inputsOf = (pid: number) => {
    const r = db.prepare('SELECT inputs_json FROM balance_patches WHERE id = ?').get(pid) as { inputs_json: string | null };
    try { return r.inputs_json ? (JSON.parse(r.inputs_json) as Record<string, string>) : null; } catch { return null; }
  };
  let changes: PublicChanges | null = null;
  let changesUnavailable: PublicEntry['changesUnavailable'] = null;
  if (self.source === 'historical') changesUnavailable = base ? 'historical' : 'first';
  else if (!self.hasInputs) changesUnavailable = base ? 'unrecorded' : 'first';
  else if (!base) changesUnavailable = 'first';
  else {
    const prev = inputsOf(base.id), cur = inputsOf(id);
    if (!prev || !cur) changesUnavailable = 'previous_unrecorded';
    else changes = publicChanges(prev, cur, opts.knobs);
  }

  let status: PublicEntry['status'] = 'compared';
  let effect: PublicEntry['effect'] = null;
  if (self.rounds === 0) status = 'no_rounds';
  else if (!base) status = 'first';
  else {
    const r = adminDefaultCompare(db, base.id, id);
    const byId = new Map(r.rows.filter((x) => x.phase === 'all').map((x) => [x.metric, x]));
    const rows: PublicRow[] = PUBLIC_METRICS.map((m) => {
      const x = byId.get(m.id);
      return x
        ? { metric: m.id, group: m.group, label: m.public!.label, a: x.a, b: x.b, diff: x.diff, rel: x.rel, lo: x.lo, hi: x.hi,
            verdict: x.verdict, moreMatches: x.moreMatches, nA: x.nA, nB: x.nB, noSharedMaps: x.noSharedMaps }
        : { metric: m.id, group: m.group, label: m.public!.label, a: null, b: null, diff: null, rel: null, lo: null, hi: null,
            verdict: 'no_data' as const, moreMatches: null, nA: 0, nB: 0, noSharedMaps: false };
    });
    // Admin order within a verdict (largest change first), missing metrics last.
    const pos = new Map(r.rows.map((x, i) => [x.metric, i]));
    rows.sort((x, y) => ORDER.indexOf(x.verdict) - ORDER.indexOf(y.verdict) || (pos.get(x.metric) ?? 1e9) - (pos.get(y.metric) ?? 1e9));
    const oneMissing = (r.a.meanMu === null) !== (r.b.meanMu === null);
    effect = {
      a: { matches: r.a.matches, rounds: r.a.rounds }, b: { matches: r.b.matches, rounds: r.b.rounds },
      skill: r.banners.skill === null ? null : oneMissing ? 'unavailable' : 'differs',
      approximate: r.banners.approximate, rows,
    };
  }
  const live = line[line.length - 1].id === id
    || db.prepare('SELECT 1 FROM balance_server_state WHERE patch_id = ? LIMIT 1').get(id) !== undefined;
  return { ...strip(self), live, previous: base ? { id: base.id, name: base.name } : null, status, changes, changesUnavailable, effect };
}
