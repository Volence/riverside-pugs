# Health-run scoring, stage 1 (shadow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute the hr1 scoring rule in the background of every match, show it to players on request, store it on the site and show it to admins, without changing any real score.

**Architecture:** l4dscores (deploy repo) owns the live computation in a new include and exposes it through one native plus two chat commands. pug-match (pug repo) reads the native at round end and sends it to the site over UDP and again in the match dump. The site stores one row per half, recomputes from raw components in a pure module, and serves an admin page.

**Tech Stack:** SourcePawn (SourceMod 1.12, left4dhooks), TypeScript + Fastify + better-sqlite3, Preact, vitest.

**Spec:** `/home/volence/l4d/pug/.claude/worktrees/alt-scoring/docs/superpowers/specs/2026-11-18-health-run-scoring-design.md` (read "The rule (hr1)" and "Design, stage 1" before any task).

## Global Constraints

- Nothing in this plan may change a real score, winner, SR, `!health`, `!scores`, `!gg`, win chance, or any existing route or table. With `l4d_score_alt 0`, or with the old l4dscores, every existing behaviour is byte-for-byte as today.
- No deploys, no rcon to live boxes, no `stage.sh`, no `deploy.sh`, no `deploy-web.sh`. Work only in the two worktrees below. Commit there with `git add <paths>` (never `-a`), never touch `master`.
  - pug: `/home/volence/l4d/pug/.claude/worktrees/alt-scoring`, branch `alt-scoring`
  - deploy: `/home/volence/l4d/deploy-altscore`, branch `feature/altscore`
- Rule constants, verbatim from the spec: pools walking 700, tank 300, door 500; weights pills 0.25, revives 0.25; solid max 100, pill store 50, rule id `hr1`; default `walkMult` 1.00; sampling 0.5 s.
- Raw components are always unweighted and unmultiplied, in this order: `ws wt wr ts tt tr ds dt dr` (walking / tank / door, each solid / temp+pills / revive).
- Each of walk, tank, door is rounded to the nearest integer after its multiplier; total = their sum.
- No em dashes in any text a person reads (chat lines, page copy, comments, docs).
- Tests and scripts run under `timeout` and `ulimit -v 12000000`. Agents do not spawn sub-agents or background tasks.
- Author name in any byline or version note: Malevolence.

## Review Focus

1. A match where UDP drops `ALT_ROUND` lines: the dump's `ALT` lines must fill every gap and replace UDP rows (Task 3 test).
2. A dump or UDP stream from the current plugin with no ALT data at all: nothing fails, nothing is stored, the admin page says there is no data yet (Tasks 2, 3, 5 tests).
3. A `!gg` forfeit or abandon, where the last half never gets a row: listed as incomplete, excluded from the "different winner" count (Task 4 test).
4. An `ALT_ROUND` line near the 768-byte `EmitPug` limit, or with a field missing or non-numeric: parser rejects the whole line rather than storing a partial row (Task 2 test); Task 6 asserts the longest possible line is under 700 bytes.
5. A survivor body changing hands (bot takeover, player return) or the plugin loading mid-half: state follows the body, and a half that started before the plugin loaded reports nothing rather than a partial number (Task 7 rig checks).

---

### Task 1: The rule as a pure site module

**Files:**
- Create: `src/altScore.ts`
- Test: `tests/altScore.test.ts`

**Interfaces:**
- Produces:

```ts
export const ALT_RULE = 'hr1';
export interface AltWeights { pills: number; revives: number; walkPool: number; tankPool: number; doorPool: number; pillStore: number; reviveStore: number; teamSize: number }
export const HR1: AltWeights; // .25, .25, 700, 300, 500, 50, 60, 4
export interface AltRaw { ws: number; wt: number; wr: number; ts: number; tt: number; tr: number; ds: number; dt: number; dr: number }
export interface SurvivorState { state: 'up' | 'down' | 'hanging' | 'dead'; solid: number; temp: number; pillsHeld: boolean; reviveStore: number }
export function fullPoints(w?: AltWeights): number;                       // 100 + pillStore*pills + reviveStore*revives = 127.5
export function survivorPoints(s: SurvivorState, w?: AltWeights): number; // dead 0; down: solid counts 0
export interface AltParts { walk: number; tank: number; door: number; total: number }
export function halfParts(raw: AltRaw, walkMult: number, doorMult: number, w?: AltWeights): AltParts;
export interface AltHalf { ordinal: number; half: number; survTeam: 'a' | 'b'; raw: AltRaw; walkMult: number; doorMult: number }
export interface AltMatch { altA: number; altB: number; altWinner: 'a' | 'b' | 'draw'; complete: boolean; differs: boolean | null }
export function compareMatch(halves: AltHalf[], realHalfCount: number, realWinner: 'a' | 'b' | 'draw' | null, w?: AltWeights): AltMatch;
```

- `halfParts`: `walk = round(walkMult * (walkPool/teamSize) * (ws + pills*wt + revives*wr) / full)`, `tank = round(tankPool * (ts + pills*tt + revives*tr) / (teamSize*full))`, `door = round(doorMult * (doorPool/teamSize) * (ds + pills*dt + revives*dr) / full)`, `total = walk + tank + door`.
- `compareMatch`: `complete` is `halves.length === realHalfCount && realHalfCount > 0`; `differs` is null when not complete or `realWinner` is null.

- [ ] **Step 1: Write the failing tests** in `tests/altScore.test.ts`:
  - `fullPoints()` is 127.5.
  - `survivorPoints`: `{up,100,0,pillsHeld,60}` = 127.5; `{up,100,0,no pills,60}` = 115; `{up,50,50,no pills,60}` = 77.5; `{up,1,0,none,60}` = 16; `{up,1,30,none,30}` = 16 (the get-downed trick pays nothing); `{up,1,30,none,0}` = 8.5; `{up,1,0,none,0}` = 1; `{down,0,0,none,60}` = 15; dead = 0.
  - `halfParts` perfect half: raw `ws=400, wt=200, wr=240, ts=400, tt=200, tr=240, ds=400, dt=200, dr=240` with multipliers 1, 1 gives `{walk:700, tank:300, door:500, total:1500}`; with `walkMult 1.15, doorMult 1.75` gives `{805, 300, 875, 1980}`.
  - `halfParts` with all-zero raw is all zeros.
  - `halfParts` with a different weight set (`pills: 0.5`) changes the result and still gives 700/300/500 for the perfect raw (full points scale with the weights).
  - `compareMatch`: 8 halves, real count 8, alt totals favour b while real winner a gives `differs: true, complete: true`; 7 halves with real count 8 gives `complete: false, differs: null`; equal totals give `altWinner: 'draw'`.
