# Health-run scoring, stage 1 (shadow): hand-off

Written 2026-11-18 by Claude after an overnight build, updated the same day with the owner's rulings (walking
purely distance based, a vanished tank pays, the tank needs a survivor standing, ledge clamp kept, no kits in
ranked). Nothing here has been deployed or merged to master. The in-game rig was run on 2026-11-18 (task 9, below). Design: `docs/superpowers/specs/2026-11-18-health-run-scoring-design.md`. Plan:
`docs/superpowers/plans/2026-11-18-health-run-scoring-shadow.md`.

## What exists and where

| Piece | Repo and branch | Worktree | Head |
|---|---|---|---|
| Site: rule module, storage, admin report and page | pug, `alt-scoring` (from master 0ee5e855) | `/home/volence/l4d/pug/.claude/worktrees/alt-scoring` | b76bb6d7 (plus the commit with this note) |
| pug-match 0.3.46: sends `ALT_ROUND` and dump `ALT` lines | same branch, `plugin/` | same | same |
| l4dscores 8.5.9-riverside9: computes hr1, `!healthalt`, `!scoresalt`, `!scoresalt full` (or `detail`, `d`), `!newhealth`, 25/50/75% progress lines | deploy, `feature/altscore` (from master 7a6bee7) | `/home/volence/l4d/deploy-altscore` | 8294e01 |

Site files: `src/altScore.ts` (the rule, pure), `src/altRoundStore.ts`, `src/altScoringReport.ts`,
`src/routes/adminAltScoring.ts`, table `match_round_alt` in `src/db.ts`, parser branches in `src/logParse.ts` and
`src/dumpParse.ts`, `storeDumpAlt` in `src/matchResult.ts`, one extra delete in `src/bookings/restore.ts`, page
`web/src/routes/admin/balance/AltScoring.tsx` (Admin, Balance desk, "Alt scoring" tab).
Plugin files: `plugin/pug-altscore.inc`; `plugins-src/l4dscores_alt.inc`, data file
`overrides/left4dead/addons/sourcemod/data/altscore_maps.txt`, rig `tools/altscore-test/`.

## What was verified

- Site: full suite passing (873 files, 12,982 tests), typecheck clean, production build passing. After the
  rulings only the admin page's help text changed in the site: typecheck clean and the 8 alt-scoring and parser
  test files pass (182 tests).
- Both plugins and the rig compile cleanly (only the long-standing `halflife.inc` deprecation warning), also
  after the rulings.
- Every task had its own review, and a Fable whole-branch review covered both repos together. It found no path
  by which this changes a real score, winner, SR or the match dump, and confirmed each piece is safe to deploy
  without the others (old plugins with the new site, new pug-match with old l4dscores, and so on).
- The site formula reproduces the plugin's integers from the raw components (checked by hand on a worked
  example; the admin page now flags any half where they disagree by more than 1).

