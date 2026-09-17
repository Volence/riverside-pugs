# Integrity: cheat telemetry, pistol script measurement, demo ticks

Design agreed 2026-09-17 with the owner. Builds on `2026-09-11-replay-capture-design.md`
(the recorder and file format), `2026-09-12-replay-viewer-design.md` and spec 7.2 of
`2026-09-12-theater-mode.md` (bookmarks), and `2026-09-17-discord-bot-and-admin.md`
(the admin panel this adds a tab to).

## Why

People avoid L4D1 because cheating is easy and nothing stops it. The owner's list:
aimbots and wallhacks, but also content swaps that are just as decisive and far more
common, such as no-trees addons, bright hunter skins, silent weapon packs and muted
common infected sounds. `sv_pure` is widely reported as non-functional in L4D1 and no
third-party anticheat supports the game.

The PUG is invite-only, so the owner chose the cheapest useful path: server-side only,
nothing required of players, no client pack, no mandatory settings.

The finding that shapes the whole design is that the recorder already captures what a
detector needs. `plugin/pug-match.sp:1277-1307` writes per-player eye angles (yaw at 0.01
degree, pitch at whole degrees) at 10 Hz alongside positions, and the `GHOST` state bit
for infected that have not spawned. A survivor can never see a ghost infected, through a
wall or otherwise, so "was this survivor's crosshair tracking a ghost" is evidence that
needs no map geometry, no line of sight tracing and no plugin at all. It can be computed
over every match already on disk.

## Decisions taken in the session

1. **Server-side only.** Nothing is asked of players. Invite-only makes this enough for now.
2. **Measurements are stored raw; scores are always derived.** Nothing computes a verdict
   at capture time. Thresholds will be wrong at first, and the whole history must stay
   recomputable when they change.
3. **The unit of review is a clip, not a player.** A flag means "watch these six seconds",
   and it deep-links into the replay viewer.
4. **The suspicion percentage is admin-only and labeled theoretical.** The owner asked for
   it and accepts that framing. Per-metric percentiles sit next to it; the composite is a
   sort key, not a claim.
5. **A cheat is impossible information or impossible motor output. Everything else is
   skill.** The tell is a discontinuity at an information boundary: a behavior change
   landing exactly on an event the player could not have known about. A good player is
   aimed at the right place early and continuously because they predicted it. A cheater
   is aimed at the wrong place and becomes correct the instant information arrives.
6. **Correlation, not proximity.** The backbone statistic is whether the survivor's yaw
   rate tracks the rate needed to follow the ghost. A pre-aimed corner is a static
   crosshair, has no variance, and scores near zero.
7. **Occupancy is scored against an empirical aim prior, never raw.** Spawns are not
   uniform and good players pre-aim the obvious spots, so "aims where SI actually are" is
   partly just map knowledge. The prior is what removes it. See section 1.
8. **Relative to the other survivors in the same frame**, as a second control on top of
   the prior. If everyone is watching the chokepoint, nobody stands out.
9. **A separate plugin, not `pug-match.sp`.** That file runs ranked matches and is over
   three thousand lines. Per-tick work goes in its own plugin that can be unloaded
   instantly without touching match reporting.
10. **Pistol: measure for the first week, clamp after.** Nobody knows what a real human
   clicking interval looks like on this server. A guessed floor either misses the
   scripters or eats legitimate shots and feels like a broken gun.
11. **Ceiling pouncing is deferred.** The fix depends on an unanswered question about
   whether mid-air re-pounces off walls are legitimate in the ruleset.

## Scope

In: a replay analyzer and its backfill script, two new tables plus a review table, an
admin Integrity tab and its routes, replay format version 4 carrying the demo tick offset,
the bookmark display of `demo_gototick`, and a new measure-only `l4d_integrity` plugin.

Out: the ceiling pounce fix; the `sv_consistency`, `sv_pure` and `QueryClientConVar`
probes, which are their own spike on the local test server; the admin balancing tab; any
automatic punishment. Nothing in this spec bans anyone or tells a player anything.

## 1. The analyzer

Pure functions in `src/integrity/ghostTrack.ts`, buffers in and metrics out, tested the
way `replayFormat.ts` is tested. No filesystem, no database. `src/integrity/run.ts` owns
the IO.

