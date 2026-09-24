# Balance Public Page (piece 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/balance` page listing each published balance patch with its notes, what changed versus the previous published patch, and the measured effect on an allowlist of metrics, with the verdict carried in the wording; plus publish / preview controls on the admin Patches tab.

**Architecture:** An allowlist flag on `MetricDef`; a server module `src/balancePublic.ts` that orders published patches, builds the public change list from stored inventories and wraps the piece 3 `compareSides` (same query, same cache key as the admin default, so verdicts are identical); a route module `src/routes/balancePublic.ts` (public GETs, admin preview and publish); on the web a pure wording module, a shared `PatchEntryView`, the `/balance` page and publish controls in `AdminPatches`.

**Tech Stack:** TypeScript, better-sqlite3, Fastify, Preact + preact-iso, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-balance-public-page-design.md` (read the "Planning review" section at the end: it settles the gaps this plan relies on).

## Global Constraints

- No em dashes anywhere: code, comments, UI text, docs, commit messages.
- Every `db` function takes `db: DB` first. Every admin route starts with `requireAdmin`; every admin mutation ends with `logAdmin`.
- Only rounds of matches with `state = 'completed' AND voided_at IS NULL` count (the compare filter).
- Public wording: always "Measured change", never "caused by". Verdict sentences exactly as in Task 6.
- Never send file contents, hashes, fingerprints, `inputs_json` or rating numbers to the public API.
- Allowlist (exact ids and labels):

| id | public label |
|---|---|
| round.saferoom | Rounds where survivors reached the saferoom |
| round.score | Survivor distance score |
| round.length_min | Round length (minutes) |
| tank.killed_rate | Tanks killed by survivors |
| tank.lifetime_killed_s | How long a killed tank lasted (s) |
| tank.damage_per_tank | Damage dealt per tank |
| tank.incaps_caused | Survivor incaps per tank |
| witch.crown_rate | Witches crowned |
| witch.startle_rate | Witches startled |
| hunter.skeet_rate | Hunters skeeted |
| hunter.damage_per_spawn | Hunter damage per spawn |
| smoker.pull_rate | Smoker pulls per spawn |
| boomer.boomed_per_spawn | Survivors boomed per boomer |
| boomer.pop_rate | Boomers popped before vomiting |
| pace.si_damage_per_min | Special infected damage per minute |
| si.pins_per_min | Pins per minute |
| weapons.hold.pumpshotgun | Time holding the pump shotgun |
| weapons.hold.smg | Time holding the Uzi |

- A separate branch (piece 4) edits `src/routes/admin.ts`, `balance/knobs.json`, `src/db.ts` (new tables) and the admin Balance desk. Do not edit `src/routes/admin.ts` or `src/routes/stats.ts`; keep edits to `src/db.ts`, `src/balancePatches.ts`, `web/src/api.ts`, `web/src/styles/app.css` and `AdminPatches.tsx` small and local.
- Work only in `/home/volence/l4d/pug/.claude/worktrees/agent-a7bcd36c1e70fde8b` (branch `balance-public-page`).
- Baseline: `npx vitest run` has one known failure (`tests/server.test.ts` "a malformed URL > gets the app shell on a page path"). `npm run typecheck` must stay clean (baseline: 1 failed | 4515 passed).

## File map

| File | Responsibility |
|---|---|
| `src/metrics/types.ts` | `MetricDef.public?: { label: string }` |
| `src/metrics/defs/*.ts` | `public` labels on the 18 allowlisted defs |
| `src/metrics/registry.ts` | `PUBLIC_METRICS` export |
| `src/db.ts` | `balance_patches.published_at` column |
| `src/balancePatches.ts` | `publishedAt` on `PatchSummary` |
| `src/balancePublic.ts` | Ordering, publish rules, change list, public entry |
| `src/routes/balancePublic.ts` | Public GETs, admin preview and publish |
| `src/server.ts` | Register the route module |
| `web/src/api.ts` | Types and client calls |
| `web/src/routes/balance/wording.ts` | Pure value formatting and verdict sentences |
| `web/src/routes/balance/PatchEntryView.tsx` | One public entry (used by page and admin preview) |
| `web/src/routes/BalanceNotes.tsx` | The `/balance` page |
| `web/src/AppRoutes.tsx`, `web/src/components/Nav.tsx` | Route and nav link |
| `web/src/routes/admin/AdminPatches.tsx` | Publish / unpublish and preview |
| `web/src/styles/app.css` | A few classes |

---

### Task 1: Allowlist on the metric registry

**Files:**
- Modify: `src/metrics/types.ts` (MetricDef), `src/metrics/defs/outcomes.ts`, `tank.ts`, `witch.ts`, `si.ts`, `pace.ts`, `weapons.ts`, `src/metrics/registry.ts`
- Test: `tests/metrics/registry.test.ts`

**Interfaces:**
- Produces: `MetricDef.public?: { label: string }`; `export const PUBLIC_METRICS: MetricDef[]` (the defs with `public`, in `METRICS` order) from `src/metrics/registry.ts`.

- [ ] **Step 1: Failing test.** Append to `tests/metrics/registry.test.ts`:

```ts
import { PUBLIC_METRICS } from '../../src/metrics/registry.js';

const ALLOWLIST: Record<string, string> = {
  'round.saferoom': 'Rounds where survivors reached the saferoom',
  'round.score': 'Survivor distance score',
  'round.length_min': 'Round length (minutes)',
  'tank.killed_rate': 'Tanks killed by survivors',
  'tank.lifetime_killed_s': 'How long a killed tank lasted (s)',
  'tank.damage_per_tank': 'Damage dealt per tank',
  'tank.incaps_caused': 'Survivor incaps per tank',
  'witch.crown_rate': 'Witches crowned',
  'witch.startle_rate': 'Witches startled',
  'hunter.skeet_rate': 'Hunters skeeted',
  'hunter.damage_per_spawn': 'Hunter damage per spawn',
  'smoker.pull_rate': 'Smoker pulls per spawn',
  'boomer.boomed_per_spawn': 'Survivors boomed per boomer',
  'boomer.pop_rate': 'Boomers popped before vomiting',
  'pace.si_damage_per_min': 'Special infected damage per minute',
  'si.pins_per_min': 'Pins per minute',
  'weapons.hold.pumpshotgun': 'Time holding the pump shotgun',
  'weapons.hold.smg': 'Time holding the Uzi',
};

describe('public allowlist', () => {
  it('every allowlisted id exists in the registry', () => {
    const ids = new Set(METRICS.map((m) => m.id));
    for (const id of Object.keys(ALLOWLIST)) expect(ids.has(id), id).toBe(true);
  });
  it('is exactly the approved list, with the approved non-empty labels', () => {
    expect(Object.fromEntries(PUBLIC_METRICS.map((m) => [m.id, m.public!.label]))).toEqual(ALLOWLIST);
    expect(PUBLIC_METRICS.every((m) => m.public!.label.trim().length > 0 && !m.public!.label.includes('\u2014'))).toBe(true);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/metrics/registry.test.ts` fails (PUBLIC_METRICS not exported).
- [ ] **Step 3: Implement.** In `src/metrics/types.ts` add to `MetricDef` after `description`:

```ts
  /** Shown on the public patch notes page under this label. Absent means
   *  admin only. See docs/superpowers/specs/2026-09-24-balance-public-page-design.md. */
  public?: { label: string };
