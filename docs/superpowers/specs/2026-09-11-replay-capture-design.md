# Sub-project 6: Round-Aware Capture, Replay Recording, and Admin Storage

## What this is

The capture layer beneath a set of analytics pages. It persists three things a PUG
already produces and currently throws away: which team played survivor in each round,
when each notable event happened, and where every player was while it happened.

Written 2026-09-11. This is piece 1 of four; the other three are named under
"What this feeds" and are not designed here.

Large enough that the implementation plan will almost certainly stage it: plugin and
schema first, then ingest, then the admin panel. That staging is the plan's job, not
this document's.

## What this feeds

This spec captures data. It does not display any of it. Every stream below exists to
serve a specific display in a later piece, and nothing is captured speculatively.

| Stream | Feeds |
|---|---|
| Round and side (`match_rounds`) | Per-round survivor/infected splits on the match page and the player page (piece 2) |
| Event timestamps and vocabulary | Match timeline and killfeed (piece 3); clear latency, FF timeline, tank-fight segmentation (piece 4) |
| Position and state frames | Replay viewer, live and saved (piece 3); isolation, pacing, death heatmaps (piece 4) |
| Admin storage panel | Ships here, because this spec introduces pruning |

**The point of the project is the stat display**, specifically letting a player find the
games that went badly and see what the data says about why. Piece 1 is plumbing. If a
proposed capture does not feed a number someone would look up, it does not belong here.

### The four positional metrics this exists for

Named explicitly because they are the justification for 10Hz sampling, and because none
of them can be produced by any counter in `statKeys.ts`:

1. **Isolation.** Mean distance to nearest living teammate while alive. Getting caught
   out alone is the most common way a PUG survivor round dies and nothing currently
   measures it.
2. **Pacing.** Position along survivor flow relative to the team median. Persistently
   ahead is overrushing, persistently behind is lagging. Both are correctable habits.
3. **Death and incap heatmaps**, per chapter.
4. **Clear latency.** Seconds a teammate stayed pinned before being cleared. Derived from
   event timestamps rather than positions, but it lands in the same analytics surface.

All four work with no background map image. The map art is required for the replay
viewer in piece 3, not for these.

## Why now, and what it depends on

Capture is the only piece whose data cannot be recovered retroactively. Every PUG played
before this lands is permanently missing round sides, event timestamps and positions,
while every presentation piece applies to matches already in the database. That
asymmetry is the entire reason this is first despite shipping nothing visible.

**No dependency on skill_detect changes.** An earlier concern that skill stats had been
dead since 2026-09-08 was wrong.
`deploy/overrides/left4dead/cfg/pug_match.cfg:37-43` already loads `l4d2_skill_detect.smx`
and sets `sm_skill_report_enable 0`, so it is loaded and silent for ranked PUGs and
unloaded only for casual play. That is the correct scoping and needs no change.

**Merged into one plugin change on purpose.** Round capture, event timestamps and
position logging all touch `pug-match.sp`. Doing them as one change means one deploy to
a live box rather than three.

## Scope

### Round and side capture

Two new emissions on code paths that already exist. `OnRoundIsLive()` already marks a
half going live, `Event_RoundEnd` already closes it, `g_iPugSide[]` already holds the
pug-team to game-team mapping, and `StatsActive()` is already exactly the "capture is
valid right now" predicate. None of it is persisted today.

- `ROUND_START map=%s half=%d surv=%s` from `OnRoundIsLive`. `surv=` is OMITTED, not
  guessed, when the orientation mapping has not settled yet: `ROUND_END` is a single
  datagram with no retransmit, so a guess here survives as a fabricated side whenever
  that datagram is lost. Ingest records such a round unreliable and promotes it when
  `ROUND_END` supplies the real side.
- `ROUND_END map=%s half=%d surv=%s score=%d` from `Event_RoundEnd`. `map=` rides along
  so ingest can resolve the round's map ordinal by name; the half-2 `ROUND_END` is
  emitted immediately before `MAP_RESULT`, and those two reordering in flight would
  otherwise file the round on the next map.

