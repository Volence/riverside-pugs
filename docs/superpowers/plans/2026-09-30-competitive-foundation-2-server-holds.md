# Competitive foundation plan 2: one server holds module

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every question of the form "is anything other than a match holding this box?" is answered in one place, so plan 4 can add bookings as a third kind of hold by editing one view and one type, with no other code path able to miss it. PUGs, practice leases and side games behave exactly as today.

**Architecture:** A SQLite view `open_server_holds (server_id, kind, row_id, rank)` is the union of the open rows of every holding table (today `practice_leases` and `side_games`). `src/serverHolds.ts`, which already tracks who owns a `reserved` box in memory, gains the database side: `NOT_HELD_SQL`, `holdFor(db, serverId)` and `isHeld(db, serverId)`. `src/serverPool.ts` gains one shared `claimableServers(db)` query, replacing three copies. `NOT_LEASED_SQL`, `isLeased` and `isSideHeld` are deleted, and a source-scanning guard test fails on any new SQL that takes an idle box without `NOT_HELD_SQL`. The deploy repo's `stage-on-restart.sh`, which today misses side games entirely, reads the same view.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck`; bash + sqlite3 for the deploy tool.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md`, section 3, "One holds module": "Practice leases and side games each hide their box from the queue with their own SQL (`NOT_LEASED_SQL`). Bookings would be a third copy, so all three move onto `src/serverHolds.ts`: one `NOT_HELD_SQL` and one `holdFor(serverId)` answer, used by `claimIdle`, the balance writer and the release engine. This is the only refactor of existing code in this spec, and it gets its own tests before bookings land."

## Global Constraints

- No behaviour change for PUGs, practice leases or side games. Every existing test passes unchanged; tests are only added.
- A practice lease or side game being wound down (`end_reason` set, `ended_at` still NULL) still holds its box, exactly as today: "open" means `ended_at IS NULL` for both tables.
- Bookings are NOT built here. No `bookings` table, no `'booking'` kind. The view and the `HoldKind` type are the two places plan 4 extends.
- Priority, for plan 4 (owner, 2026-09-30): booking > PUG > practice lease / side game. A booking is a hold PUGs never override. Nothing in this plan changes preemption; each holder keeps its own `needServer`.
- No schema migration framework: the view is dropped and recreated on every `openDb` (src/db.ts), never altered.
- Never write em dashes in code, comments, commits or docs.
- Commit messages follow the repo style (plain sentence); do not push, do not deploy.
- Several Claude sessions may use `/home/volence/l4d/pug`: work in a worktree branch, check `git reflog -10` and `git status` before any write on master.

## Review Focus

- A practice lease being wound down after its owner ended it (`end_reason = 'owner'`, `ended_at` NULL, the box restarting): `claimIdle` must still skip it, or a PUG lands on a box mid-restart with the practice cfg loaded. Task 1 test.
- A side game on a box when the balance writer wants to hold that box for a rollout: the writer must not take it (no test covers the balance writer against holds today). Task 2 test.
- An existing production database opened by the new code: `widenCheck` rebuilds `practice_leases` with `ALTER TABLE ... RENAME`, which SQLite refuses while a view names the table. The view must be dropped before any rebuild and recreated after. The existing "an existing park/drill table is widened" test in tests/db.test.ts reopens a file database and exercises exactly this; Task 1 also adds a reopen test with open holds.
- `stage-on-restart.sh` run against a site database that is older than this plan (the view does not exist yet): it must refuse to drain, with a message saying so, never drain a held box. Task 3 check.
- The mod chat server list: a leased box that an admin disabled still shows (state `practice`), a side-game box shows `side`, exactly as today. Covered by tests/serverChatRoutes.test.ts, which must pass unchanged.

---

## File map