```

Add `public: { label: '...' }` to each of the 16 non-weapon defs in their defs files (exact labels from the table). In `weapons.ts` add a map and spread it into the `weapons.hold.${g}` def only:

```ts
const PUBLIC_HOLD: Partial<Record<(typeof GUNS)[number], string>> = {
  pumpshotgun: 'Time holding the pump shotgun', smg: 'Time holding the Uzi',
};
// in the hold def:
    ...(PUBLIC_HOLD[g] ? { public: { label: PUBLIC_HOLD[g]! } } : {}),
```

In `registry.ts` after `METRICS`:

```ts
/** The metrics shown on the public patch notes page. */
export const PUBLIC_METRICS: MetricDef[] = METRICS.filter((m) => m.public);
```

Do not bump any `version` (the label is not part of the computation, and `ENGINE` must not change).
- [ ] **Step 4:** registry tests pass; `npx vitest run tests/metrics` all pass.
- [ ] **Step 5:** Commit `balance public: allowlist of public metrics with player-facing labels`.

---

### Task 2: Published flag, ordering and publish rules

**Files:**
- Modify: `src/db.ts` (one `ensureColumn` line), `src/balancePatches.ts` (`listPatches` gains `publishedAt`)
- Create: `src/balancePublic.ts`
- Test: `tests/balancePublic.test.ts` (new), adjust any existing `listPatches` equality assertions in `tests/balancePatches.test.ts` / `tests/balanceAdmin.test.ts` if they use exact equality.

**Interfaces:**
- Produces (from `src/balancePublic.ts`):

```ts
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
/** Every patch with its counted-round stats, ordered for the public timeline:
 *  by first counted round, else first_seen_at, then id. */
export function patchTimeline(db: DB): (PublicPatch & { hasInputs: boolean })[];
/** Published patches newest first. */
export function listPublished(db: DB): PublicPatch[];
export type PublishResult = { ok: true } | { ok: false; status: 400 | 404; error: string };
export function publishPatch(db: DB, id: number, published: boolean, now?: string): PublishResult;
```
- `PatchSummary` gains `publishedAt: string | null`.

- [ ] **Step 1: Failing tests** in `tests/balancePublic.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { listPublished, patchTimeline, publishPatch } from '../src/balancePublic.js';
import { listPatches } from '../src/balancePatches.js';