`half` is read from `m_bInSecondHalfOfRound`, never counted. It was a counter, and a
re-fire of the go-live forward walked it past 2, which ingest rejects.

### Event vocabulary

| kind | actor, target, value | Feeds | Hook |
|---|---|---|---|
| `pinned` | SI, survivor, class | Clear latency, pin heatmap | new (`lunge_pounce`, `tongue_grab`) |
| `cleared` | survivor, survivor | Clear latency, paired with `pinned` | new (`pounce_stopped`, `tongue_release`) |
| `incap` | survivor, cause | Death heatmap, round timeline | new (`player_incapacitated_start`) |
| `death` | survivor, killer | Death heatmap, round timeline | existing (`player_death`) |
| `ff` | survivor, survivor, damage | FF timeline | existing (`player_hurt`) |
| `si_spawn` | SI, class | Spawn positioning, spawn-to-engage time | existing (`player_spawn`) |
| `tank_spawn` | player | Tank-fight segmentation | existing (`player_spawn`) |
| `tank_take` | player | Tank-fight segmentation. A human takes the tank over from the AI | new (`bot_player_replace`) |
| `tank_give` | player | Tank-fight segmentation. A human hands the tank back to the AI | new (`player_bot_replace`) |
| `tank_death` | tank, killer | Tank-fight segmentation | existing |
| `revive` | survivor, survivor | Round timeline | existing (`revive_success`) |
| `witch_aggro` | witch, survivor | Round timeline, pairs with `crowns` | new (`witch_harasser_set`) |
| `witch_killed` | survivor | Round timeline | new (`witch_killed`) |
| `car_alarm` | player | Round timeline, blame | new (`triggered_car_alarm`, UNVERIFIED on L4D1) |
| `skeet`, `boom`, `dp` | as today | Killfeed timing only | existing / skill_detect |

`heal` is absent because kits are disabled in this ruleset, pills only. Pill detection
is deferred (see Deferred below).

`car_alarm` is UNVERIFIED and may not fire on L4D1. An earlier revision of this document
claimed `triggered_car_alarm` was proven because `l4d2_skill_detect.sp` hooks it. That was
wrong: at `l4d2_skill_detect.sp:559` the hook is both commented out and gated behind an
L4D2 version check, so its author evidently believed the event is L4D2 only. Caught during
plan 6a implementation. The hook is registered anyway, defensively (see below), and if it
never fires the fallback is the original approach: an entity hook on `prop_car_alarm`,
which `Rotoblin-AZMod/SourceCode/scripting-az/l4d_car_alarm_hittable_fix.sp:67` already
demonstrates. Confirm in game before relying on the event.

Tank passing uses `player_bot_replace` and `bot_player_replace`. An earlier revision named
`player_replace`, which exists nowhere in either reference tree. `player_bot_replace` is
used by `l4dscores.sp`, `l4d_collision_adjustments.sp` and `l4d_useful_upgrades.sp`, and
`L4D1_2-Plugins/l4d_tank_pass/scripting/l4d_tank_pass.sp` is the reference for the handover
itself.

**The event list cannot be settled from the filesystem.** L4D1 defines events partly inside
VPK archives, so grepping the loose `resource/*.res` files reports `player_bot_replace` and
`witch_killed` as absent even though plugins hook both successfully in this deployment.
Anyone tempted to "verify" an event name that way will get a confident wrong answer.

Because of that, every event hook added by this work uses `HookEventEx` rather than
`HookEvent`. `HookEvent` on an undefined event raises a native error, and raised inside
`OnPluginStart` that aborts plugin load, which would take down roster enforcement, scoring
and reporting for every ranked PUG. `HookEventEx` returns false instead, and a failure is
logged once by name. An absent event then costs one telemetry stream rather than the match
system. The hooks that predate this work stay on plain `HookEvent`: they are proven in
production and changing them buys nothing.

### Position and state frames

10Hz sampling of the 8 rostered players: position, facing, health, state
(alive/incap/ledged/dead/pinned/biled/burning), class, weapon and ammo.