| File | Change |
|---|---|
| `src/db.ts` | Drop `open_server_holds` right after `db.exec(SCHEMA)`; create it just before `seed(db)` at the end of `openDb`. |
| `src/serverHolds.ts` | Header comment covers both layers; add `HoldKind`, `Hold`, `NOT_HELD_SQL`, `holdFor`, `isHeld`. Existing `ServerHolds` class untouched. |
| `src/serverPool.ts` | Delete `NOT_LEASED_SQL`, `isLeased`, `isSideHeld`; add `claimableServers`; `claimIdle` uses it. |
| `src/balanceWriter.ts` | `hold()` uses `NOT_HELD_SQL`. |
| `src/practiceLeases.ts` | Private `claimableServers` removed; imports the shared one. |
| `src/sideGames.ts` | `maybeOpen` uses `claimableServers`. |
| `src/releaseEngine.ts` | `runBox` uses `isHeld`. |
| `src/routes/serverChat.ts` | Uses `holdFor`. |
| `tests/serverHolds.test.ts` | New: view, `holdFor`, `isHeld`, `claimableServers`, `claimIdle` against each hold. |
| `tests/serverHoldGuard.test.ts` | New: source guard. |
| `tests/balanceWriter.test.ts` | New case: held boxes are never taken. |
| `/home/volence/l4d/deploy/tools/stage-on-restart.sh` | Drain reads the view; refuses when the view is missing. Separate repo (l4d-deploy). |

---

### Task 1: The view and the database side of serverHolds

**Files:**
- Modify: `src/db.ts` (`openDb`, starting at the `export function openDb` line, about 1062; `db.exec(SCHEMA)` is a few lines in; `seed(db); return db;` closes the function, about 1786)
- Modify: `src/serverHolds.ts`
- Modify: `src/serverPool.ts` (add `claimableServers` next to `claimIdle`; do NOT delete the old exports yet, Task 2 does)
- Test: `tests/serverHolds.test.ts` (new)

**Interfaces:**
- Produces (src/serverHolds.ts):
  - `export type HoldKind = 'practice' | 'side';`
  - `export interface Hold { kind: HoldKind; rowId: number }`
  - `export const NOT_HELD_SQL: string` (a fragment to AND into a WHERE on `servers`, unaliased: `id NOT IN (SELECT server_id FROM open_server_holds)`)
  - `export function holdFor(db: DB, serverId: number): Hold | null`
  - `export function isHeld(db: DB, serverId: number): boolean`
- Produces (src/serverPool.ts): `export function claimableServers(db: DB): ServerRow[]` (idle, enabled, not held, ordered by id ascending)
- Produces (database): view `open_server_holds` with columns `server_id INTEGER`, `kind TEXT`, `row_id INTEGER`, `rank INTEGER` (lower rank wins when two holds sit on one box; practice 1, side 2; plan 4 gives booking 0).

- [ ] **Step 1: Write the failing tests**