type DBT = ReturnType<typeof openDb>;
/** Adds `n` completed matches with two counted rounds each on `patch`, ended on `day`. */
export function addMatches(db: DBT, patch: number, n: number, day: string, opts: { voided?: boolean; startId?: number } = {}) {
  const match = db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin, ended_at, voided_at) VALUES (?, 1, 'completed', 'x', 'queue', ?, ?)");
  const ctx = db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, surv_mu, inf_mu, has_replay, has_stats, engine, computed_at)
    VALUES (?, 0, ?, 'mapA', 'queue', ?, 25, 25, 0, 0, 'e', 'n')`);
  let id = opts.startId ?? ((db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM matches').get() as { m: number }).m + 1);
  for (let i = 0; i < n; i++, id++) {
    match.run(id, `${day} 10:${String(i % 60).padStart(2, '0')}:00`, opts.voided ? '2026-09-30 00:00:00' : null);
    for (const half of [1, 2]) ctx.run(id, half, patch);
  }
}

let db: DBT;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare(`INSERT INTO balance_patches (id, name, notes, source, inputs_json, first_seen_at) VALUES
    (1, 'Old', 'old notes', 'historical', NULL, '2000-01-01 00:00:00'),
    (2, 'Mid', 'mid notes', 'detected', '{}', '2026-09-10 00:00:00'),
    (3, NULL, '', 'detected', '{}', '2026-09-20 00:00:00')`).run();
});

describe('patchTimeline', () => {
  it('orders by first counted round, not first_seen_at, and counts only counted rounds', () => {
    addMatches(db, 2, 2, '2026-09-11');
    addMatches(db, 1, 3, '2026-09-12');           // historical patch whose rounds come later
    addMatches(db, 1, 1, '2026-09-13', { voided: true });
    const t = patchTimeline(db);
    expect(t.map((p) => p.id)).toEqual([2, 1, 3]);
    const old = t.find((p) => p.id === 1)!;
    expect(old).toMatchObject({ matches: 3, rounds: 6, approximate: true, firstRound: '2026-09-12 10:00:00', lastRound: '2026-09-12 10:02:00' });
    expect(t.find((p) => p.id === 3)).toMatchObject({ matches: 0, rounds: 0, firstRound: null, name: 'Patch 3' });
  });
});

describe('publishPatch', () => {
  it('refuses a patch without a name, notes or counted rounds, naming what is missing', () => {
    expect(publishPatch(db, 3, true)).toEqual({ ok: false, status: 400, error: expect.stringMatching(/name/) });
    db.prepare("UPDATE balance_patches SET name = 'New', notes = '  ' WHERE id = 3").run();
    expect(publishPatch(db, 3, true)).toEqual({ ok: false, status: 400, error: expect.stringMatching(/notes/) });
    db.prepare("UPDATE balance_patches SET notes = 'why' WHERE id = 3").run();
    expect(publishPatch(db, 3, true)).toEqual({ ok: false, status: 400, error: expect.stringMatching(/counted round/) });
    expect(publishPatch(db, 99, true)).toEqual({ ok: false, status: 404, error: 'no such patch' });
  });
  it('publishes, keeps the first publish time on a repeat, and unpublishes', () => {
    addMatches(db, 2, 1, '2026-09-11');
    expect(publishPatch(db, 2, true, '2026-09-24 01:00:00')).toEqual({ ok: true });
    expect(publishPatch(db, 2, true, '2026-09-25 01:00:00')).toEqual({ ok: true });
    expect(listPublished(db).map((p) => [p.id, p.publishedAt])).toEqual([[2, '2026-09-24 01:00:00']]);
    expect(listPatches(db).find((p) => p.id === 2)!.publishedAt).toBe('2026-09-24 01:00:00');
    expect(publishPatch(db, 2, false)).toEqual({ ok: true });
    expect(listPublished(db)).toEqual([]);
  });
  it('lists published patches newest first', () => {
    addMatches(db, 1, 1, '2026-09-05');
    addMatches(db, 2, 1, '2026-09-11');
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    expect(listPublished(db).map((p) => p.id)).toEqual([2, 1]);
    expect(JSON.stringify(listPublished(db))).not.toMatch(/inputs|fingerprint|hasInputs/);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/balancePublic.test.ts`: fails (module missing).
- [ ] **Step 3: Implement.** In `src/db.ts`, right after `ensureColumn(db, 'match_rounds', 'patch_id', ...)` and its index line, add:

```ts
  // Balance public page (piece 5): NULL = not shown on /balance.
  ensureColumn(db, 'balance_patches', 'published_at', 'TEXT');
```

In `src/balancePatches.ts` `listPatches`: select `p.published_at`, add `published_at: string | null` to the row type, `publishedAt: string | null` to `PatchSummary` (with a doc comment "When the patch was put on the public page; null when it is not public.") and map `publishedAt: r.published_at`.

Create `src/balancePublic.ts`:

```ts
import type { DB } from './db.js';

export interface PublicPatch { /* exactly as in Interfaces */ }

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

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
```

Confirm `match_rounds` has columns `match_id, ordinal, half, started_at` in `src/db.ts` before relying on them.

```ts
const strip = ({ hasInputs: _h, ...p }: PublicPatch & { hasInputs: boolean }): PublicPatch => p;

export function listPublished(db: DB): PublicPatch[] {
  return patchTimeline(db).filter((p) => p.publishedAt !== null).reverse().map(strip);
}

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
```

- [ ] **Step 4:** Tests pass; also `npx vitest run tests/balancePatches.test.ts tests/balanceAdmin.test.ts tests/db.test.ts` (fix any exact-equality assertion broken by the new `publishedAt` field by adding `publishedAt: null`).
- [ ] **Step 5:** Commit `balance public: published_at, public timeline ordering and publish rules`.

---

### Task 3: Public change list

**Files:**
- Modify: `src/balancePublic.ts`
- Test: `tests/balancePublic.test.ts`

**Interfaces:**
- Consumes: `withoutIgnored` from `src/balancePatches.ts`; `BalanceKnobs` type from `src/balanceKnobs.ts`.
- Produces:

```ts
export interface PublicChanges {
  knobs: { label: string; from: string; to: string }[];
  pluginsAdded: string[]; pluginsRemoved: string[]; pluginsUpdated: string[];
  /** Watched config files and the per-map stripper directory that differ, by label. */
  files: string[];
}
export type KnobLabels = Pick<BalanceKnobs, 'cvars' | 'files' | 'dirs' | 'versionless'> & { ignored?: string[] };
export function publicChanges(prev: Record<string, string>, cur: Record<string, string>, knobs: KnobLabels | null): PublicChanges;
```

Inventory keys (see a real `inputs_json`): `c:<cvar>` = value, `p:<file>.smx` = `size.hash`, `f:<path>` = `size.hash`, `d:<dir>` = `count.hash`.

- [ ] **Step 1: Failing tests** (append):

