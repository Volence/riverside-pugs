# Live Win Chance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The public win chance learns from how each team is playing this match (Part A) and moves during a half as survivors lose health, make distance and fight the tank (Part B).

**Architecture:** Part A tilts each team's remaining half-score histograms in `src/winProb.ts` by a form statistic fitted offline. Part B adds a half predictor: from a snapshot of the live half (progress, alive, incaps, health, tank state, time) it returns a final-score histogram in the same 20-pt bins, which replaces the "half still to play" histogram in the existing convolution. Both models are fitted offline by scripts on a prod DB copy plus R2 replays, and their fitted parameters are committed as JSON. The web process only evaluates them.

**Tech Stack:** TypeScript (tsx), better-sqlite3, vitest, Preact (web/), existing R2 client `src/r2.ts`, replay decoder `src/replayFormat.ts` / `src/metrics/replayRound.ts`.

**Spec:** `docs/superpowers/specs/2026-10-26-live-win-chance-design.md`

## Global Constraints

- Ratings never enter the public line. Form comes from this match's halves only.
- No plugin, rcon or game-server change. Web-only, shipped with `deploy-web.sh`.
- Public values use only state at least `DEFAULT_DELAY_MS` (10 s, `src/replayTail.ts`) old. Undelayed LIVEHUD stays caster-only and never enters the DB while a half is live.
- Expected events are priced in: at half start (progress 0, full health, tank not spawned) the half predictor returns exactly the distribution the half-end line used for that half. A tank spawning on its own must not move the number by more than 3 points (test-pinned).
- At half end the current-half histogram collapses to the actual score.
- Settings `win_chance_form` and `win_chance_live`, both bool, default off. Admins see the new numbers while off (preview). The owner flips them.
- Backtest gate: half-end Brier must beat 0.163 (Part A). Mid-half points must beat the frozen half-end baseline. No reliability bin with n >= 30 may be off by more than 5 points. Report the numbers to the owner either way.
- Comeback line and biggest swing use mid-half points only when `win_chance_live` is on.
- No em dashes anywhere (code, comments, commits, copy).
- Shared checkout: commit only the files you touched, by path. Never `git commit -a`.

## Review Focus

- **Paused halves.** RoundMs keeps running during a pause, but `unpausedFrames` drops paused replay frames. A snapshot timeline must use the same clock as the feeds, or progress gets attached to the wrong frame. Pinned in Task 1.
- **A half restarted mid-way** (`resetReach` exists because halves get replayed). Live snapshots from the abandoned attempt must not leak into the new one. Pinned in Task 7.
- **No LIVEHUD or no live replay** (a box without the push, a web restart mid-half). The line must fall back to the half-end behaviour, not show a stale or zero number. Pinned in Task 7.
- **Unknown progress** (`prog = -1`, a custom map with bad nav). Treat it as missing and use the last known value, never as 0%. Pinned in Task 1.
- **A map with no history at all** (a new custom campaign). The predictor must fall back to the pooled shape, same as `buildWinModel`. Pinned in Task 5.

---

### Task 1: Half snapshots from a replay plus feeds

**Files:**
- Create: `src/winLive/snapshot.ts`
- Test: `tests/winLive/snapshot.test.ts`

**Interfaces:**
- Produces:
  - `type TankState = 'pending' | 'alive' | 'dead'`
  - `interface Snapshot { tMs: number; prog: number | null; alive: number; down: number; health: number; tank: TankState; tankHealthFrac: number | null; tankFlowGap: number | null }`. `health` is the sum over alive, non-incapped survivors of `health + temp`, capped at 100 each. `down` counts incapped or ledged survivors. `tankFlowGap` = tank flow % minus `prog`, while pending.
  - `progressTimeline(points: { tMs: number; prog: number }[]): (tMs: number) => number | null`. Furthest-so-far (monotone max), linear interpolation between samples, null before the first sample. Points with prog outside 0..100 are dropped.
  - `snapshotAt(frame: Frame, prog: number | null, tankFlow: number | null): Snapshot`
  - `halfSnapshots(rr: RoundReplay, prog: (tMs: number) => number | null, tankFlow: number | null, everyMs = 5000): Snapshot[]`
  - `feedProgressPoints(db: DB, key: RoundKey): { tMs: number; prog: number }[]`. Sources: `match_si_lives` (`spawn_ms`, `spawn_prog`), `match_survivor_downs` (`t_ms`, `prog`), and `match_round_feeds.end_prog` stamped at the half's last frame time (caller passes it, or omit).

