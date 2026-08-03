# Sub-Project 3: Ratings, Stats, Leaderboard, History, Discord — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post-match OpenSkill rating updates, per-map/per-player stat persistence, leaderboard + profile + match-history pages, and Discord webhook notifications — completing sub-project 3 of the L4D1 PUG design.

**Architecture:** A new pure `src/rating.ts` module owns SR math and post-match OpenSkill updates. A new `src/matchResult.ts` owns the single "persist a finished match" transaction (matches + match_players + new match_maps + ratings), used by both the real orchestrator and a new dev-mode fake-finish route. Read-only stats endpoints live in a new `src/routes/stats.ts`; the vanilla-JS frontend gains hash-routing with leaderboard/matches/profile views. Discord is one fire-and-forget webhook function with injectable fetch.

**Tech Stack:** TypeScript ESM, Fastify 5, better-sqlite3, `openskill` 5 (`rate` — first use), vitest, vanilla JS frontend (no build step).

**Repo:** `/home/volence/l4d/pug`, branch `sub-project-3` (created by the overseer). Run tests with `npx vitest run <file>` (or `npm test` for all), typecheck with `npm run typecheck`.

**Conventions (match existing code):**
- DB access: `db.prepare(...).get/all/run`, `db.transaction(() => {...})()`. better-sqlite3 nests transactions via savepoints — calling a transaction-wrapped fn inside another is fine.
- Tests: in-memory DB per test (`openDb(':memory:')`), `describe/it/expect`, helpers in `tests/helpers.ts`. HTTP tests use `app.inject`.
- Commit after each task with the given message. Never use `--no-verify`.

---

### Task 1: Rating engine (`src/rating.ts`)

**Files:**
- Create: `src/rating.ts`
- Modify: `src/players.ts` (season-parameterized `ensureRating`)
- Test: `tests/rating.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/rating.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { displaySr, applyMatchRatings } from '../src/rating.js';
import { upsertPlayer, ensureRating } from '../src/players.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);

function seedCompletedMatch(db: DB, winner: 'a' | 'b' | 'draw'): number {
  for (const id of IDS) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
  const matchId = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign, winner, team_a_score, team_b_score, ended_at) VALUES (1, 'completed', 'no_mercy', ?, 100, 200, datetime('now'))")
      .run(winner).lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  return matchId;
}

describe('displaySr', () => {
  it('is round((mu - 2*sigma) * 100), floored at 0', () => {
    expect(displaySr(25, 25 / 3)).toBe(833); // openskill defaults
    expect(displaySr(30, 5)).toBe(2000);
    expect(displaySr(1, 10)).toBe(0); // floor
  });
});

describe('applyMatchRatings', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });

  it('raises winners, lowers losers, records history and W/L', () => {
    const matchId = seedCompletedMatch(db, 'b');
    applyMatchRatings(db, matchId);
    const a0 = ensureRating(db, IDS[0]); // team a, lost
    const b0 = ensureRating(db, IDS[4]); // team b, won
    expect(b0.mu).toBeGreaterThan(25);
    expect(a0.mu).toBeLessThan(25);
    expect(b0.sigma).toBeLessThan(25 / 3); // sigma shrinks with information
    expect(b0.wins).toBe(1);
    expect(b0.losses).toBe(0);
    expect(a0.wins).toBe(0);
    expect(a0.losses).toBe(1);
    const hist = db.prepare('SELECT * FROM rating_history WHERE match_id = ?').all(matchId) as any[];
    expect(hist).toHaveLength(8);
    expect(hist[0].mu_before).toBe(25);
  });

  it('draw: mus barely move, no wins/losses counted', () => {
    const matchId = seedCompletedMatch(db, 'draw');
    applyMatchRatings(db, matchId);
    const r = ensureRating(db, IDS[0]);
    expect(r.wins).toBe(0);
    expect(r.losses).toBe(0);
    expect(Math.abs(r.mu - 25)).toBeLessThan(0.5); // equal teams draw ≈ no shift
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
  });

  it('is idempotent — second call is a no-op', () => {
    const matchId = seedCompletedMatch(db, 'a');
    applyMatchRatings(db, matchId);
    const first = ensureRating(db, IDS[0]).mu;
    applyMatchRatings(db, matchId);
    expect(ensureRating(db, IDS[0]).mu).toBe(first);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
  });

  it('ignores non-completed matches', () => {
    const matchId = seedCompletedMatch(db, 'a');
    db.prepare("UPDATE matches SET state = 'live', winner = NULL WHERE id = ?").run(matchId);
    applyMatchRatings(db, matchId);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history').get()).toEqual({ n: 0 });
  });

  it('uses the match season, not the current season', () => {
    const matchId = seedCompletedMatch(db, 'a');
    // close season 1, open season 2 — the match still belongs to season 1
    db.prepare("UPDATE seasons SET ended_at = datetime('now') WHERE id = 1").run();
    db.prepare("INSERT INTO seasons (name) VALUES ('Season 2')").run();
    applyMatchRatings(db, matchId);
    const row = db.prepare('SELECT season_id FROM rating_history WHERE match_id = ? LIMIT 1').get(matchId) as any;
    expect(row.season_id).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rating.test.ts`
Expected: FAIL — cannot resolve `../src/rating.js`.

- [ ] **Step 3: Season-parameterize `ensureRating` in `src/players.ts`**

Replace the existing `ensureRating` (keep everything else):

```ts
export function ensureRating(db: DB, steamid: string, seasonId?: number): RatingRow {
  const season = seasonId ?? currentSeasonId(db);
  const existing = db
    .prepare('SELECT * FROM player_ratings WHERE player_id = ? AND season_id = ?')
    .get(steamid, season) as RatingRow | undefined;
  if (existing) return existing;
  const r = rating(); // openskill defaults: mu=25, sigma=25/3
  db.prepare(
    'INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, ?, ?)',
  ).run(steamid, season, r.mu, r.sigma);
  return { player_id: steamid, season_id: season, mu: r.mu, sigma: r.sigma, wins: 0, losses: 0 };
}
```

- [ ] **Step 4: Implement `src/rating.ts`**