### Admin storage panel

First admin surface in the app. A generic `requireAdmin` guard and page shell, with
only the storage view behind it.

### Deferred

- **Pills taken.** Detectable as a temp-health jump, but `temphealthfix.sp` in
  Roto-AZMod already modifies temp health behaviour, so the threshold must be read from
  the live pill value rather than hardcoded. Not worth blocking v1 on.
### Reinstated 2026-09-11: world entities are in scope after all

Reversed the same day it was decided, on evidence. The user demonstrated suprep's existing
viewer at https://l4dpug.com/player.html, which already renders all of it: individual
common infected (its status bar reports a live `common` count), the tank rock as an entity
with its flight path drawn, ghost SI visually distinguished from spawned SI with per-entity
health and entity ids, the witch, per-player view-direction lines, and per-player weapon
and ammo.

That settles the cost question empirically. The worry behind deferring these was that
per-frame entity iteration would be too expensive on a 100-tick server. A working viewer
fed by a plugin on the same hardware is a stronger argument than my estimate, so the
estimate loses.

Consequences, all landing in plan 6b, which is not yet written:

- The frame format needs a variable-length entity section after the fixed player block,
  not merely reserved space. Entity count varies per frame, so the fixed-stride property
  holds only for the player block; the file needs a per-frame entity count and the seek
  index has to account for it.
- Ghost versus spawned is a state bit on an SI, not a separate entity kind. Ghost position
  is also the most competitively sensitive data in the file, which makes the
  server-side live delay load bearing rather than merely prudent.
- View direction is already covered: yaw and pitch are in the player record.
- Per-entity health is needed for the witch and the tank, so the entity record carries
  health, not just position.

Both of these were open until 2026-09-11 and are now settled under "6b resolutions"
below: commons are captured individually at the full player rate, and the entity rate
stays a separate cvar so the measurement can still move it.

### Non-goals for v1
- **Any display of this data.** Pieces 2 through 4.
- **Map background images.** Piece 3. The four analytics metrics do not need them.
- **Per-round stat snapshots.** See the decision below; they turn out to be unnecessary.
- **Common kills as events.** Hundreds per round, feeds nothing anyone looks up.

## Decisions

### Three streams, three transports

Round facts are low-volume and must be exact, because a wrong side mapping corrupts
every downstream attribution; they ride the existing UDP log line into a new table.
Events are sparse and heterogeneous and tolerate loss; they ride the existing `EVENT`
line into `match_live_events`. Frames are dense, uniform and highly loss-tolerant; they
go to a file the plugin writes directly.

**Events are not in the replay file.** The viewer composes the two by timestamp. This
keeps the file a pure fixed-stride array so seeking is arithmetic rather than scanning,
and keeps events in SQLite where analytics can query and rank them. The killfeed overlay
and the clear-latency metric then read the same rows.

### Counters stay authoritative for totals; events carry timing only

Never derive a total by counting events. The event feed rides lossy UDP, so counting it
would produce numbers disagreeing with `match_player_stats` and create two sources of
truth for "how many skeets". This is the discipline the boomer attribution comment in
`plugin/pug-match.sp` already follows. Events answer *when* and *in what order*, never
*how many*.

### Round-relative timestamps, not wall clock

An event row gains `half` and `t_ms`, milliseconds since that round went live, alongside
the `map_ordinal` it already carries. Replay frames are indexed the same way. The viewer
then aligns motion and events by arithmetic with no clock synchronisation, and analytics
get "4:32 into the round" for free.

### No new stat snapshot table

Per-round side attribution appears to need per-round stat snapshots. It does not.

Every key in `src/statKeys.ts` already declares a `side`, and survivor stats can only
accrue while the player is survivor. Given `match_rounds.surv_team`, the existing
per-map snapshots in `match_live_map_stats` therefore already yield per-round
attribution: a team's survivor stats on a map came from whichever half they held
survivor, and their infected stats from the other. The five fixed columns on
`match_players` (`si_damage`, `si_kills`, `common_kills`, `ff_dealt`, `revives`) are all
survivor-side, so the partition holds across the whole schema.

