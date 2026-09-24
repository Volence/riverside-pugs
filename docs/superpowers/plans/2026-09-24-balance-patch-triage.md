# Balance Patch Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every detected balance patch gets a triage state (pending / balance / folded), admins decide in one click whether a new config is a balance patch, and a site-managed ignore list replaces the knobs.json code change for noise plugins.

**Architecture:** Three new columns on `balance_patches` (`triage`, `folded_into`, `came_from_patch_id`), one on `match_rounds` (`sighted_patch_id`) and one table (`balance_ignored_plugins`). A leaf module `balanceFold.ts` owns chain resolution and retagging, `balanceIgnore.ts` owns the effective ignore list, `balanceTriage.ts` owns the decisions and the card's plain-words diff. The patch admin routes move out of `routes/admin.ts` into `routes/adminBalancePatches.ts`, which gets the knobs. The Patches tab gets a triage card, folded rows collapsed under their target and an ignored-plugins list; Compare hides folded patches and tags pending ones.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Preact, vitest + @testing-library/preact.

**Spec:** `docs/superpowers/specs/2026-09-24-balance-catalogue-and-triage-design.md` (section "Sub-project 1: patch triage").

## Global Constraints

- Branch `balance-integration`, worktree `.claude/worktrees/balance-analytics`. No deploy, no production writes, no RCON.
- Triage states are exactly `pending`, `balance`, `folded`. A NULL `triage` (a merged patch the boot step could not resolve) reads as `balance`.
- `match_rounds.patch_id` stays the effective patch every reader uses; `sighted_patch_id` is the patch whose fingerprint the round reported.
- Every place that reads the ignored list reads the effective list = `knobs.json` `ignored` plus `balance_ignored_plugins`.
- Only `balance` patches appear in the public page and the knob panel's "restore from"; Compare shows `balance` and `pending` (tagged "needs triage"), never `folded`.
- Every triage write is admin only and audited with `logAdmin`.
- Names up to 60 characters, notes up to 2000 (same limits as the existing patch edit route).
- Test command: `npx vitest run <files>`; typecheck: `npm run typecheck`.

---

## File map

- `src/db.ts`: new columns, table, openDb backfill.
- `src/balanceFold.ts` (new): `chainOf`, `resolvePatch`, `retagRounds`, `foldInto`, `unfoldPatch`, `triageGeneration`.
- `src/balanceIgnore.ts` (new): `siteIgnored`, `effectiveIgnored`, `withEffectiveIgnored`, `listIgnored`, `addIgnored`, `removeIgnored`.
- `src/balancePatches.ts`: sighting writes `sighted_patch_id`, pending state, `came_from_patch_id`, "(needs triage)" alert; refingerprint folds merges and resolves backfill leftovers; `listPatches` gains triage fields; `serverDrift` takes the ignored list.
- `src/balanceTriage.ts` (new): `describeChanges`, `triageInfo`, `triageBalance`, `triageFold`, `triageIgnore`, `triageUnfold`.
- `src/routes/adminBalancePatches.ts` (new): the patch routes moved from `routes/admin.ts`, plus triage, unfold and ignored-plugin routes.
- `src/adminFeed.ts`, `src/discord/adminFeedPoster.ts`: optional `link` on a problem event.
- `src/metrics/compare/cache.ts`: `dataStamp` gains the triage generation.
- `src/balancePublic.ts`, `src/routes/balancePublic.ts`: publish refuses non-balance, effective ignore list, `live` resolves folds.
- `src/balanceControl.ts`, `src/balanceRollouts.ts`, `src/routes/adminBalanceKnobs.ts`: base inventory by sighted patch, effective ignore list, reuse of a pending patch makes it balance, folded refused, restorable only balance.
- `src/server.ts`: effective ignore list at sighting and boot; register the new routes.
- `src/historicalPatches.ts`: inserts `triage = 'balance'`, sets `sighted_patch_id`.
- `web/src/api.ts`, `web/src/routes/admin/AdminPatches.tsx`, `web/src/routes/admin/TriageCard.tsx` (new), `web/src/routes/admin/balance/Compare.tsx`.
- `scripts/balance-triage-report.ts` (new): runs the migration and boot step on a database copy and prints every patch's state.

---

### Task 1: Schema and openDb backfill

**Files:**
- Modify: `src/db.ts` (after `ensureColumn(db, 'balance_patches', 'published_at', 'TEXT');`)
- Modify: `src/historicalPatches.ts`
- Test: `tests/balanceTriageSchema.test.ts` (new)

**Interfaces:**
- Produces: columns `balance_patches.triage TEXT` (NULL | 'pending' | 'balance' | 'folded'), `balance_patches.folded_into INTEGER`, `balance_patches.came_from_patch_id INTEGER`, `match_rounds.sighted_patch_id INTEGER`; table `balance_ignored_plugins(file TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT '', added_by TEXT NOT NULL, added_at TEXT NOT NULL)`; exported `TRIAGE_BACKFILL_SQL: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/balanceTriageSchema.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { TRIAGE_BACKFILL_SQL } from '../src/db.js';

describe('triage schema and backfill', () => {
  it('backfills states and sighted_patch_id, and leaves merged detected patches for the boot step', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('a'.repeat(32));
    const ins = db.prepare('INSERT INTO balance_patches (id, fingerprint, name, source, inputs_json, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(1, null, 'Baseline', 'historical', null, '2000-01-01 00:00:00');
    ins.run(2, 'f2', 'Named', 'detected', '{}', '2026-09-23 00:00:00');
    ins.run(3, 'f3', null, 'detected', '{}', '2026-09-24 00:00:00');
    ins.run(4, null, null, 'detected', '{}', '2026-09-24 01:00:00');
    ins.run(5, 'f5', 'Panel', 'announced', '{}', '2026-09-24 02:00:00');
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, patch_id) VALUES (1, 0, 1, 'a', 3), (1, 0, 2, 'b', NULL)").run();
    // The columns exist because openDb ran; simulate a database from before them.
    db.exec('UPDATE balance_patches SET triage = NULL; UPDATE match_rounds SET sighted_patch_id = NULL');
    for (const sql of TRIAGE_BACKFILL_SQL) db.prepare(sql).run();

    const states = db.prepare('SELECT id, triage FROM balance_patches ORDER BY id').all();
    expect(states).toEqual([
      { id: 1, triage: 'balance' }, { id: 2, triage: 'balance' }, { id: 3, triage: 'pending' },
      { id: 4, triage: null }, { id: 5, triage: 'balance' },
    ]);
    const rounds = db.prepare('SELECT half, patch_id, sighted_patch_id FROM match_rounds ORDER BY half').all();
    expect(rounds).toEqual([{ half: 1, patch_id: 3, sighted_patch_id: 3 }, { half: 2, patch_id: null, sighted_patch_id: null }]);
  });

  it('refuses an unknown triage state and has the ignored plugins table', () => {
    const db = openDb(':memory:');
    expect(() => db.prepare("INSERT INTO balance_patches (source, first_seen_at, triage) VALUES ('detected', 'x', 'maybe')").run()).toThrow();
    db.prepare("INSERT INTO balance_ignored_plugins (file, added_by, added_at) VALUES ('l4d_tvwatch.smx', '1', 'x')").run();
    expect(db.prepare('SELECT reason FROM balance_ignored_plugins').get()).toEqual({ reason: '' });
  });

  it('historical patches are balance and their rounds get a sighted patch', async () => {
    const { applyHistoricalPatches } = await import('../src/historicalPatches.js');
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('a'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at) VALUES (1, 0, 1, 'a', '2026-09-01 00:00:00')").run();
    applyHistoricalPatches(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM balance_patches WHERE triage != 'balance'").get()).toEqual({ n: 0 });
    const r = db.prepare('SELECT patch_id, sighted_patch_id FROM match_rounds').get() as { patch_id: number; sighted_patch_id: number };
    expect(r.sighted_patch_id).toBe(r.patch_id);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (`TRIAGE_BACKFILL_SQL` is not exported)

Run: `npx vitest run tests/balanceTriageSchema.test.ts`

- [ ] **Step 3: Implement**

In `src/db.ts`, near the other exported SQL constants (e.g. beside `ORIGIN_BACKFILL_SQL`):

```ts
/** Patch triage backfill (sub-project 1 of the balance catalogue roadmap).
 *  Historical, announced and named detected patches are balance; an unnamed
 *  detected patch that still holds a fingerprint is pending. A merged
 *  detected patch (fingerprint NULL) is left NULL: which patch it was merged
 *  into needs the versionless/ignored lists, so the boot refingerprint
 *  resolves it (see refingerprintPatches). Every tagged round's sighted patch
 *  starts as its patch. Idempotent. */
export const TRIAGE_BACKFILL_SQL = [
  `UPDATE balance_patches SET triage = CASE
     WHEN source != 'detected' THEN 'balance'
     WHEN name IS NOT NULL AND TRIM(name) != '' THEN 'balance'
     ELSE 'pending' END
   WHERE triage IS NULL AND NOT (source = 'detected' AND fingerprint IS NULL)`,
  'UPDATE match_rounds SET sighted_patch_id = patch_id WHERE sighted_patch_id IS NULL AND patch_id IS NOT NULL',
];
```

After `ensureColumn(db, 'balance_patches', 'published_at', 'TEXT');`:

```ts
  // Patch triage: docs/superpowers/specs/2026-09-24-balance-catalogue-and-triage-design.md
  ensureColumn(db, 'balance_patches', 'triage', "TEXT CHECK (triage IN ('pending','balance','folded'))");
  ensureColumn(db, 'balance_patches', 'folded_into', 'INTEGER REFERENCES balance_patches(id)');
  // The patch the first reporting server was on before this one: the default
  // fold target and the base of the triage card's diff.
  ensureColumn(db, 'balance_patches', 'came_from_patch_id', 'INTEGER REFERENCES balance_patches(id)');
  // The patch whose fingerprint a round reported; patch_id is the effective
  // patch after folds.
  ensureColumn(db, 'match_rounds', 'sighted_patch_id', 'INTEGER REFERENCES balance_patches(id)');
  db.exec('CREATE INDEX IF NOT EXISTS match_rounds_sighted_patch ON match_rounds(sighted_patch_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS balance_ignored_plugins (
    file     TEXT PRIMARY KEY,
    reason   TEXT NOT NULL DEFAULT '',
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL
  )`);
  for (const sql of TRIAGE_BACKFILL_SQL) db.prepare(sql).run();
```

In `src/historicalPatches.ts`: the INSERT gets `triage` = `'balance'`:

```ts
        "INSERT INTO balance_patches (fingerprint, name, notes, source, inputs_json, first_seen_at, triage) VALUES (NULL, ?, ?, 'historical', NULL, ?, 'balance')",
```

and the tagging UPDATE sets both columns:

```ts
        'UPDATE match_rounds SET patch_id = ?, sighted_patch_id = ? WHERE patch_id IS NULL AND started_at >= ? AND started_at < ?',
      ).run(id, id, p.from, end).changes;
```

- [ ] **Step 4: Run the new test and the existing balance suite, expect PASS**

Run: `npx vitest run tests/balanceTriageSchema.test.ts tests/balance*.test.ts tests/historical*.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/historicalPatches.ts tests/balanceTriageSchema.test.ts
git commit -m "balance triage: schema, ignored plugins table and backfill"
```

---

### Task 2: Fold core (`balanceFold.ts`) and the compare cache stamp

**Files:**
- Create: `src/balanceFold.ts`
- Modify: `src/metrics/compare/cache.ts`
- Test: `tests/balanceFold.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces:
  - `triageGeneration(): number`
  - `chainOf(db, id): number[]` (id first, chain end last; throws on a loop)
  - `resolvePatch(db, id): number`
  - `retagRounds(db): number` (rounds changed; bumps the generation)
  - `foldInto(db, id, into): { ok: true; target: number } | { ok: false; error: string }` (stores the chain end, unpublishes, retags; no source/state validation)
  - `unfoldPatch(db, id): void` (state back to pending, retags)

- [ ] **Step 1: Write the failing test**

```ts
// tests/balanceFold.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { chainOf, foldInto, resolvePatch, retagRounds, triageGeneration, unfoldPatch } from '../src/balanceFold.js';
import { dataStamp } from '../src/metrics/compare/cache.js';

