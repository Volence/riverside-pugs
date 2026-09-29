# Queue Side Games Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the PUG queue fills, opted-in queued players play unrecorded Rotoblin hardcore 2v2/3v3 on the server the match will use, and the pop turns that server into the match server.

**Architecture:** A `side_games` table holds a box the way `practice_leases` does (the box stays `idle`, and `NOT_LEASED_SQL` hides it from every claimer). A `SideGames` manager in `src/sideGames.ts` owns the in-memory game (lineup, sizes, rotation, grace timers) and is driven by matchmaker events and `PUGSIDE` log lines. Pure sizing and rotation rules live in `src/sideGameRules.ts`. A new SourceMod plugin `plugin/pug-sidegame.sp` does the team lock, the in-game `!ready` and vote, and the log lines. It is separate from `pug-match.sp` so it can never touch a ranked match.

**Tech Stack:** TypeScript (Node, Fastify, better-sqlite3, vitest), Preact (web), SourcePawn 1.12 (spcomp under wine), Rotoblin-AZMod configs.

**Spec:** `docs/superpowers/specs/2026-09-28-queue-side-games-design.md` (Task 1 amends it where the code base changed the design).

## Global Constraints

- Nothing about a side game is recorded or shown after the fact: no `matches` row, no SR, no replay, no dump, no stats, no Discord post, no site history. The only table is `side_games`, internal bookkeeping for which box is held.
- Rulesets are exactly `rotoblin_hardcore_2v2` and `rotoblin_hardcore_3v3`. Each ends in `sm_restartmap`, so an `exec` restarts the current map.
- Sizes: 4 or 5 opted-in players = 2v2, 6 or 7 = 3v3, fewer than 4 = no game. 8 = the queue has popped.
- Growing applies at the next map start. Shrinking applies at once (sub-in, or re-exec the smaller config, or close below 4).
- Reconnect grace 90 s. Close grace 3 min.
- Never blank `sv_password`. Closing a side game goes through `ServerReleaser.release(id, { restart: true, forceRestart: true })`, which ends in `exec secrets.cfg`.
- Default off: setting `sidegames_enabled` = `'0'`.
- No em dashes anywhere (code, comments, docs, commit messages).
- `plugin/*.smx` is gitignored; never commit it.
- Another session may be committing to master in this checkout. Before every commit: `git status --short`, and commit only this task's files (`git commit -- <paths>`). Better: execute this plan in a worktree (superpowers:using-git-worktrees).
- Do not deploy, restart or rcon any live box. Local tests only on `/home/volence/l4d1-ds` after checking `status` for humans.

## Review Focus

1. **A web restart mid side game:** the box must not stay held forever. `recover()` at boot must close every open `side_games` row with a forced restart (Task 6 test "recover closes open rows").
2. **A match needs a server while a side game holds the last one:** the waiting match must get it (Task 6 test "needServer closes the side game when no practice lease is open").
3. **Pop then failed ready check:** players who did not ready are dropped from the queue; the side game must resume only if 4+ opted-in players remain, else close (Task 7 tests "lobbyFailed resumes" and "lobbyFailed with 3 left closes").
4. **A stranger or a stale token sending PUGSIDE lines:** lines whose token is not the active game's are ignored, and `READY` from someone not in the popped lobby does nothing (Task 7 test "ignores a stale token").
5. **The voted campaign cannot run on the held box** (custom not installed, dlc4 missing): the match must not changelevel into a missing map; it closes the side game and claims normally (Task 8 test "falls back when the campaign cannot run there").

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db.ts` (modify) | `side_games` table; defaults for two settings |
| `src/serverPool.ts` (modify) | `NOT_LEASED_SQL` also excludes open side games |
| `src/settingsSchema.ts` (modify) | admin settings `sidegames_enabled`, `sidegames_min_players` |
| `src/balance.ts` (modify) | `balanceTeams` for 4, 6 or 8 players |
| `src/sideGameRules.ts` (create) | pure: `sizeFor`, `choosePlaying`, `pickSub`, `onLeave` |
| `src/matchmaker.ts` (modify) | opt-in set, persistence, `sideCandidates()`, `stateChanged` listener event |
| `src/logParse.ts` (modify) | `PUGSIDE` lines to a `side` LogEvent |
| `src/logListener.ts` (modify) | `side` admitted as token-less |
| `src/sideGames.ts` (create) | the manager: open, lineup, map events, leave, pop, resume, handover, preempt, recover, views |
| `src/orchestrator.ts` (modify) | `setupMatch` takes the held box first; `campaignRunsOn` extracted |
| `src/server.ts` (modify) | wiring: manager, log dispatch, onNoServer, boot recover, API merge |
| `src/routes/api.ts` (modify) | `POST /api/queue/side`; `sideGame` in `/api/state` |
| `web/src/api.ts`, `web/src/routes/Play.tsx` (modify) | toggle, status line, connect panel |
| `src/discord/presenter.ts`, `src/discord/sync.ts`, `src/discord/controller.ts` (modify) | `q:side` button, panel status line |
| `plugin/pug-sidegame.sp` (create), `plugin/build-sidegame.sh` (create) | the game-side half |
| `plugin/SIDEGAME-TESTING.md` (create) | local server runbook |

---

### Task 1: Amend the spec to match the code base

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-queue-side-games-design.md`

Three design points changed after reading the code. Record them so the spec stays the source of truth.

- [ ] **Step 1: Replace the server-status design**

In the "Server lifecycle" section, replace the line `New \`servers.status\` value: \`sidegame\`.` and the **Open**, **Close** and **Boot** bullets with:

```markdown
A side game holds its box through a row in a new `side_games` table, NOT a
`servers.status` value. This follows the `practice_leases` precedent in
`src/db.ts`: status has a CHECK constraint SQLite can only change by
rebuilding a table other tables reference, and `reconcileServers` frees every
`reserved` row with no live match at boot, which would run `sm_pug_abort` and
`exec secrets.cfg` into a running side game. The held box stays `idle`, and
`NOT_LEASED_SQL` (`src/serverPool.ts`) now also excludes boxes with an open
side game, so `claimIdle`, practice leases, the balance writer and the release
engine all leave it alone.

- **Open:** needs `sidegames_enabled = 1`, `sidegames_min_players` (default 4)
  opted-in players, no configuring match waiting for a server, and a
  claimable box. It takes the LOWEST id claimable box, the one `claimIdle`
  would give the match.
- **Close:** `ServerReleaser.release(id, { restart: true, forceRestart: true })`
  (srcds restarts in 1-4 s, which clears the 2v2/3v3 config; the releaser's
  cleaner ends with `exec secrets.cfg`), then the row is ended.
- **Boot:** every open `side_games` row is closed the same way. The queue and
  the opt-ins survive in `matchmaker_state`, so the game reopens by itself.
```

- [ ] **Step 2: Record the pop and growth details**

In "Player experience", replace item 5 with:

```markdown
5. At 8 in the queue: the side game stops at once. The plugin moves every
   player to spectator and shows a center-screen and chat notice: "QUEUE
   POPPED: type !ready". `!ready` is intercepted while popped (Rotoblin's
   ready-up has no use for it then) and goes to the site. The campaign vote
   then appears as an in-game menu. Both are also on the site and Discord
   exactly as today.
```

In "When someone leaves", after the numbered list, add:

```markdown
Growing and rotation are computed at map end and applied at the next map
start: the site pushes the new roster, and if the size changed it execs the
new config, whose `sm_restartmap` restarts the fresh map before anyone has
played it. An exec AT map end would restart the map just finished.
```

In "Server lifecycle", **Pop to match**, delete the sentences `Anyone connected who is not in the roster is kicked with "Queue match starting" (not spectated, unlike a normal match).` Every side-game player is in the popped lobby (the queue pops the moment it reaches 8), and pug-match already spectates anyone unrostered.

- [ ] **Step 3: Commit**

```bash
git status --short
git commit -m "spec: side games hold boxes via a side_games table; pop and growth details" -- docs/superpowers/specs/2026-09-28-queue-side-games-design.md
```

---

### Task 2: `side_games` table, lease exclusion, settings

**Files:**
- Modify: `src/db.ts` (SCHEMA string; `DEFAULT_SETTINGS` near line 807)
- Modify: `src/serverPool.ts:69` (`NOT_LEASED_SQL`, and `isLeased` doc)
- Modify: `src/settingsSchema.ts` (Queue group)
- Test: `tests/sideGamesTable.test.ts` (create)

**Interfaces:**
- Produces: table `side_games(id, server_id, token, password, created_at, ended_at, end_reason)`; `NOT_LEASED_SQL` excludes `side_games WHERE ended_at IS NULL`; `isSideHeld(db, serverId): boolean` in `src/serverPool.ts`; settings keys `sidegames_enabled` ('0'), `sidegames_min_players` ('4').

- [ ] **Step 1: Write the failing test**

```ts
// tests/sideGamesTable.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, claimIdle, isSideHeld } from '../src/serverPool.js';
import { getSetting } from '../src/settings.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

function add(name: string): number {
  return addServer(db, { name, host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
}

describe('side_games', () => {
  it('hides a held box from claimIdle while the row is open', () => {
    const a = add('a');
    const b = add('b');
    db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (?, 'tok', 'side_x')").run(a);
    expect(isSideHeld(db, a)).toBe(true);
    expect(claimIdle(db)?.id).toBe(b);
  });

  it('gives the box back once the row is ended', () => {
    const a = add('a');
    db.prepare("INSERT INTO side_games (server_id, token, password, ended_at) VALUES (?, 't', 'p', datetime('now'))").run(a);
    expect(isSideHeld(db, a)).toBe(false);
    expect(claimIdle(db)?.id).toBe(a);
  });

  it('seeds the settings off with a minimum of 4', () => {
    expect(getSetting(db, 'sidegames_enabled')).toBe('0');
    expect(getSetting(db, 'sidegames_min_players')).toBe('4');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/sideGamesTable.test.ts`
Expected: FAIL, `no such table: side_games` / `isSideHeld` is not exported.

- [ ] **Step 3: Implement**

In `src/db.ts`, add to the SCHEMA string right after the `servers` table:

```sql
-- A box held for a queue side game (2v2/3v3 while the queue fills). A row,
-- not a servers.status value, for the practice_leases reasons: see the
-- comment on that table. Internal bookkeeping only; nothing reads it for
-- display, and side games are never recorded anywhere else.
CREATE TABLE IF NOT EXISTS side_games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id),
  token       TEXT NOT NULL,
  password    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT,
  end_reason  TEXT
);
CREATE INDEX IF NOT EXISTS side_games_open ON side_games (server_id) WHERE ended_at IS NULL;
```

In `DEFAULT_SETTINGS` add:

```ts
  sidegames_enabled: '0',
  sidegames_min_players: '4',
```

In `src/serverPool.ts` replace the `NOT_LEASED_SQL` line with:

```ts
export const NOT_LEASED_SQL =
  'id NOT IN (SELECT server_id FROM practice_leases WHERE ended_at IS NULL)'
  + ' AND id NOT IN (SELECT server_id FROM side_games WHERE ended_at IS NULL)';

/** Whether an open queue side game holds this server (src/sideGames.ts). */
export function isSideHeld(db: DB, serverId: number): boolean {
  return db.prepare('SELECT 1 FROM side_games WHERE server_id = ? AND ended_at IS NULL').get(serverId) !== undefined;
}
```

and extend the doc comment above it with one sentence: `A box held for a queue side game is invisible the same way (side_games).`

In `src/settingsSchema.ts`, in the Queue group after `vote_seconds`:

```ts
  { key: 'sidegames_enabled', group: 'Queue', label: 'Side games', help: 'Opted-in queued players play unrecorded 2v2/3v3 on the match server while the queue fills.', type: { kind: 'bool' } },
  { key: 'sidegames_min_players', group: 'Queue', label: 'Side game minimum', help: 'Opted-in players needed to open a side game.', type: { kind: 'int', min: 4, max: 7 } },
```

- [ ] **Step 4: Run the test and the neighbours**

Run: `npx vitest run tests/sideGamesTable.test.ts tests/serverRelease.test.ts tests/adminSettings.test.ts`
Expected: PASS (fix `adminSettings` snapshot counts if it enumerates the schema).

- [ ] **Step 5: Commit**