This breaks if a round is restarted after stats accrued, or a player changes team
mid-match. Neither is detected yet, and this is the honest state of the column: nothing
in the plugin or the ingest path notices either case, so `match_rounds.reliable` cannot
report them. The suppressions that DO exist are narrower:

- `recordRoundStart` stores `reliable = 0` for a round whose `ROUND_START` carried no
  side at all, and `ROUND_END` promotes it back to 1 when it supplies the real one.
- `roundAttribution` forces both halves of a map unreliable in its return value when
  they fail to partition the sides (both recorded as the same team on survivor).

So `reliable = 1` means "nothing has shown this round to be wrong", not "this round has
been verified". Detecting restarts and mid-match team changes is outstanding plugin
work; until it lands, a consumer that treats a reliable round as guaranteed correct is
trusting more than this column can deliver.

The test named under Testing is what this decision rests on. If it fails, this section
is wrong and a snapshot table is needed after all.

### Side is stamped at both round start and round end

The orientation logic in `pug-match.sp` exists precisely because the mapping is
unreliable early in a round. The round-end value is authoritative; ingest compares the
two and logs a disagreement rather than silently trusting the provisional one.

### Files on disk with a DB index, not blobs in SQLite

Live tailing needs an appendable file a second process can follow, which SQLite cannot
provide, so the file exists either way. Putting the bytes in the database is therefore
strictly additional machinery, and it has to earn that. It does not:

- `better-sqlite3` is synchronous, so pulling a 4 MB blob blocks the event loop for its
  duration, including live WebSocket traffic and the log listener.
- A static file gets HTTP range requests, caching and sendfile for free. A seeking
  viewer needs those.
- The DB is in WAL mode; 4 MB inserts would make replays the dominant content of a file
  that is otherwise counters and text, and every backup a multi-GB copy of immutable data.
- A crash mid-round truncates one file rather than damaging the database that holds
  ratings.

`match_replays` mirrors `match_demos`: bytes on disk, one index row per file. The row
outlives the file so the UI can say "replay expired" rather than 404.

### Binary fixed-stride frames

Chosen for plugin cost more than for size. Text means eight `Format()` calls with float
conversion per sample; packing bytes is a handful of Pawn ops. Fixed stride also makes
seeking O(1) arithmetic and makes a truncated file trivially recoverable by rounding
down to the last whole frame.

### One file per round

The survivor/infected mapping is constant within a round, and a round is the natural
unit of "let me look at that again". A map view plays two files in sequence. Naming
follows the demo precedent so the file-to-match link is a property of the filename and
survives a backend restart or a lost datagram: `pug_<token>_<ordinal>_<half>.rpl`.

### Live delay is enforced server-side

The 10 second delay is anti-ghosting, not buffering. A live top-down view showing every
infected player's position is perfect information for anyone watching a ranked PUG on a
second monitor. If the client delays, someone reads the WebSocket directly and ghosts.
The backend therefore never sends a frame newer than `now - delay`.

### Map imagery comes from nav meshes first, screenshots second

Recorded here because it determines whether piece 3 is blocked on art. It is not.

The install carries 318 `.nav` files (magic `0xFEEDFACE`, version 13). A nav mesh is the
walkable footprint as quads with corner heights, so projecting it to 2D yields a
schematic top-down for every map with no manual work. `cl_leveloverview` screenshots
then upgrade the background one map at a time, and because that mode reports world
origin and scale, the world-to-image transform is derived rather than eyeballed.

The nav mesh also carries per-area flow distance, which is the pacing axis directly. It
makes "ahead of or behind the team" exact rather than inferred from raw XY, matches what
the patched `l4d_current_survivor_progress` already computes, and sidesteps vertical
overlap for analytics because flow is one-dimensional. Confirming which fields nav v13
exposes is a one-hour spike before relying on it.

