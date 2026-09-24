# LilAC Detection Reason Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Little Anti-Cheat (LilAC) aimbot or aimlock flag on the site says WHY it fired: LilAC's own reason (Aim-Snap, Aim-Snap2, Autoshoot, Angle-Repeat, Total-Delta) from a small fork, plus our own independent measurement of the shooter's aim and trigger input in the 1.5 s before the detection.

**Architecture:** (Option 2) Vendor the exact LilAC build the four servers run (`1.7.4_4-2024/10/3`, HarryPotter's L4D fork) into the deploy repo, prove it matches the installed binary, then add ONE new forward `lilac_aimbot_detected(client, flags, delta, total_delta)` fired before LilAC's existing `lilac_cheater_detected`. (Option 1) `l4d_lilac_report` keeps a ring buffer of every human's view angles and attack button per usercmd, and on an aimbot or aimlock detection appends our measurement and LilAC's reason (when the fork supplied one) to the signed `L4DL` log line. The site parses the optional fields (old lines still parse), stores them in `integrity_flags.detail`, and the timeline says the reason in words.

**Tech Stack:** SourcePawn 1.12 (spcomp via wine, Rotoblin tree), TypeScript (Fastify, better-sqlite3, vitest), Preact admin UI.

**Spec:** No separate spec file. The design is this conversation's option 1 plus option 2 as approved by the owner on 2026-09-24 ("Can we do 1 and 2 for now?"), recorded in memory note `l4d1-macro-detection` (LilAC log section). Key facts: upstream `lilac_detected_aimbot` calls the forward on every detection but returns before logging on the first detection per 600 s, so the reason never reaches `lilac.log`; the forward passes only `(client, cheat)`. Aimbot flag bits: `AIMBOT_FLAG_REPEAT 1<<0`, `AIMBOT_FLAG_AUTOSHOOT 1<<1`, `AIMBOT_FLAG_SNAP 1<<2`, `AIMBOT_FLAG_SNAP2 1<<3`; Total-Delta is `td > AIMBOT_MAX_TOTAL_DELTA` (450).

## Global Constraints

- pug work: ONLY in `/home/volence/l4d/pug/.claude/worktrees/lilac-reason` (branch `worktree-lilac-reason`). deploy-repo work: `/home/volence/l4d/deploy/plugins-src/lilac/` (new directory only; that repo has other sessions' untracked files: never `git add -A`, add only paths this plan names). Never use git stash.
- Never use em dashes (U+2014) in code, comments, docs, UI text or commit messages.
- LilAC behaviour must not change: same detections, same cvars and defaults, same bans (production runs `lilac_ban 0`). The fork only ADDS a forward call; its version string gets the suffix `+riverside1`.
- `l4d_lilac_report` stays report-only: never bans, never kicks, never writes `buttons` or angles, never hooks `lilac_allow_cheat_detection`.
- The `L4DL` line stays anchored and signed (pug-logauth). New fields are optional `key=value` numbers; a line without them must parse exactly as before.
- Our measurement window: the 1.5 s before the detection, from the ring buffer (256 usercmds per client).
- No production change without the owner's standing rule (`feedback-deploy-when-empty`): each game server gated on 0 humans immediately before the change, web deploy only with no live match, DB backup first.

---

### Task 1: Vendor LilAC 1.7.4_4 and prove it is the build the servers run

**Files:**
- Create: `/home/volence/l4d/deploy/plugins-src/lilac/` (the upstream `scripting/` tree of that build: `lilac.sp`, `lilac/*.sp`, `include/lilac.inc`), plus `/home/volence/l4d/deploy/plugins-src/lilac/SOURCE.md`
- Create: `/home/volence/l4d/deploy/plugins-src/lilac/build.sh`

**Source:** GitHub `thepharat2538/ffc-server-l4d2`, path `addons/sourcemod/scripting/lilac.sp`, `addons/sourcemod/scripting/lilac/`, and `addons/sourcemod/scripting/include/lilac.inc` (its `lilac_globals.sp` carries `PLUGIN_VERSION "1.7.4_4-2024/10/3"`). Fetch with `gh api repos/thepharat2538/ffc-server-l4d2/contents/<path>` (base64 content) or a shallow sparse clone; record the commit SHA in SOURCE.md.

- [ ] **Step 1:** Fetch the files unmodified into `plugins-src/lilac/`. Record repo, commit SHA and file list in `SOURCE.md`, with one paragraph on why the fork exists (the reason never reaches the log on a first detection; link to this plan).
- [ ] **Step 2:** Write `build.sh` in the style of `/home/volence/l4d/deploy/plugins-src/build.sh` (wine + `/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az/spcomp.exe`, copy in, relative compile, copy out, stash-and-restore anything it shadows). Output to `plugins-src/staged/lilac.smx` (NOT into `overrides/`).
- [ ] **Step 3:** Build the UNMODIFIED source. It must compile with no errors.
- [ ] **Step 4: Prove the match.** SMX files are zlib-compressed and carry compiler-specific bytecode, so byte equality is not expected. Write a small Python SMX reader (header: magic `0x53504646`, version, compression, disksize, imagesize, section count, string table offset, data offset; section table; zlib-decompress the data region) and compare the INSTALLED `/home/volence/l4d/deploy/overrides/left4dead/addons/sourcemod/plugins/lilac.smx` against the fresh build on: the `.publics` names, `.natives` names, `.pubvars` names, and the set of printable strings in `.data` (cvar names, defaults, descriptions, log formats, the version string). Report every difference. Acceptance: identical publics, natives and pubvars; every cvar name and default string present in both; version string identical. If the installed build was made by a different compiler, sizes and code differ, which is fine. If any cvar, public or string differs, STOP and report: the source is not the running build.
- [ ] **Step 5: Commit** in the deploy repo, adding ONLY `plugins-src/lilac/` (not staged/, not other untracked files): `git add plugins-src/lilac && git commit -m "LilAC 1.7.4_4 source vendored unmodified, proven to match the installed build"`.

### Task 2: The fork: one new forward carrying the aimbot reason

**Files:**
- Modify: `plugins-src/lilac/include/lilac.inc`, `plugins-src/lilac/lilac/lilac_globals.sp` (version string), the file that creates LilAC's global forwards (find `CreateGlobalForward` / `GlobalForward` for `lilac_cheater_detected`), `plugins-src/lilac/lilac/lilac_aimbot.sp` (`lilac_detected_aimbot`), and SOURCE.md (list the change).

- [ ] **Step 1:** In `include/lilac.inc`, beside the existing `lilac_cheater_detected` forward, declare:

```sourcepawn
/**
 * Riverside fork: why the aimbot check fired. Called for EVERY aimbot
 * detection, including the first, which upstream never logs, and always
 * immediately BEFORE lilac_cheater_detected for the same detection.
 *
 * @param client       Client index.
 * @param flags        AIMBOT_FLAG_* bits: 1 Angle-Repeat, 2 Autoshoot,
 *                     4 Aim-Snap, 8 Aim-Snap2. Total-Delta is total_delta > 450.
 * @param delta        Largest single view-angle change in the 0.5 s before the shot, degrees.
 * @param total_delta  Sum of view-angle changes over that 0.5 s, degrees.
 */
forward void lilac_aimbot_detected(int client, int flags, float delta, float total_delta);
```

- [ ] **Step 2:** Create the forward where LilAC creates its others, following their exact pattern (`new GlobalForward("lilac_aimbot_detected", ET_Ignore, Param_Cell, Param_Cell, Param_Float, Param_Float)` or the `CreateGlobalForward` form the file uses).
- [ ] **Step 3:** In `lilac_detected_aimbot(client, delta, td, flags)`, after the `playerinfo_banned_flags` and `lilac_forward_allow_cheat_detection` early returns and BEFORE `lilac_forward_client_cheat(client, CHEAT_AIMBOT)`, fire the new forward with `(client, flags, delta, td)`. Nothing else in the function changes.
- [ ] **Step 4:** Version string: append `+riverside1` to `PLUGIN_VERSION`.
- [ ] **Step 5:** Build; rerun the Task 1 comparison against the installed binary: the only differences must be the new forward's public/forward entry, the version string, and the forward name string. Report them.
- [ ] **Step 6: Commit** (deploy repo, `plugins-src/lilac` only): `"LilAC fork: lilac_aimbot_detected forward carrying the reason on every detection"`.

### Task 2b (owner addition 2026-09-24): reasons for aimlock and bhop too

Same pattern as Task 2, in the same fork, same `+riverside1` version.

- **Bhop.** Declare in `include/lilac.inc` and create like the others:
  `forward void lilac_bhop_detected(int client, int perfect_bhops, int jump_ticks);`
  Fire it in `lilac_detected_bhop` immediately BEFORE `lilac_forward_client_cheat(client, CHEAT_BHOP)`, with `perfect_bhops[client]` and `jump_ticks[client]` (the values upstream only ever logs from the second detection).
- **Aimlock.** Declare: `forward void lilac_aimlock_detected(int client, int target, int suspicions);`
  The check (`timer_check_aimlock` / `is_aimlocking`) finds the locked-on enemy but never stores it. Add `static int aimlock_target[MAXPLAYERS + 1];`, set `aimlock_target[client] = target` where `detected_aimlock[client] = true` is set, and pass it to `lilac_detected_aimlock` (add an `int target` parameter). Fire the new forward immediately BEFORE `lilac_forward_client_cheat(client, CHEAT_AIMLOCK)` with `(client, target, playerinfo_aimlock_sus value at detection)` (capture the count before the function resets it to 0). No detection logic changes.
- WHY aimlock matters on L4D: the check has no visibility test, and L4D shows survivors to infected through walls by design, so an infected player locking onto a glowing survivor can trip it legitimately. Recording the target's team and class is how a week of data will show whether that happens.
- Rerun the Task 1 comparison: differences must be only the three new forwards, their name strings, and the version string.
- Reporter (Task 3): implement both forwards like `lilac_aimbot_detected` (store with a 2.0 s freshness window). On `CHEAT_BHOP` append `lbhops=%d ljump=%d` (or `-1 -1`). On `CHEAT_AIMLOCK` append `ltarget_team=%d ltarget_class=%d ltarget_ghost=%d` (team 2 survivor or 3 infected; class `m_zombieClass` for infected else 0; ghost from `m_isGhost`; all `-1` when unknown) in addition to the aim measurement Task 3 already adds for aimlock.
- Site (Task 4): parse the new optional integer fields (`lbhops` 0..1000, `ljump` -1..100000, `ltarget_team` -1..3, `ltarget_class` -1..8, `ltarget_ghost` -1..1) with the same reject-on-malformed rule, add them to the canonical detail string, and say them in the timeline: bhop "N perfect hops in a row"; aimlock "locked onto a survivor / an infected <class> (a ghost)" and, when the flagged player is infected and the target a survivor, add "infected see survivors through walls in L4D, so this can be legitimate".

### Task 3: `l4d_lilac_report` 0.2.0: our measurement plus LilAC's reason on the wire

**Files:**
- Modify: `plugin/l4d_lilac_report.sp` (pug worktree)
- Copy for compiling: `lilac.inc` from `/home/volence/l4d/deploy/plugins-src/lilac/include/lilac.inc` (the fork's, which declares the new forward); read how `plugin/build.sh` or the file header says to compile the reporter and follow it.

Behaviour:
- `OnPlayerRunCmdPre` (read-only signature, like `l4d_inputstats.sp`): for each human client push `{angles[0], angles[1], buttons & IN_ATTACK, GetGameTickCount()}` into a per-client ring of 256 entries. Reset the ring on `OnClientPutInServer`/disconnect.
- `lilac_aimbot_detected(client, flags, delta, total_delta)`: store `flags, delta, total_delta, GetGameTime()` for that client.
- In `Report(client, cheat, banned)`, when `cheat` is `CHEAT_AIMBOT` or `CHEAT_AIMLOCK`, append to the existing line:
  - `lflags=%d ldelta=%.1f ltd=%.1f` from the stored reason when it was stored for this client within the last 2.0 s AND cheat is aimbot; otherwise `lflags=-1 ldelta=-1 ltd=-1` (stock LilAC, or an aimlock).
  - `maxd=%.1f totd=%.1f taps=%d taps1=%d` computed over ring entries within the last 1.5 s (by game tick, tick interval from `GetTickInterval()`): `maxd` = largest per-usercmd view change (yaw difference wrapped to [-180,180] combined with pitch difference: `SquareRoot(dy*dy + dp*dp)`), `totd` = sum of those changes, `taps` = attack press edges, `taps1` = press edges whose press lasted exactly one usercmd.
- Other cheats: the line stays exactly as today.
- Bump `PLUGIN_VERSION` to `0.2.0`. Keep every existing comment that is still true; add WHY comments for the ring and the 2.0 s/1.5 s windows.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Compile the reporter against the fork's `lilac.inc` and the pug `pug-logauth.inc`/`pug-hmac.inc`, output kept out of any deploy path (put the smx at `plugin/l4d_lilac_report.smx` only if that is where the repo keeps it; check `git ls-files plugin | grep lilac`).
- [ ] **Step 3:** Load both plugins on the LOCAL test server (`/home/volence/l4d1-ds`) ONLY if no srcds is running there and no other session uses it; otherwise skip and say so. If loaded: `sm plugins list` shows both running, no errors in `addons/sourcemod/logs/errors_*.log`, then remove them again. Never touch a live server in this task.
- [ ] **Step 4: Commit** (pug worktree): `"l4d_lilac_report 0.2.0: carry LilAC's aimbot reason and our own aim and trigger measurement"`.

### Task 4: The site: parse, store and say the reason

**Files:**
- Modify: `src/logParse.ts` (the `L4DL` branch near line 318 and the `lilac_flag` event type near line 134)
- Modify: `src/server.ts` (the `ev.kind === 'lilac_flag'` branch near line 694: pass `detail`)
- Modify: `src/admin/timeline/lilac.ts` (select `detail`; summary in words)
- Test: the existing logParse and timeline tests (find with `grep -ln "L4DL\|lilac_flag" tests/*.ts`), plus new cases

Behaviour:
- Parser: optional numeric fields `lflags` (integer -1..15), `ldelta`, `ltd`, `maxd`, `totd` (finite numbers, -1 or 0..100000), `taps`, `taps1` (integers 0..1000). A field present but malformed rejects the whole line (return null), matching how the parser treats other bad input. Absent fields: the event has no `reason`. Event type gains `reason?: { lflags: number; ldelta: number; ltd: number; maxd: number; totd: number; taps: number; taps1: number }`.
- server.ts: `detail` becomes a canonical string when `reason` is present: `lflags=%d ldelta=%s ltd=%s maxd=%s totd=%s taps=%d taps1=%d` (numbers as parsed), else `''` as today. Dedupe (`recordIntegrityFlag`) is unchanged.
- Timeline summary for an aimbot/aimlock row with a parseable detail: the existing sentence, then " LilAC's reason: <names>." when `lflags >= 0` (names from bits: 1 Angle-Repeat, 2 Autoshoot, 4 Aim-Snap, 8 Aim-Snap2, and Total-Delta when `ltd > 450`; "none recorded" when 0 and ltd <= 450), then " Our measurement over the 1.5 s before: biggest one-tick aim change X degrees, total Y degrees, N trigger presses, M of them one tick long." Rows with empty detail read exactly as today.
- [ ] **Step 1:** Write failing tests: an old-format line parses as before with no reason; a full new line parses every field; each malformed field rejects the line; the timeline summary for a row with `lflags=2 ...` says "Autoshoot" and the measurement sentence; `lflags=-1` omits LilAC's reason sentence but keeps ours; an empty detail reads as today.
- [ ] **Step 2:** Implement; run the covering tests, then `npm test` and `npm run typecheck`.
- [ ] **Step 3: Commit:** `"Site: store and show why LilAC flagged an aimbot, with our own measurement beside it"`.

### Task 5: Ship (web first, then plugins, each gated)

- [ ] **Step 1:** Merge the pug branch to master the way the repo does (check `git reflog` and status on master first; fast-forward; push `origin master:main` and `private master:master`). Confirm no live match, back up the DB on the box, `./deploy-web.sh`, verify per memory `pug-deploy-verification` (source hash, `NRestarts`, journal). The web accepts old and new lines, so it goes first.
- [ ] **Step 2:** For each server (riverside-a, riverside-b, chicago, dallas), gated on 0 humans immediately before each change: stage the fork `lilac.smx` and the reporter with `/home/volence/l4d/deploy/plugins-src/stage-plugin.sh` style steps (lilac has no gamedata of its own; check for a `lilac` gamedata/translations dependency on the box first and leave those untouched). Reload order: `sm plugins reload lilac` then reload the reporter (inside `load_unlock`/`load_lock`). Verify: `sm plugins info` shows `+riverside1` and `0.2.0`, `sm plugins list` has no errors, errors log clean.
- [ ] **Step 3:** Copy both smx into `deploy/overrides/.../plugins/` so future deploys carry them; do not commit other sessions' files.
- [ ] **Step 4:** Rollback recorded in memory: restore the previous `lilac.smx` (md5 `e9d96504c464...`) and reporter 0.1.1.
