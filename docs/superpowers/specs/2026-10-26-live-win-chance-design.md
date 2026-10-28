# Live win chance: team form and in-round updates

Date: 2026-10-26. Status: APPROVED by the owner 2026-10-27.
Builds on `src/winProb.ts` (the win chance line, deployed 2026-10-10).

## Intent

The win chance today moves only when a half ends. It looks at the score gap and
the maps left, and asks how halves on those maps have scored historically. Two
things make it feel dead to watch:

1. **It ignores how the teams are actually playing.** A team that just held its
   opponents to a quarter of par on two maps is priced the same as an average
   team for the rest of the match. The only correction is one global
   temperature (`CALIBRATION = 1.15`), which the 10-10 backtest needed precisely
   because "a team that has outscored the other so far tends to keep doing so".
2. **Nothing happens during a map.** Survivors losing half their health, a tank
   spawning, a tank dying with everyone alive, a wipe at 30%: the number sits
   still until the round ends and then jumps.

The owner wants the line to (1) learn from how the teams do as the match goes on,
including signals beyond the score such as SI damage, and (2) move through the
map as survivors lose health, make distance, face and clear the tank.

Success: a viewer on /live or on stream sees the number react to the moments
everyone in voice reacts to, and the number is still honest (calibrated) when
checked against history.

## Goals

- **A. Team form.** Each team's remaining halves are priced using how that team
  has played *in this match so far*, not just the map's history.
- **B. In-round line.** During a live half, the current half's final score is
  predicted from the live state and the win chance is recomputed every few
  seconds.
- Both show on: /live (bar and line), the finished match page (the line now
  has in-round detail), the caster overlay, and the Discord comeback line.
- Both are backtested and shipped only if they do at least as well as the
  current model (Brier 0.163; 80-90% calls won 83%; 90%+ won 96%).

## Non-goals

- Ratings stay out. The public line is scoreboard and game state only (owner
  ruling, see the header comment in `src/winProb.ts`). Team form is measured
  from this match's play, never from player ratings or history.
- No per-player credit or swing attribution.
- No !gg unlock change, no new weekly awards. Those are separate ideas already
  on the list in memory and can use this later.
- No plugin release. Everything needed is already sent by pug-match (LIVEHUD,
  live replay frames, data feeds). If the builder finds a hard gap, stop and
  bring it to the owner rather than shipping a plugin.

## Anti-goals (failure even if it works)

- **The public number runs ahead of the public stream.** LIVEHUD is undelayed
  game state and today is deliberately memory-only and caster-gated
  (`src/cast/liveHud.ts` header). Anything public must be computed from state
  at least as old as the public live viewer's delay (`DEFAULT_DELAY_MS`,
  `src/replayTail.ts`). The caster overlay may use the undelayed value, behind
  the same gate it uses today.
