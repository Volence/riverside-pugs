# Health-run scoring, stage 1 (shadow): hand-off

Written 2026-11-18 by Claude after an overnight build. Nothing here has been deployed, merged to master, or run
in game. Design: `docs/superpowers/specs/2026-11-18-health-run-scoring-design.md`. Plan:
`docs/superpowers/plans/2026-11-18-health-run-scoring-shadow.md`.

## What exists and where

| Piece | Repo and branch | Worktree | Head |
|---|---|---|---|
| Site: rule module, storage, admin report and page | pug, `alt-scoring` (from master 0ee5e855) | `/home/volence/l4d/pug/.claude/worktrees/alt-scoring` | 74163a18 (plus this note) |
| pug-match 0.3.46: sends `ALT_ROUND` and dump `ALT` lines | same branch, `plugin/` | same | same |
| l4dscores 8.5.9-riverside9: computes hr1, `!healthalt`, `!scoresalt` | deploy, `feature/altscore` (from master 7a6bee7) | `/home/volence/l4d/deploy-altscore` | 2cd8650 |

Site files: `src/altScore.ts` (the rule, pure), `src/altRoundStore.ts`, `src/altScoringReport.ts`,
`src/routes/adminAltScoring.ts`, table `match_round_alt` in `src/db.ts`, parser branches in `src/logParse.ts` and
`src/dumpParse.ts`, `storeDumpAlt` in `src/matchResult.ts`, one extra delete in `src/bookings/restore.ts`, page
`web/src/routes/admin/balance/AltScoring.tsx` (Admin, Balance desk, "Alt scoring" tab).
Plugin files: `plugin/pug-altscore.inc`; `plugins-src/l4dscores_alt.inc`, data file
`overrides/left4dead/addons/sourcemod/data/altscore_maps.txt`, rig `tools/altscore-test/`.

## What was verified

- Site: full suite passing (873 files, 12,982 tests), typecheck clean, production build passing.
- Both plugins compile cleanly (only the long-standing `halflife.inc` deprecation warning).
- Every task had its own review, and a Fable whole-branch review covered both repos together. It found no path
  by which this changes a real score, winner, SR or the match dump, and confirmed each piece is safe to deploy
  without the others (old plugins with the new site, new pug-match with old l4dscores, and so on).
- The site formula reproduces the plugin's integers from the raw components (checked by hand on a worked
  example; the admin page now flags any half where they disagree by more than 1).

## What was NOT verified

The in-game rig (`deploy/tools/altscore-test`, see its README) was written but never run: the local test servers
were in use by other sessions all night. So every game-facing assumption is unconfirmed:

- the saved pre-grab health read by offset, and the ledge-restore prediction;
- that left4dhooks' first-survivor-left-safe-area forward fires on our boxes and at the right moment around ready-up;
- bot and human takeover event order, and that walking state follows the body;
- that a frustration pass is not read as a tank death;
- whether the "Some rounds are missing from this list." line shows in normal matches (if match configs load
  l4dscores late);
- chat colours and line lengths of both commands;
- that the map multiplier is loaded one frame after map start.

Do not stage riverside9 to a live box before the rig has been run on a free local server.

## Decisions made without the owner

Design calls (marked "Claude's call" or "Fable review" in the spec):
1. Distance is rescaled so the start saferoom is 0 and the end saferoom is 100; a make is credited the rest of
   the walk at the survivor's health at the door.
2. Only ground walked while standing pays. A teleport (more than 1000 units between two half-second samples), a
   respawn, or time spent down, hanging or dead moves the mark without pay.
3. A tank's death pays whatever killed it; with more than one tank it pays when the last one dies. A tank that
   vanishes (kick, disconnect, despawn) pays nothing, but its snapshot is recorded as `gone`.
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

Left as they are for shadow, on purpose: more than four survivors push the percentages over 100 (clamped only
on the tank line); a pinned or dragged survivor counts as standing; a fling or punch under 1000 units is paid as
walking; `!healthalt` says "Tank up to 300" on a map that never spawns one; `Map N` in `!scoresalt` numbers alt
rows, so it can shift against `!scores` after a map with no alt half.

## Decisions waiting for the owner

1. **Ledge clamp.** As the game works, grabbing a ledge would raise a low-health survivor's score (16 to about
   23). The build clamps that out so "going down never raises a score" holds. Keep the clamp, or count
   ledge-rescue temp health as the game gives it?
2. **A vanished tank.** Should a tank that disappears through a kick or disconnect pay like a dead one?
3. **First aid kits.** hr1 gives a held kit nothing, and a heal raises solid health and resets revives. Confirm
   the ranked config has no kits before any real test games.
4. **`!scoresalt` as chat lines** (as built) or a panel.
5. **Who runs the rig**, and on which local server.

## To ship it (owner's call, in this order)

Each step is safe without the next one.

1. **Site.** Merge `alt-scoring` into pug master and deploy with `deploy-web.sh` under the shared lock. The new
   table is created on boot. With no plugin sending data, the admin page shows its empty state.
2. **pug-match 0.3.46.** Build with `plugin/build.sh`, stage as usual when the boxes are empty. Against the
   current l4dscores it loads and sends nothing new.
3. **l4dscores riverside9.** First run the rig locally. Then merge `feature/altscore` into deploy master, build
   with `./build.sh l4dscores` (the script now carries `l4dscores_alt.inc` along), and deploy with
   `altscore_maps.txt`. From the next map on, matches report alt scores and the two commands work.

Rollback at any point: `l4d_score_alt 0` (the commands then say alt scoring is off and nothing is computed or
sent). Removing the plugins or the site change is also safe in any order.

## After it is live

Watch the admin page's mismatch line (it should stay hidden), the share of incomplete matches, and the per-map
table: once maps reach 100 halves it shows the walking multiplier that would even them out, which is the input
for refitting `altscore_maps.txt`. The Season 0 numbers in that file came from a cruder health measure.