```ts
import { publicChanges } from '../src/balancePublic.js';

const KNOBS = {
  cvars: [{ cvar: 'z_tank_health', label: 'Tank base health', group: 'tank' }],
  files: [{ path: 'cfg/pug_match.cfg', label: 'PUG match config' }],
  dirs: [{ path: 'addons/stripper/Roto-AZMod/maps', ext: '.cfg', label: 'Stripper per-map configs' }],
  versionless: ['pug-match.smx'],
  ignored: ['l4d_tvwatch.smx'],
};

describe('publicChanges', () => {
  const prev = {
    'c:z_tank_health': '8000', 'c:tongue_hit_delay': '13', 'c:only_prev': '1',
    'p:l4d_skypounce.smx': '100.aaaaaaaa', 'p:old_thing.smx': '5.bbbbbbbb', 'p:pug-match.smx': '9.cccccccc',
    'f:cfg/pug_match.cfg': '10.dddddddd', 'f:cfg/other.cfg': '11.eeeeeeee',
    'd:addons/stripper/Roto-AZMod/maps': '138.ffffffff',
  };
  const cur = {
    'c:z_tank_health': '7500', 'c:tongue_hit_delay': '10', 'c:only_cur': '2',
    'p:l4d_skypounce.smx': '101.11111111', 'p:new_thing.smx': '7.22222222', 'p:pug-match.smx': '9.33333333',
    'p:l4d_tvwatch.smx': '1.44444444',
    'f:cfg/pug_match.cfg': '10.55555555', 'f:cfg/other.cfg': '11.eeeeeeee',
    'd:addons/stripper/Roto-AZMod/maps': '139.66666666',
  };
  it('labels knobs, names plugins without .smx and files by label, and never leaks hashes', () => {
    const c = publicChanges(prev, cur, KNOBS);
    expect(c).toEqual({
      knobs: [{ label: 'Tank base health', from: '8000', to: '7500' }, { label: 'tongue_hit_delay', from: '13', to: '10' }],
      pluginsAdded: ['new_thing'], pluginsRemoved: ['old_thing'], pluginsUpdated: ['l4d_skypounce'],
      files: ['PUG match config', 'Stripper per-map configs'],
    });
    expect(JSON.stringify(c)).not.toMatch(/[0-9a-f]{8}|\.smx|cfg\/|c:|p:|f:|d:/);
  });
  it('ignores versionless plugin rebuilds and ignored plugins, but shows a versionless plugin appearing', () => {
    const c = publicChanges({ 'p:pug-match.smx': '1.aaaaaaaa' }, { 'p:pug-match.smx': '2.bbbbbbbb', 'p:l4d_tvwatch.smx': '1.cccccccc' }, KNOBS);
    expect(c.pluginsUpdated).toEqual([]); expect(c.pluginsAdded).toEqual([]);
    expect(publicChanges({}, { 'p:pug-match.smx': '1.aaaaaaaa' }, KNOBS).pluginsAdded).toEqual(['pug-match']);
  });
  it('lists a watched file that appears or disappears, and falls back to raw names without knobs', () => {
    expect(publicChanges({}, { 'f:cfg/new.cfg': '1.aaaaaaaa' }, KNOBS).files).toEqual(['cfg/new.cfg']);
    expect(publicChanges({ 'c:z_tank_health': '1' }, { 'c:z_tank_health': '2' }, null).knobs).toEqual([{ label: 'z_tank_health', from: '1', to: '2' }]);
  });
});
```

- [ ] **Step 2:** Run: fails.
- [ ] **Step 3: Implement:**

```ts
import { withoutIgnored } from './balancePatches.js';
import type { BalanceKnobs } from './balanceKnobs.js';

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
  }
  out.knobs.sort((x, y) => byLabel(x.label, y.label));
  for (const l of [out.pluginsAdded, out.pluginsRemoved, out.pluginsUpdated, out.files]) l.sort(byLabel);
  return out;
}
```

Note the expected knob order in the test is by label with case-sensitive `localeCompare`; if it differs, keep label ordering and adjust the test order, never the output format.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `balance public: player-facing change list from stored inventories`.

---

### Task 4: The public entry (baseline, change list, measured effect, parity)

**Files:**
- Modify: `src/balancePublic.ts`
- Test: `tests/balancePublic.test.ts`

**Interfaces:**
- Consumes: `compareSides` (`src/metrics/compare/compare.ts`), `memo`, `parseSideParams` (`src/metrics/compare/cache.ts`), `METRICS`, `PUBLIC_METRICS` (`src/metrics/registry.ts`), `Verdict` (`src/metrics/compare/stats.ts`).
- Produces:

```ts
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
  /** Why `changes` is null: this patch is historical, the baseline has no recorded
   *  inputs, or there is no baseline. */
  changesUnavailable: 'historical' | 'previous_unrecorded' | 'first' | null;
  effect: {
    a: { matches: number; rounds: number }; b: { matches: number; rounds: number };
    skill: 'differs' | 'unavailable' | null; approximate: boolean; rows: PublicRow[];
  } | null;
}
/** Null for an unknown id, or an unpublished one unless `preview` (the admin
 *  preview treats the patch as published). */
export function publicEntry(db: DB, id: number, opts: { knobs: KnobLabels | null; preview?: boolean }): PublicEntry | null;
/** The admin compare route's exact cache key and query for "A vs B", so the
 *  public page and the admin default view share one computation. */
export function adminDefaultCompare(db: DB, a: number, b: number): CompareResult;
```

- [ ] **Step 1: Failing tests.** Build a DB like `tests/metrics/compare.test.ts` `setup()` (copy that function into this test file as `compareDb()`, with patches 1 'Old' and 2 'New', both `detected`, notes set, `inputs_json` set to `{"c:z_tank_health":"8000"}` and `{"c:z_tank_health":"7500"}`; round_metrics rows use `ENGINE` from the registry). Append:

