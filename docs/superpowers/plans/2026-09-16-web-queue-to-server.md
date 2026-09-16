# Website Queue to Live Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the full website path work end to end for the first time: sign in, queue, vote, balanced teams, connect handoff, play, result on the main menu, match reported, requeue.

**Architecture:** Nine pieces across three layers. The backend gains one `ServerReleaser` chokepoint that every server-freeing path routes through, a pending-match list drained when a box frees, a no-show reaper, connect details on the viewer-relative state snapshot, a new public queue route, and a Steam persona backfill. The plugin stops kicking non-rostered players, lets a backend roster lock teams even under auto-track, and kicks everyone to the main menu with the result at match end. The web app renders queue faces and the connect handoff.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Vitest, Preact, Vite. SourcePawn compiled with `plugin/build.sh` (wine + spcomp 1.12).

**Spec:** `docs/superpowers/specs/2026-09-16-web-queue-to-server-design.md`

## Global Constraints

- **Baseline is 1094 tests across 96 files, all green.** Run `npm test` before starting and after every task. A task is not done if the count drops.
- **TDD.** Every backend and web task writes a failing test first. Plugin tasks cannot be unit tested and say so explicitly in their verification steps.
- **No em dashes** anywhere: code, comments, commit messages, docs. Replace by meaning, not by character swap.
- **Never deploy, restart, or rcon the Dallas box (45.32.199.85) without an explicit go-ahead from the owner.** Players are often on it. Every task here is local work; shipping is a separate conversation.
- **Always recompile before staging a plugin.** `plugin/build.sh` then `plugin/stage.sh`. A past session staged a `.smx` that did not match the `.sp` and lost a live test to it.
- **Ship order when the time comes:** `./deploy-web.sh` first, then `plugin/stage.sh` with the server empty, then rcon `sm_pug_auto_track 1; sm_pug_roster_at_live 1`, because a plugin reload resets every cvar until the next map change.
- **Derive the match password, never store it twice:** it is `pug_` + `matches.token` sliced to 8 characters, the expression already at `src/orchestrator.ts:107`.

---

## File Structure

**Create:**
- `src/serverRelease.ts` - the single chokepoint for freeing a server: clear `sv_password`, mark the row idle, notify waiters. Owns no rcon of its own; takes a password-clearing function so tests inject a fake.
- `src/pendingMatches.ts` - matches that could not claim a box, drained when one frees, rebuilt from `state='configuring'` at boot.
- `src/noShow.ts` - the two abort rules for a match nobody turned up to.
- `src/personaBackfill.ts` - one-shot Steam persona fetch for players with a null avatar.
- `tests/serverRelease.test.ts`, `tests/pendingMatches.test.ts`, `tests/noShow.test.ts`, `tests/personaBackfill.test.ts`, `tests/queueRoute.test.ts`
- `web/src/components/ConnectPanel.tsx` + `web/src/components/ConnectPanel.test.tsx`
- `plugin/RUNBOOK-first-web-match.md`

**Modify:**
- `src/orchestrator.ts` - `setupMatch` pends instead of aborting when no box is free; `finishMatch` and both setup failure paths route through the releaser; stamp `went_live_at`.
- `src/liveView.ts:423-445` - `reapOrphanedMatches` takes a releaser instead of writing `servers.status` directly.
- `src/matchmaker.ts` - `stateFor` gains the connect block, queue players, and a waiting flag.
- `src/routes/api.ts` - new public `GET /api/queue`.
- `src/server.ts` - wire the releaser, pending list, no-show reaper, persona backfill, and a `player` log-event handler.
- `src/db.ts` - three `ensureColumn` calls and three new settings.
- `web/src/api.ts`, `web/src/routes/Play.tsx` - types and rendering.
- `plugin/pug-match.sp` - pieces 7 and 8.

---

### Task 1: The `ServerReleaser` chokepoint and `sv_password` teardown

Four places currently stop owning a server and they do not agree. `orchestrator.ts:90`, `:121` and `:212` call `release()`; `liveView.ts:438` writes `servers.status = 'idle'` with raw SQL and never dials rcon. None of them clear `sv_password`, which is the live bug: the first completed web match locks the box to `pug_<token8>` forever.

`serverPool.ts` stays pure DB with no rcon dependency, so the releaser is its own module taking an injected password clearer.

**Files:**
- Create: `src/serverRelease.ts`
- Create: `tests/serverRelease.test.ts`
- Modify: `src/orchestrator.ts` (lines 90, 121, 212 and the class constructor)
- Modify: `src/liveView.ts:423-445`
- Modify: `src/server.ts` (construct the releaser, pass it to the reaper)

**Interfaces:**
- Consumes: `release`, `getServer`, `type ServerRow` from `src/serverPool.js`; `type DB` from `src/db.js`.
- Produces:
  - `type PasswordClearer = (server: ServerRow) => Promise<void>`
  - `class ServerReleaser { constructor(db: DB, clearPassword: PasswordClearer); release(serverId: number): void; onFreed(fn: () => void): void }`
  - `reapOrphanedMatches(db: DB, releaser: ServerReleaser, olderThanMs?: number): number[]`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/serverRelease.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer, getServer, markLive } from '../src/serverPool.js';
import { ServerReleaser, type PasswordClearer } from '../src/serverRelease.js';

function seedServer(db: ReturnType<typeof openDb>): number {
  return addServer(db, {
    name: 'test', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x',
  });
}

