# Balance analytics (pieces 1 to 3): live data verification

Date: 2026-09-24. Checked against a snapshot of the production database taken
about 06:30 UTC (master 147ea38 deployed), plus the 71 replay files on the box
and the 701 replay copies in the R2 bucket (public URL, read only). Nothing on
production or on any game server was written, restarted or deployed.

Branch `worktree-agent-a80c80ac515510977`, worktree
`/home/volence/l4d/pug/.claude/worktrees/agent-a80c80ac515510977`.

## Summary

Tagging (piece 1) and the per-round plugin data are correct: every round has
the right patch, and per-round stats agree exactly with the per-match totals
recorded independently. The metric maths (piece 2) is correct: an
independent re-derivation matches on every round, and a from-scratch
recompute reproduces every stored row. The compare engine (piece 3) behaves
as specified and its verdicts are honest on real data.

Five problems were found and fixed on the branch (tests first; full suite
passes except the known `tests/server.test.ts` malformed URL failure;
typecheck clean):

| Commit | Problem |
|---|---|
| e7981bd | `si.quad_caps` stored 4 per quad cap (the plugin credits all four infected) |
| 98b8f7d | Rounds from before the event markers gave a spurious "real change" in the event and normal phases |
| 9d67f77 | The replay prune deleted replays the metrics job had not read yet; 26 patch 6 rounds lose their replay metrics |
| 3e1e6d2 | No way to recompute a round whose replay is only in R2 (196 rounds now, and every round after any metric version bump) |
| 346a216 | The Compare page would default to patch 6 vs merged patch 7 (the same config) |

Two items need the owner: a data repair (patch 7 into 6) and a run of the new
R2 recompute script after deploy. See the end.

## 1. Patch tagging (piece 1)

### Rounds to patches

All 1144 rounds carry a patch; none is NULL.

| Patch | Source | Rounds | First round | Last round |
|---|---|---|---|---|
| 1 Baseline | historical | 10 | 09-11 20:53 | 09-11 22:43 |
| 2 Anti-bait horde and stumble door | historical | 463 | 09-12 03:13 | 09-20 08:48 |
| 3 Map fixes | historical | 178 | 09-20 11:13 | 09-21 10:23 |
| 4 Sky pounce fix | historical | 216 | 09-21 20:23 | 09-22 21:31 |
| 5 Saferoom lock | historical | 138 | 09-22 22:19 | 09-23 10:39 |
| 6 (unnamed) | detected | 131 | 09-23 20:41 | 09-24 06:30 |
| 7 (unnamed, merged into 6) | detected | 8 | 09-24 05:41 | 09-24 06:20 |

- Every historical boundary falls in a gap between matches; no match
  straddles two patches. The boundaries agree with the deploy repo log
  (for example l4d_saferoom_lock 1.2 committed 21:03 UTC, boundary 21:36, the
  last patch 4 round on Dallas started 21:31 and the next match 22:19).
- Historical tagging stops at the first detected sighting (09-23 20:41:53),
  which is also the first round of pug-match 0.3.9. No rounds were played
  between 10:39 and 20:41 that day, so nothing sits unaccounted.
- All 139 rounds since then got a BALANCE sighting and a detected patch. Server
  sightings are consistent: Dallas 20:41 to 06:30, Chicago 00:46 to 04:38,
  Riverside #3 02:12 to 04:20 on patch 6; Dallas 05:41 to 06:20 on patch 7.
- Patch 7 differs from patch 6 only by `p:l4d_tvwatch.smx` (now ignored) and
  `p:pug-match.smx` (versionless). The 06:27 refingerprint merged it into 6
  as designed, and `balance_server_state` for Dallas followed silently to 6.
  Its 8 rounds (match 169) stay on 7 by design, which leads to the default
  side problem fixed in 346a216 and the repair below.

### Per-round plugin data (ROUND_STAT, ROUND_STATS_END, ROUND_MARK)

- Every ended round since 20:41 (137) has per-round stats and
  `skill_detect = 1`. The two without are an unfinished half of aborted match
  168 and the live match 170. No stats exist before 20:41, as expected.
- No duplicates (primary keys hold) and no stats or marks for a round that
  does not exist.
- For all 32 stats that are also recorded per match, the per-round rows summed
  per player equal the per-match value on every player (for example
  tank_damage 889,449 both ways, crowns 12, draw crowns 41, quad caps 28).
- Per-weapon buckets add up exactly to the totals: SI damage 604,013 and tank
  damage 895,024 across pistol, Uzi, pump and other.
- Every stat lands on the right side of its round: survivor stats (tank_damage,
  sidmg, crowns, rock_skeets, boomer_pops, ...) always on the survivor team,
  infected stats (damage_as_si, dmg_as_tank, quad_caps, ...) always on the
  infected team. So ordinal and half assignment is right.
- Markers: 79 panic markers in 71 rounds, all inside the round's playing time.
  No finale marker exists because no finale map was played (the rotation uses
  maps 1 to 4), so the finale path is untested on live data.
