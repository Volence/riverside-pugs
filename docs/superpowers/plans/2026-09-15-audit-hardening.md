# Audit Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the failure modes seen on 2026-09-13/14 (matches 15 to 18) impossible or honest: rounds never silently dropped, late joiners rostered, failed reads stored as unknown rather than zero, and every page saying "not recorded" instead of a fake 0.

**Architecture:** Part A is one SourceMod plugin change (`plugin/pug-match.sp`, `plugin/pug-stats.inc`), built with `plugin/build.sh` and staged with `plugin/stage.sh` on an empty server (a reload wipes match state; re-assert `sm_pug_auto_track 1` after). Part B is backend (`src/`) plus Preact site (`web/src/`), tested with `npx vitest run`, typechecked with `npm run typecheck`, deployed with `./deploy-web.sh`. Parts are independent; B never depends on A being staged, but B's parsers must accept A's new wire lines.

**Tech Stack:** SourcePawn 1.12 (left4dhooks), Node 22 + Fastify + better-sqlite3, Preact, vitest.

**Spec:** the audit findings in the 2026-09-14/15 session, recorded in memory `l4d1-pug-mix-testing-mode` and this file's task rationales. No separate spec document.

## Global Constraints

- No em dashes anywhere (code, comments, commits, copy).
- Wire grammar lives in `src/logParse.ts`; every new key or line the plugin emits gets a parser case and a test in `tests/logParse.test.ts`. Unknown keys are ignored by design, so a typo is silent: test both directions.
- Stat keys resolve through `src/statKeys.ts`; event kinds through `src/eventKinds.ts` (parity test `tests/eventKindsParity.test.ts` holds the plugin to it).
- `EmitPug` buffer is 768 bytes and `LogToGame` truncates silently; never build one line longer than that. Never pass a runtime-built string as a format (use `"%s"`).
- Live UDP data is cosmetic; the rcon dump (`sm_pug_dump`) is authoritative. Nothing in Part B may change a stored result from live data.
- Existing data is NOT migrated or edited. Every fix is forward-only.

---

## Part A: plugin

### Task A1: never drop a round score (logical-team mapping fallback)

**Rationale:** `ObserveSurvivorPugTeam()` returns 0 on a tie or when no rostered survivor is seen, and `AttributeScore` then logs "unattributable" and discards the score (match 18 lost 1244 and 726). The engine's logical team index (1 or 2, what `L4D_GetTeamScore` is keyed by) is stable for the whole match, so once any round's vote is decisive the plugin knows which logical team is pug A and can use that forever.

**Files:**
- Modify: `plugin/pug-match.sp` (`ObserveSurvivorPugTeam`, `AttributeScore`, `TryReadRoundScore`, `ResetMatchState`, `sm_pug_status`)

- [ ] **Step 1:** Add `int g_iLogicalOfPugA = 0;` next to `g_iRound1Logical` (0 = unknown, else 1|2). Reset it in `ResetMatchState()` only (it must survive `OnMapStart`).
- [ ] **Step 2:** In `TryReadRoundScore`, keep the resolved `survLogical` in a new global `g_iLastSurvLogical` (set on every successful read, both halves).
- [ ] **Step 3:** In `AttributeScore(survPug, score, second)`: after the existing half-2 inversion fallback, add: if `survPug != 0 && g_iLastSurvLogical != 0` then learn `g_iLogicalOfPugA = (survPug == 1) ? g_iLastSurvLogical : 3 - g_iLastSurvLogical`. If `survPug == 0 && g_iLogicalOfPugA != 0 && g_iLastSurvLogical != 0` then `survPug = (g_iLastSurvLogical == g_iLogicalOfPugA) ? 1 : 2` and `LogError("[pug] round score %d attributed to pug team %s by logical-team mapping (vote tied or empty)", ...)`. Only if all fallbacks fail keep the existing "unattributable" LogError.
- [ ] **Step 4:** Print `logicalOfA=%d` on the `STATUS orient` line of `sm_pug_status`.
- [ ] **Step 5:** Build (`plugin/build.sh`), fix compile errors, commit: `fix(plugin): attribute tied or unobserved rounds by the learned logical-team mapping`.

### Task A2: roster late joiners and subs at go-live

**Rationale:** mayhem played all four maps of match 18 unrostered: no stats, no rating, and his pins went out with `target=0`, which is what let a clear pair with a stale pin (the 71.8 second clear). Subs (Heart and Soul, Don Lockwood) likewise.

