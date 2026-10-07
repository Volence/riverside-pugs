# Tournaments plan T6: carry game 1's score into game 2 (Bo2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ruleset switch, `series.carryScore` (default off), makes game 2 of a best of 2 series start with game 1's totals in the box's l4dscores tally. The in-game scoreboard then shows the running series score, and from game 2's second chapter on the team ahead overall survives first.

**Architecture:** There are three layers, and each has one owner.
- **The rule:** `src/rulesets.ts` `MatchRules.series` gains `carryScore: boolean`. It is parsed, edited, snapshotted and summarised the way plan T5's fields are.
- **The numbers:** a new pure-over-the-DB module `src/events/carry.ts` answers "what does this game carry, in pug-team order". Two places use that answer: the game burst (`gameLinesOf` in `src/bookings/tournamentGames.ts`) and crash recovery (`src/bookings/restore.ts`).
- **The box:** pug-match 0.3.27 adds a server command `sm_pug_carry <matchid> <a> <b>`, latched to the pending match. The plugin adds the carry to every l4dscores seed and to its own side-order totals.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), better-sqlite3, vitest (`npx vitest run <file>`), `npm run typecheck`, Preact web (`web/`, its own vitest). SourcePawn 1.12, compiled only in a scratch copy with `plugin/build.sh`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md` (series formats). The owner's rulings of 2026-10-07 (below) extend it.

## Owner rulings (2026-10-07, given)

1. A Bo2 that splits 1-1 is decided by total score. **This is already built** (`src/events/seriesRules.ts:110`, T3b Ruling 5); a tied total replays game 2's last chapter as a tiebreak. This plan does not change it.
2. Score carry-over is a **ruleset option, default off**.
3. With carry on, side order on game 2's maps 2 onward **follows the running series total**. The veto still decides who survives first on game 2's first chapter.

## Rulings this plan makes (for the owner to confirm)

4. **Only game 2 of a Bo2 carries.** Game 1, every game of a Bo1/Bo3/Bo5, and every tiebreak start at 0. A tiebreak decides the series by its own result alone (`seriesRules.ts:124-127`), so a carried total there would only mislead.
5. **The carry is the event's recorded game 1 scores at the moment game 2 is pushed.** A staff correction to game 1 made while game 2 is live reaches the box only on the next push of that burst (a re-push or a crash recovery). The site's series totals always use the corrected rows, so the result is never wrong. Only the in-game tally and side order can lag.
6. **mapCounter stays the game's own.** The seed's third argument is still `g_iMapCount + 1`, so l4dscores' map 3 and map 5 swap rules see game 2's own chapters.
7. **The carry is re-seeded at every go-live on the first chapter this plugin instance plays**, not only at the first. A map restart after go-live (an admin restart or a ready-up unready) makes l4dscores clear its tally on a first map (`L4D_OnClearTeamScores` -> `OnNewMission`). Before plan T6 the resume seed had the same hole; Ruling 7 closes it for both. A re-seed before half 2's round end is idempotent, because l4dscores adds round scores only at half 2's round_end.
8. **The site announces it.** Game 2's start line gains `Game 1's score carries over: Rats 500, Bats 400.` in the existing `say [Match]` start text, so no new plugin copy is needed.
9. **No stage editor warning** when a carry ruleset is used on a stage whose veto is not a Bo2. The rules line names "best of 2", and the switch is a no-op elsewhere.

## Global Constraints

- **PUG behaviour does not change.** `sm_pug_carry` is refused unless `TourneyOn()`, and nothing in a PUG burst sends it.
- **Pug teams are not the room's sides.** Event scores are keyed by entry_a/entry_b (`score_a`/`score_b`). The box's pug teams are oriented through game 2's `matches.booking_side_a`: pug team a is the entry on side `booking_side_a`.
- Every write to `rulesets` stays in `src/rulesetStore.ts`. Every write to the room tables stays in `src/events/room.ts`. `carry.ts` only reads.
- An older plugin answers `sm_pug_carry` with "unknown command"; that is harmless. pug-match 0.3.27 must be staged before an event uses the switch. That is an owner action, written into the checklist.
- The plugin is compiled only in a scratch copy, never into `plugin/` of a tree that is deployed. Nothing is staged, rcon'd, restarted or deployed.
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (a plain sentence). Do not push. Do not deploy.
- Several Claude sessions use `/home/volence/l4d/pug`. Work in the worktree `/home/volence/l4d/pug/.claude/worktrees/carry-score` (branch `carry-score`, cut from master `cee1bd6c` or later). Run `npm ci` in it and in its `web/`.
- The 7 `tests/skeetStreakPoster.test.ts` failures depend on the wall clock and fail on master too. Ignore them, and keep every other test passing.

