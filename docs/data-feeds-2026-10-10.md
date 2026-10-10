# Data feeds: connection funnel, flow and cause codes, SI lives

Branch `data-feeds`, built 2026-10-09 for owner review on 2026-10-10. Ideas 3, 6 and 7 of the
2026-10-09 plugin ideas audit. Nothing here changes gameplay or shows anything new to players:
every new line is staff-side data, the public live feed is unchanged, and the only UI change is
one line of grey text on the admin live board.

**Version.** `PLUGIN_VERSION` in `pug-match.sp` is deliberately NOT bumped on this branch
(another branch, `audit-fixes`, edits pug-match tonight). Bump it at merge to whatever is next
(0.3.29 if nothing else lands first) and name it in the deploy notes.

## What is recorded

### A. Connection funnel and the L4D2 pack flag

For each rostered player (by SteamID64), timestamps in unix seconds on the game server's clock:

| stage | when | once per |
|---|---|---|
| `connect` | `player_connect` (the network connect, networkid converted to SteamID64) | real connection |
| `ingame` | `player_activate` (fully loaded the map) | map |
| `team` | first `player_team` to survivors or infected | map |
| `ready` | first `IsReady()` during a ready-up (1 s poll, l4dready native, feature-checked) | map |
| `drop` | `player_disconnect`, with `pre=1` when they never got in game on this map, the seconds connected, and the engine's reason string | real disconnect |

Plus `MAPLOAD` at every `OnMapStart` of a tracked match, so loading time per map is
`ingame.at - mapload.at`.

Site side (`src/dataFeeds.ts`):

- every line goes into `match_connect_funnel` (configuring or live match);
- `player_pack_status` per player: `ok` once they get in game on an L4D2-port map; `missing`
  when they drop while loading one (`pre=1`) with a missing-map/file reason; `suspect` when they
  drop while loading one with a generic reason and have never been seen to load one;
- `packStatus(db, steamid)` / `packStatusMany` return `ok | missing | suspect | unknown`. This is
  the flag the future pack-check vote gate reads. The gate itself is NOT built.