```bash
git status --short
git commit -m "side games: side_games table holds a box like a practice lease; settings" -- src/db.ts src/serverPool.ts src/settingsSchema.ts tests/sideGamesTable.test.ts
```

---

### Task 3: `balanceTeams` for 4, 6 or 8 players

**Files:**
- Modify: `src/balance.ts`
- Test: `tests/balance.test.ts`

**Interfaces:**
- Produces: `balanceTeams(players: RatedPlayer[]): BalanceResult` accepting length 4, 6 or 8; throws otherwise. The 8-player result is identical to today's.

- [ ] **Step 1: Add failing tests** (append to the `describe` in `tests/balance.test.ts`)

```ts
  it('splits 4 into 2v2 and 6 into 3v3', () => {
    for (const n of [4, 6]) {
      const players = Array.from({ length: n }, (_, i) => p(`p${i}`, 20 + i));
      const { teamA, teamB } = balanceTeams(players);
      expect(teamA).toHaveLength(n / 2);
      expect(teamB).toHaveLength(n / 2);
      expect([...teamA, ...teamB].sort()).toEqual(players.map((x) => x.steamid).sort());
    }
  });

  it('separates the two strongest in a 2v2', () => {
    const { teamA, teamB } = balanceTeams([p('s1', 40), p('s2', 40), p('a', 20), p('b', 20)]);
    expect(teamA.includes('s1')).not.toBe(teamA.includes('s2'));
    expect(teamB).toHaveLength(2);
  });

  it('refuses sizes other than 4, 6 and 8', () => {
    expect(() => balanceTeams([p('a', 25), p('b', 25), p('c', 25)])).toThrow(/4, 6 or 8/);
    expect(() => balanceTeams(Array.from({ length: 10 }, (_, i) => p(`p${i}`, 25)))).toThrow(/4, 6 or 8/);
  });
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/balance.test.ts`
Expected: FAIL, "needs exactly 8 players".

- [ ] **Step 3: Implement** (replace the body of `src/balance.ts` from `export function balanceTeams` down)

```ts
/** Every way to choose `k` of the indices 1..n-1 (player 0 is always on team A). */
function combos(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick = (start: number, acc: number[]) => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < n; i++) { acc.push(i); pick(i + 1, acc); acc.pop(); }
  };
  pick(1, []);
  return out;
}

export function balanceTeams(players: RatedPlayer[]): BalanceResult {
  const n = players.length;
  if (n !== 4 && n !== 6 && n !== 8) throw new Error(`balanceTeams needs 4, 6 or 8 players, got ${n}`);
  const ratings = players.map((p) => rating({ mu: p.mu, sigma: p.sigma }));
  const all = Array.from({ length: n }, (_, i) => i);

  let best: BalanceResult | null = null;
  // player 0 always on team A; choose the rest of A from indices 1..n-1, in
  // the same lexicographic order the old fixed 8-player loops used, so the
  // 8-player answer (ties included) is unchanged.
  for (const rest of combos(n, n / 2 - 1)) {
    const aIdx = [0, ...rest];
    const bIdx = all.filter((x) => !aIdx.includes(x));
    const [pA] = predictWin([aIdx.map((x) => ratings[x]), bIdx.map((x) => ratings[x])]);
    if (!best || Math.abs(pA - 0.5) < Math.abs(best.pWinA - 0.5)) {
      best = {
        teamA: aIdx.map((x) => players[x].steamid),
        teamB: bIdx.map((x) => players[x].steamid),
        pWinA: pA,
      };
    }
  }
  return best!;
}
```

- [ ] **Step 4: Run all balance and matchmaker tests**

Run: `npx vitest run tests/balance.test.ts tests/matchmaker.test.ts tests/matchmakerEvents.test.ts`
Expected: PASS (the old tests pin the 8-player path).

- [ ] **Step 5: Commit**

```bash
git status --short
git commit -m "balanceTeams: 2v2 and 3v3 as well as 4v4, 8-player path unchanged" -- src/balance.ts tests/balance.test.ts
```

---

### Task 4: Pure sizing and rotation rules

**Files:**
- Create: `src/sideGameRules.ts`
- Test: `tests/sideGameRules.test.ts`

**Interfaces:**
- Produces:
  - `type SideSize = 2 | 3`
  - `sizeFor(n: number): SideSize | null`
  - `interface SideCandidate { steamid: string; connected: boolean; queuePos: number; satOut: number; playedStreak: number }` where `satOut` = consecutive maps sat out, `playedStreak` = consecutive maps played.
  - `choosePlaying(cands: SideCandidate[], size: SideSize): { playing: string[]; bench: string[] }`
  - `pickSub(bench: SideCandidate[]): string | null`
  - `type LeaveAction = { kind: 'sub'; steamid: string } | { kind: 'rebuild'; size: SideSize } | { kind: 'close' }`
  - `onLeave(remaining: SideCandidate[], bench: SideCandidate[]): LeaveAction` where `remaining` = every participant still in the game (playing and bench) after the leaver is gone.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sideGameRules.test.ts
import { describe, it, expect } from 'vitest';
import { sizeFor, choosePlaying, pickSub, onLeave, type SideCandidate } from '../src/sideGameRules.js';

const c = (steamid: string, o: Partial<SideCandidate> = {}): SideCandidate =>
  ({ steamid, connected: true, queuePos: 0, satOut: 0, playedStreak: 0, ...o });

describe('sizeFor', () => {
  it('maps counts to sizes', () => {
    expect([0, 3, 4, 5, 6, 7].map(sizeFor)).toEqual([null, null, 2, 2, 3, 3]);
    expect(sizeFor(8)).toBeNull();
  });
});

describe('choosePlaying', () => {
  it('benches the one who has played longest when nobody has sat out', () => {
    const r = choosePlaying([
      c('a', { queuePos: 0, playedStreak: 3 }), c('b', { queuePos: 1, playedStreak: 1 }),
      c('c', { queuePos: 2, playedStreak: 1 }), c('d', { queuePos: 3, playedStreak: 1 }),
      c('e', { queuePos: 4, playedStreak: 1 }),
    ], 2);
    expect(r.bench).toEqual(['a']);
    expect(r.playing.sort()).toEqual(['b', 'c', 'd', 'e']);
  });

  it('brings in the longest sitter first', () => {
    const r = choosePlaying([
      c('a', { satOut: 1 }), c('b', { playedStreak: 2, queuePos: 1 }), c('c', { playedStreak: 1, queuePos: 2 }),
      c('d', { playedStreak: 1, queuePos: 3 }), c('e', { playedStreak: 1, queuePos: 4 }),
    ], 2);
    expect(r.playing).toContain('a');
    expect(r.bench).toEqual(['b']);
  });

  it('benches a player who is not connected before anyone who is', () => {
    const r = choosePlaying([c('a', { connected: false, satOut: 5 }), c('b'), c('c'), c('d'), c('e')], 2);
    expect(r.bench).toEqual(['a']);
  });

  it('breaks ties by queue position, earlier plays', () => {
    const r = choosePlaying([c('x', { queuePos: 4 }), c('a', { queuePos: 0 }), c('b', { queuePos: 1 }), c('c', { queuePos: 2 }), c('d', { queuePos: 3 })], 2);
    expect(r.bench).toEqual(['x']);
  });
});

describe('pickSub', () => {
  it('takes the connected longest sitter, or nobody', () => {
    expect(pickSub([c('a', { satOut: 1 }), c('b', { satOut: 2 })])).toBe('b');
    expect(pickSub([c('a', { connected: false, satOut: 9 })])).toBeNull();
    expect(pickSub([])).toBeNull();
  });
});