type DB = ReturnType<typeof openDb>;

function seed(db: DB) {
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('a'.repeat(32));
  const ins = db.prepare("INSERT INTO balance_patches (id, fingerprint, source, inputs_json, first_seen_at, triage, published_at) VALUES (?, ?, 'detected', '{}', ?, ?, ?)");
  ins.run(1, 'f1', '2026-09-20 00:00:00', 'balance', null);
  ins.run(2, 'f2', '2026-09-21 00:00:00', 'pending', null);
  ins.run(3, 'f3', '2026-09-22 00:00:00', 'balance', '2026-09-22 00:00:00');
  const r = db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, patch_id, sighted_patch_id) VALUES (1, ?, ?, 'a', ?, ?)");
  r.run(0, 1, 1, 1); r.run(0, 2, 2, 2); r.run(1, 1, 3, 3);
  db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, patch_id, has_replay, has_stats, engine, computed_at)
    VALUES (1, 0, 2, 2, 1, 1, 'e', '2026-09-24 00:00:00')`).run();
}

describe('balanceFold', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); seed(db); });

  const roundPatch = (half: number, ordinal = 0) =>
    (db.prepare('SELECT patch_id, sighted_patch_id FROM match_rounds WHERE ordinal = ? AND half = ?').get(ordinal, half));
  const ctxPatch = () => (db.prepare('SELECT patch_id FROM round_metric_context').get() as { patch_id: number }).patch_id;

  it('folds a patch: rounds and metric context move, sighted stays', () => {
    expect(foldInto(db, 2, 1)).toEqual({ ok: true, target: 1 });
    expect(roundPatch(2)).toEqual({ patch_id: 1, sighted_patch_id: 2 });
    expect(ctxPatch()).toBe(1);
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = 2').get()).toEqual({ triage: 'folded', folded_into: 1 });
  });

  it('unfold restores patch_id from sighted_patch_id and returns to pending', () => {
    foldInto(db, 2, 1);
    unfoldPatch(db, 2);
    expect(roundPatch(2)).toEqual({ patch_id: 2, sighted_patch_id: 2 });
    expect(ctxPatch()).toBe(2);
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = 2').get()).toEqual({ triage: 'pending', folded_into: null });
  });

  it('folding into a folded patch follows the chain to its end', () => {
    foldInto(db, 2, 1);
    expect(foldInto(db, 3, 2)).toEqual({ ok: true, target: 1 });
    expect(db.prepare('SELECT folded_into FROM balance_patches WHERE id = 3').get()).toEqual({ folded_into: 1 });
    expect(roundPatch(1, 1)).toEqual({ patch_id: 1, sighted_patch_id: 3 });
  });

  it('a patch folded into one that is later folded moves with it', () => {
    foldInto(db, 2, 3);
    foldInto(db, 3, 1);
    expect(chainOf(db, 2)).toEqual([2, 3, 1]);
    expect(resolvePatch(db, 2)).toBe(1);
    expect(roundPatch(2)).toEqual({ patch_id: 1, sighted_patch_id: 2 });
  });

  it('refuses a loop and folding into itself', () => {
    foldInto(db, 2, 3);
    expect(foldInto(db, 3, 2)).toEqual({ ok: false, error: expect.stringMatching(/loop/) });
    expect(foldInto(db, 1, 1)).toEqual({ ok: false, error: expect.stringMatching(/itself/) });
    expect(db.prepare('SELECT triage FROM balance_patches WHERE id = 3').get()).toEqual({ triage: 'balance' });
  });

  it('folding unpublishes', () => {
    foldInto(db, 3, 1);
    expect(db.prepare('SELECT published_at FROM balance_patches WHERE id = 3').get()).toEqual({ published_at: null });
  });

  it('retagging bumps the generation and the compare data stamp', () => {
    const g = triageGeneration(), s = dataStamp(db);
    retagRounds(db);
    expect(triageGeneration()).toBe(g + 1);
    expect(dataStamp(db)).not.toBe(s);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (module missing)

Run: `npx vitest run tests/balanceFold.test.ts`

- [ ] **Step 3: Implement `src/balanceFold.ts`**

```ts
import type { DB } from './db.js';

/**
 * Folding: a patch that is not a balance change counts as another patch.
 * Leaf module (imports nothing from the balance code) so the sighting, the
 * boot refingerprint, the triage decisions and the compare cache can all use
 * it without an import cycle. See
 * docs/superpowers/specs/2026-09-24-balance-catalogue-and-triage-design.md.
 */

let generation = 0;
/** Bumped on every retag, so the compare cache drops results computed before
 *  rounds moved between patches (a fold changes no count or timestamp the
 *  cache stamp otherwise reads). */
export function triageGeneration(): number { return generation; }

/** `id`, then each patch it is folded into, ending at the effective patch.
 *  Throws on a loop, which foldInto never creates. */
export function chainOf(db: DB, id: number): number[] {
  const step = db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?');
  const chain = [id];
  for (;;) {
    const r = step.get(chain[chain.length - 1]) as { triage: string | null; folded_into: number | null } | undefined;
    if (!r || r.triage !== 'folded' || r.folded_into === null) return chain;
    if (chain.includes(r.folded_into)) throw new Error(`balance patch fold loop: ${[...chain, r.folded_into].join(' -> ')}`);
    chain.push(r.folded_into);
  }
}

export function resolvePatch(db: DB, id: number): number {
  const c = chainOf(db, id);
  return c[c.length - 1];
}

/** Every round (and its metric context row) gets the patch its sighted patch
 *  resolves to. Returns how many rounds moved. */
export function retagRounds(db: DB): number {
  return db.transaction(() => {
    const ids = db.prepare('SELECT DISTINCT sighted_patch_id AS id FROM match_rounds WHERE sighted_patch_id IS NOT NULL').all() as { id: number }[];
    const setRounds = db.prepare('UPDATE match_rounds SET patch_id = ? WHERE sighted_patch_id = ? AND patch_id IS NOT ?');
    const setCtx = db.prepare(`UPDATE round_metric_context SET patch_id = ?
      WHERE patch_id IS NOT ? AND EXISTS (SELECT 1 FROM match_rounds r WHERE r.match_id = round_metric_context.match_id
        AND r.ordinal = round_metric_context.ordinal AND r.half = round_metric_context.half AND r.sighted_patch_id = ?)`);
    let moved = 0;
    for (const { id } of ids) {
      const eff = resolvePatch(db, id);
      moved += setRounds.run(eff, id, eff).changes;
      setCtx.run(eff, eff, id);
    }
    generation++;
    return moved;
  })();
}

/** Fold `id` into the end of `into`'s chain, unpublish it and retag. No
 *  checks on source or state: the triage decisions and the refingerprint
 *  make those. */
export function foldInto(db: DB, id: number, into: number): { ok: true; target: number } | { ok: false; error: string } {
  if (id === into) return { ok: false, error: 'a patch cannot be folded into itself' };
  const chain = chainOf(db, into);
  if (chain.includes(id)) return { ok: false, error: 'that fold would make a loop: the target is already folded into this patch' };
  const target = chain[chain.length - 1];
  db.transaction(() => {
    db.prepare("UPDATE balance_patches SET triage = 'folded', folded_into = ?, published_at = NULL WHERE id = ?").run(target, id);
    retagRounds(db);
  })();
  return { ok: true, target };
}

export function unfoldPatch(db: DB, id: number): void {
  db.transaction(() => {
    db.prepare("UPDATE balance_patches SET triage = 'pending', folded_into = NULL WHERE id = ?").run(id);
    retagRounds(db);
  })();
}
```

In `src/metrics/compare/cache.ts`, import and add to the stamp:

```ts
import { triageGeneration } from '../../balanceFold.js';
...
  return `${metricsGeneration()}|${triageGeneration()}|${c.n}|${c.t ?? ''}|${v.n}`;
```

Update the `dataStamp` doc comment: add "a fold or unfold (the triage generation)".

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run tests/balanceFold.test.ts tests/balanceCompare*.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/balanceFold.ts src/metrics/compare/cache.ts tests/balanceFold.test.ts
git commit -m "balance triage: fold, unfold and chain resolution"
```

---

### Task 3: Effective ignore list (`balanceIgnore.ts`)

**Files:**
- Create: `src/balanceIgnore.ts`
- Test: `tests/balanceIgnore.test.ts` (new)

**Interfaces:**
- Produces:
  - `PLUGIN_FILE_RE: RegExp` (`/^[A-Za-z0-9_.-]{1,64}\.smx$/`)
  - `siteIgnored(db): string[]`
  - `effectiveIgnored(db, knobsIgnored?: string[]): string[]` (sorted, unique)
  - `withEffectiveIgnored<T extends { ignored?: string[] }>(db, knobs: T): T`
  - `interface IgnoredPlugin { file: string; reason: string; addedBy: string | null; addedAt: string | null; source: 'site' | 'knobs' }`
  - `listIgnored(db, knobsIgnored?: string[]): IgnoredPlugin[]`
  - `addIgnored(db, files: string[], p: { reason: string; by: string; now: string }): string[]` (files newly added)
  - `removeIgnored(db, file): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/balanceIgnore.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addIgnored, effectiveIgnored, listIgnored, PLUGIN_FILE_RE, removeIgnored, siteIgnored, withEffectiveIgnored } from '../src/balanceIgnore.js';

describe('balanceIgnore', () => {
  it('merges knobs.json and the site list', () => {
    const db = openDb(':memory:');
    expect(addIgnored(db, ['b.smx', 'a.smx'], { reason: 'r', by: '1', now: '2026-09-24 00:00:00' })).toEqual(['b.smx', 'a.smx']);
    expect(addIgnored(db, ['a.smx'], { reason: 'r', by: '1', now: 'x' })).toEqual([]);
    expect(siteIgnored(db)).toEqual(['a.smx', 'b.smx']);
    expect(effectiveIgnored(db, ['c.smx', 'a.smx'])).toEqual(['a.smx', 'b.smx', 'c.smx']);
    expect(withEffectiveIgnored(db, { versionless: [], ignored: ['c.smx'] })).toEqual({ versionless: [], ignored: ['a.smx', 'b.smx', 'c.smx'] });
    expect(listIgnored(db, ['c.smx'])).toEqual([
      { file: 'a.smx', reason: 'r', addedBy: '1', addedAt: '2026-09-24 00:00:00', source: 'site' },
      { file: 'b.smx', reason: 'r', addedBy: '1', addedAt: '2026-09-24 00:00:00', source: 'site' },
      { file: 'c.smx', reason: '', addedBy: null, addedAt: null, source: 'knobs' },
    ]);
    expect(removeIgnored(db, 'a.smx')).toBe(true);
    expect(removeIgnored(db, 'a.smx')).toBe(false);
    expect(siteIgnored(db)).toEqual(['b.smx']);
  });

  it('accepts only plugin file names', () => {
    expect(PLUGIN_FILE_RE.test('l4d_tvwatch.smx')).toBe(true);
    expect(PLUGIN_FILE_RE.test('../x.smx')).toBe(false);
    expect(PLUGIN_FILE_RE.test('x.cfg')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run tests/balanceIgnore.test.ts`

- [ ] **Step 3: Implement `src/balanceIgnore.ts`**