```ts
import { compareSides } from '../src/metrics/compare/compare.js';
import { adminDefaultCompare, publicEntry } from '../src/balancePublic.js';
import { PUBLIC_METRICS } from '../src/metrics/registry.js';

describe('publicEntry', () => {
  it('is null for unknown or unpublished ids unless previewing', () => {
    const db = compareDb();
    expect(publicEntry(db, 99, { knobs: null })).toBeNull();
    expect(publicEntry(db, 2, { knobs: null })).toBeNull();
    expect(publicEntry(db, 2, { knobs: null, preview: true })).not.toBeNull();
  });

  it('first published patch: no baseline, no comparison', () => {
    const db = compareDb();
    publishPatch(db, 1, true);
    expect(publicEntry(db, 1, { knobs: null })).toMatchObject({ status: 'first', previous: null, effect: null, changes: null, changesUnavailable: 'first' });
  });

  it('parity: public rows equal the admin default rows filtered to the allowlist', () => {
    const db = compareDb();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    const e = publicEntry(db, 2, { knobs: null })!;
    expect(e.status).toBe('compared');
    expect(e.previous).toEqual({ id: 1, name: 'Old' });
    expect(e.changes!.knobs).toEqual([{ label: 'z_tank_health', from: '8000', to: '7500' }]);
    const admin = compareSides(db, { patchIds: [1], origin: 'all', maps: null }, { patchIds: [2], origin: 'all', maps: null }, { phases: 'all' });
    const pub = new Set(PUBLIC_METRICS.map((m) => m.id));
    const adminRows = admin.rows.filter((r) => pub.has(r.metric));
    for (const r of adminRows) {
      const p = e.effect!.rows.find((x) => x.metric === r.metric)!;
      expect({ v: p.verdict, a: p.a, b: p.b, lo: p.lo, hi: p.hi }).toEqual({ v: r.verdict, a: r.a, b: r.b, lo: r.lo, hi: r.hi });
    }
    expect(e.effect!.rows.find((x) => x.metric === 'round.saferoom')!.verdict).toBe('real');
    // Admin-only metrics never leak.
    expect(e.effect!.rows.some((x) => x.metric === 'tank.spawns')).toBe(false);
    // Every allowlisted metric is listed, missing ones as no data.
    expect(e.effect!.rows.map((x) => x.metric).sort()).toEqual([...pub].sort());
    expect(e.effect!.rows.find((x) => x.metric === 'witch.crown_rate')).toMatchObject({ verdict: 'no_data', a: null, b: null, nA: 0, nB: 0 });
    expect(JSON.stringify(e)).not.toMatch(/meanMu|meanGap|fingerprint|inputs_json|"p":/);
  });

  it('shares the admin cache entry', () => {
    const db = compareDb();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    const first = adminDefaultCompare(db, 1, 2);
    expect(adminDefaultCompare(db, 1, 2)).toBe(first);
  });

  it('skips a published baseline with no counted rounds, and diffs across an unpublished patch', () => {
    const db = compareDb();
    // Patch 3: published, no rounds, between 1 and 2 by first_seen_at.
    db.prepare(`INSERT INTO balance_patches (id, name, notes, source, inputs_json, first_seen_at, published_at)
      VALUES (3, 'Empty', 'n', 'detected', '{"c:z_tank_health":"7000"}', '2026-09-09 00:00:00', '2026-09-24 00:00:00')`).run();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    const e = publicEntry(db, 2, { knobs: null })!;
    expect(e.previous!.id).toBe(1);
    expect(e.changes!.knobs[0]).toMatchObject({ from: '8000', to: '7500' });
    expect(publicEntry(db, 3, { knobs: null })).toMatchObject({ status: 'no_rounds', effect: null, matches: 0 });
  });

  it('historical patch: approximate, no change list; a baseline without inputs gives previous_unrecorded', () => {
    const db = compareDb();
    db.prepare("UPDATE balance_patches SET source = 'historical', inputs_json = NULL WHERE id = 1").run();
    publishPatch(db, 1, true); publishPatch(db, 2, true);
    expect(publicEntry(db, 1, { knobs: null })).toMatchObject({ approximate: true, changes: null, changesUnavailable: 'first' });
    const e = publicEntry(db, 2, { knobs: null })!;
    expect(e).toMatchObject({ changes: null, changesUnavailable: 'previous_unrecorded' });
    expect(e.effect!.approximate).toBe(true);
  });
});
```

Also add one test where patch 1 itself is `historical` and not first (publish a detected patch 0 with earlier rounds before it) only if cheap; otherwise the rule `source === 'historical'` giving `changesUnavailable: 'historical'` is tested by a direct small case: two published patches where the later one is historical (`changesUnavailable: 'historical'`).

- [ ] **Step 2:** Run: fails.
- [ ] **Step 3: Implement:**

```ts
import { compareSides } from './metrics/compare/compare.js';
import { memo, parseSideParams } from './metrics/compare/cache.js';
import type { CompareResult } from './metrics/compare/types.js';
import { PUBLIC_METRICS } from './metrics/registry.js';
import type { Verdict } from './metrics/compare/stats.js';

const ORDER: Verdict[] = ['real', 'too_early', 'noise', 'no_data'];

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
  if (self.source === 'historical' || !self.hasInputs) changesUnavailable = base ? 'historical' : 'first';
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
  return { ...strip(self), previous: base ? { id: base.id, name: base.name } : null, status, changes, changesUnavailable, effect };
}
```

Note on `changesUnavailable` for a historical patch with a baseline: 'historical'; without: 'first'. The rule "baseline has no inputs" also covers a detected patch with a historical baseline.
- [ ] **Step 4:** Tests pass; `npx vitest run tests/metrics` still passes.
- [ ] **Step 5:** Commit `balance public: public entry with the admin comparison filtered to the allowlist`.

---

### Task 5: Routes

**Files:**
- Create: `src/routes/balancePublic.ts`
- Modify: `src/server.ts` (import and `await app.register(balancePublicRoutes, { db: deps.db, knobsPath: deps.balanceKnobsPath });` right after the `statsRoutes` registration)
- Test: `tests/balancePublicRoutes.test.ts`

**Interfaces:**
- Consumes: `listPublished`, `publicEntry`, `publishPatch` (Task 2/4); `loadBalanceKnobs` (`src/balanceKnobs.ts`); `makeRequireAdmin` (`src/routes/guards.ts`); `logAdmin` (`src/admin/audit.ts`).
- Produces routes:
  - `GET /api/balance/patches` -> `{ patches: PublicPatch[] }` (public)
  - `GET /api/balance/patches/:id` -> `PublicEntry` or 404 `{ error: 'no such patch' }` (public)
  - `GET /api/admin/balance/patches/:id/public` -> `PublicEntry` (preview) or 404 (admin)
  - `POST /api/admin/balance/patches/:id/publish` body `{ published: boolean }` -> `{ ok: true }`, 400 `{ error }`, 404 (admin; `logAdmin(db, adminId, published ? 'publish_patch' : 'unpublish_patch', id)`)

