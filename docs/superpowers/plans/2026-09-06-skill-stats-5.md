# Skill Stats Capture and Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture L4D1 competitive skill events (skeets, deadstops, pops, crowns, high pounces, tank damage) per player per match and display them on the website, with season leaderboards and a private self-only view for the stats where a high number is bad.

**Architecture:** `l4d2_skill_detect` global forwards and pug-match's own `player_hurt` hook feed per-roster-slot counters in a new `plugin/pug-stats.inc`. Counters ride out on a new `SKILL` line in the `sm_pug_dump` response, are parsed against a shared TypeScript stat registry, and land in a narrow key/value table that makes leaderboards a single indexed group-by. Visibility (`public` vs `self`) is a property of the registry and is enforced server-side in every read path.

**Tech Stack:** SourcePawn 1.12 (spcomp under wine), TypeScript, Fastify, better-sqlite3, Preact, vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-skill-stats-5-design.md`

## Global Constraints

- **No em dashes** anywhere: code, comments, docs, commit messages.
- Ranked ruleset is **hardcore** (`rotoblin_hardcore_4v4`), decided 2026-09-06. Not lite.
- The SourceMod library name registered by skill_detect is **`skill_detect`**, not `l4d2_skill_detect` (`l4d2_skill_detect.sp:475`). `LibraryExists` with the wrong name returns false forever and silently disables all skill capture.
- **`OnSkeet` does NOT fire for weapon-specific skeets.** The dispatch at `l4d2_skill_detect.sp:3461-3523` is an if/else-if chain; sniper, GL, melee, magnum and shotgun each fire only their own forward, and `OnSkeet` fires only in the final `else`. All six must be implemented. They are mutually exclusive, so summing them cannot double count.
- L4D1 has no magnum and no grenade launcher, so `OnSkeetMagnum` and `OnSkeetGL` will never fire there. Implement them anyway (4 lines each) so the totals stay correct if this is ever pointed at L4D2.
- A team skeet is **not** also counted as a skeet. `isTeamSkeet` routes to `team_skeets`, else to `skeets`. This matches the `l4dcompstats` convention players already see in the end-of-round table.
- Existing `match_players` columns (`si_damage`, `si_kills`, `common_kills`, `ff_dealt`, `revives`) are **not** touched or migrated. New stats go only to the new table.
- `sidmg` stays tank-free. Tank damage is its own key.
- Plugin builds via `plugin/build.sh`, which copies sources into the Rotoblin scripting dir and compiles relative, because absolute unix paths break `spcomp` under wine. Any new source file must be copied and cleaned up the same way.
- Never restart the live server to deploy the plugin. `plugin/stage.sh` copies one file and reloads.

---

### Task 1: Stat registry

The single source of truth for stat keys, sides, labels and visibility. Everything downstream imports this, which is what makes the key/value storage safe: a typo becomes a test failure instead of a silently empty leaderboard.

**Files:**
- Create: `src/statKeys.ts`
- Test: `tests/statKeys.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `StatSide`, `StatVisibility`, `StatDef`, `STAT_DEFS`, `statDef(key: string): StatDef | undefined`, `isKnownStat(key: string): boolean`, `publicStatKeys(): string[]`, `skillDetectStatKeys(): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/statKeys.test.ts
import { describe, it, expect } from 'vitest';
import { STAT_DEFS, statDef, isKnownStat, publicStatKeys, skillDetectStatKeys } from '../src/statKeys.js';

describe('stat registry', () => {
  it('has unique keys', () => {
    const keys = STAT_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('looks up a definition', () => {
    expect(statDef('skeets')).toMatchObject({ side: 'survivor', visibility: 'public', needsSkillDetect: true });
    expect(statDef('tank_damage')).toMatchObject({ side: 'survivor', visibility: 'public', needsSkillDetect: false });
    expect(statDef('nope')).toBeUndefined();
  });

  it('marks the two negative stats self-only', () => {
    expect(statDef('times_skeeted')!.visibility).toBe('self');
    expect(statDef('times_deadstopped')!.visibility).toBe('self');
  });

  it('publicStatKeys excludes self-only stats', () => {
    expect(publicStatKeys()).not.toContain('times_skeeted');
    expect(publicStatKeys()).toContain('skeets');
  });

  it('skillDetectStatKeys excludes the three natively captured stats', () => {
    const k = skillDetectStatKeys();
    expect(k).not.toContain('tank_damage');
    expect(k).not.toContain('damage_as_si');
    expect(k).not.toContain('tank_punches');
    expect(k).toContain('deadstops');
  });

  it('every key is snake_case and short enough for the wire format', () => {
    for (const d of STAT_DEFS) {
      expect(d.key).toMatch(/^[a-z][a-z0-9_]{0,23}$/);
      expect(d.label.length).toBeGreaterThan(0);
    }
  });

  it('isKnownStat gates unknown keys', () => {
    expect(isKnownStat('skeets')).toBe(true);
    expect(isKnownStat('__proto__')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/statKeys.test.ts`
Expected: FAIL, cannot resolve `../src/statKeys.js`

- [ ] **Step 3: Write the registry**