```ts
import type { DB } from './db.js';

/**
 * The effective ignored plugin list: knobs.json `ignored` plus the plugins an
 * admin marked "ignore from now on" in patch triage. Every reader of the
 * ignored list goes through here, so the site list takes effect with no
 * deploy. See docs/superpowers/specs/2026-09-24-balance-catalogue-and-triage-design.md.
 */

export const PLUGIN_FILE_RE = /^[A-Za-z0-9_.-]{1,64}\.smx$/;

export function siteIgnored(db: DB): string[] {
  return (db.prepare('SELECT file FROM balance_ignored_plugins ORDER BY file').all() as { file: string }[]).map((r) => r.file);
}

export function effectiveIgnored(db: DB, knobsIgnored: string[] = []): string[] {
  return [...new Set([...knobsIgnored, ...siteIgnored(db)])].sort();
}

export function withEffectiveIgnored<T extends { ignored?: string[] }>(db: DB, knobs: T): T {
  return { ...knobs, ignored: effectiveIgnored(db, knobs.ignored) };
}

export interface IgnoredPlugin { file: string; reason: string; addedBy: string | null; addedAt: string | null; source: 'site' | 'knobs' }

/** Site entries first-class; a knobs.json entry also on the site list shows
 *  once, as the site entry (removing it there still leaves knobs.json). */
export function listIgnored(db: DB, knobsIgnored: string[] = []): IgnoredPlugin[] {
  const site = (db.prepare('SELECT file, reason, added_by, added_at FROM balance_ignored_plugins').all() as
    { file: string; reason: string; added_by: string; added_at: string }[])
    .map((r): IgnoredPlugin => ({ file: r.file, reason: r.reason, addedBy: r.added_by, addedAt: r.added_at, source: 'site' }));
  const have = new Set(site.map((s) => s.file));
  const fromKnobs = knobsIgnored.filter((f) => !have.has(f))
    .map((file): IgnoredPlugin => ({ file, reason: '', addedBy: null, addedAt: null, source: 'knobs' }));
  return [...site, ...fromKnobs].sort((a, b) => a.file.localeCompare(b.file));
}

export function addIgnored(db: DB, files: string[], p: { reason: string; by: string; now: string }): string[] {
  const ins = db.prepare('INSERT OR IGNORE INTO balance_ignored_plugins (file, reason, added_by, added_at) VALUES (?, ?, ?, ?)');
  return files.filter((f) => ins.run(f, p.reason, p.by, p.now).changes > 0);
}

export function removeIgnored(db: DB, file: string): boolean {
  return db.prepare('DELETE FROM balance_ignored_plugins WHERE file = ?').run(file).changes > 0;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run tests/balanceIgnore.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/balanceIgnore.ts tests/balanceIgnore.test.ts
git commit -m "balance triage: effective ignored plugin list"
```

---

### Task 4: Sighting writes triage data; the alert says "needs triage" and links

**Files:**
- Modify: `src/balancePatches.ts` (`recordBalanceSighting`, `alertText`)
- Modify: `src/adminFeed.ts` (problem event), `src/discord/adminFeedPoster.ts`
- Modify: `src/server.ts` (the `balance_end` handler)
- Test: `tests/balancePatches.test.ts`, `tests/discordAdminFeed.test.ts`

**Interfaces:**
- Consumes: `resolvePatch` (Task 2), `effectiveIgnored` (Task 3).
- Produces: `recordBalanceSighting(...)` returns `{ patchId: number /* sighted */; effectivePatchId: number; newPatch: boolean; serverChanged: boolean }`. New detected patches are inserted `triage = 'pending'` with `came_from_patch_id` = the reporting server's previous patch, resolved. `AdminEvent` problem gains `link?: { label: string; path: string }`.

- [ ] **Step 1: Write the failing tests**

Add to the `recordBalanceSighting` describe in `tests/balancePatches.test.ts`:

```ts
  it('a new detected patch is pending, remembers where the server came from, and the alert says so with a link', () => {
    const events: { text: string; link?: { label: string; path: string } }[] = [];
    const off = subscribeAdminEvents((e) => { if (e.kind === 'problem') events.push(e); });
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    const b = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: { ...INV, 'p:l4d_tvwatch.smx': '1.a' }, versionless: [] });
    off();
    const row = db.prepare('SELECT triage, came_from_patch_id FROM balance_patches WHERE id = ?').get(b.patchId);
    expect(row).toEqual({ triage: 'pending', came_from_patch_id: a.patchId });
    expect(events[1].text).toMatch(/new patch \(#2, needs triage\)/);
    expect(events[1].link).toEqual({ label: 'Triage it', path: '/admin/balance/patches' });
  });

  it('a sighting of a folded patch tags the round with its target, keeping the sighted patch', () => {
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    const b = recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: { ...INV, 'c:z_tank_health': '1' }, versionless: [] });
    db.prepare("UPDATE balance_patches SET triage = 'folded', folded_into = ? WHERE id = ?").run(a.patchId, b.patchId);
    const again = recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: { ...INV, 'c:z_tank_health': '1' }, versionless: [] });
    expect(again).toMatchObject({ patchId: b.patchId, effectivePatchId: a.patchId });
    expect(db.prepare('SELECT patch_id, sighted_patch_id FROM match_rounds WHERE match_id = 1').get())
      .toEqual({ patch_id: a.patchId, sighted_patch_id: b.patchId });
  });
```

Add to `tests/discordAdminFeed.test.ts`, in the describe that holds "admin actions, penalties, accounts and problems post one line each":

```ts
  it('a problem with a link renders it against the public URL', async () => {
    publishAdminEvent({ kind: 'problem', text: 'Balance config changed.', link: { label: 'Triage it', path: '/admin/balance/patches' } });
    await feed.idle();
    expect(text(0)).toContain('Balance config changed. [Triage it](https://pug.test/admin/balance/patches)');
  });
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run tests/balancePatches.test.ts tests/discordAdminFeed.test.ts`

- [ ] **Step 3: Implement**

`src/adminFeed.ts`, the problem member:

```ts
  // `link` is a site path the Discord poster turns into a link.
  | { kind: 'problem'; text: string; matchId?: number; link?: { label: string; path: string } }
```

`src/discord/adminFeedPoster.ts`:

```ts
      case 'problem':
        return { text: `⚠️ ${e.text}${e.link ? ` [${e.link.label}](${this.deps.publicUrl}${e.link.path})` : ''}`, color: COLOR.problem };
```

`src/balancePatches.ts`: `import { resolvePatch } from './balanceFold.js';`. Rewrite the body of the transaction in `recordBalanceSighting` so `prev` is read first and the insert records state and origin:

```ts
  return db.transaction(() => {
    const prev = s.serverId === null ? undefined
      : db.prepare('SELECT patch_id, inventory_json FROM balance_server_state WHERE server_id = ?')
        .get(s.serverId) as { patch_id: number; inventory_json: string } | undefined;
    let newPatch = false;
    let row = db.prepare('SELECT id FROM balance_patches WHERE fingerprint = ?').get(fp) as { id: number } | undefined;
    if (!row) {
      const id = Number(db.prepare(
        "INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage, came_from_patch_id) VALUES (?, 'detected', ?, ?, 'pending', ?)",
      ).run(fp, invJson, now, prev ? resolvePatch(db, prev.patch_id) : null).lastInsertRowid);
      row = { id };
      newPatch = true;
    }
    const patchId = row.id;
    const effectivePatchId = resolvePatch(db, patchId);

    db.prepare('UPDATE match_rounds SET patch_id = ?, sighted_patch_id = ? WHERE match_id = ? AND ordinal = ? AND half = ?')
      .run(effectivePatchId, patchId, s.matchId, currentOrdinal(db, s.matchId), s.half);
```

Delete the later `const prev = ...` line inside `if (s.serverId !== null)` (it now comes from above). Keep `balance_server_state.patch_id` as the sighted patch (a fold later resolves it; see Task 7 for readers). Change the publish call and the return:

```ts
          const pending = (db.prepare('SELECT triage FROM balance_patches WHERE id = ?').get(patchId) as { triage: string | null }).triage === 'pending';
          publishAdminEvent({
            kind: 'problem', text: alertText(db, s.serverId, patchNumber, newPatch, pending, prev, inventory),
            ...(pending ? { link: { label: 'Triage it', path: '/admin/balance/patches' } } : {}),
          });
...
    return { patchId, effectivePatchId, newPatch, serverChanged };
```

Return type: `{ patchId: number; effectivePatchId: number; newPatch: boolean; serverChanged: boolean }`, with the doc comment saying `patchId` is the patch whose fingerprint was seen.

`alertText` gains `pending: boolean` after `newPatch`:

