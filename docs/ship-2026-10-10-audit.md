# Ship 2026-10-10: audit fixes (plugin review D/E, pause ghost M1, ban sync)

Built 2026-10-09 on branch `audit-fixes` (worktree `.claude/worktrees/audit-fixes`,
based on master 9da97dd1), plus one commit on branch `audit-fixes-2026-10-09` in
`/home/volence/l4d/practice`. Nothing was deployed, staged, pushed or sent by rcon.

## What is in it

| Commit | Item | Where |
|---|---|---|
| Resumed tournament game keeps its stop map and disconnect handling | D1 (MEDIUM) | site + pug-match |
| Pause releases an infected ghost's held attack | ZoneMod pause.sp port | pug-match |
| !pause waits while the other team's !tech is on its way | D2 | pug-match |
| pug-sidegame 0.1.1: in-game vote stays within keys 1-5 | E1 | pug-sidegame |
| pug-sidegame: keep auto-track off for the whole side game | E2 | pug-sidegame |
| Ban sync sends only what a box's own list lacks | ban log spam | site |
| pug-match 0.3.29 | version bump | pug-match |
| l4d_practice: map change clears the station flags | E6 | practice repo |

Details:

- **D1.** `sm_pug_resume` takes an optional 6th argument, the quoted stop map
  (`src/bookings/restore.ts` sends it; computed by the new `src/events/stopMap.ts`,
  the same rule the series engine uses for `sm_pug_match`: a tiebreak's one map,
  the stage's chapter count, else the campaign stop point). Non-tournament games
  get no stop map, as before. In the plugin, `LeaveTracking()` now accepts
  `g_bResumed && TourneyOn()`, so a resumed tournament game gets the disconnect
  pause, team reconnect pool, disconnect forfeit and emergency sub again. A resumed
  scrim/booking game stays untracked (on purpose: those boxes keep
  `sm_pug_leave_budget` at its 300 default after a restart, and tracking them
  would start pausing scrims).
- **Ghost M1.** On the pause clock tick that first sees a pause (any pause),
  every human infected ghost holding IN_ATTACK has it cleared, gets
  `m_hasVisibleThreats 1` (as ZoneMod; the game recomputes it on its next think)
  and a chat line. `pug-pause.inc PauseReleaseGhostAttack`.
- **D2.** `Listener_PugPause` refuses a `!pause` while the other team's `!tech`
  is pending inside `Tourney_RetryGap()`, with a chat line. Tournament boxes only
  in practice (`g_iTechPendingTeam` is only set by `!tech`).
- **E1.** More than five campaigns: four per page plus "More campaigns..." as
  item 5; the last page holds up to five, with "Back to the first campaigns" when
  there is room. SourceMod paging off. Five or fewer: one menu, as before.
- **E2.** While a side game is armed, pug-sidegame sets `sm_pug_auto_track 0`
  in OnConfigsExecuted and on every round_start. `sm_side_stop` still restores
  the saved value.
- **Ban sync.** The 5-minute sweep and the match-setup push now send `listid`
  first and push only the difference: `sm_addban` for an open ban the box does
  not hold as **permanent**, `sm_unban` for a lifted ban (30-day window) the box
  still holds. Unreadable reply = old full push. Instant pushes on ban/lift
  unchanged. Expected effect: Dallas's daily basebans lines go from ~26,600 to a
  handful (one per real change per box). Extra rcon per sweep: one connection,
  one command, per box.
- **E6.** `l4d_practice` OnMapStart now runs StopPit and resets god, M2, DP,
  climb, lane and pit mark for every slot. It still does not call StopTrainer
  (its crown cleanup would delete witches near the old spot on the new map).
  Hitbox/callout display toggles are kept.

## Ship order

1. **Web first** (`./deploy-web.sh` from the merged master, the usual way; web
   deploys may go out during live matches). Safe against the old plugin: 0.3.28
   ignores the 6th `sm_pug_resume` argument, and the ban diff only uses the
   engine's `listid`. Verify with the pug-deploy-verification recipe.
   - After deploy, watch one box's SourceMod log for an hour:
     `grep -c 'added ban\|removed ban' L<date>.log` should stay near zero (it was
     ~1,100 an hour on Dallas). If it does NOT drop, the box's `listid` reply was
     unreadable and the sweep fell back to the full push: run `listid` by rcon on
     an idle box and compare with `parseListId` in `src/serverBans.ts`.
2. **pug-match 0.3.29 + pug-sidegame 0.1.1**: build from the merged tree
   (`plugin/build.sh`, `plugin/build-sidegame.sh`), copy both `.smx` into
   `deploy/overrides/left4dead/addons/sourcemod/plugins/`, commit in the deploy
   repo, then `deploy/tools/stage-on-restart.sh` per pool box (installs between
   matches). Do not hot-load into a running match.
   Local build hashes (scratch copy of scripting-az, same spcomp):
   pug-match.smx `1dd417fd...fa826`, pug-sidegame.smx `ae618286...a154`.
3. **l4d_practice**: merge `audit-fixes-2026-10-09` into practice master (the
   commit includes the rebuilt `l4d_practice.smx`), copy it to the deploy repo's
   `optional/l4d_practice.smx`, stage on restart like step 2. Inert until a box is
   leased for practice.

Order between 2 and 3 does not matter. Nothing needs a DB migration.

## What was tested

- `npm run typecheck`: clean.
- `npx vitest run` (TMPDIR in the session scratchpad): 11,198 passed, 7 failed.
  The 7 are all `tests/skeetStreakPoster.test.ts` and **pre-existing**: the same
  7 fail at master 9da97dd1 (checked in the endorse-board worktree). None of mine.
- New tests: `tests/resumeStopMap.test.ts` (6: resume line equals the game's own
  `sm_pug_match` stop map, stage chapters, tiebreak, non-tournament gets none,
  crash recovery sends it, unsafe map refused); `tests/serverBans.test.ts` (+8:
  listid parsing incl. timed entries, silent second sweep, only-the-difference,
  empty box after restart gets everything, timed engine ban does not count,
  foreign box bans left alone, lift via onChange, setup push diff). Three old ban
  tests updated for the extra `listid` call.
- pug-match, pug-sidegame and l4d_practice compile clean (only the stock
  halflife.inc CreateDialog deprecation warning).

## Still needs an in-game check (none of this was run on a server)

- **listid over rcon**: confirm the L4D1 reply reads `ID filter list: N entries`
  / `1 STEAM_1:Y:Z : permanent` (format taken from the Source 2007 engine
  `listid`). If it differs the sweep silently falls back to the full push (safe,
  just no spam fix).
- **Ghost M1**: 2-client local repro (cheats cfg): ghost holding M1, `!pause`,
  release M1 during the pause, unpause; the ghost must not materialize and must
  see the chat line. Also check that L4D1 does not spawn on the first unpaused
  tick anyway (a press edge would still be a legitimate spawn).
- **D1**: on a local tournament-like box (`sm_pug_tournament 1`,
  `sm_pug_dc_team_seconds 60`), `sm_pug_resume ... "<stop map>"`, roster,
  commit, go live, drop a player: expect the disconnect pause and team pool;
  `sm_pug_status` should show the stop map; finishing that map ends the game.
- **D2**: hard to hit by hand (needs Rotoblin to refuse the !tech pause); a
  read-through is the main check.
- **E1**: side game pop with 6+ campaigns in the pool: keys 1-5 only, "More"
  pages through and wraps, a vote from page 2 logs the right slug.
- **E2**: side game across a map change: `sm_pug_auto_track` reads 0 after the
  second map loads and the 2v2/3v3 map cfg ran.
- **E6**: practice park, start a trainer with god, changelevel: god is off.

## Note for the deploy repo (not changed here)

`deploy/overrides/left4dead/cfg/riverside/shared.cfg:294` runs
`sm_cvar sm_pug_auto_track 1` on every map (it is the `every_map` block, exec'd
from the 2v2/3v3 map cfgs too). Since 0.1.1 pug-sidegame turns it off again
while a side game runs, but the cleaner fix is in the cfg layer: keep the
auto-track line out of the 2v2/3v3 map cfgs, so a side game box is never
recordable by config. Recording of side games is otherwise only prevented by
`sm_pug_auto_min_players 8`.