describe('ServerReleaser', () => {
  it('marks the server idle and clears the password', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const cleared: string[] = [];
    const clear: PasswordClearer = async (s) => { cleared.push(s.name); };

    const releaser = new ServerReleaser(db, clear);
    releaser.release(id);

    expect(getServer(db, id)!.status).toBe('idle');
    await new Promise((r) => setImmediate(r));
    expect(cleared).toEqual(['test']);
  });

  it('notifies every registered waiter that a box freed', () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const calls: number[] = [];
    const releaser = new ServerReleaser(db, async () => {});
    releaser.onFreed(() => calls.push(1));
    releaser.onFreed(() => calls.push(2));

    releaser.release(id);

    expect(calls).toEqual([1, 2]);
  });

  it('still frees the row when clearing the password throws', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const releaser = new ServerReleaser(db, async () => { throw new Error('rcon down'); });

    releaser.release(id);

    expect(getServer(db, id)!.status).toBe('idle');
    await new Promise((r) => setImmediate(r));
  });

  it('is a no-op for a server id that does not exist', () => {
    const db = openDb(':memory:');
    const releaser = new ServerReleaser(db, async () => {});
    expect(() => releaser.release(999)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/serverRelease.test.ts`
Expected: FAIL, cannot resolve `../src/serverRelease.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/serverRelease.ts
import type { DB } from './db.js';
import { getServer, release, type ServerRow } from './serverPool.js';

/** Clears sv_password on a server we are done with. Injected so tests never
 *  dial rcon and so the reaper, which has no rcon of its own, can still do it. */
export type PasswordClearer = (server: ServerRow) => Promise<void>;

/**
 * The single place a server stops being ours.
 *
 * Before this existed there were four: three release() calls in the
 * orchestrator and a raw `UPDATE servers SET status = 'idle'` in the orphan
 * reaper. None of them cleared sv_password, so the first completed web match
 * left the box locked to pug_<token8> and shut out every casual player. The
 * reaper is exactly the path that most needs the clear, because a crashed
 * match is the case where nobody is around to notice.
 */
export class ServerReleaser {
  private waiters: Array<() => void> = [];

  constructor(private db: DB, private clearPassword: PasswordClearer) {}

  /** Called when a box frees, so a match waiting for one can claim it. */
  onFreed(fn: () => void): void {
    this.waiters.push(fn);
  }

  /**
   * Free the server. The DB half is synchronous so a caller can assert on it
   * immediately; the rcon half is best effort and fire-and-forget, because a
   * match result is never allowed to fail over a password reset.
   */
  release(serverId: number): void {
    const server = getServer(this.db, serverId);
    if (!server) return;
    release(this.db, serverId);
    void this.clearPassword(server).catch((err) => {
      console.error(`[serverRelease] could not clear sv_password on ${server.name}:`, err);
    });
    for (const fn of this.waiters) {
      try {
        fn();
      } catch (err) {
        console.error('[serverRelease] waiter threw:', err);
      }
    }
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/serverRelease.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Route the orphan reaper through the releaser**

Change the signature at `src/liveView.ts:423` and replace the raw status write at `:438`:

```typescript
export function reapOrphanedMatches(
  db: DB,
  releaser: ServerReleaser,
  olderThanMs = ORPHAN_AFTER_MS,
): number[] {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db
    .prepare(
      `SELECT m.id, m.server_id FROM matches m
       JOIN match_live l ON l.match_id = m.id
       WHERE m.state = 'live' AND l.last_seen < ?`,
    )
    .all(cutoff) as { id: number; server_id: number | null }[];

  for (const r of rows) {
    db.prepare("UPDATE matches SET state = 'aborted', ended_at = datetime('now') WHERE id = ?")
      .run(r.id);
    // Through the releaser, not a raw status write: a reaped match is exactly
    // the one whose sv_password nobody is left to clear by hand.
    if (r.server_id !== null) releaser.release(r.server_id);
    clearLive(db, r.id);
    console.warn(`[liveView] reaped orphaned match ${r.id}: no heartbeat for ${olderThanMs}ms`);
  }
  return rows.map((r) => r.id);
}
```

Add `import type { ServerReleaser } from './serverRelease.js';` at the top of `liveView.ts`.

Note the transaction wrapper is gone on purpose: `releaser.release` starts async work, and better-sqlite3 transactions must stay synchronous. The two writes are independently idempotent, so the wrapper bought nothing.

- [ ] **Step 6: Give the orchestrator a releaser and use it on all three paths**

In `RealOrchestratorDeps` add `releaser: ServerReleaser`. Store it in the constructor as `this.releaser = deps.releaser`. Replace all three `release(this.db, ...)` calls (lines 90, 121, 212) with `this.releaser.release(...)`, and drop the now-unused `release` import.

Construct it in `src/server.ts` where the orchestrator is built, with a real clearer:

```typescript
const releaser = new ServerReleaser(deps.db, async (server) => {
  const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
  try {
    await rcon.connect();
    await rcon.exec('sv_password ""');
  } finally {
    rcon.close();
  }
});
```

Pass `releaser` into `new RealOrchestrator({...})` and into the `reapOrphanedMatches(deps.db, releaser)` call inside the 60 second interval at `src/server.ts:284`.

- [ ] **Step 7: Update every existing caller in the tests**

`tests/liveView.test.ts` calls `reapOrphanedMatches(db)` and `tests/orchestrator*.test.ts` construct `RealOrchestrator`. Give them a throwaway releaser:

```typescript
const releaser = new ServerReleaser(db, async () => {});
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, 1098 tests (1094 + 4 new).

- [ ] **Step 9: Commit**

```bash
git add src/serverRelease.ts tests/serverRelease.test.ts src/orchestrator.ts src/liveView.ts src/server.ts tests/
git commit -m "fix: one chokepoint for freeing a server, and clear sv_password there

setupMatch set sv_password and nothing ever cleared it, so the first
completed web match would have locked the box to pug_<token8> until
someone rconned it by hand. The orphan reaper freed servers with a raw
status write and never dialed rcon at all, which is the path that most
needs the clear."
```

---

### Task 2: Stamp `went_live_at`

Task 3 needs to know when a match went live, not when its row was inserted. With task 4 a match can sit in `configuring` for a long time waiting for a box, so `created_at` would make a no-show timer fire the instant it finally started.

**Files:**
- Modify: `src/db.ts` (near the existing `ensureColumn` calls at :266-279)
- Modify: `src/orchestrator.ts` (the `state = 'live'` update inside `setupMatch`)
- Modify: `src/selfStarted.ts` (its own live transition)
- Test: `tests/orchestrator.test.ts`

**Interfaces:**
- Produces: `matches.went_live_at TEXT` (null until the match goes live).

- [ ] **Step 1: Write the failing test**

Add to `tests/orchestrator.test.ts`:

```typescript
it('stamps went_live_at when the match goes live', async () => {
  const { db, orch, srv } = await setupFixture();
  const mid = seedMatch(db);

  await orch.setupMatch(mid);

  const row = db.prepare('SELECT state, went_live_at FROM matches WHERE id = ?').get(mid) as
    { state: string; went_live_at: string | null };
  expect(row.state).toBe('live');
  expect(row.went_live_at).not.toBeNull();
  await srv.close();
});
```

Use whatever fixture helper the neighbouring tests in that file already use to build `db`, `orch` and the fake rcon server; do not invent a new one.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/orchestrator.test.ts -t went_live_at`
Expected: FAIL, `went_live_at` is undefined (no such column).

- [ ] **Step 3: Add the column**

In `src/db.ts::openDb`, beside the other `ensureColumn` calls:

```typescript
// When the match actually went live, which is not when its row was inserted:
// a match with no free server now waits in 'configuring' instead of aborting,
// so created_at can be arbitrarily older. The no-show reaper times from here.
ensureColumn(db, 'matches', 'went_live_at', 'TEXT');
```

- [ ] **Step 4: Stamp it in both live transitions**

In `src/orchestrator.ts::setupMatch`, change the live update to:

```typescript
this.db.prepare("UPDATE matches SET state = 'live', went_live_at = datetime('now') WHERE id = ?")
  .run(matchId);
```

In `src/selfStarted.ts`, find the insert that creates an already-live self-started match and add `went_live_at = datetime('now')` to it, so a self-started match is not treated as a permanent no-show.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS, 1099 tests.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/orchestrator.ts src/selfStarted.ts tests/orchestrator.test.ts
git commit -m "feat: stamp matches.went_live_at at the live transition

created_at stops being a usable proxy once a match can wait in
configuring for a free box."
```

---

### Task 3: No-show timeout

`Timer_Heartbeat` in the plugin emits whenever `g_State != MS_None`, so it beats with nobody connected, and the orphan reaper only catches heartbeat loss. A match the eight never joined heartbeats forever, stays `live` forever, and pins `servers.status = 'live'` forever. Task 4 turns that from a manual cleanup into a permanent deadlock, so this lands first.

`src/logParse.ts:7` already parses `PLAYER ... event=connect|disconnect`, but `src/server.ts` never handles `ev.kind === 'player'`: it falls through the else-if chain silently. That is the signal we need.

**Files:**
- Create: `src/noShow.ts`
- Create: `tests/noShow.test.ts`
- Modify: `src/db.ts` (one `ensureColumn`, three settings)
- Modify: `src/server.ts` (handle the `player` event; call the reaper)

**Interfaces:**
- Consumes: `ServerReleaser` from Task 1; `matches.went_live_at` from Task 2.
- Produces:
  - `recordPlayerConnect(db: DB, token: string, steamid: string): void`
  - `reapNoShowMatches(db: DB, releaser: ServerReleaser, now?: Date): number[]`
  - `match_players.connected_at TEXT`
  - settings `noshow_minutes` (`'10'`), `noshow_min_connected` (`'6'`), `no_round_minutes` (`'30'`)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/noShow.test.ts
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, getServer, markLive } from '../src/serverPool.js';
import { ServerReleaser } from '../src/serverRelease.js';
import { currentSeasonId } from '../src/players.js';
import { recordPlayerConnect, reapNoShowMatches } from '../src/noShow.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

/** A live match whose went_live_at is `minutesAgo` in the past. */
function liveMatch(db: DB, minutesAgo: number): { id: number; serverId: number } {
  const serverId = addServer(db, {
    name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x',
  });
  markLive(db, serverId);
  for (const id of IDS) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(id, id);
  const id = Number(
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, went_live_at)
       VALUES (?, 'live', 'no_mercy', ?, 'tok', datetime('now', ?))`,
    ).run(currentSeasonId(db), serverId, `-${minutesAgo} minutes`).lastInsertRowid,
  );
  IDS.forEach((sid, i) => db.prepare(
    'INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)',
  ).run(id, sid, i < 4 ? 'a' : 'b'));
  return { id, serverId };
}

describe('no-show reaper', () => {
  it('aborts and frees the box when too few ever connected', () => {
    const db = openDb(':memory:');
    const { id, serverId } = liveMatch(db, 11);
    for (const sid of IDS.slice(0, 3)) recordPlayerConnect(db, 'tok', sid);

    const reaped = reapNoShowMatches(db, new ServerReleaser(db, async () => {}));

    expect(reaped).toEqual([id]);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(id) as any).state).toBe('aborted');
    expect(getServer(db, serverId)!.status).toBe('idle');
  });

  it('leaves a well attended match alone', () => {
    const db = openDb(':memory:');
    const { id } = liveMatch(db, 11);
    for (const sid of IDS) recordPlayerConnect(db, 'tok', sid);

    expect(reapNoShowMatches(db, new ServerReleaser(db, async () => {}))).toEqual([]);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(id) as any).state).toBe('live');
  });

  it('does not fire before the threshold', () => {
    const db = openDb(':memory:');
    liveMatch(db, 5);

    expect(reapNoShowMatches(db, new ServerReleaser(db, async () => {}))).toEqual([]);
  });

  it('aborts on the backstop when everyone connected but no round was ever recorded', () => {
    const db = openDb(':memory:');
    const { id } = liveMatch(db, 31);
    for (const sid of IDS) recordPlayerConnect(db, 'tok', sid);

    expect(reapNoShowMatches(db, new ServerReleaser(db, async () => {}))).toEqual([id]);
  });

  it('records the first connect only, so a reconnect does not move the timestamp', () => {
    const db = openDb(':memory:');
    liveMatch(db, 1);
    recordPlayerConnect(db, 'tok', IDS[0]);
    const first = (db.prepare(
      'SELECT connected_at FROM match_players WHERE player_id = ?',
    ).get(IDS[0]) as any).connected_at;

    recordPlayerConnect(db, 'tok', IDS[0]);

    expect((db.prepare(
      'SELECT connected_at FROM match_players WHERE player_id = ?',
    ).get(IDS[0]) as any).connected_at).toBe(first);
  });

  it('ignores a connect for an unknown token', () => {
    const db = openDb(':memory:');
    liveMatch(db, 1);
    expect(() => recordPlayerConnect(db, 'nope', IDS[0])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/noShow.test.ts`
Expected: FAIL, cannot resolve `../src/noShow.js`.

- [ ] **Step 3: Add the column and settings**

In `src/db.ts::openDb`:

```typescript
// First time this rostered player was seen connected to the match server.
// Null means they never turned up, which is what the no-show reaper counts.
ensureColumn(db, 'match_players', 'connected_at', 'TEXT');
```

In `DEFAULT_SETTINGS`:

```typescript
  noshow_minutes: '10',
  noshow_min_connected: '6',
  no_round_minutes: '30',
```

- [ ] **Step 4: Write the implementation**

```typescript
// src/noShow.ts
import type { DB } from './db.js';
import { getSetting } from './settings.js';
import type { ServerReleaser } from './serverRelease.js';

/**
 * Stamp the first time a rostered player is seen on the match server.
 *
 * First connect only: the plugin re-fires PLAYER connect for every client
 * across a map transition (they "reconnect" through the changelevel), so
 * overwriting would make every timestamp read as the most recent map change.
 */
export function recordPlayerConnect(db: DB, token: string, steamid: string): void {
  db.prepare(
    `UPDATE match_players SET connected_at = datetime('now')
     WHERE player_id = ?
       AND connected_at IS NULL
       AND match_id IN (SELECT id FROM matches WHERE token = ?)`,
  ).run(steamid, token);
}

function num(db: DB, key: string, fallback: number): number {
  const raw = Number(getSetting(db, key));
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * Abort live matches that never actually got going, and free their box.
 *
 * The orphan reaper cannot see these. Timer_Heartbeat fires whenever the
 * plugin holds a match, connected humans or not, so a match nobody joined
 * heartbeats forever and pins servers.status = 'live' forever. Since a match
 * with no free server now waits rather than aborting, that pin would deadlock
 * every future queue pop.
 *
 * Two rules:
 *   1. Past noshow_minutes with fewer than noshow_min_connected of the roster
 *      ever connected: nobody turned up.
 *   2. Past no_round_minutes with no round ever recorded: everyone turned up
 *      and then nobody readied.
 */
export function reapNoShowMatches(db: DB, releaser: ServerReleaser): number[] {
  const noShowMin = num(db, 'noshow_minutes', 10);
  const minConnected = num(db, 'noshow_min_connected', 6);
  const noRoundMin = num(db, 'no_round_minutes', 30);

  const rows = db
    .prepare(
      `SELECT m.id, m.server_id,
              (julianday('now') - julianday(m.went_live_at)) * 24 * 60 AS age_min,
              (SELECT COUNT(*) FROM match_players mp
                WHERE mp.match_id = m.id AND mp.connected_at IS NOT NULL) AS connected,
              (SELECT COUNT(*) FROM match_rounds r WHERE r.match_id = m.id) AS rounds
         FROM matches m
        WHERE m.state = 'live' AND m.went_live_at IS NOT NULL`,
    )
    .all() as { id: number; server_id: number | null; age_min: number; connected: number; rounds: number }[];

  const doomed = rows.filter(
    (r) =>
      (r.age_min >= noShowMin && r.connected < minConnected) ||
      (r.age_min >= noRoundMin && r.rounds === 0),
  );

  for (const r of doomed) {
    db.prepare("UPDATE matches SET state = 'aborted', ended_at = datetime('now') WHERE id = ?")
      .run(r.id);
    if (r.server_id !== null) releaser.release(r.server_id);
    console.warn(
      `[noShow] aborted match ${r.id}: ${r.connected} connected, ${r.rounds} rounds, ${Math.round(r.age_min)} min live`,
    );
  }
  return doomed.map((r) => r.id);
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/noShow.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Wire it into the server**

In `src/server.ts`, inside the existing else-if chain over `ev.kind` (around line 180), add:

```typescript
          else if (ev.kind === 'player' && ev.event === 'connect') {
            recordPlayerConnect(deps.db, ev.token, ev.steamid);
          }
```

In the 60 second interval that calls `reapOrphanedMatches` (around line 284), add a second call in its own try/catch so one reaper failing never stops the other:

```typescript
    try {
      reapNoShowMatches(deps.db, releaser);
    } catch (err) {
      console.error('[noShow] reaper failed:', err);
    }
```

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS, 1105 tests.

- [ ] **Step 8: Commit**

```bash
git add src/noShow.ts tests/noShow.test.ts src/db.ts src/server.ts
git commit -m "feat: abort and free the box for a match nobody turned up to

Timer_Heartbeat beats with zero humans connected, so the orphan reaper
cannot see an unattended match: it stays live forever and pins the
server. Handles the PLAYER connect lines the parser already produced and
server.ts silently dropped."
```

---

### Task 4: Wait for a free server instead of aborting

`setupMatch:78` aborts the match when `claimIdle` returns null. The owner's rule: if a box is free it is claimable, if none are free the pug waits.

Drain on release rather than a retry timer: there is exactly one place a server becomes free (Task 1's releaser), so the reaction is immediate and no third timer joins the reaper and the prune. The in-memory list is rebuilt from `state='configuring'` at boot, because the same class of bug (in-memory token registry lost on restart) already deafened in-flight matches once.

**Files:**
- Create: `src/pendingMatches.ts`
- Create: `tests/pendingMatches.test.ts`
- Modify: `src/orchestrator.ts:77-82`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `ServerReleaser.onFreed` from Task 1.
- Produces: `class PendingMatches { constructor(db: DB, setup: (matchId: number) => Promise<void>); add(matchId: number): void; drain(): void; rebuildFromDb(): void; size(): number }`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/pendingMatches.test.ts
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { currentSeasonId } from '../src/players.js';
import { PendingMatches } from '../src/pendingMatches.js';

function configuringMatch(db: DB): number {
  return Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', 'no_mercy')")
      .run(currentSeasonId(db)).lastInsertRowid,
  );
}

describe('PendingMatches', () => {
  it('retries the oldest waiting match when a box frees', async () => {
    const db = openDb(':memory:');
    const a = configuringMatch(db);
    const b = configuringMatch(db);
    const tried: number[] = [];
    const pending = new PendingMatches(db, async (id) => { tried.push(id); });

    pending.add(a);
    pending.add(b);
    pending.drain();
    await new Promise((r) => setImmediate(r));

    expect(tried).toEqual([a]);
    expect(pending.size()).toBe(1);
  });

  it('does not retry a match that is no longer configuring', async () => {
    const db = openDb(':memory:');
    const id = configuringMatch(db);
    const tried: number[] = [];
    const pending = new PendingMatches(db, async (i) => { tried.push(i); });

    pending.add(id);
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(id);
    pending.drain();
    await new Promise((r) => setImmediate(r));

    expect(tried).toEqual([]);
    expect(pending.size()).toBe(0);
  });

  it('never queues the same match twice', () => {
    const db = openDb(':memory:');
    const id = configuringMatch(db);
    const pending = new PendingMatches(db, async () => {});

    pending.add(id);
    pending.add(id);

    expect(pending.size()).toBe(1);
  });

  it('rebuilds from the database at boot so a restart does not strand anyone', () => {
    const db = openDb(':memory:');
    const a = configuringMatch(db);
    const b = configuringMatch(db);
    db.prepare("UPDATE matches SET state = 'live' WHERE id = ?").run(b);
    const pending = new PendingMatches(db, async () => {});

    pending.rebuildFromDb();

    expect(pending.size()).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/pendingMatches.test.ts`
Expected: FAIL, cannot resolve `../src/pendingMatches.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/pendingMatches.ts
import type { DB } from './db.js';

/**
 * Matches that could not claim a server and are waiting for one.
 *
 * The owner's rule: a box running a pug is not claimable, a free one is, and
 * if none are free the pug waits rather than dying. Drained by the
 * ServerReleaser rather than polled, since there is exactly one place a server
 * becomes free.
 *
 * Held in memory but rebuilt from state='configuring' at boot. The same shape
 * of bug bit once already: registered match tokens lived only in memory, so
 * every deploy deafened the matches in flight until server.ts learned to
 * re-register them on startup.
 */
export class PendingMatches {
  private waiting: number[] = [];

  constructor(private db: DB, private setup: (matchId: number) => Promise<void>) {}

  add(matchId: number): void {
    if (!this.waiting.includes(matchId)) this.waiting.push(matchId);
  }

  size(): number {
    return this.waiting.length;
  }

  /** Re-read the waiting set from the database. Call once at startup. */
  rebuildFromDb(): void {
    const rows = this.db
      .prepare("SELECT id FROM matches WHERE state = 'configuring' ORDER BY id")
      .all() as { id: number }[];
    this.waiting = rows.map((r) => r.id);
  }

  /**
   * One box freed, so retry one match. Oldest first, and only one: a second
   * waiting match has no server to go to and would just abort itself.
   */
  drain(): void {
    while (this.waiting.length > 0) {
      const matchId = this.waiting.shift()!;
      const row = this.db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as
        | { state: string }
        | undefined;
      // Aborted or already live while it waited: drop it and try the next one.
      if (!row || row.state !== 'configuring') continue;
      void this.setup(matchId).catch((err) => {
        console.error(`[pendingMatches] retry failed for match ${matchId}:`, err);
      });
      return;
    }
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/pendingMatches.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Make `setupMatch` pend instead of abort**

`RealOrchestratorDeps` gains `onNoServer?: (matchId: number) => void`. Replace the abort block at `src/orchestrator.ts:77-82`:

```typescript
    const server = claimIdle(this.db);
    if (!server) {
      // Wait, do not abort. The match stays 'configuring' and the pending list
      // retries it when a box frees. Only the no-server case pends: an rcon
      // failure below still aborts, because retrying a broken setup forever
      // would pin the queue on a server that is not going to work.
      console.warn(`[orchestrator] no idle server for match ${matchId}; waiting`);
      this.onNoServer?.(matchId);
      return;
    }
```

- [ ] **Step 6: Write the test for the new orchestrator behaviour**

Add to `tests/orchestrator.test.ts`:

```typescript
it('waits rather than aborting when no server is idle', async () => {
  const { db, orch } = await setupFixture();
  const mid = seedMatch(db);
  db.prepare("UPDATE servers SET status = 'live'").run();
  const pended: number[] = [];
  orch.onNoServer = (id: number) => pended.push(id);

  await orch.setupMatch(mid);

  expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state)
    .toBe('configuring');
  expect(pended).toEqual([mid]);
});
```

Adjust to however `setupFixture` supplies deps in that file; if `onNoServer` is constructor-injected there rather than assignable, pass it at construction instead.

- [ ] **Step 7: Wire it in the server**

In `src/server.ts`, after the orchestrator and releaser exist:

```typescript
const pending = new PendingMatches(db, (id) => orchestrator.setupMatch(id));
pending.rebuildFromDb();
releaser.onFreed(() => pending.drain());
```

and pass `onNoServer: (id) => pending.add(id)` into `new RealOrchestrator({...})`. Construction order: releaser, then orchestrator (needs releaser), then pending (needs orchestrator), then `releaser.onFreed`.

- [ ] **Step 8: Run the suite**

Run: `npm test`
Expected: PASS, 1110 tests.

- [ ] **Step 9: Commit**

```bash
git add src/pendingMatches.ts tests/pendingMatches.test.ts src/orchestrator.ts src/server.ts tests/orchestrator.test.ts
git commit -m "feat: a match with no free server waits instead of aborting

Drained by the releaser rather than polled, since there is exactly one
place a server becomes free, and rebuilt from state='configuring' at
boot so a deploy does not strand a waiting match."
```

---

### Task 5: Connect details and queue rosters on the state snapshot

`StateSnapshot.match` carries no host, port or password, so eight players would get balanced teams and a locked server they cannot enter. `StateSnapshot.queue` carries only a count, so nobody can see who is waiting.

The password is derived from the token, never stored twice. It goes only to viewers on that match's roster, and only once the match is `live`: before that the box is still mid-`changelevel`.

**Files:**
- Modify: `src/matchmaker.ts` (`NamedPlayer`, `StateSnapshot`, `stateFor`)
- Modify: `web/src/api.ts` (mirror the types)
- Test: `tests/matchmaker.test.ts`

**Interfaces:**
- Produces:
  - `interface NamedPlayer { steamid: string; name: string; avatar: string | null }`
  - `StateSnapshot.queue` gains `players: NamedPlayer[]`
  - `StateSnapshot.match` gains `connect: { host: string; port: number; password: string } | null` and `waitingForServer: boolean`

- [ ] **Step 1: Write the failing test**

Add to `tests/matchmaker.test.ts`:

```typescript
describe('stateFor connect details', () => {
  it('gives a rostered player the connect block once the match is live', () => {
    const { db, mm } = fixtureWithLiveMatch();
    const snap = mm.stateFor(IDS[0]);
    expect(snap.match!.connect).toEqual({
      host: '10.0.0.1', port: 27015, password: 'pug_abcdef12',
    });
  });

  it('withholds the connect block while the match is still configuring', () => {
    const { db, mm, matchId } = fixtureWithLiveMatch();
    db.prepare("UPDATE matches SET state = 'configuring' WHERE id = ?").run(matchId);
    expect(mm.stateFor(IDS[0]).match!.connect).toBeNull();
  });

  it('lists who is in the queue, with avatars', () => {
    const { db, mm } = fixture();
    db.prepare('UPDATE players SET avatar = ? WHERE steamid = ?').run('http://a/1.jpg', IDS[0]);
    mm.join(IDS[0]);
    const snap = mm.stateFor(IDS[0]);
    expect(snap.queue.players).toEqual([
      { steamid: IDS[0], name: expect.any(String), avatar: 'http://a/1.jpg' },
    ]);
  });

  it('flags a match that is waiting for a free server', () => {
    const { db, mm, matchId } = fixtureWithLiveMatch();
    db.prepare("UPDATE matches SET state = 'configuring', server_id = NULL WHERE id = ?").run(matchId);
    expect(mm.stateFor(IDS[0]).match!.waitingForServer).toBe(true);
  });
});
```

Build `fixtureWithLiveMatch` on the helpers already in that file: a match row with `state='live'`, `token='abcdef1234567890...'` and a `servers` row at `10.0.0.1:27015`, plus eight `match_players`. The expected password is `pug_` + the first 8 characters of that token.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/matchmaker.test.ts -t "connect details"`
Expected: FAIL, `connect` is undefined.

- [ ] **Step 3: Implement**

In `src/matchmaker.ts`, widen `NamedPlayer` and `StateSnapshot`:

```typescript
export interface NamedPlayer {
  steamid: string;
  name: string;
  avatar: string | null;
}

export interface StateSnapshot {
  queue: { count: number; joined: boolean; players: NamedPlayer[] };
  lobby: (Omit<LobbySnapshot, 'players'> & { players: NamedPlayer[]; myVote: string | null }) | null;
  match: {
    id: number;
    state: string;
    campaign: string;
    teamA: NamedPlayer[];
    teamB: NamedPlayer[];
    /** Only for a viewer on this roster, and only once the match is live. */
    connect: { host: string; port: number; password: string } | null;
    /** Live but serverless means it is queued behind another match. */
    waitingForServer: boolean;
  } | null;
}
```

In `stateFor`, extend `named` to carry the avatar, widen the match query to `SELECT m.*`, and build the block:

```typescript
    const named = (id: string): NamedPlayer => {
      const p = getPlayer(this.db, id);
      return { steamid: id, name: p?.name ?? id, avatar: p?.avatar ?? null };
    };
```

```typescript
      // Derived, never stored twice: this is the same expression setupMatch
      // uses to set sv_password, so the two cannot drift.
      let connect: StateSnapshot['match'] extends null ? never : { host: string; port: number; password: string } | null = null;
      if (matchRow.state === 'live' && matchRow.server_id !== null && matchRow.token) {
        const server = getServer(this.db, matchRow.server_id);
        if (server) {
          connect = {
            host: server.host,
            port: server.port,
            password: `pug_${matchRow.token.slice(0, 8)}`,
          };
        }
      }
```

Simplify that local type to `{ host: string; port: number; password: string } | null`. The viewer is already on the roster: `stateFor`'s query joins `match_players` on the caller's steamid, so no extra check is needed, and that is worth a comment so nobody later "adds the missing guard" and duplicates it.

Set `waitingForServer: matchRow.state === 'configuring' && matchRow.server_id === null`, and add `players: this.queue.list().map(named)` to the queue block. Import `getServer` from `./serverPool.js`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/matchmaker.test.ts`
Expected: PASS.

- [ ] **Step 5: Mirror the types in the web client**

Update `web/src/api.ts` lines 20-48 so `NamedPlayer` has `avatar: string | null`, `StateSnapshot.queue` has `players: NamedPlayer[]`, and the match block has `connect` and `waitingForServer`. Types only, no behaviour.

- [ ] **Step 6: Run the suite and the typecheck**

Run: `npm test && npx tsc --noEmit -p web`
Expected: both clean. Fix any component that destructures `NamedPlayer` positionally.

- [ ] **Step 7: Commit**

```bash
git add src/matchmaker.ts web/src/api.ts tests/matchmaker.test.ts
git commit -m "feat: connect details and queue rosters on the state snapshot

The password is derived from the match token rather than stored a second
time, and reaches only a viewer already on the roster, only once the
match is live."
```

---

### Task 6: Public queue route

`/api/state` cannot be unlocked: it is entirely viewer-relative and meaningless anonymously. So a separate public route, which must never carry the connect block.

**Files:**
- Create: `tests/queueRoute.test.ts`
- Modify: `src/matchmaker.ts` (add `publicQueue()`)
- Modify: `src/routes/api.ts`
- Modify: `web/src/api.ts`

**Interfaces:**
- Produces:
  - `Matchmaker.publicQueue(): { count: number; players: NamedPlayer[]; phase: LobbyPhase | null }`
  - `GET /api/queue`, no auth
  - `api.queue()` in the web client

- [ ] **Step 1: Write the failing test**

```typescript
// tests/queueRoute.test.ts
import { describe, it, expect } from 'vitest';
import { buildTestServer } from './helpers.js';

describe('GET /api/queue', () => {
  it('is public and lists who is queued', async () => {
    const { app, db, mm, ids } = await buildTestServer();
    mm.join(ids[0]);

    const res = await app.inject({ method: 'GET', url: '/api/queue' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.players[0].steamid).toBe(ids[0]);
    await app.close();
  });

  it('never exposes connect details', async () => {
    const { app } = await buildTestServer();
    const body = await app.inject({ method: 'GET', url: '/api/queue' }).then((r) => r.json());
    expect(JSON.stringify(body)).not.toContain('password');
    expect(body.connect).toBeUndefined();
    await app.close();
  });
});
```

Use whatever server-building helper `tests/api.test.ts` already uses; do not add a new one. If it requires an authenticated session by default, call it in its anonymous mode.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/queueRoute.test.ts`
Expected: FAIL, 404.

- [ ] **Step 3: Implement**

In `src/matchmaker.ts`:

```typescript
  /**
   * The queue as anyone may see it, signed in or not.
   *
   * Deliberately not stateFor with the auth removed: that snapshot is entirely
   * viewer-relative (are YOU queued, YOUR lobby, YOUR vote) and would be
   * meaningless anonymously. Carries no connect block and no match id.
   */
  publicQueue(): { count: number; players: NamedPlayer[]; phase: LobbyPhase | null } {
    const named = (id: string): NamedPlayer => {
      const p = getPlayer(this.db, id);
      return { steamid: id, name: p?.name ?? id, avatar: p?.avatar ?? null };
    };
    const anyLobby = [...this.lobbies.values()][0];
    return {
      count: this.queue.count(),
      players: this.queue.list().map(named),
      phase: anyLobby?.snapshot().phase ?? null,
    };
  }
```

Import `LobbyPhase` from `./lobby.js` if it is not already imported. Factor the duplicated `named` helper out to a private method rather than writing it twice in the file.

In `src/routes/api.ts`, after the other routes, with no guard:

```typescript
  // Public on purpose: the point is that people can watch the queue fill
  // without signing in. Carries nothing viewer-relative and no connect block.
  app.get('/api/queue', async () => matchmaker.publicQueue());
```

In `web/src/api.ts`, add the type and `queue: (signal?: AbortSignal) => get<PublicQueue>('/api/queue', signal)`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/queueRoute.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/matchmaker.ts src/routes/api.ts web/src/api.ts tests/queueRoute.test.ts
git commit -m "feat: public GET /api/queue so anyone can watch the queue fill"
```

---

### Task 7: Steam persona backfill

`fetchPersona` is called from exactly one place, the login callback at `routes/auth.ts:27`. Players created from roster snapshots keep their in-game nickname and a null avatar: 16 of the 18 rows on the box. Tasks 5 and 8 put those names and faces on screen.

`GetPlayerSummaries` accepts up to 100 steamids per call, so the whole table is one request.

**Files:**
- Create: `src/personaBackfill.ts`
- Create: `tests/personaBackfill.test.ts`
- Modify: `src/steamAuth.ts` (add a batch fetch beside `fetchPersona`)
- Modify: `src/server.ts` (run once at startup)

**Interfaces:**
- Produces:
  - `fetchPersonas(steamids: string[], apiKey: string | null, fetchFn?: FetchFn): Promise<Map<string, { name: string; avatar: string | null }>>`
  - `backfillPersonas(db: DB, apiKey: string | null, fetch?: FetchFn): Promise<number>` returning how many rows were updated

- [ ] **Step 1: Write the failing test**

```typescript
// tests/personaBackfill.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { backfillPersonas } from '../src/personaBackfill.js';

const OK = (players: any[]) => async () =>
  ({ json: async () => ({ response: { players } }) }) as any;

describe('backfillPersonas', () => {
  it('fills name and avatar for players who have no avatar', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run('76561198000000001', 'dizzy');

    const n = await backfillPersonas(db, 'key', OK([
      { steamid: '76561198000000001', personaname: 'Dizzy', avatarfull: 'http://a/1.jpg' },
    ]));

    expect(n).toBe(1);
    const row = db.prepare('SELECT name, avatar FROM players WHERE steamid = ?').get('76561198000000001') as any;
    expect(row).toEqual({ name: 'Dizzy', avatar: 'http://a/1.jpg' });
  });

  it('leaves players who already have an avatar alone', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name, avatar) VALUES (?, ?, ?)')
      .run('76561198000000002', 'Real Name', 'http://a/2.jpg');
    let called = false;

    const n = await backfillPersonas(db, 'key', (async () => { called = true; return OK([])(); }) as any);

    expect(n).toBe(0);
    expect(called).toBe(false);
  });

  it('does nothing without an api key', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run('76561198000000003', 'x');
    expect(await backfillPersonas(db, null)).toBe(0);
  });

  it('survives a steam outage without touching any row', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run('76561198000000004', 'nick');

    const n = await backfillPersonas(db, 'key', (async () => { throw new Error('down'); }) as any);

    expect(n).toBe(0);
    expect((db.prepare('SELECT name FROM players WHERE steamid = ?').get('76561198000000004') as any).name)
      .toBe('nick');
  });

  it('skips a steamid steam returns nothing for', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run('76561198000000005', 'ghost');
    expect(await backfillPersonas(db, 'key', OK([]))).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/personaBackfill.test.ts`
Expected: FAIL, cannot resolve `../src/personaBackfill.js`.

- [ ] **Step 3: Add the batch fetch**

In `src/steamAuth.ts`, beside `fetchPersona`:

```typescript
/** Batch persona lookup. GetPlayerSummaries takes up to 100 ids per call, so
 *  the whole players table is normally a single request. Best effort like its
 *  single-id sibling: a failure yields an empty map, never a throw. */
export async function fetchPersonas(
  steamids: string[],
  apiKey: string | null,
  fetchFn: FetchFn = fetch,
): Promise<Map<string, { name: string; avatar: string | null }>> {
  const out = new Map<string, { name: string; avatar: string | null }>();
  if (!apiKey || steamids.length === 0) return out;
  for (let i = 0; i < steamids.length; i += 100) {
    const batch = steamids.slice(i, i + 100);
    try {
      const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${batch.join(',')}`;
      const res = await fetchFn(url);
      const data: any = await res.json();
      for (const p of data?.response?.players ?? []) {
        if (!p?.steamid) continue;
        out.set(p.steamid, { name: p.personaname ?? p.steamid, avatar: p.avatarfull ?? null });
      }
    } catch {
      // Leave this batch out. The caller updates only what came back.
    }
  }
  return out;
}
```

- [ ] **Step 4: Write the backfill**

```typescript
// src/personaBackfill.ts
import type { DB } from './db.js';
import { fetchPersonas } from './steamAuth.js';

type FetchFn = typeof fetch;

/**
 * Give roster-created players their real Steam name and avatar.
 *
 * fetchPersona only ever ran in the login callback, so anyone the backend
 * learned about from a MATCH_ROSTER line kept their in-game nickname and no
 * avatar. Harmless until the queue page started showing faces.
 *
 * A null avatar is the marker for "never looked up": a real persona always
 * carries one, and a lookup that genuinely returns no avatar is rare enough
 * that retrying it on the next boot costs nothing.
 */
export async function backfillPersonas(db: DB, apiKey: string | null, fetchFn?: FetchFn): Promise<number> {
  if (!apiKey) return 0;
  const rows = db.prepare('SELECT steamid FROM players WHERE avatar IS NULL').all() as
    { steamid: string }[];
  if (rows.length === 0) return 0;

  const personas = await fetchPersonas(rows.map((r) => r.steamid), apiKey, fetchFn);
  if (personas.size === 0) return 0;

  const update = db.prepare('UPDATE players SET name = ?, avatar = ? WHERE steamid = ?');
  let n = 0;
  db.transaction(() => {
    for (const [steamid, p] of personas) {
      update.run(p.name, p.avatar, steamid);
      n++;
    }
  })();
  return n;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/personaBackfill.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run it at startup**

In `src/server.ts`, after the db is open:

```typescript
  // Best effort and never awaited: a Steam outage must not delay boot.
  void backfillPersonas(deps.db, deps.config.steamApiKey)
    .then((n) => { if (n > 0) console.log(`[persona] backfilled ${n} player(s)`); })
    .catch((err) => console.error('[persona] backfill failed:', err));
```

- [ ] **Step 7: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/personaBackfill.ts tests/personaBackfill.test.ts src/steamAuth.ts src/server.ts
git commit -m "feat: backfill Steam personas for roster-created players

fetchPersona only ever ran in the login callback, so 16 of 18 players on
the box had an in-game nickname and no avatar."
```

---

### Task 8: Web, the connect panel

**Files:**
- Create: `web/src/components/ConnectPanel.tsx`
- Create: `web/src/components/ConnectPanel.test.tsx`
- Modify: `web/src/routes/Play.tsx` (the `Live` match branch, lines 84-105)

**Interfaces:**
- Consumes: `StateSnapshot['match']` from Task 5.
- Produces: `<ConnectPanel connect={...} />`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/ConnectPanel.test.tsx
import { render, screen } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { ConnectPanel } from './ConnectPanel';

const CONNECT = { host: '45.32.199.85', port: 27015, password: 'pug_a1b2c3d4' };

describe('ConnectPanel', () => {
  it('links straight into the game with the match password', () => {
    render(<ConnectPanel connect={CONNECT} />);
    expect(screen.getByRole('link', { name: /join server/i }))
      .toHaveAttribute('href', 'steam://connect/45.32.199.85:27015/pug_a1b2c3d4');
  });

  it('shows the console line as a fallback', () => {
    render(<ConnectPanel connect={CONNECT} />);
    expect(screen.getByText('connect 45.32.199.85:27015; password pug_a1b2c3d4')).toBeTruthy();
  });
});
```

Match the import style and testing-library setup of the neighbouring `web/src/components/*.test.tsx` files rather than the exact lines above.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run web/src/components/ConnectPanel.test.tsx`
Expected: FAIL, cannot resolve `./ConnectPanel`.

- [ ] **Step 3: Implement**

```tsx
// web/src/components/ConnectPanel.tsx
import { useState } from 'preact/hooks';

export interface ConnectInfo {
  host: string;
  port: number;
  password: string;
}

/**
 * How the eight actually get into the server.
 *
 * Both a steam:// link and the console line on purpose: sv_password means this
 * is the only door in, so a protocol handler that misbehaves on one person's
 * machine must not be a locked door.
 */
export function ConnectPanel({ connect }: { connect: ConnectInfo }) {
  const [copied, setCopied] = useState(false);
  const line = `connect ${connect.host}:${connect.port}; password ${connect.password}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied. The line is on screen to select by hand.
    }
  };

  return (
    <div class="connect">
      <a class="btn btn--block" href={`steam://connect/${connect.host}:${connect.port}/${connect.password}`}>
        Join server
      </a>
      <p class="muted">or paste into console:</p>
      <div class="connect__line">
        <code>{line}</code>
        <button class="btn btn--ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run web/src/components/ConnectPanel.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Render it in the match panel**

In `web/src/routes/Play.tsx`, inside the `if (match)` branch after the teams block:

```tsx
        {match.connect && <ConnectPanel connect={match.connect} />}
        {match.waitingForServer && (
          <Empty>Waiting for a free server. The match starts as soon as one opens up.</Empty>
        )}
```

and change the eyebrow so the three states read correctly:

```tsx
        <p class="eyebrow">
          {match.state === 'live' ? 'Match in progress'
            : match.waitingForServer ? 'Waiting for a server'
            : 'Setting up server'}
        </p>
```

Add the `.connect` and `.connect__line` rules to the stylesheet the other components use, following the existing "Safe Room" tokens rather than new colours.

- [ ] **Step 6: Run the suite and typecheck**

Run: `npm test && npx tsc --noEmit -p web`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/ConnectPanel.tsx web/src/components/ConnectPanel.test.tsx web/src/routes/Play.tsx web/src/
git commit -m "feat(web): hand the eight a steam:// link and a console line

sv_password makes this the only door in, so the console line is there for
when the protocol handler misbehaves."
```

---

### Task 9: Web, queue faces and the public queue

**Files:**
- Modify: `web/src/routes/Play.tsx` (`Slots`, `QueuePanel`, `SignIn`)
- Test: `web/src/routes/routes.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `web/src/routes/routes.test.tsx`:

```tsx
it('shows who is in the queue and keeps the empty slots visible', () => {
  const players = [
    { steamid: '1', name: 'dizzy', avatar: 'http://a/1.jpg' },
    { steamid: '2', name: 'mayhem', avatar: null },
  ];
  render(<QueuePanel count={2} joined={false} players={players} refresh={() => {}} />);

  expect(screen.getByText('dizzy')).toBeTruthy();
  expect(screen.getByText('mayhem')).toBeTruthy();
  expect(document.querySelectorAll('.slot').length).toBe(8);
});
```

Export `QueuePanel` from `Play.tsx` if it is not already exported, and follow the render/import conventions already in that test file.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run web/src/routes/routes.test.tsx`
Expected: FAIL, names are not rendered.

- [ ] **Step 3: Implement**

Thread `players` through `QueuePanel` into `Slots`, and fill occupied slots:

```tsx
/** Eight fixed slots rather than a list that grows. A half-full queue should
 *  look like a half-full queue: the empty slots are the information. Filled
 *  ones now name who is in them, which is what a friend group actually wants
 *  to know before deciding to join. */
function Slots({ players }: { players: NamedPlayer[] }) {
  return (
    <div class="slots">
      {Array.from({ length: QUEUE_SIZE }, (_, i) => {
        const p = players[i];
        return (
          <div key={i} class={`slot ${p ? 'slot--filled' : ''}`} title={p?.name}>
            {p && (
              <>
                {p.avatar
                  ? <img class="slot__avatar" src={p.avatar} alt="" />
                  : <span class="slot__avatar slot__avatar--none" aria-hidden="true" />}
                <span class="slot__name">{p.name}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Show the queue to signed-out visitors**

`SignIn` currently renders only the hero panel. Give it the public queue:

```tsx
function SignIn() {
  const [q, setQ] = useState<PublicQueue | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => api.queue().then((r) => { if (alive) setQ(r); }).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <div class="page page--play">
      <Panel class="hero-panel">
        <p class="eyebrow">Riverside</p>
        <h1>Ranked 4v4 pick-up games</h1>
        <p class="muted">Sign in to join the queue.</p>
        <a class="btn" href="/auth/steam">Sign in through Steam</a>
      </Panel>
      {q && (
        <Panel>
          <p class="eyebrow">Queue</p>
          <div class="queue-count">
            <span class="hero">{q.count}</span>
            <span class="queue-count__of">/ {QUEUE_SIZE}</span>
          </div>
          <Slots players={q.players} />
        </Panel>
      )}
    </div>
  );
}
```

Poll on an interval rather than through the websocket: the socket nudge is session-scoped and an anonymous visitor has no session, which is the same reason the live page polls.

- [ ] **Step 5: Run the suite and typecheck**

Run: `npm test && npx tsc --noEmit -p web`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/Play.tsx web/src/routes/routes.test.tsx web/src/
git commit -m "feat(web): name who is in the queue, and show it signed out

A count of 3 does not tell you whether to join; three names do."
```

---

### Task 10: Plugin, place rostered players instead of kicking anyone

Two changes in `plugin/pug-match.sp`. Both are owner rulings: the rostered eight belong in the correct slots, and anyone else who wants to spectate may.

`Timer_TeamLock` already does the placement. It is gated by `if (!g_cvTeamLock.BoolValue || g_cvAutoTrack.BoolValue)`, and `sm_pug_auto_track` is persisted to 1 on the live box, so as things stand a backend match would place nobody.

**Files:**
- Modify: `plugin/pug-match.sp` (`OnClientPostAdminCheck` around :2069-2093, `Timer_TeamLock`)
- Modify: `plugin/README.md`

- [ ] **Step 1: Drop the kick**

Replace the non-rostered branch in `OnClientPostAdminCheck`:

```sourcepawn
	int slot = RosterIndexOfId(id);
	if (slot == -1)
	{
		// Nobody is kicked, backend match or not. The owner's rule is that the
		// rostered eight belong in the correct slots and anyone else may
		// spectate; Timer_TeamLock does the placing, so enforcement never
		// needed a door policy. This also removes the first-run failure mode
		// where one bad roster line bounced all eight players with no in-game
		// recourse.
		return;
	}
```

Leave `KickClient(client, "Could not verify Steam ID")` above it alone: an unauthenticated client cannot be attributed to anyone.

- [ ] **Step 2: Let a backend roster lock teams under auto-track**

In `Timer_TeamLock`, replace the gate:

```sourcepawn
	// Testing switch: the vote above still tracks orientation for scoring, but
	// nobody is moved. Never leave this off for a real ranked match.
	if (!g_cvTeamLock.BoolValue) return Plugin_Continue;
	// Auto-track implies no team lock only for the matches auto-track itself
	// starts, which have no authority: their "roster" is just whoever happened
	// to be on each side. A backend-issued roster is authoritative and must be
	// enforced even while auto_track is on, which it always is on the live box.
	if (g_cvAutoTrack.BoolValue && g_bSelfStarted) return Plugin_Continue;
```

- [ ] **Step 3: Update the header contract**

The comment block at `pug-match.sp:99-104` documents the two self-started differences, one of which is now gone. Rewrite it to say the match id is still 0 until `sm_pug_setid`, and that no match kicks non-rostered players any more.

- [ ] **Step 4: Compile**

Run: `cd plugin && ./build.sh`
Expected: compiles clean, `pug-match.smx` timestamp updates. Warnings that already existed are fine; new ones are not.

- [ ] **Step 5: Update the plugin README**

In `plugin/README.md`, correct the roster-enforcement description: `enforceRoster` no longer means kicking. Say that placement is by `Timer_TeamLock` and non-rostered clients spectate.

- [ ] **Step 6: Commit**

```bash
git add plugin/pug-match.sp plugin/pug-match.smx plugin/README.md
git commit -m "feat(plugin): place the roster, kick nobody

The kick branch had never executed on the live box, since every match so
far was self-started. A backend roster now locks teams even while
auto_track is on, which it always is, so a web match would otherwise
have placed nobody."
```

**Verification note:** SourcePawn has no test harness here. This task is verified in Task 12's runbook, not by an automated test. Do not claim it works before then.

---

### Task 11: Plugin, match end sends everyone to the main menu

`EndMatchNow` already prints the score to chat. It needs the winner in that line and a delayed kick carrying the result, which Source shows in the main-menu dialog.

Safe for reporting: `WriteDump` reads only the roster-slot arrays (`g_sRosterId`, `g_iStat*`, `g_iMapScore*`), nothing about connected clients, so the backend can still pull a complete dump from an empty server.

**Files:**
- Modify: `plugin/pug-match.sp` (`EndMatchNow` and a new timer callback)

- [ ] **Step 1: Store the result text and schedule the kick**

At the end of `EndMatchNow`, after the existing `EmitPug` and `PugDebug` lines, replace the `PrintToChatAll` with:

```sourcepawn
	char teamName[16];
	if (StrEqual(winner, "draw")) strcopy(teamName, sizeof(teamName), "Draw");
	else Format(teamName, sizeof(teamName), "Team %s wins", winner[0] == 'a' ? "A" : "B");

	// Held in a global because the timer fires after this frame and cannot be
	// handed a string. One match ends at a time, so a single buffer is enough.
	Format(g_sEndResult, sizeof(g_sEndResult), "%s: %s %d to %d",
		g_sCampaign, teamName, a, b);

	PrintToChatAll("[PUG] Match ended. %s. Reporting to the site.", g_sEndResult);
	// Everyone, spectators included, so the box is empty and ready for the next
	// queue pop. Delayed so the score can be read in game first rather than
	// only in the menu dialog. Safe for reporting: WriteDump reads roster slots,
	// not clients, so the backend still gets a complete dump from an empty
	// server.
	CreateTimer(END_KICK_DELAY, Timer_EndKick);
```

- [ ] **Step 2: Add the global, the constant and the callback**

Beside the other globals:

```sourcepawn
#define END_KICK_DELAY 8.0
char g_sEndResult[128];
```

And the callback:

```sourcepawn
public Action Timer_EndKick(Handle timer)
{
	if (g_sEndResult[0] == '\0') return Plugin_Stop;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (IsClientInGame(c) && !IsFakeClient(c)) KickClient(c, "%s", g_sEndResult);
	}
	return Plugin_Stop;
}
```

`KickClient` with a format string, not a bare buffer: a campaign or player name containing a `%` would otherwise be interpreted as a format specifier.

- [ ] **Step 3: Clear the buffer on a new match**

Wherever match state is reset for a new match (the same place that clears `g_iLockAttempts` and the roster), add `g_sEndResult[0] = '\0';` so a stale result can never kick players out of a fresh match.

- [ ] **Step 4: Compile**

Run: `cd plugin && ./build.sh`
Expected: compiles clean.

- [ ] **Step 5: Commit**

```bash
git add plugin/pug-match.sp plugin/pug-match.smx
git commit -m "feat(plugin): send everyone to the main menu with the result

Chat the winner, then kick every client eight seconds later with the
result as the kick reason, which Source shows in the menu dialog. Leaves
the box empty for the next queue pop."
```

**Verification note:** as with Task 10, verified in the runbook, not by a test.

---

### Task 12: First-run runbook

The plugin halves of this work cannot be tested automatically, and this is the first time the web orchestration leg runs against a real server. The runbook is the test.

**Files:**
- Create: `plugin/RUNBOOK-first-web-match.md`

- [ ] **Step 1: Write the runbook**

Cover, in order:

1. **Preconditions.** Server empty (`status` over rcon shows no humans). No live match: `SELECT id, state FROM matches WHERE state IN ('configuring','live')` is empty, and `SELECT status FROM servers` reads `idle`. Owner has given an explicit go-ahead.
2. **Ship order.** `./deploy-web.sh`, then `plugin/build.sh` and `plugin/stage.sh` with the server still empty, then rcon `sm_pug_auto_track 1; sm_pug_roster_at_live 1`. A plugin reload resets every cvar until the next map change.
3. **Roster identity check, before anyone connects.** After the queue pops and `setupMatch` runs, rcon `sm_pug_status` and confirm the eight SteamID64s match `SELECT player_id FROM match_players WHERE match_id = ?`. This is the pairing that has never been exercised on the backend path.
4. **Connect.** Each player uses the site's Join server button. Confirm all eight land, and that a ninth non-rostered person is NOT kicked and can spectate.
5. **Placement.** Confirm each player is moved to their assigned side within a few seconds without typing anything, and that `sm_pug_debug 1` logs `lock moving` lines rather than silence. Silence here means the auto-track gate from Task 10 did not take.
6. **Play and end.** Play through, or `!endpug` to shortcut. Confirm the chat line carries the winner, then that everyone lands on the main menu with the result in the dialog.
7. **Teardown.** Confirm `sv_password` is empty (`rcon sv_password` prints no value), `servers.status` is back to `idle`, the match row is `completed`, and SR moved on the leaderboard.
8. **Rollback.** If the plugin misbehaves, `plugin/stage.sh` the previous `.smx` and rcon `sm_pug_abort <token>`. Never blanket-update matches: `UPDATE matches SET state='aborted' WHERE state='live'` killed a match the owner had just started. Target a specific id.

- [ ] **Step 2: Commit**

```bash
git add plugin/RUNBOOK-first-web-match.md
git commit -m "docs: runbook for the first website-to-playing match"
```

---

## Self-Review

**Spec coverage:**

| Spec piece | Task |
|---|---|
| 1 connect handoff | 5 (backend), 8 (web) |
| 2 sv_password teardown | 1 |
| 3 release chokepoint and waiting | 1 (chokepoint), 4 (waiting), 2 (`went_live_at` so waiting does not break the no-show timer) |
| 4 who is in the queue | 5 (backend), 9 (web) |
| 5 public queue view | 6 |
| 6 persona backfill | 7 |
| 7 placement instead of kicking | 10 |
| 8 match end to main menu | 11 |
| 9 no-show timeout | 3 |
| First-run runbook | 12 |

**Ordering:** Task 3 before Task 4 is deliberate. Task 4 turns an unattended match from a manual cleanup into a permanent deadlock, so the no-show reaper must exist before waiting does.

**Type consistency:** `NamedPlayer` gains `avatar: string | null` in Task 5 and is used with that shape in Tasks 6 and 9. `ServerReleaser.release(serverId: number): void` is used identically in Tasks 1, 3 and 4. `PendingMatches.add` is what `onNoServer` calls in Task 4. `ConnectInfo` in Task 8 matches the `connect` block defined in Task 5.

**Deliberately not here:** mid-match abandonment (pause, five minute timer, one day ban, forfeit). Its rules are recorded at the end of the spec and it gets its own spec after the first run.