```ts
  const head = newPatch
    ? `Balance config on ${name} is a new patch (#${patchNumber}, needs triage).`
    : `Balance config on ${name} changed (still patch #${patchNumber}${pending ? ', needs triage' : ''}).`;
```

In `src/server.ts` (`balance_end` handler) pass the effective list and keep confirming by the sighted patch:

```ts
              inventory: inv, versionless: balanceKnobs.versionless, ignored: effectiveIgnored(deps.db, balanceKnobs.ignored),
```

with `import { effectiveIgnored } from './balanceIgnore.js';`. `confirmOnSighting(deps.db, { serverId, patchId: r.patchId })` stays: a rollout's patch is the fingerprint holder.

Fix any existing test that matched the old "unnamed; name it" wording (search: `grep -rn "name it in Admin" tests`).

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run tests/balancePatches.test.ts tests/discordAdminFeed.test.ts tests/balanceWiring.test.ts tests/balanceRollouts.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/balancePatches.ts src/adminFeed.ts src/discord/adminFeedPoster.ts src/server.ts tests/balancePatches.test.ts tests/discordAdminFeed.test.ts
git commit -m "balance triage: sightings record pending patches and the sighted patch"
```

---

### Task 5: Refingerprint folds its merges and resolves backfill leftovers

**Files:**
- Modify: `src/balancePatches.ts` (`refingerprintPatches`)
- Modify: `src/server.ts` (boot call)
- Test: `tests/balancePatches.test.ts` (`refingerprintPatches` describe)

**Interfaces:**
- Consumes: `foldInto`, `resolvePatch`, `retagRounds` (Task 2), `effectiveIgnored` (Task 3).
- Produces: same signature. Changes: the keeper of a group is the non-recomputed holder, else the oldest `balance` patch, else the oldest; every merged patch becomes `folded` into the keeper (so its rounds move); a detected patch with NULL fingerprint and NULL triage is folded into the holder of its recomputed fingerprint, or set `balance` when there is none.

- [ ] **Step 1: Write the failing tests** (in the `refingerprintPatches` describe; its `beforeEach` has match 1 with rounds half 1 and 2, server dallas)

```ts
  it('folds a merged patch into the keeper and moves its rounds', () => {
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    const b = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: withSpec, versionless: [] });
    refingerprintPatches(db, [], [SPEC], () => {});
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?').get(b.patchId))
      .toEqual({ triage: 'folded', folded_into: a.patchId });
    expect(db.prepare('SELECT patch_id, sighted_patch_id FROM match_rounds WHERE half = 2').get())
      .toEqual({ patch_id: a.patchId, sighted_patch_id: b.patchId });
  });

  it('a balance patch keeps the fingerprint over an older pending one', () => {
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: withSpec, versionless: [] });
    const b = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: INV, versionless: [] });
    db.prepare("UPDATE balance_patches SET triage = 'balance', name = 'Real' WHERE id = ?").run(b.patchId);
    const r = refingerprintPatches(db, [], [SPEC], () => {});
    expect(r.merged).toEqual([{ keep: b.patchId, into: [a.patchId] }]);
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?').get(a.patchId))
      .toEqual({ triage: 'folded', folded_into: b.patchId });
  });

  it('resolves a merged patch left by the backfill: folded into the holder, else balance', () => {
    const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    const ins = db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage) VALUES (NULL, 'detected', ?, '2026-09-24 00:00:00', NULL)");
    const merged = Number(ins.run(JSON.stringify(withSpec)).lastInsertRowid);
    const orphan = Number(ins.run(JSON.stringify({ 'c:x': '1' })).lastInsertRowid);
    refingerprintPatches(db, [], [SPEC], () => {});
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?').get(merged)).toEqual({ triage: 'folded', folded_into: a.patchId });
    expect(db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?').get(orphan)).toEqual({ triage: 'balance', folded_into: null });
  });
```

Update the existing refingerprint tests that assert a merged patch keeps its rounds: now the rounds move to the keeper (`patch_id` = keeper, `sighted_patch_id` = merged patch). Update any assertion on the message text to the new wording below.

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run tests/balancePatches.test.ts`

- [ ] **Step 3: Implement** (in `src/balancePatches.ts`; `import { foldInto, resolvePatch, retagRounds } from './balanceFold.js';`)

Select `triage` with the rows:

```ts
    const rows = db.prepare(`SELECT id, fingerprint, inputs_json, first_seen_at, triage FROM balance_patches
      WHERE source = 'detected' AND inputs_json IS NOT NULL AND fingerprint IS NOT NULL
      ORDER BY first_seen_at, id`).all() as { id: number; fingerprint: string; inputs_json: string; first_seen_at: string; triage: string | null }[];
    const triageOf = new Map(rows.map((r) => [r.id, r.triage]));
```

Keeper choice:

```ts
      const keep = holder && !mine.has(holder.id) ? holder.id
        : ids.find((id) => (triageOf.get(id) ?? 'balance') === 'balance') ?? ids[0];
```

After the fingerprint updates (after `for (const [id, fp] of changed) if (fp !== null) setFp.run(fp, id);`):

```ts
    // A merge is a fold: the merged patch's rounds count for the keeper.
    for (const m of merged) {
      for (const id of m.into) {
        if (resolvePatch(db, m.keep) === id) continue; // the keeper is already folded into it: one patch already
        foldInto(db, id, m.keep);
      }
    }
    // Merged patches from before triage existed (the openDb backfill leaves
    // them NULL): fold each into whoever holds its fingerprint now.
    const leftovers = db.prepare(`SELECT id, inputs_json FROM balance_patches
      WHERE source = 'detected' AND fingerprint IS NULL AND triage IS NULL AND inputs_json IS NOT NULL`).all() as { id: number; inputs_json: string }[];
    for (const l of leftovers) {
      let holder: { id: number } | undefined;
      try {
        holder = holderOf.get(fingerprintOf(withoutIgnored(JSON.parse(l.inputs_json) as Inventory, ignored), versionless)) as { id: number } | undefined;
      } catch { holder = undefined; }
      if (holder && resolvePatch(db, holder.id) !== l.id) foldInto(db, l.id, holder.id);
      else db.prepare("UPDATE balance_patches SET triage = 'balance' WHERE id = ?").run(l.id);
    }
    db.prepare("UPDATE balance_patches SET triage = 'balance' WHERE source = 'detected' AND fingerprint IS NULL AND triage IS NULL").run();
```

New message text:

```ts
        + '. The merged patches are folded into the patch they were merged into: their rounds now count for it.';
```

Update the function's doc comment: merges are folds; keeper preference; leftovers.

`src/server.ts` boot call:

```ts
          refingerprintPatches(deps.db, balanceKnobs.versionless, effectiveIgnored(deps.db, balanceKnobs.ignored), (e) => bootProblems.push(e.text));
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run tests/balancePatches.test.ts tests/balanceWiring.test.ts tests/balancePublic.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/balancePatches.ts src/server.ts tests/balancePatches.test.ts
git commit -m "balance triage: refingerprint merges become folds"
```

---

### Task 6: Triage decisions and the card's plain-words diff (`balanceTriage.ts`), `listPatches` fields

**Files:**
- Create: `src/balanceTriage.ts`
- Modify: `src/balancePatches.ts` (`PatchSummary`, `listPatches`, `patchDetail`, `serverDrift`)
- Test: `tests/balanceTriage.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 2, 3, 5; `activeRollout` from `src/balanceRollouts.ts`; `patchNumber` from `src/balanceControl.ts`.
- Produces:
  - `type Lists = { versionless: string[]; ignored: string[] }` (ignored = effective)
  - `describeChanges(a: Inventory, b: Inventory, versionless: string[]): { lines: string[]; plugins: string[]; onlyPlugins: boolean }`
  - `triageInfo(db, id, lists): { base: { id: number; number: number; name: string | null } | null; changes: string[]; plugins: string[]; onlyPluginsChanged: boolean }`
  - `type TriageResult = { ok: true; target?: number } | { ok: false; status: 400 | 404 | 409; error: string }`
  - `triageBalance(db, id, p: { name: unknown; notes: unknown }): TriageResult`
  - `triageFold(db, id, into: unknown): TriageResult`
  - `triageIgnore(db, id, p: { into: unknown; plugins: unknown; versionless: string[]; knobsIgnored: string[]; adminId: string; now?: string }): TriageResult`
  - `triageUnfold(db, id): TriageResult`
  - `PatchSummary` gains `triage: 'pending' | 'balance' | 'folded'`, `foldedInto: number | null`, `onlyPluginsChanged: boolean`, `triageBase: { id; number; name } | null`, `changes: string[]`, `plugins: string[]`; `merged` = `triage === 'folded'`.
  - `listPatches(db, lists?: Lists)`, `patchDetail(db, id, lists?: Lists)`, `serverDrift(db, ignored?: string[])`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/balanceTriage.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { recordBalanceSighting, listPatches, serverDrift } from '../src/balancePatches.js';
import { describeChanges, triageBalance, triageFold, triageIgnore, triageInfo, triageUnfold } from '../src/balanceTriage.js';
import { siteIgnored } from '../src/balanceIgnore.js';

type DB = ReturnType<typeof openDb>;
const BASE = { 'c:z_tank_health': '8000', 'p:pug-match.smx': '1.a', 'p:l4d_skypounce.smx': '2.b', 'f:cfg/pug_match.cfg': '10.c' };
const LISTS = { versionless: ['pug-match.smx'], ignored: [] as string[] };

describe('describeChanges', () => {
  it('words each difference and spots plugin-only changes', () => {
    const plug = describeChanges(BASE, { ...BASE, 'p:l4d_tvwatch.smx': '3.c', 'p:pug-match.smx': '9.z' }, LISTS.versionless);
    expect(plug).toEqual({ lines: ['plugin added: l4d_tvwatch'], plugins: ['l4d_tvwatch.smx'], onlyPlugins: true });
    const mixed = describeChanges(BASE, { ...BASE, 'c:z_tank_health': '7500', 'f:cfg/pug_match.cfg': '11.d', 'p:l4d_skypounce.smx': '3.x' }, []);
    expect(mixed.lines).toEqual(['plugin updated: l4d_skypounce', 'z_tank_health 8000 -> 7500', 'file changed: pug_match.cfg']);
    expect(mixed.onlyPlugins).toBe(false);
    expect(describeChanges(BASE, BASE, []).onlyPlugins).toBe(false);
  });
});

describe('triage decisions', () => {
  let db: DB;
  let base: number, noisy: number, real: number;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('a'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a'), (1, 0, 2, 'b')").run();
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const s = (inv: Record<string, string>, half: 1 | 2, now: string) =>
      recordBalanceSighting(db, { matchId: 1, serverId: 1, half, inventory: inv, versionless: LISTS.versionless, now }).patchId;
    base = s(BASE, 1, '2026-09-20 00:00:00');
    db.prepare("UPDATE balance_patches SET triage = 'balance', name = 'Base' WHERE id = ?").run(base);
    noisy = s({ ...BASE, 'p:l4d_tvwatch.smx': '3.c' }, 2, '2026-09-21 00:00:00');
    real = Number(db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage) VALUES ('r', 'detected', ?, '2026-09-22 00:00:00', 'pending')")
      .run(JSON.stringify({ ...BASE, 'c:z_tank_health': '7500' })).lastInsertRowid);
  });

  it('the card info: base is where the server came from, changes worded, plugin-only hint', () => {
    expect(triageInfo(db, noisy, LISTS)).toEqual({
      base: { id: base, number: 1, name: 'Base' }, changes: ['plugin added: l4d_tvwatch'],
      plugins: ['l4d_tvwatch.smx'], onlyPluginsChanged: true,
    });
    // No came_from: falls back to the previous non-folded patch with inputs.
    expect(triageInfo(db, real, LISTS).base?.id).toBe(noisy);
  });

  it('balance needs a name and only applies to a pending patch', () => {
    expect(triageBalance(db, noisy, { name: ' ', notes: '' })).toMatchObject({ ok: false, status: 400 });
    expect(triageBalance(db, noisy, { name: 'Tv', notes: 'n' })).toEqual({ ok: true });
    expect(db.prepare('SELECT triage, name, notes, reviewed FROM balance_patches WHERE id = ?').get(noisy))
      .toEqual({ triage: 'balance', name: 'Tv', notes: 'n', reviewed: 1 });
    expect(triageBalance(db, noisy, { name: 'Tv', notes: '' })).toMatchObject({ ok: false, status: 409 });
  });

  it('fold moves rounds to a balance target; refuses a pending target, announced source, active rollout', () => {
    expect(triageFold(db, noisy, real)).toMatchObject({ ok: false, status: 400 });
    expect(triageFold(db, noisy, base)).toEqual({ ok: true, target: base });
    expect(db.prepare('SELECT patch_id FROM match_rounds WHERE half = 2').get()).toEqual({ patch_id: base });
    expect(listPatches(db, LISTS).find((p) => p.id === noisy)).toMatchObject({
      triage: 'folded', foldedInto: base, merged: true, changes: ['plugin added: l4d_tvwatch'],
    });
    const ann = Number(db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage) VALUES ('an', 'announced', '{}', '2026-09-23 00:00:00', 'balance')").run().lastInsertRowid);
    expect(triageFold(db, ann, base)).toMatchObject({ ok: false, status: 400 });
    db.prepare("INSERT INTO balance_rollouts (patch_id, values_json, content, created_by, created_at) VALUES (?, '{}', '', '1', 'x')").run(real);
    db.prepare("UPDATE balance_patches SET triage = 'balance', name = 'R' WHERE id = ?").run(real);
    expect(triageFold(db, real, base)).toMatchObject({ ok: false, status: 409 });
  });

  it('unfold restores and returns to pending', () => {
    triageFold(db, noisy, base);
    expect(triageUnfold(db, noisy)).toEqual({ ok: true });
    expect(db.prepare('SELECT patch_id FROM match_rounds WHERE half = 2').get()).toEqual({ patch_id: noisy });
    expect(triageUnfold(db, noisy)).toMatchObject({ ok: false, status: 409 });
  });

  it('ignore: plugin-only diffs only, adds the plugins, refingerprints and folds', () => {
    expect(triageIgnore(db, real, { into: base, plugins: [], versionless: LISTS.versionless, knobsIgnored: [], adminId: '1' }))
      .toMatchObject({ ok: false, status: 400 });
    expect(triageIgnore(db, noisy, { into: base, plugins: ['other.smx'], versionless: LISTS.versionless, knobsIgnored: [], adminId: '1' }))
      .toMatchObject({ ok: false, status: 400 });
    expect(triageIgnore(db, noisy, { into: base, plugins: ['l4d_tvwatch.smx'], versionless: LISTS.versionless, knobsIgnored: [], adminId: '1' }))
      .toEqual({ ok: true, target: base });
    expect(siteIgnored(db)).toEqual(['l4d_tvwatch.smx']);
    expect(db.prepare('SELECT triage, folded_into, fingerprint IS NULL AS merged FROM balance_patches WHERE id = ?').get(noisy))
      .toEqual({ triage: 'folded', folded_into: base, merged: 1 });
    // A new sighting with the plugin now lands on the base patch.
    const again = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: { ...BASE, 'p:l4d_tvwatch.smx': '3.c' },
      versionless: LISTS.versionless, ignored: ['l4d_tvwatch.smx'] });
    expect(again.patchId).toBe(base);
  });

  it('drift uses the ignored list it is given', () => {
    addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: BASE, versionless: LISTS.versionless });
    expect(serverDrift(db, []).find((s) => s.name === 'dallas')!.differsFrom).toHaveLength(1);
    expect(serverDrift(db, ['l4d_tvwatch.smx']).find((s) => s.name === 'dallas')!.differsFrom).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run tests/balanceTriage.test.ts`

- [ ] **Step 3: Implement `src/balanceTriage.ts`**

```ts
import type { DB } from './db.js';
import { diffInventories, refingerprintPatches, withoutIgnored } from './balancePatches.js';
import { chainOf, foldInto, resolvePatch, unfoldPatch } from './balanceFold.js';
import { addIgnored, effectiveIgnored, PLUGIN_FILE_RE } from './balanceIgnore.js';
import { activeRollout } from './balanceRollouts.js';
import { patchNumber } from './balanceControl.js';

/**
 * Patch triage: is a new config a balance patch? See
 * docs/superpowers/specs/2026-09-24-balance-catalogue-and-triage-design.md.
 * Callers (the admin routes) audit every decision.
 */