- The per-match stats `deadstops`, `skeets_melee`, `skeets_sniper`,
  `survivors_biled`, `tongue_cuts` and `times_deadstopped` are 0 in every
  match since 20:41, so their absence from per-round rows is expected.

## 2. Metrics engine (piece 2)

### Coverage

- 970 rounds have metrics, all on the current engine; 0 failed, 0 frozen.
- 84 finished rounds (11 matches, 156 to 169) have none yet. Cause: the
  reaper runs only when no match is live or configuring, and last night there
  was almost always one. Nothing was computed between 00:11 and 03:17; match
  153 (ended 00:09) was computed at 05:16 to 05:28. Not a correctness bug, but
  the current patch lags hours behind on a busy night. Measured cost on this
  machine: 5 ms median, 26 ms worst per round, replay decode about 1 ms. See
  "not fixed" below.
- Replay coverage: 486 rounds computed with a replay, 484 without. Of those
  484, 170 (patch 2) have a replay copy in R2 that was pruned locally before
  the backfill ran. Of the 84 waiting rounds, 26 (matches 156, 158, 159, 160)
  had their local replay pruned at the 06:27 boot, before the job reached them;
  they will be computed without their replay and never revisited (fixed in
  9d67f77 going forward, repaired by 3e1e6d2's script).
- By 06:30 1079 of 1139 replay rows were pruned locally (R2 on, disk 9.4 GB
  free against a 10 GB floor). The 84 rounds pending at snapshot time were
  drained on a copy with the replays that were still on the box: 0 failures.

### Values

Distributions over every metric (all phase) show no negatives, no NaN, every
share within 0 to 1, and plausible ranges: round length 0.9 to 11.9 min
(pooled 4.5), tank lifetime 20 to 373 s (pooled 106), survivor spread 130 to
594 units, SI damage 72 to 501 per round, pins 3.2 per minute, saferoom 29% of
rounds. Weapon hold shares for the auto shotgun, rifle and hunting rifle are
always 0 (they are not in play), so those rows read "too early" with 0 vs 0.

### Hand and independent checks

- An independent Python re-derivation from raw events, round rows and round
  stats, over all 1054 rounds, of round.saferoom, survivors_alive, score,
  hunter/smoker/boomer spawns, revives, pin gap, boomer pop rate, all 12
  weapon damage shares, SI damage per minute, SI kills per minute, tank damage
  and punches per tank: 0 mismatches. The one mismatch was si.quad_caps (next).
- Recomputing every round from scratch with all 772 replays (local plus R2)
  reproduced all 46,563 stored rows of the replay rounds exactly, so the job is
  deterministic and R2 copies decode identically.
- Replay-derived timing agrees with events: tank lifetime from the replay is
  the event span plus 3.1 s in 353 of 354 single-tank rounds (the AI tank
  lives before a player takes it). Round length from the replay equals wall
  clock minus pauses (match 97 map 1 half 2: 13.2 min wall, 7.5 min paused,
  5.7 min replay).
- The event-only fallback agrees with the replay method on the same 740
  rounds for every metric computable both ways (only tank.spawns differs, by
  0.7%), so mixing replay and no-replay rounds across patches does not bias a
  comparison.
- Rock skeets: match 169 had 46 (5.75 per tank) against 0.62 per tank overall.
  The per-player rows look genuine (6, 6 and 4 by three players) and no plugin
  change touches rock skeets; noted, not a bug.

### Bug: si.quad_caps (e7981bd)

The plugin credits `quad_caps = 1` to each of the four infected in a quad cap,
so the metric's infected-side sum stored 4 per quad (production: 7 quad caps,
every one stored as 4.0). A quad ends the round, so the metric is now 0 or 1.
Version 2.

## 3. Compare engine (piece 3)

Run through `compareSides` / `metricDetail` on copies of the snapshot.