Input is one replay file, which is one match, ordinal and half. Frames decode through the
existing `decodeFrames`.

### Geometry

Positions are entity origins as int16 world units, not eye positions, and the file carries
no crouch state. Pitch is stored at whole-degree resolution. Together that makes the
vertical axis unreliable at the scale we care about: a 30 unit eye-height error is about 3
degrees at 600 units, which is the same size as the effect being measured.

**So yaw is the primary axis and pitch is a loose secondary gate only.** The correlation
metric is defined on yaw alone, which is unaffected by eye height entirely. This is a
deliberate limitation of the 10 Hz retrospective pass; the plugin phase has real eye
positions and real traces and does not inherit it.

For a survivor `s` and ghost `g` in frame `f`:

- `bearing(s, g, f)` is `atan2` of the XY offset, in degrees.
- `err(s, g, f)` is the survivor's yaw minus that bearing, wrapped to [-180, 180].

### Frame eligibility

A frame contributes only when all of these hold. Each exclusion exists because it is a
false positive generator, not for tidiness.

- The survivor has `PRESENT` and `ALIVE` set, and does not have `INCAP`, `LEDGED` or
  `PINNED`. A pinned player's view is not theirs.
- The ghost has `PRESENT` and `GHOST` set.
- Distance is above `D_MIN` (300 units). Very close coincidences are common and worthless.
- The frame is at least `SPAWN_GRACE` (5 seconds) after the round's first frame.
- No non-ghost target lies within `OCCLUDE_WINDOW` (15 degrees) of the same bearing. The
  analyzer has no line of sight, so it cannot tell whether the survivor is looking at a
  visible SI, a teammate being attacked or a common that happens to sit in the same
  direction as the ghost. When something visible is in the way, the frame proves nothing
  and is dropped.

### The aim prior, which is what makes occupancy mean anything

Spawns are not uniform. Some spots are obviously better than others, players learn them,
and they pre-aim them. So "this player aims where SI actually are" is contaminated by map
knowledge, and a raw occupancy number ranks the people who know the map best. Controlling
for it is not a refinement, it is the difference between a working metric and a list of
your good players.

The control is empirical and comes out of the same replay files, so it costs no new data.

Grid each map into `CELL` (256 unit) cells in XY, ignoring Z. Pooled over every round ever
recorded on that map, compute `aimPrior(c)`: the fraction of survivor-frames in which some
survivor's yaw wedge covers cell `c`. That grid is "the obvious spots", derived from
behavior rather than hand-labeled, and it already contains every place people stare because
SI tend to come from there.

The prior is built **excluding the subject player's own frames**, so a cheater cannot
inflate the baseline they are measured against.

Occupancy then becomes a calibration test rather than a count. Over the eligible frames of
a player-round, with the ghost in cell `c`:

- `expected` is the sum of `aimPrior(c)` across those frames: what map knowledge alone
  predicts.
- `observed` is the count of frames where the player was actually within `E_DWELL` of the
  ghost.
- The statistic is the excess of observed over expected, as a z-score against the binomial
  spread of `expected`.

A player exploiting nothing but map knowledge scores zero excess **by construction**,
because the prior already contains their map knowledge. Aiming at a ghost sitting in the
famous doorway earns almost nothing, since everyone aims there. Being on a ghost that is
somewhere nobody normally looks is worth a great deal, and that falls out of the same
arithmetic without a second mechanism: rare cells have a low prior, so they carry most of
the excess.

**Data sufficiency.** A map with fewer than `MIN_PRIOR_ROUNDS` (20 player-rounds) gets no
occupancy score at all, only correlation. With roughly 35 matches in hand, several maps
will not qualify, and scoring them off a thin prior is worse than not scoring them. The
analyzer records which maps were skipped and why.

**Known weakness.** Without geometry the yaw wedge does not stop at walls, so the prior and
the occupancy both include aim that is really into a wall. This inflates both sides of the
comparison rather than one, so it costs sensitivity rather than creating false positives.
The plugin phase has real traces and does not inherit it.

### The metrics

**A. Tracking correlation.** The backbone, and the one the owner's spawn-knowledge
objection does not touch at all. Over a sliding window of `W` frames (20, which is 2
seconds at 10 Hz) in which the same ghost stays eligible throughout and `|err|` stays under
`E_TRACK` (12 degrees) throughout, the Pearson correlation between the survivor's
frame-to-frame yaw delta and the frame-to-frame delta of `bearing(s, g)`.