Create `tests/serverHolds.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { addServer, claimIdle, claimableServers, setEnabled } from '../src/serverPool.js';
import { holdFor, isHeld, NOT_HELD_SQL } from '../src/serverHolds.js';

const OWNER = '76561199000000001';

function seedOwner(db: DB): void {
  db.prepare("INSERT INTO players (steamid, name) VALUES (?, 'owner')").run(OWNER);
}
function lease(db: DB, serverId: number, extra: { endReason?: string; ended?: boolean } = {}): number {
  return Number(db.prepare(
    `INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at, end_reason, ended_at)
     VALUES (?, 'park', ?, 'pw', datetime('now', '+1 hour'), ?, ?)`,
  ).run(serverId, OWNER, extra.endReason ?? null, extra.ended ? new Date().toISOString() : null).lastInsertRowid);
}
function sideGame(db: DB, serverId: number, extra: { endReason?: string; ended?: boolean } = {}): number {
  return Number(db.prepare(
    'INSERT INTO side_games (server_id, token, password, end_reason, ended_at) VALUES (?, ?, ?, ?, ?)',
  ).run(serverId, `t${serverId}`, 'p', extra.endReason ?? null, extra.ended ? new Date().toISOString() : null).lastInsertRowid);
}
let hosts = 0;
function box(db: DB, name: string): number {
  return addServer(db, { name, host: `10.0.0.${++hosts}`, port: 27015, rconPort: 27015, rconPassword: 'x' });
}

let db: DB;
let s1: number, s2: number, s3: number;
beforeEach(() => {
  db = openDb(':memory:');
  seedOwner(db);
  s1 = box(db, 's1'); s2 = box(db, 's2'); s3 = box(db, 's3');
});

describe('holdFor / isHeld', () => {
  it('a free box has no hold', () => {
    expect(holdFor(db, s1)).toBeNull();
    expect(isHeld(db, s1)).toBe(false);
  });

  it('an open practice lease holds its box, naming the lease row', () => {
    const id = lease(db, s1);
    expect(holdFor(db, s1)).toEqual({ kind: 'practice', rowId: id });
    expect(isHeld(db, s1)).toBe(true);
    expect(isHeld(db, s2)).toBe(false);
  });

  it('an open side game holds its box, naming the side game row', () => {
    const id = sideGame(db, s2);
    expect(holdFor(db, s2)).toEqual({ kind: 'side', rowId: id });
  });

  it('a lease or side game being wound down still holds (end_reason set, ended_at NULL)', () => {
    lease(db, s1, { endReason: 'owner' });
    sideGame(db, s2, { endReason: 'preempted' });
    expect(holdFor(db, s1)?.kind).toBe('practice');
    expect(holdFor(db, s2)?.kind).toBe('side');
  });

  it('an ended row holds nothing', () => {
    lease(db, s1, { endReason: 'owner', ended: true });
    sideGame(db, s2, { endReason: 'match', ended: true });
    expect(holdFor(db, s1)).toBeNull();
    expect(holdFor(db, s2)).toBeNull();
  });

  it('two holds on one box answer with the lower rank (practice before side)', () => {
    const id = lease(db, s1);
    sideGame(db, s1);
    expect(holdFor(db, s1)).toEqual({ kind: 'practice', rowId: id });
  });
});

describe('claimableServers / claimIdle against holds', () => {
  it('lists idle, enabled, unheld boxes lowest id first', () => {
    lease(db, s1);
    expect(claimableServers(db).map((s) => s.id)).toEqual([s2, s3]);
    sideGame(db, s2);
    expect(claimableServers(db).map((s) => s.id)).toEqual([s3]);
    setEnabled(db, s3, false);
    expect(claimableServers(db)).toEqual([]);
  });

  it('claimIdle skips a leased box, a side game box and a box being wound down', () => {
    lease(db, s1, { endReason: 'owner' });
    sideGame(db, s2);
    const got = claimIdle(db)!;
    expect(got.id).toBe(s3);
    expect(claimIdle(db)).toBeNull();
  });

  it('claimIdle takes a box again once its hold has ended', () => {
    const id = lease(db, s1);
    sideGame(db, s2); sideGame(db, s3);
    expect(claimIdle(db)).toBeNull();
    db.prepare("UPDATE practice_leases SET ended_at = datetime('now') WHERE id = ?").run(id);
    expect(claimIdle(db)!.id).toBe(s1);
  });

  it('NOT_HELD_SQL is usable as a bare WHERE fragment on servers', () => {
    lease(db, s1);
    const ids = (db.prepare(`SELECT id FROM servers WHERE ${NOT_HELD_SQL} ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual([s2, s3]);
  });
});

describe('open_server_holds survives reopening and table rebuilds', () => {
  it('a file database reopened with open holds keeps them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pugholds-')), 'pug.db');
    let fdb = openDb(path);
    seedOwner(fdb);
    const a = box(fdb, 'a');
    lease(fdb, a);
    fdb.close();
    fdb = openDb(path);
    expect(holdFor(fdb, a)?.kind).toBe('practice');
    fdb.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/serverHolds.test.ts`
Expected: FAIL, with `holdFor`/`isHeld`/`NOT_HELD_SQL` not exported from `src/serverHolds.js` and `claimableServers` not exported from `src/serverPool.js`.

- [ ] **Step 3: Add the view to openDb**

In `src/db.ts`, directly after the `db.exec(SCHEMA);` line inside `openDb`, add:

```ts
  // open_server_holds is recreated at the end of openDb. Dropped first because
  // widenCheck below rebuilds practice_leases with ALTER TABLE ... RENAME,
  // which SQLite refuses while a view names the table.
  db.exec('DROP VIEW IF EXISTS open_server_holds');
```

and directly before the final `seed(db);` in `openDb`, add:

```ts
  // Everything besides a match that holds a box out of the pool: one row per
  // open hold. A holder's box stays 'idle' in servers (see practice_leases
  // above for why), so everything that takes an idle box for itself asks this
  // view, through NOT_HELD_SQL in src/serverHolds.ts. Open means ended_at IS
  // NULL: a lease or side game being wound down holds its box until the
  // restart that clears it has finished. rank orders two holds on one box
  // (lower first). A new kind of hold is a new UNION ALL arm here and a new
  // HoldKind, nothing else.
  db.exec(`
    CREATE VIEW open_server_holds AS
      SELECT server_id, 'practice' AS kind, id AS row_id, 1 AS rank FROM practice_leases WHERE ended_at IS NULL
      UNION ALL
      SELECT server_id, 'side' AS kind, id AS row_id, 2 AS rank FROM side_games WHERE ended_at IS NULL
  `);