```ts
// src/statKeys.ts
/** Single source of truth for skill stat keys.
 *
 *  Storage is a narrow key/value table (`match_player_stats`) rather than one
 *  column per stat, so adding a stat needs no migration. The cost of that choice
 *  is that a typo'd key is not a DB error, it is a silently empty leaderboard.
 *  This registry plus tests/statKeys.test.ts is the mitigation: the plugin, the
 *  parser and the API all resolve keys through here. */

export type StatSide = 'survivor' | 'infected';

/** `self` stats are shown only to the player they describe and are never
 *  eligible for a leaderboard. Used for stats where a high number is bad. */
export type StatVisibility = 'public' | 'self';

export interface StatDef {
  key: string;
  side: StatSide;
  visibility: StatVisibility;
  label: string;
  /** True when the value comes from an l4d2_skill_detect forward, and is
   *  therefore absent (not zero) from a dump whose header says skilldetect=0. */
  needsSkillDetect: boolean;
}

const def = (
  key: string, side: StatSide, label: string,
  needsSkillDetect = true, visibility: StatVisibility = 'public',
): StatDef => ({ key, side, label, needsSkillDetect, visibility });

export const STAT_DEFS: readonly StatDef[] = [
  // Survivor, from skill_detect. A team skeet is not also a skeet.
  def('skeets', 'survivor', 'Skeets'),
  def('team_skeets', 'survivor', 'Team skeets'),
  def('skeets_hurt', 'survivor', 'Hurt skeets'),
  def('skeet_assists', 'survivor', 'Skeet assists'),
  def('skeets_shotgun', 'survivor', 'Shotgun skeets'),
  def('skeets_sniper', 'survivor', 'Sniper skeets'),
  def('skeets_melee', 'survivor', 'Melee skeets'),
  def('deadstops', 'survivor', 'Deadstops'),
  def('boomer_pops', 'survivor', 'Boomer pops'),
  def('crowns', 'survivor', 'Crowns'),
  def('draw_crowns', 'survivor', 'Draw crowns'),
  def('tongue_cuts', 'survivor', 'Tongue cuts'),
  def('self_clears', 'survivor', 'Self clears'),
  def('rock_skeets', 'survivor', 'Rock skeets'),
  def('clears', 'survivor', 'Clears'),
  def('insta_clears', 'survivor', 'Insta clears'),

  // Infected, from skill_detect.
  def('dps_landed', 'infected', 'DPs landed'),
  def('pounce_damage_high', 'infected', 'High pounce damage'),
  def('biles_landed', 'infected', 'Biles landed'),
  def('survivors_biled', 'infected', 'Survivors biled'),
  def('tank_rocks_landed', 'infected', 'Tank rocks landed'),

  // Infected, private. High is bad, so shown only to the player themselves and
  // never rankable. See the spec's "Stat visibility" section.
  def('times_skeeted', 'infected', 'Times skeeted', true, 'self'),
  def('times_deadstopped', 'infected', 'Times deadstopped', true, 'self'),

  // Captured by pug-match's own hooks, so always available even with no
  // skill_detect on the server.
  def('tank_damage', 'survivor', 'Tank damage', false),
  def('damage_as_si', 'infected', 'Damage as SI', false),
  def('tank_punches', 'infected', 'Tank punches', false),
];

const BY_KEY = new Map(STAT_DEFS.map((d) => [d.key, d]));

export function statDef(key: string): StatDef | undefined {
  return BY_KEY.get(key);
}

export function isKnownStat(key: string): boolean {
  return BY_KEY.has(key);
}

export function publicStatKeys(): string[] {
  return STAT_DEFS.filter((d) => d.visibility === 'public').map((d) => d.key);
}

export function skillDetectStatKeys(): string[] {
  return STAT_DEFS.filter((d) => d.needsSkillDetect).map((d) => d.key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/statKeys.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/statKeys.ts tests/statKeys.test.ts
git commit -m "feat(stats): add shared stat key registry with visibility"
```

---

### Task 2: Parse the SKILL dump line

**Files:**
- Modify: `src/dumpParse.ts`
- Test: `tests/dumpParse.test.ts`

**Interfaces:**
- Consumes: `isKnownStat` from Task 1
- Produces: `Dump.skillDetect: boolean`, `Dump.skills: DumpSkill[]` where `DumpSkill = { steamid: string; stats: Record<string, number> }`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/dumpParse.test.ts
const SKILL_SAMPLE = [
  'DUMP match=42 skilldetect=1',
  'MAP map=l4d_vs_airport01_greenhouse a=824 b=400',
  'STAT steamid=76561198000000001 team=a sidmg=1850 sikill=13 ck=44 ff=4 rev=2',
  'SKILL steamid=76561198000000001 skeets=2 skeets_shotgun=2 deadstops=1 tank_damage=1699 times_skeeted=3',
  'END winner=a a=824 b=400',
].join('\n');