- [ ] **Step 1: Failing tests** (model on `tests/balanceCompareRoutes.test.ts`: `openDb(':memory:')`, season row, `buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} })`, `authedCookie`). Cover:
  1. `GET /api/balance/patches` with no cookie returns 200 and only published patches, newest first.
  2. `GET /api/balance/patches/:id` 404 for an unpublished id, an unknown id and `abc`; 200 for a published one, no cookie needed.
  3. Admin preview returns the entry for an unpublished patch; non-admin gets 403; no cookie gets 401.
  4. `POST .../publish` with `{ published: true }` on a patch missing notes: 400 whose error mentions notes; then valid: 200, patch appears publicly, an `admin_actions` row with action `publish_patch` exists; `{ published: 'yes' }` gives 400; unknown id 404; non-admin 403.
  5. Single flight: `vi.spyOn` is not possible on ESM exports, so instead: publish two patches with rounds (reuse a compare fixture), fire two `a.inject` GETs for the newer id with `Promise.all`, and assert both bodies are deep-equal and that `JSON.stringify` of the two is identical; then assert the cache was used once by checking `adminDefaultCompare(db, a, b)` returns the same object identity twice (import from `src/balancePublic.js`). Add a comment explaining that better-sqlite3 plus the synchronous memo already serialises computations (spec planning review item 5).
- [ ] **Step 2:** Run: fails.
- [ ] **Step 3: Implement** `src/routes/balancePublic.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { loadBalanceKnobs, type BalanceKnobs } from '../balanceKnobs.js';
import { listPublished, publicEntry, publishPatch } from '../balancePublic.js';

export interface BalancePublicRouteOpts { db: DB; knobsPath?: string }

const idOf = (req: { params: unknown }): number | null => {
  const raw = (req.params as { id: string }).id;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
};

/** The public patch notes page (balance analytics piece 5) and its admin
 *  preview and publish controls. Public routes are unauthenticated and only
 *  ever answer fixed query shapes over published patches; the heavy part is
 *  the admin comparison's own cache. */
export async function balancePublicRoutes(app: FastifyInstance, opts: BalancePublicRouteOpts): Promise<void> {
  const { db } = opts;
  const requireAdmin = makeRequireAdmin(db);
  // Labels only: a missing or broken knobs.json degrades to raw cvar names.
  let knobs: BalanceKnobs | null = null;
  try { knobs = loadBalanceKnobs(opts.knobsPath); } catch (err) {
    console.error('[balance] public page: knobs.json failed to load, showing raw names:', err);
  }

  app.get('/api/balance/patches', async () => ({ patches: listPublished(db) }));

  app.get('/api/balance/patches/:id', async (req, reply) => {
    const id = idOf(req);
    const e = id === null ? null : publicEntry(db, id, { knobs });
    return e ?? reply.code(404).send({ error: 'no such patch' });
  });

  app.get('/api/admin/balance/patches/:id/public', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const id = idOf(req);
    const e = id === null ? null : publicEntry(db, id, { knobs, preview: true });
    return e ?? reply.code(404).send({ error: 'no such patch' });
  });

  app.post('/api/admin/balance/patches/:id/publish', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such patch' });
    const published = (req.body as { published?: unknown } | undefined)?.published;
    if (typeof published !== 'boolean') return reply.code(400).send({ error: 'published is true or false' });
    const r = publishPatch(db, id, published);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, published ? 'publish_patch' : 'unpublish_patch', id);
    return { ok: true };
  });
}
```

Check `ServerDeps` has `balanceKnobsPath` (it does, see `src/server.ts` around line 164).
- [ ] **Step 4:** Tests pass; `npx vitest run tests/balanceCompareRoutes.test.ts tests/balanceAdmin.test.ts` still pass.
- [ ] **Step 5:** Commit `balance public: public patch routes, admin preview and publish`.

---

### Task 6: Web API client and wording

**Files:**
- Modify: `web/src/api.ts`
- Create: `web/src/routes/balance/wording.ts`
- Test: `web/src/routes/balance/wording.test.ts`

**Interfaces:**
- Produces in `web/src/api.ts` (placed right after the existing `CompareQuery`/`compareParams` block): types `PublicPatch`, `PublicChanges`, `PublicRow`, `PublicEntry` mirroring Tasks 2 to 4 exactly; `PatchSummary.publishedAt: string | null`; `api.balancePatches(signal)` -> `{ patches: PublicPatch[] }`; `api.balancePatch(id, signal)` -> `PublicEntry`; `adminApi.balancePublicPreview(id, signal)` -> `PublicEntry`; `adminApi.publishBalancePatch(id, published)` -> `post(...)`.
- Produces in `wording.ts`:

```ts
export function publicValue(metric: string, v: number | null): string;
export function publicDelta(metric: string, d: number | null): string;
export function verdictSentence(r: PublicRow): string;
export function skillBannerText(s: 'differs' | 'unavailable' | null): string | null;
export const APPROXIMATE_TEXT: string;
export const CHANGES_UNAVAILABLE_TEXT: Record<'historical' | 'previous_unrecorded' | 'first', string>;
```