```

- [ ] **Step 4: Add the database side of serverHolds**

Replace the header comment of `src/serverHolds.ts` and add the new exports above the existing `HoldOwner` type. The file becomes:

```ts
import type { DB } from './db.js';

/**
 * Who holds a box out of the pool, in two layers.
 *
 * In the database: anything besides a match that keeps an idle box for
 * itself (a practice lease, a queue side game) is an open row of its own
 * table, and the view open_server_holds (src/db.ts) is the union of them. The
 * box stays 'idle' in servers.status, so everything that takes an idle box
 * for itself must AND in NOT_HELD_SQL; tests/serverHoldGuard.test.ts fails on
 * SQL that does not. Priority between holders is each holder's own business
 * (practiceLeases.needServer, sideGames.needServer); this only says who holds.
 *
 * In memory (ServerHolds): the release engine and the balance writer both
 * hold an idle box by moving it idle -> reserved, and a reserved row does not
 * say whose hold it is: an admin's Set idle while one side waits lets the
 * other take the box, and from then on only the side that took it may treat
 * the hold as its own (restart the box, or give it back). After a site
 * restart the release engine's recover() takes back what it held.
 */

/** A kind of database hold; one arm of open_server_holds each. */
export type HoldKind = 'practice' | 'side';

export interface Hold {
  kind: HoldKind;
  /** The id of the holding row in that kind's own table. */
  rowId: number;
}

/** "Nothing but a match may use this box": AND it into a WHERE on servers.
 *  Unaliased, so the query must not alias servers. */
export const NOT_HELD_SQL = 'id NOT IN (SELECT server_id FROM open_server_holds)';

/** The hold on this box, or null. Two holds on one box (which nothing should
 *  create) answer with the lower rank. */
export function holdFor(db: DB, serverId: number): Hold | null {
  const r = db.prepare('SELECT kind, row_id FROM open_server_holds WHERE server_id = ? ORDER BY rank, row_id LIMIT 1')
    .get(serverId) as { kind: HoldKind; row_id: number } | undefined;
  return r ? { kind: r.kind, rowId: r.row_id } : null;
}

export function isHeld(db: DB, serverId: number): boolean {
  return holdFor(db, serverId) !== null;
}

export type HoldOwner = 'release' | 'balance';
```

followed by the existing `ServerHolds` class, unchanged.

- [ ] **Step 5: Add claimableServers and route claimIdle through it**

In `src/serverPool.ts`, add the import at the top:

```ts
import { NOT_HELD_SQL } from './serverHolds.js';
```

(`src/serverHolds.ts` imports only the `DB` type, so there is no import cycle.) Then replace `claimIdle` with:

```ts
/** Idle, enabled boxes that nothing holds (src/serverHolds.ts), lowest id
 *  first: what the queue could take right now. claimIdle takes the first;
 *  a practice lease picks from the other end. */
export function claimableServers(db: DB): ServerRow[] {
  return db.prepare(`SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 AND ${NOT_HELD_SQL} ORDER BY id`)
    .all() as ServerRow[];
}

/** Atomically reserve one idle, enabled server; returns it, or null if none is
 *  available. A disabled box is invisible here however idle it looks, which is
 *  the whole point: an admin can pull a misbehaving server out of rotation
 *  mid-evening without stopping it, kicking anyone, or editing the database.
 *  A held box (practice lease, side game) is invisible the same way; a PUG
 *  that finds nothing else takes one back through that holder's preemption
 *  (src/practiceLeases.ts, src/sideGames.ts), never by claiming it here. */