- **In game, 2026-11-18 (task 9)**: own local srcds on port 27075 (l4d1-ds install, l4dscores 8.5.9-riverside9
  at deploy 61ac90d, rig at deploy eec0e1f), bots plus SourceMod fake clients, no game client. Every rig case
  passes; numbers in `deploy/tools/altscore-test/README.md` Status and below.
  - Cases: fresh 127.5; incap 16 / 15 / 16 (solid 1) / 8.48 (8.5); still: walk raw unchanged, points lose only
    temp decay; teleport: mark 0.16 to 6.23, gain 4.798 for 4.795 expected; down: mark held, gain 2.269 = 2.269;
    respawn: mark 1.97 to 3.48 with walk raw unchanged; pills: 77.5 held, 77.5 eaten; tankfreeze: walk raw and
    mark held while the tank is up, then the mark catches up and pays 1.761; tankgone: paid 460 = 460, tankBy 3;
    tankwipe kill and gone: window closed, unpaid, `ts` 0, tankBy 2 and 3; clean: 700 / 300 / 500 = 1500.
  - Saved health by offset: read = the health set before the grab in every run (10, 1, 60). The ledge-restore
    prediction matched the game for solid and temp (stock: 10 solid gives 10 + 20 temp). A 12 s hang at 60 solid
    restored 53 + 0, at 10 solid 8 + 22; hr1 points never rose above the pre-grab value.
  - First survivor left: fires from Director::Update only when a survivor is really outside the start area
    (flow ~1500 on hospital01; 315 was still inside), bots included. With the normal 4v4 config (`sv_cheats 0`,
    ready-up on): a survivor moved out during ready-up is put back and the half stays not live; after the
    live countdown (`sm_forcestart`, no humans) the half went live when a survivor left, not at the countdown.
  - Takeover: fake client takes a bot (mark 3.422 = 3.422, body known, walk raw unchanged) and back (mark 5.96
    kept).
  - Frustration pass (`L4D_ReplaceTank` to another infected): the window stays open, tanks stays 1, nothing paid;
    the later kill paid once.
  - Map multipliers: hospital01 walk 0.95 / door 1.00; after a changelevel to hospital02 walk 0.95 / door 1.20;
    after the natural versus transition to hospital03 walk 1.05 / door 1.40; greenhouse 0.85. Loaded each time.
    (SourceMod `%.2f` truncates, so the rig shows 0.94 and 1.04; the held integers are 95 and 105.)
  - Real score unchanged: the same scripted half (fixed health, same flow, into the end saferoom) with
    `l4d_score_alt 1` then `0` gave roundScores 400 and 400, engine chapter score 400 and 400, same 27.7% and
    4 alive.
  - Commands (from `sm_altshow`, colours removed): `[Alt] Walk 30 | Tank up to 300 (194 now) | Door up to 600
    (388 now)` / `[Alt] This half: 30 banked, 951 if you finish at this health. Team health 65%.`; with a tank up
    `Walk 93 (paused while the tank is up)`; after a kill `Walk 32 | Tank 193 | Door up to 600 (386 now)` and
    `225 banked`; unpaid tank `Tank 0`; between halves `[Alt] No half in progress.`; second half third line
    `[Alt] To beat: 244.`; `!scoresalt`: header, `Map 1: 290/244`, `Total: ...`; with `l4d_score_alt 0` both print
    `[Alt] Alt scoring is off.` The "Some rounds are missing" line showed only when the plugin was loaded
    mid-map; after a map start (including `sm_restartmap` from the 4v4 config) the tally is not partial.
  - `l4d_ledge_heal_fix` loaded alongside: no conflict; hr1's clamp held in every ledge run.

## What was NOT verified

- Chat colours and line lengths as a human sees them (needs a game client typing `!healthalt` / `!scoresalt`).
- The 25/50/75% progress lines (added 2026-11-18, commit 8294e01): compiled only, never run in game or through the rig.
- `!scoresalt full` (added 2026-11-18, commit dfdbd94): compiled only (plugin and rig), never run in game or
  through the rig. The rig's `sm_altshow` now prints it and checks every stored half's parts sum to its total;
  each round_end checks the filed half carries the held parts.