Pre-aiming a spawn spot is a static crosshair. It has no variance, so it cannot correlate
with anything, and it scores near zero no matter how well chosen the spot was. Following an
invisible target that is moving scores high, and the more the ghost moves the harder the
result is to produce by accident.

Recorded per player-round: the maximum window correlation and the 95th percentile of window
correlations.

**B. Prior-corrected occupancy.** The z-score defined above. Replaces the "relative aim
share" and "near-miss dwell" metrics of the first draft, which measured map knowledge as
much as anything else.

**C. Team-relative occupancy.** B computed for every alive survivor in the round, expressed
as this player's rank and gap against their own team. A second control on a different axis
from the prior: the prior removes what is normal for the map across all history, this
removes what was normal for this specific round, including whatever the director happened
to do that game.

### Anti-metrics, written down so nobody adds them later

Accuracy, headshot rate, kills, damage per shot, skeet rate, and every other measure of
outcome quality. These measure skill. A list sorted by any of them is a list of your best
players, which is the exact failure this design exists to avoid. They may appear in the
admin UI as context next to a flagged clip. They must never enter the composite.

### Clips

A window qualifying under metric A above `CLIP_MIN` correlation becomes a candidate clip:
start and end `tMs`, the ghost's slot, the correlation, the mean `|err|`, the mean
distance. Up to `CLIPS_PER_ROUND` (5) highest-scoring, non-overlapping windows per
player-round are kept.

The ten constants above (`D_MIN`, `SPAWN_GRACE`, `OCCLUDE_WINDOW`, `CELL`,
`MIN_PRIOR_ROUNDS`, `W`, `E_TRACK`, `E_DWELL`, `CLIP_MIN`, `CLIPS_PER_ROUND`) live in one
exported object so tuning is a single edit and the tests can pin them.

## 2. Storage and scoring

Schema goes in `src/db.ts` with the rest, as `CREATE TABLE IF NOT EXISTS` plus the
existing `addColumn` helper. There is no migration framework here by design.

```
integrity_rounds   (match_id, ordinal, half, slot) PRIMARY KEY
                   steamid, analyzer_version, metrics TEXT (JSON), computed_at

integrity_clips    id PRIMARY KEY, match_id, ordinal, half, slot, steamid,
                   start_ms, end_ms, kind, score REAL, detail TEXT (JSON),
                   analyzer_version

integrity_reviews  (match_id, ordinal, half, slot) PRIMARY KEY
                   state TEXT ('new'|'reviewed'|'dismissed'), note,
                   reviewed_by, reviewed_at

integrity_aim_prior (map, cell_x, cell_y) PRIMARY KEY
                   p REAL, frames INTEGER, rounds INTEGER, analyzer_version
```

`integrity_aim_prior` is the cached grid from section 1. It is derived, so it is rebuilt
wholesale rather than updated incrementally, and it is rebuilt whenever new rounds land for
a map or the analyzer version changes. A map spanning 16000 units each way is about 4000
cells at 256 units, so the whole pool across every campaign is tens of thousands of rows.

Order matters when recomputing: the prior must be rebuilt before any round is scored
against it, because a player's own frames are excluded from their prior and the exclusion
is computed at scoring time from `frames`.

**Clips are derived and disposable; review state is not.** A re-analysis deletes and
rewrites every row in `integrity_rounds` and `integrity_clips` for the rounds it covers.
If review state lived on a clip it would be destroyed by the first threshold change, which
is exactly the change the design is built to allow. So review attaches to the player-round,
which is stable regardless of how the clips inside it are recomputed.

`analyzer_version` is a constant bumped whenever a metric changes meaning, so stale rows
are identifiable without guessing from `computed_at`.

**Scoring** happens at read time in `src/integrity/score.ts`. Each metric becomes a
percentile against the population of all player-rounds in the same season, and the
composite is the mean of those percentiles. Nothing is stored. A threshold change is a
page refresh, not a migration.

**Where it runs.** A job after `recordMatchReplays` in the existing post-match path, plus
`scripts/backfill-integrity.ts` to walk every replay on disk. The backfill is how the
first baseline gets built, and it needs no deploy: it reads files and writes rows.