- An L4D2-port map is `isL4d2PortMap(map)`: L4D2 naming `c<n>m<n>_` AND a campaign in
  `DLC4_CAMPAIGNS` (so Passifice's river maps, stock L4D1, never count).
- Admin live board: each player row gets `funnel: { stage, pack }` and shows one grey line:
  "loading the map", "in game, not ready" (only during a ready-up), "L4D2 map pack missing" or
  "may lack the L4D2 map pack". The funnel uses the newest map the funnel heard of, not
  `match_live.current_map`, because that moves at go-live and loading happens before it.

**Important unknown.** `l4d_consistency` already learned that a client's own drop reaches the
server as plain `Disconnect by user.`. A missing-map drop may well look the same, in which case
`missing` will rarely fire and `suspect` carries the signal. The raw reason is stored either way;
the first real port-map drop will tell. Do not build the vote gate on `missing` alone until then.

### B. Flow % and cause codes

Every `EVENT` line gains ` flow=<%> prog=<%>` and, on `incap`, `death` and `tank_death`,
` cause=<code>`:

- `flow` = the survivor the event is about (actor if a survivor, else the target), from the same
  reading `!cur` and `LIVEHUD` use (last known nav area flow / map max flow, rounded, 0..100).
  No alive check, so a death has the flow where they went down; falls back to the last value read
  (refreshed every second). `-1` = none (e.g. `si_spawn`, `tank_spawn`).
- `prog` = the furthest living survivor's flow (bots included), the team's progress.
- incap/death `cause`: `punch`, `rock`, `hittable`, `tank` (tank, unknown weapon), `hunter`,
  `smoker`, `boomer`, `common`, `witch`, `fall`, `bleed`, `ff`, `other`. Read from the event's own
  `attacker`, `attackerentid`, `weapon` and `type` (both `player_incapacitated_start` and
  `player_death` carry all four on L4D1, checked in `resource/modevents.res`). `boomer` and
  `common` are separate codes (the audit listed them together; split is strictly more data).
- `tank_death` `cause`: `kill` or `pass`. A pass is a tank whose killer is not a survivor (itself,
  an infected player, or nobody with health left), or a `tank_frustrated` within 5 s. The
  `tank_death` EVENT still fires on a pass exactly as before (the public feed is unchanged); the
  analytics now filter on `cause=pass`.

New line, one per rostered survivor incap or death, attacker or not:

```
DOWN half=<h> t=<ms> steamid=<victim> kind=incap|death cause=<code> by=<steamid|0> flow=<%> prog=<%> pinned=<0|1>
```

Why a separate line: the death EVENT has always been skipped when the attacker is not a player
(bleed-out, fall, commons, witch), and adding those to the EVENT feed would show new lines on the
public match page and move existing metrics. `DOWN` is complete and invisible.

And at round end:

```
ROUND_FLOW half=<h> prog=<%> p=<steamid>:<flow %>,...
```

where everyone was when the round ended (a wipe's flow, the saferoom's 100).

Site side: `match_live_events.flow/prog/cause` (new nullable columns), `match_survivor_downs`,
`match_round_feeds.end_prog/end_flows`.

### C. SI lives

One record per life of a rostered infected player, batched per round:

| field | source |
|---|---|
| ghost start | `L4D_OnEnterGhostState` (0 = already a ghost at go-live) |
| materialize time, own flow, team prog | `player_spawn`, read one frame later (it fires inside `MaterializeFromGhost` while `m_isGhost` is still 1) |
| tank lives | `tank_spawn` (also fires for each new controller after a pass) |
| first hit, damage | one line in `Event_PlayerHurt`'s infected branch; damage split standing / incapped |
| end time and cause | `player_death`: `skeet` (hunter with `m_isAttemptingToPounce`, or skill_detect's skeet forward via `CountSkeet`), `shot`, `shove` (DMG_CLUB), `melee` (L4D2 only, never on L4D1), `fire`, `blast`, `other`, `pass` |
| non-death ends | `tank` (became the tank), `disc`, `team` (left infected), `open` (alive at round end) |
| respawn timer | `ghost_spawn_time` event (`spawntime`), attached to the life that just ended |
| killer | the survivor's SteamID64, or 0 |

```
SILIFE half=<h> i=<index of first record> l=<rec>,<rec>,...
SILIFE_END half=<h> lives=<n> dropped=<n>
rec = id:zc:ghost:spawn:sflow:sprog:hit:dmg:dmginc:end_t:end:killer:resp
```

Site side: `match_si_lives` keyed `(match, ordinal, half, idx)`; `match_round_feeds.si_lives`
and `si_dropped` (rows stored vs lives recorded tells a lost datagram). Cap 192 lives per round
(`dropped` counts any past it; a real round is 40 to 80).

## Wire grammar summary (all through `EmitPug`, so signed and token-gated)

```
CONN steamid=<id64> stage=connect|ingame|team|ready|drop t=<unix s> map=<map> [team=<2|3>] [pre=<0|1> secs=<n>] [reason=<rest of line>]
MAPLOAD map=<map> t=<unix s>
DOWN half=<h> t=<ms> steamid=<id64> kind=incap|death cause=<code> by=<id64|0> flow=<%> prog=<%> pinned=<0|1>
ROUND_FLOW half=<h> prog=<%> p=<id64>:<flow %>,...
SILIFE half=<h> i=<first index> l=<record>,...
SILIFE_END half=<h> lives=<n> dropped=<n>
EVENT ... flow=<%> prog=<%> [cause=<code>]
```

`reason=` is last on CONN because a client can write its own disconnect reason (sanitized of line
breaks and capped at 128 bytes by `SanitizeChat`); the parser reads keys only from before it, and
`tests/dataFeeds.test.ts` forges keys inside a reason to prove it.

## Backward compatibility

- **Old site, new plugin:** `parseLogDatagram` returns null for an unknown verb (CONN, MAPLOAD,
  DOWN, ROUND_FLOW, SILIFE, SILIFE_END) and `kv()` ignores unknown EVENT keys. Nothing changes.
- **New site, old plugin:** no new lines arrive; EVENT rows get NULL flow/prog/cause; the board's
  `funnel` is null and shows nothing; `packStatus` is `unknown` for everyone.
- Schema is additive (`ensureDataFeedsSchema` at boot: five `CREATE TABLE IF NOT EXISTS`, three
  `ALTER TABLE match_live_events ADD COLUMN`). A replayed half clears its downs, lives and round
  row beside `resetRoundLines`. The merge tool knows the new player columns.

## Payload sizes

Measured on the rig (see below) and estimated for a real match:

- EVENT tail: +16 to +26 bytes per line.
- DOWN: about 150 bytes, one per incap/death (a match has roughly 30 to 60).
- ROUND_FLOW: about 130 bytes per round.
- SILIFE: a record is about 90 bytes; lines are capped at 560 bytes of body (about 6 records),
  well under EmitPug's 768 buffer plus the signature trailer. A 6-minute round with 4 infected
  players and ~10 s average lives is ~40 to 80 lives: 7 to 14 lines at round end. Every line is
  its own UDP datagram, so nothing is near the 4 KB rcon fragment problem of the 09-13 incident
  (that was the rcon dump, which this does not touch).
- CONN/MAPLOAD: about 110 bytes, ~5 per player per map: ~40 per map, ~160 per match.
- Per match total: roughly 25 to 40 KB extra over UDP (LIVEHUD alone is ~1,500 lines a match).

## Hooks and engine checks

- Game events used (all present in L4D1's `resource/*.res`): `player_connect` (has `networkid`,
  `index`), `player_activate`, `player_team`, `player_disconnect` (Pre, like l4d_consistency),
  `player_incapacitated_start` (has `weapon` and `type`), `player_death` (has `attackerentid`,
  `weapon`, `type`), `tank_frustrated`, `ghost_spawn_time` (`spawntime`), `revive_success`,
  `tank_spawn`, `player_spawn`. All hooked with `HookEventEx`; a missing one costs its feed.
- One left4dhooks forward, `L4D_OnEnterGhostState`. Its detour is already active on every
  server (l4d_QuadCaps, l4d_versus_GhostWarp and l4d_versus_despawn_health listen to it), so this
  enables nothing new. Materialize was first written against `L4D_OnMaterializeFromGhost`, which
  NO live plugin listens to (it would have been a new detour); the rig showed `player_spawn`
  fires inside `CTerrorPlayer::MaterializeFromGhost` (event first, forward after, with
  `m_isGhost` still 1 at the event), so the plugin now reads the ghost flag one frame after
  `player_spawn` (`RequestFrame`) and the forward is not used.
- No new detours of our own, no SDKHooks, no per-tick hooks. One 1 s timer (ready poll, flow
  cache, team-change close). `player_hurt` costs nothing new: the SI damage hook is one line in
  pug-match's existing handler.

## pug-match.sp edits (merge surface)

New file `plugin/pug-datafeeds.inc`, included after `pug-tourney.inc`. In `pug-match.sp`, one
line each: `DataFeeds_Init()` (OnPluginStart), `DataFeeds_Reset()` (ResetMatchState),
`DataFeeds_MapStart()` (OnMapStart, after `Gg_OnMapStart`), `DataFeeds_RoundLive()` (go-live),
`DataFeeds_RoundEnd(half)` (after `EmitRoundStats`), `DataFeeds_SiHit(...)` (player_hurt infected
branch), `DataFeeds_OnDeath(...)` (player_death, after TankRecapEnd), `DataFeeds_OnIncap(...)`
(before the incap EVENT), and `EmitEvent` builds a tail. `pug-stats.inc` `CountSkeet` gains
`DataFeeds_MarkSkeet(victim)`. `build.sh` copies the include and accepts `DF_TEST=1` (rig-only
build, see below).

Site files: new `src/dataFeedParse.ts`, `src/dataFeeds.ts`, `tests/dataFeeds.test.ts`; small
edits to `src/logParse.ts` (union member, EVENT extras, default case), `src/server.ts` (one
dispatch block, one reset line), `src/liveView.ts` (EVENT insert), `src/db.ts` (schema call),
`src/mergePlayers.ts`, `src/admin/liveBoard.ts`, `web/src/api.ts`, `web/src/liveBoard.ts`,
`web/src/routes/admin/AdminLive.tsx`, and the expected table list in `tests/db.test.ts`.

## Ship order

1. Merge, bump `PLUGIN_VERSION`, rebuild.
2. **Web first** (`deploy-web.sh`; web deploys may go out during live matches per the deploy
   rules). The schema migrates at boot and nothing arrives yet.
3. **Plugin second**, via `stage-on-restart.sh` (empty boxes / after-match restarts), all pool
   servers. Old and new plugins can coexist in the pool.
4. After the first matches: run the verification list below.

## What was tested

- `npm run typecheck`: clean (server and web).
- `tests/dataFeeds.test.ts` (new, 18 cases): every verb, malformed and forged lines, unknown
  verbs, the EVENT extras with an old line byte-identical, funnel state machine across a
  changelevel and a drop, pack status transitions, idempotent upserts for downs and lives,
  resetRoundFeeds, unknown tokens, NULL extras from an old plugin.
- `tests/liveBoard.test.ts` (funnel on the board), `web/src/liveBoard.test.ts` (`funnelText`),
  `tests/db.test.ts` (table list).
- Full `npx vitest run` with `TMPDIR` in the session scratchpad: all pass except
  `tests/skeetStreakPoster.test.ts` (7 cases), which is date-dependent on master (its fixtures end
  matches on 2026-09-29 and the poster's stale cutoff skips them now) and untouched by this branch.
- Plugin builds clean with spcomp 1.12 (`./build.sh`, 0 errors, the same pre-existing
  `halflife.inc` deprecation warning) in both the production and `DF_TEST=1` variants.
- **Rig** (cfgfp `dfeeds` variant, srcds under `unshare -rn`, Dallas plugin set, `pug_match.cfg`,
  a fake 8-id roster, survivor bots via `sb_add`, SI and tank via `z_spawn` through a bot, a
  rig-only helper plugin `df_rig`): results, all as designed:
  - `EVENT` lines carry `flow=`/`prog=` (`si_spawn`/`tank_spawn` read `flow=-1`), and
    `cause=` on incap (`punch` from a real `tank_claw` hit, `smoker` from `smoker_claw`, `ff` from
    a survivor's smg, `other` for a world hit) and `tank_death` (`kill` by a survivor's
    shotgun; `pass` for a tank killed by itself, the pass heuristic).
  - `DOWN` for every incap and death, including the two the EVENT feed never had: a fall death
    (`worldspawn`, DMG_FALL, `cause=fall`) and an incapped survivor finished with no attacker
    (`cause=bleed`).
  - `ROUND_FLOW`, `SILIFE` and `SILIFE_END` at both round ends (a wipe), before `ROUND_END`.
    SI lives ended `shot`, `shove` (DMG_CLUB), `fire` (DMG_BURN) and `open`, with killers, spawn
    times and spawn flow; the tank life had `zc=5`.
  - `MAPLOAD` at each map start of a tracked match.
  - Materialize: forcing a bot's `m_isGhost` and calling `L4D_MaterializeFromGhost` showed
    `player_spawn` fires inside it with the ghost flag still 1, then the left4dhooks forward.
    That is why the plugin reads the flag one frame after `player_spawn` and needs no new detour.
  - End to end: all 861 `PUG` lines the rig logged were fed through `parseLogDatagram` and the
    new store (`recordDataFeed`, `recordLiveEvent`): no feed line failed to parse, and downs,
    lives, round rows and EVENT causes landed as above.
  - Measured sizes: DOWN 149 bytes, EVENT with tail 146 to 149, ROUND_FLOW 143 (4 survivors),
    SILIFE 325 for 4 records (about 65 to 90 bytes a record), SILIFE_END 72, MAPLOAD 89.
  - Not exercisable with bots: the funnel (bots have no SteamID), ghost state, respawn timers,
    SI damage per life (human SI only), skill_detect skeets, a real frustration pass.

## What needs a real match to verify

1. **Missing-map reason.** What a client lacking the pack actually sends (`missing` vs
   `suspect`). Check `SELECT stage, pre, reason FROM match_connect_funnel WHERE stage='drop'`.
2. **Ghost and respawn with humans.** Bots never ghost, so `L4D_OnEnterGhostState` and
   `ghost_spawn_time` were not exercised, and materialize was only exercised by forcing a bot's
   ghost flag and calling `L4D_MaterializeFromGhost` (same engine function a human goes through).
   Check `match_si_lives` rows have `ghost_ms` and `spawn_ms`, and `respawn_s` on deaths.
3. **SI damage per life.** `dmg`/`first_hit_ms` come from pug-match's player_hurt branch, which
   counts human SI only (`!IsFakeClient`), so the rig's bot SI always showed 0.
4. **Tank pass.** That a frustration pass gives `tank_death ... cause=pass` and an SI life
   `end=pass`, and the new controller a fresh tank life.
5. **Skeet.** That a real skeet ends the hunter's life as `skeet` (both the netprop check and
   skill_detect's forward).
6. **Hittable.** Which `weapon`/`attackerentid` L4D1 reports for a car hit (`hittable` is
   matched on `prop_*`, DMG_CRUSH, or an attacker-less prop entity).
7. **Funnel stages.** `connect`/`ingame`/`team`/`ready` for real clients, including across a
   changelevel (that `player_activate` fires again per map, which drives per-map loading time).
8. `SILIFE_END.lives` equals the stored row count for each round (no lost datagrams at the
   round-end burst).

## Rig notes (for repeating the test)

- Variant: `/home/volence/l4d1-ds-cfgfp/dfeeds` (made by `mkvariant.sh dfeeds`; its
  `plugins/pug-match.smx` is a real file, the DF_TEST build, and `plugins/df_rig.smx` is the
  helper, source in `plugin/tests/df_rig.sp`: `df_spawn <class>`, `df_hurt <victim> <attacker|0>
  <dmg> <dmgtype>`, `df_ghostmat <client>`, `df_who`). The server is stopped. Delete the variant when done: `rm -rf /home/volence/l4d1-ds-cfgfp/dfeeds`.
- `DF_TEST=1 ./build.sh` gives every bot on a team a free roster slot so EVENT, DOWN and SILIFE
  fire for bots. Never stage that build.
- The roster arg must be quoted on a raw console (`sm_pug_roster "7656...:a"`); the console
  tokenizer splits on `:`.