Vertical overlap is accepted rather than solved. A flat top-down drops Z, so places at
the same X,Y and different heights share a pixel. No Mercy 4's hospital interior is the
worst case, an elevator ride through floors on one footprint; most L4D1 chapters are
linear and ground-level, so it is the outlier.

Decided 2026-09-11: **scale the player avatar by height**, roughly plus or minus 20%.
Higher reads as closer to an overhead camera, so it matches the intuition the view
already creates, and it separates a rooftop from the alley beneath it without a layer
system or a UI. If one map is still unreadable, dim anything far outside the survivor
team's current height band; the team is nearly always together.

The analytics are unaffected either way. Isolation uses true 3D distance, pacing uses
one-dimensional nav flow, and heatmaps can bin by height. Only the viewer sees a flat
image.

### Retention is 90 days, controllable from the browser

Roughly a season. At 30 PUGs a week this is about 1.5 GB steady state. Retention
settings live in the existing `settings` table rather than in env, so they are
changeable without a redeploy, exactly as `map_pool` and `ready_seconds` already are.
Env supplies defaults only.

### The admin panel ships with this piece

Shipping a retention policy with no visibility into what it is deleting is how a second
disk incident happens. This box has already had one: `tv_autorecord` filling the disk at
~1.7 GB/day recording an empty server, 7.76 GB pruned by hand on 2026-09-10, root cause
still open.

Those demos are orphans, files with no matching pug token, and `discoverMatchDemos`
already distinguishes them by the `pug_<token>_...` convention. Classifying every file
as belonging-to-a-match or orphaned is the diagnostic that has been missing, so this
panel closes an open incident rather than only serving the new feature.

The `requireAdmin` guard and page shell are built generically. Once an admin surface
exists, invite code, map pool, ready timers and bans will all want to live there. Build
the door properly, ship only the storage room.

## Data flow

```
pug-match.sp
  OnRoundIsLive    -> ROUND_START (udp)  -> match_rounds
                   -> open pug_<token>_<ordinal>_<half>.rpl
  Timer 0.1s       -> 8+128+12N frame    -> replay file (no flush)
  hooks            -> EVENT ... t_ms     -> match_live_events
  Event_RoundEnd   -> ROUND_END (udp)    -> match_rounds
                   -> close file (indexed by filename, no datagram)

pug-web
  live:  tail open file -> hold to now-10s -> websocket
  saved: static file + range requests
  daily: prune job over settings-driven windows
  admin: /api/admin/storage, /api/admin/storage/prune, /api/admin/settings
```

### Schema additions

```sql
CREATE TABLE match_rounds (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  ordinal    INTEGER NOT NULL,
  half       INTEGER NOT NULL,
  surv_team  TEXT NOT NULL CHECK (surv_team IN ('a','b')),
  score      INTEGER NOT NULL DEFAULT 0,
  reliable   INTEGER NOT NULL DEFAULT 1,
  started_at TEXT, ended_at TEXT,
  PRIMARY KEY (match_id, ordinal, half)
);

CREATE TABLE match_replays (
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  ordinal     INTEGER NOT NULL,
  half        INTEGER NOT NULL,
  filename    TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  frames      INTEGER NOT NULL,
  sample_hz   INTEGER NOT NULL,
  pruned_at   TEXT,
  PRIMARY KEY (match_id, ordinal, half)
);
```

`match_live_events` gains `half` and `t_ms` via the existing `ensureColumn` helper, which
is the established pattern here; there is deliberately no migration framework.

### Replay file format

Header, 160 bytes fixed, including reserved space: magic `L4RP` and version, the 32
character match token, map ordinal, half, player sample rate, entity sample rate, map
name, wall-clock start, the slot table mapping roster slots 0 to 7 to SteamID64, and the
keyframe index's own offset and count. Frames reference slot indices, which is where most
of the size saving comes from.

The index offset and count are zero until the round closes, because their values are not
known until then. The writer seeks back to the header and fills them in as its last act,
so a file that was never closed is self-evidently indexless rather than carrying a
plausible but wrong offset.

Everything in the file is explicit little-endian, byte by byte. Nothing is written as a
native word, so the parser never has to agree with the game server about endianness or
struct padding.