## Review Focus

1. **Orientation when the veto flips game 2.** If game 2's `booking_side_a` is `'b'` (the entry_b team survives first), pug team a must carry `score_b`. Task 3 pins it with a test where entry_b starts game 2.
2. **A game 2 whose game 1 has no scores.** For example, staff entered a forfeit. A Bo2 forfeit ends the series, so game 2 should never be pushed. `carryFor` still returns null, never `0 0` from nulls. Task 3 pins it.
3. **A stale carry on the box.** Game 2 of series X carries, then the next booking's game 1 on the same box must not inherit it. `Cmd_Match` and `Cmd_Resume` run `ResetMatchState`, which must clear the carry. `sm_pug_carry` for any match id but the pending one is refused. Task 5 pins it in the checklist.
4. **Crash recovery of game 2 after map 1.** `restoreSnapshot`'s `firstSurv` must use totals plus carry. Otherwise the replayed map's sides disagree with what l4dscores (seeded with the carry) would do. Task 4 pins it.
5. **Side-order log noise.** If `SeedNewMapSides` totals leave out the carry, every carried game logs `following l4dscores` as an error on each map. Task 5 adds the carry to those totals and checks the SourceMod error log stays clean.

---

### Task 1: The rule field (server)

**Files:**
- Modify: `src/rulesets.ts` (`MatchRules.series` around l.37, `MATCH_PLAY_DEFAULTS` l.42-44, `TEMPLATES` l.60-109, the `series` parse at l.183-193)
- Modify: `src/rulesetStore.ts` (`readEditableRules` series read around l.145, its returned object, `unratedRules` l.172-178, `mergeStored` l.211-218)
- Modify: `src/events/format.ts` (`rulesLines` l.41-62)
- Test: `tests/rulesets.test.ts`, `tests/rulesetStore.test.ts`, `tests/eventFormat.test.ts`

**Interfaces:**
- Produces: `MatchRules['series'] = { nextGameSeconds: number; carryScore: boolean }`, plus `MATCH_PLAY_DEFAULTS.carryScore = false`. Tasks 2 to 4 read `rules.series.carryScore`.

- [ ] **Step 1: Write the failing tests**

In `tests/rulesets.test.ts`, next to the T5 default test at l.49:

```ts
it('reads series.carryScore (plan T6), false when a ruleset saved before it lacks it, and refuses a non-boolean', () => {
  const base = JSON.parse(JSON.stringify(TEMPLATES['Standard Cup'])) as Record<string, any>;
  delete base.series.carryScore;
  expect(parseRules(JSON.stringify(base)).series).toEqual({ nextGameSeconds: 60, carryScore: false });
  delete base.series;
  expect(parseRules(JSON.stringify(base)).series).toEqual({ nextGameSeconds: 60, carryScore: false });
  base.series = { nextGameSeconds: 90, carryScore: true };
  expect(parseRules(JSON.stringify(base)).series).toEqual({ nextGameSeconds: 90, carryScore: true });
  base.series = { nextGameSeconds: 90, carryScore: 'yes' };
  expect(() => parseRules(JSON.stringify(base))).toThrow('invalid rules: series.carryScore');
});
it('every template carries carryScore false', () => {
  for (const t of Object.values(TEMPLATES)) expect(t.series.carryScore).toBe(false);
});
```

Use the import names the file already uses for `TEMPLATES` and `parseRules`, and add them to its imports if missing.

