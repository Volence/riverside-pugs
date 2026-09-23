# Spawned-infected wallhack detection: design

2026-09-23. Owner asked, after a report that a player was "walling", whether detection could cover
spawned infected and not just ghosts. Approach B (live line-of-sight checks in the plugin) chosen
over A (rebuilding map geometry on the site). Sections 1 to 3 of this design were approved in chat.

## Why

The replay analyzer (`src/integrity/`, analyzer version 4) only scores survivors against **ghost**
infected. A ghost is invisible whatever the geometry, so the analyzer needs no walls. A spawned
hunter crouched behind a wall is where a wallhack actually pays, and whether a survivor was aiming
*through a wall* or *at something they could see* depends on geometry the replay does not carry.

Reconstructing geometry on the site (approach A) was rejected because it gets the two hard cases
wrong in the direction that hurts innocent players: props (cars, dumpsters, trucks) are not world
brushes, and see-through surfaces (fences, grates, windows) are solid brushes. It would also need
per-map work for every custom campaign.

## Goals

1. Record, for every replay frame, which spawned infected each survivor could actually see.
2. Score survivors on tracking, pre-aiming and reaction against **hidden** spawned infected,
   against the league, the way the ghost metrics already do.
3. Make the existing ghost tracking tolerant of human reaction lag (known weakness, see below).
4. Surface flags on the admin Integrity tab only, until a calibration session has set thresholds.

## Non-goals

- Past matches. Recording starts with the plugin deploy; history stays ghost-only.
- Infected-side wallhacks. L4D1 already shows survivors to infected through walls.
- Any automatic action. A flag is a pointer to a replay moment for a human to judge. No ban,
  kick, rating change or Discord post comes from a score.
- Per-tick aim metrics (snap, silent aim). That is the separate `l4d_integrity` plugin on the
  anticheat roadmap and needs tick-rate data, not 10 Hz.

## 1. Recording line of sight (plugin)

**What is checked.** At each replay frame (10 Hz, the existing sampler), for every living survivor
and every living, **non-ghost, human-controlled** infected, the plugin traces from the survivor's
eye (`GetClientEyePosition`) to three points on the infected: head (eye position), chest (origin
+ 36 z) and feet (origin + 8 z). The pair is **visible** if any one trace reaches its point.
Generous by design: an infected whose head clears a wall is visible, so aiming at it can never
count as aiming through a wall.

**What blocks a trace.** `MASK_VISIBLE` (opaque world brushes, opaque entities, moveable doors).
It excludes `CONTENTS_WINDOW` and `CONTENTS_GRATE`, so fences, grates and glass do not block,
matching what a player sees. A trace filter ignores every client and every `infected` (common)
entity: a common walking between the two is not a wall. Smoker smoke and boomer bile are not
geometry and do not block; the result is that aiming at an infected hidden only by smoke counts
as visible, which is the conservative direction.

**Skipped pairs.** Bots on either side; a survivor pinned by that infected (they obviously know);
incapacitated or ledge-hanging survivors; the tank (loud and enormous, no information advantage).

**Cost.** At most 4 survivors x 4 infected x 3 traces x 10 Hz = 480 traces a second, early-exit on
the first clear trace, so typically far fewer. Must be measured before shipping: run a bot-filled
round on the local test server with `l4d_tickstats` and compare p99 frame time against the 11.25 ms
baseline. Budget: no measurable change in p99. If it shows up, drop to two points (head, chest).

## 2. Replay format version 4

Two changes ride one version bump, because version 4 was already reserved for the demo tick
stamp (see the viewer bookmarks work).

**Per-frame visibility block.** Frames grow by 8 bytes, placed immediately after the player block
and before the entities: byte *i* is a bitmask over roster slots, bit *j* set when slot *i* could
see slot *j* this frame. Only survivor rows carry bits, and only for spawned human infected; every
other byte is 0. Frame size for version 4 is `8 + 160 + 8 + entities * 12`.

**Header growth for the demo tick.** The header grows from 160 to 192 bytes. New fields at 160:
`demoStartTick` (u32, `GetGameTickCount()` when the match demo started) and 164: `replayOpenTick`
(u32, the same at replay open). Bytes 168 to 191 are reserved zero padding. Offsets below 160 do
not move, so the byte-serving route's token blanking and the sides mask are unchanged.

**Readers.** `replayFormat.ts` branches on `version`: version 3 files decode exactly as today
(no visibility, 160-byte header); version 4 decodes the block into `frame.sees: number[8]`. The
encoder writes version 4. Everything that reads frames (viewer, live push, analyzer, `replayTail`)
goes through `decodeFrames`, so one branch covers them; the plan must still grep for any reader
that hardcodes `HEADER_BYTES` or the frame stride. The SourcePawn writer and the TypeScript encoder
must agree byte for byte, closed by an encode/decode test on a real v4 file pulled from the local
test server.

## 3. The checks (analyzer version 5)

All scores compare a player against the league, like the ghost metrics. All share the existing
gates (`D_MIN` 300, `R_MAX` 2000, `SPAWN_GRACE_MS`, pitch tolerance) plus two new ones:

- **Hidden:** the pair's visibility bit is 0 for this frame.
- **Hidden from the whole team:** no *other* survivor can see that infected either. If a teammate
  can see it, the survivor may simply have heard a callout, and voice is the biggest legitimate
  source of information about hidden infected. This gate costs samples but removes most of that
  confound.

**Lag tolerance, all tracking metrics (ghosts included).** A human with a wallhack follows the
target slightly late. Tracking fidelity is evaluated at lags of 0, 100, 200, 300 and 400 ms (0 to 4
frames at 10 Hz) and the best lag is kept, with the lag stored. Searching lags makes a chance
match easier, so the chance baseline must run the identical search: the null model and the
synthetic-tracker tests both get the lag search, or the scores inflate.