Frame, variable length, repeated. Three parts:

1. **Frame header, 8 bytes**: `t_ms` as uint32, an entity count as uint16, and 2 bytes
   reserved. The count is what makes the frame self-describing.
2. **Player block, 128 bytes fixed**: eight 16-byte records of position as three int16,
   yaw as int16, pitch as int8, health as uint16 (the tank needs the range), a state
   bitfield, class, weapon and ammo. Always eight, even when a slot is empty, so this
   block alone stays fixed-stride.
3. **Entity block, 12 bytes per entity**: entity reference as uint16, kind as uint8, a
   state bitfield as uint8, position as three int16, and health as uint16.

   Corrected 2026-09-11. This record was specified as 8 bytes carrying no health, which
   was wrong twice over. The listed fields summed to 10 bytes, not 8, so every size
   estimate built on the 8 was low. And the same revision that reinstated world entities
   states two paragraphs earlier that "the entity record carries health, not just
   position", which the 8-byte layout then contradicted by pushing an AI boss's health
   into the high bits of the state byte. That hack would have given a witch roughly four
   bits of health resolution. A uniform 12-byte record with a real uint16 health costs
   360 bytes per frame at 30 commons, which is what the size estimate below already
   assumed, and it removes the special case entirely.

   **Entities cover every actor that is not a rostered player**, which is AI tanks,
   survivor bots, AI special infected, the witch, the tank rock and commons. The player
   block therefore stays exactly the eight roster slots and never has to decide whether
   a bot has inherited a slot. This is what makes a thin game legible: with one human
   connected, seven slots are empty and every survivor on screen is an entity record.

Revised 2026-09-11 when world entities came back into scope. The earlier design was a
flat 132-byte fixed-stride frame with "reserved space" for entities, which does not work:
entity count varies per frame, so no fixed stride can hold them.

**The cost of variability is seeking.** A fixed-stride file lets a viewer jump to frame N
by multiplication. With variable frames it cannot, so the writer must emit a keyframe
index: every 10 seconds, record `(t_ms, byte offset)` into a table written at the END of
the file, with the table's own offset stored in the header. The viewer reads the header,
seeks to the table, and binary-searches it. A crash mid-round leaves no table, which is
exactly why the reader must also support a linear scan fallback; a truncated file then
degrades to "playable but slow to seek" rather than "unreadable".

Size, with entities: players are 1,360 bytes per second at 10Hz. Commons run roughly 20
to 30 alive in a versus round, and at 12 bytes each the entity block adds roughly 2,400
to 3,600 bytes per second.
Call it 3.4 KB/s, 12 MB per hour, 10 to 15 MB for a full match. Still small next to the
1.7 GB/day the demo recorder was producing, and the 90 day retention still lands near
4 GB at 30 matches a week.

Timestamps are explicit rather than implied by frame index, costing 4 bytes per frame,
so a hitch or pause cannot silently desync motion from the event timeline.

Entities keep their own cvar so the two rates move independently, and the default is the
full player rate. The frame-time gate under Testing is what may move it: this is a
measurement that can still overrule the default, not an argument that has been won.

## 6b resolutions

Decided 2026-09-11, when 6b was scoped. 6a is deployed and has been verified in game.
6b is the recorder and the reader; it ships no viewer, which is piece 3.

### The entity set is maintained incrementally, never scanned

This is the single most important cost decision in the recorder, and it is the one an
obvious implementation gets wrong. Finding commons, the witch and the rock with
`FindEntityByClassname` walks the entity table once per classname per frame. At three
classnames and 10Hz that is tens of thousands of entity slots a second on a box whose
recorded p99 is already 11.25ms against a 10ms budget at 100 tick.

Instead the plugin tracks the set in `OnEntityCreated` and `OnEntityDestroyed` and holds
entity *references*, not indices, so a recycled index cannot alias onto a dead entity.
The per-frame cost becomes walking about 30 tracked references. Creation and destruction
are events the engine already raises, so the work moves off the sampling path entirely.