- [ ] **Step 1: Failing tests** `web/src/routes/balance/wording.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PublicRow } from '../../api';
import { publicDelta, publicValue, skillBannerText, verdictSentence } from './wording';

const row = (o: Partial<PublicRow>): PublicRow => ({
  metric: 'tank.killed_rate', group: 'tank', label: 'Tanks killed by survivors', a: 0.62, b: 0.71, diff: 0.09, rel: 0.145,
  lo: 0.03, hi: 0.15, verdict: 'real', moreMatches: null, nA: 40, nB: 40, noSharedMaps: false, ...o,
});

describe('public wording', () => {
  it('formats shares and per-spawn rates as percent, others with the admin units', () => {
    expect(publicValue('tank.killed_rate', 0.62)).toBe('62%');
    expect(publicValue('hunter.skeet_rate', 0.123)).toBe('12%');
    expect(publicValue('tank.lifetime_killed_s', 41.4)).toBe('41 s');
    expect(publicValue('round.score', 412.345)).toBe('412.35');
    expect(publicValue('round.score', null)).toBe('n/a');
    expect(publicDelta('tank.killed_rate', 0.09)).toBe('+9 pts');
    expect(publicDelta('tank.lifetime_killed_s', -3.2)).toBe('-3 s');
  });
  it('real change carries values, change and range and never says caused', () => {
    const s = verdictSentence(row({}));
    expect(s).toBe('Measured change: Tanks killed by survivors went from 62% to 71% (+9 pts, likely between +3 pts and +15 pts).');
    expect(s).not.toMatch(/caus/i);
  });
  it('noise, too early and no data', () => {
    expect(verdictSentence(row({ verdict: 'noise' }))).toBe('No clear change: within normal variation.');
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: 12 }))).toBe('Too early to tell: about 12 more matches needed.');
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: 1 }))).toBe('Too early to tell: about 1 more match needed.');
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: 800 }))).toBe('Too early to tell: about 500+ more matches needed.');
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: null }))).toBe('Too early to tell: more matches needed.');
    expect(verdictSentence(row({ verdict: 'no_data', b: null, nB: 0 }))).toBe('Not measured for this patch.');
    expect(verdictSentence(row({ verdict: 'no_data', a: null, nA: 0 }))).toBe('Not measured for the previous patch.');
    expect(verdictSentence(row({ verdict: 'no_data', a: null, b: null, noSharedMaps: true }))).toBe('No maps in common with the previous patch, so no comparison.');
  });
  it('skill banner', () => {
    expect(skillBannerText(null)).toBeNull();
    expect(skillBannerText('differs')).toMatch(/players, not the patch/);
    expect(skillBannerText('unavailable')).toMatch(/could not/);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run web/src/routes/balance/wording.test.ts`: fails.
- [ ] **Step 3: Implement** `wording.ts`:

```ts
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

export const CHANGES_UNAVAILABLE_TEXT = {
  historical: 'This patch was reconstructed from dates, so there is no recorded list of settings. See the notes above.',
  previous_unrecorded: 'The previous patch predates recorded settings, so the list of changes is not available. See the notes above.',
  first: 'First tracked patch: nothing earlier to compare with.',
} as const;
```

Careful with `fmtValue` returning e.g. `41 s` and `412.35`: prefixing `+`/`-` gives `+41 s`. If the rounded magnitude is zero, drop the sign (the regex above; adjust to taste but test `publicDelta('round.score', 0.001)` gives `0`).

Add the api types and calls (mirror server types exactly; `post` returns `Promise<unknown>`):

```ts
  balancePatches: (signal?: AbortSignal) => get<{ patches: PublicPatch[] }>('/api/balance/patches', signal),
  balancePatch: (id: number, signal?: AbortSignal) => get<PublicEntry>(`/api/balance/patches/${id}`, signal),
```
in `api`, and in `adminApi` next to `editBalancePatch`:
```ts
  balancePublicPreview: (id: number, signal?: AbortSignal) => get<PublicEntry>(`/api/admin/balance/patches/${id}/public`, signal),
  publishBalancePatch: (id: number, published: boolean) => post(`/api/admin/balance/patches/${id}/publish`, { published }),
```
Update `web/src/routes/admin/AdminPatches.test.tsx` fixtures with `publishedAt: null` if typecheck requires.
- [ ] **Step 4:** Tests pass; web typecheck clean.
- [ ] **Step 5:** Commit `balance public: web client and verdict wording`.

---

### Task 7: PatchEntryView and the /balance page

**Files:**
- Create: `web/src/routes/balance/PatchEntryView.tsx`, `web/src/routes/BalanceNotes.tsx`, `web/src/routes/balance/BalanceNotes.test.tsx`
- Modify: `web/src/AppRoutes.tsx` (route `/balance`), `web/src/components/Nav.tsx` (`['/balance', 'Patch notes']` after `/matches`), `web/src/components/Nav.test.tsx` (assert the link), `web/src/styles/app.css` (append a short block)

**Interfaces:**
- Consumes: `api.balancePatches`, `api.balancePatch`, wording helpers, `GROUP_LABEL` from `web/src/routes/admin/balance/format.ts`, `Panel`, `Empty` from `components/bits`, `PageHeader`, `useFetch`, `fmtDate`.
- Produces: `export function PatchEntryView({ entry }: { entry: PublicEntry })`; `export function BalanceNotes()`.

`PatchEntryView` renders, in order:
1. `<h3>` name; a line with the dates (`fmtDate(firstRound).slice(0, 10)` to `fmtDate(lastRound).slice(0, 10)`, one date when equal, nothing when null), `N matches, M rounds`, and an `approximate` chip when `entry.approximate`.
2. Notes in a `<p class="patch-notes">` (CSS `white-space: pre-line`).
3. "What changed": `changesUnavailable` text, or the lists (`<Label>: from -> to` for knobs using the text "from X to Y"; "Added plugins: a, b", "Removed plugins", "Updated plugins", "Changed files"); when every list is empty: "No tracked setting changed; see the notes."
4. "Measured effect": `status === 'first'` -> `CHANGES_UNAVAILABLE_TEXT.first`-style text "First tracked patch: nothing earlier to compare with."; `no_rounds` -> "No rounds yet."; `compared` -> "Compared with <previous.name>: A matches before, B matches after." then banners (`skillBannerText`, `APPROXIMATE_TEXT` when `effect.approximate`) as `<p class="patch-banner">`, then one table per group in `GROUP_LABEL` key order (skip empty groups), columns: Metric, Before, After, Change, What we measured; rows in the server order (real first). Change cell: `publicDelta` (empty when diff null). Last cell: `verdictSentence(row)`; a `real` row gets class `patch-row--real`.