In `tests/rulesetStore.test.ts`, next to "reads the plan T5 fields when sent..." (l.37), use that test's own helpers (copy its body shape):
- A body with `series: { nextGameSeconds: 60, carryScore: true }` saves, and reads back `carryScore: true`.
- A body with `carryScore: 1` is refused `bad_rules`.
- A body with `series: { nextGameSeconds: 120 }` (no carryScore) saved over a stored `carryScore: true` keeps `true`. This is the mergeStored sub-merge.

In `tests/eventFormat.test.ts` (l.63-78 style):

```ts
it('rulesLines names the score carry-over only when it is on (plan T6)', () => {
  const r = parseRules(JSON.stringify(TEMPLATES['Standard Cup']));
  expect(rulesLines(r).some((l) => l.includes('carries'))).toBe(false);
  const on = { ...r, series: { ...r.series, carryScore: true } };
  expect(rulesLines(on)).toContain("Best of 2: game 2 starts with game 1's score, so later chapters follow the running total");
});
```

`rulesSummary` is unchanged: its exact-string tests must still pass untouched.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/rulesets.test.ts tests/rulesetStore.test.ts tests/eventFormat.test.ts`
Expected: the new tests FAIL (`carryScore` undefined), and the old ones pass.

- [ ] **Step 3: Implement**

`src/rulesets.ts`:
```ts
  /** Plan T5: seconds between two games of a series. Plan T6: carryScore
   *  starts game 2 of a best of 2 with game 1's totals in the box's tally. */
  series: { nextGameSeconds: number; carryScore: boolean };
```
Add `carryScore: false` to `MATCH_PLAY_DEFAULTS`. Add `carryScore: false` to each template's `series` object. Replace the `nextGameSeconds` line built with `one('series', ...)` by a dedicated branch, because the `one` helper handles numbers only. Keep `one` for `disconnect` and `staffCall`, and narrow its key type to `'disconnect' | 'staffCall'`:
```ts
  let series: MatchRules['series'] = { nextGameSeconds: MATCH_PLAY_DEFAULTS.nextGameSeconds, carryScore: MATCH_PLAY_DEFAULTS.carryScore };
  if (r.series !== undefined) {
    if (typeof r.series !== 'object' || r.series === null) fail('series');
    const s = r.series as Record<string, unknown>;
    if (!inRange(s.nextGameSeconds, RULE_RANGES.nextGameSeconds)) fail('series.nextGameSeconds');
    if (s.carryScore !== undefined && typeof s.carryScore !== 'boolean') fail('series.carryScore');
    series = { nextGameSeconds: s.nextGameSeconds as number, carryScore: (s.carryScore as boolean | undefined) ?? MATCH_PLAY_DEFAULTS.carryScore };
  }