## 3. Admin Integrity tab

Routes in `src/routes/admin.ts`, alongside the existing ones and behind the same guard:

- `GET  /api/admin/integrity`: player rows for a season, per-metric percentiles, composite,
  clip counts by state, sorted by composite.
- `GET  /api/admin/integrity/:steamid`: that player's rounds and clips.
- `POST /api/admin/integrity/:matchId/:ordinal/:half/:slot/review`: state and note.
  Audit-logged through `src/admin/audit.ts` like bans and settings already are.

`web/src/routes/admin/AdminIntegrity.tsx` follows the existing admin page patterns and
`useAction.ts`. A player opens to their clips; each clip deep-links into the replay viewer
at its start tick, shows the numbers that flagged it, and shows the `demo_gototick` from
section 4 for review in game.

The composite renders with its label stating plainly that it is theoretical and ranks
rather than accuses. This is admin-only and never appears on a public page.

## 4. Replay format version 4 and the demo tick

**The problem.** Frames and timeline entries store `tMs`, milliseconds since the replay
opened (`src/replayFormat.ts:361`). The replay file opens at round start, one per half
(`RplOpen`, `plugin/pug-match.sp:895-1003`). The demo is started at map load, one per map, covering both
halves (`plugin/pug-match.sp:2527`). The gap between those two moments is recorded nowhere,
the header carries only a one second `GetTime()`, and a Source demo holds no wall clock
inside it. The offset cannot be recovered from existing files, which is why the owner chose
to wait for a format change rather than take a version with a hand-entered base tick.

**The change.** `HEADER_BYTES` goes from 160 to 168:

| offset | bytes | field |
|---|---|---|
| 160 | 4 | `demoTick`, uint32: `GetGameTickCount()` at replay open minus the tick when `tv_record` started for this map |
| 164 | 1 | `ticksPerSecond`, uint8: `RoundToNearest(1.0 / GetTickInterval())` |
| 165 | 1 | `demoTickFlag`, uint8: 1 when the offset is real |
| 166 | 2 | spare, zero |

The plugin stores the game tick in a global at `StartMatchDemo()` and subtracts at replay
open. When the running demo is not one we started, such as a `tv_autorecord` file, the
offset is meaningless, so the flag stays 0. That is the same pattern `sidesFlag` already
set at offset 157, and the reader treats it the same way: absent means "do not show",
never "show zero".

`parseReplay` branches on version. Version 3 and earlier decode exactly as today with
`demoTickKnown` false, which is the honest answer for every match recorded before this
ships. Old files can never gain the number.

**Bookmarks.** `demoTick + round(tMs * ticksPerSecond / 1000)`, computed in
`web/src/replay/bookmarks.ts` with unit tests on the conversion. The rail and the stats
panel render a click-to-copy `demo_gototick N` on each bookmark, hidden entirely when the
flag is clear.

## 5. The `l4d_integrity` plugin, measure only

New plugin in `plugin/`, built and staged by the existing `build.sh` and `stage.sh`. It
writes a sidecar `pug_<token>_<ordinal>_<half>.itg` beside the replays, using the same
filename convention so the backend pairs them the way `discoverMatchReplays` already pairs
replay files, with no datagram announcing anything.

What it measures, per tick in `OnPlayerRunCmd`:

- Yaw and pitch deltas into a short per-client ring buffer. This is aim snap, which 10 Hz
  cannot see: a snap happens inside one 100-tick frame.
- `IN_ATTACK` press edges into an inter-press interval histogram, bucketed per weapon id.
  This is both the pistol script detector and the data the clamp threshold will be chosen
  from.
- On `weapon_fire` and `player_hurt`, the preceding N tick deltas are snapshotted so a shot
  carries its own approach profile.

Two of those deltas matter more than the rest, and both are information-boundary metrics in
the sense of decision 5. Neither is possible at 10 Hz, which is why they live here.

- **Reaction after line of sight opens.** The tick at which an SI first becomes visible to a
  survivor, and the delay until that survivor's crosshair arrives within `E_DWELL` or until
  they fire. Human reaction has a biological floor around 150 to 200 ms. Consistently
  landing inside 80 ms is not fast reaction, it is foreknowledge, and unlike every skill
  metric this one is bounded by the human rather than by practice. Recorded as a
  distribution per player, never as a single event: one fast reaction is a guess that paid
  off.