export function claimIdle(db: DB): ServerRow | null {
  return db.transaction(() => {
    const row = claimableServers(db)[0];
    if (!row) return null;
    db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(row.id);
    return { ...row, status: 'reserved' as const };
  })();
}
```

Leave `NOT_LEASED_SQL`, `isLeased` and `isSideHeld` in place for now so the tree still compiles; Task 2 removes them.

- [ ] **Step 6: Run the new tests and the database tests**

Run: `npx vitest run tests/serverHolds.test.ts tests/db.test.ts tests/serverPool.test.ts`
Expected: PASS. If "an existing park/drill table is widened" in tests/db.test.ts fails with `error in view open_server_holds`, the DROP VIEW in Step 3 is placed after the `widenCheck(db, 'practice_leases', ...)` call; move it up to directly after `db.exec(SCHEMA)`.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/db.ts src/serverHolds.ts src/serverPool.ts tests/serverHolds.test.ts
git commit -m "Server holds: open_server_holds view, NOT_HELD_SQL, holdFor and one claimableServers query"
```

---

### Task 2: Move every caller onto serverHolds, delete the old helpers, add the guard

**Files:**
- Modify: `src/serverPool.ts` (delete `NOT_LEASED_SQL` and its comment block, `isLeased`, `isSideHeld`)
- Modify: `src/balanceWriter.ts:6` (import) and `:84` (`hold()`)
- Modify: `src/practiceLeases.ts:57` (import) and `:236-241` (private `claimableServers`, delete)
- Modify: `src/sideGames.ts:16` (import) and `:243-245` (`maybeOpen`)
- Modify: `src/releaseEngine.ts:6` (import) and `:288-291` (`runBox`)
- Modify: `src/routes/serverChat.ts:6` (import) and `:43-47`
- Modify: `src/db.ts` comment that mentions NOT_LEASED_SQL, if any (search: `grep -n NOT_LEASED src/db.ts src/practiceLeases.ts src/sideGames.ts`), so no comment names a deleted symbol
- Test: `tests/serverHoldGuard.test.ts` (new), `tests/balanceWriter.test.ts` (one new case)

**Interfaces:**
- Consumes: `NOT_HELD_SQL`, `holdFor`, `isHeld` from `src/serverHolds.ts`; `claimableServers` from `src/serverPool.ts` (Task 1).
- Produces: nothing new. After this task `NOT_LEASED_SQL`, `isLeased`, `isSideHeld` no longer exist.

- [ ] **Step 1: Write the guard test**

Create `tests/serverHoldGuard.test.ts`:

```ts
// tests/serverHoldGuard.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A box held by a practice lease or a side game (and, later, a booking) is
 * 'idle' in servers.status. Any SQL that picks or takes an idle box without
 * ${NOT_HELD_SQL} would hand a held box to a match. The allowlist is for a
 * holder acting on its OWN held box, with the reason; counts are per file so
 * a second such statement in an allowed file still fails.
 */
const ALLOWED: Record<string, number> = {
  'src/sideGames.ts': 1, // takeForMatch: the side game hands its own box to the match its pop became
};

const STRINGS = /`[^`]*`|"(?:[^"\\\n]|\\.)*"/g;
const IDLE_FILTER = /\b(WHERE|AND)\s+status\s*=\s*'idle'/i;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));