**Files:**
- Modify: `plugin/pug-match.sp` (`MAX_ROSTER`, `SnapshotRoster`, new `RosterLateJoiners`, `OnRoundIsLive`, `EmitRosterBurst`, dump roster line)
- Modify: `src/logParse.ts`, `src/selfStarted.ts`, `src/server.ts` (accept a MATCH_ROSTER for an already-adopted match), `src/dumpParse.ts`, `src/matchResult.ts`, `src/rating.ts`
- Test: `tests/logParse.test.ts`, `tests/selfStarted.test.ts` (or nearest existing), `tests/rating.test.ts`

- [ ] **Step 1:** `#define MAX_ROSTER 12`. Grep every `8` that means the roster cap (`onTeams > MAX_ROSTER` already uses the define; check `g_iSkill[MAX_ROSTER]` sizes in `pug-stats.inc`, replay header slot table: `replayFormat` header has 8 slots, so the REPLAY roster stays 8: cap `g_iClientRoster` slots written to the replay at 8 and document that slots 8..11 are not drawn).
- [ ] **Step 2:** Add `int g_iRosterJoinedMap[MAX_ROSTER];` set to `g_iMapCount` when a slot is filled (0 for the original roster).
- [ ] **Step 3:** New `int RosterLateJoiners()`: for each human in game on SURVIVOR or INFECTED with `g_iClientRoster[c] == -1` and roster not full: side = the pug team with the majority of rostered players currently on that game team (`OrientationVote`-style count); if the majority is empty fall back to `g_iPugSide` mapping; add the slot exactly as `SnapshotRoster` does, set `g_iRosterJoinedMap`, `EmitPug("MATCH_ROSTER steamid=%s team=%s name=%s joined_map=%d", ...)`, `PrintToChatAll("[PUG] %N joined team %s", ...)`. Return how many were added.
- [ ] **Step 4:** Call `RosterLateJoiners()` in `OnRoundIsLive` when `g_State == MS_Live` (after the existing pending-to-live block).
- [ ] **Step 5:** Dump: the `ROSTER` line (line ~1756 and ~3088) gains `joined_map=%d`.
- [ ] **Step 6:** Backend: `logParse.ts` MATCH_ROSTER parses optional `joined_map` (default 0). `selfStarted.ts`: a `match_roster` for a token that is already committed (match exists in DB with that token and state live) inserts the player (`players` upsert as roster-created, status invited) and a `match_players` row, ignoring duplicates. `dumpParse.ts` reads `joined_map` on roster lines.
- [ ] **Step 7:** Rating rule: `applyMatchRatings` skips players whose `joined_map` is greater than half the maps played (store `joined_map INTEGER NOT NULL DEFAULT 0` on `match_players` via a migration in `src/db.ts`; `completeMatch` writes it from the dump). A skipped player keeps stats and appears on the match page but gets no `rating_history` row. Test: 4 maps, joined_map 3 skipped, joined_map 1 rated.
- [ ] **Step 8:** Tests for the parser and the rating rule; build the plugin; commit `feat(plugin,backend): roster late joiners at go-live; subs who played under half the maps are not rated`.

### Task A3: warn when the roster disagrees with the sides

**Files:** `plugin/pug-match.sp` (`Timer_TeamLock` vote section)

- [ ] **Step 1:** Add `int g_iRosterMismatchHalves[MAXPLAYERS + 1]` and `bool g_bMismatchWarned`. In `OnRoundIsLive` for a live match: for each rostered client on a side, if their game team != `g_iPugSide[g_iRosterTeam[slot]]` increment their counter, else zero it. If any counter reaches 2 and `!g_bMismatchWarned`: `PrintToChatAll("[PUG] %N is on the other team from the recorded roster. Scores are credited by where people actually play; stats and ratings follow the roster.")`, `LogError` the same, set the flag. Reset in `ResetMatchState`.
- [ ] **Step 2:** Build, commit `feat(plugin): warn once when a rostered player plays two halves on the other side`.

### Task A4: report failed score reads honestly

**Rationale:** the retry-exhausted path in `Timer_ReadScore` emits `ROUND_END ... score=<accumulated>` which is 0, and the backend stores it reliable. It should almost never fire (the 16/17 case was the half-live-flag bug, fixed), but when it does the site must say "not recorded".