- [ ] **Step 1: Write failing tests**
  - `progressTimeline` returns the max-so-far: points (0,0),(10000,30),(20000,20),(30000,50) give 25 at 15000 and 30 at 20000.
  - Points with prog -1 or 101 are ignored.
  - `snapshotAt` on a frame with one dead survivor, one incapped, two standing at 60+20 and 100+0 gives `alive 3, down 1, health 180`.
  - Tank state: a player with `cls === 5` and ALIVE, or an entity of kind `ENTITY_KIND.TANK_AI`, makes the state 'alive' with `tankHealthFrac = health / spawnHealth`. Spawn health is the max health seen for that tank so far. Before any tank it is 'pending'. After a seen tank disappears it is 'dead'.
  - Pause clock: a fixture with a 20 s pause (frames dropped by `unpausedFrames`) still pairs a feed sample at RoundMs 40000 with the frame whose `tMs` is 40000, not with the 40th second of play.
- [ ] **Step 2:** Run `npx vitest run tests/winLive/snapshot.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3:** Implement `src/winLive/snapshot.ts`. Feed `t_ms`/`spawn_ms` and replay `tMs` are both the plugin's `RoundMs()` (ms since the half went live, `plugin/pug-match.sp:866`), so no offset is needed. Pair by `tMs`, never by frame index.
- [ ] **Step 4:** Run the test. Expect PASS.
- [ ] **Step 5:** Commit `src/winLive/snapshot.ts tests/winLive/snapshot.test.ts`.

### Task 2: Position-to-progress lookup for halves without feeds

**Files:**
- Create: `src/winLive/progressMap.ts`
- Test: `tests/winLive/progressMap.test.ts`

**Interfaces:**
- Consumes: Task 1 `Snapshot`, `progressTimeline`.
- Produces:
  - `interface ProgressMap { map: string; cells: Record<string, number> }` (JSON-serialisable). Key `"${ix},${iy},${iz}"` on a 128-unit grid, value = median progress of the furthest survivor seen in that cell.
  - `buildProgressMap(map: string, samples: { x: number; y: number; z: number; prog: number }[]): ProgressMap`
  - `progressAt(pm: ProgressMap, x: number, y: number, z: number): number | null`. Exact cell, else the nearest filled cell within 3 cells, else null.
  - `furthestProg(pm: ProgressMap, frame: Frame): number | null`. Max over alive survivors.

- [ ] **Step 1: Write failing tests:** two samples in one cell with prog 10 and 30 give 20. A query two cells away from the only filled cell returns its value. A query five cells away returns null.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit.

### Task 3: Dataset builder script

**Files:**
- Create: `scripts/win-dataset.ts`
- Test: none (I/O script). Verified by its printed summary.

**Interfaces:**
- Consumes: Tasks 1-2, `r2FromEnv`/`getRange` (`src/r2.ts`), `decodeRoundReplay` (`src/metrics/replayRound.ts`), `trainingHalves`-style filter (completed unvoided PUG, `reliable = 1`).
- Produces: `data/win-dataset/halves.jsonl`, one line per half: `{ matchId, ordinal, half, map, survTeam, score, made, endedAt, progSource: 'feeds' | 'map' | 'none', snaps: Snapshot[] }`. Also `data/win-dataset/progress-maps.json` (`ProgressMap[]`). Both gitignored (check `.gitignore` covers `data/`).

- [ ] **Step 1:** Write the script: `tsx scripts/win-dataset.ts --db <copy of prod pug.db> [--limit N] [--resume]`. It caches each fetched replay under `data/win-dataset/rpl/` so a rerun does not hit R2 again. It refuses to run against `data/pug.db` without `--db`.
- [ ] **Step 2:** Pass 1, halves with feeds: build `progress-maps.json` from survivor positions paired with feed progress. Hold out 20% of those halves and print the median absolute error of `furthestProg` against the feed timeline.
- [ ] **Step 3:** Pass 2: write every half. Feed halves use `progSource 'feeds'`. Others use the progress map when its holdout median error is 8 points or less for that map, else `'none'`.
- [ ] **Step 4:** Copy the prod DB read-only (`ssh root@45.32.199.85` then `sqlite3 -readonly ... ".backup /tmp/x.db"`, scp to `data/win-dataset/pug-<date>.db`) and run. Expected summary: about 5,400 halves, about 1,600 from feeds, counts per `progSource`, the progress-map error per map.
- [ ] **Step 5:** Commit the script only.

### Task 4: Part A, team form

**Files:**
- Create: `src/winForm.ts`, `src/winForm.fitted.json`
- Modify: `src/winProb.ts` (`winChance`, `winLineFrom`, `liveWinLine`, `matchWinLine` take an optional `form` option)
- Create: `scripts/win-backtest.ts` (shared by Task 6)
- Test: `tests/winForm.test.ts`, extend `tests/winProb.test.ts`

**Interfaces:**
- Consumes: `WinModel.dist(map)`.
- Produces:
  - `interface FormParams { survivor: number; infected: number; siDamage: number; shrink: number; calibration: number }` (loaded from `src/winForm.fitted.json`).
  - `halfPercentile(model: WinModel, map: string, score: number): number`: the mid-rank CDF of `score` in `dist(map)`, in 0..1.
  - `teamForm(model, played: PlayedHalf[], siDmg?: Map<string, number>): { a: number; b: number }`: the log-odds tilt for each team's future survivor halves. Survivor form = mean logit of own percentiles. Infected form = minus the mean logit of the opponent's percentiles (plus the SI damage term when present). Each is shrunk by `n / (n + shrink)` with n = halves played on that side.
  - `tilt(dist: Float64Array, theta: number): Float64Array`: exponential tilt over bin index scaled by the map's spread, renormalised. `theta = 0` returns the same array values.
  - `winChance(model, gap, mapsA, mapsB, opts?: { tiltA?: number; tiltB?: number; calibration?: number })`
- [ ] **Step 1: Failing tests:**
  - `tilt(d, 0)` equals `d`.
  - A positive tilt raises the mean, and the result sums to 1.
  - With no halves played, `teamForm` is `{0,0}`, so the opening point is unchanged from today.
  - A team with two 90th-percentile survivor halves gets a positive tilt. Its chance with the same gap and maps is higher than without form.
  - Antisymmetry is kept: swapping the teams mirrors the chance.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. `teamForm` tilts team A's future survivor halves by `survivor * formA_surv - infected * formB_inf`, and the same for B.
- [ ] **Step 4:** Write `scripts/win-backtest.ts --db <copy> --part form`. Use the time split from 10-10: train on the oldest 70% of completed PUGs, test on the newest 30%. Fit `FormParams` by maximum likelihood on train with a coarse grid then coordinate descent. It prints Brier, the reliability table (10 bins with n) and log loss for: today's model, form without SI damage, form with SI damage (only halves that have feeds). It writes the winner to `src/winForm.fitted.json`. SI damage stays in only if it lowers held-out Brier.
- [ ] **Step 5:** Run it on the Task 3 DB copy. Paste the table into the commit message. If form does not beat 0.163, stop and report to the owner instead of continuing Part A.
- [ ] **Step 6:** Gate it behind `win_chance_form`. Add it to `src/settingsSchema.ts` (group Stats, bool, default off). Callers pass form only when the setting is on, or when the viewer is an admin.
- [ ] **Step 7:** Run `npm test` and `npm run typecheck`. Expect PASS. Commit.

### Task 5: Part B, half predictor

**Files:**
- Create: `src/winLive/halfModel.ts`, `src/winLive/halfModel.fitted.json`
- Test: `tests/winLive/halfModel.test.ts`

**Interfaces:**
- Consumes: Task 1 `Snapshot`, `WinModel`, Task 4 `tilt`.
- Produces:
  - `interface HalfModelParams` (JSON).
  - `predictHalf(model: WinModel, params: HalfModelParams, map: string, theta: number, snap: Snapshot | null): Float64Array`: the final-score histogram in `winProb` bins.
- Model (my call, swappable if the backtest says otherwise): the final score is in units of the map's typical made score (`scale` from `buildWinModel`). Predict it as a mixture over 3 outcomes (made with all alive, made with fewer, wiped), with a multinomial logistic on snapshot features. Within each outcome, use the empirical normalised-score shape conditioned on `prog` (the score cannot drop below what the distance already guarantees for a wipe, so it is floored at the wipe score implied by `prog`). The base-rate intercepts are per map, shrunk toward the pool like `buildWinModel`.
- [ ] **Step 1: Failing tests:**
  - `predictHalf(..., null)` equals `tilt(model.dist(map), theta)` exactly.
  - At-start snapshot `{prog 0, alive 4, down 0, health 400, tank 'pending'}` is within total variation 0.02 of the null case.
  - A snapshot that changes only `tank` from 'pending' to 'alive' (tankHealthFrac 1, same health and prog) moves the team's single-half win chance (via `winChance` with that half alone) by under 3 points.
  - Lower health, all else equal, gives a lower mean. More progress gives a higher mean.
  - `alive 0` gives a point mass at the wipe score for `prog` (within one bin).
  - An unknown map uses the pooled shape and does not throw.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement `predictHalf`, and fitting in `scripts/win-backtest.ts --part live`. Only snapshots with `prog !== null` train the progress terms. Halves with `progSource 'none'` still train the health, alive and tank terms with progress marginalised.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit.

### Task 6: Part B backtest and gate

**Files:**
- Modify: `scripts/win-backtest.ts`

- [ ] **Step 1:** Add `--part live`. Use time-ordered 5-fold validation over matches that have progress (feeds or map), each fold tested on later matches than it trained on. Score the match win chance at five points in each test half: 25%, 50%, 75% of the half's duration, 10 s after tank spawn, and 10 s after tank death. Baseline: the half-end line frozen at the previous half end (with form when Task 4 shipped).
- [ ] **Step 2:** Print Brier per point type for both models, a reliability table with n per bin, and the share of halves where the tank spawn alone moved the number by more than 3 points (must be under 5%).
- [ ] **Step 3:** Run it. If it beats the baseline at every point type and no bin with n >= 30 is off by more than 5 points, write `halfModel.fitted.json`. Otherwise stop, report the table to the owner, and do not do Tasks 7-9.
- [ ] **Step 4:** Commit the script and the fitted JSON, with the tables in the commit message.

### Task 7: Live wiring

**Files:**
- Create: `src/winLive/liveState.ts`
- Modify: `src/winProb.ts` (`WinPoint` and `liveWinLine`), `src/cast/liveHud.ts` (keep a timestamped ring of LIVEHUD lines per token and half), `src/server.ts:1376` area (record into the ring), `src/liveView.ts:119`, `src/cast/matchView.ts:252`, `src/settingsSchema.ts`, `src/db.ts`
- Test: `tests/winLive/liveState.test.ts`, extend `tests/winProb.test.ts`

**Interfaces:**
- Produces:
  - `WinPoint` gains optional `tMs?: number` (ms into the half) and `moment?: 'tank_spawn' | 'tank_death' | 'wipe' | 'saferoom'`. Half-end points leave them unset.
  - `LiveHudStore.history(token, ordinal, half): { at: number; prog: number; tank: number }[]`. Kept in memory and cleared by `resetReach`.
  - `liveSnapshot(db, matchId, nowMs, delayMs): { ordinal: number; half: number; snap: Snapshot; tankFlow: number | null } | null`. It reads the newest released frame of the live replay (`currentFileFor` + `releasableFrames`) and the newest LIVEHUD sample with `at <= nowMs - delayMs`. Pass `delayMs = 0` for the caster overlay. Null when either is missing, or when the half attempt is not the current one.
  - `liveWinLine(db, matchId, campaign, model?, opts?: { live?: boolean; form?: boolean; nowMs?: number; delayMs?: number })` appends in-half points, at most one per 5 s, held in a per-match memory list. It also marks moments on the transitions between snapshots.
  - Table `match_progress_samples(match_id, ordinal, half, t_ms, prog, tank, PRIMARY KEY(match_id, ordinal, half, t_ms))`, written from the ring every 10 s of half time at half end only (the round-end handler in `src/server.ts`).
  - Setting `win_chance_live` (bool, default off).
- [ ] **Step 1: Failing tests:**
  - With the delay at 10 s, a LIVEHUD sample 4 s old is not used and the 12 s old one is.
  - No LIVEHUD at all gives no in-half point, and the line equals today's.
  - `resetReach` empties the history, so a restarted half starts clean.
  - `prog -1` samples fall back to the previous sample.
  - The progress samples are written at half end and none are written while the half is live.
  - A tank pending to alive transition makes a `moment: 'tank_spawn'` point.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. Public callers (`liveView`) pass `live: setting || isAdmin` and `delayMs: DEFAULT_DELAY_MS`. The caster `matchView` passes `delayMs: 0` behind its existing gate.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expect PASS.
- [ ] **Step 5:** Commit.

### Task 8: Finished matches: stored in-round lines

**Files:**
- Create: `src/winLive/finishedLine.ts`, `scripts/win-backfill.ts`
- Modify: `src/winProb.ts` (`matchWinLine` merges stored points), `src/db.ts` (table), the match-end path that already runs replay offload or metrics (call after the replay reaches R2 or local disk)
- Test: `tests/winLive/finishedLine.test.ts`

**Interfaces:**
- Table `match_win_points(match_id, ordinal, half, t_ms, p_a, moment, model_version, PRIMARY KEY(match_id, ordinal, half, t_ms))`.
- `computeFinishedPoints(db, matchId, loadReplay: (key) => RoundReplay | null): number`. It computes from the replay, feeds (or `match_progress_samples`, or a progress map) and the fitted models, writes the rows, and returns the count.
- `matchWinLine` interleaves the stored points between half-end points when `win_chance_live` is on (or for an admin). With no rows, it keeps today's line.
- [ ] **Step 1: Failing tests:** stored points are interleaved in order. Half-end points are unchanged. A stale `model_version` row is ignored. No rows gives exactly today's line.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement, plus `scripts/win-backfill.ts --db <path> [--commit]` (dry run by default, R2 fetch like `src/metrics/r2Recompute.ts`).
- [ ] **Step 4:** Run tests. Expect PASS. Commit.

### Task 9: Display, comeback line and biggest swing

**Files:**
- Modify: `web/src/components/WinChart.tsx`, `web/src/routes/Live.tsx`, `web/src/routes/MatchDetail.tsx`, `web/src/api.ts` (types), `src/winProb.ts` (`turning`/`winnerLow` over all points), `src/discord/sync.ts:643` and its presenter
- Test: `web/src/routes/routes.test.tsx`, `tests/winProb.test.ts`, the existing discord presenter test

- [ ] **Step 1: Failing tests:**
  - WinChart draws the in-half points between half markers, with an icon per `moment`.
  - The Live page bar updates from the in-half point.
  - The biggest swing names the moment: `"Tank on map 3: 68% to 31%"`. Pre-existing copy is unchanged when there are no in-half points.
  - The comeback line uses the in-half low only when `win_chance_live` is on.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. The Live page polls the way it does today. No new websocket channel.
- [ ] **Step 4:** Run `npm test`, `npm run typecheck`, `npm run build`. Expect PASS.
- [ ] **Step 5:** Commit.

### Task 10: Ship dark and report

- [ ] **Step 1:** Run `deploy-web.sh` (flock, curl pages after, per deploy rules). Both settings stay off.
- [ ] **Step 2:** Run `scripts/win-backfill.ts --commit` on the box for matches since 628. Check that a sample match page as admin shows in-round points.
- [ ] **Step 3:** Watch one live PUG as admin on /live. The number moves about every 5 s, sits 10 s behind the stream, and the tank spawn moves it under 3 points.
- [ ] **Step 4:** Report the backtest tables and screenshots to the owner, and ask them to flip `win_chance_form` and `win_chance_live`.
- [ ] **Step 5:** Update memory `pug-win-chance.md` with the commits, deploy time and backtest numbers.