- **Silent aim, the one-tick excursion.** The view angle spikes onto a target for exactly
  the tick of the shot and returns on the next tick. No human produces a one-tick angular
  excursion synchronised to their own trigger pull. This is the strongest aimbot signature
  available and it is strictly better than raw snap speed, which a good flick can imitate.
  A related and weaker form: a flick with no settle. Humans overshoot and correct, so the
  tell is the missing correction phase rather than the speed of the approach.

Line of sight, which is the part the analyzer cannot do, extends the ghost metric to live
SI tracked through walls. **Traces are not free and this server's tickrate history is a
crash history** (`cfg/Reloadables/server_custom_convars.cfg` carries the 128 tick segfault
record). So: a cheap yaw gate first, `TR_TraceRay` only for players already inside the
angle threshold, and the trace pass at 20 Hz rather than every tick.

The sidecar is line-oriented text, one record per line as `key=value` pairs, not a packed
binary format. The replay file is packed because it holds tens of thousands of frames and
is served to a browser; this one holds a few hundred aggregate lines per round, so
SourcePawn writing it and TypeScript parsing it should both be trivial and readable by eye
during bring-up. It holds aggregates and worst windows only. There is no per-tick dump and
the file size is bounded by construction. Note that the RCON dump path is not used for any of
this: `l4d1-rcon-multipacket-incident` is what a dump over 4 KB does.

Cvars: `sm_integrity_enable`, `sm_integrity_hz`, `sm_integrity_dir`, and
`sm_pistol_min_interval` defaulting to **0, meaning measure only**. When it is set
non-zero, the plugin writes `m_flNextPrimaryAttack` on the weapon after each shot to
enforce that floor. That is a server-authoritative clamp needing no client cooperation.
Two things go in the runbook when it is turned on: clipped shots still play the fire
animation client-side because of prediction, so the floor must be tuned to real human
clicking rather than to the theoretical cap; and it is a balance change, so it belongs to
the ruleset versioning that the deferred balancing tab will own.

## 6. Order of work

Each step is useful alone and the in-game risk is last.

1. Analyzer, tests, backfill script. No deploy. Produces the first baseline from the
   matches already on disk, which is also the only honest way to pick thresholds.
2. Admin Integrity tab against those rows.
3. Format version 4: plugin stamp, decoder, bookmark display.
4. `l4d_integrity` plugin, measure only.
5. The pistol floor, chosen from a week of data, then the clamp.

Nothing goes near the Dallas box without an explicit go-ahead. The plugin steps follow the
order already learned: `deploy-web.sh`, then `plugin/stage.sh` on an empty server, then
re-assert `sm_pug_auto_track` and `sm_pug_roster_at_live`.

## 7. Verification owed

- **SourceTV demo tick base.** Whether a demo's ticks start at 0 or at the server tick that
  was live when recording began. Checkable offline by parsing a `.dem` header and first
  frame on the box, no game needed. Do this before writing section 4, because it decides
  whether `demoTick` is the whole answer or needs a constant.
- **False positive rate before any admin sees a number.** Run the backfill, look at the
  distribution across all existing matches, and confirm the top of the list is not simply
  the best players. If it is, the metric is measuring aim quality and not wallhacking, and
  the relative scoring in metric B is where the fix goes.
- **Tick cost of the plugin.** `l4d_tickstats` p99 before and after, against the 11.25 ms
  baseline.
- **Eye height.** The analyzer assumes a fixed eye offset and no crouch state. Confirm the
  yaw-only design actually sidesteps this rather than merely reducing it.
- **That the aim prior actually absorbs spawn knowledge.** The direct test: compute
  occupancy with and without the prior correction over the same history. If the two
  rankings agree, the prior is doing nothing and the correction is not working. They should
  disagree, and the players who fall furthest when the prior is applied are the ones whose
  raw score was map knowledge.
- **Prior coverage.** How many maps clear `MIN_PRIOR_ROUNDS` against the current history.
  If it is only two or three, occupancy is not yet a usable metric and correlation carries
  the whole retrospective pass until more matches accumulate. That is an acceptable
  outcome and should be reported rather than worked around by lowering the threshold.