describe('parseDump SKILL lines', () => {
  it('parses skill stats and the capability flag', () => {
    const d = parseDump(SKILL_SAMPLE)!;
    expect(d.skillDetect).toBe(true);
    expect(d.skills).toEqual([
      { steamid: '76561198000000001',
        stats: { skeets: 2, skeets_shotgun: 2, deadstops: 1, tank_damage: 1699, times_skeeted: 3 } },
    ]);
  });

  it('defaults skillDetect to false when the header omits it', () => {
    expect(parseDump(SAMPLE)!.skillDetect).toBe(false);
    expect(parseDump(SAMPLE)!.skills).toEqual([]);
  });

  it('drops unknown stat keys rather than failing the dump', () => {
    const body = SKILL_SAMPLE.replace('deadstops=1', 'deadstops=1 wat=9');
    const d = parseDump(body)!;
    expect(d.skills[0].stats).not.toHaveProperty('wat');
    expect(d.skills[0].stats.deadstops).toBe(1);
  });

  it('rejects the dump when a SKILL steamid is malformed', () => {
    expect(parseDump(SKILL_SAMPLE.replace('steamid=76561198000000001 skeets', 'steamid=nope skeets'))).toBeNull();
  });

  it('rejects the dump when a known stat has a non-integer value', () => {
    expect(parseDump(SKILL_SAMPLE.replace('skeets=2', 'skeets=x'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dumpParse.test.ts`
Expected: FAIL, `d.skillDetect` is undefined

- [ ] **Step 3: Implement**

In `src/dumpParse.ts`, add the import and interface:

```ts
import { isKnownStat } from './statKeys.js';

export interface DumpSkill {
  steamid: string;
  /** Only keys present in the registry. Absent means not measured, which is
   *  different from zero: see skillDetect. */
  stats: Record<string, number>;
}
```

Extend `Dump`:

```ts
export interface Dump {
  matchId: number;
  maps: DumpMap[];
  players: DumpPlayer[];
  /** False when skill_detect was not loaded at MATCH_START. Skill-derived stats
   *  are then absent rather than zero, and must not be persisted as zeros. */
  skillDetect: boolean;
  skills: DumpSkill[];
  winner: 'a' | 'b' | 'draw';
  totalA: number;
  totalB: number;
}
```

In `parseDump`, after `const matchId = intOf(header.match);`:

```ts
  const skillDetect = header.skilldetect === '1';
```

Declare alongside `maps` and `players`:

```ts
  const skills: DumpSkill[] = [];
```

Add a branch before the `END` branch:

```ts
    } else if (verb === 'SKILL') {
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      const stats: Record<string, number> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (k === 'steamid') continue;
        // Unknown keys are ignored so a newer plugin degrades against an older
        // backend instead of failing the whole dump. Known keys must be valid.
        if (!isKnownStat(k)) continue;
        const n = intOf(v);
        if (n === null) return null;
        stats[k] = n;
      }
      skills.push({ steamid: rest.steamid, stats });
```

Update the return:

```ts
  return { matchId, maps, players, skillDetect, skills, winner: end.winner, totalA: end.totalA, totalB: end.totalB };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dumpParse.test.ts`
Expected: PASS, including the pre-existing tests

- [ ] **Step 5: Commit**

```bash
git add src/dumpParse.ts tests/dumpParse.test.ts
git commit -m "feat(stats): parse SKILL dump lines and the skilldetect capability flag"
```

---

### Task 3: Persist skill stats

**Files:**
- Modify: `src/db.ts` (append to the `SCHEMA` string)
- Modify: `src/matchResult.ts`
- Test: `tests/matchResult.test.ts`

**Interfaces:**
- Consumes: `Dump.skills`, `Dump.skillDetect` from Task 2
- Produces: table `match_player_stats(match_id, player_id, stat, value)`; `completeMatch` writes it

`src/db.ts` applies `SCHEMA` with `CREATE TABLE IF NOT EXISTS` on every open, so an existing database picks the new table up automatically. There is no migration framework and none is needed.

- [ ] **Step 1: Write the failing test**

```ts
// Append INSIDE the existing `describe('completeMatch')` block in
// tests/matchResult.test.ts, which already provides `db` and `matchId` via
// beforeEach, plus the helpers `seedLiveMatch(db)`, `dumpFor(matchId)` and `IDS`.
it('persists skill stats keyed by roster slot', () => {
  const d: Dump = { ...dumpFor(matchId), skillDetect: true, skills: [
    { steamid: IDS[0], stats: { skeets: 2, tank_damage: 1699 } },
  ] };
  expect(completeMatch(db, matchId, d)).toBe(true);
  const rows = db.prepare(
    'SELECT stat, value FROM match_player_stats WHERE match_id = ? AND player_id = ? ORDER BY stat',
  ).all(matchId, IDS[0]);
  expect(rows).toEqual([{ stat: 'skeets', value: 2 }, { stat: 'tank_damage', value: 1699 }]);
});

it('writes no skill-detect stats when skilldetect was 0, but still writes native ones', () => {
  const d: Dump = { ...dumpFor(matchId), skillDetect: false, skills: [
    { steamid: IDS[0], stats: { skeets: 9, tank_damage: 500 } },
  ] };
  completeMatch(db, matchId, d);
  expect(db.prepare(
    "SELECT value FROM match_player_stats WHERE match_id = ? AND stat = 'skeets'",
  ).all(matchId)).toEqual([]);
  // tank_damage does not need skill_detect, so it survives.
  expect(db.prepare(
    "SELECT value FROM match_player_stats WHERE match_id = ? AND stat = 'tank_damage'",
  ).get(matchId)).toEqual({ value: 500 });
});
```

```ts
it('skips skill stats for a steamid not on the roster instead of throwing', () => {
  const d: Dump = { ...dumpFor(matchId), skillDetect: true, skills: [
    { steamid: '76561199999999999', stats: { skeets: 3 } },
  ] };
  // Must not throw: foreign_keys is ON, so an unguarded insert would abort the
  // whole completion transaction and lose the match result.
  expect(() => completeMatch(db, matchId, d)).not.toThrow();
  expect(db.prepare('SELECT COUNT(*) AS n FROM match_player_stats').get()).toEqual({ n: 0 });
  expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as any).state).toBe('completed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matchResult.test.ts`
Expected: FAIL, `no such table: match_player_stats`

- [ ] **Step 3: Add the table**

Append to the `SCHEMA` template string in `src/db.ts`, after the `match_maps` table:

```sql
CREATE TABLE IF NOT EXISTS match_player_stats (
  match_id  INTEGER NOT NULL REFERENCES matches(id),
  player_id TEXT    NOT NULL REFERENCES players(steamid),
  stat      TEXT    NOT NULL,
  value     INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id, stat)
);
CREATE INDEX IF NOT EXISTS idx_mps_stat ON match_player_stats(stat, value DESC);
```

- [ ] **Step 4: Write the rows**

In `src/matchResult.ts`, add the import:

```ts
import { statDef } from './statKeys.js';
```

Inside the existing `db.transaction(() => { ... })`, after the `match_players` update loop and before `applyMatchRatings(db, matchId)`:

```ts
    // Skill stats. sm_pug_dump may be called more than once, so upsert rather
    // than insert. Stats that need skill_detect are skipped entirely when the
    // plugin reported skilldetect=0, so "not measured" never lands as a zero.
    const insStat = db.prepare(
      `INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (match_id, player_id, stat) DO UPDATE SET value = excluded.value`,
    );
    // src/db.ts:103 sets `foreign_keys = ON`, so a steamid that is not a known
    // player would not warn, it would THROW and roll back this whole transaction,
    // losing the match result over a stray stat row. Skip and warn instead, which
    // is also how the match_players update above treats an unmatched steamid.
    const onRoster = new Set(
      (db.prepare('SELECT player_id FROM match_players WHERE match_id = ?')
        .all(matchId) as { player_id: string }[]).map((r) => r.player_id),
    );
    for (const s of d.skills) {
      if (!onRoster.has(s.steamid)) {
        console.warn(`[matchResult] skill stats for ${s.steamid} matched no roster row in match ${matchId}`);
        continue;
      }
      for (const [key, value] of Object.entries(s.stats)) {
        const def = statDef(key);
        if (!def) continue;
        if (def.needsSkillDetect && !d.skillDetect) continue;
        insStat.run(matchId, s.steamid, key, value);
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/matchResult.test.ts tests/db.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/matchResult.ts tests/matchResult.test.ts
git commit -m "feat(stats): persist skill stats to match_player_stats"
```

---

### Task 4: Serve stats with visibility enforced

`src/routes/stats.ts` has no authentication today. This adds the first authenticated read path in it.

**Files:**
- Modify: `src/routes/stats.ts`
- Test: `tests/stats.test.ts`

**Interfaces:**
- Consumes: `statDef`, `STAT_DEFS` from Task 1; `getSession` from `src/session.ts`
- Produces: `GET /api/matches/:id` player rows gain `stats: Record<string, number>`; `GET /api/players/:steamid` gains `statTotals: Record<string, number>` and `privateStatTotals: Record<string, number> | null`

- [ ] **Step 1: Write the failing test**

```ts
// Append to tests/stats.test.ts, INSIDE `describe('stats routes')`, which already
// provides `db`, `app` and `cookies` (an authedCookie for ME) via beforeEach,
// plus `IDS`, `ME` and `playCompletedMatch(db, winner)`.
describe('stat visibility', () => {
  it('hides self-only stats from other viewers on a match page', async () => {
    const matchId = playCompletedMatch(db);
    seedStats(db, matchId, IDS[1], { skeets: 2, times_skeeted: 5 });
    // `cookies` authenticates ME (IDS[0]), who is NOT IDS[1].
    const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}`, cookies });
    const row = res.json().players.find((p: any) => p.steamid === IDS[1]);
    expect(row.stats.skeets).toBe(2);
    expect(row.stats).not.toHaveProperty('times_skeeted');
  });

  it('shows self-only stats in your own row', async () => {
    const matchId = playCompletedMatch(db);
    seedStats(db, matchId, ME, { skeets: 2, times_skeeted: 5 });
    const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}`, cookies });
    const row = res.json().players.find((p: any) => p.steamid === ME);
    expect(row.stats.times_skeeted).toBe(5);
  });

  it('returns privateStatTotals null on someone else profile', async () => {
    const matchId = playCompletedMatch(db);
    seedStats(db, matchId, IDS[1], { times_skeeted: 5 });
    const res = await app.inject({ method: 'GET', url: `/api/players/${IDS[1]}`, cookies });
    expect(res.json().privateStatTotals).toBeNull();
  });

  it('returns privateStatTotals on your own profile', async () => {
    const matchId = playCompletedMatch(db);
    seedStats(db, matchId, ME, { times_skeeted: 5 });
    const res = await app.inject({ method: 'GET', url: `/api/players/${ME}`, cookies });
    expect(res.json().privateStatTotals.times_skeeted).toBe(5);
  });
});
```

Authentication already exists on these routes. `tests/stats.test.ts` sets `cookies` in
`beforeEach` via `authedCookie(app, db, ME)` from `tests/helpers.ts:7`. Do not invent a
session helper.

Add this seeding helper at module scope in `tests/stats.test.ts`, next to `playCompletedMatch`:

```ts
function seedStats(db: DB, matchId: number, steamid: string, stats: Record<string, number>): void {
  const ins = db.prepare(
    'INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)',
  );
  for (const [stat, value] of Object.entries(stats)) ins.run(matchId, steamid, stat, value);
}
```

`src/db.ts:103` sets `foreign_keys = ON`, so the player and match rows must exist first.
`playCompletedMatch` creates both, so always call it before `seedStats`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stats.test.ts`
Expected: FAIL, `row.stats` is undefined

- [ ] **Step 3: Implement the filter helper**

**Correction to the spec.** The spec says this is "the first authenticated read path" in
`stats.ts`. That is wrong: every route here is already guarded by `makeRequireActive(db)`
(`src/routes/guards.ts`), and `tests/stats.test.ts` has a `requires auth` test asserting 401
on all of them. The guard **returns the viewer's steamid** and the handlers currently discard
it. Use that return value rather than importing `getSession`.

In `src/routes/stats.ts`, add one import:

```ts
import { STAT_DEFS, statDef } from '../statKeys.js';
```

Add near the top of the module:

```ts
/** Strip self-only stats unless the requester IS the subject.
 *
 *  Enforced here rather than in the UI on purpose: a value the server sends is
 *  a value the viewer can read, regardless of what the page chooses to render. */
function visibleStats(
  raw: Record<string, number>, subject: string, viewer: string,
): Record<string, number> {
  const isSelf = viewer === subject;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const def = statDef(k);
    if (!def) continue;
    if (def.visibility === 'self' && !isSelf) continue;
    out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4: Attach stats to the match detail response**

In the `GET /api/matches/:id` handler, after the players query, load and attach:

```ts
    // requireActive already returns the steamid; the existing line discards it.
    // Change `if (!requireActive(req, reply)) return;` at the top of this handler to:
    //     const viewer = requireActive(req, reply);
    //     if (!viewer) return;
    const statRows = db.prepare(
      'SELECT player_id, stat, value FROM match_player_stats WHERE match_id = ?',
    ).all(id) as { player_id: string; stat: string; value: number }[];
    const byPlayer = new Map<string, Record<string, number>>();
    for (const r of statRows) {
      const bucket = byPlayer.get(r.player_id) ?? {};
      bucket[r.stat] = r.value;
      byPlayer.set(r.player_id, bucket);
    }
```

and in the mapping that builds each player row, add:

```ts
      stats: visibleStats(byPlayer.get(p.steamid) ?? {}, p.steamid, viewer),
```

- [ ] **Step 5: Add profile totals**

In the `GET /api/players/:steamid` handler, after the existing `totals` query:

```ts
    // Same change as the match handler: capture requireActive's return value.
    //     const viewer = requireActive(req, reply);
    //     if (!viewer) return;
    const rows = db.prepare(
      `SELECT mps.stat, SUM(mps.value) AS total
       FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
       WHERE mps.player_id = ? AND m.state = 'completed'
       GROUP BY mps.stat`,
    ).all(steamid) as { stat: string; total: number }[];

    const statTotals: Record<string, number> = {};
    const privateTotals: Record<string, number> = {};
    for (const r of rows) {
      const def = statDef(r.stat);
      if (!def) continue;
      (def.visibility === 'self' ? privateTotals : statTotals)[r.stat] = r.total;
    }
    const isSelf = viewer === steamid;
```

Add to the response object:

```ts
      statTotals,
      privateStatTotals: isSelf ? privateTotals : null,
      statDefs: STAT_DEFS,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/stats.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/routes/stats.ts tests/stats.test.ts
git commit -m "feat(stats): serve skill stats with self-only visibility enforced server side"
```

---

### Task 5: Stat leaderboards

**Files:**
- Modify: `src/routes/stats.ts`
- Test: `tests/stats.test.ts`

**Interfaces:**
- Consumes: `statDef`, `publicStatKeys` from Task 1
- Produces: `GET /api/leaderboard/stat/:key?season=N&limit=N`

The existing `GET /api/leaderboard` is the SR ladder and is left alone.

- [ ] **Step 1: Write the failing test**

```ts
// Append INSIDE `describe('stats routes')` in tests/stats.test.ts, using the
// same `db`, `app`, `cookies`, `IDS`, `playCompletedMatch` and `seedStats` as Task 4.
describe('stat leaderboard', () => {
  it('ranks players by summed stat across completed matches in a season', async () => {
    const matchId = playCompletedMatch(db);
    seedStats(db, matchId, IDS[0], { skeets: 5 });
    seedStats(db, matchId, IDS[1], { skeets: 9 });
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/skeets', cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: any) => r.steamid)).toEqual([IDS[1], IDS[0]]);
    expect(res.json().rows[0].total).toBe(9);
  });

  it('refuses a self-only stat even though the key is valid', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/times_skeeted', cookies });
    expect(res.statusCode).toBe(404);
  });

  it('refuses an unknown stat key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/wat', cookies });
    expect(res.statusCode).toBe(404);
  });
});
```

Also add the new URL to the existing `requires auth` test near the top of
`describe('stats routes')`, so the new endpoint cannot silently become the one
unauthenticated stats route:

```ts
    for (const url of ['/api/leaderboard', '/api/leaderboard/stat/skeets', `/api/players/${ME}`, '/api/matches', '/api/matches/1']) {
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stats.test.ts -t "stat leaderboard"`
Expected: FAIL, 404 on the first test because the route does not exist

- [ ] **Step 3: Implement**

Add to `statsRoutes` in `src/routes/stats.ts`:

```ts
  /** Per-stat ladder. `self`-visibility stats are refused here rather than
   *  filtered later: a "most skeeted" board is exactly what the private
   *  visibility rule exists to prevent, so it must not be reachable by URL. */
  app.get('/api/leaderboard/stat/:key', async (req, reply) => {
    if (!requireActive(req, reply)) return;
    const { key } = req.params as { key: string };
    const def = statDef(key);
    if (!def || def.visibility !== 'public') return reply.code(404).send({ error: 'unknown stat' });

    const q = req.query as { season?: string; limit?: string };
    const seasonId = q.season ? Number(q.season) : currentSeasonId(db);
    const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), 100);

    const rows = db.prepare(
      `SELECT mps.player_id AS steamid, p.name, p.avatar, SUM(mps.value) AS total
       FROM match_player_stats mps
       JOIN matches m ON m.id = mps.match_id
       JOIN players p ON p.steamid = mps.player_id
       WHERE mps.stat = ? AND m.season_id = ? AND m.state = 'completed'
       GROUP BY mps.player_id
       ORDER BY total DESC, p.name ASC
       LIMIT ?`,
    ).all(key, seasonId, limit);

    return { stat: def, seasonId, rows };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/stats.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/stats.ts tests/stats.test.ts
git commit -m "feat(stats): add per-stat season leaderboard endpoint"
```

---

### Task 6: Display

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/routes/MatchDetail.tsx`
- Modify: `web/src/routes/Profile.tsx`
- Test: `web/src/routes/routes.test.tsx`

**Interfaces:**
- Consumes: the API shapes from Tasks 4 and 5
- Produces: no exported interfaces; UI only

- [ ] **Step 1: Write the failing test**

```tsx
// Append to web/src/routes/routes.test.tsx. That file mocks the api module via
// `mockApi` and renders components directly; there are no renderMatch/renderProfile
// helpers. Follow the existing MatchDetail test at line 73 for the shape.
describe('skill stats display', () => {
  it('renders skill stat columns on the match page', async () => {
    mockApi.match.mockResolvedValue({
      match: { id: 7, campaign: 'no_mercy', state: 'completed', endedAt: '2026-09-06T04:00:00', teamAScore: 900, teamBScore: 800, winner: 'a' },
      maps: [{ ordinal: 0, map: 'l4d_hospital01_apartment', teamAScore: 400, teamBScore: 300 }],
      players: [
        { steamid: '1', name: 'alice', team: 'a', siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4, srDelta: 12,
          stats: { skeets: 2, deadstops: 1, tank_damage: 1699 } },
      ],
    });
    render(<MatchDetail id="7" me="1" />);
    await waitFor(() => expect(screen.getByText('Skeets')).toBeTruthy());
    expect(screen.getByText('1699')).toBeTruthy();
  });

  it('shows the private panel only when privateStatTotals is present', async () => {
    mockApi.profile.mockResolvedValue({
      player: { steamid: '1', name: 'alice', avatar: null },
      sr: 1500, wins: 3, losses: 1, games: 4,
      totals: { siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4 },
      matches: [],
      statTotals: { skeets: 12 },
      privateStatTotals: { times_skeeted: 7 },
    });
    render(<Profile steamid="1" />);
    await waitFor(() => expect(screen.getByText('Times skeeted')).toBeTruthy());
  });

  it('hides the private panel when privateStatTotals is null', async () => {
    mockApi.profile.mockResolvedValue({
      player: { steamid: '2', name: 'bob', avatar: null },
      sr: 1500, wins: 3, losses: 1, games: 4,
      totals: { siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4 },
      matches: [],
      statTotals: { skeets: 12 },
      privateStatTotals: null,
    });
    render(<Profile steamid="2" />);
    await waitFor(() => expect(screen.getByText('bob')).toBeTruthy());
    expect(screen.queryByText('Times skeeted')).toBeNull();
  });
});
```

The exact prop names for `Profile` and the exact shape of the profile response must be
read from `web/src/routes/Profile.tsx` and `web/src/api.ts` before writing these tests;
the fields above other than `statTotals` and `privateStatTotals` are illustrative of the
existing shape, not authoritative. Match whatever those files already declare.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/routes/routes.test.tsx`
Expected: FAIL, "Skeets" not found

- [ ] **Step 3: Extend the API types**

In `web/src/api.ts`, add to the match player interface:

```ts
  stats: Record<string, number>;
```

and to the profile interface:

```ts
  statTotals: Record<string, number>;
  privateStatTotals: Record<string, number> | null;
  statDefs: { key: string; side: 'survivor' | 'infected'; visibility: 'public' | 'self'; label: string; needsSkillDetect: boolean }[];
```

- [ ] **Step 4: Render on the match page**

In `web/src/routes/MatchDetail.tsx`, after the existing `Revives` header add headers for the columns that any player in this match actually has, so a match played without skill_detect shows no empty columns:

```tsx
const skillCols = Array.from(
  new Set(players.flatMap((p) => Object.keys(p.stats ?? {})))
).sort();
```

Add to the header row, before the `SR` header:

```tsx
{skillCols.map((k) => <th class="num" key={k}>{labelFor(k)}</th>)}
```

Add to each body row, before the `SR` cell:

```tsx
{skillCols.map((k) => <td class="num" key={k}>{p.stats?.[k] ?? 0}</td>)}
```

Add a local label helper near the top of the file. It duplicates the registry's labels rather than importing server code, because `web/` does not import from `src/`:

```tsx
const STAT_LABELS: Record<string, string> = {
  skeets: 'Skeets', team_skeets: 'Team skeets', skeets_hurt: 'Hurt skeets',
  skeet_assists: 'Skeet assists', skeets_shotgun: 'Shotgun skeets',
  skeets_sniper: 'Sniper skeets', skeets_melee: 'Melee skeets',
  deadstops: 'Deadstops', boomer_pops: 'Boomer pops', crowns: 'Crowns',
  draw_crowns: 'Draw crowns', tongue_cuts: 'Tongue cuts', self_clears: 'Self clears',
  rock_skeets: 'Rock skeets', clears: 'Clears', insta_clears: 'Insta clears',
  dps_landed: 'DPs landed', pounce_damage_high: 'High pounce damage',
  biles_landed: 'Biles landed', survivors_biled: 'Survivors biled',
  tank_rocks_landed: 'Tank rocks landed', times_skeeted: 'Times skeeted',
  times_deadstopped: 'Times deadstopped', tank_damage: 'Tank damage',
  damage_as_si: 'Damage as SI', tank_punches: 'Tank punches',
};
const labelFor = (k: string): string => STAT_LABELS[k] ?? k;
```

- [ ] **Step 5: Render the private panel on Profile**

In `web/src/routes/Profile.tsx`, add after the existing totals panel:

```tsx
{profile.privateStatTotals && (
  <Panel title="Only you can see this">
    <p class="muted">
      Shown to you alone. Nobody else sees these numbers and they never appear on a leaderboard.
    </p>
    <table>
      <tbody>
        {Object.entries(profile.privateStatTotals).map(([k, v]) => (
          <tr key={k}><td>{labelFor(k)}</td><td class="num">{v}</td></tr>
        ))}
      </tbody>
    </table>
  </Panel>
)}
```

Import or duplicate `labelFor` the same way as in Task 6 Step 4.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run web/src/routes/routes.test.tsx && npm run build`
Expected: PASS and a clean build

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/routes/MatchDetail.tsx web/src/routes/Profile.tsx web/src/routes/routes.test.tsx
git commit -m "feat(web): show skill stats on match pages and a private panel on your own profile"
```

---

### Task 7: pug_match.cfg

This is the blocker that makes everything above reachable. Without it a ranked match never reaches ready-up, never leaves `MS_Pending`, and records `0-0` for every map.

**Files:**
- Create: `deploy/overrides/left4dead/cfg/pug_match.cfg`

**Interfaces:**
- Consumes: nothing
- Produces: the config `src/orchestrator.ts:94` already execs by name

- [ ] **Step 1: Create the config**

```
//=========================================
// pug_match
//
// Workstation-managed. Exec'd by the PUG backend over RCON at match setup
// (src/orchestrator.ts:94) BEFORE sm_pug_match and the roster, and before the
// changelevel to the first map.
//
// Keep this file pure ASCII and BOM-free. Source's cfg parser breaks comments
// on the first non-ASCII byte and runs the remainder as console commands.
//
// WHY THIS FILE EXISTS. The orchestrator has always exec'd "pug_match", but the
// file did not exist, so the line silently did nothing. Ready-up lives only in
// the competitive configs, and without ready-up Rotoblin never fires
// OnRoundIsLive, so pug-match.smx never leaves MS_Pending and scores nothing.
// A PUG launched at a pub-configured server recorded 0-0 for every map. Found
// 2026-09-06.
//
// Do NOT try to use !load / sm_match / sm_mode from the backend instead.
// comp_loader.sp:925 starts Config_Changer with "if (client == 0) return", so
// every one of those commands is a no-op over RCON. exec is the only path.
//=========================================

// Ranked ruleset. Hardcore, decided 2026-09-06. Not lite.
exec rotoblin_hardcore_4v4.cfg

// skill_detect is a DATA SOURCE here, not a display.
//
// pug-match.smx reads LibraryExists("skill_detect") at MATCH_START and stamps
// skilldetect=0|1 on the dump. If this plugin is missing, every skill stat is
// omitted from the dump and the site shows them as unavailable rather than as
// zeros. Note the library name is "skill_detect", NOT "l4d2_skill_detect".
sm plugins load_unlock
sm plugins load l4d2_skill_detect.smx
sm plugins load_lock

// Silence its chat callouts for ranked play. The forwards still fire; only the
// CPrintToChat output is suppressed. If you ever need to re-verify the plugin
// in game, set this back to 1 temporarily: silence is not evidence of breakage.
sm_cvar sm_skill_report_enable 0

// Production orientation threshold. stage.sh --solo drops this to 1 for
// single-player testing and the runbook says to put it back; this makes the
// backend authoritative so a forgotten test cvar cannot reach a ranked match.
sm_pug_min_orient 3
sm_pug_debug 0
```

- [ ] **Step 2: Verify the referenced config exists on the box**

Run:

```bash
cd /home/volence/l4d && . ./deploy/server.env && ssh root@$L4D_HOST 'ls -la /home/l4d/l4d1-server/left4dead/cfg/rotoblin_hardcore_4v4.cfg'
```

Expected: the file exists. If it does not, stop and resolve the config name before going further.

- [ ] **Step 3: Commit**

```bash
git add deploy/overrides/left4dead/cfg/pug_match.cfg
git commit -m "fix(pug): add the pug_match.cfg the orchestrator has always exec'd"
```

Note: this file lives in the `l4d` tree, not the `pug` repo. Commit it wherever that tree is versioned, or note it as an untracked deployment artifact if it is not.

---

### Task 8: Plugin capture

**Files:**
- Create: `plugin/pug-stats.inc`
- Modify: `plugin/pug-match.sp`
- Modify: `plugin/build.sh`

**Interfaces:**
- Consumes: `g_iClientRoster`, `g_iRosterCount`, `g_sRosterId`, `MAX_ROSTER`, `DumpLine`, `PugDebug` from `pug-match.sp`
- Produces: `ResetSkillStats()`, `SampleSkillDetect()`, `WriteSkillLines()`, `AddStat(int client, PugStat stat, int amount)`

- [ ] **Step 1: Create `plugin/pug-stats.inc`**

```sourcepawn
/** Skill stat capture for pug-match.
 *
 *  Included by pug-match.sp rather than living in its own plugin: every counter
 *  here has to be keyed to a roster slot that survives reconnects and map
 *  changes, and has to be emitted inside sm_pug_dump. pug-match owns the roster
 *  and the dump; a separate plugin would need natives just to reach them.
 *
 *  All l4d2_skill_detect forwards are GLOBAL forwards, so no dependency is
 *  required: if the plugin is absent these handlers simply never fire. That
 *  creates a silent-failure mode (zero skeets for everyone looks exactly like a
 *  match where nobody skeeted), so g_bSkillDetect is sampled at MATCH_START and
 *  stamped on the dump. */

// The include MUST be wrapped. l4d2_skill_detect.inc:427 declares
//
//     public SharedPlugin __pl_l4d2_skill_detect = {
//         name = "skill_detect", file = "l4d2_skill_detect.smx",
//     #if defined REQUIRE_PLUGIN
//         required = 1,
//     #else
//         required = 0,
//     #endif
//     };
//
// REQUIRE_PLUGIN is defined by default, so a bare `#include <l4d2_skill_detect>`
// makes skill_detect a HARD dependency and SourceMod refuses to load pug-match
// on any server without it. That would break the skilldetect=0 design, break the
// casual server, and break Task 9's verification step, which unloads
// skill_detect on purpose. pug-match already uses this exact idiom for
// readyup.inc at pug-match.sp:7-9; match it.
#undef REQUIRE_PLUGIN
#include <l4d2_skill_detect>
#define REQUIRE_PLUGIN

enum PugStat
{
	PS_Skeets = 0, PS_TeamSkeets, PS_SkeetsHurt, PS_SkeetAssists,
	PS_SkeetsShotgun, PS_SkeetsSniper, PS_SkeetsMelee,
	PS_Deadstops, PS_BoomerPops, PS_Crowns, PS_DrawCrowns,
	PS_TongueCuts, PS_SelfClears, PS_RockSkeets, PS_Clears, PS_InstaClears,
	PS_DpsLanded, PS_PounceDamageHigh, PS_BilesLanded, PS_SurvivorsBiled,
	PS_TankRocksLanded, PS_TimesSkeeted, PS_TimesDeadstopped,
	PS_TankDamage, PS_DamageAsSi, PS_TankPunches,
	PS_MAX
};

/** Wire keys. MUST match src/statKeys.ts exactly; tests/statKeys.test.ts is the
 *  backstop on the TypeScript side and a mismatch here is a silently missing
 *  stat, not an error. */
static const char g_sStatKey[PS_MAX][24] = {
	"skeets", "team_skeets", "skeets_hurt", "skeet_assists",
	"skeets_shotgun", "skeets_sniper", "skeets_melee",
	"deadstops", "boomer_pops", "crowns", "draw_crowns",
	"tongue_cuts", "self_clears", "rock_skeets", "clears", "insta_clears",
	"dps_landed", "pounce_damage_high", "biles_landed", "survivors_biled",
	"tank_rocks_landed", "times_skeeted", "times_deadstopped",
	"tank_damage", "damage_as_si", "tank_punches"
};

/** True for stats that come from skill_detect and must be omitted (not zeroed)
 *  from the dump when it was not loaded. The last three are captured by
 *  pug-match's own hooks and are always available. */
static bool StatNeedsSkillDetect(PugStat s)
{
	return s != PS_TankDamage && s != PS_DamageAsSi && s != PS_TankPunches;
}

int g_iSkill[MAX_ROSTER][PS_MAX];
bool g_bSkillDetect;                     // sampled at MATCH_START, not at dump time

void ResetSkillStats()
{
	for (int i = 0; i < MAX_ROSTER; i++)
		for (int s = 0; s < view_as<int>(PS_MAX); s++)
			g_iSkill[i][s] = 0;
	g_bSkillDetect = false;
}

/** Sampled once when the match goes live. Deliberately not read at dump time:
 *  a mid-match unload would otherwise make a partial capture look complete. */
void SampleSkillDetect()
{
	g_bSkillDetect = LibraryExists("skill_detect");
	PugDebug("skill_detect present=%d", g_bSkillDetect ? 1 : 0);
}

void AddStat(int client, PugStat stat, int amount = 1)
{
	if (client < 1 || client > MaxClients) return;
	int slot = g_iClientRoster[client];
	if (slot == -1) return;
	g_iSkill[slot][stat] += amount;
}

void WriteSkillLines()
{
	for (int i = 0; i < g_iRosterCount; i++)
	{
		char line[512];
		Format(line, sizeof(line), "SKILL steamid=%s", g_sRosterId[i]);
		for (int s = 0; s < view_as<int>(PS_MAX); s++)
		{
			if (!g_bSkillDetect && StatNeedsSkillDetect(view_as<PugStat>(s))) continue;
			Format(line, sizeof(line), "%s %s=%d", line, g_sStatKey[s], g_iSkill[i][s]);
		}
		// DumpLine is `DumpLine(const char[] fmt, any ...)` (pug-match.sp:164) and
		// VFormats its first argument, so a runtime-built string must never be
		// passed as the format. Current keys and steamids cannot contain '%', but
		// a non-literal format string is a latent defect regardless.
		DumpLine("%s", line);
	}
}

// ---------- skill_detect forwards ----------
//
// NOTE: OnSkeet does NOT fire for weapon-specific skeets. The dispatch in
// l4d2_skill_detect.sp:3461-3523 is an if/else-if chain, so a shotgun skeet
// fires OnSkeetShotgun ONLY. Implementing OnSkeet alone would miss nearly every
// skeet on L4D1. They are mutually exclusive, so summing them cannot double
// count. OnSkeetMagnum and OnSkeetGL can never fire on L4D1 (no such weapons)
// and are implemented only so the totals stay right if pointed at L4D2.

static void CountSkeet(int survivor, int victim, bool isTeamSkeet, PugStat weaponStat)
{
	AddStat(survivor, isTeamSkeet ? PS_TeamSkeets : PS_Skeets);
	if (weaponStat != PS_MAX) AddStat(survivor, weaponStat);
	AddStat(victim, PS_TimesSkeeted);
}

public void OnSkeet(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_MAX); }

public void OnSkeetShotgun(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_SkeetsShotgun); }

public void OnSkeetSniper(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_SkeetsSniper); }

public void OnSkeetMelee(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_SkeetsMelee); }

public void OnSkeetMagnum(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_MAX); }