describe('server hold guard', () => {
  it('every statement that filters on idle servers also excludes held ones', () => {
    const found: Record<string, number> = {};
    for (const f of walk('src')) {
      const bare = (readFileSync(join(root, f), 'utf8').match(STRINGS) ?? [])
        .filter((s) => IDLE_FILTER.test(s) && !s.includes('${NOT_HELD_SQL}'));
      if (bare.length > 0) found[f] = bare.length;
    }
    const offenders = Object.entries(found).filter(([f, n]) => n > (ALLOWED[f] ?? 0));
    expect(offenders).toEqual([]);
  });

  it('the per-table helpers are gone', () => {
    const hits = walk('src').filter((f) => /\b(NOT_LEASED_SQL|isLeased|isSideHeld)\b/.test(readFileSync(join(root, f), 'utf8')));
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the balance writer test**

In `tests/balanceWriter.test.ts` (fixture: `fakeBoxes()` records every file put on a box in `f.disk` keyed `${serverId}/${name}`; `beforeEach` makes two idle boxes `s1`, `s2` with a pending rollout on each; `state(sid)` reads the rollout row), add inside `describe('BalanceRolloutWriter', ...)`:

```ts
  it('never holds a box a practice lease or a side game holds, and writes it once they end', async () => {
    db.prepare("INSERT INTO players (steamid, name) VALUES ('76561199000000009', 'o')").run();
    db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
      VALUES (?, 'park', '76561199000000009', 'pw', datetime('now', '+1 hour'))`).run(s1);
    db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (?, 't', 'p')").run(s2);
    const f = fakeBoxes();
    const w = new BalanceRolloutWriter({ db, transport: f.transport });
    await w.sync();
    expect(f.disk.size).toBe(0);
    expect(state(s1).state).not.toBe('written');
    expect(state(s2).state).not.toBe('written');
    expect((db.prepare('SELECT status FROM servers ORDER BY id').all() as { status: string }[]).map((r) => r.status))
      .toEqual(['idle', 'idle']);
    db.prepare("UPDATE practice_leases SET ended_at = datetime('now')").run();
    db.prepare("UPDATE side_games SET ended_at = datetime('now')").run();
    await w.sync();
    expect(state(s1).state).toBe('written');
    expect(state(s2).state).toBe('written');
  });
```

- [ ] **Step 3: Run both to see them fail**

Run: `npx vitest run tests/serverHoldGuard.test.ts tests/balanceWriter.test.ts`
Expected: the guard's first case FAILS with `[['src/balanceWriter.ts', 1], ['src/practiceLeases.ts', 1], ['src/sideGames.ts', 2]]` (serverPool.ts is already clean after Task 1); the second case FAILS listing every file that still names the old helpers. The balance writer case PASSES already (the old `NOT_LEASED_SQL` covers both tables), which is fine: it pins behaviour across the swap.

- [ ] **Step 4: Migrate the callers**

`src/balanceWriter.ts`: change the import line to

```ts
import { getServer, listServers, type ServerRow } from './serverPool.js';
import { NOT_HELD_SQL, ServerHolds } from './serverHolds.js';
```

(merge with the existing `import { ServerHolds } from './serverHolds.js';` line rather than duplicating it), and in `hold()`:

```ts
    const took = this.deps.db.prepare(`UPDATE servers SET status = 'reserved' WHERE id = ? AND status = 'idle' AND enabled = 1 AND ${NOT_HELD_SQL}`)
```

Update the comment above `hold()` to say "lent out as a practice server or held by a side game (idle in status, busy in fact)".

`src/practiceLeases.ts`: import `claimableServers` from `./serverPool.js` (drop `NOT_LEASED_SQL` from that import), and delete the private function:

```ts
/** Enabled idle boxes that no lease holds: what the queue could claim now. */
function claimableServers(db: DB): ServerRow[] {
  return db.prepare(
    `SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 AND ${NOT_LEASED_SQL} ORDER BY id`,
  ).all() as ServerRow[];
}
```

Its callers (`pickLeaseServer`, `needServer`) keep calling `claimableServers(this.db)` / `claimableServers(db)` unchanged. Note the shared query also excludes side game boxes, which the old one did too (NOT_LEASED_SQL covered both tables), so nothing changes. Update the file header comment that points at `NOT_LEASED_SQL in src/serverPool.ts` to point at `open_server_holds in src/db.ts and NOT_HELD_SQL in src/serverHolds.ts`.

`src/sideGames.ts`: import `claimableServers` from `./serverPool.js` (drop `NOT_LEASED_SQL`), and in `maybeOpen` replace

```ts
    const server = (this.deps.db.prepare(
      `SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 AND ${NOT_LEASED_SQL} ORDER BY id`,
    ).all() as ServerRow[]).find((s) => !this.refusedUntil.has(s.id));
```

with

```ts
    const server = claimableServers(this.deps.db).find((s) => !this.refusedUntil.has(s.id));
```

Update the header comment (lines 6-8) from "NOT_LEASED_SQL keeps claimIdle and friends away from it" to "open_server_holds keeps claimIdle and friends away from it (src/serverHolds.ts)". Drop `ServerRow` from the import only if nothing else in the file uses it (`grep -n ServerRow src/sideGames.ts`).

`src/releaseEngine.ts`: import `isHeld` from `./serverHolds.js` (merge with the existing `ServerHolds` import), drop `isLeased, isSideHeld` from the `./serverPool.js` import, and in `runBox`:

```ts
    // A box held by a practice lease or a side game (src/serverHolds.ts) is
    // idle in status only. It waits like a busy one; the holder ends through
    // the releaser, whose hook is the releaserRestarting path above.
    if (!releaserRestarting && (s.status !== 'idle' || isHeld(db, s.id))) { this.setBox(r.id, b.server_id, 'waiting'); return; }
```

`src/routes/serverChat.ts`: import `holdFor` from `../serverHolds.js`, drop `isLeased, isSideHeld` from the serverPool import, and replace the list body with:

```ts
    const servers: ChatServerView[] = listServers(db)
      .map((s) => ({ s, hold: holdFor(db, s.id) }))
      .filter(({ s, hold }) => s.enabled === 1 || hold?.kind === 'practice')
      .map(({ s, hold }) => ({
        id: s.id, name: s.name,
        state: hold?.kind === 'practice' ? 'practice' : hold?.kind === 'side' ? 'side' : liveMatchOn(db, s.id) !== null ? 'match' : s.status === 'offline' ? 'offline' : 'idle',
        lastAt: (lastAt.get(s.id) as { at: number | null }).at,
      }));
```

This is the same filter and the same state order as before (practice checked first), so the route answers exactly as it did.

`src/serverPool.ts`: delete the `NOT_LEASED_SQL` doc comment and constant, `isLeased` and `isSideHeld`.

- [ ] **Step 5: Find anything else that named the old helpers**

Run: `grep -rn "NOT_LEASED_SQL\|isLeased\|isSideHeld" src tests`
Expected: no output. A test file importing `isLeased` or `isSideHeld` from serverPool: switch it to `isHeld` / `holdFor` from `../src/serverHolds.js` with the same assertion.

- [ ] **Step 6: Run the guard, the touched suites, then everything**

Run: `npx vitest run tests/serverHoldGuard.test.ts tests/serverHolds.test.ts tests/balanceWriter.test.ts tests/releaseEngine.test.ts tests/sideGames.test.ts tests/practiceLeases.test.ts tests/practiceLeaseRoutes.test.ts tests/serverChatRoutes.test.ts tests/orchestrator.test.ts tests/serverPool.test.ts`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors. The pass count is the pre-plan count plus the new cases; no existing test changed.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "Every hold check goes through serverHolds; NOT_LEASED_SQL, isLeased, isSideHeld removed; guard test"
```

---

### Task 3: stage-on-restart.sh reads the view (deploy repo)

The drain in `/home/volence/l4d/deploy/tools/stage-on-restart.sh` (function `idle_restart`, about line 93) only checks `practice_leases`, so today it can restart a box in the middle of a queue side game. It moves onto the view, and refuses outright on a site database that predates it.

This is a separate git repository (l4d-deploy). Its commit must NOT reach any box's use before the web deploy of Tasks 1-2 has landed, because the script queries the live site database over ssh; the refusal below makes an early run safe, but pointless.

**Files:**
- Modify: `/home/volence/l4d/deploy/tools/stage-on-restart.sh` (`idle_restart`)

**Interfaces:**
- Consumes: view `open_server_holds` on the site database (Task 1).

- [ ] **Step 1: Check the deploy repo is free**

Run: `cd /home/volence/l4d/deploy && git status --short && git reflog -5`
Expected: clean, no fresh foreign commits. If another session is mid-change, stop and tell the owner.

- [ ] **Step 2: Build a scratch database to test the SQL against**

From `/home/volence/l4d/pug`, write the scratch script to the session scratchpad (NOT the repo) and run it:

```ts
// <scratchpad>/holds-db.ts
import { openDb } from '/home/volence/l4d/pug/src/db.ts';
const db = openDb(process.argv[2]);
db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES ('a', 'h', 27015, 27015, 'x'), ('b', 'h', 27016, 27016, 'x'), ('c', 'h', 27017, 27017, 'x')").run();
db.prepare("INSERT INTO players (steamid, name) VALUES ('76561199000000001', 'o')").run();
db.prepare("INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at) VALUES (1, 'park', '76561199000000001', 'pw', 'x')").run();
db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (2, 't', 'p')").run();
db.close();
```

Run: `npx tsx <scratchpad>/holds-db.ts <scratchpad>/holds.db`

- [ ] **Step 3: Show the old drain takes the side game box (the bug)**

Run:

```bash
for SID in 1 2 3; do sqlite3 <scratchpad>/holds.db "UPDATE servers SET enabled=0 WHERE id=$SID AND enabled=1 AND status='idle'
  AND id NOT IN (SELECT server_id FROM practice_leases WHERE ended_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM matches WHERE server_id=$SID AND state='live'); SELECT changes();"; done
sqlite3 <scratchpad>/holds.db "UPDATE servers SET enabled=1"
```

Expected: `0`, `1`, `1`: box 2 (side game) is drained, which is the bug.

- [ ] **Step 4: Change the drain**

In `idle_restart`, directly after the `[ -n "$SID" ] || { ... }` line, add:

```bash
  # Holds live in the site's open_server_holds view (practice leases, side
  # games, later bookings). A site database older than that view cannot say
  # what holds a box, so nothing is drained.
  if [ "$(sql "SELECT count(*) FROM sqlite_master WHERE type='view' AND name='open_server_holds';")" != 1 ]; then
    echo "==> $TARGET: the site database has no open_server_holds view (web deploy older than the holds module), not restarting"
    return 2
  fi
```

and replace the drain statement's lease line so it reads:

```bash
  got=$(sql "UPDATE servers SET enabled=0 WHERE id=$SID AND enabled=1 AND status='idle'
    AND id NOT IN (SELECT server_id FROM open_server_holds)
    AND NOT EXISTS (SELECT 1 FROM matches WHERE server_id=$SID AND state='live'); SELECT changes();")
```

Update the comment above it ("idle, unleased and has no live match") to "idle, held by nothing (lease, side game) and has no live match", and the busy message to `busy (in a match, held by a lease or side game, or out of the pool), applies at its next restart`.

- [ ] **Step 5: Verify the new SQL and the syntax**

Run:

```bash
bash -n /home/volence/l4d/deploy/tools/stage-on-restart.sh && echo syntax-ok
for SID in 1 2 3; do sqlite3 <scratchpad>/holds.db "UPDATE servers SET enabled=0 WHERE id=$SID AND enabled=1 AND status='idle'
  AND id NOT IN (SELECT server_id FROM open_server_holds)
  AND NOT EXISTS (SELECT 1 FROM matches WHERE server_id=$SID AND state='live'); SELECT changes();"; done
sqlite3 <scratchpad>/holds.db "SELECT count(*) FROM sqlite_master WHERE type='view' AND name='open_server_holds';"
sqlite3 :memory: "SELECT count(*) FROM sqlite_master WHERE type='view' AND name='open_server_holds';"
```

Expected: `syntax-ok`; `0`, `0`, `1` (only the free box drains); `1` for the scratch database; `0` for an empty database, which is the refusal path.

- [ ] **Step 6: Commit in the deploy repo (after the web deploy)**

Only once the owner has approved and the web deploy of Tasks 1-2 is verified on Dallas (`sqlite3 data/pug.db "SELECT count(*) FROM sqlite_master WHERE name='open_server_holds'"` answers 1 there):

```bash
cd /home/volence/l4d/deploy
git add tools/stage-on-restart.sh
git commit -m "stage-on-restart: drain reads open_server_holds, so a side game box is never restarted; refuse without the view"
```

---

## Rollout

- Web only (Tasks 1-2): merge the worktree branch to pug master, then `deploy-web.sh` after the owner's go-ahead. No plugin change, no server restart. Verify with the deploy verification recipe (tree hash, and on Dallas `SELECT count(*) FROM sqlite_master WHERE name='open_server_holds'` = 1, `SELECT * FROM open_server_holds` matches the open rows of `practice_leases` and `side_games`).
- Deploy repo (Task 3): commit only after the web deploy is verified.

## Notes for plan 4 (bookings)

- Add `'booking'` to `HoldKind` and one arm to the view: `SELECT server_id, 'booking', id, 0 FROM bookings WHERE server_id IS NOT NULL AND state IN ('held','setup','ready','active')` (rank 0: a booking outranks every other hold, owner ruling 2026-09-30). The guard test, `claimIdle`, the balance writer, the release engine, the side game opener, the lease picker and stage-on-restart.sh then all respect bookings with no further change.
- A booking is never preempted: plan 4 simply gives it no `needServer`. Leases and side games on a box a booking wants are preempted through their existing `needServer` paths.
- `serverChat` will need a `'booking'` state for the mod chat list; the `hold?.kind` switch there is the place.