- [ ] **Step 2:** Run `timeout 120 npx vitest run tests/altScore.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `src/altScore.ts` to the interface above. Pure functions, no imports from the rest of `src/`.
- [ ] **Step 4:** Run the same command. Expected: PASS. Run `timeout 300 npm run typecheck`. Expected: no errors.
- [ ] **Step 5:** Commit `src/altScore.ts tests/altScore.test.ts` with message `Alt scoring: hr1 rule as a pure module`.

### Task 2: Store `ALT_ROUND` lines from UDP

**Files:**
- Modify: `src/db.ts` (`SCHEMA`, add table), `src/logParse.ts` (new event), `src/liveView.ts` (new `recordAltRound` beside `recordRoundEnd`), `src/server.ts` (dispatch beside the `recordRoundEnd` call, about line 1607)
- Test: `tests/altRound.test.ts`, and one case added to `tests/logParse.test.ts`

**Interfaces:**
- Consumes: `AltRaw`, `ALT_RULE` from Task 1.
- Produces:
  - Table `match_round_alt`: `match_id INTEGER NOT NULL REFERENCES matches(id)`, `ordinal INTEGER NOT NULL`, `half INTEGER NOT NULL`, `rule TEXT NOT NULL`, `surv_team TEXT NOT NULL CHECK (surv_team IN ('a','b'))`, `walk INTEGER NOT NULL`, `tank INTEGER NOT NULL`, `door INTEGER NOT NULL`, `walk_mult REAL NOT NULL`, `door_mult REAL NOT NULL`, `ws wt wr ts tt tr ds dt dr REAL NOT NULL`, `tank_pct INTEGER` (null when unpaid), `tank_by TEXT CHECK (tank_by IN ('surv','other'))` (null when unpaid), `survivors_in INTEGER NOT NULL`, `source TEXT NOT NULL CHECK (source IN ('udp','dump'))`, `created_at TEXT NOT NULL DEFAULT (datetime('now'))`, `PRIMARY KEY (match_id, ordinal, half, rule)`.
  - Parsed event `{ kind: 'alt_round', token, map: string, half: 1|2, surv: 'a'|'b', rule: string, walk, tank, door: number, walkMult, doorMult: number, raw: AltRaw, tankPct: number|null, tankBy: 'surv'|'other'|null, survivorsIn: number }` (name the kind to match the file's existing convention).
  - `export function parseAltFields(kv: Record<string,string>): AltRoundFields | null` in `src/logParse.ts`, shared with Task 3, returning null unless every field is present and numeric where it must be.
  - `export function recordAltRound(db: DB, token: string, ev: AltRoundEvent, source: 'udp' | 'dump'): void` in `src/liveView.ts`. Resolves the ordinal with `ordinalForRoundEnd`. A `udp` write never overwrites an existing `dump` row; a `dump` write always replaces.
- The wire line (pinned, used verbatim in tests):
  `ALT_ROUND map=l4d_vs_airport03_garage half=2 surv=b rule=hr1 walk=463 tank=164 door=0 wm=115 dm=175 ws=180.25 wt=40.50 wr=96.00 ts=150.00 tt=60.00 tr=90.00 ds=0.00 dt=0.00 dr=0.00 tankpct=41 tankby=surv in=0`
  `wm` and `dm` are multipliers x100. `tankpct=-1` and `tankby=none` mean unpaid.

- [ ] **Step 1: Write the failing tests.** In `tests/logParse.test.ts` (follow how the file wraps a line in a datagram with the token and trailing NUL): the pinned line parses to the event above with `walkMult 1.15`, `doorMult 1.75`, `tankPct 41`, `tankBy 'surv'`; the same line with `tankpct=-1 tankby=none` gives nulls; the line with `ws=` removed, with `walk=abc`, with `half=3`, or with `rule` missing yields no event. In `tests/altRound.test.ts` (in-memory DB as other liveView tests build it): a UDP event inserts one row with `source 'udp'`; a second UDP event for the same half updates it; after a `dump` write, a later `udp` write leaves the dump values; an unknown token writes nothing and does not throw.
- [ ] **Step 2:** Run `timeout 300 npx vitest run tests/altRound.test.ts tests/logParse.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3:** Add the table to `SCHEMA`, the parser branch and `parseAltFields`, `recordAltRound`, and the `server.ts` dispatch.
- [ ] **Step 4:** Run the same command. Expected: PASS. Run `timeout 900 npm test` and `timeout 300 npm run typecheck`. Expected: all green.
- [ ] **Step 5:** Commit the five source paths and two test paths: `Alt scoring: store ALT_ROUND lines`.

### Task 3: Reliable copy from the match dump

**Files:**
- Modify: `src/dumpParse.ts` (new `ALT` verb), `src/matchResult.ts` (`completeMatch` writes the rows)
- Test: `tests/dumpParse.test.ts` (add cases), `tests/altDump.test.ts`