type Inventory = Record<string, string>;
export type Lists = { versionless: string[]; ignored: string[] };
export type TriageResult = { ok: true; target?: number } | { ok: false; status: 400 | 404 | 409; error: string };

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const base = (path: string) => path.split('/').pop() ?? path;

/** a to b in plain words, one line per difference. A versionless plugin whose
 *  build alone changed is not a difference (the fingerprint ignores it too). */
export function describeChanges(a: Inventory, b: Inventory, versionless: string[]): { lines: string[]; plugins: string[]; onlyPlugins: boolean } {
  const skip = new Set(versionless.map((f) => `p:${f}`));
  const d = diffInventories(a, b);
  const lines: string[] = [];
  const plugins: string[] = [];
  let other = 0;
  const word = (key: string, what: 'added' | 'removed' | 'changed', from?: string, to?: string) => {
    const kind = key.slice(0, 2), name = key.slice(2);
    if (kind === 'p:') {
      plugins.push(name);
      lines.push(`plugin ${what === 'changed' ? 'updated' : what}: ${name.replace(/\.smx$/, '')}`);
      return;
    }
    other++;
    if (kind === 'c:') lines.push(what === 'changed' ? `${name} ${from} -> ${to}` : `${name} ${what === 'added' ? `now reported (${to})` : 'no longer reported'}`);
    else if (kind === 'f:') lines.push(`file ${what}: ${base(name)}`);
    else if (kind === 'd:') lines.push(`files changed in: ${base(name)}`);
    else lines.push(what === 'changed' ? `${key}: ${from} -> ${to}` : `${key} ${what}`);
  };
  for (const k of d.added) word(k, 'added', undefined, b[k]);
  for (const k of d.removed) word(k, 'removed');
  for (const c of d.changed) if (!skip.has(c.key)) word(c.key, 'changed', c.from, c.to);
  // Plugins first, then everything else, each in key order.
  const order = (l: string) => (l.startsWith('plugin ') ? 0 : 1);
  lines.sort((x, y) => order(x) - order(y));
  return { lines, plugins: plugins.sort(), onlyPlugins: plugins.length > 0 && other === 0 };
}

const row = (db: DB, id: number) => db.prepare(
  'SELECT id, name, source, triage, folded_into, came_from_patch_id, inputs_json, first_seen_at FROM balance_patches WHERE id = ?',
).get(id) as { id: number; name: string | null; source: string; triage: string | null; folded_into: number | null;
  came_from_patch_id: number | null; inputs_json: string | null; first_seen_at: string } | undefined;

const inputsOf = (db: DB, id: number, ignored: string[]): Inventory | null => {
  const r = row(db, id);
  if (!r?.inputs_json) return null;
  try { return withoutIgnored(JSON.parse(r.inputs_json) as Inventory, ignored); } catch { return null; }
};

/** The patch a pending patch is judged against (and folded into by default):
 *  where its first server came from, else the newest earlier non-folded patch
 *  with inputs. For a folded patch, the patch it is folded into. */
function triageBaseId(db: DB, id: number): number | null {
  const r = row(db, id);
  if (!r) return null;
  if (r.triage === 'folded' && r.folded_into !== null) return resolvePatch(db, r.folded_into);
  if (r.came_from_patch_id !== null) {
    const b = resolvePatch(db, r.came_from_patch_id);
    if (b !== id) return b;
  }
  const prev = db.prepare(`SELECT id FROM balance_patches WHERE inputs_json IS NOT NULL AND COALESCE(triage, 'balance') != 'folded'
    AND id != ? AND (first_seen_at < ? OR (first_seen_at = ? AND id < ?)) ORDER BY first_seen_at DESC, id DESC LIMIT 1`)
    .get(id, r.first_seen_at, r.first_seen_at, id) as { id: number } | undefined;
  return prev?.id ?? null;
}