```ts
import { rating, rate } from 'openskill';
import type { DB } from './db.js';
import { ensureRating } from './players.js';

/** Cosmetic SR shown on site. Stored mu/sigma remain canonical. */
export function displaySr(mu: number, sigma: number): number {
  return Math.max(0, Math.round((mu - 2 * sigma) * 100));
}

interface MpRow { player_id: string; team: 'a' | 'b' }

/** Apply OpenSkill updates for a completed match: player_ratings mu/sigma/W-L
 *  plus one rating_history row per player. Idempotent via rating_history guard.
 *  Draws update mu/sigma (rank tie) but count as neither win nor loss. */
export function applyMatchRatings(db: DB, matchId: number): void {
  const match = db
    .prepare('SELECT id, season_id, state, winner FROM matches WHERE id = ?')
    .get(matchId) as { id: number; season_id: number; state: string; winner: 'a' | 'b' | 'draw' | null } | undefined;
  if (!match || match.state !== 'completed' || !match.winner) return;
  if (db.prepare('SELECT 1 FROM rating_history WHERE match_id = ? LIMIT 1').get(matchId)) return;

  const mps = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?').all(matchId) as MpRow[];
  const teamA = mps.filter((r) => r.team === 'a').map((r) => r.player_id);
  const teamB = mps.filter((r) => r.team === 'b').map((r) => r.player_id);
  if (teamA.length === 0 || teamB.length === 0) return;

  const before = new Map(mps.map((r) => [r.player_id, ensureRating(db, r.player_id, match.season_id)]));
  const rank = match.winner === 'a' ? [1, 2] : match.winner === 'b' ? [2, 1] : [1, 1];
  const [newA, newB] = rate(
    [teamA.map((id) => rating(before.get(id)!)), teamB.map((id) => rating(before.get(id)!))],
    { rank },
  );

  db.transaction(() => {
    const upd = db.prepare(
      'UPDATE player_ratings SET mu = ?, sigma = ?, wins = wins + ?, losses = losses + ? WHERE player_id = ? AND season_id = ?',
    );
    const hist = db.prepare(
      `INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const apply = (ids: string[], rated: { mu: number; sigma: number }[], won: boolean, lost: boolean) => {
      ids.forEach((id, i) => {
        const b = before.get(id)!;
        upd.run(rated[i].mu, rated[i].sigma, won ? 1 : 0, lost ? 1 : 0, id, match.season_id);
        hist.run(id, matchId, match.season_id, b.mu, b.sigma, rated[i].mu, rated[i].sigma);
      });
    };
    apply(teamA, newA, match.winner === 'a', match.winner === 'b');
    apply(teamB, newB, match.winner === 'b', match.winner === 'a');
  })();
}
```

- [ ] **Step 5: Run the new tests, then the full suite + typecheck**

Run: `npx vitest run tests/rating.test.ts` → PASS.
Run: `npm test && npm run typecheck` → all green (ensureRating change is backwards compatible).

- [ ] **Step 6: Commit**

```bash
git add src/rating.ts src/players.ts tests/rating.test.ts
git commit -m "feat: openskill post-match rating engine + displayed SR"
```

---

### Task 2: `match_maps` table + `completeMatch` (`src/matchResult.ts`), orchestrator refactor

**Files:**
- Modify: `src/db.ts` (add `match_maps` to SCHEMA)
- Create: `src/matchResult.ts`
- Modify: `src/orchestrator.ts` (replace private `persist` with `completeMatch` call)
- Test: `tests/matchResult.test.ts`; Modify: `tests/db.test.ts` (table list)

- [ ] **Step 1: Add the table to `src/db.ts` SCHEMA** (after the `match_players` block):

```sql
CREATE TABLE IF NOT EXISTS match_maps (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  ordinal INTEGER NOT NULL,
  map TEXT NOT NULL,
  team_a_score INTEGER NOT NULL DEFAULT 0,
  team_b_score INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, ordinal)
);
```

Update `tests/db.test.ts` expected table list to (alphabetical):

```ts
expect(names).toEqual([
  'match_maps', 'match_players', 'matches', 'player_ratings', 'players',
  'rating_history', 'seasons', 'servers', 'settings',
]);
```

Note: SCHEMA is `CREATE TABLE IF NOT EXISTS` — new tables appear on existing DBs at next boot; no migration needed. (The live Dallas deploy is not running this backend yet.)

- [ ] **Step 2: Write the failing tests**

Create `tests/matchResult.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { completeMatch } from '../src/matchResult.js';
import { upsertPlayer } from '../src/players.js';
import type { Dump } from '../src/dumpParse.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);

function seedLiveMatch(db: DB): number {
  for (const id of IDS) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
  const matchId = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run().lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  return matchId;
}

function dumpFor(matchId: number): Dump {
  return {
    matchId,
    maps: [
      { map: 'l4d_hospital01_apartment', a: 100, b: 150 },
      { map: 'l4d_hospital02_subway', a: 120, b: 160 },
    ],
    players: IDS.map((steamid, i) => ({
      steamid, team: i < 4 ? 'a' : 'b', sidmg: 1000 + i, sikill: i, ck: 200 + i, ff: 10 + i, rev: i % 3,
    })),
    winner: 'b',
    totalA: 220,
    totalB: 310,
  };
}