- A full non-cheats match with humans readying up (the normal-config pass above used bots and `sm_forcestart`).
- Takeover by a real human (the rig used a SourceMod fake client).
- Two rig lines FAIL by design: `takeover` on a half that is not live, and the ledge temp prediction when
  `l4d_ledge_HealthExpolitFixes` is loaded (it zeroes the buffer at the grab, so the rig's snapshot reads 0).

Found while testing: `l4d_ledge_HealthExpolitFixes.smx` (raziEiL) is in every server's plugins/ in the deploy
state snapshot and already stops ledge-rescue health gain: with it loaded, 10 solid 0 temp came back 10 + 0 (also
on a natural bot rescue after an 18 s hang: 8 + 0), and 10 solid 50 temp came back 10 + 49.6 a frame after the
rescue. The scoring clamp stays per the ruling; it just rarely has anything to clamp on our boxes.

## Decisions made without the owner

Design calls (marked "Claude's call" or "Fable review" in the spec):
1. Distance is rescaled so the start saferoom is 0 and the end saferoom is 100; a make is credited the rest of
   the walk at the survivor's health at the door.
2. Walking is purely distance based (owner ruling). The mark is the furthest distance already paid; a survivor is
   paid up to where they are, at their health then, whenever they are standing and no tank is up. Ground covered
   while down, hanging or with a tank up is paid later, the same way. How they got there does not matter.
   Claude's guard: a survivor who was dead and is alive again has the mark moved to where they reappear, without
   pay. Versus has no rescue closets, so it cannot fire in a real match (only on an admin respawn).
3. A tank's death pays whatever killed it; with more than one tank it pays when the last one dies. A tank that
   vanishes (kick, disconnect, despawn) pays like a dead one and is recorded as `gone` (owner ruling). In every
   case the tank pays 0 unless a survivor is standing when the window closes (owner ruling).
4. Each of walk, tank and door is rounded separately and the half is their sum, so players can add up what the
   commands print.
5. After a crash resume the in-game alt tally is not restored; `!scoresalt` says rounds are missing. The site is
   unaffected.
6. A match counts toward "different winner" only when every real half has an alt row. Forfeits and abandons are
   listed as incomplete and left out.
7. The per-map walking fit uses only complete, not voided, ranked PUGs.
8. `!scoresalt` prints chat lines like the real `!scores`, not a panel (the plan had asked for a panel by
   mistake; a panel would be hidden by the ready-up panel).
9. `!healthalt` was added as a separate command, because in shadow the real `!health` must keep showing today's
   scoring.
10. The alt tally is swapped wherever the real tally is swapped (map start and end as well as the swap command).
11. The automatic alt chat lines (tank payout, round end) are opt in per player with `!newhealth` (owner ruling
    2026-11-18), default off, kept in a clientprefs cookie; `!healthalt` and `!scoresalt` answer anyone.

Left as they are for shadow, on purpose: more than four survivors push the percentages over 100 (clamped only
on the tank line); a pinned or dragged survivor counts as standing, so ground they are dragged forward is paid;
walking held back during a tank is paid at the health after it; `!healthalt` says "Tank up to 300" on a map that never spawns one; `Map N` in `!scoresalt` numbers alt
rows, so it can shift against `!scores` after a map with no alt half.

## Decisions waiting for the owner

1. **`!scoresalt` as chat lines** (as built) or a panel.

Settled by the owner on 2026-11-18: the ledge clamp stays (believed then that no game-side fix existed; the
in-game run found `l4d_ledge_HealthExpolitFixes` already does it, see above; a
game-side ledge fix, plugin `l4d_ledge_heal_fix`, is being built separately, and the scoring clamp stays either
way); a vanished tank pays like a dead one; ranked has no first aid kits; walking is purely distance based; the
dead-respawn guard does not matter in versus.

## To ship it (owner's call, in this order)

Each step is safe without the next one.

1. **Site.** Merge `alt-scoring` into pug master and deploy with `deploy-web.sh` under the shared lock. The new
   table is created on boot. With no plugin sending data, the admin page shows its empty state.
2. **pug-match 0.3.46.** Build with `plugin/build.sh`, stage as usual when the boxes are empty. Against the
   current l4dscores it loads and sends nothing new.
3. **l4dscores riverside9.** The rig has been run (2026-11-18). Merge `feature/altscore` into deploy master, build
   with `./build.sh l4dscores` (the script now carries `l4dscores_alt.inc` along), and deploy with
   `altscore_maps.txt`. From the next map on, matches report alt scores and the two commands work.

Rollback at any point: `l4d_score_alt 0` (the commands then say alt scoring is off and nothing is computed or
sent). Removing the plugins or the site change is also safe in any order.

## After it is live

Watch the admin page's mismatch line (it should stay hidden), the share of incomplete matches, and the per-map
table: once maps reach 100 halves it shows the walking multiplier that would even them out, which is the input
for refitting `altscore_maps.txt`. The Season 0 numbers in that file came from a cruder health measure.