### One write call per frame, and no flush

The frame is packed into a byte array in Pawn and written with a single `WriteFile` call
at `size = 1`. The alternative, a `WriteFileCell` per field, is roughly 190 native calls
per frame. Packing is a few hundred shifts, which is far cheaper than the call overhead
it replaces.

`FlushFile` is never called. The page cache serves a tailing reader on the same box
without it, and a 10Hz flush is the most direct way to turn an estimated cost into a
measured stall.

### No REPLAY datagram; replays are discovered by filename

Supersedes the `REPLAY` line in the data flow above. `match_replays` rows are built by
listing `replayDir` for `pug_<token>_<ordinal>_<half>.rpl`, exactly as
`discoverMatchDemos` already does for demos, with `frames` and `sample_hz` read out of
the file header rather than taken on trust from a datagram.

The filename already carries the match link by construction, which is the whole reason
the demo naming convention exists. Discovery by listing therefore costs nothing and
removes a lossy dependency: a dropped datagram would otherwise leave a real file
permanently unindexed.

The consequence worth stating plainly is that **6b introduces no new UDP line type**. It
is a plugin that writes files and a backend that reads them. Nothing it does touches the
datagram path that carries match results and ratings.

### Live tailing ships, the WebSocket does not

The reader and the "hold every frame until `now - delay`" logic are built and tested here
as pure functions over parsed frames. Wiring them to a socket waits for piece 3.

The delay is the anti-ghosting control, not a buffering convenience, so it should be
proven against the viewer that will actually expose it rather than against a throwaway
debug client. Deferring the socket moves plumbing, not judgement: nothing built in 6b is
discarded when the viewer arrives.

### Retention machinery lands here; the admin panel still waits for 6c

A free-space floor in the recorder and a daily prune driven by the `settings` table ship
in 6b. The dry-run preview, orphan classification and the admin UI stay in 6c.

This splits the spec's "the admin panel ships with this piece" along the line that
actually matters. The floor and the prune are what stop a second disk incident, and 6b
is the piece that starts writing 10 to 15 MB a match. The panel makes that visible and
manual, which is valuable but not load bearing, and it is the larger half of the work.

## Error handling

**Governing rule: a replay failure must never affect a ranked result.** The rating
pipeline must not be able to notice that replay capture exists. This mirrors the
never-throws discipline in `src/demos.ts`.

| Case | Handling |
|---|---|
| `replayDir` unset | Feature off entirely, silent. Mirrors `demoDir` defaulting to empty |
| File write fails | Log once, disable replay for the rest of the match, match continues |
| Free space below floor | Refuse to open new replay files. Cheap insurance given the prior incident |
| File missing at ingest | No `match_replays` row, UI shows unavailable. Not an error |
| Truncated file | Round down to the last whole frame |
| Round restarted after stats accrued | Not currently detected. Known gap: `reliable` is only lowered at derivation time when a map's two halves fail to partition the two sides between them |
| Player changes team mid-match | Not currently detected. Known gap: same as above |
| Start/end side disagreement | Trust round end, log the disagreement |
| Duplicate UDP datagram | Idempotent upsert, as `match_live_maps` already does |

### Admin panel safety

Deletion is irreversible. Dry run is mandatory, and the confirm call must echo back the
exact file and byte count from that preview, so a stale tab cannot delete something the
preview never showed. Files belonging to a live or configuring match are never eligible.
Every deletion is logged. Orphan demos get their own toggle defaulting to **off**, since
that is the one category where a misclassification actually costs something.

## Testing

**Event-kind registry with a parity test.** This mirrors `src/statKeys.ts` and
`tests/statKeysParity.test.ts`, and exists for the identical reason: the comment there is
right that a typo'd key is not a DB error but a silently empty leaderboard. Event kinds
fail the same way. The plugin emits `witch_agro`, the web looks for `witch_aggro`, and
the timeline is quietly missing witches forever. One registry, resolved by plugin,
parser and API alike.

- **Format round-trip.** Synthesize a file, parse it, assert frames match. Includes a
  deliberately truncated file.