- Patch 5 vs 6 (the page's default at snapshot time; 18 vs 7 matches): 40
  too early, 23 no data, 0 real. The skill banner fires (mean rating 26.0 vs
  24.1). pace.pin_gap_s passed Benjamini-Hochberg (p 0.002) but stays "too
  early, 3 more matches" under the 10-match rule. With the backlog computed
  (18 vs 17 matches) its p is 0.26: the 10-match rule stopped a false alarm.
- Patch 5 vs 6+7, all rounds computed: 40 too early, 0 real, no skill banner
  (26.0 vs 25.1). Biggest moves, all inside noise: deaths per minute -35%,
  revives +33%, boomed per spawn +18% (p 0.026), tank incaps +16%. 8 of 24 maps
  excluded as one-sided and listed.
- Patch 4 vs 5 (27 vs 18): 0 real. round.score +41% has p 0.006, which is
  rank 1 of 40 but still above its BH cutoff (0.0025), so "too early".
- Patch 2 vs 3+4 (53 vs 45): 8 real changes (saferoom 38% to 23%, survivors
  alive, score, SI spawns down 7 to 10%, tank incaps +10%), 10 noise, 3 too
  early. These are the only real verdicts in the history.
- Bootstrap intervals look right: they contain the point difference, are
  reproducible with the fixed seed and match the p-values. The per-row seed
  keeps verdicts identical whether phases are split or not.
- Map weighting behaves as specified (side A's weights, one-sided maps
  excluded and listed). Since campaigns rotate, several maps drop out of a
  small comparison. The UI lists them, so this is expected.

### Bug: event and normal phases before the markers (98b8f7d)

Rounds without per-round stats predate the event markers, so their event share
is stored as 0 and their event time is counted as normal play. Patch 5 vs 6+7
with phases split showed `round.phase_share|event` 0% to 7.6% as its one
"real change", and `round.phase_share|normal` (53% to 47%) was one match away
from another. The compare now reads 'event' and 'normal' rows only from rounds
with per-round stats (the same release brought the markers). This is done at
read time, so frozen rounds are covered too. After the fix, those rows read
"no data" for patches 1 to 5 and nothing is real.

### Bug: merged patch as a default side (346a216)

The Compare page defaults to the two newest patches with counted rounds. Once
match 169 is computed, that becomes 6 vs 7: one config against itself, with
one match on side B (the snapshot's 6 vs 7 run: 63 too early, one row at
+513%). `listPatches` now reports `merged` (a detected patch whose fingerprint
the refingerprint cleared) and the defaults skip merged patches. A merged
patch can still be picked by hand.

### Spec deviations noticed, not changed

- "Too early" ignores interval width. It depends only on the 30-match rule.
  A row with 30+ matches on each side is "noise" however wide its interval.
- Catalogue items the metrics plan did not list as deviations and did not
  build: hunter skeets by weapon (round stats have skeets_shotgun and
  team_skeets), deadstops, smoker self clears and tongue cuts (self_clears and
  tongue_clears exist per round), boomer damage while boomed, weapon kills
  (w_*_sikill exist per round), tank survivor distance at spawn, witch killed
  after startle.
- The backfill summary prints unnamed detected patches as "untagged".

## Fixes on the branch

- **e7981bd** `si.quad_caps` v2: 0 or 1 per round.
- **98b8f7d** compare: event and normal rows only from rounds with markers.
- **9d67f77** replay prune: a replay stays on disk while its finished round
  of a completed, unvoided match has no metrics, or has metrics computed
  before the replay arrived. The hold lifts once the job has read the file or
  tried to. On the snapshot this holds the 58 still-local waiting rounds
  (about 60 MB).
- **3e1e6d2** `scripts/recompute-metrics-from-r2.ts` (logic in
  `src/metrics/r2Recompute.ts`): fetches from R2 the replay of every counted
  round whose local file is gone and whose metrics lack the replay or are on
  an older or frozen engine, and stores metrics on the current engine. It is a
  dry run unless `--apply` and refuses while a match is live unless `--force`.
  Simulated on a copy with the bucket's files: 682 rounds in 4 s, then
  identical to a from-scratch recompute with every replay. Replay coverage
  went from 486 to 740 rounds (patch 2: 0 to 170 of 414; patch 6: all 128).
- **346a216** merged patches never default a Compare side.

## Not fixed

- **Reaper starvation.** Metrics wait while any match is live. With three
  servers that can mean hours (84 rounds pending at snapshot, 5 hours of lag
  for match 153). Measured compute is 5 to 26 ms per round, so running 1 or 2
  rounds per tick during live matches looks safe. That is a deliberate
  decision in the plan, though, so it is left to the owner. With 9d67f77 the
  lag no longer costs data.
- **Metric version bumps freeze history.** Almost every local replay is
  pruned within hours now, so any version bump (including e7981bd) freezes
  nearly all replay rounds on their old rows until the R2 script runs. A
  longer-term fix is for the job itself to read from R2. For now: run the
  script after each deploy that bumps a metric.
- **Disk.** 9.4 GB free against the 10 GB replay floor. About 800 MB of
  `pug.db` backups sit in `/home/pug/app/data`.

## For the owner (nothing run on production)

1. **Data repair, patch 7 into 6.** Run
   `docs/superpowers/verification/2026-09-24-fold-patch-7-into-6.sql` while no
   match is live, after a backup:
   `sqlite3 /home/pug/app/data/pug.db ".read 2026-09-24-fold-patch-7-into-6.sql"`.
   It moves patch 7's rounds, context rows and sighting to 6 and deletes 7.
   It does not touch server states, unlike
   `scripts/merge-balance-patches.ts 6 7`, which would rewrite Dallas's stored
   inventory to patch 6's older pug-match hash and post a "config changed"
   alert on the next sighting. Its guards (CHECK plus `.bail on`) refuse while
   a match is live or if patch 7 was not merged. Tested on copies: it refused
   with match 170 live, and with no match live it moved 8 rounds and 1
   sighting. With 346a216 deployed this is cosmetic, but patch 7 would
   otherwise remain as a one-match patch.
2. **After deploying the branch**, from `/home/pug/app`:
   `set -a; . /home/pug/app/.env; set +a; npx tsx scripts/recompute-metrics-from-r2.ts /home/pug/app/data/pug.db "$REPLAY_DIR"`
   (dry run), then again with `--apply` while no match is live. This restores
   replay metrics for 196 rounds and moves every round with an R2 copy onto
   the new engine instead of freezing it.