describe('onLeave', () => {
  it('subs in from the bench when a connected sitter exists', () => {
    const bench = [c('s', { satOut: 1 })];
    expect(onLeave([c('a'), c('b'), c('c'), c('s')], bench)).toEqual({ kind: 'sub', steamid: 's' });
  });
  it('rebuilds smaller at 5 with nobody sitting (6 to 5)', () => {
    expect(onLeave([c('a'), c('b'), c('c'), c('d'), c('e')], [])).toEqual({ kind: 'rebuild', size: 2 });
  });
  it('closes below 4 (a 2v2 loses one)', () => {
    expect(onLeave([c('a'), c('b'), c('c')], [])).toEqual({ kind: 'close' });
  });
  it('rebuilds at the same size when the only sitter is disconnected', () => {
    const bench = [c('s', { connected: false })];
    expect(onLeave([c('a'), c('b'), c('c'), c('s')], bench)).toEqual({ kind: 'rebuild', size: 2 });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/sideGameRules.test.ts`
Expected: FAIL, cannot find module `../src/sideGameRules.js`.

- [ ] **Step 3: Implement**

```ts
// src/sideGameRules.ts
/**
 * The rules of a queue side game, with no I/O: how many play, who sits out,
 * who subs in. src/sideGames.ts applies them. See the spec,
 * docs/superpowers/specs/2026-09-28-queue-side-games-design.md.
 */
export type SideSize = 2 | 3;

/** 4-5 players play 2v2, 6-7 play 3v3. Under 4 is no game; 8 means the queue popped. */
export function sizeFor(n: number): SideSize | null {
  if (n === 4 || n === 5) return 2;
  if (n === 6 || n === 7) return 3;
  return null;
}

export interface SideCandidate {
  steamid: string;
  connected: boolean;
  /** Position in the PUG queue, 0 = front. */
  queuePos: number;
  /** Consecutive maps sat out. */
  satOut: number;
  /** Consecutive maps played. */
  playedStreak: number;
}

/** Who plays first: connected, then longest sitter, then shortest streak,
 *  then earliest in the queue. */
function playOrder(a: SideCandidate, b: SideCandidate): number {
  if (a.connected !== b.connected) return a.connected ? -1 : 1;
  if (a.satOut !== b.satOut) return b.satOut - a.satOut;
  if (a.playedStreak !== b.playedStreak) return a.playedStreak - b.playedStreak;
  return a.queuePos - b.queuePos;
}

export function choosePlaying(cands: SideCandidate[], size: SideSize): { playing: string[]; bench: string[] } {
  const sorted = [...cands].sort(playOrder);
  return {
    playing: sorted.slice(0, size * 2).map((x) => x.steamid),
    bench: sorted.slice(size * 2).map((x) => x.steamid),
  };
}

/** The connected player who has sat out longest, or null. */
export function pickSub(bench: SideCandidate[]): string | null {
  const ready = bench.filter((b) => b.connected).sort(playOrder);
  return ready[0]?.steamid ?? null;
}

export type LeaveAction =
  | { kind: 'sub'; steamid: string }
  | { kind: 'rebuild'; size: SideSize }
  | { kind: 'close' };

/**
 * A player has gone for good. `remaining` is everyone still in the game
 * (playing and sitting out); `bench` is the sitting-out part of it.
 * Shrinking is handled at once: a sub keeps the size, otherwise the game is
 * rebuilt at the size the remaining count supports, or closed under 4.
 */
export function onLeave(remaining: SideCandidate[], bench: SideCandidate[]): LeaveAction {
  const sub = pickSub(bench);
  if (sub) return { kind: 'sub', steamid: sub };
  const size = sizeFor(remaining.length);
  return size ? { kind: 'rebuild', size } : { kind: 'close' };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/sideGameRules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status --short
git commit -m "side games: pure sizing, rotation and leave rules" -- src/sideGameRules.ts tests/sideGameRules.test.ts
```

---

### Task 5: Matchmaker opt-in, persistence, change event

**Files:**
- Modify: `src/matchmaker.ts`
- Test: `tests/matchmakerSideOptIn.test.ts` (create; copy the `FakeScheduler`, `IDS`, and `beforeEach` from `tests/matchmaker.test.ts:1-50`)

**Interfaces:**
- Produces on `Matchmaker`:
  - `setSideOptIn(steamid: string, on: boolean): { ok: boolean; error?: string }` (must be queued)
  - `sideCandidates(): string[]` (queued AND opted in, queue order)
  - `isSideOptedIn(steamid: string): boolean`
  - `queuePosition(steamid: string): number` (-1 when not queued)
  - `lobbyOf(steamid: string): LobbySnapshot | null`
  - `MatchmakerListener.stateChanged?(): void`, emitted at the end of every `changed()`
  - `StateSnapshot.queue.sideOptIn: boolean`
- Opt-ins are kept through a pop (lobby members keep theirs so a failed ready check resumes the game), dropped on `leave`, `remove`, and for the players of a completed lobby.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/matchmakerSideOptIn.test.ts  (setup block copied from tests/matchmaker.test.ts:1-50)
describe('side game opt-in', () => {
  it('only a queued player may opt in', () => {
    expect(mm.setSideOptIn(IDS[0], true).ok).toBe(false);
    mm.join(IDS[0]);
    expect(mm.setSideOptIn(IDS[0], true)).toEqual({ ok: true });
    expect(mm.sideCandidates()).toEqual([IDS[0]]);
    expect(mm.stateFor(IDS[0]).queue.sideOptIn).toBe(true);
  });

  it('keeps queue order and drops a player who leaves', () => {
    for (const id of IDS.slice(0, 3)) { mm.join(id); mm.setSideOptIn(id, true); }
    mm.leave(IDS[1]);
    expect(mm.sideCandidates()).toEqual([IDS[0], IDS[2]]);
    mm.join(IDS[1]);
    expect(mm.isSideOptedIn(IDS[1])).toBe(false);
  });

  it('survives a restore', () => {
    mm.join(IDS[0]); mm.setSideOptIn(IDS[0], true);
    const mm2 = new Matchmaker(db, {
      broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} }, scheduler: sched, rng: () => 0,
    });
    mm2.restore();
    expect(mm2.sideCandidates()).toEqual([IDS[0]]);
  });

  it('keeps opt-ins through a pop and requeues them after a failed ready check', () => {
    for (const id of IDS) { mm.join(id); mm.setSideOptIn(id, true); }
    expect(mm.sideCandidates()).toEqual([]);              // all 8 are in the lobby now
    expect(mm.lobbyOf(IDS[0])?.phase).toBe('ready_check');
    for (const id of IDS.slice(0, 5)) mm.ready(id);
    sched.fireAll();                                       // ready check times out
    expect(mm.sideCandidates()).toEqual(IDS.slice(0, 5));
  });

  it('drops the opt-ins of a completed lobby', () => {
    for (const id of IDS) { mm.join(id); mm.setSideOptIn(id, true); }
    for (const id of IDS) mm.ready(id);
    sched.fireAll();                                       // vote ends
    expect(IDS.some((id) => mm.isSideOptedIn(id))).toBe(false);
  });

  it('tells listeners on every change', () => {
    let n = 0;
    mm.on({ stateChanged: () => { n++; } });
    mm.join(IDS[0]);
    expect(n).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/matchmakerSideOptIn.test.ts`
Expected: FAIL, `setSideOptIn is not a function`.

- [ ] **Step 3: Implement** in `src/matchmaker.ts`

Add to `MatchmakerListener`:

```ts
  /** Anything changed (queue, lobbies, opt-ins). Fired after the state is saved. */
  stateChanged?(): void;
```

Add to `StateSnapshot.queue` type: `sideOptIn: boolean;`

Add a field to the class:

```ts
  /** Queued players who asked for side games (2v2/3v3 while waiting). Kept
   *  through a pop so a failed ready check resumes the game; see sideGames.ts. */
  private sideOptIn = new Set<string>();
```

In `changed()`, add `sideOptIn: [...this.sideOptIn],` to `state`, and after `this.deps.broadcast('refresh');` add `this.emit('stateChanged');`.

In `restore()`, widen the parsed type to `{ queue: string[]; lobbies: PersistedLobby[]; sideOptIn?: string[] }` and before `this.changed()` add:

```ts
    for (const id of state.sideOptIn ?? []) {
      if (this.queue.has(id) || this.playerLobby.has(id)) this.sideOptIn.add(id);
    }
```

In `leave()` and `remove()`, add `this.sideOptIn.delete(steamid);` before `this.changed()` (in `remove`, at the top after the early return).

In `onLobbyComplete`, after `this.dissolveLobby(id);` add `for (const p of result.players) this.sideOptIn.delete(p);`.

In `onLobbyFail`, players in `notReady` are dropped from the queue; add `for (const p of notReady) this.sideOptIn.delete(p);`.

New methods (place after `vote()`):

```ts
  setSideOptIn(steamid: string, on: boolean): { ok: boolean; error?: string } {
    if (!this.queue.has(steamid)) return { ok: false, error: 'join the queue first' };
    if (on) this.sideOptIn.add(steamid); else this.sideOptIn.delete(steamid);
    this.changed();
    return { ok: true };
  }

  isSideOptedIn(steamid: string): boolean {
    return this.sideOptIn.has(steamid);
  }

  /** Queued players who opted in, in queue order. Lobby members are not
   *  queued, so this is empty for them while a pop is running. */
  sideCandidates(): string[] {
    return this.queue.list().filter((id) => this.sideOptIn.has(id));
  }

  queuePosition(steamid: string): number {
    return this.queue.list().indexOf(steamid);
  }

  lobbyOf(steamid: string): LobbySnapshot | null {
    return this.lobbyFor(steamid)?.snapshot() ?? null;
  }
```

In `stateFor`, the queue object gains `sideOptIn: this.sideOptIn.has(steamid),`.

Also update `web/src/api.ts` `StateSnapshot.queue` type with `sideOptIn?: boolean;` so the web typecheck keeps passing.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/matchmakerSideOptIn.test.ts tests/matchmaker.test.ts tests/matchmakerPersist.test.ts tests/matchmakerEvents.test.ts && npm run typecheck`
Expected: PASS. If the ready-fail test's `sched.fireAll()` also fires other timers, match the pattern used by the existing ready-timeout test in `tests/matchmaker.test.ts`.

- [ ] **Step 5: Commit**

```bash
git status --short
git commit -m "matchmaker: side game opt-in, persisted, kept through a pop" -- src/matchmaker.ts web/src/api.ts tests/matchmakerSideOptIn.test.ts
```

---

### Task 6: `PUGSIDE` log lines

**Files:**
- Modify: `src/logParse.ts` (LogEvent union near line 240; a branch next to `PUGCALL ` near line 637)
- Modify: `src/logListener.ts:78-81` (token-less allowlist)
- Test: `tests/sideGameParse.test.ts` (create)

**Interfaces:**
- Line format (plugin writes, signed by `PugLog`): `PUGSIDE event=<join|part|ready|vote|mapstart|mapend> token=<hex> [steamid=<id64>] [map=<map>] [campaign=<slug>]`
- Produces LogEvent member: `{ kind: 'side'; event: SideLogEvent; token: string; steamid: string | null; map: string | null; campaign: string | null }` and `export type SideLogEvent = 'join' | 'part' | 'ready' | 'vote' | 'mapstart' | 'mapend'`.
- Token-less for the listener (admitted from game server addresses only); `SideGames` checks the token itself.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sideGameParse.test.ts
import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const P = '76561199048276493';
const parse = (line: string) => parseLogDatagram(Buffer.from(line, 'utf8'));

describe('PUGSIDE parsing', () => {
  it('reads a ready line', () => {
    expect(parse(`PUGSIDE event=ready token=ab12cd34 steamid=${P}`)).toEqual({
      kind: 'side', event: 'ready', token: 'ab12cd34', steamid: P, map: null, campaign: null,
    });
  });
  it('reads a vote with its campaign and a map end with its map', () => {
    expect(parse(`PUGSIDE event=vote token=ab12cd34 steamid=${P} campaign=no_mercy`)).toMatchObject({ campaign: 'no_mercy' });
    expect(parse('PUGSIDE event=mapend token=ab12cd34 map=l4d_vs_hospital01_apartment'))
      .toMatchObject({ event: 'mapend', steamid: null, map: 'l4d_vs_hospital01_apartment' });
  });
  it('drops unknown events, bad tokens, bad maps and bad campaigns', () => {
    expect(parse('PUGSIDE event=explode token=ab12cd34')).toBeNull();
    expect(parse('PUGSIDE event=mapend token=zz;quit map=x')).toBeNull();
    expect(parse('PUGSIDE event=mapend token=ab12cd34 map=bad*map')).toMatchObject({ map: null });
    expect(parse(`PUGSIDE event=vote token=ab12cd34 steamid=${P} campaign=Bad;Slug`)).toMatchObject({ campaign: null });
  });
  it('drops a player event without a valid steamid', () => {
    expect(parse('PUGSIDE event=ready token=ab12cd34 steamid=nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/sideGameParse.test.ts`
Expected: FAIL (returns null for every line).

- [ ] **Step 3: Implement**

In `src/logParse.ts`, add the type near the other exported types:

```ts
export type SideLogEvent = 'join' | 'part' | 'ready' | 'vote' | 'mapstart' | 'mapend';
const SIDE_EVENTS: readonly SideLogEvent[] = ['join', 'part', 'ready', 'vote', 'mapstart', 'mapend'];
const SIDE_PLAYER_EVENTS: readonly SideLogEvent[] = ['join', 'part', 'ready', 'vote'];
```

Add to the `LogEvent` union:

```ts
  | { kind: 'side'; event: SideLogEvent; token: string; steamid: string | null; map: string | null; campaign: string | null }
```

Add the branch right before the `PUGCALL ` branch (inside `parseSourcePinned`, same `body` variable):

```ts
  // Queue side games (plugin/pug-sidegame.sp). Token-less as far as the
  // listener is concerned: src/sideGames.ts compares the token to the game
  // it is running and drops anything else.
  if (body.startsWith('PUGSIDE ')) {
    const head = kv(body.split(/\s+/).slice(1));
    const event = head.event as SideLogEvent;
    if (!SIDE_EVENTS.includes(event)) return null;
    const token = head.token ?? '';
    if (!/^[0-9a-f]{8,64}$/.test(token)) return null;
    let steamid: string | null = null;
    if (SIDE_PLAYER_EVENTS.includes(event)) {
      steamid = steamId64Of(head.steamid ?? '');
      if (!steamid) return null;
    }
    const map = head.map !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(head.map) ? head.map : null;
    const campaign = head.campaign !== undefined && /^[a-z0-9_]{1,64}$/.test(head.campaign) ? head.campaign : null;
    return { kind: 'side', event, token, steamid, map, campaign };
  }
```

(If `steamId64Of` or `kv` are named differently in this file, use the helpers the `PUGCALL ` branch uses; they are in scope there.)

In `src/logListener.ts`, add `|| ev.kind === 'side'` to the token-less allowlist condition at lines 78-81.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/sideGameParse.test.ts tests/logParse.test.ts tests/modCallParse.test.ts && npm run typecheck`
Expected: PASS. A `switch (ev.kind)` elsewhere that must be exhaustive will surface in typecheck; add a `case 'side': break;` there if so.

- [ ] **Step 5: Commit**

```bash
git status --short
git commit -m "logParse: PUGSIDE lines for queue side games (token-less, checked by the manager)" -- src/logParse.ts src/logListener.ts tests/sideGameParse.test.ts
```

---

### Task 7: The `SideGames` manager

**Files:**
- Create: `src/sideGames.ts`
- Test: `tests/sideGames.test.ts`

**Interfaces:**
- Consumes: `sizeFor`, `choosePlaying`, `onLeave`, `SideCandidate`, `SideSize` (Task 4); `balanceTeams` (Task 3); `Matchmaker` methods from Task 5; `NOT_LEASED_SQL`, `getServer`, `type ServerRow` (`src/serverPool.ts`); `openLeases`, `matchesWaiting`, `type LeaseRcon` (`src/practiceLeases.ts`); `serverPasswordFor`, `newToken` (`src/matchToken.ts`; if `newToken` lives in orchestrator.ts, import it from there); `getRatings` (`src/players.js`); `campaignRegistry`, `campaignDisplayName` (`src/campaignRegistry.ts`); `campaignForMap` (`src/campaigns.ts`); `getSetting` (`src/settings.ts`); `SideLogEvent` (Task 6).
- Produces:

```ts
export interface SideQueue {
  sideCandidates(): string[];
  queuePosition(steamid: string): number;
  lobbyOf(steamid: string): LobbySnapshot | null;
  lobbies(): { id: string; snapshot: LobbySnapshot }[];
  ready(steamid: string): { ok: boolean; error?: string };
  vote(steamid: string, campaign: string): boolean;
  on(l: MatchmakerListener): void;
}
export interface SideGameDeps {
  db: DB;
  queue: SideQueue;
  rcon: LeaseRcon;                                  // (server, commands) => replies
  release: (serverId: number) => Promise<boolean>;  // forced-restart release
  broadcast: () => void;                            // hub 'refresh'
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  rng?: () => number;
}
export interface SideGameView {
  phase: 'running' | 'popped' | 'closing';
  size: SideSize | null;
  players: number;
  youIn: boolean;
  connect: { host: string; port: number; password: string } | null;
}
export class SideGames {
  constructor(deps: SideGameDeps);
  sync(): void;                                   // re-evaluate from the queue
  onLog(ev: { event: SideLogEvent; token: string; steamid: string | null; map: string | null; campaign: string | null }): void;
  takeForMatch(campaign: string, runsOn: (server: ServerRow) => boolean): { server: ServerRow; firstCommands: string[] } | null;
  needServer(): void;                             // a match waits with no free box
  recover(): void;                                // boot: close every open row
  view(steamid: string): SideGameView | null;
  publicView(): { size: SideSize | null; players: number } | null;
  settled(): Promise<void>;                       // tests: wait for queued rcon
}
export const RECONNECT_GRACE_MS = 90_000;
export const CLOSE_GRACE_MS = 180_000;
```

Plugin command contract (Task 10 implements it; every command answers `PUGOK ...` or `PUGERR ...`):
- `sm_side_start <token>`: arm the plugin for this game, save and zero `sm_pug_auto_track`.
- `sm_side_roster <id64>:<A|B|S> ...`: replace the roster in one command.
- `sm_side_popped`: everyone to spectator, team lock off, `!ready` intercepted, notices on.
- `sm_side_resume`: back from popped (team lock on, interception off).
- `sm_side_vote "<slug>=<Display Name>" ...`: show the vote menu to every rostered player.
- `sm_side_notice <id64> "<text>"`: chat line to one player.
- `sm_side_stop <token>`: disarm, restore `sm_pug_auto_track`, clear the roster.

State the manager keeps (in memory; the DB row only marks the box held):

```ts
interface Seat { steamid: string; team: 'A' | 'B' | 'S' }
interface Active {
  rowId: number;
  server: ServerRow;
  token: string;
  password: string;
  phase: 'running' | 'popped' | 'closing';
  size: SideSize;
  seats: Seat[];                  // current roster as pushed
  pendingSize: SideSize | null;   // grow at next mapstart
  pendingSeats: Seat[] | null;    // rotation at next mapstart
  connected: Set<string>;
  away: Map<string, { cancel(): void }>;  // reconnect grace timers
  gone: Set<string>;              // grace ran out; sit out until they rejoin
  satOut: Map<string, number>;
  played: Map<string, number>;
  map: string | null;
  voteSentFor: string | null;     // lobby id the vote menu went out for
  closeTimer: { cancel(): void } | null;
}
```

Behaviour, each bullet one test in Step 1:

1. **open**: `sidegames_enabled='1'`, 4 candidates, one idle server, no waiting match: inserts a `side_games` row for the LOWEST id claimable box and sends, in order, `sv_password "<password>"`, `exec rotoblin_hardcore_2v2`, `sm_side_start <token>`, `sm_side_roster ...` (4 seats, 2 A, 2 B), `changelevel <first map>`. First map is `firstMapOf` of a random stock (non-custom, non-dlc4) campaign from `campaignRegistry`.
2. **no open** when disabled, when fewer than `sidegames_min_players`, when `matchesWaiting(db) > 0`, or when no box is claimable.
3. **join mid-map**: a 5th opted-in player gets seat `S` pushed at once (`sm_side_roster` with 5 entries); the size stays 2.
4. **grow at mapstart**: 6 candidates after a `mapend`; on `mapstart` it sends `exec rotoblin_hardcore_3v3` then `sm_side_roster` with 3 A, 3 B.
5. **rotation**: 5 candidates, `mapend` then `mapstart`: the sitter is seated, and the player with the longest streak sits (`S`). No exec (same size).
6. **finale**: `mapend` with the map that is the last of its campaign's `maps` sends `changelevel` to the first map of a new random stock campaign.
7. **disconnect grace**: `part` starts a 90 s timer; `join` within it cancels it and nothing is re-pushed. When it fires, the player is treated as gone (rule below).
8. **leave with a sitter**: a seated player leaves the queue; the connected sitter takes the same team letter, one `sm_side_roster` push, no exec.
9. **leave, 6 to 5, no sitter**: rebalanced 2v2 plus one `S`, `exec rotoblin_hardcore_2v2` (its `sm_restartmap` restarts the map) then the roster.
10. **leave, 4 to 3**: the game stops at once (every seat pushed as `S`, a `say` line), phase `closing`, the box still held. After `CLOSE_GRACE_MS` it closes: `sm_side_stop`, then `release(serverId)`, and the row gets `end_reason='too_few'`.
11. **pop**: `lobbyStarted` containing participants sends `sm_side_popped`; phase `popped`; queue changes are ignored while popped.
12. **vote menu**: when the lobby reaches `map_vote`, sends one `sm_side_vote` with `"<slug>=<display>"` per option, once per lobby id.
13. **in-game ready**: `ready` event with the right token calls `queue.ready(steamid)`; if it fails, sends `sm_side_notice <id64> "<error>"`. **ignores a stale token**: a wrong token does nothing.
14. **in-game vote**: `vote` event calls `queue.vote(steamid, campaign)`.
15. **lobbyFailed resumes**: 4 or more candidates remain: `sm_side_resume`, `exec` of the right config, rebalanced roster. **lobbyFailed with 3 left closes**: `sm_side_resume` then the wind-down of behaviour 10.
16. **takeForMatch**: returns the held box with `status` set to `reserved` in the DB, the row ended with `end_reason='match'`, and `firstCommands` = `['sm_side_stop <token>']`; returns null when nothing is held. **falls back when the campaign cannot run there**: when `runsOn(server)` is false it closes the game (release) and returns null.
17. **needServer closes the side game when no practice lease is open**, and does nothing while a practice lease is open (the practice preemption goes first).
18. **recover closes open rows**: two open rows at construction time, `recover()` calls `release` for both and ends them with `end_reason='boot'`.
19. **close grace reopens**: while `closing`, a 4th opt-in within `CLOSE_GRACE_MS` puts the game back to `running` on the same box (exec + roster, no new row, no release); `needServer` during `closing` closes at once.
20. **views**: `view(id)` returns `connect` only for a participant; `publicView()` returns `{ size, players }` for anyone; both null with no game.

- [ ] **Step 1: Write the failing tests**

Build a fake `SideQueue` in the test (an object with an array of candidates, a map of lobbies, and spies for `ready`/`vote`, plus a stored listener so the test can call `listener.lobbyStarted(...)`, `lobbyFailed`, `stateChanged`). Fake `rcon` records `commands` per call and returns `['PUGOK']` per command. Fake `release` records ids and resolves true. Fake `setTimer` stores callbacks with their delay so the test fires them. Use `openDb(':memory:')`, `addServer` twice, `setSetting(db, 'sidegames_enabled', '1')`, `upsertPlayer` for the steamids (ratings come from `getRatings`), and `setMissionsDirs`/registry defaults as `tests/campaignRegistry.test.ts` does so stock campaigns have `maps`.

Write one `it` per numbered behaviour above, named exactly as the bold names where given. Example for behaviours 1 and 16:

```ts
it('opens on the lowest id box with a 2v2 at 4 candidates', async () => {
  q.candidates = ids(4);
  sg.sync();
  await sg.settled();
  const cmds = rconLog.flat();
  expect(cmds[0]).toMatch(/^sv_password "side_[0-9a-f]{8}"$/);
  expect(cmds[1]).toBe('exec rotoblin_hardcore_2v2');
  expect(cmds[2]).toMatch(/^sm_side_start [0-9a-f]+$/);
  expect(cmds[3].split(' ').slice(1).filter((s) => s.endsWith(':A'))).toHaveLength(2);
  expect(cmds[4]).toMatch(/^changelevel l4d_vs_/);
  expect(db.prepare('SELECT server_id FROM side_games WHERE ended_at IS NULL').get()).toEqual({ server_id: s1 });
});

it('takeForMatch hands the held box to the match', async () => {
  q.candidates = ids(4); sg.sync(); await sg.settled();
  const took = sg.takeForMatch('no_mercy', () => true)!;
  expect(took.server.id).toBe(s1);
  expect(took.firstCommands[0]).toMatch(/^sm_side_stop /);
  expect(db.prepare('SELECT status FROM servers WHERE id = ?').get(s1)).toEqual({ status: 'reserved' });
  expect(db.prepare('SELECT end_reason FROM side_games').get()).toEqual({ end_reason: 'match' });
  expect(sg.view(q.candidates[0])).toBeNull();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/sideGames.test.ts`
Expected: FAIL, cannot find module `../src/sideGames.js`.

- [ ] **Step 3: Implement `src/sideGames.ts`**

Structure (fill every method; this is the full skeleton with the non-obvious bodies written out):

```ts
import type { DB } from './db.js';
import { NOT_LEASED_SQL, getServer, type ServerRow } from './serverPool.js';
import { openLeases, matchesWaiting, type LeaseRcon } from './practiceLeases.js';
import { newToken } from './matchToken.js';
import { getRatings } from './players.js';
import { balanceTeams } from './balance.js';
import { campaignRegistry, campaignDisplayName } from './campaignRegistry.js';
import { campaignForMap } from './campaigns.js';
import { getSetting } from './settings.js';
import { sizeFor, choosePlaying, onLeave, type SideCandidate, type SideSize } from './sideGameRules.js';
import type { LobbySnapshot } from './lobby.js';
import type { MatchmakerListener } from './matchmaker.js';
import type { SideLogEvent } from './logParse.js';

export const RECONNECT_GRACE_MS = 90_000;
export const CLOSE_GRACE_MS = 180_000;
const CONFIG: Record<SideSize, string> = { 2: 'rotoblin_hardcore_2v2', 3: 'rotoblin_hardcore_3v3' };

// ... interfaces from the Interfaces block above ...

export class SideGames {
  private active: Active | null = null;
  private work: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<SideGameDeps['setTimer']>;
  private readonly rng: () => number;

  constructor(private readonly deps: SideGameDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; });
    this.rng = deps.rng ?? Math.random;
    deps.queue.on({
      // One listener for the life of the manager. The vote menu rides on the
      // same event: the lobby moving to map_vote is a state change.
      stateChanged: () => { this.sync(); this.maybeSendVote(); },
      lobbyStarted: (_id, players) => this.onPop(players),
      lobbyFailed: () => this.onLobbyFailed(),
    });
  }

  /** Rcon in order, one batch at a time, never throwing into the caller. */
  private send(server: ServerRow, commands: string[]): void {
    this.work = this.work.then(() => this.deps.rcon(server, commands)).catch((err) => {
      console.warn(`[sidegame] rcon to ${server.name} failed:`, err instanceof Error ? err.message : err);
    });
  }

  settled(): Promise<void> { return this.work.then(() => {}); }

  private enabled(): boolean { return getSetting(this.deps.db, 'sidegames_enabled') === '1'; }
  private minPlayers(): number { return Math.max(4, Number(getSetting(this.deps.db, 'sidegames_min_players') ?? 4) || 4); }

  sync(): void {
    const a = this.active;
    // A pop takes the eight out of the queue; they are not leavers.
    if (a?.phase === 'popped') return;
    const cands = this.deps.queue.sideCandidates();
    if (!a) { this.maybeOpen(cands); return; }
    if (a.phase === 'closing') {
      // Held for CLOSE_GRACE_MS after dropping under 4: back to the minimum
      // reopens on the same box, no restart.
      if (cands.length >= this.minPlayers()) this.restart(a, cands);
      return;
    }
    const inGame = new Set(a.seats.map((s) => s.steamid));
    for (const s of [...inGame]) if (!cands.includes(s)) this.gone(s, 'left');
    if (!this.active) return;
    const added = cands.filter((c) => !inGame.has(c));
    if (added.length) {
      a.seats = [...a.seats, ...added.map((steamid) => ({ steamid, team: 'S' as const }))];
      this.pushRoster(a);
      this.planNextMap(a);
    }
  }

  private maybeOpen(cands: string[]): void {
    if (!this.enabled() || cands.length < this.minPlayers()) return;
    if (matchesWaiting(this.deps.db) > 0) return;
    const server = this.deps.db.prepare(
      `SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 AND ${NOT_LEASED_SQL} ORDER BY id LIMIT 1`,
    ).get() as ServerRow | undefined;
    if (!server) return;
    const token = newToken();
    const password = `side_${token.slice(0, 8)}`;
    const rowId = Number(this.deps.db.prepare(
      'INSERT INTO side_games (server_id, token, password) VALUES (?, ?, ?)',
    ).run(server.id, token, password).lastInsertRowid);
    const size = sizeFor(Math.min(cands.length, 7))!;
    const a: Active = {
      rowId, server, token, password, phase: 'running', size, seats: [], pendingSize: null, pendingSeats: null,
      connected: new Set(), away: new Map(), gone: new Set(), satOut: new Map(), played: new Map(),
      map: null, voteSentFor: null, closeTimer: null,
    };
    a.seats = this.lineup(a, cands, size);
    this.active = a;
    const first = this.randomFirstMap();
    this.send(server, [
      `sv_password "${password}"`,
      `exec ${CONFIG[size]}`,
      `sm_side_start ${token}`,
      this.rosterCommand(a.seats),
      `changelevel ${first}`,
    ]);
    this.deps.broadcast();
  }

  /** Candidates to seats: who plays (rules), then SR-balanced A/B. */
  private lineup(a: Active, cands: string[], size: SideSize): Seat[] {
    const sc: SideCandidate[] = cands.map((steamid) => ({
      steamid,
      connected: a.connected.has(steamid) || a.connected.size === 0,
      queuePos: this.deps.queue.queuePosition(steamid),
      satOut: a.satOut.get(steamid) ?? 0,
      playedStreak: a.played.get(steamid) ?? 0,
    }));
    const { playing, bench } = choosePlaying(sc, size);
    const ratings = getRatings(this.deps.db, playing);
    const { teamA, teamB } = balanceTeams(playing.map((steamid) => {
      const r = ratings.get(steamid)!;
      return { steamid, mu: r.mu, sigma: r.sigma };
    }));
    return [
      ...teamA.map((steamid) => ({ steamid, team: 'A' as const })),
      ...teamB.map((steamid) => ({ steamid, team: 'B' as const })),
      ...bench.map((steamid) => ({ steamid, team: 'S' as const })),
    ];
  }

  private rosterCommand(seats: Seat[]): string {
    return `sm_side_roster ${seats.map((s) => `${s.steamid}:${s.team}`).join(' ')}`;
  }

  private pushRoster(a: Active): void { this.send(a.server, [this.rosterCommand(a.seats)]); this.deps.broadcast(); }

  /** Growth and rotation are decided now and applied at the next mapstart. */
  private planNextMap(a: Active): void {
    const cands = a.seats.map((s) => s.steamid).filter((s) => !a.gone.has(s));
    const size = sizeFor(Math.min(cands.length, 7));
    if (!size) return;
    a.pendingSize = size !== a.size ? size : null;
    a.pendingSeats = this.lineup(a, cands, size);
  }

  onLog(ev: { event: SideLogEvent; token: string; steamid: string | null; map: string | null; campaign: string | null }): void {
    const a = this.active;
    if (!a || ev.token !== a.token) return;
    const id = ev.steamid;
    switch (ev.event) {
      case 'join': if (id) this.onJoin(a, id); break;
      case 'part': if (id) this.onPart(a, id); break;
      case 'ready': if (id && a.phase === 'popped') this.onReady(a, id); break;
      case 'vote': if (id && ev.campaign && a.phase === 'popped') this.deps.queue.vote(id, ev.campaign); break;
      case 'mapend': this.onMapEnd(a, ev.map); break;
      case 'mapstart': this.onMapStart(a, ev.map); break;
    }
  }

  private onJoin(a: Active, id: string): void {
    a.connected.add(id);
    a.away.get(id)?.cancel();
    a.away.delete(id);
    if (a.gone.delete(id) && a.seats.some((s) => s.steamid === id)) this.deps.broadcast();
  }

  private onPart(a: Active, id: string): void {
    a.connected.delete(id);
    if (!a.seats.some((s) => s.steamid === id) || a.away.has(id)) return;
    a.away.set(id, this.setTimer(() => {
      a.away.delete(id);
      if (this.active === a && !a.connected.has(id)) this.gone(id, 'disconnected');
    }, RECONNECT_GRACE_MS));
  }

  private onReady(a: Active, id: string): void {
    const r = this.deps.queue.ready(id);
    const text = r.ok ? 'Ready. Waiting for the others.' : `Not ready: ${r.error ?? 'try again on the site'}`;
    this.send(a.server, [`sm_side_notice ${id} "${text.replace(/"/g, "'")}"`]);
  }

  private candidateOf(a: Active, steamid: string): SideCandidate {
    return {
      steamid,
      connected: a.connected.has(steamid) && !a.gone.has(steamid),
      queuePos: this.deps.queue.queuePosition(steamid),
      satOut: a.satOut.get(steamid) ?? 0,
      playedStreak: a.played.get(steamid) ?? 0,
    };
  }

  /**
   * A player is out: left the queue (dropped from the seats), or the
   * reconnect grace ran out (kept as a sitter in `gone`, so a later join
   * brings them back). Shrinking is handled at once, per the spec.
   */
  private gone(id: string, why: 'left' | 'disconnected'): void {
    const a = this.active!;
    const seat = a.seats.find((s) => s.steamid === id);
    if (!seat) return;
    if (why === 'left') a.seats = a.seats.filter((s) => s.steamid !== id);
    else { a.gone.add(id); a.seats = a.seats.map((s) => s.steamid === id ? { ...s, team: 'S' } : s); }
    if (seat.team === 'S') { this.pushRoster(a); return; }

    const stillIn = a.seats.filter((s) => !a.gone.has(s.steamid));
    const bench = stillIn.filter((s) => s.team === 'S').map((s) => this.candidateOf(a, s.steamid));
    const action = onLeave(stillIn.map((s) => this.candidateOf(a, s.steamid)), bench);
    if (action.kind === 'close') { this.windDown(a); return; }
    if (action.kind === 'sub') {
      a.seats = a.seats.map((s) => s.steamid === action.steamid ? { ...s, team: seat.team } : s);
      this.pushRoster(a);
      return;
    }
    a.size = action.size;
    const goneSeats = [...a.gone].map((steamid) => ({ steamid, team: 'S' as const }));
    a.seats = [...this.lineup(a, stillIn.map((s) => s.steamid), action.size), ...goneSeats];
    // The config ends in sm_restartmap: this restarts the map at the new size.
    this.send(a.server, [`exec ${CONFIG[action.size]}`, this.rosterCommand(a.seats)]);
    this.deps.broadcast();
  }

  /** Under 4: stop the game at once but hold the box for CLOSE_GRACE_MS, in
   *  case someone opts in or reconnects. sync() reopens it; the timer closes. */
  private windDown(a: Active): void {
    a.phase = 'closing';
    a.seats = a.seats.map((s) => ({ ...s, team: 'S' }));
    this.send(a.server, [
      this.rosterCommand(a.seats),
      'say [Side] Not enough players. The side game restarts if someone joins in the next 3 minutes.',
    ]);
    a.closeTimer?.cancel();
    a.closeTimer = this.setTimer(() => { if (this.active === a && a.phase === 'closing') this.close('too_few'); }, CLOSE_GRACE_MS);
    this.deps.broadcast();
  }

  /** Back to running on the box already held (closing or a failed pop). */
  private restart(a: Active, cands: string[]): void {
    const size = sizeFor(Math.min(cands.length, 7))!;
    a.closeTimer?.cancel();
    a.closeTimer = null;
    const wasPopped = a.phase === 'popped';
    a.phase = 'running';
    a.size = size;
    a.voteSentFor = null;
    a.gone.clear();
    a.seats = this.lineup(a, cands, size);
    this.send(a.server, [...(wasPopped ? ['sm_side_resume'] : []), `exec ${CONFIG[size]}`, this.rosterCommand(a.seats)]);
    this.deps.broadcast();
  }

  private onMapEnd(a: Active, map: string | null): void {
    for (const s of a.seats) {
      if (s.team === 'S') { a.satOut.set(s.steamid, (a.satOut.get(s.steamid) ?? 0) + 1); a.played.set(s.steamid, 0); }
      else { a.played.set(s.steamid, (a.played.get(s.steamid) ?? 0) + 1); a.satOut.set(s.steamid, 0); }
    }
    this.planNextMap(a);
    if (map && this.isFinale(map)) this.send(a.server, [`changelevel ${this.randomFirstMap()}`]);
  }

  private onMapStart(a: Active, map: string | null): void {
    a.map = map;
    const cmds: string[] = [];
    if (a.pendingSize) { a.size = a.pendingSize; cmds.push(`exec ${CONFIG[a.size]}`); }
    if (a.pendingSeats) { a.seats = a.pendingSeats; cmds.push(this.rosterCommand(a.seats)); }
    a.pendingSize = null;
    a.pendingSeats = null;
    if (cmds.length) { this.send(a.server, cmds); this.deps.broadcast(); }
  }

  private onPop(players: string[]): void {
    const a = this.active;
    if (!a || a.phase !== 'running' || !a.seats.some((s) => players.includes(s.steamid))) return;
    a.phase = 'popped';
    this.send(a.server, ['sm_side_popped']);
    this.deps.broadcast();
  }

  private maybeSendVote(): void {
    const a = this.active;
    if (!a || a.phase !== 'popped') return;
    const lobby = a.seats.map((s) => this.deps.queue.lobbyOf(s.steamid)).find((l) => l !== null);
    if (!lobby || lobby.phase !== 'map_vote' || a.voteSentFor === lobby.id) return;
    a.voteSentFor = lobby.id;
    const opts = lobby.options.map((slug) => `"${slug}=${campaignDisplayName(this.deps.db, slug).replace(/"/g, "'")}"`);
    this.send(a.server, [`sm_side_vote ${opts.join(' ')}`]);
  }

  private onLobbyFailed(): void {
    const a = this.active;
    if (!a || a.phase !== 'popped') return;
    const cands = this.deps.queue.sideCandidates();
    if (cands.length >= this.minPlayers()) { this.restart(a, cands); return; }
    this.send(a.server, ['sm_side_resume']);
    this.windDown(a);
  }

  takeForMatch(campaign: string, runsOn: (server: ServerRow) => boolean): { server: ServerRow; firstCommands: string[] } | null {
    const a = this.active;
    if (!a) return null;
    const server = getServer(this.deps.db, a.server.id);
    if (!server || !runsOn(server)) { this.close('campaign'); return null; }
    const took = this.deps.db.transaction(() => {
      const r = this.deps.db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ? AND status = 'idle'").run(server.id);
      if (r.changes !== 1) return false;
      this.endRow(a.rowId, 'match');
      return true;
    })();
    if (!took) { this.close('campaign'); return null; }
    this.stopTimers(a);
    this.active = null;
    this.deps.broadcast();
    return { server: { ...server, status: 'reserved' }, firstCommands: [`sm_side_stop ${a.token}`] };
  }

  needServer(): void {
    if (!this.active || openLeases(this.deps.db).length > 0) return;
    this.close('preempted');
  }

  recover(): void {
    const rows = this.deps.db.prepare('SELECT id, server_id FROM side_games WHERE ended_at IS NULL').all() as { id: number; server_id: number }[];
    for (const r of rows) {
      void this.deps.release(r.server_id);
      this.endRow(r.id, 'boot');
    }
  }

  private close(reason: string): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.stopTimers(a);
    this.send(a.server, [`sm_side_stop ${a.token}`]);
    // Release after the stop has gone out; the forced restart clears the
    // 2v2/3v3 config and the cleaner restores the standing password.
    this.work = this.work.then(() => this.deps.release(a.server.id)).catch(() => {});
    this.endRow(a.rowId, reason);
    this.deps.broadcast();
  }

  private endRow(id: number, reason: string): void {
    this.deps.db.prepare("UPDATE side_games SET ended_at = datetime('now'), end_reason = ? WHERE id = ? AND ended_at IS NULL").run(reason, id);
  }

  private stopTimers(a: Active): void {
    for (const t of a.away.values()) t.cancel();
    a.away.clear();
    a.closeTimer?.cancel();
  }

  private stockCampaigns(): { slug: string; firstMap: string; maps: string[] }[] {
    return [...campaignRegistry(this.deps.db).values()]
      .filter((c) => !c.custom && !c.requiresDlc4 && !c.practiceOnly && c.maps.length > 0);
  }

  private randomFirstMap(): string {
    const pool = this.stockCampaigns();
    return pool[Math.floor(this.rng() * pool.length)]?.firstMap ?? 'l4d_vs_hospital01_apartment';
  }

  private isFinale(map: string): boolean {
    const slug = campaignForMap(map);
    const entry = slug ? campaignRegistry(this.deps.db).get(slug) : undefined;
    return !!entry && entry.maps[entry.maps.length - 1] === map;
  }

  view(steamid: string): SideGameView | null {
    const a = this.active;
    if (!a) return null;
    const youIn = a.seats.some((s) => s.steamid === steamid);
    return {
      phase: a.phase, size: a.phase === 'running' ? a.size : null, players: a.seats.length, youIn,
      connect: youIn ? { host: a.server.host, port: a.server.port, password: a.password } : null,
    };
  }

  publicView(): { size: SideSize | null; players: number } | null {
    const a = this.active;
    return a ? { size: a.phase === 'running' ? a.size : null, players: a.seats.length } : null;
  }
}
```

Implementation notes for the engineer:
- `lineup()` marks everyone connected when nobody has connected yet (`a.connected.size === 0`), so the first lineup does not bench by connection.
- A pop takes the 8 out of the queue, so `sync()` must not treat them as leavers. That is why `sync()` returns early while `popped`.
- `now` and `rng` are injected for tests; `now` is currently unused by the logic and may be dropped if the tests do not need it.

- [ ] **Step 4: Run tests until green**

Run: `npx vitest run tests/sideGames.test.ts && npm run typecheck`
Expected: PASS, 20+ tests.

- [ ] **Step 5: Commit**

```bash
git status --short
git commit -m "side games: manager (open, lineup, rotation, leave rules, pop, resume, handover, preempt, recover)" -- src/sideGames.ts tests/sideGames.test.ts
```

---

### Task 8: The match takes the held box

**Files:**
- Modify: `src/orchestrator.ts:131-240` (`RealOrchestrator.setupMatch`; options interface)
- Test: `tests/orchestrator.test.ts` (append)

**Interfaces:**
- Consumes: `SideGames.takeForMatch(campaign, runsOn)` (Task 7).
- Produces: `RealOrchestrator` option `takeHeld?: (campaign: string, runsOn: (s: ServerRow) => boolean) => { server: ServerRow; firstCommands: string[] } | null`; exported `campaignRunsOn(db: DB, campaign: string, server: ServerRow): boolean` (the custom-installed and dlc4 checks, moved out of `setupMatch` unchanged in meaning).

- [ ] **Step 1: Write the failing tests** (append to `tests/orchestrator.test.ts`, using its `fakeServer`, `addServer`, `LogListener`, `ServerReleaser` setup at lines 82-95)

```ts
describe('setupMatch with a held side-game box', () => {
  async function build(takeHeld: ConstructorParameters<typeof RealOrchestrator>[0]['takeHeld']) {
    const listener = new LogListener(() => {}); await listener.listen(0); cleanup.push(() => listener.close());
    const releaser = new ServerReleaser(db, async () => {});
    return new RealOrchestrator({ db, listener, logPublicAddress: '127.0.0.1:27500', releaser, makeRcon: (o) => o, takeHeld });
  }

  it('uses the held box and sends its first commands before exec pug_match', async () => {
    const srv = await fakeServer(''); cleanup.push(srv.close);
    const held = addServer(db, { name: 'held', host: '127.0.0.1', port: 27016, rconPort: srv.port, rconPassword: 'secret' });
    addServer(db, { name: 'other', host: '127.0.0.1', port: 27017, rconPort: 1, rconPassword: 'x' });
    const orch = await build(() => ({ server: { ...getServer(db, held)!, status: 'reserved' }, firstCommands: ['sm_side_stop abc'] }));
    const matchId = seedMatch(db, 'no_mercy');
    await orch.setupMatch(matchId);
    expect(srv.cmds[0]).toBe('sm_side_stop abc');
    expect(srv.cmds.indexOf('exec pug_match')).toBeGreaterThan(0);
    expect(db.prepare('SELECT server_id FROM matches WHERE id = ?').get(matchId)).toEqual({ server_id: held });
  });

  it('falls back when the campaign cannot run there', async () => {
    const srv = await fakeServer(''); cleanup.push(srv.close);
    // The held box lacks the dlc4 mappack (has_dlc4 defaults to 0); the other has it.
    const heldNoDlc4 = addServer(db, { name: 'held', host: '127.0.0.1', port: 27016, rconPort: 1, rconPassword: 'x' });
    const other = addServer(db, { name: 'other', host: '127.0.0.1', port: 27017, rconPort: srv.port, rconPassword: 'secret' });
    setHasDlc4(db, other, true);
    // What SideGames does: hide the held box from claimIdle while it is held,
    // ask runsOn, and on false close the game and answer null.
    db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (?, 't', 'p')").run(heldNoDlc4);
    let asked: boolean | null = null;
    const orch = await build((_c, runsOn) => {
      asked = runsOn(getServer(db, heldNoDlc4)!);
      return null;
    });
    const matchId = seedMatch(db, 'dead_center');
    await orch.setupMatch(matchId);
    expect(asked).toBe(false);
    expect(db.prepare('SELECT server_id FROM matches WHERE id = ?').get(matchId)).toEqual({ server_id: other });
  });
});
```

(If `setHasDlc4` takes a number instead of a boolean, pass `1`; if a dlc4 campaign also needs the stock missions dirs to have maps, reuse the setup the existing dlc4 test near line 799 uses.)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: FAIL, `takeHeld` is not a known option / first command is not `sm_side_stop`.

- [ ] **Step 3: Implement**

1. Add `takeHeld?` to the `RealOrchestrator` options interface and store it (`private takeHeld`).
2. Export:

```ts
/** Whether this box can run the campaign: a custom one must be installed on
 *  it, a dlc4 one needs the mappack. The same two checks setupMatch has always
 *  made before changelevel. */
export function campaignRunsOn(db: DB, campaign: string, server: ServerRow): boolean {
  const entry = campaignRegistry(db).get(campaign);
  if (!entry) return false;
  if (entry.custom && !isInstalledEverywhere(db, campaign, [server.id])) return false;
  if (entry.requiresDlc4 && !server.has_dlc4) return false;
  return true;
}
```

3. In `setupMatch`, read the match row BEFORE claiming, then:

```ts
    const held = this.takeHeld?.(match.campaign, (s) => campaignRunsOn(this.db, match.campaign, s)) ?? null;
    const server = held?.server ?? claimIdle(this.db);
```

keeping the existing no-server branch, and, right after `connectRcon`, before any other command:

```ts
      for (const c of held?.firstCommands ?? []) {
        try { await rcon.exec(c); } catch (err) { console.warn(`[orchestrator] ${c.split(' ')[0]} failed (non-fatal):`, err); }
      }
```

Keep the existing throwing checks after the roster as they are (they still guard the `claimIdle` path; the message text must not change).

4. When the match row is missing, the old code released the claimed server; keep that for the new order (read the row first; if missing, return before claiming).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/orchestrator.test.ts tests/pendingMatches.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status --short
git commit -m "orchestrator: a match takes its side-game box first; campaignRunsOn extracted" -- src/orchestrator.ts tests/orchestrator.test.ts
```

---

### Task 9: Wiring, API and state

**Files:**
- Modify: `src/server.ts` (near `practiceLeases` 729-744; log callback 851+; `RealOrchestrator` 1244-1257; reconcile 1283; matchmaker 1347-1355)
- Modify: `src/routes/api.ts` (queue routes lines 29-74; `/api/state`)
- Test: `tests/sideGameRoutes.test.ts` (create; follow `tests/queueRoute.test.ts` for building the app with a session)

**Interfaces:**
- Consumes: everything above.
- Produces: `POST /api/queue/side` body `{ on: boolean }` answers `{ ok: true }` or 409 `{ error }`; `GET /api/state` adds `sideGame: SideGameView | null`; `GET /api/queue` adds `sideGame: { size, players } | null`; Fastify decoration `sideGames`.

- [ ] **Step 1: Write the failing route tests**

```ts
it('toggles side games for a queued player', async () => {
  await post('/api/queue/join');
  expect((await post('/api/queue/side', { on: true })).statusCode).toBe(200);
  expect((await get('/api/state')).json().queue.sideOptIn).toBe(true);
});
it('refuses the toggle when not queued', async () => {
  expect((await post('/api/queue/side', { on: true })).statusCode).toBe(409);
});
it('state and public queue carry sideGame (null with none running)', async () => {
  expect((await get('/api/state')).json().sideGame).toBeNull();
  expect((await get('/api/queue')).json().sideGame).toBeNull();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/sideGameRoutes.test.ts`
Expected: FAIL, 404 on `/api/queue/side`.

- [ ] **Step 3: Implement**

In `src/routes/api.ts`, next to `/api/queue/leave`:

```ts
  app.post('/api/queue/side', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const { on } = (req.body ?? {}) as { on?: unknown };
    if (typeof on !== 'boolean') return reply.code(400).send({ error: 'on must be true or false' });
    const r = matchmaker.setSideOptIn(steamid, on);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return { ok: true };
  });
```

Change `/api/state` to return `{ ...matchmaker.stateFor(steamid), sideGame: app.sideGames?.view(steamid) ?? null }` and `/api/queue` to `{ ...matchmaker.publicQueue(), sideGame: app.sideGames?.publicView() ?? null }`. Declare the decoration type where `matchmaker` is declared (`declare module 'fastify'` block).

In `src/server.ts`:
1. After the matchmaker is built and restored (line ~1355), in the non-dev branch:

```ts
  const sideGames = new SideGames({
    db: deps.db,
    queue: matchmaker,
    rcon: deps.practiceRcon ?? realServerRcon,
    release: (serverId) => new Promise<boolean>((resolve) => {
      releaser.release(serverId, { restart: true, forceRestart: true }, resolve);
    }),
    broadcast: () => hub.broadcast('refresh'),
  });
  sideGames.recover();
  sideGames.sync();
  app.decorate('sideGames', sideGames);
```

Dev mode: decorate `null` so routes answer `sideGame: null`.

2. `RealOrchestrator` is built before the matchmaker. Give it `takeHeld: (c, runsOn) => sideGamesRef?.takeForMatch(c, runsOn) ?? null` with `let sideGamesRef: SideGames | null = null;` declared next to `let pending` and assigned after construction.
3. `onNoServer`: `(id) => { pending?.add(id); practiceLeases.needServer(); sideGamesRef?.needServer(); }`.
4. In the log callback, next to the `call` case:

```ts
        if (ev.kind === 'side') {
          try { sideGamesRef?.onLog(ev); } catch (err) { console.error('[sidegame] log line failed:', err); }
          return;
        }
```

5. Recover order matters: `sideGames.recover()` must run after `reconcileServers` (the release it triggers goes through the same releaser) and before the matchmaker's first `sync()`.

- [ ] **Step 4: Run tests and the whole suite**

Run: `npx vitest run tests/sideGameRoutes.test.ts tests/api.test.ts tests/queueRoute.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status --short
git commit -m "side games: wiring, POST /api/queue/side, sideGame on state and public queue" -- src/server.ts src/routes/api.ts tests/sideGameRoutes.test.ts
```

---

### Task 10: Website queue panel

**Files:**
- Modify: `web/src/api.ts` (types; `setSideOptIn`)
- Modify: `web/src/routes/Play.tsx` (`QueuePanel` 340-394; its call site in `Live` 226-281)
- Test: `web/src/routes/routes.test.tsx` (append near the `QueuePanel` tests, ~line 787)

**Interfaces:**
- Produces: `api.setSideOptIn(on: boolean): Promise<void>`; `StateSnapshot.sideGame?: { phase: 'running' | 'popped' | 'closing'; size: 2 | 3 | null; players: number; youIn: boolean; connect: { host: string; port: number; password: string } | null } | null`; `QueuePanel` props `sideOptIn?: boolean; sideGame?: StateSnapshot['sideGame']`.

- [ ] **Step 1: Write the failing component tests**

```tsx
it('offers the side game toggle to a queued player', async () => {
  render(<QueuePanel count={3} joined={true} players={[]} refresh={noop} sideOptIn={false} sideGame={null} me={me} />);
  const box = screen.getByRole('checkbox', { name: /2v2\/3v3 while I wait/i });
  fireEvent.click(box);
  await waitFor(() => expect(mockApi.setSideOptIn).toHaveBeenCalledWith(true));
});

it('shows the side game with connect details to a participant', () => {
  render(<QueuePanel count={5} joined={true} players={[]} refresh={noop} sideOptIn={true}
    sideGame={{ phase: 'running', size: 2, players: 5, youIn: true, connect: { host: '1.2.3.4', port: 27015, password: 'side_ab' } }} me={me} />);
  expect(screen.getByText(/Side game open: 2v2, 5 playing/)).toBeTruthy();
  expect(screen.getByText(/password side_ab; connect 1\.2\.3\.4:27015/)).toBeTruthy();
});

it('shows only a status line to someone not in it', () => {
  render(<QueuePanel count={5} joined={true} players={[]} refresh={noop} sideOptIn={false}
    sideGame={{ phase: 'running', size: 2, players: 4, youIn: false, connect: null }} me={me} />);
  expect(screen.getByText(/Side game running \(4 players\)/)).toBeTruthy();
  expect(screen.queryByText(/connect 1\.2/)).toBeNull();
});
```

Add `setSideOptIn: vi.fn(async () => {})` to the `mockApi` object at the top of the file.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run web/src/routes/routes.test.tsx -t "side game"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`web/src/api.ts`: add the `sideGame` field to `StateSnapshot`, and next to `leaveQueue`:

```ts
  setSideOptIn: (on: boolean) => post('/api/queue/side', { on }),
```

(use the same `post` helper the neighbours use).

`Play.tsx`, inside `QueuePanel`, below the join/leave button block, only when `joined`:

```tsx
{joined && (
  <label class="side-toggle">
    <input type="checkbox" checked={!!sideOptIn}
      onChange={(e) => act(() => api.setSideOptIn((e.target as HTMLInputElement).checked))} />
    Play 2v2/3v3 while I wait
  </label>
)}
{sideGame && (sideGame.youIn && sideGame.connect ? (
  <div class="side-game">
    <p>{sideGame.phase === 'popped' ? 'Queue popped: ready up here or in game (!ready).'
      : `Side game open: ${sideGame.size}v${sideGame.size}, ${sideGame.players} playing`}</p>
    {sideGame.phase === 'running' && <ConnectPanel connect={sideGame.connect} />}
  </div>
) : (
  <p class="side-game side-game--muted">Side game running ({sideGame.players} players)</p>
))}
```

Pass `sideOptIn={state.queue.sideOptIn}` and `sideGame={state.sideGame ?? null}` from `Live`. Add minimal CSS for `.side-toggle` and `.side-game` next to the queue panel styles (match the existing spacing tokens; no new colors).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run web/src/routes/routes.test.tsx web/src/components/ConnectPanel.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status --short
git commit -m "web: side game toggle, status line and connect panel on the queue" -- web/src/api.ts web/src/routes/Play.tsx web/src/routes/routes.test.tsx web/src/styles
```

(Adjust the styles path to the file you touched.)

---

### Task 11: Discord queue card

**Files:**
- Modify: `src/discord/presenter.ts:54-96` (`PanelView`, `renderPanel`)
- Modify: `src/discord/sync.ts:292-311` (pass the side game)
- Modify: `src/discord/controller.ts:77-133` (`q:side`)
- Modify: where the Discord sync deps are built in `src/server.ts` (add `sideGame`)
- Test: `tests/discordPresenter.test.ts`, `tests/discordController.test.ts` (append)

**Interfaces:**
- Produces: `PanelView.sideGame?: { size: 2 | 3 | null; players: number } | null`; button `q:side` (label `Side games`, style `secondary`); sync deps `sideGame?: () => { size: 2 | 3 | null; players: number } | null`; controller deps `sideGameView?: (steamid: string) => SideGameView | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// discordPresenter.test.ts
it('shows a running side game on the queue card', () => {
  const p = renderPanel({ publicUrl: 'https://x', size: 8, players: [], phase: null, sideGame: { size: 2, players: 5 } });
  expect(p.embeds[0].description).toContain('Side game: 2v2, 5 playing');
  expect(p.components[0].some((b) => b.kind === 'button' && b.customId === 'q:side')).toBe(true);
});

// discordController.test.ts (use its existing linked-player fixture)
it('q:side toggles the opt-in and replies with connect details when a game is open', async () => {
  mm.join(linked.steamid);
  const r1 = await handleButton(deps, button('q:side'));
  expect(mm.isSideOptedIn(linked.steamid)).toBe(true);
  expect(r1.content).toMatch(/side games on/i);
  const r2 = await handleButton(deps, button('q:side'));
  expect(mm.isSideOptedIn(linked.steamid)).toBe(false);
  expect(r2.content).toMatch(/side games off/i);
});
it('q:side asks an unqueued player to join first', async () => {
  const r = await handleButton(deps, button('q:side'));
  expect(r.content).toMatch(/join the queue first/i);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/discordPresenter.test.ts tests/discordController.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`presenter.ts`: add the field to `PanelView`; in `renderPanel`, after `status`:

```ts
  const side = v.sideGame
    ? `\nSide game: ${v.sideGame.size ? `${v.sideGame.size}v${v.sideGame.size}, ` : ''}${v.sideGame.players} playing (opt in with Side games).`
    : '';
```

append `${side}` to the description after `${status}`, and add after the Leave button:

```ts
      { kind: 'button', customId: 'q:side', label: 'Side games', style: 'secondary' },
```

(Check the Discord 5-buttons-per-row limit: Join, Leave, Side games, Notify me, Website, Leaderboard is 6. Move the two link buttons to a second row: `components: [[join, leave, side, ...notify], [website, leaderboard]]`, and update any presenter test that pins the single row.)

`sync.ts`: pass `sideGame: this.deps.sideGame?.() ?? null` into `renderPanel`; add `sideGame?` to its deps interface; wire it in `server.ts` as `sideGame: () => sideGamesRef?.publicView() ?? null`.

`controller.ts`: add `|| parts[1] === 'side'` to the `q` part of `known`, and after the `q:leave` branch:

```ts
  if (parts[0] === 'q' && parts[1] === 'side') {
    const on = !mm.isSideOptedIn(steamid);
    const r = mm.setSideOptIn(steamid, on);
    if (!r.ok) return say(`Could not change side games: ${r.error}.`);
    if (!on) return say('Side games off. You stay in the queue.');
    const v = deps.sideGameView?.(steamid);
    return say(v?.connect
      ? `Side games on. Join: \`password ${v.connect.password}; connect ${v.connect.host}:${v.connect.port}\``
      : 'Side games on. You will get connect details here and on the website when a game opens.');
  }
```

Wire `sideGameView: (s) => sideGamesRef?.view(s) ?? null` into the controller deps in `server.ts`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/discordPresenter.test.ts tests/discordController.test.ts tests/discordSync.test.ts && npm run typecheck`
Expected: PASS (fix the row-layout assertions the button move breaks).

- [ ] **Step 5: Commit**

```bash
git status --short
git commit -m "discord: Side games button and status line on the queue card" -- src/discord/presenter.ts src/discord/sync.ts src/discord/controller.ts src/server.ts tests/discordPresenter.test.ts tests/discordController.test.ts
```

---

### Task 12: The plugin

**Files:**
- Create: `plugin/pug-sidegame.sp`
- Create: `plugin/build-sidegame.sh` (copy of `plugin/build-tvwatch.sh` with `l4d_tvwatch` replaced by `pug-sidegame` everywhere)
- Create: `plugin/SIDEGAME-TESTING.md`

**Interfaces:**
- Consumes: the command contract in Task 7; `pug-logauth.inc` (`PugLogAuth_Init()`, `PugLog(fmt, ...)`); Rotoblin's `sm_sur` / `sm_inf`; readyup's `sm_ready` command name.
- Produces: log lines `PUGSIDE event=... token=... [steamid=...] [map=...] [campaign=...]` exactly as parsed in Task 6.

- [ ] **Step 1: Write the plugin**

```sourcepawn
// plugin/pug-sidegame.sp
// Queue side games: 2v2/3v3 on the match server while the PUG queue fills.
// Separate from pug-match on purpose: nothing here may touch a ranked match.
// Spec: docs/superpowers/specs/2026-09-28-queue-side-games-design.md
#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <sdktools>
#include "pug-logauth.inc"

#define TEAM_SPEC 1
#define TEAM_SURVIVOR 2
#define TEAM_INFECTED 3
#define MAX_SEATS 8
#define LOCK_ATTEMPT_CAP 5

public Plugin myinfo = {
	name = "PUG Side Game", author = "Riverside", description = "Queue side games (2v2/3v3)",
	version = "0.1.0", url = ""
};

char g_sToken[65];
bool g_bActive;
bool g_bPopped;
char g_sSeatId[MAX_SEATS][32];
char g_cSeatTeam[MAX_SEATS];      // 'A', 'B' or 'S'
int g_iSeats;
int g_iSideOfA;                   // TEAM_SURVIVOR or TEAM_INFECTED, 0 = unknown
int g_iAttempts[MAXPLAYERS + 1];
bool g_bReadied[MAXPLAYERS + 1];
bool g_bRoundEnded;
int g_iSavedAutoTrack = -1;
char g_sVoteSlug[16][64];
char g_sVoteName[16][64];
int g_iVoteCount;

public void OnPluginStart()
{
	PugLogAuth_Init();
	RegServerCmd("sm_side_start", Cmd_Start, "sm_side_start <token>");
	RegServerCmd("sm_side_roster", Cmd_Roster, "sm_side_roster <id64>:<A|B|S> ...");
	RegServerCmd("sm_side_popped", Cmd_Popped, "sm_side_popped");
	RegServerCmd("sm_side_resume", Cmd_Resume, "sm_side_resume");
	RegServerCmd("sm_side_vote", Cmd_Vote, "sm_side_vote \"slug=Name\" ...");
	RegServerCmd("sm_side_notice", Cmd_Notice, "sm_side_notice <id64> \"text\"");
	RegServerCmd("sm_side_stop", Cmd_Stop, "sm_side_stop <token>");
	AddCommandListener(Listen_Ready, "sm_ready");
	HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);
	HookEvent("round_end", Event_RoundEnd, EventHookMode_PostNoCopy);
	CreateTimer(2.0, Timer_Lock, _, TIMER_REPEAT);
	CreateTimer(15.0, Timer_Remind, _, TIMER_REPEAT);
}

// ---------- commands ----------

public Action Cmd_Start(int args)
{
	GetCmdArg(1, g_sToken, sizeof(g_sToken));
	if (strlen(g_sToken) < 8) { PrintToServer("PUGERR bad token"); return Plugin_Handled; }
	ConVar at = FindConVar("sm_pug_auto_track");
	if (at != null && g_iSavedAutoTrack < 0) { g_iSavedAutoTrack = at.IntValue; at.IntValue = 0; }
	g_bActive = true;
	g_bPopped = false;
	g_iSeats = 0;
	g_iSideOfA = 0;
	PrintToServer("PUGOK side start");
	return Plugin_Handled;
}

public Action Cmd_Roster(int args)
{
	if (!g_bActive) { PrintToServer("PUGERR not active"); return Plugin_Handled; }
	g_iSeats = 0;
	char arg[48];
	for (int i = 1; i <= args && g_iSeats < MAX_SEATS; i++)
	{
		GetCmdArg(i, arg, sizeof(arg));
		int sep = FindCharInString(arg, ':');
		if (sep < 1) continue;
		char t = arg[sep + 1];
		if (t != 'A' && t != 'B' && t != 'S') continue;
		arg[sep] = '\0';
		strcopy(g_sSeatId[g_iSeats], 32, arg);
		g_cSeatTeam[g_iSeats] = t;
		g_iSeats++;
	}
	for (int c = 1; c <= MaxClients; c++) g_iAttempts[c] = 0;
	PrintToServer("PUGOK roster=%d", g_iSeats);
	return Plugin_Handled;
}

public Action Cmd_Popped(int args)
{
	if (!g_bActive) { PrintToServer("PUGERR not active"); return Plugin_Handled; }
	g_bPopped = true;
	for (int c = 1; c <= MaxClients; c++)
	{
		g_bReadied[c] = false;
		if (IsClientInGame(c) && !IsFakeClient(c) && GetClientTeam(c) != TEAM_SPEC) ChangeClientTeam(c, TEAM_SPEC);
	}
	RemindAll();
	PrintToServer("PUGOK popped");
	return Plugin_Handled;
}

public Action Cmd_Resume(int args)
{
	g_bPopped = false;
	g_iVoteCount = 0;
	PrintToChatAll("\x04[Side]\x01 The ready check failed. Side game back on.");
	PrintToServer("PUGOK resume");
	return Plugin_Handled;
}

public Action Cmd_Vote(int args)
{
	if (!g_bActive || !g_bPopped) { PrintToServer("PUGERR not popped"); return Plugin_Handled; }
	g_iVoteCount = 0;
	char arg[140];
	for (int i = 1; i <= args && g_iVoteCount < 16; i++)
	{
		GetCmdArg(i, arg, sizeof(arg));
		int eq = FindCharInString(arg, '=');
		if (eq < 1) continue;
		strcopy(g_sVoteName[g_iVoteCount], 64, arg[eq + 1]);
		arg[eq] = '\0';
		strcopy(g_sVoteSlug[g_iVoteCount], 64, arg);
		g_iVoteCount++;
	}
	for (int c = 1; c <= MaxClients; c++) if (SeatOf(c) >= 0) ShowVote(c);
	PrintToServer("PUGOK vote=%d", g_iVoteCount);
	return Plugin_Handled;
}

public Action Cmd_Notice(int args)
{
	char id[32], text[192];
	GetCmdArg(1, id, sizeof(id));
	GetCmdArg(2, text, sizeof(text));
	int c = ClientOfId(id);
	if (c > 0) PrintToChat(c, "\x04[Side]\x01 %s", text);
	PrintToServer("PUGOK notice");
	return Plugin_Handled;
}

public Action Cmd_Stop(int args)
{
	char tok[65];
	GetCmdArg(1, tok, sizeof(tok));
	if (g_bActive && !StrEqual(tok, g_sToken)) { PrintToServer("PUGERR token"); return Plugin_Handled; }
	g_bActive = false;
	g_bPopped = false;
	g_iSeats = 0;
	g_iVoteCount = 0;
	g_sToken[0] = '\0';
	ConVar at = FindConVar("sm_pug_auto_track");
	if (at != null && g_iSavedAutoTrack >= 0) at.IntValue = g_iSavedAutoTrack;
	g_iSavedAutoTrack = -1;
	PrintToServer("PUGOK side stop");
	return Plugin_Handled;
}

// ---------- ready and vote ----------

public Action Listen_Ready(int client, const char[] command, int argc)
{
	if (!g_bActive || !g_bPopped || client <= 0 || SeatOf(client) < 0) return Plugin_Continue;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return Plugin_Handled;
	g_bReadied[client] = true;
	PugLog("PUGSIDE event=ready token=%s steamid=%s", g_sToken, id);
	return Plugin_Handled;
}

void ShowVote(int client)
{
	if (g_iVoteCount == 0) return;
	Menu menu = new Menu(MenuHandler_Vote);
	menu.SetTitle("Queue popped: campaign vote");
	for (int i = 0; i < g_iVoteCount; i++) menu.AddItem(g_sVoteSlug[i], g_sVoteName[i]);
	menu.Display(client, 30);
}

public int MenuHandler_Vote(Menu menu, MenuAction action, int client, int item)
{
	if (action == MenuAction_End) { delete menu; return 0; }
	if (action != MenuAction_Select || !g_bActive || !g_bPopped) return 0;
	char slug[64], id[32];
	menu.GetItem(item, slug, sizeof(slug));
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return 0;
	PugLog("PUGSIDE event=vote token=%s steamid=%s campaign=%s", g_sToken, id, slug);
	PrintToChat(client, "\x04[Side]\x01 Vote sent.");
	return 0;
}

public Action Timer_Remind(Handle t)
{
	if (g_bActive && g_bPopped) RemindAll();
	return Plugin_Continue;
}

void RemindAll()
{
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c) || g_bReadied[c] || SeatOf(c) < 0) continue;
		PrintCenterText(c, "QUEUE POPPED: type !ready");
		PrintToChat(c, "\x04[Side]\x01 The queue popped. Type \x05!ready\x01 now (or press Ready on the site).");
	}
}

// ---------- team lock ----------

int SeatOf(int client)
{
	if (!IsClientInGame(client) || IsFakeClient(client)) return -1;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return -1;
	for (int i = 0; i < g_iSeats; i++) if (StrEqual(g_sSeatId[i], id)) return i;
	return -1;
}

int ClientOfId(const char[] id)
{
	char cid[32];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		if (GetClientAuthId(c, AuthId_SteamID64, cid, sizeof(cid)) && StrEqual(cid, id)) return c;
	}
	return 0;
}

/** Which game team team A is on, read from where seated players stand. */
void UpdateOrientation()
{
	int aSurv = 0, aInf = 0, bSurv = 0, bInf = 0;
	for (int c = 1; c <= MaxClients; c++)
	{
		int s = SeatOf(c);
		if (s < 0) continue;
		int team = GetClientTeam(c);
		if (g_cSeatTeam[s] == 'A') { if (team == TEAM_SURVIVOR) aSurv++; else if (team == TEAM_INFECTED) aInf++; }
		else if (g_cSeatTeam[s] == 'B') { if (team == TEAM_SURVIVOR) bSurv++; else if (team == TEAM_INFECTED) bInf++; }
	}
	int straight = aSurv + bInf, inverted = aInf + bSurv;
	if (straight > inverted) g_iSideOfA = TEAM_SURVIVOR;
	else if (inverted > straight) g_iSideOfA = TEAM_INFECTED;
	else if (g_iSideOfA == 0) g_iSideOfA = TEAM_SURVIVOR;
}

public Action Timer_Lock(Handle t)
{
	if (!g_bActive || g_bPopped || g_iSeats == 0) return Plugin_Continue;
	UpdateOrientation();
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		int s = SeatOf(c);
		int have = GetClientTeam(c);
		int want = TEAM_SPEC;
		if (s >= 0 && g_cSeatTeam[s] == 'A') want = g_iSideOfA;
		else if (s >= 0 && g_cSeatTeam[s] == 'B') want = (g_iSideOfA == TEAM_SURVIVOR) ? TEAM_INFECTED : TEAM_SURVIVOR;
		if (have == want) { g_iAttempts[c] = 0; continue; }
		if (g_iAttempts[c]++ >= LOCK_ATTEMPT_CAP) continue;
		if (want == TEAM_SPEC) ChangeClientTeam(c, TEAM_SPEC);
		else if (want == TEAM_SURVIVOR)
		{
			if (have == TEAM_INFECTED) ChangeClientTeam(c, TEAM_SPEC);
			FakeClientCommand(c, "sm_sur");
		}
		else FakeClientCommand(c, "sm_inf");
	}
	return Plugin_Continue;
}

// ---------- presence and map events ----------

public void OnClientPostAdminCheck(int client)
{
	if (!g_bActive || IsFakeClient(client)) return;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return;
	g_iAttempts[client] = 0;
	g_bReadied[client] = false;
	PugLog("PUGSIDE event=join token=%s steamid=%s", g_sToken, id);
	if (g_bPopped && g_iVoteCount > 0 && SeatOf(client) >= 0) ShowVote(client);
}

public void OnClientDisconnect(int client)
{
	if (!g_bActive || !IsClientInGame(client) || IsFakeClient(client)) return;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return;
	PugLog("PUGSIDE event=part token=%s steamid=%s", g_sToken, id);
}

public void OnConfigsExecuted()
{
	if (!g_bActive) return;
	g_bRoundEnded = false;
	char map[64];
	GetCurrentMap(map, sizeof(map));
	PugLog("PUGSIDE event=mapstart token=%s map=%s", g_sToken, map);
}

public void Event_RoundStart(Event e, const char[] n, bool d) { g_bRoundEnded = false; }

public void Event_RoundEnd(Event e, const char[] n, bool d)
{
	// round_end can fire twice; only the second half's first one ends the map.
	if (!g_bActive || g_bRoundEnded) return;
	g_bRoundEnded = true;
	if (!view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound"))) return;
	char map[64];
	GetCurrentMap(map, sizeof(map));
	PugLog("PUGSIDE event=mapend token=%s map=%s", g_sToken, map);
}
```

Notes for the engineer:
- `pug-logauth.inc` is `#include`d with quotes because `build-sidegame.sh` copies it beside the source; check how `l4d_tvwatch.sp` includes it and match that exactly.
- `OnClientDisconnect` fires on real disconnects only, not on changelevel in Source, which is what the 90 s grace needs.
- `AddCommandListener` on `sm_ready` also catches the `!ready` chat trigger. If testing shows readyup's command is registered under another name on this build, add a listener for that name too.

- [ ] **Step 2: Build it**

```bash
cd /home/volence/l4d/pug/plugin && sed 's/l4d_tvwatch/pug-sidegame/g' build-tvwatch.sh > build-sidegame.sh && chmod +x build-sidegame.sh && ./build-sidegame.sh
```

Expected: `built: .../plugin/pug-sidegame.smx`, no errors. Fix warnings too.

- [ ] **Step 3: Write `plugin/SIDEGAME-TESTING.md`**

Contents (a runbook, not code):
1. Local server `/home/volence/l4d1-ds` is shared: `rcon-local.py status` first; stop if foreign humans are on.
2. Start with `start-cheats.sh` (owner rule: local tests use `rotoblin_cheats_4v4`), copy `pug-sidegame.smx` into `addons/sourcemod/plugins`, `sm plugins load pug-sidegame`.
3. Drive it by rcon with a fake token: `sm_side_start deadbeef01`, `sm_side_roster <your id64>:A`, `exec rotoblin_hardcore_2v2`. Check you are moved to your side, that a stranger slot `S` goes to spectate, that `sm_pug_auto_track` reads 0, and that `logaddress_add 127.0.0.1:<port>` plus a `nc -ul` shows signed `PUGSIDE event=join` and `event=mapstart` lines.
4. `sm_side_popped`: you go to spectate, center text shows, `!ready` prints a `PUGSIDE event=ready` line and does NOT ready you up in readyup.
5. `sm_side_vote "no_mercy=No Mercy" "death_toll=Death Toll"`: menu appears, a pick prints `event=vote ... campaign=no_mercy`.
6. `sm_side_stop deadbeef01`: auto_track restored to its old value.
7. Confirm no `matches` row and no replay file appeared (`sm_pug_status` shows no match).

- [ ] **Step 4: Run the runbook** on the local server and note results at the bottom of the file.

- [ ] **Step 5: Commit** (never the `.smx`)

```bash
git status --short
git commit -m "plugin: pug-sidegame (team lock, in-game ready and vote, PUGSIDE lines)" -- plugin/pug-sidegame.sp plugin/build-sidegame.sh plugin/SIDEGAME-TESTING.md
```

---

### Task 13: End-to-end rehearsal and go-live notes

**Files:**
- Modify: `plugin/SIDEGAME-TESTING.md` (append the rehearsal section and results)

- [ ] **Step 1: Full suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 2: Local end-to-end** with `npm run dev` pointed at the local server as its only pool box (the `DevOrchestrator` path does not run real rcon, so use a local non-dev config with the l4d1-ds box as the single server, as the web-queue rehearsal did). Script four queue joins and opt-ins using the signed-cookie method in memory `pug-web-queue-to-server` (use obviously invalid steamids, e.g. `76561190000000001`-style values that are not real accounts; clean up `players`, `player_ratings` rows afterwards). Check:
  - the side game opens on the box, the site shows the connect line, you are placed in game;
  - a 5th opt-in appears as `S` and is seated at the next map;
  - four more joins pop the queue; `!ready` in game readies you on the site;
  - the match goes onto the same box and `side_games.end_reason = 'match'`;
  - no `matches` row exists for the side game period and no replay was written.

- [ ] **Step 3: Go-live notes** (append to the runbook, do NOT execute): stage `pug-sidegame.smx` on all pool boxes via `deploy/tools/stage-on-restart.sh` so it lands between matches; deploy web with `deploy-web.sh`; turn on `sidegames_enabled` from the admin panel while the owner watches the first one. Live boxes are never touched without the owner's explicit go-ahead.

- [ ] **Step 4: Commit**

```bash
git status --short
git commit -m "side games: rehearsal results and go-live notes" -- plugin/SIDEGAME-TESTING.md
```