**Files:** `plugin/pug-match.sp` (`Timer_ReadScore`), `src/logParse.ts`, `src/liveView.ts` (`recordRoundEnd`), tests.

- [ ] **Step 1:** Plugin: on retry exhaustion emit `EmitRoundEnd(half, survEnd, -1)` (let `EmitRoundEnd` print `score=-1`) and `LogError` as today.
- [ ] **Step 2:** Backend: `logParse` accepts `score=-1`; `recordRoundEnd` stores `score = 0, reliable = 0` when the score is negative. `recordMapResult` unchanged.
- [ ] **Step 3:** Tests: parser round trip; `recordRoundEnd` with -1 leaves `reliable = 0`. Commit `fix: a failed score read is stored unreliable, never as 0`.

### Task A5: no post-match demo

**Files:** `plugin/pug-match.sp` (`OnMapStart`, `EndMatchNow`)

- [ ] **Step 1:** In `OnMapStart`, move the finale check (`L4D_IsMissionFinalMap(true)`) ABOVE `StartMatchDemo()`, next to the campaign-change check, so a match that ends on this map load never opens a demo under its token.
- [ ] **Step 2:** In `EndMatchNow`, if a match demo is recording, `ServerCommand("tv_stoprecord")` (check `StartMatchDemo` for the flag it sets and clear it).
- [ ] **Step 3:** Build, commit `fix(plugin): end the match before opening a demo for the post-finale map`.

### Task A6: per-map skill stats

**Rationale:** the per-map tables show n/a for every skill_detect column because the LIVESTAT line carries a curated subset and the 26-key SKILL set only exists in the dump. `recordMapResult` snapshots `match_live_players` at map end, so the plugin only has to get the full set into that table before MAP_RESULT.

**Files:** `plugin/pug-match.sp` (`FinalizeMap`), `plugin/pug-stats.inc` (new `EmitSkillLive`), `src/liveView.ts` (`recordLiveStat` merges), tests.

- [ ] **Step 1:** `pug-stats.inc`: `void EmitSkillLive()` that, for each roster slot, emits ONE OR MORE `LIVESTAT steamid=%s <key=value ...>` lines, adding keys until the line would pass 600 bytes and then starting a new line, using the same `StatNeedsSkillDetect` gate as `WriteSkillLines`.
- [ ] **Step 2:** Call `EmitSkillLive()` in `FinalizeMap()` before `EmitPug("MAP_RESULT ...")`.
- [ ] **Step 3:** Backend `recordLiveStat`: MERGE into the existing `stats_json` (`{...existing, ...safe}`) instead of replacing, so split lines accumulate. Test: two LIVESTAT lines for one player yield the union.
- [ ] **Step 4:** Build, commit `feat: full skill stat set per map via end-of-map LIVESTAT lines`.

### Task A7: stage

- [ ] Build once more, run `npx vitest run`, then with the server EMPTY: `plugin/stage.sh`, then rcon `sm_pug_auto_track 1; sm_pug_roster_at_live 1; sm_pug_status`. Record the staging in memory.

---

## Part B: backend and site

### Task B1: "Not recorded" wherever a round is unreliable

**Files:** `web/src/routes/MatchDetail.tsx` (map chips ~line 267 to 285, map header), `src/routes/api.ts` (campaign and map aggregates), `web/src/routes/Campaigns.tsx`, `web/src/routes/MapDetail.tsx` (or the map page file), tests in `web/src/routes/routes.test.tsx` and `tests/`.

- [ ] **Step 1:** API: `/api/matches/:id` maps gain `recorded: boolean` = every round of that ordinal has `reliable = 1` AND at least one round row exists. A map with no round rows at all (pre round-capture matches) is `recorded: true` (legacy, scores came from MAP_RESULT).
- [ ] **Step 2:** Match page: a map with `recorded: false` shows `not recorded` (muted) in the chip and header instead of `0 - 0`.
- [ ] **Step 3:** Campaign averages (`/api/maps`, `/api/maps/:map`): exclude maps whose rounds are all unreliable; the map page's "Avg score" says `not recorded` when nothing qualifies, and win rate columns exclude those maps (no W, no L).
- [ ] **Step 4:** Tests with a fixture match whose ordinal 0 rounds are `reliable = 0`. Commit `feat(site): unreliable maps read "not recorded" everywhere instead of 0 to 0`.

### Task B2: uncaptured players show dashes

