# Competitive foundation plan 1: match kinds, visibility, rules snapshot

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every match carries a kind (pug / scrim / tournament) and a visibility (public / participants / staff), every PUG-facing number counts only kind pug, and no route hands a private match to a viewer who may not see it. PUGs behave exactly as today.

**Architecture:** Two columns on `matches` with defaults that make every existing and newly created row a public PUG, so nothing changes until later plans create other kinds. One helper (`src/matchKinds.ts`) is the single definition of "a completed PUG"; a source-scanning guard test stops raw completed-match filters from creeping back. One access module (`src/matchVisibility.ts`) decides who sees a match; every match-returning route calls it. Ruleset and game-config tables plus a pure rules module land now so later plans (bookings, tournaments) only have to write snapshots.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md`, section 1 (Match kinds, rulesets, privacy). Inventory of every completed-match filter: the table in Task 5 of this plan.

## Global Constraints

- `matches.kind` is `pug`, `scrim` or `tournament`, default `pug`, backfilled for every existing row.
- `matches.visibility` is `public`, `participants` or `staff`, default `public`.
- `origin` (queue / in_game) stays as it is and only means where a PUG came from.
- Tournament and scrim matches never touch PUG SR; `applyMatchRatings` only ever rates kind pug.
- A match stores `rules_json` and `game_config` as a copy made at creation (columns only in this plan; nothing writes them yet).
- Staff (is_admin or is_mod) and the anti-cheat analyzers always see everything.
- No behaviour change for PUGs: existing tests must pass unchanged except where a test fixture gains optional fields.
- No schema migration framework: new columns go through `ensureColumn` in `openDb` (src/db.ts), exactly like `origin` at src/db.ts:1525. Never `widenCheck` on `matches` (other tables reference it).
- Never write em dashes in code, comments, commits or docs.
- Commit messages follow the repo style (plain sentence, no conventional-commit prefix needed); do not push, do not deploy.

## Review Focus

- A scrim with the same eight players as a PUG: their leaderboard row, profile, standings, chemistry, endorsement titles and weekly awards must be identical with and without the scrim (Task 3 and Task 4 tests seed exactly this).
- `recomputeSeasonRatings` after a scrim exists: it must reproduce PUG ratings exactly and never write rating_history for the scrim (Task 2 test).
- A private scrim's id typed straight into any match URL (detail, demos, replay bytes, timeline, live round) by an anonymous viewer or a non-participant: 404, the same answer as a match that does not exist, so ids do not leak existence (Task 7 and Task 8 tests).
- A voided PUG: behaviour unchanged by the kind filter (the helper does not include `voided_at`; call sites keep their own voided filter). Task 3 includes a voided row in the seed.
- Replay pruning: a completed scrim's replays must still be prunable once offloaded (the metrics "keep until measured" rule is PUG-only, so it must not pin scrim replays forever). Task 4 test.

---

### Task 1: Schema columns, ruleset tables, fixture support

**Files:**
- Modify: `src/db.ts` (SCHEMA string for two new tables; `openDb` for four `ensureColumn` calls and template seeding)
- Modify: `tests/weeklyFixtures.ts` (`SeedMatch` gains `kind?`, `visibility?`)
- Test: `tests/matchKindSchema.test.ts`

**Interfaces:**
- Produces: columns `matches.kind TEXT NOT NULL DEFAULT 'pug'`, `matches.visibility TEXT NOT NULL DEFAULT 'public'`, `matches.rules_json TEXT`, `matches.game_config TEXT`; tables `game_configs(key TEXT PRIMARY KEY, label TEXT NOT NULL, cfg TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)` and `rulesets(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, rules_json TEXT NOT NULL, template INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT)`; seeded game config `standard` (cfg `pug_match`); `SeedMatch.kind?: 'pug' | 'scrim' | 'tournament'`, `SeedMatch.visibility?: 'public' | 'participants' | 'staff'`.
- The three ruleset templates are seeded by Task 9, not here (they need the rules module).

- [ ] **Step 1: Write the failing test**

```ts
// tests/matchKindSchema.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';