public void OnSkeetGL(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_MAX); }

public void OnSkeetHurt(int survivor, int victim, int damage, bool isOverkill, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ AddStat(survivor, PS_SkeetsHurt); }

public void OnSkeetShotgunHurt(int survivor, int victim, int damage, bool isOverkill, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ AddStat(survivor, PS_SkeetsHurt); }

public void OnSkeetSniperHurt(int survivor, int victim, int damage, bool isOverkill, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ AddStat(survivor, PS_SkeetsHurt); }

public void OnSkeetMeleeHurt(int survivor, int victim, int damage, bool isOverkill, bool isTeamSkeet, bool isHunter, bool headshot)
{ AddStat(survivor, PS_SkeetsHurt); }

public void OnTeamSkeetAssist(int victim, int assist, bool isHunter, int damage, int shots)
{ AddStat(assist, PS_SkeetAssists); }

public void OnHunterDeadstop(int survivor, int hunter)
{ AddStat(survivor, PS_Deadstops); AddStat(hunter, PS_TimesDeadstopped); }

public void OnBoomerPop(int survivor, int boomer, int shoveCount, float timeAlive)
{ AddStat(survivor, PS_BoomerPops); }

public void OnWitchCrown(int survivor, int damage)
{ AddStat(survivor, PS_Crowns); }