**Interfaces:**
- Consumes: `parseAltFields`, `recordAltRound` (Task 2).
- Produces: `ParsedDump.alt: AltRoundFields[]` (empty array when the dump has none). `completeMatch` upserts each with source `dump` inside its existing transaction.
- Dump line: `ALT ` followed by exactly the same `key=value` fields as the UDP line. It appears before `END`.

- [ ] **Step 1: Write the failing tests.** `dumpParse`: a dump containing two `ALT` lines before `END` yields `alt.length === 2` with the pinned values; a dump with none yields `alt: []` and parses exactly as before; a malformed `ALT` line is skipped and the rest of the dump still parses. `altDump`: after `completeMatch` on a dump with `ALT` lines for halves that already have `udp` rows, the rows have `source 'dump'` and the dump's values; halves with only a dump line are inserted; `match_maps` and the match winner are unchanged by the presence of `ALT` lines (compare against the same dump without them).
- [ ] **Step 2:** Run `timeout 300 npx vitest run tests/dumpParse.test.ts tests/altDump.test.ts`. Expected: new cases FAIL.
- [ ] **Step 3:** Implement. The ordinal for a dump `ALT` line is the position of its `map=` among the dump's `MAP` lines.
- [ ] **Step 4:** Same command, expected PASS; then `timeout 900 npm test`.
- [ ] **Step 5:** Commit: `Alt scoring: ALT lines in the match dump`.

### Task 4: Admin report and route

**Files:**
- Create: `src/altScoringReport.ts`, `src/routes/adminAltScoring.ts`
- Modify: `src/server.ts` (register the route module the way `adminBalancePatchRoutes` is registered, about line 2391)
- Test: `tests/altScoringReport.test.ts`, `tests/adminAltScoringRoutes.test.ts`

**Interfaces:**
- Consumes: `halfParts`, `compareMatch`, `HR1` (Task 1); table `match_round_alt` (Task 2).
- Produces:

```ts
export interface AltReport {
  summary: { matchesWithData: number; complete: number; differentWinner: number; share: { walk: number; tank: number; door: number } }; // shares are 0..1, over complete counted matches
  maps: { map: string; halves: number; avgWalkRaw: number; suggestedWalkMult: number }[];
  matches: { id: number; endedAt: string | null; campaign: string; realA: number; realB: number; realWinner: string | null; altA: number; altB: number; altWinner: string; complete: boolean; differs: boolean | null; counted: boolean;
             halves: { ordinal: number; half: number; map: string; survTeam: 'a' | 'b'; real: number | null; walk: number; tank: number; door: number; total: number; tankPct: number | null; tankBy: string | null; survivorsIn: number }[] }[];
}
export function buildAltReport(db: DB, opts?: { limit?: number }): AltReport; // limit default 100 matches, newest first
```

- `counted` = state `completed`, `voided_at IS NULL`, `kind = 'pug'`, and `complete`. Only counted matches feed `summary.complete`, `differentWinner` and `share`. `matchesWithData` counts every match with at least one row.
- `maps[].avgWalkRaw` = mean per half of walking at `walkMult` 1 (from raw components). `suggestedWalkMult` = overall mean / that map's mean, rounded to 0.05, and 1.00 when the map has under 100 halves.
- Route `GET /api/admin/balance/alt-scoring` returns `AltReport`, guarded with `makeRequireAdmin(db)` exactly as `src/routes/adminBalancePatches.ts` does.