describe('completeMatch', () => {
  let db: DB;
  let matchId: number;
  beforeEach(() => { db = openDb(':memory:'); matchId = seedLiveMatch(db); });

  it('persists match result, per-map scores, per-player stats, and ratings in one go', () => {
    expect(completeMatch(db, matchId, dumpFor(matchId))).toBe(true);
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as any;
    expect(m.state).toBe('completed');
    expect(m.team_a_score).toBe(220);
    expect(m.team_b_score).toBe(310);
    expect(m.winner).toBe('b');
    expect(m.ended_at).toBeTruthy();
    const maps = db.prepare('SELECT * FROM match_maps WHERE match_id = ? ORDER BY ordinal').all(matchId) as any[];
    expect(maps).toHaveLength(2);
    expect(maps[0]).toMatchObject({ ordinal: 0, map: 'l4d_hospital01_apartment', team_a_score: 100, team_b_score: 150 });
    const mp = db.prepare('SELECT * FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, IDS[0]) as any;
    expect(mp.si_damage).toBe(1000);
    expect(JSON.parse(mp.stats_json).sidmg).toBe('1000');
    // ratings applied
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
    const winner = db.prepare('SELECT * FROM player_ratings WHERE player_id = ?').get(IDS[4]) as any;
    expect(winner.wins).toBe(1);
  });

  it('refuses already-completed or aborted matches', () => {
    completeMatch(db, matchId, dumpFor(matchId));
    expect(completeMatch(db, matchId, dumpFor(matchId))).toBe(false);
    const other = seedLiveMatch(db); // fresh match, then abort it
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(other);
    expect(completeMatch(db, other, dumpFor(other))).toBe(false);
  });
});
```

Note: the second seedLiveMatch reuses the same 8 players — `upsertPlayer` is an upsert, so that's fine.

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run tests/matchResult.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `src/matchResult.ts`**

```ts
import type { DB } from './db.js';
import type { Dump } from './dumpParse.js';
import { applyMatchRatings } from './rating.js';

/** Persist a finished match (result, per-map scores, per-player stats) and
 *  apply ratings, atomically. Returns false when the match is missing or
 *  already completed/aborted. The single write-path for match completion —
 *  used by the real orchestrator and by dev-mode simulation. */
export function completeMatch(db: DB, matchId: number, d: Dump): boolean {
  const row = db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as { state: string } | undefined;
  if (!row || row.state === 'completed' || row.state === 'aborted') return false;
  db.transaction(() => {
    db.prepare(
      "UPDATE matches SET state = 'completed', team_a_score = ?, team_b_score = ?, winner = ?, ended_at = datetime('now') WHERE id = ?",
    ).run(d.totalA, d.totalB, d.winner, matchId);
    const insMap = db.prepare(
      'INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)',
    );
    d.maps.forEach((m, i) => insMap.run(matchId, i, m.map, m.a, m.b));
    const upd = db.prepare(
      `UPDATE match_players SET si_damage = ?, si_kills = ?, common_kills = ?, ff_dealt = ?, revives = ?, stats_json = ?
       WHERE match_id = ? AND player_id = ?`,
    );
    for (const p of d.players) {
      upd.run(p.sidmg, p.sikill, p.ck, p.ff, p.rev,
        JSON.stringify({ sidmg: String(p.sidmg), sikill: String(p.sikill), ck: String(p.ck), ff: String(p.ff), rev: String(p.rev) }),
        matchId, p.steamid);
    }
    applyMatchRatings(db, matchId);
  })();
  return true;
}
```

- [ ] **Step 5: Refactor `src/orchestrator.ts` to use it**

Add import `import { completeMatch } from './matchResult.js';`, delete the entire private `persist` method and the now-unused `import { parseDump, type Dump }` Dump type import if unreferenced (keep `parseDump`). In `finishMatch`, replace:

```ts
      this.persist(matchId, dump);
      persisted = true;
```

with:

```ts
      persisted = completeMatch(this.db, matchId, dump);
      if (!persisted) {
        console.error(`[orchestrator] match ${matchId} was not completable (state changed?); skipping`);
        return;
      }
```

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green — orchestrator e2e tests now also exercise map/rating persistence. If an orchestrator test seeds match_players without players rows and FK errors appear on player_ratings, fix the TEST seed to insert players first (players are always real rows in production).

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/matchResult.ts src/orchestrator.ts tests/matchResult.test.ts tests/db.test.ts
git commit -m "feat: match_maps table + shared completeMatch write-path with ratings"
```

---

### Task 3: Discord notifier + wiring

**Files:**
- Create: `src/discord.ts`
- Modify: `src/db.ts` (DEFAULT_SETTINGS), `src/matchmaker.ts` (notify dep + queue/pop pings), `src/orchestrator.ts` (notify dep + live/result pings), `src/server.ts` (wire notify)
- Test: `tests/discord.test.ts`; Modify: `tests/matchmaker.test.ts` only if constructor typing forces it (dep is optional — it shouldn't)

- [ ] **Step 1: Failing tests** — `tests/discord.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { notifyDiscord } from '../src/discord.js';

describe('notifyDiscord', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });

  it('no-ops when webhook url is unset/empty', () => {
    const fetchFn = vi.fn();
    notifyDiscord(db, 'hello', fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('POSTs {content} to the configured webhook', () => {
    setSetting(db, 'discord_webhook_url', 'https://discord.test/hook');
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    notifyDiscord(db, 'match live', fetchFn);
    expect(fetchFn).toHaveBeenCalledWith('https://discord.test/hook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'match live' }),
    });
  });

  it('swallows fetch failures', async () => {
    setSetting(db, 'discord_webhook_url', 'https://discord.test/hook');
    const fetchFn = vi.fn().mockRejectedValue(new Error('down'));
    expect(() => notifyDiscord(db, 'x', fetchFn)).not.toThrow();
    await new Promise((r) => setImmediate(r)); // let the rejection settle
  });
});
```

- [ ] **Step 2: Run to fail** — `npx vitest run tests/discord.test.ts` → module missing.

- [ ] **Step 3: Implement `src/discord.ts`**

```ts
import type { DB } from './db.js';
import { getSetting } from './settings.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<unknown>;

/** Fire-and-forget Discord webhook message. No-op when discord_webhook_url is
 *  unset or empty; never throws (a dead webhook must not break matchmaking). */
export function notifyDiscord(db: DB, content: string, fetchFn: FetchLike = fetch as unknown as FetchLike): void {
  const url = getSetting(db, 'discord_webhook_url');
  if (!url) return;
  Promise.resolve(
    fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
  ).catch((err) => console.error('[discord] webhook post failed:', err));
}
```

- [ ] **Step 4: Settings defaults** — in `src/db.ts` DEFAULT_SETTINGS add:

```ts
  discord_webhook_url: '',
  discord_queue_thresholds: JSON.stringify([4, 6]),
```

(`notifyDiscord` treats `''` as unset. `tests/db.test.ts` doesn't assert the full settings list, only specific keys — no change needed there.)

- [ ] **Step 5: Matchmaker pings** — in `src/matchmaker.ts`:

Add to `MatchmakerDeps`:

```ts
  /** Optional out-of-band notification hook (Discord). Must never throw. */
  notify?: (msg: string) => void;
```

In `join()`, after `this.queue.join(steamid);` and BEFORE `this.maybeStartLobby();`:

```ts
    const thresholds = JSON.parse(getSetting(this.db, 'discord_queue_thresholds') ?? '[]') as number[];
    if (thresholds.includes(this.queue.count())) {
      this.deps.notify?.(`🧟 ${this.queue.count()}/${QUEUE_SIZE} in queue`);
    }
```

In `maybeStartLobby()`, right after `this.lobbies.set(id, lobby);`:

```ts
      this.deps.notify?.('🔔 Queue popped — ready check started!');
```

- [ ] **Step 6: Orchestrator pings** — in `src/orchestrator.ts`:

Add to `RealOrchestratorDeps`: `notify?: (msg: string) => void;` and store it (`private notify: (msg: string) => void;` initialized `deps.notify ?? (() => {})` in the constructor). Import `CAMPAIGNS` from `./campaigns.js`.

In `setupMatch`, right after the `state = 'live'` UPDATE:

```ts
      this.notify(`🎮 Match #${matchId} is live — ${CAMPAIGNS[match.campaign]?.name ?? match.campaign} on ${server.name}`);
```

(`ServerRow` already carries `name` — verify in `src/serverPool.ts` and adjust the accessor if the field differs.)

In `finishMatch`, inside the `if (persisted) { ... }` block:

```ts
      const winnerText = dump.winner === 'draw' ? 'Draw' : dump.winner === 'a' ? 'Team A wins' : 'Team B wins';
      this.notify(`🏁 Match #${matchId} final: Team A ${dump.totalA} — Team B ${dump.totalB}. ${winnerText}!`);
```

`dump` must be in scope there — declare `let dump: Dump | null = null;` alongside `persisted` and assign inside the try (keep the `Dump` type import). Guard with `if (persisted && dump)`.

- [ ] **Step 7: Wire in `src/server.ts`**

```ts
import { notifyDiscord } from './discord.js';
```

Before the orchestrator block: `const notify = (msg: string) => notifyDiscord(deps.db, msg);`
Pass `notify` into `new RealOrchestrator({ ... , notify })` and into the Matchmaker deps: `{ broadcast: ..., orchestrator, notify }`.

- [ ] **Step 8: Full suite + typecheck** — `npm test && npm run typecheck` → green (notify is optional everywhere; existing tests unaffected).

- [ ] **Step 9: Commit**

```bash
git add src/discord.ts src/db.ts src/matchmaker.ts src/orchestrator.ts src/server.ts tests/discord.test.ts
git commit -m "feat: discord webhook notifications (queue thresholds, pop, live, result)"
```

---

### Task 4: Read API — leaderboard, profiles, match history

**Files:**
- Create: `src/routes/guards.ts`, `src/routes/stats.ts`
- Modify: `src/routes/api.ts` (use shared guard), `src/server.ts` (register statsRoutes)
- Test: `tests/stats.test.ts`

- [ ] **Step 1: Extract the guard** — create `src/routes/guards.ts`:

```ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { getSession } from '../session.js';
import { getPlayer } from '../players.js';

/** Returns a per-route guard: steamid of an active player, or sends the
 *  401/403 reply and returns null. */
export function makeRequireActive(db: DB) {
  return function requireActive(req: FastifyRequest, reply: FastifyReply): string | null {
    const steamid = getSession(req);
    if (!steamid) {
      reply.code(401).send({ error: 'not logged in' });
      return null;
    }
    const player = getPlayer(db, steamid);
    if (!player || player.status !== 'active') {
      reply.code(403).send({ error: 'not an active player' });
      return null;
    }
    return steamid;
  };
}
```

In `src/routes/api.ts`: delete the inline `requireActive` and its `getSession`/`getPlayer` imports; add `import { makeRequireActive } from './guards.js';` and `const requireActive = makeRequireActive(db);` at the top of `apiRoutes`. Behavior identical; `npx vitest run tests/api.test.ts` must stay green.

- [ ] **Step 2: Failing tests** — `tests/stats.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { completeMatch } from '../src/matchResult.js';
import { upsertPlayer } from '../src/players.js';
import type { Dump } from '../src/dumpParse.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ME = IDS[0];

function config() {
  return {
    port: 0, publicUrl: 'http://localhost', cookieSecret: 'test-secret-test-secret-test-secret',
    steamApiKey: '', dbPath: ':memory:', devMode: false, adminSteamIds: [],
    logListenPort: 0, logPublicAddress: '127.0.0.1:0',
  };
}

function playCompletedMatch(db: DB, winner: 'a' | 'b' | 'draw' = 'b'): number {
  const matchId = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run().lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  const totalA = winner === 'a' ? 300 : 200;
  const totalB = winner === 'b' ? 300 : 200;
  const dump: Dump = {
    matchId,
    maps: [{ map: 'm1', a: totalA, b: totalB }],
    players: IDS.map((steamid, i) => ({ steamid, team: i < 4 ? 'a' : 'b', sidmg: 500, sikill: 5, ck: 100, ff: 20, rev: 1 })),
    winner: winner === 'draw' && totalA === totalB ? 'draw' : winner,
    totalA, totalB,
  };
  completeMatch(db, matchId, dump);
  return matchId;
}

describe('stats routes', () => {
  let db: DB;
  let app: FastifyInstance;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    db = openDb(':memory:');
    app = await buildServer({ config: config() as any, db, orchestrator: stubOrchestrator() });
    for (const id of IDS) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    cookies = authedCookie(app, db, ME);
  });
  afterEach(async () => { await app.close(); });

  it('requires auth', async () => {
    for (const url of ['/api/leaderboard', `/api/players/${ME}`, '/api/matches', '/api/matches/1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('leaderboard: SR-sorted current-season rows with games count', async () => {
    playCompletedMatch(db, 'b');
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard', cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.season.id).toBe(1);
    expect(body.rows).toHaveLength(8);
    expect(body.rows[0].sr).toBeGreaterThanOrEqual(body.rows[7].sr);
    const winner = body.rows.find((r: any) => r.steamid === IDS[4]);
    expect(winner.wins).toBe(1);
    expect(winner.games).toBe(1);
    expect(typeof winner.sr).toBe('number');
    expect(winner.name).toBe('p4');
  });

  it('profile: rating, totals, recent matches with SR delta, history', async () => {
    playCompletedMatch(db, 'a');
    const res = await app.inject({ method: 'GET', url: `/api/players/${ME}`, cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.player.steamid).toBe(ME);
    expect(body.rating.wins).toBe(1);
    expect(body.totals.games).toBe(1);
    expect(body.totals.si_damage).toBe(500);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].result).toBe('win');
    expect(typeof body.matches[0].srDelta).toBe('number');
    expect(body.history).toHaveLength(1);
    expect(typeof body.history[0].sr).toBe('number');
    expect(await (await app.inject({ method: 'GET', url: '/api/players/76561190000000000', cookies })).statusCode).toBe(404);
  });

  it('match list and detail', async () => {
    const matchId = playCompletedMatch(db, 'b');
    const list = (await app.inject({ method: 'GET', url: '/api/matches', cookies })).json();
    expect(list.matches).toHaveLength(1);
    expect(list.matches[0]).toMatchObject({ id: matchId, campaign: 'no_mercy', winner: 'b' });
    const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}`, cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.match.id).toBe(matchId);
    expect(body.maps).toHaveLength(1);
    expect(body.players).toHaveLength(8);
    const p = body.players.find((x: any) => x.steamid === ME);
    expect(p.team).toBe('a');
    expect(p.si_damage).toBe(500);
    expect(typeof p.srDelta).toBe('number');
    expect((await app.inject({ method: 'GET', url: '/api/matches/999', cookies })).statusCode).toBe(404);
  });
});
```

Check `tests/http-e2e.test.ts` / `tests/api.test.ts` for how `config` objects are actually built (there may be a `loadConfig`/factory to reuse instead of the inline literal above — mirror the existing pattern exactly).

- [ ] **Step 3: Run to fail** — `npx vitest run tests/stats.test.ts` → 404s (routes missing).

- [ ] **Step 4: Implement `src/routes/stats.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireActive } from './guards.js';
import { displaySr } from '../rating.js';
import { getPlayer, currentSeasonId } from '../players.js';

export interface StatsRouteOpts { db: DB }

const RECENT_MATCH_LIMIT = 50;
const PROFILE_MATCH_LIMIT = 20;

export async function statsRoutes(app: FastifyInstance, opts: StatsRouteOpts): Promise<void> {
  const { db } = opts;
  const requireActive = makeRequireActive(db);

  app.get('/api/leaderboard', async (req, reply) => {
    if (!requireActive(req, reply)) return;
    const seasonId = currentSeasonId(db);
    const season = db.prepare('SELECT id, name FROM seasons WHERE id = ?').get(seasonId) as { id: number; name: string };
    const rows = db.prepare(
      `SELECT pr.player_id AS steamid, p.name, p.avatar, pr.mu, pr.sigma, pr.wins, pr.losses,
              (SELECT COUNT(*) FROM rating_history rh WHERE rh.player_id = pr.player_id AND rh.season_id = pr.season_id) AS games
       FROM player_ratings pr JOIN players p ON p.steamid = pr.player_id
       WHERE pr.season_id = ?`,
    ).all(seasonId) as { steamid: string; name: string; avatar: string | null; mu: number; sigma: number; wins: number; losses: number; games: number }[];
    return {
      season,
      rows: rows
        .map((r) => ({ steamid: r.steamid, name: r.name, avatar: r.avatar, sr: displaySr(r.mu, r.sigma), wins: r.wins, losses: r.losses, games: r.games }))
        .sort((x, y) => y.sr - x.sr),
    };
  });

  app.get('/api/players/:steamid', async (req, reply) => {
    if (!requireActive(req, reply)) return;
    const { steamid } = req.params as { steamid: string };
    const player = getPlayer(db, steamid);
    if (!player) return reply.code(404).send({ error: 'no such player' });
    const seasonId = currentSeasonId(db);

    const r = db.prepare('SELECT mu, sigma, wins, losses FROM player_ratings WHERE player_id = ? AND season_id = ?')
      .get(steamid, seasonId) as { mu: number; sigma: number; wins: number; losses: number } | undefined;

    const totals = db.prepare(
      `SELECT COUNT(*) AS games, COALESCE(SUM(mp.si_damage),0) AS si_damage, COALESCE(SUM(mp.si_kills),0) AS si_kills,
              COALESCE(SUM(mp.common_kills),0) AS common_kills, COALESCE(SUM(mp.ff_dealt),0) AS ff_dealt, COALESCE(SUM(mp.revives),0) AS revives
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ? AND m.state = 'completed'`,
    ).get(steamid) as { games: number; si_damage: number; si_kills: number; common_kills: number; ff_dealt: number; revives: number };

    const matches = (db.prepare(
      `SELECT m.id, m.campaign, m.ended_at, m.team_a_score, m.team_b_score, m.winner, mp.team,
              rh.mu_before, rh.sigma_before, rh.mu_after, rh.sigma_after
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       LEFT JOIN rating_history rh ON rh.match_id = m.id AND rh.player_id = mp.player_id
       WHERE mp.player_id = ? AND m.state = 'completed'
       ORDER BY m.id DESC LIMIT ?`,
    ).all(steamid, PROFILE_MATCH_LIMIT) as any[]).map((m) => ({
      id: m.id, campaign: m.campaign, endedAt: m.ended_at,
      teamAScore: m.team_a_score, teamBScore: m.team_b_score, team: m.team,
      result: m.winner === 'draw' ? 'draw' : m.winner === m.team ? 'win' : 'loss',
      srDelta: m.mu_after === null ? 0
        : displaySr(m.mu_after, m.sigma_after) - displaySr(m.mu_before, m.sigma_before),
    }));

    const history = (db.prepare(
      'SELECT match_id, mu_after, sigma_after FROM rating_history WHERE player_id = ? AND season_id = ? ORDER BY id',
    ).all(steamid, seasonId) as any[]).map((h) => ({ matchId: h.match_id, sr: displaySr(h.mu_after, h.sigma_after) }));

    return {
      player: { steamid: player.steamid, name: player.name, avatar: player.avatar, createdAt: player.created_at },
      rating: r ? { sr: displaySr(r.mu, r.sigma), mu: r.mu, sigma: r.sigma, wins: r.wins, losses: r.losses } : null,
      totals, matches, history,
    };
  });

  app.get('/api/matches', async (req, reply) => {
    if (!requireActive(req, reply)) return;
    const matches = db.prepare(
      `SELECT id, campaign, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore, winner
       FROM matches WHERE state = 'completed' ORDER BY id DESC LIMIT ?`,
    ).all(RECENT_MATCH_LIMIT);
    return { matches };
  });

  app.get('/api/matches/:id', async (req, reply) => {
    if (!requireActive(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const match = db.prepare(
      `SELECT id, campaign, state, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore, winner
       FROM matches WHERE id = ? AND state = 'completed'`,
    ).get(id);
    if (!match) return reply.code(404).send({ error: 'no such match' });
    const maps = db.prepare(
      'SELECT ordinal, map, team_a_score AS teamAScore, team_b_score AS teamBScore FROM match_maps WHERE match_id = ? ORDER BY ordinal',
    ).all(id);
    const players = (db.prepare(
      `SELECT mp.player_id AS steamid, p.name, mp.team, mp.si_damage, mp.si_kills, mp.common_kills, mp.ff_dealt, mp.revives,
              rh.mu_before, rh.sigma_before, rh.mu_after, rh.sigma_after
       FROM match_players mp
       JOIN players p ON p.steamid = mp.player_id
       LEFT JOIN rating_history rh ON rh.match_id = mp.match_id AND rh.player_id = mp.player_id
       WHERE mp.match_id = ?`,
    ).all(id) as any[]).map((p) => ({
      steamid: p.steamid, name: p.name, team: p.team,
      si_damage: p.si_damage, si_kills: p.si_kills, common_kills: p.common_kills, ff_dealt: p.ff_dealt, revives: p.revives,
      srDelta: p.mu_after === null ? 0
        : displaySr(p.mu_after, p.sigma_after) - displaySr(p.mu_before, p.sigma_before),
    }));
    return { match, maps, players };
  });
}
```

- [ ] **Step 5: Register in `src/server.ts`** — after `apiRoutes`:

```ts
import { statsRoutes } from './routes/stats.js';
// ...
await app.register(statsRoutes, { db: deps.db });
```

- [ ] **Step 6: Run** — `npx vitest run tests/stats.test.ts tests/api.test.ts` → PASS, then `npm test && npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/guards.ts src/routes/stats.ts src/routes/api.ts src/server.ts tests/stats.test.ts
git commit -m "feat: leaderboard, profile, and match history read API"
```

---

### Task 5: Dev-mode match simulation

**Files:**
- Modify: `src/routes/dev.ts`
- Test: `tests/dev.test.ts` (extend)

- [ ] **Step 1: Failing tests** — append to `tests/dev.test.ts` (mirror its existing setup; it already builds a dev-mode server):

```ts
  it('finish-match completes the open match with fake stats and ratings', async () => {
    await app.inject({ method: 'POST', url: '/api/dev/fill' });
    await app.inject({ method: 'POST', url: '/api/dev/ready-all' });
    await app.inject({ method: 'POST', url: '/api/dev/vote-all' });
    const res = await app.inject({ method: 'POST', url: '/api/dev/finish-match' });
    expect(res.statusCode).toBe(200);
    const { matchId } = res.json();
    const m = db.prepare('SELECT state, winner FROM matches WHERE id = ?').get(matchId) as any;
    expect(m.state).toBe('completed');
    expect(['a', 'b', 'draw']).toContain(m.winner);
    expect((db.prepare('SELECT COUNT(*) n FROM match_maps WHERE match_id = ?').get(matchId) as any).n).toBe(4);
    expect((db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId) as any).n).toBe(8);
  });

  it('finish-match 409s with no open match', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dev/finish-match' });
    expect(res.statusCode).toBe(409);
  });

  it('simulate-match runs a full fake match in one call', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dev/simulate-match' });
    expect(res.statusCode).toBe(200);
    const { matchId } = res.json();
    expect((db.prepare("SELECT state FROM matches WHERE id = ?").get(matchId) as any).state).toBe('completed');
  });
```

Note: `/api/dev/fill` uses a module-level `fakeSeq` counter, so fake steamids differ across tests — fine, players are upserted per test DB.

- [ ] **Step 2: Run to fail** — `npx vitest run tests/dev.test.ts`.

- [ ] **Step 3: Implement** — in `src/routes/dev.ts` add imports:

```ts
import { completeMatch } from '../matchResult.js';
import type { Dump } from '../dumpParse.js';
```

Add inside `devRoutes` (near the other routes):

```ts
  function fakeDump(matchId: number, campaign: string, players: { player_id: string; team: 'a' | 'b' }[]): Dump {
    const rnd = (n: number) => Math.floor(Math.random() * n);
    const maps = Array.from({ length: 4 }, (_, i) => ({ map: `${campaign}_m${i + 1}`, a: rnd(400), b: rnd(400) }));
    const totalA = maps.reduce((s, m) => s + m.a, 0);
    const totalB = maps.reduce((s, m) => s + m.b, 0);
    return {
      matchId, maps,
      players: players.map((p) => ({
        steamid: p.player_id, team: p.team,
        sidmg: rnd(2500), sikill: rnd(40), ck: rnd(600), ff: rnd(120), rev: rnd(8),
      })),
      winner: totalA === totalB ? 'draw' : totalA > totalB ? 'a' : 'b',
      totalA, totalB,
    };
  }

  function finishOpenMatch(): number | null {
    const row = db.prepare("SELECT id, campaign FROM matches WHERE state IN ('configuring','live') ORDER BY id DESC LIMIT 1")
      .get() as { id: number; campaign: string } | undefined;
    if (!row) return null;
    const players = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
      .all(row.id) as { player_id: string; team: 'a' | 'b' }[];
    completeMatch(db, row.id, fakeDump(row.id, row.campaign, players));
    opts.hub.broadcast('refresh');
    return row.id;
  }

  /** Complete the newest open match with fabricated scores/stats + real rating updates. */
  app.post('/api/dev/finish-match', async (_req, reply) => {
    const matchId = finishOpenMatch();
    if (matchId === null) return reply.code(409).send({ error: 'no open match' });
    return { ok: true, matchId };
  });

  /** One-click full fake match: fill queue → ready → vote → finish. */
  app.post('/api/dev/simulate-match', async (_req, reply) => {
    await app.inject({ method: 'POST', url: '/api/dev/fill' });
    await app.inject({ method: 'POST', url: '/api/dev/ready-all' });
    await app.inject({ method: 'POST', url: '/api/dev/vote-all' });
    const matchId = finishOpenMatch();
    if (matchId === null) return reply.code(409).send({ error: 'simulation did not produce an open match' });
    return { ok: true, matchId };
  });
```

(If self-`app.inject` inside a handler misbehaves, refactor the bodies of fill/ready-all/vote-all into local `fillQueue()`, `readyAll()`, `voteAll()` functions and have both the routes and simulate-match call those directly — preferred if any flakiness appears.)

- [ ] **Step 4: Run** — `npx vitest run tests/dev.test.ts` → PASS; `npm test && npm run typecheck` → green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/dev.ts tests/dev.test.ts
git commit -m "feat: dev-mode fake match completion + one-click simulate"
```

---

### Task 6: Frontend — nav, leaderboard, matches, match detail, profile

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/style.css`

No unit tests (no frontend test rig); verification is `npm run dev` + the overseer's browser pass. Keep the existing vanilla style: `$()`, `esc()`, innerHTML templates.

- [ ] **Step 1: `public/index.html`** — replace `<header>` contents with:

```html
  <header>
    <h1>L4D1 PUG</h1>
    <nav>
      <a href="#/">Play</a>
      <a href="#/leaderboard">Leaderboard</a>
      <a href="#/matches">Matches</a>
    </nav>
    <div id="whoami"></div>
  </header>
```

Add before `</main>`:

```html
    <section id="leaderboard" hidden>
      <h2>Leaderboard — <span id="lb-season"></span></h2>
      <div id="lb-body"></div>
    </section>

    <section id="matches-page" hidden>
      <h2>Recent matches</h2>
      <div id="matches-body"></div>
    </section>

    <section id="match-detail" hidden>
      <div id="match-detail-body"></div>
    </section>

    <section id="profile" hidden>
      <div id="profile-body"></div>
    </section>
```

Make `#whoami` a profile link target (handled in JS below).

- [ ] **Step 2: `public/app.js`** — add routing + page renderers.

After the `esc` helper add:

```js
const RESULT_LABEL = { win: 'W', loss: 'L', draw: 'D' };

function fmtDate(iso) {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '';
}

function srDeltaHtml(d) {
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : '';
  return `<span class="delta ${cls}">${d > 0 ? '+' : ''}${d}</span>`;
}

function sparkline(values, w = 560, h = 80) {
  if (values.length < 2) return '<p class="note">Not enough matches for a graph yet.</p>';
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 5 - ((v - min) / span) * (h - 10)).toFixed(1)}`)
    .join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (res.status === 401 || res.status === 403) { location.hash = '#/'; refresh(); return null; }
  if (!res.ok) return null;
  return res.json();
}
```

Replace the bottom bootstrap block (`setInterval` … `refresh();`) with a router:

```js
function playerLink(p) {
  return `<a href="#/player/${esc(p.steamid)}">${esc(p.name)}</a>`;
}

async function renderLeaderboard() {
  const data = await fetchJson('/api/leaderboard');
  if (!data) return;
  $('lb-season').textContent = data.season.name;
  $('lb-body').innerHTML = data.rows.length === 0
    ? '<p class="note">No rated players yet.</p>'
    : `<table><thead><tr><th>#</th><th>Player</th><th>SR</th><th>W</th><th>L</th><th>Games</th></tr></thead><tbody>` +
      data.rows.map((r, i) =>
        `<tr><td>${i + 1}</td><td>${playerLink(r)}</td><td class="sr">${r.sr}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.games}</td></tr>`,
      ).join('') + '</tbody></table>';
  show('leaderboard');
}

async function renderMatches() {
  const data = await fetchJson('/api/matches');
  if (!data) return;
  $('matches-body').innerHTML = data.matches.length === 0
    ? '<p class="note">No completed matches yet.</p>'
    : `<table><thead><tr><th>#</th><th>Campaign</th><th>Score</th><th>Winner</th><th>Ended</th></tr></thead><tbody>` +
      data.matches.map((m) =>
        `<tr><td><a href="#/match/${m.id}">${m.id}</a></td><td>${esc(CAMPAIGN_NAMES[m.campaign] ?? m.campaign)}</td>` +
        `<td>${m.teamAScore} — ${m.teamBScore}</td><td>${m.winner === 'draw' ? 'Draw' : `Team ${m.winner.toUpperCase()}`}</td>` +
        `<td>${esc(fmtDate(m.endedAt))}</td></tr>`,
      ).join('') + '</tbody></table>';
  show('matches-page');
}

async function renderMatchDetail(id) {
  const data = await fetchJson(`/api/matches/${encodeURIComponent(id)}`);
  if (!data) { $('match-detail-body').innerHTML = '<p class="note">Match not found.</p>'; show('match-detail'); return; }
  const { match, maps, players } = data;
  const teamTable = (team) =>
    `<table><thead><tr><th>Player</th><th>SI dmg</th><th>SI kills</th><th>Commons</th><th>FF</th><th>Revives</th><th>SR</th></tr></thead><tbody>` +
    players.filter((p) => p.team === team).map((p) =>
      `<tr><td>${playerLink(p)}</td><td>${p.si_damage}</td><td>${p.si_kills}</td><td>${p.common_kills}</td><td>${p.ff_dealt}</td><td>${p.revives}</td><td>${srDeltaHtml(p.srDelta)}</td></tr>`,
    ).join('') + '</tbody></table>';
  $('match-detail-body').innerHTML =
    `<h2>Match #${match.id} — ${esc(CAMPAIGN_NAMES[match.campaign] ?? match.campaign)}</h2>` +
    `<p>${match.teamAScore} — ${match.teamBScore} · ${match.winner === 'draw' ? 'Draw' : `Team ${match.winner.toUpperCase()} wins`} · ${esc(fmtDate(match.endedAt))}</p>` +
    `<table><thead><tr><th>Map</th><th>A</th><th>B</th></tr></thead><tbody>` +
    maps.map((m) => `<tr><td>${esc(m.map)}</td><td>${m.teamAScore}</td><td>${m.teamBScore}</td></tr>`).join('') +
    '</tbody></table>' +
    `<div class="teams"><div><h3>Team A</h3>${teamTable('a')}</div><div><h3>Team B</h3>${teamTable('b')}</div></div>`;
  show('match-detail');
}

async function renderProfile(steamid) {
  const data = await fetchJson(`/api/players/${encodeURIComponent(steamid)}`);
  if (!data) { $('profile-body').innerHTML = '<p class="note">Player not found.</p>'; show('profile'); return; }
  const { player, rating, totals, matches, history } = data;
  const avatar = player.avatar ? `<img class="avatar" src="${esc(player.avatar)}" alt="">` : '';
  $('profile-body').innerHTML =
    `<div class="profile-head">${avatar}<div><h2>${esc(player.name)}</h2>` +
    (rating
      ? `<p class="sr big">${rating.sr} SR</p><p>${rating.wins}W — ${rating.losses}L</p>`
      : '<p class="note">Unrated this season.</p>') +
    '</div></div>' +
    sparkline(history.map((h) => h.sr)) +
    `<h3>Season totals</h3><p>${totals.games} games · ${totals.si_damage} SI damage · ${totals.si_kills} SI kills · ` +
    `${totals.common_kills} commons · ${totals.ff_dealt} FF · ${totals.revives} revives</p>` +
    '<h3>Recent matches</h3>' +
    (matches.length === 0 ? '<p class="note">None yet.</p>'
      : `<table><thead><tr><th>#</th><th>Campaign</th><th></th><th>Score</th><th>SR</th><th>Ended</th></tr></thead><tbody>` +
        matches.map((m) =>
          `<tr><td><a href="#/match/${m.id}">${m.id}</a></td><td>${esc(CAMPAIGN_NAMES[m.campaign] ?? m.campaign)}</td>` +
          `<td class="result-${m.result}">${RESULT_LABEL[m.result]}</td><td>${m.teamAScore} — ${m.teamBScore}</td>` +
          `<td>${srDeltaHtml(m.srDelta)}</td><td>${esc(fmtDate(m.endedAt))}</td></tr>`,
        ).join('') + '</tbody></table>');
  show('profile');
}

function route() {
  const hash = location.hash || '#/';
  for (const a of document.querySelectorAll('header nav a')) {
    a.classList.toggle('active', a.getAttribute('href') === hash);
  }
  if (hash === '#/') refresh();
  else if (hash === '#/leaderboard') renderLeaderboard();
  else if (hash === '#/matches') renderMatches();
  else if (hash.startsWith('#/match/')) renderMatchDetail(hash.slice('#/match/'.length));
  else if (hash.startsWith('#/player/')) renderProfile(hash.slice('#/player/'.length));
  else { location.hash = '#/'; }
}

window.addEventListener('hashchange', route);
setInterval(() => { if (location.hash === '#/' || location.hash === '') { if (state?.lobby) render(); } }, 1000);
connectWs();
initDevPanel();
route();
```

Change `connectWs`'s `ws.onmessage = () => refresh();` to `ws.onmessage = () => route();` (live pages refetch on server pushes). In `refresh()`, make `#whoami` a link to own profile: after `$('whoami').textContent = me.name;` replace with:

```js
  $('whoami').innerHTML = `<a href="#/player/${esc(me.steamid)}">${esc(me.name)}</a>`;
```

(`/api/me` already returns `steamid`.) Also guard `render()` so it only touches play sections when on the play route: first line `if (location.hash !== '#/' && location.hash !== '') return;`.

- [ ] **Step 3: Dev panel button** — in `index.html` devpanel add `<button id="dev-sim">simulate match</button>`; in `initDevPanel` add:

```js
  $('dev-sim').onclick = () => api('/api/dev/simulate-match').then(route);
```

- [ ] **Step 4: `public/style.css`** — append:

```css
header nav { display: flex; gap: 1rem; }
header nav a { color: #aaa; text-decoration: none; }
header nav a.active, header nav a:hover { color: #fff; }
#whoami a { color: #e6e6e6; text-decoration: none; }
table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
th { text-align: left; color: #999; font-weight: 500; padding: 0.3rem 0.5rem; border-bottom: 1px solid #2a2e36; }
td { padding: 0.3rem 0.5rem; border-bottom: 1px solid #22252c; }
td a { color: #e6e6e6; }
.sr { color: #fc6; font-weight: 600; }
.sr.big { font-size: 1.6rem; margin: 0.2rem 0; }
.delta.up { color: #6c6; }
.delta.down { color: #e66; }
.result-win { color: #6c6; } .result-loss { color: #e66; } .result-draw { color: #999; }
.spark { width: 100%; height: 80px; margin: 0.5rem 0; }
.spark polyline { fill: none; stroke: #c33; stroke-width: 2; }
.profile-head { display: flex; gap: 1rem; align-items: center; }
.avatar { width: 64px; height: 64px; border-radius: 8px; }
```

- [ ] **Step 5: Manual smoke check** — start `npm run dev`, then via dev panel: login, simulate match ×3, visit Leaderboard / Matches / a match detail / a profile. All pages render with data; Play tab still works. (The overseer does a browser pass after this task; the implementer should at minimum run the server and curl the pages' APIs.)

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: leaderboard, match history, match detail, and profile pages"
```

---

### Task 7: README + final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Update `README.md`: add sub-project 3 to the feature list (rating updates, match_maps, stats API routes, frontend pages, Discord settings keys `discord_webhook_url` / `discord_queue_thresholds`, dev routes `finish-match` / `simulate-match`). Follow the README's existing structure/tone.

- [ ] **Step 2:** `npm test && npm run typecheck` → everything green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README for sub-project 3 (ratings, stats, discord)"
```

---

## Self-review notes (already applied)

- Spec coverage: rating engine ✔ (Task 1), per-map + persistence ✔ (2), Discord queue/pop/live/result ✔ (3), leaderboard/profile/history API ✔ (4), dev seeding ✔ (5), frontend pages ✔ (6). SR formula matches spec (`round((mu−2σ)·100)` floored at 0; defaults → 833). Draws: rank tie, no W/L increment. Aborted matches never rate (completeMatch refuses; applyMatchRatings requires `completed`).
- Season-correctness: ratings keyed to the **match's** season, not "current" (Task 1 test covers it).
- Idempotency: rating_history presence guards double application; completeMatch refuses re-completion.
- Type consistency: `Dump`/`DumpPlayer` shapes from `src/dumpParse.ts` used verbatim; `displaySr` imported by stats routes; `completeMatch` used by orchestrator + dev.