public void OnWitchCrownHurt(int survivor, int damage, int chipdamage)
{ AddStat(survivor, PS_DrawCrowns); }

public void OnTongueCut(int survivor, int smoker)
{ AddStat(survivor, PS_TongueCuts); }

public void OnSmokerSelfClear(int survivor, int smoker, bool withShove, bool headshot)
{ AddStat(survivor, PS_SelfClears); }

public void OnTankRockSkeeted(int survivor, int tank)
{ AddStat(survivor, PS_RockSkeets); }

public void OnTankRockEaten(int tank, int survivor)
{ AddStat(tank, PS_TankRocksLanded); }

public void OnHunterHighPounce(int hunter, int victim, int actualDamage, float calculatedDamage, float height, bool bReportedHigh)
{
	if (bReportedHigh) AddStat(hunter, PS_DpsLanded);
	AddStat(hunter, PS_PounceDamageHigh, actualDamage);
}

public void OnBoomerVomitLanded(int boomer, int amount)
{ AddStat(boomer, PS_BilesLanded); AddStat(boomer, PS_SurvivorsBiled, amount); }

/** insta_clears is a SUBSET of clears, not additional to it. */
public void OnSpecialClear(int clearer, int pinner, int pinvictim, int zombieClass, float timeA, float timeB, bool withShove, bool headshot)
{
	AddStat(clearer, PS_Clears);
	if (timeA > 0.0 && timeA <= 0.75) AddStat(clearer, PS_InstaClears);
}
```

- [ ] **Step 2: Wire it into pug-match.sp**

Add after the existing includes in `plugin/pug-match.sp`:

```sourcepawn
#include "pug-stats.inc"
```

In `ResetMatchState()`, next to the other resets:

```sourcepawn
	ResetSkillStats();