`BalanceNotes`: `PageHeader eyebrow="Balance" title="Patch notes"` with a one-paragraph intro ("Each balance patch, why it was made, and what the numbers measured afterwards. A change is only called a measured change when it is larger than normal game-to-game variation."), then for each listed patch (newest first) a child `PatchPanel` that fetches `api.balancePatch(id)` with `useFetch` and renders `<Panel><PatchEntryView entry=.../></Panel>`, a loading line, or "Could not load this patch." on error. Empty list: `<Empty>No patch notes yet.</Empty>`.

- [ ] **Step 1: Failing render tests** in `web/src/routes/balance/BalanceNotes.test.tsx` (mock `../../api` like `routes.test.tsx` does, with `api.balancePatches` and `api.balancePatch`). Fixtures: a compared entry with one row of each verdict (real `tank.killed_rate`, noise `round.saferoom`, too_early `witch.crown_rate` with `moreMatches: 12`, no_data `weapons.hold.smg` with `nB: 0`), `skill: 'differs'`, changes with one knob; a historical first entry (`approximate: true`, `status: 'first'`, `changesUnavailable: 'first'`); a `no_rounds` entry. Assert:
  - the page lists all three names, newest first;
  - the compared entry shows "Measured change: Tanks killed by survivors went from 62% to 71%", "No clear change: within normal variation.", "about 12 more matches needed", "Not measured for this patch.", the skill banner text, "Tank base health" and "from 8000 to 7500";
  - the historical entry shows "approximate" and "First tracked patch";
  - the no-rounds entry shows "No rounds yet.";
  - no text on the page matches `/caus/i`.
  - Also render `PatchEntryView` directly for the `previous_unrecorded` text.
- [ ] **Step 2:** Run: fails.
- [ ] **Step 3: Implement** the components; add the route `<Route path="/balance" component={BalanceNotes} />` next to `/matches` in `AppRoutes.tsx`; nav link; CSS:

```css
/* Balance patch notes (/balance) */
.patch-notes { white-space: pre-line; }
.patch-banner { border-left: 3px solid var(--warn, #c90); padding-left: 0.6rem; }
.patch-row--real td:last-child { font-weight: 600; }
```

(Check `app.css` for the real warning colour variable name and use it.)
- [ ] **Step 4:** Tests pass; `npx vitest run web/src` passes; web typecheck clean.
- [ ] **Step 5:** Commit `balance public: /balance patch notes page`.

---

### Task 8: Publish and preview on the admin Patches tab

**Files:**
- Modify: `web/src/routes/admin/AdminPatches.tsx`, `web/src/routes/admin/AdminPatches.test.tsx`

**Interfaces:**
- Consumes: `adminApi.balancePublicPreview`, `adminApi.publishBalancePatch`, `PatchSummary.publishedAt`, `PatchEntryView`.

Changes:
- Patches table: a "Public" column showing `public` (a `.admin-tag`) when `publishedAt` is set, blank otherwise.
- Detail panel: below the save form, a "Public page" block: text "Public since <fmtTime(publishedAt)>." or "Not public."; a `Publish` button (when not public) or `Unpublish` (when public) that runs `adminApi.publishBalancePatch(open.id, !isPublic)` through `run(...)` (errors from a 400 show in the existing `error` line) and then reloads the list and closes nothing; a `Preview` button that loads `adminApi.balancePublicPreview(open.id)` into state and renders `<PatchEntryView entry={preview} />` inside a bordered block headed "Preview of the public entry". A hint line: "Publishing needs a name, notes and at least one counted round." Keep the existing save form untouched.
- Because the open detail was fetched before publishing, derive `isPublic` from the reloaded list entry for `open.id` (fall back to `open.publishedAt`).

- [ ] **Step 1: Failing tests** in `AdminPatches.test.tsx` (extend `mockAdmin` with `balancePublicPreview` and `publishBalancePatch`): open a patch, click Preview, see a line from the mocked entry ("Measured change: ..."); click Publish, `publishBalancePatch` called with `(id, true)`; a rejected publish (`new ApiError(400, 'publishing needs notes')`, check the ApiError constructor signature in `web/src/api.ts`) shows the message; a published patch shows the `public` tag and an Unpublish button.
- [ ] **Step 2:** Run: fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run web/src/routes/admin` passes; web typecheck clean.
- [ ] **Step 5:** Commit `balance public: publish, unpublish and preview on the Patches tab`.

---

### Task 9: Check against a copy of production (controller, not a subagent)

- Copy the snapshot to the scratchpad (never the original), open it with the branch code (`openDb` runs migrations), publish the historical patches (and the detected patch 6 after naming it in the copy), call `listPublished` and `publicEntry` from a script, render the entries with the wording module (or run the built site locally against the copy), and read every sentence by eye for honesty and wording. Record findings in the SDD ledger. Nothing touches production.

## Self-review notes

- Spec coverage: published_at + publish rules (T2), preview (T5, T8), historical (T4, T7), date range (T2), change list incl. unpublished-in-between (T3, T4), measured effect parity and full BH set (T4), wording (T6), banners (T4, T6), first patch and no rounds (T4, T7), allowlist and registry test (T1), API and 404 (T5), memo and single flight (T4, T5), page and nav (T7), before-ship check (T9).
- Types: `PublicPatch`, `PublicChanges`, `PublicRow`, `PublicEntry`, `KnobLabels` defined in T2 to T4 and mirrored in T6.