describe('match kind schema', () => {
  it('defaults a new match to a public pug with no rules snapshot', () => {
    const db = openDb(':memory:');
    const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'dead_air')").run().lastInsertRowid);
    expect(db.prepare('SELECT kind, visibility, rules_json, game_config FROM matches WHERE id = ?').get(id))
      .toEqual({ kind: 'pug', visibility: 'public', rules_json: null, game_config: null });
  });

  it('rejects an unknown kind or visibility', () => {
    const db = openDb(':memory:');
    const ins = (kind: string, vis: string) => db.prepare(
      "INSERT INTO matches (season_id, state, campaign, kind, visibility) VALUES (1, 'live', 'c', ?, ?)",
    ).run(kind, vis);
    expect(() => ins('ranked', 'public')).toThrow(/CHECK/);
    expect(() => ins('scrim', 'friends')).toThrow(/CHECK/);
    expect(() => ins('scrim', 'participants')).not.toThrow();
  });

  it('is idempotent on reopen and seeds the standard game config once', () => {
    const db = openDb(':memory:');
    expect(db.prepare('SELECT key, cfg, enabled FROM game_configs').all())
      .toEqual([{ key: 'standard', cfg: 'pug_match', enabled: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matchKindSchema.test.ts`
Expected: FAIL (`no such column: kind`, `no such table: game_configs`).

- [ ] **Step 3: Implement**

In the `SCHEMA` string of `src/db.ts`, next to the other `CREATE TABLE IF NOT EXISTS` blocks after `matches`:

```sql
-- Competitive platform (docs/superpowers/specs/2026-09-30-competitive-foundation-design.md).
-- Game configs staff approve for events and bookings; the balance layer
-- everyone plays by default is 'standard' (pug_match.cfg).
CREATE TABLE IF NOT EXISTS game_configs (
  key     TEXT PRIMARY KEY,
  label   TEXT NOT NULL,
  cfg     TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
-- Named match-rule profiles. A match copies the rules it was played under into
-- matches.rules_json, so editing a ruleset never rewrites history.
CREATE TABLE IF NOT EXISTS rulesets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  rules_json  TEXT NOT NULL,
  template    INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
```

In `openDb`, after the existing `matches` column steps (after the `abort_cause` line near src/db.ts:1663):

```ts
  // Competitive platform. Every row that exists today, and every row the queue
  // or an in-game !load creates, is a public PUG; only later code creates
  // other kinds. See src/matchKinds.ts and src/matchVisibility.ts.
  ensureColumn(db, 'matches', 'kind', "TEXT NOT NULL DEFAULT 'pug' CHECK (kind IN ('pug','scrim','tournament'))");
  ensureColumn(db, 'matches', 'visibility', "TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','participants','staff'))");
  // The rules and game config a match was played under, copied at creation.
  // NULL means a PUG created before rulesets existed: today's PUG rules.
  ensureColumn(db, 'matches', 'rules_json', 'TEXT');
  ensureColumn(db, 'matches', 'game_config', 'TEXT');
  db.prepare(
    "INSERT OR IGNORE INTO game_configs (key, label, cfg) VALUES ('standard', 'Standard (Rotoblin PUG 4v4)', 'pug_match')",
  ).run();
```

In `tests/weeklyFixtures.ts`, extend `SeedMatch` and the insert:

```ts
export interface SeedMatch {
  // ...existing fields unchanged...
  kind?: 'pug' | 'scrim' | 'tournament';
  visibility?: 'public' | 'participants' | 'staff';
  lines: SeedLine[];
}
```

```ts
  const id = Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, winner, team_a_score, team_b_score, ended_at, went_live_at, voided_at, kind, visibility)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.state ?? 'completed', o.campaign ?? 'no_mercy', o.winner ?? 'a', o.a ?? 500, o.b ?? 400,
    o.endedAt, o.wentLiveAt ?? null, o.voided ? o.endedAt : null,
    o.kind ?? 'pug', o.visibility ?? 'public',
  ).lastInsertRowid);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/matchKindSchema.test.ts` then `npm test`
Expected: PASS, and the full suite still passes (defaults make every existing insert a public pug).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/weeklyFixtures.ts tests/matchKindSchema.test.ts
git commit -m "Matches carry a kind and a visibility, default public pug; game_configs and rulesets tables"
```

---

### Task 2: The completed-PUG helper and the SR gate

**Files:**
- Create: `src/matchKinds.ts`
- Modify: `src/rating.ts:143-165` (`RatingOutcome.reason`, `applyMatchRatings`), `src/rating.ts:222-224` (`recomputeSeasonRatings`)
- Test: `tests/matchKinds.test.ts`

**Interfaces:**
- Produces: `export type MatchKind = 'pug' | 'scrim' | 'tournament'`; `export type MatchVisibility = 'public' | 'participants' | 'staff'`; `export function completedPug(alias?: string): string` returning `"<a>.state = 'completed' AND <a>.kind = 'pug'"` (with `alias` omitted: `"state = 'completed' AND kind = 'pug'"`). It deliberately does NOT include `voided_at`; call sites keep their own voided filter so behaviour stays identical. `RatingOutcome.reason` gains `'not_pug'`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/matchKinds.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { completedPug } from '../src/matchKinds.js';
import { applyMatchRatings, recomputeSeasonRatings } from '../src/rating.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';

function eightLines(ids: string[]) {
  return ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
}
function withMap(db: ReturnType<typeof openDb>, id: number) {
  db.prepare("INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 1, 'm1', 500, 400)").run(id);
}

describe('completedPug', () => {
  it('builds the fragment with and without an alias', () => {
    expect(completedPug('m')).toBe("m.state = 'completed' AND m.kind = 'pug'");
    expect(completedPug()).toBe("state = 'completed' AND kind = 'pug'");
  });
});

describe('SR only moves on PUGs', () => {
  it('applyMatchRatings refuses a scrim or a tournament match', () => {
    const db = openDb(':memory:');
    const ids = seedPlayers(db, 8);
    for (const kind of ['scrim', 'tournament'] as const) {
      const id = seedMatch(db, { endedAt: '2026-09-20 12:00:00', kind, visibility: kind === 'scrim' ? 'participants' : 'public', lines: eightLines(ids) });
      withMap(db, id);
      expect(applyMatchRatings(db, id)).toMatchObject({ applied: false, reason: 'not_pug' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE match_id = ?').get(id)).toEqual({ n: 0 });
    }
  });

  it('recomputeSeasonRatings ignores scrims and reproduces PUG ratings', () => {
    const db = openDb(':memory:');
    const ids = seedPlayers(db, 8);
    const pug = seedMatch(db, { endedAt: '2026-09-20 12:00:00', lines: eightLines(ids) });
    withMap(db, pug);
    applyMatchRatings(db, pug);
    const before = db.prepare('SELECT player_id, mu, sigma, wins, losses FROM player_ratings ORDER BY player_id').all();
    const scrim = seedMatch(db, { endedAt: '2026-09-20 13:00:00', kind: 'scrim', visibility: 'participants', winner: 'b', lines: eightLines(ids) });
    withMap(db, scrim);
    recomputeSeasonRatings(db, 1);
    expect(db.prepare('SELECT player_id, mu, sigma, wins, losses FROM player_ratings ORDER BY player_id').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE match_id = ?').get(scrim)).toEqual({ n: 0 });
  });
});
```

(`match_maps` NOT NULL columns are exactly match_id, ordinal, map; `withMap` fills them. The point is only that `applyMatchRatings` sees one map played, so every seeded player counts as rated.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matchKinds.test.ts`
Expected: FAIL (`Cannot find module '../src/matchKinds.js'`).

- [ ] **Step 3: Implement**

```ts
// src/matchKinds.ts
/**
 * What kind of match a row is, and the one definition of "a completed PUG".
 *
 * Scrims and tournament matches live in the same `matches` table as PUGs so
 * they reuse setup, capture, replays and the viewer, but they must never count
 * toward anything PUG-facing: SR, the leaderboard, profiles, standings,
 * chemistry, endorsements, weekly awards, skeet posts, balance analytics. Every
 * such query builds its filter from completedPug(); tests/matchKindGuard.test.ts
 * fails on a raw completed-match filter anywhere else.
 *
 * voided_at is deliberately NOT part of it: some PUG aggregates count voided
 * matches and some do not, and each call site keeps its own rule.
 */
export type MatchKind = 'pug' | 'scrim' | 'tournament';
export type MatchVisibility = 'public' | 'participants' | 'staff';

export function completedPug(alias?: string): string {
  const p = alias ? `${alias}.` : '';
  return `${p}state = 'completed' AND ${p}kind = 'pug'`;
}
```

In `src/rating.ts`, widen the reason union and gate `applyMatchRatings`:

```ts
  reason?: 'not_completed' | 'already' | 'too_few' | 'not_pug';
```

```ts
export function applyMatchRatings(db: DB, matchId: number): RatingOutcome {
  const match = db
    .prepare('SELECT id, season_id, state, winner, kind FROM matches WHERE id = ?')
    .get(matchId) as { id: number; season_id: number; state: string; winner: 'a' | 'b' | 'draw' | null; kind: string } | undefined;
  if (!match || match.state !== 'completed' || !match.winner) return { applied: false, reason: 'not_completed', ratedA: 0, ratedB: 0 };
  // Scrims and tournament matches never move SR (spec: foundation section 1).
  if (match.kind !== 'pug') return { applied: false, reason: 'not_pug', ratedA: 0, ratedB: 0 };
```

In `recomputeSeasonRatings` replace `WHERE season_id = ? AND state = 'completed'` with a template using the helper:

```ts
    const matches = db.prepare(
      `SELECT id FROM matches WHERE season_id = ? AND ${completedPug()}
       ORDER BY COALESCE(ended_at, created_at), id`,
    ).all(seasonId) as { id: number }[];
```

and add `import { completedPug } from './matchKinds.js';` at the top of `src/rating.ts`.

Check `src/matchResult.ts` around line 94: it only warns on `reason === 'too_few'`, so `'not_pug'` passes silently. Leave it.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/matchKinds.test.ts tests/adminMatches.test.ts` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/matchKinds.ts src/rating.ts tests/matchKinds.test.ts
git commit -m "Only PUGs move SR: completedPug() helper, applyMatchRatings refuses other kinds, recompute skips them"
```

---

### Task 3: Player-facing aggregates count PUGs only

**Files:**
- Modify: `src/playerQueries.ts:40,47,106,115,132`, `src/standings.ts:71,77`, `src/seasons.ts:16`, `src/routes/stats.ts:106`, `src/playerStats.ts:116,193,327,438`, `src/endorsements.ts:184,190,211,223,242`, `src/chemistry.ts:45`, `src/admin/players.ts:175`, `src/admin/conduct.ts:100`
- Test: `tests/matchKindAggregates.test.ts`

**Interfaces:**
- Consumes: `completedPug(alias?)` from Task 2.
- Produces: no new exports. Every listed query counts only kind pug.

Replacement rule at every listed line: where the SQL says `<a>.state = 'completed'` write `${completedPug('<a>')}` (switch the string to a template literal if it is not one); where it says bare `state = 'completed'` write `${completedPug()}`. Two sites are not plain equality:
- `src/admin/conduct.ts:100` has `m.state IN ('completed', 'aborted')`: keep it and append ` AND m.kind = 'pug'` (scrims allow free pausing, so counting them would distort a player's pause rate).
- `src/admin/players.ts:175` counts "games" in admin search: make it PUG games like the profile (`${completedPug('m')}`).
- `src/playerQueries.ts:115` (the profile's recent match list) becomes PUG-only too: the spec keeps PUGs as the profile headline, and scrim/tournament tabs come in a later plan.

Add `import { completedPug } from './matchKinds.js';` (adjust the relative path: `'../matchKinds.js'` from `src/routes/` and `src/admin/`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/matchKindAggregates.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';
import { leaderboardData, profileData } from '../src/playerQueries.js';
import { playerStandings } from '../src/standings.js';
import { listSeasons } from '../src/seasons.js';
import { playerMapBreakdown, mapIndex, mapDetail } from '../src/playerStats.js';
import { endorsementSummary, allTitles } from '../src/endorsements.js';
import { chemistryFor } from '../src/chemistry.js';
import { searchPlayers } from '../src/admin/players.js';

let db: DB;
let ids: string[];
const lines = () => ids.map((id, i) => ({
  id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b',
  fixed: { si_damage: 100, si_kills: 5, common_kills: 20, revives: 1, ff_dealt: 3 },
  stats: { skeets: 2 },
}));

/** Every aggregate we care about, as one comparable snapshot. */
function snapshot() {
  return {
    leaderboard: leaderboardData(db, 1),
    profile: profileData(db, ids[0], null),
    standings: playerStandings(db, 1, ids[0]),
    seasons: listSeasons(db),
    breakdown: playerMapBreakdown(db, ids[0]),
    mapIndex: mapIndex(db),
    mapDetail: mapDetail(db, 'no_mercy'),
    endorse: endorsementSummary(db, ids[0]),
    titles: [...allTitles(db).entries()],
    chemistry: chemistryFor(db, ids[0]),
    search: searchPlayers(db, ''),
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  ids = seedPlayers(db, 8);
  seedMatch(db, { endedAt: '2026-09-20 12:00:00', lines: lines() });
  seedMatch(db, { endedAt: '2026-09-20 14:00:00', voided: true, lines: lines() });
});

describe('PUG aggregates ignore scrims and tournament matches', () => {
  it.each(['scrim', 'tournament'] as const)('a completed %s changes nothing PUG-facing', (kind) => {
    const before = snapshot();
    seedMatch(db, { endedAt: '2026-09-21 12:00:00', kind, visibility: kind === 'scrim' ? 'participants' : 'public', lines: lines() });
    expect(snapshot()).toEqual(before);
  });

  it('a second PUG does change them (the snapshot is sensitive)', () => {
    const before = snapshot();
    seedMatch(db, { endedAt: '2026-09-21 12:00:00', lines: lines() });
    expect(snapshot()).not.toEqual(before);
  });
});
```

(If `mapDetail` / `mapIndex` read `match_maps` rather than `matches.campaign`, add a `match_maps` row per seeded match in a small local helper so the map pages have data; the sensitivity test tells you when the snapshot is blind.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matchKindAggregates.test.ts`
Expected: the two `it.each` cases FAIL (the scrim changes the leaderboard, profile, etc.); the sensitivity case PASSES.

- [ ] **Step 3: Implement** the replacements listed above, one file at a time. Example for `src/playerQueries.ts:40`:

```ts
// before
     WHERE m.season_id = ? AND m.state = 'completed'
// after
     WHERE m.season_id = ? AND ${completedPug('m')}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/matchKindAggregates.test.ts` then `npm test` then `npm run typecheck`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git add src/playerQueries.ts src/standings.ts src/seasons.ts src/routes/stats.ts src/playerStats.ts src/endorsements.ts src/chemistry.ts src/admin/players.ts src/admin/conduct.ts tests/matchKindAggregates.test.ts
git commit -m "Leaderboard, profiles, standings, maps, endorsements, chemistry and admin counts see PUGs only"
```

---

### Task 4: Awards, Discord posts, balance and metrics count PUGs only

**Files:**
- Modify: `src/weeklyAwards.ts:119` (`WEEK_MATCHES`), `src/discord/skeetStreakPoster.ts:73`, `src/balancePatches.ts:397`, `src/balancePublic.ts:38`, `src/metrics/summary.ts:18`, `src/metrics/r2Recompute.ts:26`, `src/metrics/compare/load.ts:26`, `src/metrics/job.ts:45`, `src/replayPrune.ts:89`
- Test: `tests/matchKindAnalytics.test.ts`

**Interfaces:**
- Consumes: `completedPug(alias?)`.
- Produces: no new exports.

Replacements:
- `WEEK_MATCHES`: `` `SELECT id FROM matches WHERE ${completedPug()} AND voided_at IS NULL AND ended_at >= ? AND ended_at < ?` `` (one edit fixes all nine uses, including weeklyRecap).
- `skeetStreakPoster.ts:73`: `WHERE ${completedPug()} AND voided_at IS NULL AND ended_at >= ?`.
- `balancePatches.ts:397`, `balancePublic.ts:38`, `metrics/summary.ts:18`, `metrics/r2Recompute.ts:26`, `metrics/job.ts:45`: `${completedPug('m')} AND m.voided_at IS NULL`.
- `metrics/compare/load.ts:26`: `const parts = [completedPug('m'), 'm.voided_at IS NULL'];`
- `replayPrune.ts:89` must mirror `metrics/job.ts:45` exactly, or scrim replays are pinned forever: `AND NOT (${completedPug('m')} AND m.voided_at IS NULL AND EXISTS (`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/matchKindAnalytics.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';
import { WEEK_MATCHES } from '../src/weeklyAwards.js';
import { pendingRounds } from '../src/metrics/job.js';
import { planPrune } from '../src/replayPrune.js';

let db: DB;
let ids: string[];
const lines = () => ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));

function roundAndReplay(matchId: number) {
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, 1, 1, 'a', 100, '2026-09-21 12:00:00')").run(matchId);
  db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (?, 1, 1, ?, 10, 10, 10)").run(matchId, `r${matchId}.bin`);
}

beforeEach(() => {
  db = openDb(':memory:');
  ids = seedPlayers(db, 8);
});

describe('weekly and analytics filters', () => {
  it('WEEK_MATCHES returns PUGs only', () => {
    const pug = seedMatch(db, { endedAt: '2026-09-22 12:00:00', lines: lines() });
    seedMatch(db, { endedAt: '2026-09-22 13:00:00', kind: 'scrim', visibility: 'participants', lines: lines() });
    seedMatch(db, { endedAt: '2026-09-22 14:00:00', kind: 'tournament', lines: lines() });
    expect(db.prepare(WEEK_MATCHES).all('2026-09-21 12:00:00', '2026-09-28 12:00:00')).toEqual([{ id: pug }]);
  });

  it('the metrics job never queues a scrim round', () => {
    const scrim = seedMatch(db, { endedAt: '2026-09-21 12:00:00', kind: 'scrim', visibility: 'participants', lines: lines() });
    roundAndReplay(scrim);
    const keys = pendingRounds(db, { engine: 'test-engine', replayWaitMin: 0, limit: 50, now: '2026-09-22 12:00:00' });
    expect(keys.filter((k) => k.matchId === scrim)).toEqual([]);
  });

  it('an unmeasured scrim replay is still a prune candidate', () => {
    const scrim = seedMatch(db, { endedAt: '2026-09-21 12:00:00', kind: 'scrim', visibility: 'participants', lines: lines() });
    roundAndReplay(scrim);
    const pug = seedMatch(db, { endedAt: '2026-09-21 13:00:00', lines: lines() });
    roundAndReplay(pug);
    // planPrune(db, dir, now, retentionDays, freeBytes, floorBytes, opts): both rounds are
    // far past a 1-day retention, so only the metrics hold can keep one.
    const plan = planPrune(db, dir, new Date('2026-12-01T00:00:00Z'), 1, 1e12, 0);
    const matches = plan.map((c: { matchId: number }) => c.matchId);
    expect(matches).toContain(scrim);    // no metrics rule pins a scrim
    expect(matches).not.toContain(pug);  // the unmeasured PUG round is still kept
  });
});
```

`dir` is a temp directory holding both replay files, so the test works whether or not `planPrune` stats them: add `import { mkdtempSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';` and in `beforeEach` `dir = mkdtempSync(join(tmpdir(), 'prune-'));`, and in `roundAndReplay` `writeFileSync(join(dir, `r${matchId}.bin`), 'x'.repeat(10));` (declare `let dir: string;` beside `db`). The `match_rounds` insert above already fills every NOT NULL column (match_id, ordinal, half, surv_team).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matchKindAnalytics.test.ts`
Expected: FAIL on all three (scrim and tournament ids in WEEK_MATCHES; scrim round queued; scrim replay kept).

- [ ] **Step 3: Implement** the replacements listed above, adding the `completedPug` import to each file (`'./matchKinds.js'`, `'../matchKinds.js'`, `'../../matchKinds.js'` by depth).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/matchKindAnalytics.test.ts` then `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/weeklyAwards.ts src/discord/skeetStreakPoster.ts src/balancePatches.ts src/balancePublic.ts src/metrics src/replayPrune.ts tests/matchKindAnalytics.test.ts
git commit -m "Weekly awards, skeet posts, balance and metrics see PUGs only; replay prune mirrors the metrics rule"
```

---

### Task 5: Guard test against raw completed-match filters

**Files:**
- Test: `tests/matchKindGuard.test.ts`

**Interfaces:**
- Consumes: the state of `src/` after Tasks 2-4.

The test scans every `.ts` file under `src/` for the pattern below and compares per-file hit counts to an allowlist of files whose remaining hits are ANY_KIND (operational code that must keep seeing every kind) or VISIBILITY (routes that Tasks 7-8 gate by viewer instead). A new raw filter anywhere, or an extra one in an allowlisted file, fails the test with the file name.

Classification used for the allowlist (from the 2026-09-30 inventory):

| File | Hits left | Why they stay raw |
|---|---|---|
| src/matchKinds.ts | 0 | the helper builds its string with a template, no literal match |
| src/matchResult.ts | 1 | the result writer sets state = 'completed' |
| src/demoOffload.ts | 1 | offload every finished match's demos |
| src/replayOffload.ts | 1 | offload every finished match's replays |
| src/replayPrune.ts | 1 | line 83: prune every finished match's replays |
| src/playerNames.ts | 1 | clean name scratch for every finished match |
| src/reindex.ts | 1 | relink every finished match's files |
| src/nameBackfill.ts | 1 | map every log token to its match |
| src/tickets/filing.ts | 1 | a report can be about any match the two shared |
| src/discord/reportButton.ts | 1 | recent co-players from any match |
| src/discord/voice.ts | 1 | sweep voice channels of every ended match |
| src/admin/matches.ts | 1 | staff list every kind |
| src/admin/conduct.ts | 1 | kept `IN ('completed','aborted')` plus `m.kind = 'pug'` (Task 3) |
| src/routes/people.ts | 1 | mod chat log, staff only |
| src/routes/replays.ts | 2 | gated by viewer in Task 8 |
| src/routes/stats.ts | 2 | /api/matches and /api/matches/:id, gated by viewer in Task 7 |
| src/discord/commands.ts | 1 | recent matches, public-only in Task 7 |
| src/matchArchive.ts | 1 | a comment describing the rule |

- [ ] **Step 1: Write the test**

```ts
// tests/matchKindGuard.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Any raw "state = 'completed'" or "state IN (... 'completed' ...)" outside
 * this allowlist is a query that would count scrims and tournament matches as
 * PUGs. Use completedPug() from src/matchKinds.ts instead, or, if the code is
 * operational and must see every kind, add the file here with the reason.
 * Counts are per file so a second raw filter in an allowed file still fails.
 */
const ALLOWED: Record<string, number> = {
  'src/matchResult.ts': 1,          // the result writer
  'src/demoOffload.ts': 1,          // offload demos of every kind
  'src/replayOffload.ts': 1,        // offload replays of every kind
  'src/replayPrune.ts': 1,          // prune replays of every kind
  'src/playerNames.ts': 1,          // name scratch cleanup
  'src/reindex.ts': 1,              // relink files
  'src/nameBackfill.ts': 1,         // log token to match
  'src/tickets/filing.ts': 1,       // reports about any shared match
  'src/discord/reportButton.ts': 1, // co-players from any match
  'src/discord/voice.ts': 1,        // voice sweep
  'src/admin/matches.ts': 1,        // staff list
  'src/admin/conduct.ts': 1,        // IN (...) plus kind = 'pug'
  'src/routes/people.ts': 1,        // staff chat log
  'src/routes/replays.ts': 2,       // gated by canViewMatch
  'src/routes/stats.ts': 2,         // gated by visibleMatchesSql / canViewMatch
  'src/discord/commands.ts': 1,     // public matches only
  'src/matchArchive.ts': 1,         // comment
};

const RAW = /state\s*=\s*'completed'|state\s+IN\s*\([^)]*'completed'/g;

describe('completed-match filters', () => {
  it('only allowlisted files keep raw filters, and no more of them than allowed', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));
    const found: Record<string, number> = {};
    for (const f of walk('src')) {
      const n = (readFileSync(join(root, f), 'utf8').match(RAW) ?? []).length;
      if (n > 0) found[f] = n;
    }
    const offenders = Object.entries(found).filter(([f, n]) => n > (ALLOWED[f] ?? 0));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/matchKindGuard.test.ts`
Expected: PASS. If a file shows up that is not in the table, read the hit: if it counts toward anything a player sees, convert it with `completedPug` (and add a case to the Task 3 or Task 4 test); if it is operational, add it to `ALLOWED` with a one-line reason. If an allowlisted count is too high, it means an earlier task missed a conversion; fix the conversion, never raise the count.

- [ ] **Step 3: Prove it bites**

Temporarily add `const x = "SELECT 1 FROM matches WHERE state = 'completed'";` to `src/chemistry.ts`, run the test, see it FAIL naming `src/chemistry.ts`, then remove the line.

- [ ] **Step 4: Commit**

```bash
git add tests/matchKindGuard.test.ts
git commit -m "Guard test: no raw completed-match filter outside the operational allowlist"
```

---

### Task 6: Match visibility module

**Files:**
- Create: `src/matchVisibility.ts`
- Test: `tests/matchVisibility.test.ts`

**Interfaces:**
- Produces:
  - `export interface Viewer { steamid: string | null; staff: boolean }`
  - `export function viewerFor(db: DB, steamid: string | null): Viewer` (staff = `is_admin = 1 OR is_mod = 1`)
  - `export function canViewMatch(db: DB, viewer: Viewer, matchId: number): boolean` (false for a missing match)
  - `export function visibleMatchesSql(viewer: Viewer, alias: string): { sql: string; params: (string | number)[] }` for WHERE clauses

Rules (spec section 1, Visibility): `public` is visible to everyone; `participants` to staff and anyone in `match_players` for that match; `staff` to staff only. Later plans extend "participants" with ringers, approved spectators and invited casters through `booking_people`; this plan has only `match_players`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/matchVisibility.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';
import { viewerFor, canViewMatch, visibleMatchesSql } from '../src/matchVisibility.js';

let db: DB;
let ids: string[];
let outsider: string;
let mod: string;
let pub: number, priv: number, staffOnly: number;

beforeEach(() => {
  db = openDb(':memory:');
  const all = seedPlayers(db, 10);
  ids = all.slice(0, 8);
  outsider = all[8];
  mod = all[9];
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(mod);
  const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
  pub = seedMatch(db, { endedAt: '2026-09-21 12:00:00', lines });
  priv = seedMatch(db, { endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', lines });
  staffOnly = seedMatch(db, { endedAt: '2026-09-21 14:00:00', kind: 'scrim', visibility: 'staff', lines });
});

describe('canViewMatch', () => {
  it.each([
    ['anonymous', () => null, [true, false, false]],
    ['outsider', () => outsider, [true, false, false]],
    ['participant', () => ids[0], [true, true, false]],
    ['mod', () => mod, [true, true, true]],
  ] as const)('%s', (_label, who, expected) => {
    const v = viewerFor(db, who());
    expect([pub, priv, staffOnly].map((id) => canViewMatch(db, v, id))).toEqual(expected);
  });

  it('a missing match is not viewable', () => {
    expect(canViewMatch(db, viewerFor(db, mod), 999_999)).toBe(false);
  });
});

describe('visibleMatchesSql', () => {
  const idsFor = (who: string | null) => {
    const { sql, params } = visibleMatchesSql(viewerFor(db, who), 'm');
    return (db.prepare(`SELECT m.id FROM matches m WHERE ${sql} ORDER BY m.id`).all(...params) as { id: number }[]).map((r) => r.id);
  };
  it('matches canViewMatch for every viewer', () => {
    expect(idsFor(null)).toEqual([pub]);
    expect(idsFor(outsider)).toEqual([pub]);
    expect(idsFor(ids[0])).toEqual([pub, priv]);
    expect(idsFor(mod)).toEqual([pub, priv, staffOnly]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matchVisibility.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/matchVisibility.ts
import type { DB } from './db.js';

/**
 * Who may see a match (spec: foundation section 1, Visibility).
 *
 * public: everyone. participants: staff and the players of that match (later
 * plans add ringers, approved spectators and invited casters). staff: staff
 * only. Every route that returns a match, its demos, replays, timeline or live
 * round goes through canViewMatch or visibleMatchesSql, and answers a match the
 * viewer may not see exactly like a match that does not exist.
 */
export interface Viewer { steamid: string | null; staff: boolean }

export function viewerFor(db: DB, steamid: string | null): Viewer {
  if (!steamid) return { steamid: null, staff: false };
  const row = db.prepare('SELECT is_admin, is_mod FROM players WHERE steamid = ?').get(steamid) as
    { is_admin: number; is_mod: number } | undefined;
  return { steamid, staff: row?.is_admin === 1 || row?.is_mod === 1 };
}

export function canViewMatch(db: DB, viewer: Viewer, matchId: number): boolean {
  const row = db.prepare('SELECT visibility FROM matches WHERE id = ?').get(matchId) as { visibility: string } | undefined;
  if (!row) return false;
  if (row.visibility === 'public' || viewer.staff) return true;
  if (row.visibility !== 'participants' || !viewer.steamid) return false;
  return db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, viewer.steamid) !== undefined;
}

export function visibleMatchesSql(viewer: Viewer, alias: string): { sql: string; params: (string | number)[] } {
  if (viewer.staff) return { sql: '1 = 1', params: [] };
  if (!viewer.steamid) return { sql: `${alias}.visibility = 'public'`, params: [] };
  return {
    sql: `(${alias}.visibility = 'public' OR (${alias}.visibility = 'participants' AND EXISTS (
            SELECT 1 FROM match_players vis_mp WHERE vis_mp.match_id = ${alias}.id AND vis_mp.player_id = ?)))`,
    params: [viewer.steamid],
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/matchVisibility.test.ts` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/matchVisibility.ts tests/matchVisibility.test.ts
git commit -m "matchVisibility: who may see a public, participants-only or staff-only match"
```

---

### Task 7: Gate the match routes and the Discord recent list

**Files:**
- Modify: `src/routes/stats.ts` (`GET /api/matches` ~line 165, `GET /api/matches/:id` ~line 173, `GET /api/matches/:id/demos/:ordinal` ~line 351)
- Modify: `src/discord/commands.ts:187`
- Test: `tests/matchVisibilityRoutes.test.ts`

**Interfaces:**
- Consumes: `viewerFor`, `canViewMatch`, `visibleMatchesSql` (Task 6). `viewerOf = makeOptionalViewer(db)` already exists in `src/routes/stats.ts:62`.

Changes:
- `/api/matches`: build `const v = viewerFor(db, viewerOf(req)); const vis = visibleMatchesSql(v, 'm');` and query `FROM matches m WHERE m.state = 'completed' AND ${vis.sql} ORDER BY m.id DESC LIMIT ?` with `.all(...vis.params, RECENT_MATCH_LIMIT)`. Keep selecting the same columns (prefix with `m.`). The route handler needs `req` now: `app.get('/api/matches', async (req) => {`.
- `/api/matches/:id`: right after the `inProgress` lookup returns a row, add `if (!canViewMatch(db, viewerFor(db, viewer), id)) return reply.code(404).send({ error: 'no such match' });` so the ongoing stub is gated too. Same 404 body as a missing match.
- `/api/matches/:id/demos/:ordinal`: at the top of the handler, `if (!canViewMatch(db, viewerFor(db, viewerOf(req)), Number(id))) return reply.code(404).send({ error: 'no such demo' });` (use whatever 404 body the route already sends for a missing demo, so the two are indistinguishable).
- `src/discord/commands.ts:187` (anonymous Discord audience): add `AND visibility = 'public'` to that query.

- [ ] **Step 1: Write the failing test**

```ts
// tests/matchVisibilityRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';

let db: DB;
let app: FastifyInstance;
let ids: string[];
let outsider: string;
let priv: number;
let pub: number;

beforeEach(async () => {
  db = openDb(':memory:');
  const all = seedPlayers(db, 9);
  ids = all.slice(0, 8);
  outsider = all[8];
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
  pub = seedMatch(db, { endedAt: '2026-09-21 12:00:00', lines });
  priv = seedMatch(db, { endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', lines });
});
afterEach(async () => { await app.close(); });

const get = (url: string, who?: string) =>
  app.inject({ method: 'GET', url, cookies: who ? authedCookie(app, db, who) : undefined });

describe('match routes respect visibility', () => {
  it('lists the private scrim only to its players', async () => {
    const listed = async (who?: string) => ((await get('/api/matches', who)).json().matches as { id: number }[]).map((m) => m.id);
    expect(await listed()).toEqual([pub]);
    expect(await listed(outsider)).toEqual([pub]);
    expect(await listed(ids[0])).toEqual([priv, pub]);
  });

  it('answers a private scrim like a missing match for outsiders', async () => {
    const missing = await get('/api/matches/999999');
    for (const who of [undefined, outsider]) {
      const r = await get(`/api/matches/${priv}`, who);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual(missing.json());
    }
    expect((await get(`/api/matches/${priv}`, ids[0])).statusCode).toBe(200);
  });

  it('gates the ongoing stub and demos too', async () => {
    db.prepare("UPDATE matches SET state = 'live' WHERE id = ?").run(priv);
    expect((await get(`/api/matches/${priv}`, outsider)).statusCode).toBe(404);
    expect((await get(`/api/matches/${priv}/demos/1`, outsider)).statusCode).toBe(404);
  });
});
```

(`authedCookie` creates a session for a steamid, see `tests/helpers.ts`; if it requires the player row to be `active`, set `status = 'active'` for the seeded players in `beforeEach`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matchVisibilityRoutes.test.ts`
Expected: FAIL (the scrim is listed and served to everyone).

- [ ] **Step 3: Implement** the route changes above; import `viewerFor, canViewMatch, visibleMatchesSql` from `'../matchVisibility.js'` in `src/routes/stats.ts`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/matchVisibilityRoutes.test.ts tests/matchKindGuard.test.ts` then `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/stats.ts src/discord/commands.ts tests/matchVisibilityRoutes.test.ts
git commit -m "Match list, match page, ongoing stub and demos hide private matches; Discord recent list is public-only"
```

---

### Task 8: Gate replays, live data, streams and the caster list

**Files:**
- Modify: `src/routes/replays.ts` (routes `/api/replays/live/match/:id` ~389, `/api/replays/file/:name` ~428, `/api/replays/match/:id/:ordinal/:half` ~445, `/api/replays/timeline/:matchId/:ordinal/:half` ~524)
- Modify: `src/liveView.ts` (`getLiveMatches` ~line 903), `src/streamsView.ts` (~line 92), `src/routes/cast.ts` (~line 64)
- Test: `tests/matchVisibilityLive.test.ts`

**Interfaces:**
- Consumes: Task 6. `src/routes/replays.ts` has no viewer today: add `const viewerOf = makeOptionalViewer(db);` (import from `'./guards.js'`) inside its route registration function.

Changes:
- The three match-addressed replay routes: first line of each handler, `if (!canViewMatch(db, viewerFor(db, viewerOf(req)), Number(<id param>))) return reply.code(404).send(<the same body the route sends for a missing replay>);`.
- `/api/replays/file/:name`: after `resolveByName` finds a file, look up `SELECT match_id FROM match_replays WHERE filename = ?`; if a row exists and `!canViewMatch(...)`, return the route's existing 404 (`{ error: 'no such replay' }`). Files with no match row (standalone `!mix` sessions) behave as today.
- `getLiveMatches`: add `AND m.visibility = 'public'` to its WHERE. The public live page never shows scrims; tournament live data with the 90 s delay is a later plan (tournaments plan 3), and until then tournament matches are public but not yet created by anything.
- `streamsView.ts` live roster query: add `AND m.visibility = 'public'`, so a streamer's card never reveals they are in a private scrim.
- `routes/cast.ts`: add `AND m.kind IN ('pug', 'tournament')` (spec: casters see every PUG and tournament match; scrims only when both captains invite them, which arrives with bookings).

- [ ] **Step 1: Write the failing test**

```ts
// tests/matchVisibilityLive.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';
import { getLiveMatches } from '../src/liveView.js';

let db: DB;
let app: FastifyInstance;
let ids: string[];
let outsider: string;
let caster: string;
let priv: number;

beforeEach(async () => {
  db = openDb(':memory:');
  const all = seedPlayers(db, 10);
  ids = all.slice(0, 8);
  outsider = all[8];
  caster = all[9];
  db.prepare('UPDATE players SET is_caster = 1 WHERE steamid = ?').run(caster);
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
  priv = seedMatch(db, { endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', state: 'live', lines });
  db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (?, 1, 1, 'scrim.bin', 10, 10, 10)").run(priv);
});
afterEach(async () => { await app.close(); });

const get = (url: string, who?: string) =>
  app.inject({ method: 'GET', url, cookies: who ? authedCookie(app, db, who) : undefined });

describe('replays and live data respect visibility', () => {
  it('replay routes 404 for outsiders', async () => {
    for (const url of [
      `/api/replays/live/match/${priv}`,
      `/api/replays/match/${priv}/1/1`,
      `/api/replays/timeline/${priv}/1/1`,
    ]) {
      expect((await get(url, outsider)).statusCode, url).toBe(404);
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });

  it('the public live list and the caster list leave the scrim out', async () => {
    expect(getLiveMatches(db).map((m) => m.id)).not.toContain(priv);
    const cast = await get('/api/cast', caster);
    expect(JSON.stringify(cast.json())).not.toContain(`"id":${priv}`);
  });
});
```

(`/api/replays/match/...` may also 404 for a participant here because no file exists on disk; this test only asserts the outsider case. `/api/replays/file/:name` needs a real file under the replay dir; cover it by extracting the new `match_id` lookup into a small exported function in `src/routes/replays.ts`, e.g. `replayFileVisible(db, viewer, filename): boolean`, and unit-testing that function here with the `scrim.bin` row.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matchVisibilityLive.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the changes listed above.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/matchVisibilityLive.test.ts tests/matchKindGuard.test.ts` then `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/replays.ts src/liveView.ts src/streamsView.ts src/routes/cast.ts tests/matchVisibilityLive.test.ts
git commit -m "Replays, timelines, live rounds, the live list, streams and the caster list hide private matches"
```

---

### Task 9: Rules module and ruleset templates

**Files:**
- Create: `src/rulesets.ts`
- Modify: `src/db.ts` (`openDb`: seed the three templates via `seedRulesetTemplates(db)` after the tables exist)
- Test: `tests/rulesets.test.ts`

**Interfaces:**
- Produces:
  - `export interface MatchRules { rated: boolean; pause: { limit: number | null; seconds: number | null; mutualUnpause: boolean; techPauses: number }; teamLock: boolean; playerMapControl: boolean; restartHalf: { allowed: boolean; lockAfterDamage: boolean }; noShowGraceMinutes: number; penalties: boolean; bosses: 'random_published' | 'fixed' | 'voteboss'; sideRule: 'higher_seed_chooses' | 'non_picker_chooses' | 'coin'; spectate: { sideLocked: boolean } }`
  - `export const TEMPLATES: Record<'PUG' | 'Standard Cup' | 'Casual Scrim', MatchRules>`
  - `export function parseRules(json: string): MatchRules` (throws `Error('invalid rules: <field>')` on a bad or missing field)
  - `export function rulesForKind(kind: MatchKind, rules: MatchRules): MatchRules` (forces `rated: false` for any kind other than pug; the spec's second guard)
  - `export function seedRulesetTemplates(db: DB): void` (INSERT OR IGNORE by name, `template = 1`)

Template values: PUG mirrors today's cfg (`sm_pug_pause_limit` 3, `sm_pug_pause_seconds` 120, team lock on, no player map control, penalties on, no-show grace = the `noshow_minutes` default, rated true, bosses `random_published`, side rule `coin`, sideLocked false). Standard Cup: rated false, pause limit 3 / 120 s, mutual unpause true, tech pauses 2, team lock on, no map control, restart not allowed, grace 15, penalties false, bosses `random_published`, `higher_seed_chooses`, sideLocked true. Casual Scrim: rated false, unlimited pauses (`null`/`null`), mutual unpause true, tech pauses 0, team lock on, map control true, restart allowed with lockAfterDamage false, grace 15, penalties false, bosses `random_published`, `non_picker_chooses`, sideLocked false. Read the real `noshow_minutes` default from `DEFAULT_SETTINGS` in `src/db.ts` and the pause cvar defaults from `plugin/pug-pause.inc` before writing the PUG template, and put the numbers in literally.

- [ ] **Step 1: Write the failing test**

```ts
// tests/rulesets.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { TEMPLATES, parseRules, rulesForKind } from '../src/rulesets.js';

describe('rulesets', () => {
  it('seeds the three templates once', () => {
    const db = openDb(':memory:');
    const rows = db.prepare('SELECT name, rules_json, template FROM rulesets ORDER BY name').all() as { name: string; rules_json: string; template: number }[];
    expect(rows.map((r) => r.name)).toEqual(['Casual Scrim', 'PUG', 'Standard Cup']);
    for (const r of rows) {
      expect(r.template).toBe(1);
      expect(parseRules(r.rules_json)).toEqual(TEMPLATES[r.name as keyof typeof TEMPLATES]);
    }
  });

  it('only the PUG template is rated', () => {
    expect(TEMPLATES.PUG.rated).toBe(true);
    expect(TEMPLATES['Standard Cup'].rated).toBe(false);
    expect(TEMPLATES['Casual Scrim'].rated).toBe(false);
  });

  it('rulesForKind forces unrated outside pug', () => {
    expect(rulesForKind('scrim', TEMPLATES.PUG).rated).toBe(false);
    expect(rulesForKind('tournament', TEMPLATES.PUG).rated).toBe(false);
    expect(rulesForKind('pug', TEMPLATES.PUG).rated).toBe(true);
  });

  it('parseRules rejects a missing or mistyped field', () => {
    const { pause, ...noPause } = TEMPLATES.PUG;
    expect(() => parseRules(JSON.stringify(noPause))).toThrow(/invalid rules: pause/);
    expect(() => parseRules(JSON.stringify({ ...TEMPLATES.PUG, bosses: 'sometimes' }))).toThrow(/invalid rules: bosses/);
    expect(() => parseRules('not json')).toThrow(/invalid rules/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rulesets.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/rulesets.ts` with the interface above: a field-by-field validator (no library; check each field's type and enum, throw `invalid rules: <dotted field>`), the three templates as literals, `rulesForKind` returning `{ ...rules, rated: kind === 'pug' ? rules.rated : false }`, and `seedRulesetTemplates` doing `INSERT OR IGNORE INTO rulesets (name, rules_json, template) VALUES (?, ?, 1)` for each template. Call `seedRulesetTemplates(db)` in `openDb` right after the `game_configs` seed from Task 1 (import it at the top of `src/db.ts`; `src/rulesets.ts` must import only the `DB` type from `./db.js` to avoid a runtime cycle).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/rulesets.test.ts tests/matchKindSchema.test.ts` then `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rulesets.ts src/db.ts tests/rulesets.test.ts
git commit -m "Match rules module with PUG, Standard Cup and Casual Scrim templates seeded"
```

---

## After all tasks

- Run `npm test` and `npm run typecheck` once more on the branch.
- Do not deploy. Deploying this is the owner's call; it changes no PUG behaviour, so when approved it ships with a normal `deploy-web.sh` run.
- Update the memory file `pug-competitive-platform.md` with the branch name and "foundation plan 1 built, not deployed".