```

In `OnRoundIsLive()`, inside the `if (g_State == MS_Pending)` block that emits `MATCH_START`, add before the emit:

```sourcepawn
		SampleSkillDetect();
```

In `WriteDump()`, change the header line and add the skill lines after the `STAT` loop:

```sourcepawn
	DumpLine("DUMP match=%d skilldetect=%d", g_iMatchId, g_bSkillDetect ? 1 : 0);
```

```sourcepawn
	WriteSkillLines();
```

- [ ] **Step 3: Capture tank damage and SI damage natively**

**Read this before editing.** `Event_PlayerHurt` (`pug-match.sp:805`) returns at line 810 for
any attacker that is not a survivor:

```sourcepawn
	if (attacker <= 0 || attacker > MaxClients || !IsSurvivorClient(attacker)) return;
```

So infected-side capture placed anywhere in the current body is unreachable. The guard has to
be split first. Change line 810 to drop the survivor clause:

```sourcepawn
	if (attacker <= 0 || attacker > MaxClients) return;
```

Then, immediately after the existing `if (damage <= 0) return;`, insert the infected branch and
restore the survivor guard below it:

```sourcepawn
	// Infected-side capture MUST sit above the survivor-only guard: this handler
	// used to return at line 810 for any non-survivor attacker, which is why
	// nothing has ever recorded the infected half of a match. An infected
	// attacker contributes nothing to the survivor stats below, so return here.
	if (IsInfectedClient(attacker) && !IsFakeClient(attacker) && IsSurvivorClient(victim))
	{
		AddStat(attacker, PS_DamageAsSi, damage);
		if (GetEntProp(attacker, Prop_Send, "m_zombieClass") == ZC_TANK)
		{
			char wpn[32];
			event.GetString("weapon", wpn, sizeof(wpn));
			if (StrEqual(wpn, "tank_claw")) AddStat(attacker, PS_TankPunches);
		}
		return;
	}

	// Restores the behaviour the original line-810 guard had for every path below.
	if (!IsSurvivorClient(attacker)) return;

	// Tank damage stays out of sidmg on purpose: the compstats convention exists so
	// tank damage does not distort survivor damage totals. But the hook already runs
	// for tanks and the existing siVictim check just discards it, so route it to its
	// own key instead of dropping it.
	if (IsInfectedClient(victim) && GetEntProp(victim, Prop_Send, "m_zombieClass") == ZC_TANK)
	{
		AddStat(attacker, PS_TankDamage, damage);
	}