- **Jitter.** The number whipping 5 points back and forth every 2 s because of
  noise (a survivor's temp health ticking down) reads as broken.
- **False confidence early.** The owner is skeptical L4D is predictable.
  Early-match and early-half calls must stay near 50% unless the evidence is
  real; calibration is checked per stage of the half, not just overall.
- **Slowing the site.** Live recompute must be cheap; the web process also runs
  the Discord bot.

## Current state the builder needs

- `src/winProb.ts`: per-map half-score histograms (20-pt bins, shrunk toward a
  pooled shape), convolved per team, P(A > B), logit temperature. Model rebuilt
  every 30 min. `winLineFrom` builds the line; `liveWinLine` handles a match in
  progress (a half in progress counts as still to play).
- Data on the prod DB as of 2026-10-26 (read-only count):
  - 688 completed unvoided PUGs.
  - 5,457 halves with replays in R2 (`match_replays.r2_key`). Replay frames
    carry per player: position, state bits (alive, incap, ledged, pinned),
    health, temp health, class (tank = 5); AI tanks as entities. No map
    progress. Decoder: `src/replayFormat.ts`, `src/metrics/replayRound.ts`.
    Local replays are pruned once in R2, so training must read from R2.
  - 1,608 halves (matches from 628 on) with data feeds
    (`src/dataFeeds.ts`): `match_si_lives` (43,990 lives with `spawn_ms`,
    `spawn_prog`, `dmg`), `match_survivor_downs` (7,889 with `t_ms`, `prog`),
    `match_round_feeds.end_prog`.
- Live inputs: LIVEHUD every 2 s (team progress %, tank flow %, per-player
  flow and damage this half; `src/cast/liveHud.ts`), and the live replay
  buffer (health/state/tank, released after the delay by `src/replayTail.ts`).

## Part A: team form

Decided:
- Form is measured per team from halves already played in this match, on two
  sides: as survivors (their score against that map's distribution) and as
  infected (the opponent's score against it, plus SI damage dealt per half
  against that map's norm, where data feeds exist).
- Form tilts the distributions of that team's remaining halves (their survivor
  halves up or down; their opponent's survivor halves by their infected form).
  The strength of the tilt is fitted on history, and it shrinks toward zero
  with few halves played so map 1 stays close to today's behaviour.
- Each signal (survivor form, infected score form, SI damage form) stays in
  only if it improves the held-out backtest. SI damage is a hypothesis to test,
  not a promise.
- `CALIBRATION` is refitted with form in place; it is expected to move toward
  1.0 because form now explains what it was patching.

Left to the builder: the exact form statistic (percentile, z-score, ratio to
median), the tilt shape (exponential tilt of the histogram is the obvious
choice), and the fitting method.

## Part B: in-round line

Decided:
- During a live half, the half in progress is no longer "still to play from
  scratch". Its contribution is a predicted distribution of its final score,
  conditioned on the live state, in the same 20-pt bins so it drops into the
  existing convolution unchanged.
- Live state features (at minimum): map, team progress %, survivors alive,
  incapped/ledged count, total health (permanent plus temp), tank status (not
  yet spawned and its flow % against current progress / alive with health
  fraction / dead), time into the half. The form from Part A applies here too.
- Two hard edges: at half start (progress 0, full health, no tank) the
  prediction must equal the distribution the half-end line already used for
  that half (the Part A form-adjusted one when Part A is on), so the line does
  not jump when a half goes live; at half end it collapses to the actual score.
- Expected events are already priced in. Every half has a tank (and its flow %
  is known from the start), so the opening prediction already includes the
  tank fight, and the tank spawning should barely move the number on its own.
  What moves it is how the fight goes: health lost, downs, deaths, distance
  made. The same holds for witches and events. A model where the spawn itself
  causes a big drop is a bug (owner, 2026-10-27).
- Recompute cadence about 5 s. Public values use only delayed state (see
  anti-goals).
- Moments worth marking on the line: tank spawn, tank death, wipe, saferoom
  reached. The match page's "biggest swing" can now point at a moment ("tank
  on map 3: 68% to 31%"), not just a half.

Training data, decided:
- Snapshots every ~5 s from historical halves. Health, alive, incap and tank
  state come from replays (R2). Progress comes from data feeds: interpolate a
  progress timeline from `match_si_lives.spawn_prog`/`spawn_ms`,
  `match_survivor_downs.prog`/`t_ms` and `match_round_feeds.end_prog`.
- The builder must verify that feed timestamps and replay `tMs` share a clock
  (or find the offset) before joining them. If they cannot be aligned, train
  only on what can be.
- Going forward, store a LIVEHUD progress sample per half (about every 10 s)
  **after the half ends** into a new table, so later retraining has true
  progress instead of reconstruction. Writing after the half ends keeps the
  undelayed line out of the database during play.

Left to the builder, my calls flagged as such:
- Model family. My call: start with something simple and inspectable (map-
  normalised score buckets with a multinomial logistic or nearest-neighbour
  over snapshots), not a black box. Whatever is chosen must output a histogram.
- Whether older replays (before match 628, no feeds) can be given progress by
  learning a per-map position-to-progress lookup from the aligned halves.
  Worth trying if the 1,608 halves prove thin; skip if it does not help.
- Smoothing. My call: no artificial smoothing of real events; temp health is
  the main noise source and can be decayed to its expected value rather than
  smoothed after the fact.
- Scoring floor: if the versus scoring rule guarantees a minimum from distance
  already reached, use it as a hard floor.

## Comeback line and biggest swing (owner, 2026-10-27)

- The Discord "comeback from N%" line (`comebackFrom`, `src/discord/sync.ts`)
  and the match page's biggest swing use mid-half points too, so a headline can
  name the moment ("tank wiped them at 40% on map 4, they were at 12%").
- Only once the mid-half points pass the same calibration gate as half-end
  points (see Validation). Until then both keep using half-end points.

## Finished match pages (my call)

- The in-round line for a finished match is computed once when the match ends
  (from R2 replay plus feeds) and stored, never rebuilt from R2 on a page view.
  A backfill job fills it for older matches that have the data. Matches without
  it keep the half-end line.
- Part A applies to every line, old matches included, since half-end lines are
  already computed on read.

## Validation (decided)

- Same protocol as 10-10: train on the oldest 70% of matches, test on the
  newest 30%. For Part B (my call), the split is taken within the matches
  that have usable progress, since feeds only start at match 628; with only
  about 200 such matches, use time-ordered folds and report bin counts. That
  makes the position-to-progress lookup for older replays core work, not a
  side experiment: it is the way to more training data.
- Part A: Brier and reliability table at half ends, against today's 0.163.
- Part B: Brier and reliability at fixed points within halves (25%, 50%, 75%
  of the half's duration, tank spawn, tank death), against the half-end model
  frozen at the last half end (the honest baseline: does knowing the live state
  beat not knowing it).
- Ship only if both beat their baselines and no reliability bin is off by more
  than 5 points with a reasonable count. Report the numbers to the owner either
  way.

## Rollout (decided, my calls)

- Web-only change, deployed with `deploy-web.sh` (allowed during live
  matches). No game server, rcon or plugin changes.
- Two settings, each default off with an admin preview while off:
  `win_chance_form` (Part A, changes every half-end line already public) and
  `win_chance_live` (Part B). The owner flips each on. `CALIBRATION` is a
  per-model constant, the model in use follows the setting.
- Part A can ship on its own first if Part B's backtest needs more work.
