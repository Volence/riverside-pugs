# Shipping balance-integration: one runbook

Date: 2026-09-25. Covers everything on branch `balance-integration` that is not on
master: piece 4 (knob panel), piece 5 (public patch notes), live fixes, triage
(sub-project 1), fleet view and releases (2a, 2b), the watch file (3, plugin
0.3.14), the catalogue and Game values page (4), and the 2026-09-25 review fixes.
Nothing here has been run. Each numbered stage can ship on its own; later stages
depend on earlier ones.

The standing rules still apply: gate every server touch on 0 humans in the same
shell command, back up the DB before a web deploy, check `sudo -u pug test -w`
after any push to Dallas, never blank `sv_password`.

## Stage 0: before anything

1. `git log balance-integration..master` must be empty. If master moved, merge it
   in again and rerun `npx vitest run && npm run typecheck && bash plugin/build.sh`.
   A new pug-match version on master means renumbering the watch-file build
   (currently 0.3.14) and the `0.3.14+` comments in `src/server.ts`,
   `src/balanceWatch.ts`, `src/balanceKnobs.ts`.
2. Dry run on a copy of production (done 2026-09-25 03:17 local): migrations and
   backfill give #1 to #5 balance, #6 and #8 pending, #7 folded into #6. The
   triage card for #8 shows "plugin added: l4d_block_autoaim, l4d_hltv_crash_fix"
   compared with #6. Repeat with a fresh copy on ship day:
   `npx tsx scripts/balance-triage-report.ts <path containing "copy">`.

## Stage 1: web (no game server change)

1. Nothing live or configuring (`/api/live`), DB backup
   `/home/pug/pug.db.pre-balance-integration-<date>`.
2. `deploy-web.sh`. New tables and columns appear on boot (rollouts, releases,
   fleet, triage columns, `servers.deploy_slug` backfilled from names,
   `balance_server_state.watch`, `balance_patches.published_before_fold`).
3. Expect on first boot: possibly "merged" admin events from the refingerprint
   (plugin lists now match by file name). No box is written: the watch-file writer
   does write `data/pug_balance_watch.txt` to idle boxes, which only the 0.3.14
   plugin reads, so it is inert until stage 3.
4. Recompute from R2 every round whose local replay was pruned: the 26 rounds of
   matches 156, 158, 159 and 160 that were computed with no replay, and every
   older round still on an earlier metric definition (Compare says "N rounds use
   an older metric definition" for nearly all of them on 2026-09-25):
   `npx tsx scripts/recompute-metrics-from-r2.ts /home/pug/app/data/pug.db`
   (dry run), then `--apply`, while no match is live. The branch's own commit
   measured 682 rounds in 4 s on a prod copy.
5. Verify per `pug-deploy-verification`: tree hash, bundle strings
   ("Patch notes", "Game values"), DB columns, `/balance` and `/balance/values`
   load logged out, Admin > Balance > Patches shows the two pending cards.

## Stage 2: triage the backlog (site only)

1. Patch #6: Balance, name "Fingerprinted config" (the first fingerprinted
   config; nothing earlier to compare with).
2. Patch #8: now compared with #6. **Owner:** "Ignore these plugins from now on"
   (autoaim block and HLTV crash fix have no balance effect; #8 folds into #6 and
   comparisons span 09-24) or Balance with a name (keeps 09-24 21:36 as a split).
3. Publish whatever should be public on `/balance` (Patches tab, Publish).

## Stage 3: plugin 0.3.14 (watch file)

1. Confirm each box has `addons/sourcemod/data/pug_balance_watch.txt` (the site
   wrote it in stage 1).
2. Stage `pug-match.smx` on each box while empty (the usual load_unlock / reload /
   load_lock; re-assert `sm_pug_auto_track 1` and `sm_pug_roster_at_live 1`).
3. Expect on each box's next match: `watch=file` on BALANCE_END, about 166 more
   reported values, and the sighting folds silently into the current patch
   (watch-list-only). No triage card, no alert. If one appears, stop and look.

## Stage 4: knob panel writes (piece 4)

1. Check no box already has a `cfg/pug_balance.cfg`.
2. Deploy repo: add `exec pug_balance.cfg` as the LAST line of
   `rotoblin_pug_4v4_map.cfg` (after `exec local_4v4.cfg`), in `overrides/` and
   `nfo/stage`. It is watched, so the next match raises one pending patch: triage
   it as Balance "pug_balance hook" (or fold it into the current patch).
3. Knobs tab: Reset to baseline, Preview, must say "Matches existing patch #N".
   Apply. Every box should confirm on its next queue match.
4. Only then a real change.

## Stage 5: releases (2a, 2b)

1. Read-only deploy key on Dallas as `pug`, `DEPLOY_REPO_KEY` in `.env`, restart
   the site (stage 1 rules).
2. Seeding commit in the deploy repo: `boxes/<slug>/` with each box's live
   `local.cfg`, `server.cfg` and hostname txt. **Move `rcon_password` and
   `sv_password` lines out of the seeded `server.cfg` into that box's
   `secrets.cfg` first**: staging now refuses a release that carries them (and
   warns on `tv_password`, which `overrides/.../local.cfg:131` still commits).
3. Stage the seeding commit: every box must show "no changes".
4. First deploy: a comment-only change to `boxes/dallas/.../local.cfg`, Dallas
   only, not balance; check the Fleet page; Undo; check again.
5. Then `deploy.sh` and `ftpsync.py` start refusing without `--bypass-site`.

## Rollback

- Web: redeploy master. Master's code ignores the new tables and columns, so the
  DB stays as it is; restore the stage-1 backup only if a migration itself went
  wrong (that loses everything recorded since).
- Plugin: keep a `pug-match.smx.pre-0.3.14` copy on each box when staging, and
  put it back the same way.
- Knob hook: delete the exec line (a missing `pug_balance.cfg` only prints
  "couldn't exec").