- [ ] **Step 1: Write the failing tests.** Report: seeded DB with (a) a completed PUG with 8 real rounds and 8 alt rows whose alt winner differs, (b) a completed PUG with 8 real rounds and 7 alt rows, (c) a voided PUG with full rows, (d) a match with no rows. Assert `matchesWithData 3`, `complete 1`, `differentWinner 1`, (b) has `complete false, differs null, counted false`, (c) `counted false`, (d) absent; shares sum to 1 within 1e-9; an empty DB gives zeros and empty arrays without throwing. Route: 401 or 403 without an admin session (match what the copied route's tests assert), 200 with the report shape for an admin.
- [ ] **Step 2:** Run `timeout 300 npx vitest run tests/altScoringReport.test.ts tests/adminAltScoringRoutes.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the report (read-only SQL, join `match_rounds` for the real half score and `match_live_maps` or `match_maps` for the map name, whichever the real round's ordinal resolves through today) and the route.
- [ ] **Step 4:** Same command, expected PASS; `timeout 900 npm test`; `timeout 300 npm run typecheck`.
- [ ] **Step 5:** Commit: `Alt scoring: admin report and route`.

### Task 5: Admin page

**Files:**
- Create: `web/src/routes/admin/balance/AltScoring.tsx`, `web/src/routes/admin/balance/AltScoring.test.tsx`
- Modify: `web/src/routes/admin/adminRoutes.ts` (`BALANCE_TABS`, `SECTION_INTROS`, balance path parsing), `web/src/routes/Admin.tsx` (render the tab), `web/src/api.ts` (`adminApi.altScoring`, the `AltReport` type)

**Interfaces:**
- Consumes: `GET /api/admin/balance/alt-scoring` and the `AltReport` shape (Task 4).
- Produces: tab id `alt`, label `Alt scoring`, path `balance/alt`.

Page content, in order: an intro line ("Health-run scoring, computed in the background. Real scores are not affected."); the summary (matches with data, complete matches, how many would have a different winner, points share as three numbers); the per-map table; the match list (date, campaign, real score, alt score, a "same" or "different" mark, "incomplete" for incomplete ones), each row expandable to its halves. With no data: one sentence saying no match has reported alt scores yet and that it starts once the servers run the new scoring plugin. Model the component and its test on `TeamBalance.tsx` and `TeamBalance.test.tsx`; reuse the desk's existing table and number styles.

- [ ] **Step 1: Write the failing test** in `AltScoring.test.tsx`: with a mocked report of two matches (one different, one incomplete) it renders the summary numbers, both rows, the "different" and "incomplete" marks, and the halves of a row after it is expanded; with an empty report it renders the empty sentence; while loading and on a fetch error it renders the same states `TeamBalance` does.
- [ ] **Step 2:** Run `timeout 300 npx vitest run web/src/routes/admin/balance/AltScoring.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement the component, the tab registration and the API client method.
- [ ] **Step 4:** Same command, expected PASS; `timeout 900 npm test`; `timeout 300 npm run typecheck`; `timeout 300 npm run build`.
- [ ] **Step 5:** Commit: `Alt scoring: admin page`.

### Task 6: pug-match sends the numbers

**Files:**
- Create: `plugin/pug-altscore.inc`
- Modify: `plugin/pug-match.sp` (native declaration with the other l4dscores natives at lines 24-33, `#include`, a call from the round-end path after the real score is credited, a call from `WriteDump` before the `END` line, state reset where per-match state resets, version bump from 0.3.45)
- Test: `tests/logParse.test.ts` (one more case)

**Interfaces:**
- Consumes (from Task 7, declared optional and feature-checked exactly like `Score_GetLiveScores`):

```sourcepawn
// False when alt scoring is off, or no finished half is held. Valid from the
// round_end Pre hook until the next round_start. raw = ws wt wr ts tt tr ds dt dr.
native bool Score_GetAltHalf(int &walk, int &tank, int &door, float raw[9], int &walkMultX100, int &doorMultX100, int &tankPct, int &tankBy, int &survivorsIn);
// tankPct -1 when unpaid. tankBy: 0 none, 1 survivor kill, 2 other.
```

- Produces: the UDP line and the dump line pinned in Tasks 2 and 3. Floats print with `%.2f`. One stored record per finished half for the whole match (64 slots, indexed like the plugin's other per-half state), written when the native returns true.

- [ ] **Step 1: Write the failing test:** add to `tests/logParse.test.ts` a case that builds the longest possible line (map name of 63 characters, every integer at 5 digits, every float as `99999.99`) and asserts it is under 700 bytes and parses. Run `timeout 120 npx vitest run tests/logParse.test.ts`; it should pass already if Task 2 is right. If it does not, fix the format here, not the limit.
- [ ] **Step 2:** Implement `pug-altscore.inc` (`AltScore_OnRoundEnd(int half, const char[] surv)`, `AltScore_WriteDump()`, `AltScore_Reset()`) and wire the three calls. When the native is unavailable or returns false, emit nothing and store nothing. The round-end call must also run on the delayed retry path that credits a late score, once per half.
- [ ] **Step 3:** Build with `plugin/build.sh`. Expected: compiles with no warnings. Do not run `plugin/stage.sh`.
- [ ] **Step 4:** Commit `plugin/pug-altscore.inc plugin/pug-match.sp tests/logParse.test.ts` (and the built `.smx` only if the repo tracks it): `pug-match: send alt scores (ALT_ROUND, dump ALT lines)`.

### Task 7: l4dscores computes the rule

**Files (deploy worktree):**
- Create: `plugins-src/l4dscores_alt.inc`, `overrides/left4dead/addons/sourcemod/data/altscore_maps.txt`, `tools/altscore-test/README.md` and its rig script
- Modify: `plugins-src/l4dscores.sp` (include, `CreateNative` in `AskPluginLoad2`, calls from `OnPluginStart`, `OnMapStart`, the `round_start` handler, `Event_RoundEnd` before any reset, and the same-map-reload subtraction at lines 640-658; `SCORE_VERSION` to `8.5.9-riverside9`)

**Interfaces:**
- Produces: `Score_GetAltHalf` exactly as declared in Task 6; cvar `l4d_score_alt` (default `1`); for Task 8, these stocks in the include:

```sourcepawn
bool Alt_Enabled();
float Alt_SurvivorPoints(int client);        // spec "Stored health per survivor", all four states
float Alt_TeamHealthPct();                   // 0..100
void Alt_LiveParts(int &walk, int &tankNow, bool &tankPaid, int &doorNow, int &makeItNow); // current half, multiplied and rounded
int  Alt_HalfTotal(int mapIndex, int logicalTeam);   // finished halves this match, 0 if none
int  Alt_MatchTotal(int logicalTeam);
int  Alt_MapsPlayed();
bool Alt_TallyIsPartial();                   // true after a plugin load or resume mid-match
```

- `altscore_maps.txt`: KeyValues `"AltScore" { "<map>" { "walk" "<float>" } }` with the 16 starting values from the spec's "Starting `walkMult` table"; maps absent from it get 1.00.
- Everything else in the include is the implementer's design, bound by the spec sections "The rule (hr1)" and "Plugin: l4dscores", including: distance rescaling with `startFlow` and the door top-up; raw float flow from `L4D_GetLastKnownArea` + `L4D2Direct_GetTerrorNavAreaFlow`; the 0.5 s timer; tank-window detection mirroring `pug-match.sp:3452-3498` and `5103-5105`; state that follows the survivor body across `bot_player_replace` / `player_bot_replace`; a half that was already live when the plugin loaded reports nothing (`Score_GetAltHalf` false); `doorMult` falls back to 1.0 when `MapVersusDifficulty` is 0.

- [ ] **Step 1:** Write `l4dscores_alt.inc` and the hooks. Read cvars (`survivor_revive_health`, `survivor_revive_successive_penalty`, `survivor_max_incapacitated_count`, `survivor_ledge_grab_health`, `pain_pills_decay_rate`) rather than hardcoding. Confirm in the server source (`/home/volence/l4d/source`, read-only) which cvar divides the ledge restore and note the answer in a comment and in `tools/altscore-test/README.md`.
- [ ] **Step 2:** Compile with `./build-staged.sh l4dscores` from `plugins-src/` (it fails on warnings and never ships). Expected: clean build into `plugins-src/staged/`.
- [ ] **Step 3: Rig.** Write `tools/altscore-test/` following a neighbouring rig (`tools/incaprig`, `tools/ledge-fix-test`): a test-only plugin or rcon script for the LOCAL test server that sets up each case and prints `Alt_SurvivorPoints` and the live parts, with the expected value beside it. Cases, each asserting a spec property: fresh survivor 127.5; 1 solid before incap equals after revive (16, 16) and is 8.5 after the second; pills held equals pills eaten at the moment of eating; standing still for 20 s changes nothing but temp decay; one survivor teleported ahead earns only their own quarter; a downed survivor earns nothing while the others advance; a hanging survivor counts what a rescue then actually restores; a full clean half with multipliers 1 and 1 reports 700 / 300 / 500; a bot takeover mid-map keeps the body's distance.
- [ ] **Step 4: Run the rig only if the local server is free.** Check `rcon status` on the local test server (rcon port 27055) and the game log for other sessions' `rcon from` lines; with any human connected or another session active, do not run it: record "rig not run, server busy" in the README and stop. Never kill or restart a local srcds. If it runs, record the output in the README and fix anything that disagrees with the spec.
- [ ] **Step 5:** Commit the created and modified paths (not `staged/` unless tracked): `l4dscores 8.5.9-riverside9: health-run scoring in shadow (hr1)`.

### Task 8: `!healthalt` and `!scoresalt`

**Files (deploy worktree):**
- Modify: `plugins-src/l4dscores_alt.inc` (two command handlers), `plugins-src/l4dscores.sp` (register `sm_healthalt` and `sm_scoresalt` beside `sm_health` at lines 176-177)

**Interfaces:**
- Consumes: the Task 7 stocks.

Output, to the caller only. With `l4d_score_alt 0` both commands print one line: `[Alt] Alt scoring is off.`

`!healthalt` during a live half (chat, colours in the style of `PrintGetNowScores`):

```
[Alt] Walk 312 | Tank up to 300 (222 now) | Door up to 875 (648 now)
[Alt] This half: 312 banked, 1182 if you make it now. Team health 74%.
[Alt] To beat: 1040.
```

"Tank up to 300 (222 now)" becomes `Tank 186` once paid, and `Tank 0` if the half's tank can no longer pay. The third line appears only in the second half and is the first half's alt total on this map. "Door up to N" is `500 x doorMult`. Between halves it prints `[Alt] No half in progress.`

`!scoresalt`: a panel built like `Command_PrintScores` builds the real one (same `SendPanelToClient` lifetime), titled `Alt scores (health-run)`, one line per map played with both teams' alt half totals in the same team order the real panel uses, then the two match totals. When `Alt_TallyIsPartial()` add the line `Since the last restart only.`

- [ ] **Step 1:** Implement both handlers and register the commands.
- [ ] **Step 2:** `./build-staged.sh l4dscores`. Expected: clean.
- [ ] **Step 3:** If the Task 7 rig ran, add both commands to it and record their output for a first half, a second half, after a tank kill, and between halves. Otherwise note that they are compiled but unseen in game.
- [ ] **Step 4:** Commit: `l4dscores: !healthalt and !scoresalt`.

### Task 9: Hand-off note

**Files:**
- Create: `docs/superpowers/plans/2026-11-18-health-run-scoring-shadow-HANDOFF.md` (pug worktree)

- [ ] **Step 1:** Write what was built and where (both branches, commit ids), what was verified and how (test counts, build results, whether the rig ran and its results), every decision made without the owner (from the spec's "Claude's call" lines plus any made during the build), what was not verified, and the exact steps the owner would take to ship it: merge order (site, then pug-match, then l4dscores with `altscore_maps.txt`), the commands, and the rollback (`l4d_score_alt 0`).
- [ ] **Step 2:** Commit it: `Alt scoring: hand-off note`.