- **Ingest.** `ROUND_START` and `ROUND_END` parsing, start-vs-end side disagreement,
  duplicate datagrams upserting idempotently.
- **Side attribution.** Given `match_rounds` plus existing per-map snapshots, assert
  survivor stats land on the right round. This is the test the "no new snapshot table"
  decision rests on and must fail if that decision is wrong.
- **Prune safety.** Dry-run and confirm counts must match; live-match files excluded;
  orphan classification correct against known filenames.
- **Frame-time gate.** An `l4d_tickstats` capture at `sm_pug_replay_hz 0` versus 10,
  comparing p99 and p999. This is an acceptance criterion, not a footnote.

## Risks

**Frame time.** Estimated cost is ~40 to 50 microseconds on one frame in ten, about
0.05% amortized against a 10ms budget at 100 tick. But the recorded baseline p99 is
11.25ms against that 10ms budget, so roughly 1% of frames already overrun and the box
does not have headroom to spare. Mitigations: never flush per sample, since the page
cache serves live tailing without it and a 10Hz `FlushFile()` is the easiest way to turn
this into a real problem; binary packing rather than text; and `sm_pug_replay_hz` as an
instant rcon off switch needing no reload. If p99 moves measurably, drop to 5Hz, which
halves the cost and is visually identical after interpolation. If it still moves, the
design is wrong and we learn that before it is load-bearing.

**Live server.** Deployment requires an explicit go-ahead; players are frequently on the
box.

**Unknown hooks.** `car_alarm` is unverified: `triggered_car_alarm` is commented out and
L4D2-gated in skill_detect, so it may never fire here. Every hook added by this work uses
`HookEventEx`, so an absent event logs and degrades rather than aborting plugin load. The
fallback if it never fires is a `prop_car_alarm` entity hook. `pills` remains unhooked and
is deferred rather than in scope. Confirm both in game.

**Scope.** Piece 1 ships nothing visible except the admin panel. The product is pieces 2
through 4, and this spec exists to serve them.

## Resolved 2026-09-11

- Player page organizes by survivor versus infected, not by campaign or stat family
- Goal is finding games that went badly and diagnosing why, not pure record-keeping
- Sample carries full player state. World entities were deferred here and then
  reinstated the same day on evidence; see "Reinstated 2026-09-11" above, which is the
  live decision. This bullet is kept only as the record of what it reversed
- Storage is files on disk plus a DB index row, 90 day retention
- Per-round stat snapshots are unnecessary given the side partition in `statKeys.ts`
- Tank control passes in this ruleset, so it is worth capturing, but it passes THROUGH
  the AI: the other party in both directions is a bot, so `tank_take` and `tank_give`
  name one player each rather than a single `tank_pass` with a from and a to
- Kits are disabled, so `heal` becomes `pills`
- Admin storage panel ships in this piece
- `skill_detect` is already loaded and silenced for ranked play; no change needed
- Car alarm hook is `prop_car_alarm` entity creation plus touch/damage, per Rotoblin's
  own `l4d_car_alarm_hittable_fix.sp`
- Pills deferred; `temphealthfix.sp` means the temp-health threshold cannot be hardcoded
- Replay placement: live viewer sits at the top of the live page above the stats; a
  finished map's replay sits under that map's section on the scrim page. One viewer
  component, two sources. This makes the server-side delay load-bearing rather than
  cosmetic, since the live page is public
- Map imagery: nav-derived schematic first for all maps, `cl_leveloverview` screenshots
  layered in per map afterwards, so art never blocks the viewer
- Live replay is visible to anyone, on both the live page and a finished map. Tightening
  is a later option, not a v1 requirement. This is only acceptable because the delay is
  enforced server-side
- Vertical overlap: accepted, with avatars scaled by height. Not a layer system

## Still open

Nothing blocking. Both remaining questions were resolved 2026-09-11 and moved above.

Revisit later, not now:

- Whether live replay visibility needs tightening. It ships visible to everyone; the
  server-side delay is what makes that safe, so the delay is not optional
