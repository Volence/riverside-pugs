# Weekly Awards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Monday, freeze last week's awards and recap, post them to a Discord channel as two messages, and show them on the site (a weekly tab on the leaderboard and award chips on profiles).

**Architecture:** Pure computation modules (`src/weeklyAwards.ts`, `src/weeklyRecap.ts`) read the live tables for any week. `src/weeklyStore.ts` freezes a closed week into two new tables once, and everything after that (Discord, site history, profile chips) reads the frozen rows. `src/discord/weeklyPoster.ts` follows the `ModCallPoster` pattern: an hourly tick, one promise chain, the database is the queue.

**Tech Stack:** TypeScript, Fastify 5, better-sqlite3, vitest, Preact + @testing-library/preact, discord.js behind the `BotTransport` seam.

**Spec:** `docs/superpowers/specs/2026-09-27-weekly-awards-design.md`

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/weekly-awards` (branch `weekly-awards`). Other sessions rewrite `master`; never commit there.
- First time only: `npm ci` in the worktree (it has no `node_modules`).
- A week is Monday 00:00 UTC up to the next Monday 00:00 UTC. Week ids are the Monday as `YYYY-MM-DD`. `matches.ended_at` is `YYYY-MM-DD HH:MM:SS` UTC (written by `datetime('now')`), so bounds use that same form and plain string comparison.
- A match counts when `state = 'completed' AND voided_at IS NULL` and `from <= ended_at < to`.
- Minimum games for every average, win rate, SR climb and shame award: setting `weekly_min_games`, default `5`.
- Winner only (no top 3). Ties share the award. A value of zero or less never wins.
- No emoji characters anywhere in the Discord messages.
- Shame awards (group `shame`) never appear in profile chips.
- Setting `discord_weekly_channel_id`, default empty. Empty means nothing is posted, but the week is still frozen.
- Never use em dashes in code, comments, docs or commit messages.
- Run the full suite with `npm test` and types with `npm run typecheck` before each commit that touches `src/` or `web/`.

## Review Focus

- A player whose name contains Discord markdown or a mention (`@everyone`, `**x**`, `<@1>`): the post must show it literally. Pinned in Task 6 via `escapeName`.
- A week with no completed matches (a dead week, or the site was down): freezing still records the week, and the poster sends a short "no matches" recap and no awards embed instead of crashing on empty arrays. Pinned in Tasks 5 and 6.
- A Discord send that fails after the recap was accepted but before the awards: the next tick sends only the awards, never the recap twice. Pinned in Task 7.
- A match that ends exactly at Monday 00:00:00 belongs to the new week, not the old one. Pinned in Task 2.
- An account merge after a week was frozen: the award moves to the kept account and a duplicate on the same award collapses. Pinned in Task 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db.ts` (modify) | Two new tables in `SCHEMA`, two new `DEFAULT_SETTINGS` |
| `src/settingsSchema.ts` (modify) | Admin panel entries for the two settings |
| `src/mergePlayers.ts` (modify) | `weekly_awards` in `KEYED` |
| `src/weeklyAwards.ts` (create) | Week math, award catalog, `computeWeek` |
| `src/weeklyRecap.ts` (create) | `computeRecap` for the recap message |
| `src/weeklyStore.ts` (create) | Freeze, read frozen weeks, per-player award summary |
| `src/discord/weeklyCard.ts` (create) | Render recap and awards payloads, value formatting |
| `src/discord/weeklyPoster.ts` (create) | Hourly freeze + post |
| `src/server.ts` (modify) | Start/stop the poster; register routes |
| `src/routes/weekly.ts` (create) | `GET /api/weekly`, `GET /api/weekly/weeks` |
| `src/playerQueries.ts` (modify) | `weeklyAwards` in the profile payload |
| `scripts/weekly-awards.ts` (create) | Dry run and manual freeze against a DB file |
| `web/src/api.ts` (modify) | Types and client calls |
| `web/src/routes/WeeklyBoard.tsx` (create) | Weekly tab UI |
| `web/src/routes/Leaderboard.tsx` (modify) | Season / This week toggle |
| `web/src/components/WeeklyAwardChips.tsx` (create) | Profile chips |
| `web/src/routes/Profile.tsx` (modify) | Render the chips |
| `tests/weeklyFixtures.ts` (create) | Seeding helpers shared by the weekly tests |

---

### Task 1: Schema, settings, merge

**Files:**
- Modify: `src/db.ts` (end of the `SCHEMA` template string, just before its closing backtick; and `DEFAULT_SETTINGS` near `standing_min_games`)
- Modify: `src/settingsSchema.ts` (next to the `standing_min_games` and `discord_results_channel_id` entries)
- Modify: `src/mergePlayers.ts` (`KEYED` array)
- Create: `tests/weeklyFixtures.ts`
- Test: `tests/weeklySchema.test.ts`

**Interfaces:**
- Produces: tables `weekly_awards`, `weekly_award_weeks`; settings `weekly_min_games`, `discord_weekly_channel_id`; fixtures `PID`, `seedPlayers`, `seedMatch`, `seedRating`, `seedReadyup`.

- [ ] **Step 1: Write the fixtures**

`tests/weeklyFixtures.ts`:

```ts
import type { DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';

/** Seventeen-digit fake SteamID64s: PID(0) .. PID(n). */
export const PID = (n: number): string => `765611990000${String(n).padStart(5, '0')}`;

export function seedPlayers(db: DB, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    upsertPlayer(db, { steamid: PID(i), name: `p${i}`, avatar: null }, []);
    ids.push(PID(i));
  }
  return ids;
}

type Fixed = 'si_damage' | 'si_kills' | 'common_kills' | 'revives';
export interface SeedLine {
  id: string;
  team: 'a' | 'b';
  fixed?: Partial<Record<Fixed, number>>;
  stats?: Record<string, number>;
}

export interface SeedMatch {
  endedAt: string;              // 'YYYY-MM-DD HH:MM:SS'
  wentLiveAt?: string;
  winner?: 'a' | 'b' | 'draw';
  a?: number;
  b?: number;
  campaign?: string;
  state?: 'completed' | 'aborted' | 'live';
  voided?: boolean;
  lines: SeedLine[];
}

export function seedMatch(db: DB, o: SeedMatch): number {
  const id = Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, winner, team_a_score, team_b_score, ended_at, went_live_at, voided_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.state ?? 'completed', o.campaign ?? 'no_mercy', o.winner ?? 'a', o.a ?? 500, o.b ?? 400,
    o.endedAt, o.wentLiveAt ?? null, o.voided ? o.endedAt : null,
  ).lastInsertRowid);
  const mp = db.prepare(
    'INSERT INTO match_players (match_id, player_id, team, si_damage, si_kills, common_kills, revives) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const st = db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)');
  for (const l of o.lines) {
    mp.run(id, l.id, l.team, l.fixed?.si_damage ?? 0, l.fixed?.si_kills ?? 0, l.fixed?.common_kills ?? 0, l.fixed?.revives ?? 0);
    for (const [k, v] of Object.entries(l.stats ?? {})) st.run(id, l.id, k, v);
  }
  return id;
}

/** One rating_history row. mu/sigma chosen so displaySr = round((mu - 2*sigma)*100). */
export function seedRating(db: DB, matchId: number, steamid: string, before: [mu: number, sigma: number], after: [mu: number, sigma: number]): void {
  db.prepare(
    `INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
  ).run(steamid, matchId, before[0], before[1], after[0], after[1]);
}