export function triageInfo(db: DB, id: number, lists: Lists) {
  const baseId = triageBaseId(db, id);
  const b = baseId === null ? undefined : row(db, baseId);
  const mine = inputsOf(db, id, lists.ignored);
  const theirs = baseId === null ? null : inputsOf(db, baseId, lists.ignored);
  const d = mine && theirs ? describeChanges(theirs, mine, lists.versionless) : { lines: [], plugins: [], onlyPlugins: false };
  return {
    base: b ? { id: b.id, number: patchNumber(db, b.id), name: b.name } : null,
    changes: d.lines, plugins: d.plugins, onlyPluginsChanged: d.onlyPlugins,
  };
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function triageBalance(db: DB, id: number, p: { name: unknown; notes: unknown }): TriageResult {
  const r = row(db, id);
  if (!r) return { ok: false, status: 404, error: 'no such patch' };
  if (r.triage !== 'pending') return { ok: false, status: 409, error: 'only a pending patch can be triaged' };
  const name = text(p.name), notes = typeof p.notes === 'string' ? p.notes.trim() : '';
  if (!name) return { ok: false, status: 400, error: 'a balance patch needs a name' };
  if (name.length > 60) return { ok: false, status: 400, error: 'a patch name is up to 60 characters' };
  if (notes.length > 2000) return { ok: false, status: 400, error: 'notes are up to 2000 characters' };
  db.prepare("UPDATE balance_patches SET triage = 'balance', name = ?, notes = ?, reviewed = 1 WHERE id = ?").run(name, notes, id);
  return { ok: true };
}

/** Checks shared by fold and ignore. Returns the resolved target id. */
function checkFold(db: DB, id: number, into: unknown, states: string[]): { ok: true; into: number } | Extract<TriageResult, { ok: false }> {
  const r = row(db, id);
  if (!r) return { ok: false, status: 404, error: 'no such patch' };
  if (r.source !== 'detected') return { ok: false, status: 400, error: 'only a detected patch can be folded' };
  if (!states.includes(r.triage ?? 'balance')) return { ok: false, status: 409, error: `a ${r.triage} patch cannot be folded here` };
  const ro = activeRollout(db);
  if (ro && ro.patch_id === id) return { ok: false, status: 409, error: 'this patch is the knob panel\'s active rollout; it cannot be folded' };
  if (typeof into !== 'number' || !Number.isInteger(into) || !row(db, into)) return { ok: false, status: 400, error: 'pick a patch to fold into' };
  let target: number;
  try { target = resolvePatch(db, into); } catch { return { ok: false, status: 409, error: 'the target is in a fold loop' }; }
  if (chainOf(db, into).includes(id)) return { ok: false, status: 400, error: 'that fold would make a loop' };
  if ((row(db, target)!.triage ?? 'balance') !== 'balance') return { ok: false, status: 400, error: 'fold into a balance patch' };
  return { ok: true, into: target };
}

export function triageFold(db: DB, id: number, into: unknown): TriageResult {
  return db.transaction((): TriageResult => {
    const c = checkFold(db, id, into, ['pending', 'balance']);
    if (!c.ok) return c;
    const f = foldInto(db, id, c.into);
    return f.ok ? { ok: true, target: f.target } : { ok: false, status: 400, error: f.error };
  })();
}

export function triageIgnore(db: DB, id: number, p: {
  into: unknown; plugins: unknown; versionless: string[]; knobsIgnored: string[]; adminId: string; now?: string;
}): TriageResult {
  return db.transaction((): TriageResult => {
    const c = checkFold(db, id, p.into, ['pending']);
    if (!c.ok) return c;
    const ignored = effectiveIgnored(db, p.knobsIgnored);
    const mine = inputsOf(db, id, ignored), theirs = inputsOf(db, c.into, ignored);
    if (!mine || !theirs) return { ok: false, status: 400, error: 'both patches need recorded inputs' };
    const d = describeChanges(theirs, mine, p.versionless);
    if (!d.onlyPlugins) return { ok: false, status: 400, error: 'ignoring plugins is only offered when every difference is a plugin' };
    const asked = Array.isArray(p.plugins) ? p.plugins : null;
    if (!asked || asked.some((f) => typeof f !== 'string' || !PLUGIN_FILE_RE.test(f))
      || [...new Set(asked as string[])].sort().join('|') !== d.plugins.join('|')) {
      return { ok: false, status: 400, error: `the plugins to ignore must be exactly the ones that differ: ${d.plugins.join(', ')}` };
    }
    addIgnored(db, d.plugins, { reason: `triage of patch #${patchNumber(db, id)}`, by: p.adminId, now: p.now ?? nowSql() });
    refingerprintPatches(db, p.versionless, effectiveIgnored(db, p.knobsIgnored), (e) => console.warn(`[balance] ${e.text}`));
    if (resolvePatch(db, id) !== resolvePatch(db, c.into)) {
      const f = foldInto(db, id, c.into);
      if (!f.ok) return { ok: false, status: 400, error: f.error };
    }
    return { ok: true, target: resolvePatch(db, id) };
  })();
}

export function triageUnfold(db: DB, id: number): TriageResult {
  const r = row(db, id);
  if (!r) return { ok: false, status: 404, error: 'no such patch' };
  if (r.triage !== 'folded') return { ok: false, status: 409, error: 'this patch is not folded' };
  unfoldPatch(db, id);
  return { ok: true };
}
```

Note: `refingerprintPatches` publishes a merge event through its `publish` parameter; here it logs only (the admin route audits the decision).

**Import cycle check:** `balanceTriage` imports `balancePatches`, `balanceFold`, `balanceIgnore`, `balanceRollouts`, `balanceControl`. `balancePatches` must **not** import `balanceTriage` at module top level for anything evaluated at import; `listPatches` calls `triageInfo`, which is a function call at run time, so a static import is fine under ESM (both modules only define functions). If vitest reports an undefined import, move `describeChanges`/`triageInfo`/`triageBaseId` into `balancePatches.ts` instead and re-export them from `balanceTriage.ts`.

In `src/balancePatches.ts`:

```ts
export type TriageState = 'pending' | 'balance' | 'folded';
export interface PatchSummary {
  ... existing fields ...
  /** A folded patch (by triage or by the refingerprint): its rounds count for `foldedInto`. */
  merged: boolean;
  triage: TriageState;
  foldedInto: number | null;
  /** Pending or folded: the patch it is judged against / folded into, the
   *  differences in plain words, the plugins among them, and whether plugins
   *  are all that differ. Empty for a balance patch. */
  triageBase: { id: number; number: number; name: string | null } | null;
  changes: string[];
  plugins: string[];
  onlyPluginsChanged: boolean;
}
```

`listPatches(db, lists: Lists = { versionless: [], ignored: [] })`: select `COALESCE(p.triage, 'balance') AS triage, p.folded_into`, drop the `merged` SQL expression, and map:

```ts
  return rows.map((r) => {
    const info = r.triage === 'balance' ? null : triageInfo(db, r.id, lists);
    return {
      ...existing fields...,
      merged: r.triage === 'folded', triage: r.triage, foldedInto: r.folded_into,
      triageBase: info?.base ?? null, changes: info?.changes ?? [], plugins: info?.plugins ?? [],
      onlyPluginsChanged: info?.onlyPluginsChanged ?? false,
    };
  });
```

`patchDetail(db, id, lists?)` passes `lists` to `listPatches`.

`serverDrift(db, ignored: string[] = [])`: parse each `inventory_json` through `withoutIgnored(..., ignored)` before diffing.

Update `tests/balanceAdmin.test.ts` / any test that builds a `PatchSummary` literal only if typecheck complains (server-side tests read JSON, so they should not).

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run tests/balanceTriage.test.ts tests/balancePatches.test.ts tests/balanceAdmin.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/balanceTriage.ts src/balancePatches.ts tests/balanceTriage.test.ts
git commit -m "balance triage: decisions and the plain-words diff"
```

---

### Task 7: Admin routes (moved and new), audited

**Files:**
- Create: `src/routes/adminBalancePatches.ts`
- Modify: `src/routes/admin.ts` (remove the four balance patch routes and the `balancePatches.js` import)
- Modify: `src/server.ts` (register with `panelKnobs`)
- Test: `tests/balanceTriageRoutes.test.ts` (new); `tests/balanceAdmin.test.ts` must still pass unchanged

**Interfaces:**
- Consumes: Tasks 3, 6.
- Produces (all admin only; 403 for a non-admin as `requireAdmin` does):
  - `GET /api/admin/balance/patches` → `{ patches: PatchSummary[] }`
  - `GET /api/admin/balance/patches/:id` → `PatchDetail`
  - `POST /api/admin/balance/patches/:id` (edit, unchanged behaviour, audited `edit_patch`)
  - `GET /api/admin/balance/drift` → `{ servers }`
  - `POST /api/admin/balance/patches/:id/triage` body `{ decision: 'balance', name, notes } | { decision: 'fold', into } | { decision: 'ignore', into, plugins }` → `{ ok: true, target? }`, audited `triage_patch` with `{ decision, into?, plugins?, name? }`
  - `POST /api/admin/balance/patches/:id/unfold` → `{ ok: true }`, audited `unfold_patch`
  - `GET /api/admin/balance/ignored-plugins` → `{ plugins: IgnoredPlugin[] }`
  - `DELETE /api/admin/balance/ignored-plugins/:file` → `{ ok: true }`, audited `unignore_plugin`; 409 for a knobs.json-only entry; runs the refingerprint.
  - The ignore decision and DELETE answer 503 when knobs.json failed to load (they need `versionless`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/balanceTriageRoutes.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { recordBalanceSighting } from '../src/balancePatches.js';
import { addIgnored } from '../src/balanceIgnore.js';
import { KNOBS } from './balanceFixtures.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN = '76561198000000009';
const USER = '76561198000000010';
const BASE = { 'c:z_tank_health': '8000', 'p:pug-match.smx': '1.a' };

describe('patch triage routes', () => {
  let db: ReturnType<typeof openDb>;
  let knobsPath: string;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('d'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a'), (1, 0, 2, 'b')").run();
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: BASE, versionless: KNOBS.versionless, now: '2026-09-20 00:00:00' });
    db.prepare("UPDATE balance_patches SET triage = 'balance', name = 'Base' WHERE id = 1").run();
    recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: { ...BASE, 'p:x_noise.smx': '1.a' }, versionless: KNOBS.versionless, now: '2026-09-21 00:00:00' });
    knobsPath = join(mkdtempSync(join(tmpdir(), 'knobs-')), 'knobs.json');
    writeFileSync(knobsPath, JSON.stringify(KNOBS));
  });

  async function app(asAdmin = true) {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {}, balanceKnobsPath: knobsPath });
    const cookies = await authedCookie(a, db, asAdmin ? ADMIN : USER);
    if (asAdmin) db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies };
  }

  it('lists the pending patch with its card info', async () => {
    const { a, cookies } = await app();
    const body = (await a.inject({ method: 'GET', url: '/api/admin/balance/patches', cookies })).json() as { patches: { id: number; triage: string; changes: string[]; onlyPluginsChanged: boolean; triageBase: { id: number } }[] };
    expect(body.patches[1]).toMatchObject({ id: 2, triage: 'pending', changes: ['plugin added: x_noise'], onlyPluginsChanged: true, triageBase: { id: 1 } });
  });

  it('refuses a non-admin', async () => {
    const { a, cookies } = await app(false);
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/patches/2/triage', cookies, payload: { decision: 'fold', into: 1 } });
    expect(res.statusCode).toBe(403);
  });

  it('balance, fold, unfold and ignore, each audited', async () => {
    const { a, cookies } = await app();
    const post = (url: string, payload?: object) => a.inject({ method: 'POST', url, cookies, payload: payload ?? {} });
    expect((await post('/api/admin/balance/patches/2/triage', { decision: 'bogus' })).statusCode).toBe(400);
    expect((await post('/api/admin/balance/patches/2/triage', { decision: 'fold', into: 1 })).json()).toEqual({ ok: true, target: 1 });
    expect((await post('/api/admin/balance/patches/2/unfold')).json()).toEqual({ ok: true });
    const ig = await post('/api/admin/balance/patches/2/triage', { decision: 'ignore', into: 1, plugins: ['x_noise.smx'] });
    expect(ig.json()).toEqual({ ok: true, target: 1 });
    const list = (await a.inject({ method: 'GET', url: '/api/admin/balance/ignored-plugins', cookies })).json() as { plugins: { file: string; source: string }[] };
    expect(list.plugins.map((p) => [p.file, p.source])).toEqual([['l4d_tvwatch.smx', 'knobs'], ['x_noise.smx', 'site']]);
    const actions = (db.prepare("SELECT action FROM admin_actions WHERE action IN ('triage_patch','unfold_patch') ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['triage_patch', 'unfold_patch', 'triage_patch']);
  });

  it('balance decision names the patch', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/patches/2/triage', cookies, payload: { decision: 'balance', name: 'Noise on', notes: '' } });
    expect(res.json()).toEqual({ ok: true });
    expect(db.prepare('SELECT triage, name FROM balance_patches WHERE id = 2').get()).toEqual({ triage: 'balance', name: 'Noise on' });
  });

  it('removing a site ignored plugin works and is audited; a knobs.json one is refused', async () => {
    addIgnored(db, ['x_noise.smx'], { reason: 'r', by: ADMIN, now: 'x' });
    const { a, cookies } = await app();
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/balance/ignored-plugins/x_noise.smx', cookies })).json()).toEqual({ ok: true });
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/balance/ignored-plugins/l4d_tvwatch.smx', cookies })).statusCode).toBe(409);
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/balance/ignored-plugins/nope.smx', cookies })).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'unignore_plugin'").get()).toEqual({ n: 1 });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (404 on the new URLs)

Run: `npx vitest run tests/balanceTriageRoutes.test.ts`

- [ ] **Step 3: Implement `src/routes/adminBalancePatches.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import type { BalanceKnobs } from '../balanceKnobs.js';
import { editPatch, listPatches, patchDetail, refingerprintPatches, serverDrift } from '../balancePatches.js';
import { effectiveIgnored, listIgnored, PLUGIN_FILE_RE, removeIgnored } from '../balanceIgnore.js';
import { triageBalance, triageFold, triageIgnore, triageUnfold, type Lists } from '../balanceTriage.js';

export interface PatchRouteOpts {
  db: DB;
  /** Null when balance/knobs.json failed to load: the list still works (with
   *  the site ignore list only); ignoring plugins answers 503. */
  knobs: BalanceKnobs | null;
}

const idOf = (req: { params: unknown }): number | null => {
  const raw = (req.params as { id: string }).id;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
};

/** The Patches tab: list, detail, edit, drift, triage and the site ignore
 *  list. Moved out of routes/admin.ts because triage needs the knobs. */
export async function adminBalancePatchRoutes(app: FastifyInstance, opts: PatchRouteOpts): Promise<void> {
  const { db, knobs } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const lists = (): Lists => ({ versionless: knobs?.versionless ?? [], ignored: effectiveIgnored(db, knobs?.ignored) });
  const unavailable = { error: 'balance/knobs.json failed to load; ignoring plugins is unavailable until it is fixed' };

  app.get('/api/admin/balance/patches', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { patches: listPatches(db, lists()) };
  });

  app.get('/api/admin/balance/patches/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const id = idOf(req);
    const d = id === null ? null : patchDetail(db, id, lists());
    return d ?? reply.code(404).send({ error: 'no such patch' });
  });

  app.get('/api/admin/balance/drift', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { servers: serverDrift(db, lists().ignored) };
  });

  // (the POST /api/admin/balance/patches/:id edit handler, moved verbatim from routes/admin.ts)

  app.post('/api/admin/balance/patches/:id/triage', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such patch' });
    const b = (req.body ?? {}) as { decision?: unknown; name?: unknown; notes?: unknown; into?: unknown; plugins?: unknown };
    let r;
    if (b.decision === 'balance') r = triageBalance(db, id, { name: b.name, notes: b.notes });
    else if (b.decision === 'fold') r = triageFold(db, id, b.into);
    else if (b.decision === 'ignore') {
      if (!knobs) return reply.code(503).send(unavailable);
      r = triageIgnore(db, id, { into: b.into, plugins: b.plugins, versionless: knobs.versionless, knobsIgnored: knobs.ignored ?? [], adminId });
    } else return reply.code(400).send({ error: 'decision is balance, fold or ignore' });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, 'triage_patch', id, {
      decision: b.decision,
      ...(b.decision === 'balance' ? { name: typeof b.name === 'string' ? b.name.trim() : '' } : { into: r.target }),
      ...(b.decision === 'ignore' ? { plugins: b.plugins } : {}),
    });
    return r.target === undefined ? { ok: true } : { ok: true, target: r.target };
  });

  app.post('/api/admin/balance/patches/:id/unfold', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such patch' });
    const r = triageUnfold(db, id);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, 'unfold_patch', id);
    return { ok: true };
  });

  app.get('/api/admin/balance/ignored-plugins', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { plugins: listIgnored(db, knobs?.ignored ?? []) };
  });

  app.delete('/api/admin/balance/ignored-plugins/:file', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    const file = (req.params as { file: string }).file;
    if (!PLUGIN_FILE_RE.test(file)) return reply.code(400).send({ error: 'not a plugin file name' });
    if (!removeIgnored(db, file)) {
      return (knobs.ignored ?? []).includes(file)
        ? reply.code(409).send({ error: 'this plugin is ignored by balance/knobs.json; remove it there' })
        : reply.code(404).send({ error: 'not on the ignored list' });
    }
    // Past folds stay; the next sighting that includes the plugin opens a new pending patch.
    refingerprintPatches(db, knobs.versionless, effectiveIgnored(db, knobs.ignored), (e) => console.warn(`[balance] ${e.text}`));
    logAdmin(db, adminId, 'unignore_plugin', file);
    return { ok: true };
  });
}
```

Move the existing `app.post('/api/admin/balance/patches/:id', ...)` handler body from `src/routes/admin.ts` into the marked spot unchanged, and delete the four balance patch routes (list, detail, drift, edit) and the `editPatch, listPatches, patchDetail, serverDrift` import from `routes/admin.ts`. Leave the compare and metric routes where they are.

In `src/server.ts`, next to the knob routes:

```ts
  await app.register(adminBalancePatchRoutes, { db: deps.db, knobs: panelKnobs });
```

with `import { adminBalancePatchRoutes } from './routes/adminBalancePatches.js';`.

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run tests/balanceTriageRoutes.test.ts tests/balanceAdmin.test.ts tests/balanceCompareRoutes.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/routes/adminBalancePatches.ts src/routes/admin.ts src/server.ts tests/balanceTriageRoutes.test.ts
git commit -m "balance triage: admin routes for triage, unfold and the ignore list"
```

---

### Task 8: Interactions with the knob panel and the public page

**Files:**
- Modify: `src/balancePublic.ts` (`publishPatch`, `publicEntry`'s `live`)
- Modify: `src/routes/balancePublic.ts` (effective ignore list per request)
- Modify: `src/balanceControl.ts` (`baseInventory`, `previewKnobs`' `existingPatch`)
- Modify: `src/balanceRollouts.ts` (`applyKnobs`)
- Modify: `src/routes/adminBalanceKnobs.ts` (effective list per request, `restorable`)
- Test: `tests/balancePublic.test.ts`, `tests/balanceControl.test.ts`, `tests/balanceRollouts.test.ts`, `tests/balanceKnobRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3.
- Produces: `KnobPreview.existingPatch` gains `triage: 'pending' | 'balance' | 'folded'`. `publishPatch` errors: pending → `'triage it first: publish only a balance patch'`; folded → `'this patch was folded into another one; publish that patch instead'`.

- [ ] **Step 1: Write the failing tests**

`tests/balancePublic.test.ts` (inside the existing `publishPatch` describe, reusing its setup; adapt the insert helper name the file uses):

```ts
  it('refuses a pending patch and a folded one', () => {
    db.prepare("UPDATE balance_patches SET triage = 'pending' WHERE id = ?").run(p2);
    expect(publishPatch(db, p2, true)).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/triage it first/) });
    db.prepare("UPDATE balance_patches SET triage = 'folded', folded_into = ? WHERE id = ?").run(p1, p2);
    expect(publishPatch(db, p2, true)).toMatchObject({ ok: false, error: expect.stringMatching(/folded/) });
  });
```

(`p1`/`p2`: whichever two patch ids that describe already creates with names, notes and counted rounds. Replace the existing "merged patch" publish test: it now sets `triage = 'folded'` instead of `fingerprint = NULL`.)

`tests/balanceRollouts.test.ts`:

```ts
  it('reusing a pending patch makes it balance; a folded one is refused', () => {
    // Sight the exact config the draft predicts, so preview finds it as existingPatch.
    const preview = previewKnobs(db, KNOBS, { z_tank_health: '7500' });
    db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage) VALUES (?, 'detected', '{}', '2026-09-24 03:00:00', 'pending')").run(preview.fingerprint);
    const ok = applyKnobs(db, KNOBS, { values: { z_tank_health: '7500' }, name: 'T', notes: 'n', adminId: '1' });
    expect(ok).toMatchObject({ ok: true, reused: true });
    expect(db.prepare('SELECT triage FROM balance_patches WHERE fingerprint = ?').get(preview.fingerprint)).toEqual({ triage: 'balance' });
    db.prepare("UPDATE balance_patches SET triage = 'folded', folded_into = 1 WHERE fingerprint = ?").run(preview.fingerprint);
    expect(applyKnobs(db, KNOBS, { values: { z_tank_health: '7500' }, name: 'T', notes: 'n', adminId: '1' }))
      .toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/folded/) });
  });
```

(Use that file's existing `beforeEach`, which sights `LIVE` through `sight()` so a base exists.)

`tests/balanceControl.test.ts`:

```ts
  it('predicts from the sighted patch, not the patch it was folded into', () => {
    const a = sight(db, 1, 1, LIVE);
    const b = sight(db, 2, 1, { ...LIVE, 'p:x_noise.smx': '1.a' }, 'queue', '2026-09-24 02:00:00');
    foldInto(db, b.patchId, a.patchId);
    expect(baseInventory(db)!.patchId).toBe(b.patchId);
  });
```

(with `import { foldInto } from '../src/balanceFold.js';`)

`tests/balanceKnobRoutes.test.ts`:

```ts
  it('restore lists only balance patches and blocking uses the site ignore list', async () => {
    // inside the file's existing app/cookies setup
    db.prepare("UPDATE balance_patches SET triage = 'pending'").run();
    const body = (await a.inject({ method: 'GET', url: '/api/admin/balance/knobs', cookies })).json() as { restorable: unknown[] };
    expect(body.restorable).toEqual([]);
  });
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run tests/balancePublic.test.ts tests/balanceControl.test.ts tests/balanceRollouts.test.ts tests/balanceKnobRoutes.test.ts`

- [ ] **Step 3: Implement**

`src/balancePublic.ts` `publishPatch`: select `COALESCE(triage, 'balance') AS triage` in place of the `merged` expression, and replace the merged check:

```ts
  if (row.triage === 'pending') return { ok: false, status: 400, error: 'triage it first: publish only a balance patch' };
  // A folded patch's rounds count for the patch it was folded into: publish that one.
  if (row.triage === 'folded') return { ok: false, status: 400, error: 'this patch was folded into another one; publish that patch instead' };
```

`publicEntry`'s `live`: a server on a patch folded into this one counts:

```ts
  const onServers = (db.prepare('SELECT patch_id FROM balance_server_state').all() as { patch_id: number }[])
    .some((s) => resolvePatch(db, s.patch_id) === id);
  const live = line[line.length - 1].id === id || onServers;
```

(`import { resolvePatch } from './balanceFold.js';`)

`src/routes/balancePublic.ts`: compute labels per request:

```ts
  const labels = (): KnobLabels => withEffectiveIgnored(db, knobs ?? { cvars: [], files: [], dirs: [], versionless: [] });
```

and pass `{ knobs: labels() }` / `{ knobs: labels(), preview: true }`. Import `withEffectiveIgnored` and `type KnobLabels`.

`src/balanceControl.ts` `baseInventory`: `JOIN balance_patches p ON p.id = COALESCE(r.sighted_patch_id, r.patch_id)` with a comment: "the config the servers actually ran, not the patch it was folded into, so the predicted fingerprint matches what they will report". `previewKnobs`: select `COALESCE(triage, 'balance') AS triage` into `existingPatch`, and add `triage` to the `KnobPreview['existingPatch']` type and to `web/src/api.ts`'s `KnobPreview.existingPatch` (Task 9 touches that file too).

`src/balanceRollouts.ts` `applyKnobs`, first thing inside `if (preview.existingPatch) {`:

```ts
      if (p.triage === 'folded') {
        return { ok: false, status: 409, preview,
          error: `This config was folded into another patch as not a balance change. Unfold patch #${p.number} in the Patches tab first.` };
      }
```

and after the name/notes handling:

```ts
      // Choosing this config in the panel is deciding it is a balance patch.
      db.prepare("UPDATE balance_patches SET triage = 'balance' WHERE id = ? AND triage = 'pending'").run(patchId);
```

The new-patch INSERT adds `triage` = `'balance'`:

```ts
      patchId = Number(db.prepare(`INSERT INTO balance_patches (fingerprint, name, notes, source, inputs_json, first_seen_at, reviewed, triage)
        VALUES (?, ?, ?, 'announced', ?, ?, 1, 'balance')`).run(preview.fingerprint, name, notes, invJson, now).lastInsertRowid);
```

`src/routes/adminBalanceKnobs.ts`: every route uses `const k = knobs && withEffectiveIgnored(db, knobs)` computed at the top of the handler in place of `knobs` (after the 503 check), and `restorable` adds `AND COALESCE(triage, 'balance') = 'balance'` to its WHERE.

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run tests/balance*.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/balancePublic.ts src/routes/balancePublic.ts src/balanceControl.ts src/balanceRollouts.ts src/routes/adminBalanceKnobs.ts tests/
git commit -m "balance triage: knob panel and public page respect triage state"
```

---

### Task 9: Patches tab (triage card, folded collapse, ignored list) and Compare pickers

**Files:**
- Modify: `web/src/api.ts`
- Create: `web/src/routes/admin/TriageCard.tsx`
- Modify: `web/src/routes/admin/AdminPatches.tsx`, `web/src/routes/admin/balance/Compare.tsx`
- Test: `web/src/routes/admin/AdminPatches.test.tsx`, `web/src/routes/admin/balance/Compare.test.tsx`

**Interfaces:**
- Consumes: Task 7 routes.
- Produces: `PatchSummary` (web) gains `triage`, `foldedInto`, `onlyPluginsChanged`, `triageBase`, `changes`, `plugins`; `IgnoredPlugin`; `adminApi.triageBalancePatch(id, body)`, `adminApi.unfoldBalancePatch(id)`, `adminApi.balanceIgnoredPlugins(signal?)`, `adminApi.removeIgnoredPlugin(file)`.

- [ ] **Step 1: Write the failing tests**

In `AdminPatches.test.tsx`: extend `mockAdmin` with `triageBalancePatch: vi.fn(), unfoldBalancePatch: vi.fn(), balanceIgnoredPlugins: vi.fn(), removeIgnoredPlugin: vi.fn()`; give every `PatchSummary` literal the new fields (`triage: 'balance', foldedInto: null, onlyPluginsChanged: false, triageBase: null, changes: [], plugins: []`), and in `beforeEach` (add one) `mockAdmin.balanceIgnoredPlugins.mockResolvedValue({ plugins: [] })`. New tests:

```tsx
  const pending: PatchSummary = {
    id: 3, number: 3, name: null, notes: '', source: 'detected', firstSeenAt: '2026-09-24 03:00:00', reviewed: false,
    rounds: 2, countedRounds: 2, servers: [{ serverId: 1, name: 'dallas', lastSeenAt: 'x' }], publishedAt: null,
    triage: 'pending', foldedInto: null, onlyPluginsChanged: true, triageBase: { id: 1, number: 1, name: 'Baseline' },
    changes: ['plugin added: l4d_tvwatch'], plugins: ['l4d_tvwatch.smx'],
  };

  it('shows a triage card with the changes, the plugin hint and three decisions', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches: [patches[0], pending] });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    mockAdmin.triageBalancePatch.mockResolvedValue({ ok: true, target: 1 });
    render(<AdminPatches />);
    expect(await screen.findByText('plugin added: l4d_tvwatch')).toBeTruthy();
    expect(screen.getByText(/Only plugins changed/)).toBeTruthy();
    expect(screen.getByText(/dallas/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not balance, fold just this once' }));
    await waitFor(() => expect(mockAdmin.triageBalancePatch).toHaveBeenCalledWith(3, { decision: 'fold', into: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Not balance, ignore these plugins from now on' }));
    await waitFor(() => expect(mockAdmin.triageBalancePatch).toHaveBeenCalledWith(3, { decision: 'ignore', into: 1, plugins: ['l4d_tvwatch.smx'] }));
  });

  it('balance decision asks for a name', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches: [patches[0], pending] });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    mockAdmin.triageBalancePatch.mockResolvedValue({ ok: true });
    render(<AdminPatches />);
    await screen.findByText('plugin added: l4d_tvwatch');
    const submit = screen.getByRole('button', { name: 'Balance patch' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Name for patch 3'), { target: { value: 'TV watch' } });
    fireEvent.click(submit);
    await waitFor(() => expect(mockAdmin.triageBalancePatch).toHaveBeenCalledWith(3, { decision: 'balance', name: 'TV watch', notes: '' }));
  });

  it('offers no ignore button when more than plugins changed', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches: [patches[0], { ...pending, onlyPluginsChanged: false, changes: ['z_tank_health 8000 -> 7500'], plugins: [] }] });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    render(<AdminPatches />);
    await screen.findByText('z_tank_health 8000 -> 7500');
    expect(screen.queryByRole('button', { name: 'Not balance, ignore these plugins from now on' })).toBeNull();
  });

  it('collapses a folded patch under its target with unfold, and lists ignored plugins with remove', async () => {
    const folded = { ...pending, triage: 'folded' as const, foldedInto: 1, merged: true };
    mockAdmin.balancePatches.mockResolvedValue({ patches: [patches[0], folded] });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    mockAdmin.balanceIgnoredPlugins.mockResolvedValue({ plugins: [
      { file: 'x_noise.smx', reason: 'triage of patch #4', addedBy: '1', addedAt: '2026-09-24 00:00:00', source: 'site' },
      { file: 'l4d_tvwatch.smx', reason: '', addedBy: null, addedAt: null, source: 'knobs' },
    ] });
    mockAdmin.unfoldBalancePatch.mockResolvedValue({ ok: true });
    mockAdmin.removeIgnoredPlugin.mockResolvedValue({ ok: true });
    render(<AdminPatches />);
    expect(await screen.findByText(/includes 1 folded config: plugin added l4d_tvwatch/)).toBeTruthy();
    expect(screen.queryByText('Unnamed patch 3')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unfold patch 3' }));
    await waitFor(() => expect(mockAdmin.unfoldBalancePatch).toHaveBeenCalledWith(3));
    expect(await screen.findByText('x_noise.smx')).toBeTruthy();
    expect(screen.getByText(/knobs\.json/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove x_noise.smx' }));
    await waitFor(() => expect(mockAdmin.removeIgnoredPlugin).toHaveBeenCalledWith('x_noise.smx'));
  });
```

In `Compare.test.tsx` (its patch fixtures gain the same new fields):

```tsx
  it('hides folded patches and tags pending ones', async () => {
    // use the file's existing mock setup; patches: one balance, one pending, one folded
    mockAdmin.balancePatches.mockResolvedValue({ patches: [
      { ...P1, triage: 'balance' }, { ...P2, id: 2, number: 2, name: 'Pend', triage: 'pending' },
      { ...P2, id: 3, number: 3, name: 'Gone', triage: 'folded', foldedInto: 1, merged: true },
    ] });
    render(<Compare />);
    expect((await screen.findAllByText(/Pend .*needs triage/)).length).toBe(2); // once per side
    expect(screen.queryByText(/Gone/)).toBeNull();
  });
```

(`P1`/`P2`: the file's existing `PatchSummary` fixtures; rename to match.)

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run web/src/routes/admin/AdminPatches.test.tsx web/src/routes/admin/balance/Compare.test.tsx`

- [ ] **Step 3: Implement**

`web/src/api.ts`:

```ts
export interface PatchSummary {
  ...existing...
  /** pending: undecided; balance: a real patch; folded: not balance, its rounds count for `foldedInto`. */
  triage: 'pending' | 'balance' | 'folded';
  foldedInto: number | null;
  /** Pending or folded only: what it is judged against (the default fold target) and the differences in plain words. */
  triageBase: { id: number; number: number; name: string | null } | null;
  changes: string[];
  plugins: string[];
  onlyPluginsChanged: boolean;
}
export interface IgnoredPlugin { file: string; reason: string; addedBy: string | null; addedAt: string | null; source: 'site' | 'knobs' }
export type TriageBody = { decision: 'balance'; name: string; notes: string } | { decision: 'fold'; into: number } | { decision: 'ignore'; into: number; plugins: string[] };
```

`KnobPreview.existingPatch` gains `triage: 'pending' | 'balance' | 'folded'`. In `adminApi` (next to `publishBalancePatch`; use the file's existing `post` and a `del` helper if one exists, otherwise the same fetch wrapper the other DELETE calls in `adminApi` use):

```ts
  triageBalancePatch: (id: number, body: TriageBody) => post<{ ok: true; target?: number }>(`/api/admin/balance/patches/${id}/triage`, body),
  unfoldBalancePatch: (id: number) => post(`/api/admin/balance/patches/${id}/unfold`, {}),
  balanceIgnoredPlugins: (signal?: AbortSignal) => get<{ plugins: IgnoredPlugin[] }>('/api/admin/balance/ignored-plugins', signal),
  removeIgnoredPlugin: (file: string) => del(`/api/admin/balance/ignored-plugins/${encodeURIComponent(file)}`),
```

`web/src/routes/admin/TriageCard.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type PatchSummary } from '../../api';
import { Panel } from '../../components/bits';

const label = (p: { number: number; name: string | null }) => p.name ?? `Unnamed patch ${p.number}`;

/** One pending patch: what changed in plain words, which servers run it, and
 *  the three decisions. No default: every button is an explicit choice. */
export function TriageCard({ patch, targets, run, busy }: {
  patch: PatchSummary;
  /** Balance patches it can be folded into, newest first. */
  targets: PatchSummary[];
  run: (f: () => Promise<unknown>) => Promise<unknown>;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [into, setInto] = useState<number | null>(patch.triageBase?.id ?? targets[0]?.id ?? null);
  const baseChosen = into !== null && into === patch.triageBase?.id;
  return (
    <Panel>
      <h3>Needs triage: {label(patch)}</h3>
      <p class="muted">
        Against {patch.triageBase ? label(patch.triageBase) : 'no earlier patch'}
        {patch.servers.length > 0 && <>, running on {patch.servers.map((s) => s.name).join(', ')}</>}.
      </p>
      {patch.changes.length > 0
        ? <ul class="admin-list">{patch.changes.map((c) => <li key={c}>{c}</li>)}</ul>
        : <p class="muted">No recorded differences to show.</p>}
      {patch.onlyPluginsChanged && (
        <p class="balance-banner">Only plugins changed. Probably not a balance change, but plugin updates can be (sky pounce 0.4.0 was).</p>
      )}
      <form class="admin-form" onSubmit={(e) => {
        e.preventDefault();
        void run(() => adminApi.triageBalancePatch(patch.id, { decision: 'balance', name: name.trim(), notes }));
      }}>
        <input value={name} maxLength={60} placeholder="Patch name" aria-label={`Name for patch ${patch.number}`}
          onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <textarea value={notes} maxLength={2000} placeholder="Notes" aria-label={`Notes for patch ${patch.number}`}
          onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
        <button class="btn" type="submit" disabled={busy || name.trim() === ''}>Balance patch</button>
      </form>
      <div class="admin-form">
        <label>Fold into
          <select value={into ?? ''} onChange={(e) => setInto(Number((e.target as HTMLSelectElement).value))}>
            {targets.map((t) => <option key={t.id} value={t.id}>#{t.number} {label(t)}</option>)}
          </select>
        </label>
        <button class="btn" type="button" disabled={busy || into === null}
          onClick={() => void run(() => adminApi.triageBalancePatch(patch.id, { decision: 'fold', into: into! }))}>
          Not balance, fold just this once
        </button>
        {patch.onlyPluginsChanged && baseChosen && (
          <button class="btn" type="button" disabled={busy}
            onClick={() => void run(() => adminApi.triageBalancePatch(patch.id, { decision: 'ignore', into: into!, plugins: patch.plugins }))}>
            Not balance, ignore these plugins from now on
          </button>
        )}
      </div>
    </Panel>
  );
}
```

(The ignore button is shown only while the chosen target is the card's base, because `onlyPluginsChanged` and `plugins` are computed against that base; the server checks again.)

`AdminPatches.tsx`:
- Fetch `const ignored = useFetch((s) => adminApi.balanceIgnoredPlugins(s), []);` and make `useAction`'s reload refresh both lists: `useAction(() => { patches.reload(); ignored.reload(); })` (match `useAction`'s reload signature; if it takes one function, wrap).
- Above the drift panel: `{list.filter((p) => p.triage === 'pending').map((p) => <TriageCard key={p.id} patch={p} targets={balanceNewestFirst} run={run} busy={busy} />)}` where `balanceNewestFirst = [...list].reverse().filter((p) => p.triage === 'balance')`.
- Table rows: skip `triage === 'folded'`; a pending row gets `<span class="admin-tag">needs triage</span>` in the Name cell. Under each row with folded patches (`list.filter((f) => f.foldedInto === p.id)`), render one extra row:

```tsx
<tr key={`${p.id}-folded`}><td /><td colSpan={7} class="muted">
  includes {folded.length} folded config{folded.length === 1 ? '' : 's'}: {folded.map((f) => (
    <span key={f.id}>{f.changes.join(', ') || `patch ${f.number}`}{' '}
      <button class="btn btn--small" type="button" disabled={busy} aria-label={`Unfold patch ${f.number}`}
        onClick={() => void run(() => adminApi.unfoldBalancePatch(f.id))}>Unfold</button></span>
  ))}
</td></tr>
```

  The folded changes are worded "plugin added: l4d_tvwatch"; the collapse line strips the colon so it reads "plugin added l4d_tvwatch": use `f.changes.map((c) => c.replace(': ', ' ')).join(', ')`.
- After the patch table, an "Ignored plugins" panel:

```tsx
<Panel>
  <h3>Ignored plugins</h3>
  <p class="muted">Left out of the balance fingerprint: adding, removing or updating one never makes a patch.</p>
  {ignored.error && <Empty>Could not load the ignored plugins.</Empty>}
  <ul class="admin-list">{(ignored.data?.plugins ?? []).map((p) => (
    <li key={p.file}><code>{p.file}</code>{' '}
      {p.source === 'knobs'
        ? <span class="muted">(from balance/knobs.json)</span>
        : <>{p.reason && <span class="muted">{p.reason} </span>}
            <button class="btn btn--small" type="button" disabled={busy} aria-label={`Remove ${p.file}`}
              onClick={() => void run(() => adminApi.removeIgnoredPlugin(p.file))}>Remove</button></>}
    </li>))}
  </ul>
</Panel>
```

  Use whichever small-button class exists in `web/src/app.css` (`grep -n "btn--" web/src/app.css`); if none, plain `btn`.

`Compare.tsx`:
- `const list = (patches.data?.patches ?? []).filter((p) => p.triage !== 'folded');`
- Defaults: `list.filter((p) => p.countedRounds > 0 && p.triage === 'balance')`.
- `patchLabel` adds ` · needs triage` when `p.triage === 'pending'`: `` `${patchName(p)} (${p.countedRounds} rounds counted)${p.triage === 'pending' ? ' · needs triage' : ''}` ``.
- Remove the `!p.merged` default filter (folded are already out of `list`) and update its comment.

`Knobs.tsx` needs no change (restorable is filtered server-side).

- [ ] **Step 4: Run web tests and typecheck, expect PASS**

Run: `npx vitest run web/src/routes/admin && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "balance triage: triage card, folded collapse and ignored plugins in the Patches tab"
```

---

### Task 10: Copy-of-production check script and runbook

**Files:**
- Create: `scripts/balance-triage-report.ts`
- Modify: `docs/superpowers/plans/2026-09-24-balance-patch-triage.md` (tick boxes only)

**Interfaces:**
- Consumes: `openDb`, `loadBalanceKnobs`, `effectiveIgnored`, `refingerprintPatches`, `listPatches`.

- [ ] **Step 1: Write the script**

```ts
/**
 * Run the triage migration and the boot refingerprint on a COPY of the
 * production database and print every patch's triage state.
 *
 *   cp pug.db /tmp/pug-copy.db && npx tsx scripts/balance-triage-report.ts /tmp/pug-copy.db
 *
 * Refuses a path that does not contain "copy", so it is never pointed at the
 * live file by mistake.
 */
import { openDb } from '../src/db.js';
import { loadBalanceKnobs } from '../src/balanceKnobs.js';
import { effectiveIgnored } from '../src/balanceIgnore.js';
import { listPatches, refingerprintPatches } from '../src/balancePatches.js';

const path = process.argv[2];
if (!path || !path.includes('copy')) {
  console.error('usage: balance-triage-report.ts <path containing "copy">');
  process.exit(2);
}
const db = openDb(path);
const knobs = loadBalanceKnobs();
const ignored = effectiveIgnored(db, knobs.ignored);
refingerprintPatches(db, knobs.versionless, ignored, (e) => console.log(`event: ${e.text}`));
for (const p of listPatches(db, { versionless: knobs.versionless, ignored })) {
  const into = p.foldedInto === null ? '' : ` -> ${p.foldedInto}`;
  console.log(`#${p.number} (id ${p.id}) ${p.source} ${p.triage}${into}  ${p.name ?? '(unnamed)'}  rounds=${p.rounds}`);
  for (const c of p.changes) console.log(`    ${c}`);
}
```

- [ ] **Step 2: Run it on a synthetic copy to prove it works**

```bash
npx tsx scripts/balance-triage-report.ts "$SCRATCH/triage-copy.db"
```

(`$SCRATCH` = the session scratchpad. openDb creates an empty database there, so it prints nothing and exits 0. Also run it with a path that does not contain "copy" and expect exit code 2.)

- [ ] **Step 3: Full suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add scripts/balance-triage-report.ts
git commit -m "balance triage: copy-of-production report script"
```

**Owner runbook before ship (not done by the agent: needs production access):**
1. On the box: `cp /home/pug/app/data/pug.db /tmp/pug-copy.db`, then `npx tsx scripts/balance-triage-report.ts /tmp/pug-copy.db`. Expect patch 6 `pending`, historical/announced/named `balance`, patch 7 (if not yet deleted by the fold-patch-7 SQL) `folded -> 6`.
2. Run the site locally against the copy, triage patch 6 as balance ("Fingerprinted config"), and check Compare and the public page by eye.

---

## Self-review notes

- Spec coverage: states and backfill (T1, T5); triage card with plain words, servers, plugin hint, three buttons, ignore only for plugin-only (T6, T9); drift alert "(needs triage)" + link (T4); folding, `sighted_patch_id`, chain, loop, unfold, cache invalidation, folded collapse, pickers (T2, T6, T8, T9); site ignore list, effective list at every reader, immediate refingerprint on add and remove, ignored list with remove (T3, T5, T6, T7, T8, T9); API (T7); knob panel and public page interactions (T8); merged = folded (T5, T6); testing incl. copy-of-production (T1–T10).
- "Every reader uses the effective list": sighting and boot (T4, T5), drift and patch list (T7), knob panel prediction/blocking (T8), public change list (T8), triage itself (T6).
- Deliberate choices beyond the spec: fold stores the chain end; the refingerprint prefers a balance patch as keeper (so an ignore decision never folds the balance target into the pending patch); reusing a pending patch from the knob panel makes it balance, reusing a folded one is refused; `balance_server_state.patch_id` stays the sighted patch and readers resolve it.