```

Leave the `ZC_TANK` guards at lines 850 and 886 alone: those govern `sikill` and the overkill
remainder, which stay tank-free.

- [ ] **Step 4: Teach build.sh about the second source file**

In `plugin/build.sh`, alongside the existing copy of `pug-match.sp`:

```bash
cp pug-match.sp "$SCRIPTING/pug-match.sp"
cp pug-stats.inc "$SCRIPTING/pug-stats.inc"
trap 'rm -f "$SCRIPTING/pug-match.sp" "$SCRIPTING/pug-stats.inc"' EXIT
```

The compile also needs skill_detect's include on the search path:

```bash
cp /home/volence/l4d/L4D1_2-Plugins/l4d2_skill_detect/scripting/include/l4d2_skill_detect.inc "$SCRIPTING/include/l4d2_skill_detect.inc"
```

Add that file to the `trap` cleanup as well.

- [ ] **Step 5: Build**

Run: `cd plugin && ./build.sh`
Expected: `built: .../pug-match.smx`, zero errors. The single pre-existing `halflife.inc` `CreateDialog` deprecation warning is expected and unrelated.

- [ ] **Step 6: Commit**

```bash
git add plugin/pug-stats.inc plugin/pug-match.sp plugin/build.sh
git commit -m "feat(plugin): capture skill_detect events and tank damage per roster slot"
```

---

### Task 9: End to end verification on the box

There is no unit test harness for SourcePawn here, so the plugin half is verified by playing. Everything above is unproven until this passes.

**Files:**
- Modify: `plugin/TESTING.md` (append the section below once it passes)

**Interfaces:**
- Consumes: everything
- Produces: a runbook section

- [ ] **Step 1: Stage the plugin**

Run: `cd plugin && ./stage.sh --solo`
Expected: `Plugin PUG Match reloaded successfully.` Do NOT accept a `FAILED to load` message without checking `sm plugins list` for `"PUG Match"` yourself; that grep was wrong until 2026-09-06.

- [ ] **Step 2: Confirm the capability flag samples correctly**

With skill_detect loaded, set up a match and take it live, then:

```bash
./rcon.py "sm_pug_dump testtoken" | head -1
```

Expected: `DUMP match=<id> skilldetect=1`

Then unload skill_detect (`sm plugins unload l4d2_skill_detect`), set up a fresh match, take it live, and dump again. Expected: `skilldetect=0`, and `SKILL` lines carrying only `tank_damage`, `damage_as_si` and `tank_punches`. This is the check that proves "not measured" cannot be persisted as zero.

- [ ] **Step 3: Verify counting against ground truth**

Practice mode gives AI special infected with no cheats: `!load 1v4` in chat, then

```bash
./rcon.py "l4d_infectedbots_hunter_limit 4"
```

Set `sm_skill_report_enable 1` temporarily so the starred chat lines are visible, skeet a known number of hunters, then compare three sources that must agree:

1. the starred `skill_detect` chat lines
2. the `l4dcompstats` end-of-round SURVIVOR STATS table
3. `skeets` in the `SKILL` dump line

All three agreed on 2026-09-06 (2, 2 and n/a). A disagreement between 1 and 2 is a `skill_detect` threshold issue on L4D1; a disagreement between 1 and 3 is a bug in this code.

Put `sm_skill_report_enable` back to 0 when done.

- [ ] **Step 4: Verify the full loop**

Create a match through the app so `RealOrchestrator.setupMatch()` runs (this has never been exercised against the live server). Play two halves. Confirm rows land in `match_player_stats`, the match page renders the new columns, and your own profile shows the private panel while another account's does not.

- [ ] **Step 5: Restore the server**

```bash
./rcon.py "sm_pug_abort <token>"
./rcon.py "sm_pug_min_orient 3"
./rcon.py "sm_pug_debug 0"
./rcon.py "exec rotoblin_pub.cfg"
```

- [ ] **Step 6: Commit the runbook**

```bash
git add plugin/TESTING.md
git commit -m "docs(plugin): add skill stats verification runbook"
```