**Metric D, hidden tracking.** Metric A (tracking fidelity, lag-tolerant) on spawned infected
while hidden from the whole team. Same windows, same `CLIP_MIN` machinery, clip kind
`hidden_track`.

**Metric E, hidden pre-aim.** Metric B (occupancy: observed on-target blocks against what the aim
prior expects for that map and position) on spawned infected while hidden from the whole team.
Reuses `aimPrior` and `occupancy.ts`; only the pair filter changes.

**Metric F, reveal reaction.** For each hidden-to-visible transition of an infected within range,
the time until that survivor's crosshair is within `E_TRACK` of it, capped at 1.5 s. The per-player
statistic is the share of reveals already on target at the reveal frame (reaction <= 0 ms),
compared with the league. 10 Hz makes this coarse (100 ms buckets), which is why the statistic is
"already on target", the one bucket 10 Hz resolves cleanly.

**Split by class.** Every metric is also reported per infected class (hunter, smoker, boomer).
Boomers and smokers are noisy and hunters are quiet when crouched, so a player far above the league
on hunters specifically is the strongest signal. Crouch state is not recorded, so class is the proxy.

**Minimums.** No per-player score is shown under `MIN_BOARD_ROUNDS` survivor rounds with v4 data,
and metric F needs at least 30 reveals. Until enough v4 rounds exist, the board says so rather than
showing numbers.

## 4. Surfacing

- The Integrity tab gains columns for D, E and F (with the class split in the row detail), and D's
  clips join the existing clip list with a deep link to the replay moment.
- The player file's analyzer timeline items include the new clip kind.
- **No admin-channel posts.** A settings toggle for Discord posts is added but defaults off, and
  is only switched on after calibration and a week of real matches shows how often normal players
  trip each check. This is the lesson of the macro detector's `pounce_spam` miscalibration.

## 5. Ghost threshold

The owner set `CLIP_MIN` from 0.7 to **0.4** on 2026-09-23 (no real player has exceeded 0.261;
simulated wallhackers only reach 0.7 in 7 to 17% of rounds). An uncommitted change in the
`clip-min` worktree sets it to 0.35 instead; whoever owns that worktree applies 0.4. It is a
read-time score, so it needs a re-score, not a re-measure. It ships ahead of everything else here.

## 6. Calibration

Before any threshold on D, E or F is trusted, and before the lag-tolerant ghost score replaces the
current one: a private session on the local test server (or Riverside #4 while empty), two people.
The survivor deliberately "walls" by following the infected's live position from voice callouts;
the infected plays hidden approaches as hunter (crouched), smoker and boomer, several of each.
Record it as a normal match, run the analyzer, and set each threshold so that session flags and
the league's history does not. Repeat with the survivor playing honestly as the negative control.

## 7. Rollout order

1. `CLIP_MIN` 0.4 (web only).
2. Plugin: LOS sampling + v4 writer, with the TypeScript v4 reader deployed **first** (a v4 file
   hitting a v3-only reader is the failure to avoid). Perf check on the local server before it.
3. Let v4 data accumulate. The ghost metrics keep running unchanged meanwhile.
4. Analyzer version 5 (lag tolerance, D, E, F) behind the board minimums; re-measure all rounds.
5. Calibration session, thresholds set, then the Discord toggle is considered.

## Coordination with other work

Other sessions work in this repo at the same time. Before planning or building, re-check:
- **`worktree-balance-analytics`** was adding a balance inventory scan and BALANCE lines to
  `plugin/pug-match.sp` on 2026-09-23 (3f57475), branched before 0.3.7 and still at version
  0.3.6. Both efforts touch `pug-match.sp` and the plugin version; whichever merges second rebases
  and takes the next version number.
- **`clip-min`** worktree holds the uncommitted `CLIP_MIN` edit (section 5).
- Anything else touching `src/integrity/`, `src/replayFormat.ts` or the sampler in
  `pug-match.sp`: `git log --since=... --all -- <those paths>` and `git worktree list`.

## Testing

- Format: encode/decode round trip for v3 and v4; a v3 file still decodes identically after the
  change; header offsets checked against a real v4 file from the local server.
- Plugin: on the local server with bots, a known wall between a bot hunter and a survivor gives
  bit 0, line of sight gives 1, a fence gives 1; tickstats p99 before and after.
- Analyzer: extend `scripts/inject-synthetic-tracker.ts` to plant a lagged tracker on a hidden
  spawned infected; D must flag it, the honest rounds around it must not. The lag search must
  not raise the league's own score distribution by more than the synthetic margin.

## Risks

- **Voice.** A teammate calling positions is legitimate and looks like walling. The team-hidden
  gate removes the common case (a teammate can see it); a teammate who *heard* it cannot be
  removed. This is why flags are pointers, never verdicts.
- **Sound.** Infected make noise; a good player aims at sounds. Only a sustained excess over the
  league, strongest on hunters, means anything.
- **See-through surfaces that are not marked see-through.** The trace mask trusts the map's
  contents flags. Some fences may be ordinary solid brushes or props with a translucent texture,
  which would block the trace while the player can see through them, the false-flag direction.
  The plugin test on the local server must check real fences on the stock maps, and any map found
  doing this needs its surfaces allowlisted before metrics D to F go live.
- **Coarse time.** 10 Hz limits reaction and lag resolution to 100 ms.
- **Sample size.** Hidden-from-team frames are a minority of frames. Scores will take weeks of
  matches per player to settle; the board minimums exist for that.