/** One ready-up in a match with per-player not-ready seconds. */
export function seedReadyup(db: DB, matchId: number, seconds: Record<string, number>): void {
  const rid = Number(db.prepare(
    "INSERT INTO match_readyups (match_id, map_ordinal, half, started_at) VALUES (?, 1, 1, '2026-09-21 12:00:00')",
  ).run(matchId).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_readyup_players (readyup_id, match_id, player_id, seconds) VALUES (?, ?, ?, ?)');
  for (const [p, s] of Object.entries(seconds)) ins.run(rid, matchId, p, s);
}
```

- [ ] **Step 2: Write the failing test**

`tests/weeklySchema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { seedPlayers } from './weeklyFixtures.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('weekly awards schema', () => {
  it('creates both tables and the two settings', () => {
    db.prepare("INSERT INTO weekly_award_weeks (week_start, frozen_at) VALUES ('2026-09-21', '2026-09-28 00:05:00')").run();
    expect(getSetting(db, 'weekly_min_games')).toBe('5');
    expect(getSetting(db, 'discord_weekly_channel_id')).toBe('');
  });

  it('merge moves awards to the kept account and collapses a duplicate', () => {
    const [keep, dup, other] = seedPlayers(db, 3);
    const ins = db.prepare(
      "INSERT INTO weekly_awards (week_start, award, kind, player_id, value, games) VALUES ('2026-09-21', ?, 'avg', ?, ?, 5)",
    );
    ins.run('skeets', keep, 4);
    ins.run('skeets', dup, 4);     // tie on the same award: collapses into one row
    ins.run('crowns', dup, 1);     // moves
    ins.run('revives', other, 2);  // untouched
    mergePlayers(db, dup, keep);
    const rows = db.prepare('SELECT award, player_id FROM weekly_awards ORDER BY award').all();
    expect(rows).toEqual([
      { award: 'crowns', player_id: keep },
      { award: 'revives', player_id: other },
      { award: 'skeets', player_id: keep },
    ]);
  });
});
```

Before writing this test, open `src/mergePlayers.ts` at `export function mergePlayers(` (line ~145) and match its real signature and argument order (`from`, `into`, and any options such as an actor). Adjust the call above to it.

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/weeklySchema.test.ts`
Expected: FAIL, `no such table: weekly_award_weeks`.

- [ ] **Step 4: Add the tables, settings and merge entry**

In `src/db.ts`, append to the end of `SCHEMA`:

```sql
-- Weekly awards (src/weeklyStore.ts). A closed week is frozen once: the
-- winners and the recap are written here and never recomputed, so a void or
-- a rating recompute later cannot quietly change who won a past week.
CREATE TABLE IF NOT EXISTS weekly_awards (
  week_start TEXT NOT NULL,
  award      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('avg','total','single')),
  player_id  TEXT NOT NULL REFERENCES players(steamid),
  value      REAL NOT NULL,
  games      INTEGER NOT NULL,
  detail     TEXT,
  PRIMARY KEY (week_start, award, kind, player_id)
);
CREATE INDEX IF NOT EXISTS weekly_awards_player ON weekly_awards (player_id);
CREATE TABLE IF NOT EXISTS weekly_award_weeks (
  week_start        TEXT PRIMARY KEY,
  frozen_at         TEXT NOT NULL,
  weekly_recap      TEXT NOT NULL DEFAULT '{}',
  recap_message_id  TEXT,
  awards_message_id TEXT,
  posted_at         TEXT
);
```

In `DEFAULT_SETTINGS`, after `standing_min_games: '10',`:

```ts
  // Matches in a week before a player's averages, win rate, SR climb or a
  // shame award count for the weekly awards. Five, not three: at three the
  // week of 2026-09-21 gave an average to a four-game player.
  weekly_min_games: '5',
  // Where the weekly recap and awards are posted. Empty posts nothing; the
  // week is still frozen for the site.
  discord_weekly_channel_id: '',
```

In `src/settingsSchema.ts`, next to `standing_min_games`:

```ts
  { key: 'weekly_min_games', group: 'Stats', label: 'Weekly awards minimum games', help: 'Matches in a week before a player counts for the per-match averages, best win rate, biggest SR climb and the shame awards. Totals have no minimum.', type: { kind: 'int', min: 1, max: 50 } },
```

and next to `discord_results_channel_id`:

```ts
  { key: 'discord_weekly_channel_id', group: 'Discord', label: 'Weekly awards channel id', help: 'Where the weekly recap and awards are posted each Monday. Empty posts nothing; the awards still show on the site.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
```

In `src/mergePlayers.ts`, add to `KEYED` (after `['community_likes', 'player_id'],`):

```ts
  // Primary key (week_start, award, kind, player_id): a tie between the two
  // accounts on the same award collapses into one row.
  ['weekly_awards', 'player_id'],
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/weeklySchema.test.ts tests/db.test.ts tests/adminSettings.test.ts && npx vitest run -t merge`
Expected: PASS. If a parity test lists every player-referencing column or every setting, it now includes the new ones and stays green; if it fails, it names the list to extend.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/settingsSchema.ts src/mergePlayers.ts tests/weeklyFixtures.ts tests/weeklySchema.test.ts
git commit -m "Weekly awards: tables, settings, merge support"
```

---

### Task 2: Week math and the stat awards

**Files:**
- Create: `src/weeklyAwards.ts`
- Test: `tests/weeklyAwards.test.ts`

**Interfaces:**
- Consumes: tables from Task 1, `getSetting`.
- Produces:

```ts
export type AwardGroup = 'survivor' | 'infected' | 'overall' | 'shame';
export type AwardKind = 'avg' | 'total' | 'single';
export interface Winner { steamid: string; name: string; value: number; games: number; detail: string | null }
export interface AwardResult { key: string; label: string; group: AwardGroup; kind: AwardKind; winners: Winner[] }
export interface AwardDef { key: string; label: string; group: AwardGroup }
export const AWARDS: AwardDef[];                       // catalog, display order
export function awardDef(key: string): AwardDef | undefined;
export function weekStartOf(d: Date): string;         // 'YYYY-MM-DD' Monday UTC
export function addWeeks(week: string, n: number): string;
export function weekBounds(week: string): { from: string; to: string };  // 'YYYY-MM-DD HH:MM:SS'
export function weeklyMinGames(db: DB): number;
export function computeWeek(db: DB, week: string): AwardResult[];
```

`computeWeek` returns results in `AWARDS` order; stat awards contribute an `avg` then a `total` result; overall and shame awards contribute one `single` result. Awards with no winner are omitted. Task 3 fills in the overall and shame awards; in this task `computeWeek` returns only the stat awards.

- [ ] **Step 1: Write the failing tests**

`tests/weeklyAwards.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { addWeeks, computeWeek, weekBounds, weekStartOf } from '../src/weeklyAwards.js';
import { seedMatch, seedPlayers } from './weeklyFixtures.js';

let db: DB; let P: string[];
beforeEach(() => { db = openDb(':memory:'); P = seedPlayers(db, 8); });

const W = '2026-09-21';
const at = (day: number, hms = '20:00:00') => `2026-09-${String(21 + day).padStart(2, '0')} ${hms}`;
/** n matches for player p with the given stats each, teammates filler. */
function play(p: string, n: number, stats: Record<string, number>, day = 0) {
  for (let i = 0; i < n; i++) seedMatch(db, { endedAt: at(day, `1${i}:00:00`), lines: [{ id: p, team: 'a', stats }] });
}
const find = (r: ReturnType<typeof computeWeek>, key: string, kind: string) => r.find((x) => x.key === key && x.kind === kind);

describe('week math', () => {
  it('Monday is the start, whatever day is given', () => {
    expect(weekStartOf(new Date('2026-09-21T00:00:00Z'))).toBe(W);
    expect(weekStartOf(new Date('2026-09-27T23:59:59Z'))).toBe(W);
    expect(weekStartOf(new Date('2026-09-28T00:00:00Z'))).toBe('2026-09-28');
    expect(addWeeks(W, -1)).toBe('2026-09-14');
    expect(weekBounds(W)).toEqual({ from: '2026-09-21 00:00:00', to: '2026-09-28 00:00:00' });
  });

  it('a match ending exactly at Monday 00:00:00 belongs to the new week', () => {
    seedMatch(db, { endedAt: '2026-09-28 00:00:00', lines: [{ id: P[0], team: 'a', stats: { skeets: 9 } }] });
    expect(find(computeWeek(db, W), 'skeets', 'total')).toBeUndefined();
    expect(find(computeWeek(db, '2026-09-28'), 'skeets', 'total')?.winners[0].steamid).toBe(P[0]);
  });
});

describe('stat awards', () => {
  it('average needs the minimum games, total does not', () => {
    play(P[0], 4, { skeets: 5 });   // 20 total, 5.0 avg, only 4 games
    play(P[1], 5, { skeets: 3 });   // 15 total, 3.0 avg
    const r = computeWeek(db, W);
    expect(find(r, 'skeets', 'avg')!.winners.map((w) => [w.steamid, w.value, w.games])).toEqual([[P[1], 3, 5]]);
    expect(find(r, 'skeets', 'total')!.winners.map((w) => [w.steamid, w.value])).toEqual([[P[0], 20]]);
  });

  it('the minimum comes from the setting', () => {
    setSetting(db, 'weekly_min_games', '4');
    play(P[0], 4, { skeets: 5 });
    play(P[1], 5, { skeets: 3 });
    expect(find(computeWeek(db, W), 'skeets', 'avg')!.winners[0].steamid).toBe(P[0]);
  });

  it('ties share, zeros never win, voided and aborted matches do not count', () => {
    play(P[0], 5, { boomer_pops: 2 });
    play(P[1], 5, { boomer_pops: 2 });
    play(P[2], 5, { rock_skeets: 0 });
    seedMatch(db, { endedAt: at(1), voided: true, lines: [{ id: P[3], team: 'a', stats: { boomer_pops: 99 } }] });
    seedMatch(db, { endedAt: at(1), state: 'aborted', lines: [{ id: P[3], team: 'a', stats: { boomer_pops: 99 } }] });
    const r = computeWeek(db, W);
    expect(find(r, 'boomer_pops', 'total')!.winners.map((w) => w.steamid).sort()).toEqual([P[0], P[1]]);
    expect(find(r, 'rock_skeets', 'total')).toBeUndefined();
  });

  it('witch crowns adds crowns and draw crowns; fixed columns work', () => {
    play(P[0], 5, { crowns: 1, draw_crowns: 2 });
    seedMatch(db, { endedAt: at(2), lines: [{ id: P[1], team: 'a', fixed: { common_kills: 400 } }] });
    const r = computeWeek(db, W);
    expect(find(r, 'crowns', 'total')!.winners[0].value).toBe(15);
    expect(find(r, 'common_kills', 'total')!.winners[0].value).toBe(400);
  });

  it('a game with no stat row still counts as a game for the average', () => {
    play(P[0], 4, { skeets: 5 });
    seedMatch(db, { endedAt: at(3), lines: [{ id: P[0], team: 'a' }] });   // fifth match, no stats
    expect(find(computeWeek(db, W), 'skeets', 'avg')!.winners[0]).toMatchObject({ value: 4, games: 5 });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/weeklyAwards.test.ts`
Expected: FAIL, cannot resolve `../src/weeklyAwards.js`.

- [ ] **Step 3: Implement**

`src/weeklyAwards.ts`:

```ts
import type { DB } from './db.js';
import { getSetting } from './settings.js';

/**
 * Weekly awards, computed from the live tables for any week.
 *
 * Season boards rank totals, so the same heavy players top everything. The
 * weekly awards reset every Monday and cover many categories so that someone
 * who plays a few nights has something to reach. Every stat award names two
 * winners: the best per-match average among players with enough games, and
 * the biggest total. Nothing here writes; weeklyStore.ts freezes a closed
 * week so later voids cannot rewrite who won.
 */

export type AwardGroup = 'survivor' | 'infected' | 'overall' | 'shame';
export type AwardKind = 'avg' | 'total' | 'single';
export interface Winner { steamid: string; name: string; value: number; games: number; detail: string | null }
export interface AwardResult { key: string; label: string; group: AwardGroup; kind: AwardKind; winners: Winner[] }
export interface AwardDef { key: string; label: string; group: AwardGroup }

type FixedColumn = 'si_damage' | 'si_kills' | 'common_kills' | 'revives';
interface StatAward extends AwardDef { fixed?: FixedColumn; stats?: string[] }

/** Stat awards: an average and a total each. Order is display order. */
const STAT_AWARDS: StatAward[] = [
  { key: 'si_damage', label: 'SI damage', group: 'survivor', fixed: 'si_damage' },
  { key: 'si_kills', label: 'SI kills', group: 'survivor', fixed: 'si_kills' },
  { key: 'common_kills', label: 'Common kills', group: 'survivor', fixed: 'common_kills' },
  { key: 'revives', label: 'Revives', group: 'survivor', fixed: 'revives' },
  { key: 'skeets', label: 'Skeets', group: 'survivor', stats: ['skeets'] },
  { key: 'skeet_assists', label: 'Skeet assists', group: 'survivor', stats: ['skeet_assists'] },
  { key: 'boomer_pops', label: 'Boomer pops', group: 'survivor', stats: ['boomer_pops'] },
  // A draw crown (the witch took chip damage first) is still a crown.
  { key: 'crowns', label: 'Witch crowns', group: 'survivor', stats: ['crowns', 'draw_crowns'] },
  { key: 'rock_skeets', label: 'Rock skeets', group: 'survivor', stats: ['rock_skeets'] },
  { key: 'tongue_clears', label: 'Tongue clears', group: 'survivor', stats: ['tongue_clears'] },
  { key: 'insta_clears', label: 'Insta clears', group: 'survivor', stats: ['insta_clears'] },
  { key: 'tank_damage', label: 'Tank damage', group: 'survivor', stats: ['tank_damage'] },
  { key: 'damage_as_si', label: 'Damage as SI', group: 'infected', stats: ['damage_as_si'] },
  { key: 'dps_landed', label: 'Damage pounces', group: 'infected', stats: ['dps_landed'] },
  { key: 'pounce_damage', label: 'Pounce damage', group: 'infected', stats: ['pounce_damage_high'] },
  { key: 'quad_caps', label: 'Quad caps', group: 'infected', stats: ['quad_caps'] },
  { key: 'booms', label: 'Booms landed', group: 'infected', stats: ['boom_successes'] },
  { key: 'rocks', label: 'Tank rocks landed', group: 'infected', stats: ['tank_rocks_landed'] },
  { key: 'punches', label: 'Tank punches', group: 'infected', stats: ['tank_punches'] },
  { key: 'hunter_damage', label: 'Hunter damage', group: 'infected', stats: ['dmg_as_hunter'] },
  { key: 'smoker_damage', label: 'Smoker damage', group: 'infected', stats: ['dmg_as_smoker'] },
];

/** Single-winner awards, filled in by computeSingles (Task 3). */
const SINGLE_AWARDS: AwardDef[] = [];

export const AWARDS: AwardDef[] = [
  ...STAT_AWARDS.map(({ key, label, group }) => ({ key, label, group })),
  ...SINGLE_AWARDS,
];

export function awardDef(key: string): AwardDef | undefined {
  return AWARDS.find((a) => a.key === key);
}

const DAY_MS = 86_400_000;
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** The Monday (UTC) of the week `d` falls in, as 'YYYY-MM-DD'. */
export function weekStartOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;   // Monday 0 .. Sunday 6
  return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY_MS));
}

export function addWeeks(week: string, n: number): string {
  return ymd(new Date(Date.parse(`${week}T00:00:00Z`) + n * 7 * DAY_MS));
}

/** In the form datetime('now') writes, so string comparison is correct. */
export function weekBounds(week: string): { from: string; to: string } {
  return { from: `${week} 00:00:00`, to: `${addWeeks(week, 1)} 00:00:00` };
}

export function weeklyMinGames(db: DB): number {
  const n = Number(getSetting(db, 'weekly_min_games'));
  return Number.isInteger(n) && n > 0 ? n : 5;
}

/** The matches that count for a week, as a reusable SQL fragment. */
export const WEEK_MATCHES =
  "SELECT id FROM matches WHERE state = 'completed' AND voided_at IS NULL AND ended_at >= ? AND ended_at < ?";

interface PlayerGames { steamid: string; name: string; games: number }

export function playerGames(db: DB, week: string): Map<string, PlayerGames> {
  const { from, to } = weekBounds(week);
  const rows = db.prepare(
    `SELECT mp.player_id AS steamid, p.name, COUNT(*) AS games
     FROM match_players mp JOIN players p ON p.steamid = mp.player_id
     WHERE mp.match_id IN (${WEEK_MATCHES})
     GROUP BY mp.player_id`,
  ).all(from, to) as PlayerGames[];
  return new Map(rows.map((r) => [r.steamid, r]));
}

/** Everyone holding the highest value, if it is above zero. */
export function topOf<T extends { value: number }>(rows: T[]): T[] {
  const best = Math.max(0, ...rows.map((r) => r.value));
  if (!(best > 0)) return [];
  return rows.filter((r) => r.value === best);
}

function statTotals(db: DB, week: string, a: StatAward): Map<string, number> {
  const { from, to } = weekBounds(week);
  const rows = a.fixed
    ? db.prepare(
      `SELECT player_id AS steamid, SUM(${a.fixed}) AS v FROM match_players
       WHERE match_id IN (${WEEK_MATCHES}) GROUP BY player_id`,
    ).all(from, to)
    : db.prepare(
      `SELECT player_id AS steamid, SUM(value) AS v FROM match_player_stats
       WHERE match_id IN (${WEEK_MATCHES}) AND stat IN (${a.stats!.map(() => '?').join(',')})
       GROUP BY player_id`,
    ).all(from, to, ...a.stats!);
  return new Map((rows as { steamid: string; v: number }[]).map((r) => [r.steamid, r.v]));
}

const winner = (g: PlayerGames, value: number, detail: string | null = null): Winner =>
  ({ steamid: g.steamid, name: g.name, value, games: g.games, detail });

export function computeWeek(db: DB, week: string): AwardResult[] {
  const games = playerGames(db, week);
  const min = weeklyMinGames(db);
  const out: AwardResult[] = [];
  for (const a of STAT_AWARDS) {
    const totals = statTotals(db, week, a);
    const rows = [...games.values()].map((g) => ({ g, total: totals.get(g.steamid) ?? 0 }));
    const avg = topOf(rows.filter((r) => r.g.games >= min).map((r) => ({ ...r, value: r.total / r.g.games })));
    const tot = topOf(rows.map((r) => ({ ...r, value: r.total })));
    const base = { key: a.key, label: a.label, group: a.group };
    if (avg.length) out.push({ ...base, kind: 'avg', winners: avg.map((r) => winner(r.g, r.value)) });
    if (tot.length) out.push({ ...base, kind: 'total', winners: tot.map((r) => winner(r.g, r.value)) });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/weeklyAwards.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/weeklyAwards.ts tests/weeklyAwards.test.ts
git commit -m "Weekly awards: week math and per-stat average and total winners"
```

---

### Task 3: Overall and shame awards

**Files:**
- Modify: `src/weeklyAwards.ts`
- Test: `tests/weeklyAwards.test.ts` (append)

**Interfaces:**
- Consumes: `playerGames`, `topOf`, `weekBounds`, `WEEK_MATCHES`, `weeklyMinGames` from Task 2; `displaySr` from `src/rating.ts`.
- Produces: `SINGLE_AWARDS` entries with keys `sr_climb`, `wins`, `win_streak`, `matches`, `win_rate` (group `overall`) and `slow_ready`, `incap_damage`, `group_hug` (group `shame`); `computeWeek` now appends their `single` results in that order. `win_rate` winners carry `detail` like `'15-4'`; everything else `detail: null`.

- [ ] **Step 1: Write the failing tests**

Add `seedRating, seedReadyup` to the existing `./weeklyFixtures.js` import at the top of `tests/weeklyAwards.test.ts`, then append:

```ts
describe('overall awards', () => {
  /** p on team a in each match; results as a string like 'WWLW' (D = draw). */
  function results(p: string, s: string) {
    [...s].forEach((c, i) => seedMatch(db, {
      endedAt: at(0, `${String(10 + i).padStart(2, '0')}:00:00`),
      winner: c === 'W' ? 'a' : c === 'L' ? 'b' : 'draw',
      lines: [{ id: p, team: 'a' }],
    }));
  }
  const single = (key: string) => find(computeWeek(db, W), key, 'single');

  it('most wins, iron man, best win rate with its W-L record', () => {
    results(P[0], 'WWWWL');       // 4-1, 5 games
    results(P[1], 'WWWWWWLLLL');  // 6-4, 10 games
    results(P[2], 'WWWW');        // 4-0 but only 4 games
    expect(single('wins')!.winners.map((w) => w.steamid)).toEqual([P[1]]);
    expect(single('matches')!.winners.map((w) => [w.steamid, w.value])).toEqual([[P[1], 10]]);
    expect(single('win_rate')!.winners.map((w) => [w.steamid, w.value, w.detail])).toEqual([[P[0], 0.8, '4-1']]);
  });

  it('a draw breaks a win streak and does not count as decided', () => {
    results(P[0], 'WWDWWWL');
    results(P[1], 'WWWWL');
    expect(single('win_streak')!.winners.map((w) => [w.steamid, w.value])).toEqual([[P[0], 3]]);
    expect(single('win_rate')!.winners[0]).toMatchObject({ steamid: P[1], detail: '4-1' });
  });

  it('SR climb is displayed SR after the last match minus before the first', () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedMatch(db, { endedAt: at(i), lines: [{ id: P[0], team: 'a' }, { id: P[1], team: 'b' }] }));
    // P0: 25/8.333 (833) up to 30/7 (1600): +767. P1 falls: never a winner.
    ids.forEach((m, i) => {
      seedRating(db, m, P[0], i === 0 ? [25, 8.333] : [26, 8], i === 4 ? [30, 7] : [26, 8]);
      seedRating(db, m, P[1], [25, 8.333], [20, 8]);
    });
    expect(single('sr_climb')!.winners.map((w) => [w.steamid, w.value])).toEqual([[P[0], 767]]);
  });
});

describe('shame awards', () => {
  it('slowest ready-up is the average per ready-up, gated on matches', () => {
    for (let i = 0; i < 5; i++) {
      const m = seedMatch(db, { endedAt: at(i), lines: [{ id: P[0], team: 'a' }, { id: P[1], team: 'b' }] });
      seedReadyup(db, m, { [P[0]]: 40, [P[1]]: 10 });
      seedReadyup(db, m, { [P[0]]: 20, [P[1]]: 10 });
    }
    const m = seedMatch(db, { endedAt: at(5), lines: [{ id: P[2], team: 'a' }] });
    seedReadyup(db, m, { [P[2]]: 500 });   // one match: below the gate
    const s = find(computeWeek(db, W), 'slow_ready', 'single')!;
    expect(s.group).toBe('shame');
    expect(s.winners.map((w) => [w.steamid, w.value])).toEqual([[P[0], 30]]);
  });

  it('incap damage and group hug are per-match averages', () => {
    play(P[0], 5, { dmg_to_incapped: 300, times_quadded: 1 });
    play(P[1], 5, { dmg_to_incapped: 100, times_quadded: 2 });
    const r = computeWeek(db, W);
    expect(find(r, 'incap_damage', 'single')!.winners[0].steamid).toBe(P[0]);
    expect(find(r, 'group_hug', 'single')!.winners[0]).toMatchObject({ steamid: P[1], value: 2 });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/weeklyAwards.test.ts`
Expected: the new tests FAIL (`single(...)` is undefined).

- [ ] **Step 3: Implement**

In `src/weeklyAwards.ts`, add `import { displaySr } from './rating.js';` and replace `const SINGLE_AWARDS: AwardDef[] = [];` with:

```ts
/** Single-winner awards. Order is display order. */
const SINGLE_AWARDS: AwardDef[] = [
  { key: 'sr_climb', label: 'Biggest SR climb', group: 'overall' },
  { key: 'wins', label: 'Most wins', group: 'overall' },
  { key: 'win_streak', label: 'Longest win streak', group: 'overall' },
  { key: 'matches', label: 'Iron man', group: 'overall' },
  { key: 'win_rate', label: 'Best win rate', group: 'overall' },
  { key: 'slow_ready', label: 'Slowest ready-up', group: 'shame' },
  { key: 'incap_damage', label: "Kicking them while they're down", group: 'shame' },
  { key: 'group_hug', label: 'Group hug', group: 'shame' },
];
```

Add below `computeWeek`'s helpers:

```ts
interface Result { steamid: string; winner: 'a' | 'b' | 'draw' | null; team: 'a' | 'b' }

/** Each player's matches this week in order, as W, L or D. */
function resultsByPlayer(db: DB, week: string): Map<string, ('W' | 'L' | 'D')[]> {
  const { from, to } = weekBounds(week);
  const rows = db.prepare(
    `SELECT mp.player_id AS steamid, m.winner, mp.team
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE m.id IN (${WEEK_MATCHES})
     ORDER BY m.ended_at, m.id`,
  ).all(from, to) as Result[];
  const out = new Map<string, ('W' | 'L' | 'D')[]>();
  for (const r of rows) {
    const c = r.winner === r.team ? 'W' : r.winner === 'a' || r.winner === 'b' ? 'L' : 'D';
    out.set(r.steamid, [...(out.get(r.steamid) ?? []), c]);
  }
  return out;
}

function longestRun(seq: string[]): number {
  let best = 0; let run = 0;
  for (const c of seq) { run = c === 'W' ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}

/** Displayed SR after the last rated match of the week minus before the first. */
function srClimbs(db: DB, week: string): Map<string, number> {
  const { from, to } = weekBounds(week);
  const rows = db.prepare(
    `SELECT rh.player_id AS steamid, rh.mu_before, rh.sigma_before, rh.mu_after, rh.sigma_after
     FROM rating_history rh JOIN matches m ON m.id = rh.match_id
     WHERE m.id IN (${WEEK_MATCHES})
     ORDER BY m.ended_at, m.id`,
  ).all(from, to) as { steamid: string; mu_before: number; sigma_before: number; mu_after: number; sigma_after: number }[];
  const first = new Map<string, number>(); const last = new Map<string, number>();
  for (const r of rows) {
    if (!first.has(r.steamid)) first.set(r.steamid, displaySr(r.mu_before, r.sigma_before));
    last.set(r.steamid, displaySr(r.mu_after, r.sigma_after));
  }
  return new Map([...first].map(([id, sr]) => [id, last.get(id)! - sr]));
}

function slowReadyAverages(db: DB, week: string): Map<string, number> {
  const { from, to } = weekBounds(week);
  const rows = db.prepare(
    `SELECT player_id AS steamid, AVG(seconds) AS v FROM match_readyup_players
     WHERE match_id IN (${WEEK_MATCHES}) GROUP BY player_id`,
  ).all(from, to) as { steamid: string; v: number }[];
  return new Map(rows.map((r) => [r.steamid, r.v]));
}

function computeSingles(db: DB, week: string, games: Map<string, PlayerGames>, min: number): AwardResult[] {
  const results = resultsByPlayer(db, week);
  const climbs = srClimbs(db, week);
  const ready = slowReadyAverages(db, week);
  const incap = statTotals(db, week, { key: '', label: '', group: 'shame', stats: ['dmg_to_incapped'] });
  const hugs = statTotals(db, week, { key: '', label: '', group: 'shame', stats: ['times_quadded'] });
  const all = [...games.values()];
  const gated = all.filter((g) => g.games >= min);
  const record = (id: string) => {
    const seq = results.get(id) ?? [];
    return { w: seq.filter((c) => c === 'W').length, l: seq.filter((c) => c === 'L').length, seq };
  };
  const pick: Record<string, Winner[]> = {
    sr_climb: topOf(gated.map((g) => ({ g, value: climbs.get(g.steamid) ?? 0 }))).map((r) => winner(r.g, r.value)),
    wins: topOf(all.map((g) => ({ g, value: record(g.steamid).w }))).map((r) => winner(r.g, r.value)),
    win_streak: topOf(all.map((g) => ({ g, value: longestRun(record(g.steamid).seq) }))).map((r) => winner(r.g, r.value)),
    matches: topOf(all.map((g) => ({ g, value: g.games }))).map((r) => winner(r.g, r.value)),
    win_rate: topOf(all
      .map((g) => ({ g, ...record(g.steamid) }))
      .filter((r) => r.w + r.l >= min)
      .map((r) => ({ ...r, value: r.w / (r.w + r.l) })))
      .map((r) => winner(r.g, r.value, `${r.w}-${r.l}`)),
    slow_ready: topOf(gated.map((g) => ({ g, value: ready.get(g.steamid) ?? 0 }))).map((r) => winner(r.g, r.value)),
    incap_damage: topOf(gated.map((g) => ({ g, value: (incap.get(g.steamid) ?? 0) / g.games }))).map((r) => winner(r.g, r.value)),
    group_hug: topOf(gated.map((g) => ({ g, value: (hugs.get(g.steamid) ?? 0) / g.games }))).map((r) => winner(r.g, r.value)),
  };
  return SINGLE_AWARDS
    .filter((a) => pick[a.key].length > 0)
    .map((a) => ({ key: a.key, label: a.label, group: a.group, kind: 'single' as const, winners: pick[a.key] }));
}
```

At the end of `computeWeek`, before `return out;`:

```ts
  out.push(...computeSingles(db, week, games, min));
```

Note: `statTotals` takes a `StatAward`; the two inline objects above satisfy it. `slow_ready` is gated on matches played (`games`), matching the spec.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/weeklyAwards.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/weeklyAwards.ts tests/weeklyAwards.test.ts
git commit -m "Weekly awards: overall and shame awards"
```

---

### Task 4: The weekly recap

**Files:**
- Create: `src/weeklyRecap.ts`
- Test: `tests/weeklyRecap.test.ts`

**Interfaces:**
- Consumes: `weekBounds`, `WEEK_MATCHES`, `weeklyMinGames` from `src/weeklyAwards.ts`; `campaignDisplayName(db, slug)` from `src/campaignRegistry.ts`.
- Produces:

```ts
export interface RecapPlayer { steamid: string; name: string }
export interface Highlight { key: string; verb: string; label: string; player: RecapPlayer; value: number; matchId: number }
export interface WeekTotal { key: string; label: string; value: number; leader: (RecapPlayer & { value: number }) | null }
export interface Recap {
  matches: number;
  players: number;
  peakConcurrent: number;
  busiestDay: { date: string; matches: number } | null;   // date 'YYYY-MM-DD'
  highlights: Highlight[];                                 // best single game per HIGHLIGHT key, in order
  mostQuads: { matchId: number; quads: number } | null;   // null when no match had a quad
  totals: WeekTotal[];                                     // witch crowns, skeets, common infected
  streaks: (RecapPlayer & { w: number; l: number })[];    // up to 4, best win rate first, min games decided
  iron: (RecapPlayer & { games: number })[];               // everyone on the top count, then the next count
  closest: { matchId: number; campaign: string; a: number; b: number } | null;
}
export function computeRecap(db: DB, week: string): Recap;
```

- [ ] **Step 1: Write the failing tests**

`tests/weeklyRecap.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { computeRecap } from '../src/weeklyRecap.js';
import { seedMatch, seedPlayers } from './weeklyFixtures.js';

let db: DB; let P: string[];
beforeEach(() => { db = openDb(':memory:'); P = seedPlayers(db, 8); });
const W = '2026-09-21';

describe('computeRecap', () => {
  it('an empty week is all zeros and nulls, not a crash', () => {
    expect(computeRecap(db, W)).toEqual({
      matches: 0, players: 0, peakConcurrent: 0, busiestDay: null, highlights: [], mostQuads: null,
      totals: [
        { key: 'crowns', label: 'witch crowns', value: 0, leader: null },
        { key: 'skeets', label: 'skeets', value: 0, leader: null },
        { key: 'common_kills', label: 'common infected', value: 0, leader: null },
      ],
      streaks: [], iron: [], closest: null,
    });
  });

  it('headline numbers, peak overlap and busiest day', () => {
    seedMatch(db, { wentLiveAt: '2026-09-22 20:00:00', endedAt: '2026-09-22 21:00:00', lines: [{ id: P[0], team: 'a' }, { id: P[1], team: 'b' }] });
    seedMatch(db, { wentLiveAt: '2026-09-22 20:30:00', endedAt: '2026-09-22 21:30:00', lines: [{ id: P[2], team: 'a' }] });
    seedMatch(db, { wentLiveAt: '2026-09-23 20:00:00', endedAt: '2026-09-23 21:00:00', lines: [{ id: P[0], team: 'a' }] });
    const r = computeRecap(db, W);
    expect([r.matches, r.players, r.peakConcurrent]).toEqual([3, 3, 2]);
    expect(r.busiestDay).toEqual({ date: '2026-09-22', matches: 2 });
  });

  it('best single game names the match; quads count once per team, not per player', () => {
    const m1 = seedMatch(db, { endedAt: '2026-09-22 21:00:00', lines: [
      { id: P[0], team: 'a', stats: { skeets: 12, quad_caps: 2 } },
      { id: P[1], team: 'a', stats: { quad_caps: 2 } },
      { id: P[2], team: 'b', stats: { quad_caps: 1 } },
    ] });
    seedMatch(db, { endedAt: '2026-09-23 21:00:00', lines: [{ id: P[3], team: 'a', stats: { skeets: 4 } }] });
    const r = computeRecap(db, W);
    expect(r.highlights.find((h) => h.key === 'skeets')).toMatchObject({ player: { steamid: P[0] }, value: 12, matchId: m1 });
    expect(r.mostQuads).toEqual({ matchId: m1, quads: 3 });
    expect(r.totals.find((t) => t.key === 'skeets')).toMatchObject({ value: 16, leader: { steamid: P[0], value: 12 } });
  });

  it('streaks need the minimum decided games; iron lists the top count and the runner-up', () => {
    for (let i = 0; i < 6; i++) {
      seedMatch(db, { endedAt: `2026-09-24 1${i}:00:00`, winner: i < 5 ? 'a' : 'b', lines: [
        { id: P[0], team: 'a' }, { id: P[1], team: 'a' }, ...(i < 4 ? [{ id: P[2], team: 'a' as const }] : []),
      ] });
    }
    const r = computeRecap(db, W);
    expect(r.streaks.map((s) => [s.steamid, s.w, s.l])).toEqual([[P[0], 5, 1], [P[1], 5, 1]]);
    expect(r.iron.map((x) => [x.steamid, x.games])).toEqual([[P[0], 6], [P[1], 6], [P[2], 4]]);
  });

  it('closest game is the smallest margin', () => {
    seedMatch(db, { endedAt: '2026-09-22 21:00:00', a: 500, b: 300, lines: [{ id: P[0], team: 'a' }] });
    const m = seedMatch(db, { endedAt: '2026-09-23 21:00:00', a: 177, b: 178, campaign: 'death_toll', lines: [{ id: P[0], team: 'a' }] });
    expect(computeRecap(db, W).closest).toMatchObject({ matchId: m, a: 177, b: 178 });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/weeklyRecap.test.ts`
Expected: FAIL, cannot resolve `../src/weeklyRecap.js`.

- [ ] **Step 3: Implement**

`src/weeklyRecap.ts`:

```ts
import type { DB } from './db.js';
import { campaignDisplayName } from './campaignRegistry.js';
import { WEEK_MATCHES, weekBounds, weeklyMinGames } from './weeklyAwards.js';

/**
 * The numbers behind the weekly recap message, modelled on the owner's hand
 * written "Friday recap" that players liked: how busy the week was, the best
 * single games (each naming its match), hot streaks as W-L records, the
 * iron players and the closest game.
 */

export interface RecapPlayer { steamid: string; name: string }
export interface Highlight { key: string; verb: string; label: string; player: RecapPlayer; value: number; matchId: number }
export interface WeekTotal { key: string; label: string; value: number; leader: (RecapPlayer & { value: number }) | null }
export interface Recap {
  matches: number;
  players: number;
  peakConcurrent: number;
  busiestDay: { date: string; matches: number } | null;
  highlights: Highlight[];
  mostQuads: { matchId: number; quads: number } | null;
  totals: WeekTotal[];
  streaks: (RecapPlayer & { w: number; l: number })[];
  iron: (RecapPlayer & { games: number })[];
  closest: { matchId: number; campaign: string; a: number; b: number } | null;
}

/** Best single game of the week for each of these, in this order. */
const HIGHLIGHTS: { key: string; verb: string; label: string; fixed?: string; stat?: string }[] = [
  { key: 'skeets', verb: 'landed', label: 'skeets', stat: 'skeets' },
  { key: 'tank_damage', verb: 'did', label: 'tank damage', stat: 'tank_damage' },
  { key: 'common_kills', verb: 'mowed down', label: 'common', fixed: 'common_kills' },
  { key: 'rock_skeets', verb: 'skeeted', label: 'rocks', stat: 'rock_skeets' },
  { key: 'boomer_pops', verb: 'popped', label: 'boomers', stat: 'boomer_pops' },
  { key: 'dps_landed', verb: 'landed', label: 'damage pounces', stat: 'dps_landed' },
];

const STREAKS_SHOWN = 4;

export function computeRecap(db: DB, week: string): Recap {
  const { from, to } = weekBounds(week);
  const inWeek = `(${WEEK_MATCHES})`;
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(from, to, ...args) as T | undefined;
  const many = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(from, to, ...args) as T[];

  const matches = one<{ n: number }>(`SELECT COUNT(*) AS n FROM matches WHERE id IN ${inWeek}`)!.n;
  const players = one<{ n: number }>(`SELECT COUNT(DISTINCT player_id) AS n FROM match_players WHERE match_id IN ${inWeek}`)!.n;

  // Peak: for each match's start, how many matches were running at that moment.
  const spans = many<{ s: string; e: string }>(
    `SELECT went_live_at AS s, ended_at AS e FROM matches WHERE id IN ${inWeek} AND went_live_at IS NOT NULL`,
  );
  const peakConcurrent = spans.reduce((best, x) => Math.max(best, spans.filter((y) => y.s <= x.s && y.e > x.s).length), 0);

  const busy = one<{ date: string; matches: number }>(
    `SELECT substr(ended_at, 1, 10) AS date, COUNT(*) AS matches FROM matches WHERE id IN ${inWeek}
     GROUP BY date ORDER BY matches DESC, date LIMIT 1`,
  );

  const highlights: Highlight[] = [];
  for (const h of HIGHLIGHTS) {
    const row = h.fixed
      ? one<{ steamid: string; name: string; value: number; matchId: number }>(
        `SELECT mp.player_id AS steamid, p.name, mp.${h.fixed} AS value, mp.match_id AS matchId
         FROM match_players mp JOIN players p ON p.steamid = mp.player_id
         WHERE mp.match_id IN ${inWeek} ORDER BY value DESC, mp.match_id LIMIT 1`)
      : one<{ steamid: string; name: string; value: number; matchId: number }>(
        `SELECT s.player_id AS steamid, p.name, s.value, s.match_id AS matchId
         FROM match_player_stats s JOIN players p ON p.steamid = s.player_id
         WHERE s.match_id IN ${inWeek} AND s.stat = ? ORDER BY s.value DESC, s.match_id LIMIT 1`, h.stat);
    if (row && row.value > 0) {
      highlights.push({ key: h.key, verb: h.verb, label: h.label, player: { steamid: row.steamid, name: row.name }, value: row.value, matchId: row.matchId });
    }
  }

  // quad_caps credits every infected player in the quad, so summing a match
  // counts each quad four times. The highest on each team is that team's
  // count; the two teams play infected in their own halves.
  const quads = one<{ matchId: number; quads: number }>(
    `SELECT match_id AS matchId, SUM(best) AS quads FROM (
       SELECT s.match_id, mp.team, MAX(s.value) AS best
       FROM match_player_stats s JOIN match_players mp ON mp.match_id = s.match_id AND mp.player_id = s.player_id
       WHERE s.match_id IN ${inWeek} AND s.stat = 'quad_caps' GROUP BY s.match_id, mp.team)
     GROUP BY match_id ORDER BY quads DESC, match_id LIMIT 1`,
  );

  const total = (key: string, label: string, sql: string, ...args: unknown[]): WeekTotal => {
    const rows = many<{ steamid: string; name: string; value: number }>(sql, ...args);
    const value = rows.reduce((s, r) => s + r.value, 0);
    const top = rows[0];
    return { key, label, value, leader: top && top.value > 0 ? { steamid: top.steamid, name: top.name, value: top.value } : null };
  };
  const statTotal = (stats: string[]) =>
    `SELECT s.player_id AS steamid, p.name, SUM(s.value) AS value FROM match_player_stats s JOIN players p ON p.steamid = s.player_id
     WHERE s.match_id IN ${inWeek} AND s.stat IN (${stats.map(() => '?').join(',')}) GROUP BY s.player_id ORDER BY value DESC, p.name`;
  const totals = [
    total('crowns', 'witch crowns', statTotal(['crowns', 'draw_crowns']), 'crowns', 'draw_crowns'),
    total('skeets', 'skeets', statTotal(['skeets']), 'skeets'),
    total('common_kills', 'common infected',
      `SELECT mp.player_id AS steamid, p.name, SUM(mp.common_kills) AS value FROM match_players mp JOIN players p ON p.steamid = mp.player_id
       WHERE mp.match_id IN ${inWeek} GROUP BY mp.player_id ORDER BY value DESC, p.name`),
  ];

  const min = weeklyMinGames(db);
  const records = many<{ steamid: string; name: string; w: number; l: number; games: number }>(
    `SELECT mp.player_id AS steamid, p.name,
            SUM(m.winner = mp.team) AS w,
            SUM(m.winner IN ('a','b') AND m.winner != mp.team) AS l,
            COUNT(*) AS games
     FROM match_players mp JOIN matches m ON m.id = mp.match_id JOIN players p ON p.steamid = mp.player_id
     WHERE m.id IN ${inWeek} GROUP BY mp.player_id`,
  );
  const streaks = records
    .filter((r) => r.w + r.l >= min && r.w > r.l)
    .sort((a, b) => b.w / (b.w + b.l) - a.w / (a.w + a.l) || b.w - a.w || a.name.localeCompare(b.name))
    .slice(0, STREAKS_SHOWN)
    .map(({ steamid, name, w, l }) => ({ steamid, name, w, l }));

  const counts = [...new Set(records.map((r) => r.games))].sort((a, b) => b - a).slice(0, 2);
  const iron = records
    .filter((r) => counts.includes(r.games))
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name))
    .map(({ steamid, name, games }) => ({ steamid, name, games }));

  const close = one<{ matchId: number; campaign: string; a: number; b: number }>(
    `SELECT id AS matchId, campaign, team_a_score AS a, team_b_score AS b FROM matches WHERE id IN ${inWeek}
     ORDER BY ABS(team_a_score - team_b_score), id LIMIT 1`,
  );

  return {
    matches, players, peakConcurrent,
    busiestDay: busy ?? null,
    highlights,
    mostQuads: quads && quads.quads > 0 ? quads : null,
    totals, streaks, iron,
    closest: close ? { ...close, campaign: campaignDisplayName(db, close.campaign) } : null,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/weeklyRecap.test.ts`
Expected: PASS (5 tests). If `campaignDisplayName` returns something other than the slug for an unknown slug in the empty-registry test DB, the closest-game test still passes because it matches on `matchId`, `a`, `b` only.

- [ ] **Step 5: Commit**

```bash
git add src/weeklyRecap.ts tests/weeklyRecap.test.ts
git commit -m "Weekly awards: recap numbers (highlights, streaks, iron players, closest game)"
```

---

### Task 5: Freezing and reading frozen weeks

**Files:**
- Create: `src/weeklyStore.ts`
- Test: `tests/weeklyStore.test.ts`

**Interfaces:**
- Consumes: `computeWeek`, `AWARDS`, `awardDef`, `AwardResult`, `Winner` from Task 2/3; `computeRecap`, `Recap` from Task 4.
- Produces:

```ts
export interface FrozenWeek { week: string; frozenAt: string; postedAt: string | null; awards: AwardResult[]; recap: Recap }
export interface PlayerAward { award: string; label: string; count: number; weeks: string[] }  // weeks newest first
export function freezeWeek(db: DB, week: string): boolean;          // false when already frozen
export function frozenWeek(db: DB, week: string): FrozenWeek | null;
export function frozenWeeks(db: DB): string[];                       // newest first
export function playerWeeklyAwards(db: DB, steamid: string): PlayerAward[];  // no shame awards; most won first
```

- [ ] **Step 1: Write the failing tests**

`tests/weeklyStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { freezeWeek, frozenWeek, frozenWeeks, playerWeeklyAwards } from '../src/weeklyStore.js';
import { seedMatch, seedPlayers, seedReadyup } from './weeklyFixtures.js';

let db: DB; let P: string[];
beforeEach(() => { db = openDb(':memory:'); P = seedPlayers(db, 4); });
const W = '2026-09-21';
const W2 = '2026-09-28';
function skeetWeek(week: string, p: string, n = 5) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(seedMatch(db, { endedAt: `${week} 1${i}:00:00`, lines: [{ id: p, team: 'a', stats: { skeets: 3 } }] }));
  return ids;
}

describe('weeklyStore', () => {
  it('freezes once and reads back the same awards and recap', () => {
    skeetWeek(W, P[0]);
    expect(freezeWeek(db, W)).toBe(true);
    expect(freezeWeek(db, W)).toBe(false);
    const f = frozenWeek(db, W)!;
    expect(f.awards.find((a) => a.key === 'skeets' && a.kind === 'avg')!.winners[0]).toMatchObject({ steamid: P[0], name: 'p0', value: 3, games: 5 });
    expect(f.recap.matches).toBe(5);
    expect(f.postedAt).toBeNull();
  });

  it('a void after freezing does not change the frozen week', () => {
    const ids = skeetWeek(W, P[0]);
    freezeWeek(db, W);
    db.prepare("UPDATE matches SET voided_at = '2026-09-29 00:00:00' WHERE id = ?").run(ids[0]);
    expect(frozenWeek(db, W)!.recap.matches).toBe(5);
  });

  it('a week with no matches still freezes, with no awards', () => {
    expect(freezeWeek(db, W)).toBe(true);
    expect(frozenWeek(db, W)).toMatchObject({ awards: [], recap: { matches: 0 } });
  });

  it('keeps the win rate detail', () => {
    for (let i = 0; i < 5; i++) seedMatch(db, { endedAt: `${W} 1${i}:00:00`, winner: i < 4 ? 'a' : 'b', lines: [{ id: P[0], team: 'a' }] });
    freezeWeek(db, W);
    expect(frozenWeek(db, W)!.awards.find((a) => a.key === 'win_rate')!.winners[0].detail).toBe('4-1');
  });

  it('player awards group by award, count weeks, and leave out shame awards', () => {
    const a = skeetWeek(W, P[0]);
    a.forEach((m) => seedReadyup(db, m, { [P[0]]: 60 }));
    skeetWeek(W2, P[0]);
    freezeWeek(db, W); freezeWeek(db, W2);
    expect(frozenWeeks(db)).toEqual([W2, W]);
    const mine = playerWeeklyAwards(db, P[0]);
    const skeets = mine.find((x) => x.award === 'skeets')!;
    expect(skeets).toEqual({ award: 'skeets', label: 'Skeets', count: 2, weeks: [W2, W] });   // avg and total in a week count once
    expect(mine.some((x) => x.award === 'slow_ready')).toBe(false);
    expect(mine[0].count).toBeGreaterThanOrEqual(mine[mine.length - 1].count);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/weeklyStore.test.ts`
Expected: FAIL, cannot resolve `../src/weeklyStore.js`.

- [ ] **Step 3: Implement**

`src/weeklyStore.ts`:

```ts
import type { DB } from './db.js';
import { AWARDS, awardDef, computeWeek, type AwardKind, type AwardResult, type Winner } from './weeklyAwards.js';
import { computeRecap, type Recap } from './weeklyRecap.js';

/**
 * Frozen weeks. A closed week is computed once and written here; the Discord
 * post, the site's past weeks and the profile chips read only these rows, so
 * a later void or rating recompute cannot quietly change who won.
 */

export interface FrozenWeek { week: string; frozenAt: string; postedAt: string | null; awards: AwardResult[]; recap: Recap }
export interface PlayerAward { award: string; label: string; count: number; weeks: string[] }

export function freezeWeek(db: DB, week: string): boolean {
  return db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM weekly_award_weeks WHERE week_start = ?').get(week);
    if (exists) return false;
    const awards = computeWeek(db, week);
    const recap = computeRecap(db, week);
    db.prepare("INSERT INTO weekly_award_weeks (week_start, frozen_at, weekly_recap) VALUES (?, datetime('now'), ?)")
      .run(week, JSON.stringify(recap));
    const ins = db.prepare(
      'INSERT INTO weekly_awards (week_start, award, kind, player_id, value, games, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const a of awards) for (const w of a.winners) ins.run(week, a.key, a.kind, w.steamid, w.value, w.games, w.detail);
    return true;
  })();
}

const KIND_ORDER: Record<AwardKind, number> = { avg: 0, total: 1, single: 2 };

export function frozenWeek(db: DB, week: string): FrozenWeek | null {
  const head = db.prepare('SELECT frozen_at, posted_at, weekly_recap FROM weekly_award_weeks WHERE week_start = ?')
    .get(week) as { frozen_at: string; posted_at: string | null; weekly_recap: string } | undefined;
  if (!head) return null;
  const rows = db.prepare(
    `SELECT wa.award, wa.kind, wa.player_id AS steamid, p.name, wa.value, wa.games, wa.detail
     FROM weekly_awards wa JOIN players p ON p.steamid = wa.player_id
     WHERE wa.week_start = ? ORDER BY p.name`,
  ).all(week) as (Winner & { award: string; kind: AwardKind })[];
  const byKey = new Map<string, AwardResult>();
  for (const r of rows) {
    const def = awardDef(r.award);
    if (!def) continue;   // an award since removed from the catalog
    const id = `${r.award}:${r.kind}`;
    const a = byKey.get(id) ?? { key: def.key, label: def.label, group: def.group, kind: r.kind, winners: [] };
    a.winners.push({ steamid: r.steamid, name: r.name, value: r.value, games: r.games, detail: r.detail });
    byKey.set(id, a);
  }
  const order = (a: AwardResult) => AWARDS.findIndex((d) => d.key === a.key) * 3 + KIND_ORDER[a.kind];
  return {
    week, frozenAt: head.frozen_at, postedAt: head.posted_at,
    awards: [...byKey.values()].sort((a, b) => order(a) - order(b)),
    recap: JSON.parse(head.weekly_recap) as Recap,
  };
}

export function frozenWeeks(db: DB): string[] {
  return (db.prepare('SELECT week_start FROM weekly_award_weeks ORDER BY week_start DESC').all() as { week_start: string }[])
    .map((r) => r.week_start);
}

export function playerWeeklyAwards(db: DB, steamid: string): PlayerAward[] {
  const rows = db.prepare(
    'SELECT DISTINCT award, week_start FROM weekly_awards WHERE player_id = ? ORDER BY week_start DESC',
  ).all(steamid) as { award: string; week_start: string }[];
  const out = new Map<string, PlayerAward>();
  for (const r of rows) {
    const def = awardDef(r.award);
    if (!def || def.group === 'shame') continue;
    const a = out.get(r.award) ?? { award: r.award, label: def.label, count: 0, weeks: [] };
    a.count++; a.weeks.push(r.week_start);
    out.set(r.award, a);
  }
  return [...out.values()].sort((a, b) => b.count - a.count || b.weeks[0].localeCompare(a.weeks[0]) || a.label.localeCompare(b.label));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/weeklyStore.test.ts tests/weeklySchema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/weeklyStore.ts tests/weeklyStore.test.ts
git commit -m "Weekly awards: freeze a closed week and read it back"
```

---

### Task 6: Discord rendering

**Files:**
- Create: `src/discord/weeklyCard.ts`
- Test: `tests/weeklyCard.test.ts`

**Interfaces:**
- Consumes: `FrozenWeek` (Task 5), `AwardResult`, `Winner` (Task 2), `Recap` (Task 4), `escapeName` from `src/identity.ts`, `MessagePayload` from `src/discord/transport.ts`.
- Produces:

```ts
export function formatAwardValue(key: string, kind: AwardKind, w: Winner): string;
export function renderRecap(f: FrozenWeek, publicUrl: string): MessagePayload;          // content only, <= 2000 chars
export function renderAwards(f: FrozenWeek, publicUrl: string): MessagePayload | null; // one embed; null when no awards
```

Formatting rules (tests pin them):
- `avg`: damage-like keys (`si_damage`, `tank_damage`, `damage_as_si`, `pounce_damage`, `hunter_damage`, `smoker_damage`) as a whole number with thousands separators, others with one decimal; suffix `/g`. Example `8,806/g`, `4.6/g`.
- `total`: whole number with separators plus ` total`. Example `187 total`.
- `single`: `sr_climb` `+767 SR`; `wins` `12 wins`; `win_streak` `7 in a row`; `matches` `57 games`; `win_rate` its detail (`15-4`); `slow_ready` `54s per ready-up`; `incap_damage` `312/g`; `group_hug` `1.4/g`.
- Tied winners join with ` & `.
- Award line: `**Skeets**: VII 4.6/g, VII 187 total`, and when the avg and total winner sets are the same players: `**Skeets**: VII (4.6/g, 187 total)`. An award with only one of the two kinds shows just that one.

- [ ] **Step 1: Write the failing tests**

`tests/weeklyCard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatAwardValue, renderAwards, renderRecap } from '../src/discord/weeklyCard.js';
import type { FrozenWeek } from '../src/weeklyStore.js';
import type { Recap } from '../src/weeklyRecap.js';

const w = (steamid: string, name: string, value: number, detail: string | null = null) => ({ steamid, name, value, games: 5, detail });
const emptyRecap: Recap = {
  matches: 0, players: 0, peakConcurrent: 0, busiestDay: null, highlights: [], mostQuads: null,
  totals: [], streaks: [], iron: [], closest: null,
};
const week = (over: Partial<FrozenWeek> = {}): FrozenWeek => ({
  week: '2026-09-21', frozenAt: '2026-09-28 00:05:00', postedAt: null, recap: emptyRecap, awards: [], ...over,
});
const EMOJI = /\p{Extended_Pictographic}/u;

describe('formatAwardValue', () => {
  it('formats each kind', () => {
    expect(formatAwardValue('tank_damage', 'avg', w('1', 'a', 8805.9))).toBe('8,806/g');
    expect(formatAwardValue('skeets', 'avg', w('1', 'a', 4.62))).toBe('4.6/g');
    expect(formatAwardValue('skeets', 'total', w('1', 'a', 1870))).toBe('1,870 total');
    expect(formatAwardValue('sr_climb', 'single', w('1', 'a', 767))).toBe('+767 SR');
    expect(formatAwardValue('win_rate', 'single', w('1', 'a', 0.79, '15-4'))).toBe('15-4');
    expect(formatAwardValue('slow_ready', 'single', w('1', 'a', 53.8))).toBe('54s per ready-up');
  });
});

describe('renderAwards', () => {
  it('collapses a double winner, joins ties, escapes names, has no emoji', () => {
    const f = week({ awards: [
      { key: 'skeets', label: 'Skeets', group: 'survivor', kind: 'avg', winners: [w('1', 'VII', 4.6)] },
      { key: 'skeets', label: 'Skeets', group: 'survivor', kind: 'total', winners: [w('1', 'VII', 187)] },
      { key: 'crowns', label: 'Witch crowns', group: 'survivor', kind: 'total', winners: [w('2', '**b**', 8), w('3', '@everyone', 8)] },
      { key: 'slow_ready', label: 'Slowest ready-up', group: 'shame', kind: 'single', winners: [w('4', 'slow', 53.8)] },
    ] });
    const p = renderAwards(f, 'https://pug.test')!;
    const text = p.embeds[0].description!;
    expect(text).toContain('**Skeets**: VII (4.6/g, 187 total)');
    expect(text).toContain('**Witch crowns**: \\*\\*b\\*\\* & \\@everyone 8 total');
    expect(text).toContain('**Shame**');
    expect(text).toContain('https://pug.test/leaderboard?week=2026-09-21');
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(EMOJI.test(JSON.stringify(p))).toBe(false);
    expect(p.mentionUserIds).toEqual([]);
  });

  it('returns null for a week with no awards', () => {
    expect(renderAwards(week(), 'https://pug.test')).toBeNull();
  });
});

describe('renderRecap', () => {
  it('writes the headline and sections like the Friday recap, under 2000 characters', () => {
    const recap: Recap = {
      ...emptyRecap, matches: 167, players: 138, peakConcurrent: 4, busiestDay: { date: '2026-09-26', matches: 36 },
      highlights: [{ key: 'skeets', verb: 'landed', label: 'skeets', player: { steamid: '1', name: 'epx' }, value: 12, matchId: 224 }],
      mostQuads: { matchId: 218, quads: 3 },
      totals: [{ key: 'skeets', label: 'skeets', value: 2822, leader: { steamid: '1', name: 'VII', value: 187 } }],
      streaks: [{ steamid: '5', name: 'mado', w: 15, l: 4 }],
      iron: [{ steamid: '6', name: 'shove', games: 57 }, { steamid: '7', name: 'adam', games: 51 }],
      closest: { matchId: 154, campaign: 'Death Toll', a: 177, b: 178 },
    };
    const c = renderRecap(week({ recap }), 'https://pug.test').content!;
    expect(c).toContain('**Weekly recap, week of Sep 21**');
    expect(c).toContain('**167 matches**');
    expect(c).toContain('**138 different players**');
    expect(c).toContain('**epx** landed **12 skeets** in one game (match 224)');
    expect(c).toContain('Match 218 had **3 quad caps**');
    expect(c).toContain('**mado** went **15-4**');
    expect(c).toContain('**shove** played **57 games**, with **adam** close behind at 51');
    expect(c).toContain('**Closest game:** match 154 on Death Toll, **178 to 177**');
    expect(c.length).toBeLessThanOrEqual(2000);
    expect(EMOJI.test(c)).toBe(false);
  });

  it('a week with no matches says so briefly', () => {
    expect(renderRecap(week(), 'https://pug.test').content).toBe('**Weekly recap, week of Sep 21**\n\nNo matches were played this week.');
  });

  it('drops highlights from the end until it fits in 2000 characters', () => {
    const long = 'x'.repeat(30);
    const highlights = Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, verb: 'landed', label: 'skeets', player: { steamid: String(i), name: long }, value: 9, matchId: i }));
    const c = renderRecap(week({ recap: { ...emptyRecap, matches: 1, players: 1, highlights } }), 'https://pug.test').content!;
    expect(c.length).toBeLessThanOrEqual(2000);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/weeklyCard.test.ts`
Expected: FAIL, cannot resolve `../src/discord/weeklyCard.js`.

- [ ] **Step 3: Implement**

`src/discord/weeklyCard.ts`:

```ts
import { escapeName } from '../identity.js';
import type { AwardGroup, AwardKind, AwardResult, Winner } from '../weeklyAwards.js';
import type { FrozenWeek } from '../weeklyStore.js';
import type { MessagePayload } from './transport.js';

/**
 * The two weekly messages: a recap written like the owner's hand-made
 * "Friday recap" (plain markdown, bold numbers, match numbers named), then
 * the awards as one embed. Two messages because a plain message is capped at
 * 2,000 characters and the two together are longer. No emoji anywhere, by
 * the owner's ruling. Names are escaped at the source (escapeName) and no
 * message may ping anyone.
 */

const RECAP_LIMIT = 2000;
const EMBED_LIMIT = 4096;
const DAMAGE = new Set(['si_damage', 'tank_damage', 'damage_as_si', 'pounce_damage', 'hunter_damage', 'smoker_damage', 'incap_damage']);
const GROUPS: { group: AwardGroup; title: string }[] = [
  { group: 'survivor', title: 'Survivor' },
  { group: 'infected', title: 'Infected' },
  { group: 'overall', title: 'Overall' },
  { group: 'shame', title: 'Shame' },
];

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const n1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const b = (s: string | number) => `**${s}**`;
const name = (s: string) => escapeName(s);

export function weekLabel(week: string): string {
  return new Date(`${week}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatAwardValue(key: string, kind: AwardKind, w: Winner): string {
  if (kind === 'avg') return `${DAMAGE.has(key) ? n0(w.value) : n1(w.value)}/g`;
  if (kind === 'total') return `${n0(w.value)} total`;
  switch (key) {
    case 'sr_climb': return `+${n0(w.value)} SR`;
    case 'wins': return `${n0(w.value)} wins`;
    case 'win_streak': return `${n0(w.value)} in a row`;
    case 'matches': return `${n0(w.value)} games`;
    case 'win_rate': return w.detail ?? `${Math.round(w.value * 100)}%`;
    case 'slow_ready': return `${n0(w.value)}s per ready-up`;
    default: return `${DAMAGE.has(key) ? n0(w.value) : n1(w.value)}/g`;
  }
}

const names = (ws: Winner[]) => ws.map((w) => name(w.name)).join(' & ');
const sameSet = (a: Winner[], c: Winner[]) =>
  a.length === c.length && a.every((w) => c.some((x) => x.steamid === w.steamid));

function awardLine(label: string, parts: AwardResult[]): string {
  const avg = parts.find((p) => p.kind === 'avg');
  const tot = parts.find((p) => p.kind === 'total');
  const single = parts.find((p) => p.kind === 'single');
  const v = (p: AwardResult) => formatAwardValue(p.key, p.kind, p.winners[0]);
  if (single) return `${b(label)}: ${names(single.winners)} ${v(single)}`;
  if (avg && tot && sameSet(avg.winners, tot.winners)) return `${b(label)}: ${names(avg.winners)} (${v(avg)}, ${v(tot)})`;
  const bits = [avg, tot].filter((p): p is AwardResult => !!p).map((p) => `${names(p.winners)} ${v(p)}`);
  return `${b(label)}: ${bits.join(', ')}`;
}

export function renderAwards(f: FrozenWeek, publicUrl: string): MessagePayload | null {
  if (f.awards.length === 0) return null;
  const sections: string[] = [];
  for (const g of GROUPS) {
    const inGroup = f.awards.filter((a) => a.group === g.group);
    if (!inGroup.length) continue;
    const keys = [...new Set(inGroup.map((a) => a.key))];
    const lines = keys.map((k) => awardLine(inGroup.find((a) => a.key === k)!.label, inGroup.filter((a) => a.key === k)));
    sections.push(`${b(g.title)}\n${lines.join('\n')}`);
  }
  const footer = `Averages need a minimum number of games that week. Full list: ${publicUrl}/leaderboard?week=${f.week}`;
  let description = `${sections.join('\n\n')}\n\n${footer}`;
  if (description.length > EMBED_LIMIT) description = `${description.slice(0, EMBED_LIMIT - 2)}..`;
  return {
    embeds: [{ title: `Weekly awards, week of ${weekLabel(f.week)}`, description }],
    components: [],
    mentionUserIds: [],
  };
}

export function renderRecap(f: FrozenWeek, _publicUrl: string): MessagePayload {
  const r = f.recap;
  const title = b(`Weekly recap, week of ${weekLabel(f.week)}`);
  const payload = (content: string): MessagePayload => ({ content, embeds: [], components: [], mentionUserIds: [] });
  if (r.matches === 0) return payload(`${title}\n\nNo matches were played this week.`);

  const head = [
    `${b(`${n0(r.matches)} matches`)} this week with ${b(`${n0(r.players)} different players`)}`,
    r.peakConcurrent > 1 ? `up to ${b(r.peakConcurrent)} games running at once` : '',
    r.busiestDay ? `and the busiest day was ${new Date(`${r.busiestDay.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} with ${b(`${r.busiestDay.matches} matches`)}` : '',
  ].filter(Boolean).join(', ') + '. Thanks everyone who queued!';

  const highlightLines = r.highlights.map((h) => `- ${b(name(h.player.name))} ${h.verb} ${b(`${n0(h.value)} ${h.label}`)} in one game (match ${h.matchId})`);
  const tail: string[] = [];
  if (r.mostQuads) tail.push(`- Match ${r.mostQuads.matchId} had ${b(`${r.mostQuads.quads} quad caps`)}`);
  for (const t of r.totals) {
    if (t.value <= 0) continue;
    tail.push(`- ${b(`${n0(t.value)} ${t.label}`)} on the week${t.leader ? `, led by ${b(name(t.leader.name))} with ${b(n0(t.leader.value))}` : ''}`);
  }

  const rest: string[] = [];
  if (r.streaks.length) {
    rest.push(`${b('Hot streaks')}\n${r.streaks.map((s) => `${b(name(s.name))} went ${b(`${s.w}-${s.l}`)}`).join(', ')}`);
  }
  if (r.iron.length) {
    const top = r.iron.filter((x) => x.games === r.iron[0].games);
    const next = r.iron.filter((x) => x.games !== r.iron[0].games);
    const who = top.map((x) => b(name(x.name))).join(' and ');
    const line = `${who} ${top.length > 1 ? 'each ' : ''}played ${b(`${r.iron[0].games} games`)}`
      + (next.length ? `, with ${next.map((x) => b(name(x.name))).join(' and ')} close behind at ${next[0].games}` : '');
    rest.push(`${b('Iron players')}\n${line}`);
  }
  if (r.closest) {
    const hi = Math.max(r.closest.a, r.closest.b); const lo = Math.min(r.closest.a, r.closest.b);
    rest.push(`${b('Closest game:')} match ${r.closest.matchId} on ${r.closest.campaign}, ${b(`${hi} to ${lo}`)}`);
  }

  const build = (hl: string[]) => [
    title, head,
    hl.length + tail.length ? `${b('Highlights')}\n${[...hl, ...tail].join('\n')}` : '',
    ...rest,
  ].filter(Boolean).join('\n\n');
  let hl = highlightLines;
  let content = build(hl);
  while (content.length > RECAP_LIMIT && hl.length) { hl = hl.slice(0, -1); content = build(hl); }
  if (content.length > RECAP_LIMIT) content = `${content.slice(0, RECAP_LIMIT - 2)}..`;
  return payload(content);
}
```

`renderRecap` takes `_publicUrl` unused so both renderers share a signature.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/weeklyCard.test.ts`
Expected: PASS (6 tests). If the escape assertion fails, print `text` and compare with what `escapeName` produces for `**b**` and `@everyone`; adjust the expected string to `escapeName`'s real output, not the other way round.

- [ ] **Step 5: Commit**

```bash
git add src/discord/weeklyCard.ts tests/weeklyCard.test.ts
git commit -m "Weekly awards: render the recap and awards messages"
```

---

### Task 7: The poster and its wiring

**Files:**
- Create: `src/discord/weeklyPoster.ts`
- Modify: `src/server.ts` (next to `ModCallPoster`: import at line ~66, `let modCalls` at ~1456, construction in `onConnected` at ~1510, `modCalls?.stop()` at ~1592)
- Test: `tests/weeklyPoster.test.ts`

**Interfaces:**
- Consumes: `freezeWeek`, `frozenWeek` (Task 5); `renderRecap`, `renderAwards` (Task 6); `weekStartOf`, `addWeeks` (Task 2); `getSetting`; `BotTransport`.
- Produces: `class WeeklyPoster { constructor(deps: { db: DB; transport: BotTransport; publicUrl: string; tickMs?: number; now?: () => Date }); start(): void; stop(): void; idle(): Promise<void>; tickNow(): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

`tests/weeklyPoster.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { WeeklyPoster } from '../src/discord/weeklyPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { seedMatch, seedPlayers } from './weeklyFixtures.js';

let db: DB; let t: FakeTransport; let poster: WeeklyPoster; let now: Date;
const inWeekly = () => t.live().filter((m) => m.channelId === 'weekly');

beforeEach(() => {
  db = openDb(':memory:');
  const [p] = seedPlayers(db, 1);
  for (let i = 0; i < 5; i++) seedMatch(db, { endedAt: `2026-09-22 1${i}:00:00`, lines: [{ id: p, team: 'a', stats: { skeets: 3 } }] });
  setSetting(db, 'discord_weekly_channel_id', 'weekly');
  t = new FakeTransport();
  now = new Date('2026-09-28T00:10:00Z');   // Monday just after the week of Sep 21 closed
  poster = new WeeklyPoster({ db, transport: t, publicUrl: 'https://pug.test', tickMs: 0, now: () => now });
});
afterEach(() => poster.stop());

describe('WeeklyPoster', () => {
  it('freezes the closed week and posts the recap then the awards, once', async () => {
    poster.start(); await poster.idle();
    expect(inWeekly()).toHaveLength(2);
    expect(inWeekly()[0].payload.content).toContain('Weekly recap, week of Sep 21');
    expect(inWeekly()[1].payload.embeds[0].title).toBe('Weekly awards, week of Sep 21');
    await poster.tickNow();
    expect(inWeekly()).toHaveLength(2);
    expect(db.prepare("SELECT posted_at FROM weekly_award_weeks WHERE week_start = '2026-09-21'").get()).not.toEqual({ posted_at: null });
  });

  it('a blank channel posts nothing but still freezes', async () => {
    setSetting(db, 'discord_weekly_channel_id', '');
    poster.start(); await poster.idle();
    expect(t.live()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM weekly_award_weeks WHERE posted_at IS NULL").get()).toEqual({ n: 1 });
  });

  it('a failure after the recap resends only the awards', async () => {
    const kind = (m: { payload: { content?: string } }) => (m.payload.content ? 'recap' : 'awards');
    let sends = 0;
    const real = t.send.bind(t);
    t.send = async (ch, p) => { sends++; if (sends === 2) throw new Error('discord down'); return real(ch, p); };
    await poster.tickNow();
    expect(inWeekly().map(kind)).toEqual(['recap']);
    await poster.tickNow();
    expect(inWeekly().map(kind)).toEqual(['recap', 'awards']);
  });

  it('does not freeze or post the week still in progress', async () => {
    now = new Date('2026-09-24T12:00:00Z');
    poster.start(); await poster.idle();
    expect(db.prepare("SELECT week_start FROM weekly_award_weeks").all()).toEqual([{ week_start: '2026-09-14' }]);
    // Last week had no matches: a short "no matches" recap and no awards embed.
    expect(inWeekly()).toHaveLength(1);
    expect(inWeekly()[0].payload.content).toContain('No matches were played');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/weeklyPoster.test.ts`
Expected: FAIL, cannot resolve `../src/discord/weeklyPoster.js`.

- [ ] **Step 3: Implement**

`src/discord/weeklyPoster.ts`:

```ts
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { addWeeks, weekStartOf } from '../weeklyAwards.js';
import { freezeWeek, frozenWeek } from '../weeklyStore.js';
import type { BotTransport } from './transport.js';
import { renderAwards, renderRecap } from './weeklyCard.js';

const TICK_MS = 60 * 60_000;

/**
 * Freezes the week that just closed and posts it: the recap, then the awards.
 *
 * Same shape as ModCallPoster: one promise chain, a timer, and the database
 * is the queue. Each message id is stored the moment Discord accepts it and
 * posted_at only once both are in, so a restart or an outage between the two
 * sends resends only the missing one and never posts a week twice.
 *
 * Only the week before the current one is ever frozen here, so weeks from
 * before this shipped are left alone (scripts/weekly-awards.ts freezes one by
 * hand).
 */
export class WeeklyPoster {
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: { db: DB; transport: BotTransport; publicUrl: string; tickMs?: number; now?: () => Date }) {}

  start(): void {
    void this.tickNow();
    const every = this.deps.tickMs ?? TICK_MS;
    if (every > 0) {
      this.timer = setInterval(() => { void this.tickNow(); }, every);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  idle(): Promise<void> {
    return this.chain;
  }

  tickNow(): Promise<void> {
    this.chain = this.chain.then(() => this.tick()).catch((err) => console.error('[weekly] tick failed:', err));
    return this.chain;
  }

  private async tick(): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const week = addWeeks(weekStartOf((this.deps.now ?? (() => new Date()))()), -1);
    freezeWeek(db, week);
    const channelId = getSetting(db, 'discord_weekly_channel_id') ?? '';
    if (!channelId) return;
    const row = db.prepare(
      'SELECT recap_message_id, awards_message_id, posted_at FROM weekly_award_weeks WHERE week_start = ?',
    ).get(week) as { recap_message_id: string | null; awards_message_id: string | null; posted_at: string | null } | undefined;
    if (!row || row.posted_at) return;
    const f = frozenWeek(db, week)!;
    try {
      if (!row.recap_message_id) {
        const id = await transport.send(channelId, renderRecap(f, publicUrl));
        db.prepare('UPDATE weekly_award_weeks SET recap_message_id = ? WHERE week_start = ?').run(id, week);
      }
      if (!row.awards_message_id) {
        const awards = renderAwards(f, publicUrl);
        // A week with no awards has nothing to send; mark it done.
        const id = awards ? await transport.send(channelId, awards) : '';
        db.prepare('UPDATE weekly_award_weeks SET awards_message_id = ? WHERE week_start = ?').run(id, week);
      }
      db.prepare("UPDATE weekly_award_weeks SET posted_at = datetime('now') WHERE week_start = ?").run(week);
    } catch (err) {
      console.error('[weekly] post failed:', err);
    }
  }
}
```

In `src/server.ts`:
- import: `import { WeeklyPoster } from './discord/weeklyPoster.js';` next to the `ModCallPoster` import.
- declare: `let weekly: WeeklyPoster | null = null;` next to `let modCalls`.
- in `onConnected`, after `modCalls.start();`:

```ts
        weekly = new WeeklyPoster({ db: deps.db, transport: t, publicUrl: deps.config.publicUrl });
        weekly.start();
```

- in the shutdown block, after `modCalls?.stop();`: `weekly?.stop();`

Note: freezing happens only while the bot is connected. That is acceptable: without Discord there is nobody to post to, and the site's current-week view is computed live.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/weeklyPoster.test.ts && npm run typecheck`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/discord/weeklyPoster.ts src/server.ts tests/weeklyPoster.test.ts
git commit -m "Weekly awards: hourly freeze and post to the weekly channel"
```

---

### Task 8: API routes and profile payload

**Files:**
- Create: `src/routes/weekly.ts`
- Modify: `src/server.ts` (register next to `app.register(statsRoutes, ...)` at ~1666)
- Modify: `src/playerQueries.ts` (`profileData` return object, next to `standings`)
- Test: `tests/weeklyRoutes.test.ts`

**Interfaces:**
- Consumes: `computeWeek`, `weekStartOf` (Task 2); `computeRecap` (Task 4); `frozenWeek`, `frozenWeeks`, `playerWeeklyAwards` (Task 5).
- Produces:
  - `GET /api/weekly` -> `{ week: string; live: true; minGames: number; awards: AwardResult[]; recap: Recap }` for the current week.
  - `GET /api/weekly?week=YYYY-MM-DD` -> `{ week; live: false; minGames; awards; recap }` from the frozen rows (`minGames` is the current setting); the current week's id returns the live form; any other unfrozen week is `404 { error: 'no such week' }`; a malformed value is `400 { error: 'bad week' }`.
  - `GET /api/weekly/weeks` -> `{ current: string; weeks: string[] }` (frozen, newest first).
  - Profile payload gains `weeklyAwards: PlayerAward[]`.

- [ ] **Step 1: Write the failing tests**

`tests/weeklyRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { freezeWeek } from '../src/weeklyStore.js';
import { stubOrchestrator } from './helpers.js';
import { seedMatch, seedPlayers } from './weeklyFixtures.js';

let db: DB; let app: FastifyInstance; let P: string[];
beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-09-30T12:00:00Z'), toFake: ['Date'] });
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => '', fetchPersona: async () => ({ name: 'x', avatar: null }), serverExec: async () => {},
  });
  P = seedPlayers(db, 2);
  for (let i = 0; i < 5; i++) seedMatch(db, { endedAt: `2026-09-22 1${i}:00:00`, lines: [{ id: P[0], team: 'a', stats: { skeets: 3 } }] });
  seedMatch(db, { endedAt: '2026-09-29 10:00:00', lines: [{ id: P[1], team: 'a', stats: { skeets: 7 } }] });
});
afterEach(async () => { vi.useRealTimers(); await app.close(); });

describe('weekly routes', () => {
  it('current week is computed live and public', async () => {
    const r = await app.inject({ url: '/api/weekly' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ week: '2026-09-28', live: true, minGames: 5 });
    expect(r.json().awards.find((a: { key: string; kind: string }) => a.key === 'skeets' && a.kind === 'total').winners[0].steamid).toBe(P[1]);
  });

  it('past weeks come from the frozen rows, unfrozen ones 404, junk 400', async () => {
    expect((await app.inject({ url: '/api/weekly?week=2026-09-21' })).statusCode).toBe(404);
    freezeWeek(db, '2026-09-21');
    const r = await app.inject({ url: '/api/weekly?week=2026-09-21' });
    expect(r.json()).toMatchObject({ week: '2026-09-21', live: false, recap: { matches: 5 } });
    expect((await app.inject({ url: '/api/weekly?week=nope' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/weekly/weeks' })).json()).toEqual({ current: '2026-09-28', weeks: ['2026-09-21'] });
  });

  it('the profile lists weekly awards', async () => {
    freezeWeek(db, '2026-09-21');
    const r = await app.inject({ url: `/api/players/${P[0]}` });
    expect(r.json().weeklyAwards.find((a: { award: string }) => a.award === 'skeets')).toMatchObject({ count: 1, weeks: ['2026-09-21'] });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/weeklyRoutes.test.ts`
Expected: FAIL with 404 on `/api/weekly`.

- [ ] **Step 3: Implement**

`src/routes/weekly.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { computeWeek, weekStartOf, weeklyMinGames } from '../weeklyAwards.js';
import { computeRecap } from '../weeklyRecap.js';
import { frozenWeek, frozenWeeks } from '../weeklyStore.js';

/** Public, like the other stats reads: a weekly board is for sharing. The
 *  current week is computed live; past weeks only ever come from the frozen
 *  rows, so what the site shows matches what Discord announced. */
export async function weeklyRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;

  app.get('/api/weekly', async (req, reply) => {
    const current = weekStartOf(new Date());
    const q = (req.query as { week?: string }).week;
    if (q !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(q) || weekStartOf(new Date(`${q}T00:00:00Z`)) !== q)) {
      return reply.code(400).send({ error: 'bad week' });
    }
    const week = q ?? current;
    const minGames = weeklyMinGames(db);
    if (week === current) return { week, live: true, minGames, awards: computeWeek(db, week), recap: computeRecap(db, week) };
    const f = frozenWeek(db, week);
    if (!f) return reply.code(404).send({ error: 'no such week' });
    return { week, live: false, minGames, awards: f.awards, recap: f.recap };
  });

  app.get('/api/weekly/weeks', async () => ({ current: weekStartOf(new Date()), weeks: frozenWeeks(db) }));
}
```

In `src/server.ts`, after `await app.register(statsRoutes, ...)`:

```ts
  await app.register(weeklyRoutes, { db: deps.db });
```

with `import { weeklyRoutes } from './routes/weekly.js';` next to the `statsRoutes` import.

In `src/playerQueries.ts`, add `import { playerWeeklyAwards } from './weeklyStore.js';` and in the `profileData` return object after `standings: ...,`:

```ts
    // Weekly award wins, grouped by award with the weeks. Shame awards are
    // left out: they are for the Discord post, not a player's page.
    weeklyAwards: playerWeeklyAwards(db, steamid),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/weeklyRoutes.test.ts tests/profileApi.test.ts tests/stats.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/weekly.ts src/server.ts src/playerQueries.ts tests/weeklyRoutes.test.ts
git commit -m "Weekly awards: public weekly API and profile awards"
```

---

### Task 9: Weekly tab on the leaderboard

**Files:**
- Modify: `web/src/api.ts` (types near `Leaderboard`; calls next to `leaderboard:` at ~1724; `Profile` interface at ~528)
- Create: `web/src/routes/WeeklyBoard.tsx`
- Modify: `web/src/routes/Leaderboard.tsx`
- Test: `web/src/routes/WeeklyBoard.test.tsx`

**Interfaces:**
- Consumes: `/api/weekly`, `/api/weekly/weeks` (Task 8).
- Produces (in `web/src/api.ts`):

```ts
export type AwardGroup = 'survivor' | 'infected' | 'overall' | 'shame';
export interface WeeklyWinner { steamid: string; name: string; value: number; games: number; detail: string | null }
export interface WeeklyAward { key: string; label: string; group: AwardGroup; kind: 'avg' | 'total' | 'single'; winners: WeeklyWinner[] }
export interface WeeklyRecap {
  matches: number; players: number; peakConcurrent: number;
  busiestDay: { date: string; matches: number } | null;
  highlights: { key: string; verb: string; label: string; player: { steamid: string; name: string }; value: number; matchId: number }[];
  mostQuads: { matchId: number; quads: number } | null;
  totals: { key: string; label: string; value: number; leader: { steamid: string; name: string; value: number } | null }[];
  streaks: { steamid: string; name: string; w: number; l: number }[];
  iron: { steamid: string; name: string; games: number }[];
  closest: { matchId: number; campaign: string; a: number; b: number } | null;
}
export interface WeeklyData { week: string; live: boolean; minGames: number; awards: WeeklyAward[]; recap: WeeklyRecap }
export interface PlayerAward { award: string; label: string; count: number; weeks: string[] }
// api object:
weekly: (signal?: AbortSignal, week?: string) => get<WeeklyData>(week ? `/api/weekly?week=${week}` : '/api/weekly', signal),
weeklyWeeks: (signal?: AbortSignal) => get<{ current: string; weeks: string[] }>('/api/weekly/weeks', signal),
// Profile interface gains:
weeklyAwards?: PlayerAward[];
```

- `WeeklyBoard` props: `{ week?: string; onWeek: (w: string | undefined) => void }`.
- `Leaderboard` reads `?week=` from the URL (the Discord post links `/leaderboard?week=2026-09-21`) and shows the weekly view when present or when the toggle is on.

- [ ] **Step 1: Write the failing test**

`web/src/routes/WeeklyBoard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { WeeklyData } from '../api';

const { mockApi } = vi.hoisted(() => ({ mockApi: { weekly: vi.fn(), weeklyWeeks: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});
const { WeeklyBoard } = await import('./WeeklyBoard');

const w = (steamid: string, name: string, value: number, detail: string | null = null) => ({ steamid, name, value, games: 5, detail });
const data: WeeklyData = {
  week: '2026-09-28', live: true, minGames: 5,
  recap: { matches: 3, players: 6, peakConcurrent: 1, busiestDay: null, highlights: [], mostQuads: null, totals: [], streaks: [], iron: [], closest: null },
  awards: [
    { key: 'skeets', label: 'Skeets', group: 'survivor', kind: 'avg', winners: [w('1', 'VII', 4.6)] },
    { key: 'skeets', label: 'Skeets', group: 'survivor', kind: 'total', winners: [w('2', 'epx', 187)] },
    { key: 'win_rate', label: 'Best win rate', group: 'overall', kind: 'single', winners: [w('3', 'mado', 0.79, '15-4')] },
    { key: 'slow_ready', label: 'Slowest ready-up', group: 'shame', kind: 'single', winners: [w('4', 'slow', 53.8)] },
  ],
};

beforeEach(() => {
  mockApi.weekly.mockResolvedValue(data);
  mockApi.weeklyWeeks.mockResolvedValue({ current: '2026-09-28', weeks: ['2026-09-21'] });
});
afterEach(cleanup);

describe('WeeklyBoard', () => {
  it('shows each section, both winners of a stat award, and the live note', async () => {
    render(<WeeklyBoard onWeek={() => {}} />);
    await waitFor(() => screen.getByText('Skeets'));
    expect(screen.getByText('Survivor')).toBeTruthy();
    expect(screen.getByText('Shame')).toBeTruthy();
    expect(screen.getByText('VII')).toBeTruthy();
    expect(screen.getByText('epx')).toBeTruthy();
    expect(screen.getByText('15-4')).toBeTruthy();
    expect(screen.getByText(/final Monday 00:00 UTC/)).toBeTruthy();
  });

  it('offers past weeks in the picker', async () => {
    render(<WeeklyBoard onWeek={() => {}} />);
    await waitFor(() => screen.getByRole('combobox', { name: 'Week' }));
    expect(screen.getByRole('option', { name: 'Week of Sep 21' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run web/src/routes/WeeklyBoard.test.tsx`
Expected: FAIL, cannot resolve `./WeeklyBoard`.

- [ ] **Step 3: Implement**

Add the types and the two calls to `web/src/api.ts` as listed under Interfaces.

`web/src/routes/WeeklyBoard.tsx`:

```tsx
import { api, type WeeklyAward, type WeeklyWinner } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel, PlayerLink } from '../components/bits';

const GROUPS = [
  { group: 'survivor', title: 'Survivor' },
  { group: 'infected', title: 'Infected' },
  { group: 'overall', title: 'Overall' },
  { group: 'shame', title: 'Shame' },
] as const;
const DAMAGE = new Set(['si_damage', 'tank_damage', 'damage_as_si', 'pounce_damage', 'hunter_damage', 'smoker_damage', 'incap_damage']);

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const weekName = (w: string) =>
  `Week of ${new Date(`${w}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;

/** Mirrors src/discord/weeklyCard.ts formatAwardValue so the site and the
 *  Discord post say the same thing. */
function value(a: WeeklyAward, w: WeeklyWinner): string {
  if (a.kind === 'avg') return `${DAMAGE.has(a.key) ? n0(w.value) : (Math.round(w.value * 10) / 10).toFixed(1)} per game`;
  if (a.kind === 'total') return `${n0(w.value)} total`;
  switch (a.key) {
    case 'sr_climb': return `+${n0(w.value)} SR`;
    case 'wins': return `${n0(w.value)} wins`;
    case 'win_streak': return `${n0(w.value)} in a row`;
    case 'matches': return `${n0(w.value)} games`;
    case 'win_rate': return w.detail ?? `${Math.round(w.value * 100)}%`;
    case 'slow_ready': return `${n0(w.value)}s per ready-up`;
    default: return `${DAMAGE.has(a.key) ? n0(w.value) : (Math.round(w.value * 10) / 10).toFixed(1)} per game`;
  }
}

function Winners({ a }: { a: WeeklyAward }) {
  return (
    <div class="weekly__winner">
      <span class="weekly__kind">{a.kind === 'avg' ? 'Best average' : a.kind === 'total' ? 'Most total' : ''}</span>
      {a.winners.map((w) => <PlayerLink key={w.steamid} steamid={w.steamid} name={w.name} />)}
      <span class="weekly__value">{value(a, a.winners[0])}</span>
    </div>
  );
}

export function WeeklyBoard({ week, onWeek }: { week?: string; onWeek: (w: string | undefined) => void }) {
  const { data, error } = useFetch((s) => api.weekly(s, week), [week]);
  const { data: list } = useFetch((s) => api.weeklyWeeks(s).catch(() => ({ current: '', weeks: [] as string[] })), []);
  if (error) return <Empty>Could not load this week.</Empty>;
  if (!data) return null;
  return (
    <div class="weekly">
      <div class="weekly__bar">
        <select
          class="season-picker" aria-label="Week" value={week ?? ''}
          onChange={(e) => onWeek((e.currentTarget as HTMLSelectElement).value || undefined)}
        >
          <option value="">This week</option>
          {(list?.weeks ?? []).map((w) => <option key={w} value={w}>{weekName(w)}</option>)}
        </select>
        {data.live && <span class="weekly__note">Live. Averages need {data.minGames}+ games; final Monday 00:00 UTC.</span>}
      </div>
      {data.awards.length === 0 && <Empty>No awards yet this week.</Empty>}
      {GROUPS.map(({ group, title }) => {
        const inGroup = data.awards.filter((a) => a.group === group);
        if (!inGroup.length) return null;
        const keys = [...new Set(inGroup.map((a) => a.key))];
        return (
          <Panel key={group}>
            <h3 class="weekly__group">{title}</h3>
            <div class="weekly__grid">
              {keys.map((k) => {
                const parts = inGroup.filter((a) => a.key === k);
                return (
                  <div class="weekly__card" key={k}>
                    <div class="weekly__label">{parts[0].label}</div>
                    {parts.map((a) => <Winners key={a.kind} a={a} />)}
                  </div>
                );
              })}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
```

Before relying on them, open `web/src/components/bits.tsx` and confirm `PlayerLink`'s props (`steamid`, `name`) and that `Empty` takes children; adapt the calls to the real signatures.

In `web/src/routes/Leaderboard.tsx`:
- read the query once: `const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);`
- state: `const [weekly, setWeekly] = useState(params.has('week'));` and `const [week, setWeek] = useState<string | undefined>(params.get('week') ?? undefined);`
- in the page header's `aside`, add a two-button toggle before the season picker:

```tsx
<div class="lb-toggle" role="group" aria-label="Board">
  <button type="button" class={weekly ? '' : 'is-on'} aria-pressed={!weekly} onClick={() => setWeekly(false)}>Season</button>
  <button type="button" class={weekly ? 'is-on' : ''} aria-pressed={weekly} onClick={() => setWeekly(true)}>This week</button>
</div>
```

- when `weekly` is true, render `<WeeklyBoard week={week} onWeek={setWeek} />` in place of the season table and hide the season picker.

Styles: add to the leaderboard stylesheet (find it with `grep -rn "season-picker" web/src/styles`) using the existing tokens there: `.lb-toggle` as a two-segment pill, `.weekly__grid` as `display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-3)` (use whatever spacing token the file already uses), `.weekly__card` sharing the look of existing leaderboard panels, `.weekly__value` with `font-variant-numeric: tabular-nums`. One column below 480px.

- [ ] **Step 4: Run the tests and look at it**

Run: `npx vitest run web/src/routes/WeeklyBoard.test.tsx web/src/routes/routes.test.tsx && npm run typecheck`
Expected: PASS.

Then `npm run dev`, open `http://localhost:5173/leaderboard?week=` and the toggle, and `npm run shoot` if that rig covers `/leaderboard`; check light, dark and phone width.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/routes/WeeklyBoard.tsx web/src/routes/WeeklyBoard.test.tsx web/src/routes/Leaderboard.tsx web/src/styles
git commit -m "Weekly awards: weekly tab on the leaderboard"
```

---

### Task 10: Profile chips

**Files:**
- Create: `web/src/components/WeeklyAwardChips.tsx`
- Modify: `web/src/routes/Profile.tsx` (render below the standings panel that ends around line 382)
- Test: `web/src/components/WeeklyAwardChips.test.tsx`

**Interfaces:**
- Consumes: `PlayerAward` and `Profile.weeklyAwards` (Task 9).
- Produces: `WeeklyAwardChips({ awards }: { awards: PlayerAward[] })`. Renders nothing for an empty list. At most `MAX_CHIPS = 4` chips, in the order given (already most-won first); each reads `Skeets x3` (or just `Skeets` for one win) with a `title` listing the weeks. A `+N more` button expands the rest.

- [ ] **Step 1: Write the failing test**

`web/src/components/WeeklyAwardChips.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { WeeklyAwardChips } from './WeeklyAwardChips';

afterEach(cleanup);
const a = (award: string, label: string, count: number) => ({ award, label, count, weeks: Array.from({ length: count }, (_, i) => `2026-09-${String(21 - i * 7).padStart(2, '0')}`) });

describe('WeeklyAwardChips', () => {
  it('renders nothing without awards', () => {
    const { container } = render(<WeeklyAwardChips awards={[]} />);
    expect(container.textContent).toBe('');
  });

  it('shows at most four chips with counts, then expands the rest', () => {
    const awards = [a('skeets', 'Skeets', 3), a('crowns', 'Witch crowns', 2), a('revives', 'Revives', 1), a('wins', 'Most wins', 1), a('rocks', 'Tank rocks landed', 1), a('booms', 'Booms landed', 1)];
    render(<WeeklyAwardChips awards={awards} />);
    expect(screen.getByText('Skeets x3')).toBeTruthy();
    expect(screen.getByText('Revives')).toBeTruthy();
    expect(screen.queryByText('Tank rocks landed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+2 more' }));
    expect(screen.getByText('Tank rocks landed')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run web/src/components/WeeklyAwardChips.test.tsx`
Expected: FAIL, cannot resolve `./WeeklyAwardChips`.

- [ ] **Step 3: Implement**

`web/src/components/WeeklyAwardChips.tsx`:

```tsx
import { useState } from 'preact/hooks';
import type { PlayerAward } from '../api';

/** Kept small on purpose: one chip per award with a count, a handful shown,
 *  the rest behind a button, so a regular's profile does not fill with them. */
const MAX_CHIPS = 4;

const weekName = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function WeeklyAwardChips({ awards }: { awards: PlayerAward[] }) {
  const [open, setOpen] = useState(false);
  if (!awards.length) return null;
  const shown = open ? awards : awards.slice(0, MAX_CHIPS);
  const hidden = awards.length - shown.length;
  return (
    <div class="weekly-chips" aria-label="Weekly awards">
      <span class="weekly-chips__title">Weekly awards</span>
      {shown.map((a) => (
        <span class="weekly-chips__chip" key={a.award} title={`Weeks of ${a.weeks.map(weekName).join(', ')}`}>
          {a.count > 1 ? `${a.label} x${a.count}` : a.label}
        </span>
      ))}
      {hidden > 0 && (
        <button type="button" class="weekly-chips__more" onClick={() => setOpen(true)}>+{hidden} more</button>
      )}
    </div>
  );
}
```

In `web/src/routes/Profile.tsx`, import it and render `<WeeklyAwardChips awards={data.weeklyAwards ?? []} />` directly after the panel that holds the standings (the component returned around line 367 to 382), inside the same column so it sits with the other achievements. Style `.weekly-chips` next to `.standings` in the profile stylesheet (`grep -rn "standings__item" web/src/styles`), reusing the `.standings__item` look for the chip so the two rows match; `flex-wrap: wrap; gap` so it wraps on a phone.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/components/WeeklyAwardChips.test.tsx web/src/routes && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/WeeklyAwardChips.tsx web/src/components/WeeklyAwardChips.test.tsx web/src/routes/Profile.tsx web/src/styles
git commit -m "Weekly awards: award chips on profiles"
```

---

### Task 11: Dry run script and the prod check

**Files:**
- Create: `scripts/weekly-awards.ts`

**Interfaces:**
- Consumes: `openDb`, `freezeWeek`, `frozenWeek`, `computeWeek`, `computeRecap`, `renderRecap`, `renderAwards`.
- Usage: `npx tsx scripts/weekly-awards.ts <db-path> <YYYY-MM-DD> [--freeze]`. Without `--freeze` it opens the DB read-only in spirit (computes, prints both messages, writes nothing). With `--freeze` it calls `freezeWeek` and prints the frozen result.

- [ ] **Step 1: Write the script**

```ts
import { openDb } from '../src/db.js';
import { computeWeek } from '../src/weeklyAwards.js';
import { computeRecap } from '../src/weeklyRecap.js';
import { freezeWeek, frozenWeek, type FrozenWeek } from '../src/weeklyStore.js';
import { renderAwards, renderRecap } from '../src/discord/weeklyCard.js';

/**
 * Print a week's recap and awards as they would be posted, or freeze a week
 * by hand (weeks from before the feature shipped are never frozen
 * automatically). Run against a COPY of the prod database for a dry run:
 * openDb creates missing tables, which is a write.
 */
const [path, week, flag] = process.argv.slice(2);
if (!path || !/^\d{4}-\d{2}-\d{2}$/.test(week ?? '')) {
  console.error('usage: tsx scripts/weekly-awards.ts <db-path> <YYYY-MM-DD> [--freeze]');
  process.exit(2);
}
const db = openDb(path);
let f: FrozenWeek;
if (flag === '--freeze') {
  console.log(freezeWeek(db, week) ? 'frozen' : 'already frozen');
  f = frozenWeek(db, week)!;
} else {
  f = { week, frozenAt: '', postedAt: null, awards: computeWeek(db, week), recap: computeRecap(db, week) };
}
const url = process.env.PUBLIC_URL ?? 'https://riversidepug.com';
console.log(renderRecap(f, url).content);
console.log('\n----- awards -----\n');
const a = renderAwards(f, url);
console.log(a ? `${a.embeds[0].title}\n\n${a.embeds[0].description}` : '(no awards)');
```

- [ ] **Step 2: Dry run against a copy of prod**

```bash
S=/tmp/claude-1000/weekly-dryrun; mkdir -p $S
ssh root@45.32.199.85 "sqlite3 /home/pug/app/data/pug.db '.backup /tmp/pug-dryrun.db'" && scp -q root@45.32.199.85:/tmp/pug-dryrun.db $S/pug.db && ssh root@45.32.199.85 rm /tmp/pug-dryrun.db
npx tsx scripts/weekly-awards.ts $S/pug.db 2026-09-21
```

`.backup` is SQLite's online copy and does not lock the live app out. Never point the script at `/home/pug/app/data/pug.db` itself.

Expected, checked against the numbers shown to the owner in chat for the week of 2026-09-21 (the week may have grown since, so the leaders can move, but each figure must be recomputable with a direct SQL query): the recap names epx 12 skeets in match 224, match 218 with 3 quad caps, the closest game match 154 on Death Toll 178 to 177; the awards include mira's tank damage average around 8,806/g and methanol connoisseur's slowest ready-up around 54s. Both messages print under their limits and contain no emoji.

- [ ] **Step 3: Full suite and types**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add scripts/weekly-awards.ts
git commit -m "Weekly awards: dry run and manual freeze script"
```

---

## After the plan

Not part of the tasks, and each needs the owner:
- Merge `weekly-awards` into `master` (check `git reflog` and `git status` on master first; other sessions work there) and deploy with `deploy-web.sh` when nobody is in game.
- Owner creates `#weekly-top` and sets its id in Admin > Settings > Discord.
- Optionally freeze 2026-09-21 on the box with the script so some players start with chips.