**Files:** `web/src/components/StatTable.tsx`, `web/src/routes/MatchDetail.tsx` (row building ~line 118 to 177), tests.

- [ ] **Step 1:** A `StatRow` gains optional `captured: boolean`. The match page sets it false when the roster row's `stats_json` is `{}` and the player has no `match_player_stats`.
- [ ] **Step 2:** `StatTable`: an uncaptured row renders every cell as `–` with class `is-dim`, is excluded from `markColumn` inputs (pass `undefined` for its values) and from team totals. Add a title attribute "stats were not captured for this player".
- [ ] **Step 3:** Test: a fixture with one uncaptured player shows dashes and no `is-worst` on it. Commit `fix(site): players whose stats were never captured show dashes, not worst-in-team zeros`.

### Task B3: leaderboard minimum games and header figure

**Files:** `src/routes/stats.ts` (leaderboard query ~line 59), `web/src/routes/Leaderboard.tsx`, tests.

- [ ] **Step 1:** API adds `ranked: boolean` (`games >= 3`) per row and a top-level `matchesRated` = `COUNT(DISTINCT match_id) FROM rating_history WHERE season_id = ?`.
- [ ] **Step 2:** Leaderboard: ranked rows first with rank numbers; unranked rows after, greyed, rank cell `–`, an eyebrow "Provisional, under 3 games" heading the group. "Matches rated" figure reads `matchesRated`. Top-rated card considers ranked rows only.
- [ ] **Step 3:** Tests. Commit `feat(leaderboard): players under three games are provisional; rated-match count is real`.

### Task B4: hide demos for maps not in the match

**Files:** `src/routes/api.ts` (demos in `/api/matches/:id`), tests.

- [ ] **Step 1:** Filter `match_demos` rows to ordinals present in `match_maps` for completed matches (a live match keeps all).
- [ ] **Step 2:** Test. Commit `fix(api): a completed match lists demos only for its maps`.

### Task B5: phone layout

**Files:** `web/src/styles/app.css`, `web/src/routes/Leaderboard.tsx`, `web/src/routes/MatchDetail.tsx` (demo rows).

- [ ] **Step 1:** Leaderboard table: rank, player and SR cells get `position: sticky` with cumulative `left` offsets and the table background, so they stay while the stats scroll. At widths under 480px hide the W, L and Win % columns (`.lb__wl { display: none }`).
- [ ] **Step 2:** `.demos__row`: `display: flex; flex-wrap: wrap; gap` with `min-width: 0` on the name and `white-space: nowrap` on the size and link so nothing pokes past the container.
- [ ] **Step 3:** Verify with `scripts/shoot-pages.mjs` at 390 (no HORIZONTAL OVERFLOW line for match pages). Commit `fix(site): sticky identity columns on the leaderboard; demo rows fit a phone`.

### Task B6: replay sessions page labels

**Files:** `web/src/routes/Replays.tsx`, `src/routes/replays.ts` (`/api/replays/sessions`).

- [ ] **Step 1:** Each session card is titled by the campaign of its first map (via `src/campaigns.ts`) and the date; the token moves to a small muted line. A session that belongs to a match links to the match instead.
- [ ] **Step 2:** Commit `feat(site): replay sessions are named by campaign and date`.

### Task B7: pin pairing that cannot invent a 71.8 second clear

**Files:** `web/src/eventEnrich.ts`, `web/src/eventEnrich.test.ts`.

- [ ] **Step 1:** A `pinned` with no target opens nothing (already the case) AND a `cleared` whose target has no open pin gains no `from`.
- [ ] **Step 2:** An `incap` of the victim closes their open pin (outcome `died` becomes `ended`; text "until X went down"). A `si_spawn` or `death`-as-target of the PINNER (the pinner respawning or being killed) closes every pin they hold with outcome `ended`.
- [ ] **Step 3:** `MAX_PIN_MS = 30000`: a clear more than 30 s after the pin opened gets no `from` and the pin gets no duration (unknown). Tests for each rule, including the match 18 shape: pin at t, victim incapped, later clear at t + 71.8 s produces no "after" text.
- [ ] **Step 4:** Commit `fix(site): pins close on incap and pinner respawn and never pair across 30 seconds`.

### Task B8: deploy

- [ ] `npx vitest run`, `npm run typecheck`, `npm run shoot` sanity, `./deploy-web.sh`. Record in memory.