```
Then use `series` in the returned object, replacing `series: { nextGameSeconds }`.

`src/rulesetStore.ts`:
- In `readEditableRules`, after the `nextGameSeconds` check, add: `const carryScore = field('series', 'carryScore'); if (carryScore !== undefined && typeof carryScore !== 'boolean') return fail('bad_rules');`.
- Return `series: { nextGameSeconds: (nextGameSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.nextGameSeconds, carryScore: (carryScore as boolean | undefined) ?? MATCH_PLAY_DEFAULTS.carryScore }`. Match the existing return's style for the series object.
- In `mergeStored` add: `if (typeof b.series === 'object' && b.series !== null) b.series = { carryScore: stored.series.carryScore, ...(b.series as object) };`.

`src/events/format.ts` `rulesLines`, after the subs line:
```ts
  if (r.series.carryScore) lines.push("Best of 2: game 2 starts with game 1's score, so later chapters follow the running total");
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/rulesets.test.ts tests/rulesetStore.test.ts tests/eventFormat.test.ts && npm run typecheck`
Expected: PASS. Typecheck errors in other files that build `MatchRules` literals (test fixtures, for example) are fixed by adding `carryScore: false` there.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "Rulesets gain series.carryScore, off by default and off for every saved ruleset, so a best of 2 can start game 2 with game 1's score (plan T6)"
```

### Task 2: The editor toggle (web)

**Files:**
- Modify: `web/src/api.ts` (`MatchRules` mirror, l.2417-2436)
- Modify: `web/src/routes/admin/rulesets/RulesetForm.tsx` (Tournament play group, l.83-107)
- Test: `web/src/routes/admin/rulesets/AdminRulesets.test.tsx` (inline full-rules fixtures at l.21, 27 and 108 gain `carryScore: false`)

**Interfaces:**
- Consumes: Task 1's `series.carryScore`.

- [ ] **Step 1: Write the failing test** in `AdminRulesets.test.tsx`, modelled on "edits the Tournament play numbers..." (l.174). Copy that test's render/mock/save mechanics. The new behaviour: the form shows a toggle labelled `Carry score into game 2`, off for a fixture with `carryScore: false`. Clicking it and saving sends a body whose `series` is `{ nextGameSeconds: <fixture value>, carryScore: true }`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/routes/admin/rulesets/AdminRulesets.test.tsx`
Expected: FAIL, toggle not found.

- [ ] **Step 3: Implement.** In `api.ts`, `series: { nextGameSeconds: number; carryScore: boolean };`. In `RulesetForm.tsx`, directly after the "Next game after" row:
```tsx
        <ToggleRow label="Carry score into game 2" help="Best of 2 series only. Game 2 starts with game 1's totals on the in-game scoreboard, so from game 2's second chapter on the team ahead overall survives first. Game 2's first chapter keeps the sides from the veto. A tiebreak chapter always starts at 0." checked={d.series.carryScore}
          onChange={() => set({ series: { ...d.series, carryScore: !d.series.carryScore } })} />
```
Check that `set`/`readRules` in `rulesDraft.ts` pass `series` through. `readRules` spreads `...base`, but `nextGame` is typed separately. Make sure saving builds `series` from both `typed.nextGame` and `d.series.carryScore`, and does not drop one for the other. Read `rulesDraft.ts`, and if it rebuilds `series` from `nextGame` alone, include `carryScore: d.series.carryScore` there and add a `rulesDraft.test.ts` case for it.

- [ ] **Step 4: Run the web tests and typecheck**

Run: `cd web && npx vitest run src/routes/admin/rulesets && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A web/src
git commit -m "The ruleset editor's Tournament play group gains a Carry score into game 2 switch (plan T6)"
```

### Task 3: What a game carries, the game burst, and the start line

**Files:**
- Create: `src/events/carry.ts`
- Modify: `src/bookings/tournamentGames.ts` (`gameLinesOf` l.83-99)
- Modify: `src/events/series.ts` (`startText` l.352-357)
- Test: `tests/carry.test.ts` (new), `tests/series.test.ts` (the home-and-away describe near l.752)

**Interfaces:**
- Consumes: `R.gamesOf(db, eventMatchId)` (`src/events/room.ts:89`, rows with `id, ordinal, tiebreak_of, score_a, score_b, match_id`); the stage's veto via `E.stageSettingsOf(stage).veto` (`src/events/events.ts`); `parseRules`.
- Produces:
  ```ts
  /** Pug-team order: a is the game's pug team a (the entry on matches.booking_side_a). */
  export interface Carry { a: number; b: number }
  /** What this tournament game (a matches.id) starts with, or null: only game 2
   *  of a best of 2 whose ruleset carries the score and whose game 1 has two scores. */
  export function carryFor(db: DB, gameMatchId: number): Carry | null;
  /** The same in entry order, for the site's own lines. */
  export function carryEntries(db: DB, gameMatchId: number): { entryA: number; entryB: number } | null;
  ```
  Task 4 uses `carryFor`. Task 5's plugin receives `sm_pug_carry <matchid> <a> <b>`.

- [ ] **Step 1: Write the failing tests**

`tests/carry.test.ts`, built on `seriesFixture` (`tests/seriesFixture.ts`). Copy `HA` and `driveHomeAway` from `tests/series.test.ts:752-765` into the new file, or export them from `seriesFixture.ts` if that is cleaner, and update series.test.ts to import them. Turn carry on before the first tick:

```ts
const carryOn = (f: SeriesFixture, on = true) => {
  f.db.prepare("UPDATE event_stages SET rules_json = json_set(rules_json, '$.series.carryScore', json(?))").run(on ? 'true' : 'false');
  f.db.prepare("UPDATE bookings SET rules_json = json_set(rules_json, '$.series.carryScore', json(?)) WHERE rules_json IS NOT NULL").run(on ? 'true' : 'false');
};
```
(Read `seriesFixture` to confirm when the booking row is created. If it exists before your first tick, the second UPDATE is what makes the game's `matches.rules_json` carry the flag.)

Tests:
1. **Carry on, game 2:** play game 1 Rats (entry a) 500, Bats 400, as the existing "plays both games" test does. Tick to push game 2. Then `carryFor(db, g2.match_id)` equals `{ a, b }` oriented by game 2's `booking_side_a`: if `'a'`, `{ a: 500, b: 400 }`, else `{ a: 400, b: 500 }`. Assert against the stored `booking_side_a` and also hard-code the expected value for this fixture's veto, so a flipped orientation fails. The burst in `f.sent` contains `sm_pug_carry <g2 match id> <a> <b>` directly after the `sm_pug_match <g2 id> ...` line. The start line contains `Game 1's score carries over: Rats 500, Bats 400.`
2. **Orientation flip:** change the veto so Bats start game 2 as survivors (game 2's side choice step), or set `event_games.first_survivors` of game 2 to entry b before it is pushed. Then `booking_side_a` is `'b'` and `carryFor` returns `{ a: 400, b: 500 }`.
3. **Carry off:** the same series without `carryOn`. `carryFor` is null for game 2, and no `sm_pug_carry` appears in `f.sent`.
4. **Game 1 never carries, nor does a tiebreak:** `carryFor(db, g1.match_id)` is null. In the tied-totals path (game 2 Rats 300, Bats 400, as the existing test does), the tiebreak game's `carryFor` is null.
5. **Bo3 never carries:** with `presetConfig('loser_picks', ...)` and `driveLoserPicks` and carry on, game 2's `carryFor` is null.
6. **No scores:** set game 1's `score_a`/`score_b` to NULL directly and call `carryFor` for game 2. It returns null.
7. **PUG match ids:** `carryFor(db, <a PUG matches row with no booking>)` is null and does not throw.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/carry.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/events/carry.ts`**

```ts
import type { DB } from '../db.js';
import { parseRules } from '../rulesets.js';
import * as R from './room.js';
import * as E from './events.js';

/** Plan T6: game 2 of a best of 2 may start with game 1's totals in the box's
 *  l4dscores tally (ruleset series.carryScore). Only reads. */
export interface Carry { a: number; b: number }

interface GameCtx { eventMatchId: number; stageId: number; sideA: 'a' | 'b'; rulesJson: string | null }

function contextOf(db: DB, gameMatchId: number): GameCtx | null {
  const row = db.prepare(`
    SELECT em.id AS eventMatchId, em.stage_id AS stageId, m.booking_side_a AS sideA, m.rules_json AS rulesJson
    FROM matches m JOIN event_matches em ON em.booking_id = m.booking_id
    WHERE m.id = ? AND m.booking_id IS NOT NULL`).get(gameMatchId) as GameCtx | undefined;
  return row ?? null;
}

export function carryEntries(db: DB, gameMatchId: number): { entryA: number; entryB: number } | null {
  const c = contextOf(db, gameMatchId);
  if (!c || c.rulesJson === null) return null;
  let carry: boolean;
  try { carry = parseRules(c.rulesJson).series.carryScore; } catch { return null; }
  if (!carry) return null;
  const stage = E.getStage(db, c.stageId);
  if (!stage || E.stageSettingsOf(stage).veto.games !== 2) return null;
  const games = R.gamesOf(db, c.eventMatchId);
  const me = games.find((g) => g.match_id === gameMatchId);
  if (!me || me.tiebreak_of !== null || me.ordinal !== 2) return null;
  const g1 = games.find((g) => g.ordinal === 1 && g.tiebreak_of === null);
  if (!g1 || g1.score_a === null || g1.score_b === null) return null;
  return { entryA: g1.score_a, entryB: g1.score_b };
}

export function carryFor(db: DB, gameMatchId: number): Carry | null {
  const e = carryEntries(db, gameMatchId);
  if (!e) return null;
  const sideA = contextOf(db, gameMatchId)!.sideA ?? 'a';
  return sideA === 'a' ? { a: e.entryA, b: e.entryB } : { a: e.entryB, b: e.entryA };
}
```
Check every name against the code: `E.getStage`, `E.stageSettingsOf`, and the `event_matches.booking_id` / `matches.booking_side_a` columns. If `stageSettingsOf` takes another argument shape, follow it. If importing `events.ts` or `room.ts` from `tournamentGames.ts` creates an import cycle that breaks at load (run the suite to find out), replace those two calls with plain SQL on `event_stages.veto_json` and `event_games`. Also keep `presetConfig`'s fallback for a null `veto_json`, as `events.ts:81` does.

`src/bookings/tournamentGames.ts` `gameLinesOf`, directly after the `sm_pug_match` line:
```ts
    // Plan T6: after sm_pug_match (whose reset would clear it), before go-live.
    ...((c) => (c ? [`sm_pug_carry ${o.matchId} ${Math.trunc(c.a)} ${Math.trunc(c.b)}`] : []))(carryFor(db, o.matchId)),
```
Use a plain `const carry = carryFor(db, o.matchId);` above the return if that reads better.

`src/events/series.ts` `startText`: when `g.match_id !== null` and `carryEntries(this.db, g.match_id)` is non-null, insert `Game 1's score carries over: ${this.name(m, 'a')} ${e.entryA}, ${this.name(m, 'b')} ${e.entryB}. ` after `what`. `startText` is called in `gameLines` after `linkGame`. Check that `due` there has its `match_id` set. If it does not, pass `g.matchId` into `startText` as a parameter.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/carry.test.ts tests/series.test.ts tests/tournamentBooking.test.ts && npm run typecheck`
Expected: PASS. The exact-burst assertions in series.test.ts (l.102, l.869, l.1629) are unchanged, because carry is off in their fixtures.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "Game 2 of a best of 2 that carries the score pushes sm_pug_carry with game 1's totals in pug-team order, and its start line says so (plan T6)"
```

### Task 4: Crash recovery carries too

**Files:**
- Modify: `src/bookings/restore.ts` (`RestoreSnapshot`, `restoreSnapshot` l.38-98, `resumeLines` l.115-128)
- Test: the file that tests `restoreSnapshot`/`resumeLines` (`grep -ln "resumeLines\|restoreSnapshot" tests/`; `tests/series.test.ts` imports `restoreSnapshot` too)

**Interfaces:**
- Consumes: `carryFor` from Task 3.
- Produces: `RestoreSnapshot.carry: Carry | null`. `resumeLines` emits `sm_pug_carry <matchId> <a> <b>` after `sm_pug_resume`, before the `sm_pug_resume_map` lines. The plugin accepts it while the match is pending (Task 5).

- [ ] **Step 1: Write the failing tests** (in the existing restore test file, using its fixtures; if it cannot build a tournament game, put them in `tests/carry.test.ts` with `seriesFixture`):
1. Game 2 with carry `{a: 500, b: 400}` (pug order) and one chapter finished with pug a 100, pug b 150. Game-only totals say b leads (150 > 100), but totals plus carry say a leads (600 > 550). Expect `restoreSnapshot(db, g2)` to have `firstSurv: 'a'` and `carry: { a: 500, b: 400 }`.
2. The same game before any chapter finished: `firstSurv` is `'a'` (map 1 is team a), whatever the carry.
3. `resumeLines(snap)` equals `[sm_pug_resume ..., 'sm_pug_carry <id> 500 400', ...resume_map lines, ...roster, 'sm_pug_resume_commit']`, and has no carry line when `carry` is null.

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (`carry` undefined, firstSurv `'b'`).

- [ ] **Step 3: Implement.** In `restoreSnapshot`: `const carry = carryFor(db, matchId);`. Compute `firstSurv` from `totA + (maps.length > 0 ? carry?.a ?? 0 : 0)` and the matching b. Map 1 stays team a: the veto decided it, and the plugin seeds the tally itself. Return `carry` in the snapshot. In `resumeLines`, after the `sm_pug_resume` line: `...(s.carry ? [`sm_pug_carry ${s.matchId} ${Math.trunc(s.carry.a)} ${Math.trunc(s.carry.b)}`] : []),`. Update the `RestoreSnapshot` type and any test literal that builds one.

- [ ] **Step 4: Run** `npx vitest run tests/carry.test.ts tests/series.test.ts tests/bookingRunner.test.ts && npm run typecheck` and the restore test file. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "Crash recovery of a carried game 2 orders sides by totals plus the carry and sends sm_pug_carry before the resumed maps (plan T6)"
```

### Task 5: pug-match 0.3.27 and the owner's in-game checklist

**Files:**
- Modify: `plugin/pug-match.sp` (`PLUGIN_VERSION` l.30, `ResetMatchState`, server command registration near `sm_pug_resume`, `SeedL4dscoresTally` l.4630-4646, the go-live block at l.4149-4154, `SeedNewMapSides` l.3671-3717)
- Modify: `plugin/pug-tourney.inc` only if the command fits better beside `sm_pug_forfeit` (it needs `TourneyOn()`; registering it in `Tourney_Init` is fine)
- Create: `docs/superpowers/plans/2026-10-07-tournaments-6-carry-score-checklist.md`
- Modify: the fake box in `tests/seriesFixture.ts`: answer `sm_pug_carry` with `PUGOK carry a=<a> b=<b>`, so the burst stays realistic. Check that nothing reads its reply first.

**Interfaces:**
- Consumes: `sm_pug_carry <matchid> <a> <b>` from Tasks 3 and 4.

- [ ] **Step 1: Implement**

Globals: `int g_iCarryA, g_iCarryB; int g_iCarrySeedMaps = -1;`. `ResetMatchState` sets all three back (0, 0, -1).

Command (`RegServerCmd("sm_pug_carry", Cmd_Carry, "sm_pug_carry <matchid> <a> <b> - plan T6: game 1's totals that game 2 of a best of 2 starts with (tournament box)")`):
```sourcepawn
public Action Cmd_Carry(int args)
{
	if (args < 3) { PrintToServer("PUGERR usage: sm_pug_carry <matchid> <a> <b>"); return Plugin_Handled; }
	if (!TourneyOn()) { PrintToServer("PUGERR not a tournament box"); return Plugin_Handled; }
	char buf[16];
	GetCmdArg(1, buf, sizeof(buf));
	int id = StringToInt(buf);
	GetCmdArg(2, buf, sizeof(buf));
	int a = StringToInt(buf);
	GetCmdArg(3, buf, sizeof(buf));
	int b = StringToInt(buf);
	// Only the match pushed just before (sm_pug_match or sm_pug_resume reset
	// the state; this latches onto it), so a stale line never reaches the next game.
	if (g_State != MS_Pending || id != g_iMatchId) { PrintToServer("PUGERR no pending match %d", id); return Plugin_Handled; }
	if (a < 0 || b < 0 || a > 100000 || b > 100000) { PrintToServer("PUGERR bad carry"); return Plugin_Handled; }
	g_iCarryA = a;
	g_iCarryB = b;
	PrintToServer("PUGOK carry a=%d b=%d", a, b);
	LogMessage("[pug] match %d carries game 1's score: a=%d b=%d", id, a, b);
	return Plugin_Handled;
}
bool HasCarry() { return g_iCarryA > 0 || g_iCarryB > 0; }
```
Check `g_State`/`MS_Pending`/`g_iMatchId` against the file (the names are from `Cmd_Resume`).

`SeedL4dscoresTally`: after `TotalScores(a, b);` add `a += g_iCarryA; b += g_iCarryB;`.

Go-live (l.4149-4154): keep the Pending->Live block. Below it, inside `if (g_State == MS_Live)`, add a re-seed (Ruling 7):
```sourcepawn
	// Plan T6 Ruling 7: a restart of this instance's first chapter clears
	// l4dscores' tally on a first map, so seed at every go-live of it.
	if (g_State == MS_Live && (g_bResumed || HasCarry()))
	{
		if (g_iCarrySeedMaps == -1) g_iCarrySeedMaps = g_iMapCount;
		if (g_iMapCount == g_iCarrySeedMaps) SeedL4dscoresTally();
	}
```
Then change the Pending->Live block's `if (g_bResumed) SeedL4dscoresTally();` so the seed is not sent twice at the first go-live. Delete it, because the new block covers it. Read the surrounding code first. If anything between the two blocks returns early, keep the seed in the Pending->Live block and add the re-seed only for later go-lives.

`SeedNewMapSides`: after the totals loop, `totA += g_iCarryA; totB += g_iCarryB;`, and update the log text so it still says "totals".

Bump `PLUGIN_VERSION` to `"0.3.27"`.

- [ ] **Step 2: Compile in a scratch copy only**

```bash
S=/tmp/claude-1000/-home-volence-l4d/<session>/scratchpad/pm027 && rm -rf $S && mkdir -p $S && cp -r plugin $S/ && (cd $S/plugin && ./build.sh)
```
Read `plugin/build.sh` first for where it writes the `.smx`, and point it at the scratch copy. Expected: compiles with 0 errors, and the warnings are no worse than master's build.

- [ ] **Step 3: Update the fake box** in `tests/seriesFixture.ts` (`const carry = /^sm_pug_carry \d+ (\d+) (\d+)$/.exec(c); if (carry) return `PUGOK carry a=${carry[1]} b=${carry[2]}`;`). Run `npx vitest run tests/carry.test.ts tests/series.test.ts`, expected PASS.

- [ ] **Step 4: Write the checklist** at `docs/superpowers/plans/2026-10-07-tournaments-6-carry-score-checklist.md`, in the T5 checklist's format. Use the title `# pug-match 0.3.27: the owner's in-game checklist (Tournaments T6)`, a `## Setup` block of rcon lines (local box, `rotoblin_cheats_4v4`, `sv_lan 0`, `sm_pug_tournament 1`), and the table `| # | Who types what | Expected in chat / console | Log line the site receives |`. Rows, with exact expected text from the code you wrote:
  1. `sm_pug_carry 9101 500 300` with no match: `PUGERR no pending match 9101`.
  2. `sm_pug_match 9101 TOKEN1 hospital` then `sm_pug_carry 9999 1 1`: `PUGERR no pending match 9999`.
  3. `sm_pug_carry 9101 500 300`: `PUGOK carry a=500 b=300`, plus the `[pug] match 9101 carries` log line.
  4. Roster yourself on team a and go live: the SourceMod log has `[l4dscores] seeded: survivors=500 infected=300 mapCounter=1`, and `!scores` shows 500 and 300.
  5. An admin restart of the map after go-live, then go live again: the seed line appears again with the same values.
  6. Finish map 1 with team b ahead on the map but behind overall: at map 2 load, team a survives first, and `logs/errors_*.log` has no `following l4dscores` line.
  7. `sm_pug_tournament 0`, then a new `sm_pug_match` and `sm_pug_carry`: `PUGERR not a tournament box`.
  8. Resume: `sm_pug_resume 9102 TOKEN2 l4d_hospital01_apartment a 1`, then `sm_pug_carry 9102 500 300`, one `sm_pug_resume_map l4d_hospital01_apartment 100 150`, the roster, `sm_pug_resume_commit`, and go live: seeded survivors/infected equal 600/450 for the team on survivors. mapCounter is 2.
  9. A new `sm_pug_match 9103 ...` after a carried game, with no `sm_pug_carry`: go-live sends no seed (no `[l4dscores] seeded` line).

  End the file with an **Owner action** line: stage pug-match 0.3.27 on all five pool boxes (stage-on-restart) before any event's ruleset turns the switch on.

- [ ] **Step 5: Commit** (the `.sp` changes, the fixture and the checklist; never a compiled `.smx`)

```bash
git add plugin/pug-match.sp plugin/pug-tourney.inc tests/seriesFixture.ts docs/superpowers/plans/2026-10-07-tournaments-6-carry-score-checklist.md
git commit -m "pug-match 0.3.27: sm_pug_carry latches game 1's totals onto the pending game 2, every seed and the side-order totals add them, and a restarted first chapter is seeded again (plan T6)"
```
