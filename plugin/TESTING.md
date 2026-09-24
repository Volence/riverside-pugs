# pug-match: solo testing runbook

Copy-pasteable. Assumes you are in `/home/volence/l4d/pug/plugin` and that
`deploy/server.env` has `L4D_HOST` set. `R` below is shorthand for
`../../deploy/rcon.py`.

    alias R='/home/volence/l4d/deploy/rcon.py'

`rcon.py` needs `L4D_RCON_PW` in the environment. `stage.sh` sources it from
`deploy/overrides/left4dead/cfg/secrets.cfg` automatically, but for bare `R`
calls you need it exported yourself:

    export L4D_RCON_PW=$(sed -n 's/^ *rcon_password *"\([^"]*\)".*/\1/p' \
      /home/volence/l4d/deploy/overrides/left4dead/cfg/secrets.cfg | head -1)

## 0. Install

    ./build.sh          # only if you changed the .sp
    ./stage.sh --solo   # refuses if anyone is connected; sets min_orient=1, debug=1

`stage.sh` copies one file and calls `sm plugins load`. It does **not** restart
the server and does not kick anyone. The plugin is inert until a match is
configured, so leaving it installed between sessions is fine.

Watch the debug log in a second terminal for the whole session:

    ssh root@$L4D_HOST 'tail -f /home/l4d/l4d1-server/left4dead/addons/sourcemod/logs/L*.log | grep pug'

At any point, ask the plugin what it thinks is happening:

    R "sm_pug_status"

## 1. Plugin loaded

    R "sm plugins list" | grep -i pug-match

Expect a line with `pug-match`. If missing, it failed to load; the usual cause
is a missing `left4dhooks`. Check `addons/sourcemod/logs/errors_*.log`.

## 2. Match intake (RCON contract)

You need your own SteamID64. Three ways:

    ./players.sh              # names + SteamID64 of everyone connected
    ./players.sh --roster     # ready-made sm_pug_roster lines, alternating a/b

or from the admin list without touching the server at all:
`deploy/overrides/left4dead/addons/sourcemod/configs/admins_simple.ini` holds
`STEAM_X:Y:Z` forms; `id64 = 76561197960265728 + Z*2 + Y`. Yours is
`76561198030413993`.

The other seven roster entries can be any well-formed 17-digit numbers that
never connect; the roster does not have to be full for the plugin to arm.

    R 'sm_pug_match 999 testtoken no_mercy'
    R 'sm_pug_roster "76561198030413993:a"'      # <- you
    R 'sm_pug_roster "76561198000000002:a"'
    R 'sm_pug_roster "76561198000000003:a"'
    R 'sm_pug_roster "76561198000000004:a"'
    R 'sm_pug_roster "76561198000000005:b"'
    R 'sm_pug_roster "76561198000000006:b"'
    R 'sm_pug_roster "76561198000000007:b"'
    R 'sm_pug_roster "76561198000000008:b"'

Expect `PUGOK match=999` then `PUGOK roster=1` ... `roster=8`.

**The quotes around the roster arg are load-bearing.** Source's console
tokenizer splits unquoted args on `:`, so an unquoted call reaches the plugin as
a bare steamid and is rejected. That was the bug found on 2026-08-29.

Confirm the plugin agrees:

    R "sm_pug_status"

Expect `state=pending`, `match=999`, eight roster lines, `connected=0` for all.

## 3. Non-rostered clients are not kicked

Have someone not on the roster join, or temporarily roster only fake IDs and
join yourself. Expect NOT to be kicked: you stay connected, unscored, and free
to spectate. `Timer_TeamLock` never moves you because you are not in any
roster slot.

Then check `sm_pug_status` still shows `connected=0` for every rostered slot.

## 4. Rostered join + the UDP wire format

Join the server yourself. Expect:

- `sm_pug_status` shows your slot with `connected=1` and a `side=`.
- A `PLAYER steamid=... event=connect` datagram at the backend listener.

To watch the raw UDP stream without the backend running:

    R "logaddress_add <your-ip>:27500"
    nc -ul 27500 | cat -v        # cat -v makes the framing bytes visible

The real framing carries a trailing NUL and the engine echoes rcon commands
back over the same stream. Both are already pinned in `tests/logParse.test.ts`.

## 5. Go live

Ready up. Expect `state=live` in `sm_pug_status` and a `MATCH_START map=...`
line.

## 6 + 8. Score attribution and the cross-map case (the risky part)

This is what `sm_pug_min_orient 1` unlocks. With the threshold at 1 your single
rostered presence sets the orientation, so you can play a versus round with bots
and still get correct attribution.

Play both halves of a map, then a second map. After each map end check:

    R "sm_pug_status"

Expect a `STATUS map ordinal=N map=... a=X b=Y` line per completed map, and the
scores to match the in-game scoreboard.

**Item 8 is the one to watch.** On the second map the engine's logical team
indices can swap relative to the pug teams. If `a` and `b` invert between map 1
and map 2 in the status output, that is the cross-map relabeling bug and it is
the single most important thing this session can find. The debug log lines
`orientation ->`, `score read`, and `credit N to pug team` show exactly where it
went wrong.

## 7. Team lock (needs a second person)

Have someone swap teams mid-round. Expect the lock to move them back within ~4s,
and `lock moving <name> to <side>` in the debug log. Solo you can approximate
this by swapping yourself.

## 9. Match end and the authoritative dump

On finale load expect `MATCH_END`. Then:

    R "sm_pug_dump testtoken"
    R "sm_pug_dump testtoken"

Expect `DUMP` / `MAP` / `STAT` / `END` lines, identical both times (it must be
idempotent, the backend may call it more than once).

## 10. Abort

    R "sm_pug_abort testtoken"

Expect `PUGOK aborted`. After this, team-lock placement stops: `g_State`
resets to `MS_None`, so `Timer_TeamLock` bails immediately and nobody joining
afterward gets moved onto a side. Verify that, since a stuck lock would drag
your casual players onto teams.

## 11. Heartbeats

`PUG <token> HEARTBEAT` every 30s while a match is configured, none at
`state=none`.

## Skill stats verification

This runbook is run against a live ranked match to verify the skill-detection
integration end to end. Everything above is unproven until this passes.

**WARNING: Every step below changes the live server. Real players are usually connected. Before you start, run `R "status"` to see who is online and get the owner's explicit go-ahead before proceeding.**

### 1. Stage the plugin

    ./stage.sh --solo

Expected: `Plugin PUG Match reloaded successfully.` Do NOT accept a `FAILED to load` message without checking `sm plugins list` for `"PUG Match"` yourself; that grep was wrong until 2026-09-06.

### 2. Confirm the capability flag samples correctly

With skill_detect loaded, set up a match and take it live, then:

    R "sm_pug_dump testtoken" | head -1

Expected: `DUMP match=<id> skilldetect=1 state=live` (0.3.3 adds `state=`, and `nonce=` when a second argument is given)

Then unload skill_detect (`sm plugins unload l4d2_skill_detect`), set up a fresh match, take it live, and dump again. **This unload will disrupt anyone playing with the plugin loaded; confirm no one is mid-match first.** Expected: `skilldetect=0`, and `SKILL` lines carrying only `tank_damage`, `damage_as_si` and `tank_punches`. This is the check that proves "not measured" cannot be persisted as zero.

### 3. Verify counting against ground truth

Practice mode gives AI special infected with no cheats: `!load 1v4` in chat, then

    R "l4d_infectedbots_hunter_limit 4"

Set `sm_skill_report_enable 1` temporarily so the starred chat lines are visible, skeet a known number of hunters, then compare three sources that must agree:

1. the starred `skill_detect` chat lines
2. the `l4dcompstats` end-of-round SURVIVOR STATS table
3. `skeets` in the `SKILL` dump line

All three agreed on 2026-09-06 (2, 2 and n/a). A disagreement between 1 and 2 is a `skill_detect` threshold issue on L4D1; a disagreement between 1 and 3 is a bug in this code.

Put `sm_skill_report_enable` back to 0 when done.

### 4. Verify the full loop

Create a match through the app so `RealOrchestrator.setupMatch()` runs (this has never been exercised against the live server). Play two halves. Confirm rows land in `match_player_stats`, the match page renders the new columns, and your own profile shows the private panel while another account's does not.

### 5. Restore the server

**This step resets all config back to production. Confirm the match is finished first.**

    R "sm_pug_abort <token>"
    R "sm_pug_min_orient 3"
    R "sm_pug_debug 0"
    R "exec rotoblin_pub.cfg"

## Before you leave

    R "sm_pug_abort testtoken"     # if a match is still configured
    R "sm_pug_min_orient 3"        # back to production
    R "sm_pug_debug 0"

The plugin can stay loaded. It does nothing without a match.

## If something goes wrong

Capture these three and it will almost always be diagnosable:

1. `R "sm_pug_status"` at the moment it looked wrong.
2. The `grep pug` debug log around that time.
3. What the in-game scoreboard actually said, so the plugin's numbers can be
   compared against ground truth.

---

## Live test: `!load_4v4p` (the in-game entry point)

Added 2026-09-11. Everything below the plugin's own roster snapshot has already
been verified end to end against the live backend using synthetic datagrams:
match adoption, player auto-creation, team assignment, server status, and the
`sm_pug_setid` rcon leg. **What has NOT been tested is the part that needs a
human in the server**, because the roster snapshot reads real connected
clients and bots are excluded by `IsFakeClient`.

### Prerequisites (all already true on the box as of 2026-09-11)

- `pug-match.smx` staged and loaded (`./stage.sh --solo`)
- `logaddress_add 127.0.0.1:27500` active (`logaddress_list` to confirm; also
  persisted in `deploy/overrides/left4dead/cfg/local.cfg`)
- `pug-web.service` running, `servers` row host = `45.32.199.85`
- `rotoblin_pug_4v4.cfg`, `rotoblin_pug_4v4_map.cfg`, `pug_match.cfg` on the box

### Runbook

1. Join the server. Get on survivors or infected, not spectator.
2. `!load_4v4p` in chat. Expect a chat line "Match starting: N players. Ready
   up." and the server to restart the map into the PUG config with the
   "4v4 PUG" league notice.
3. `sm_pug_status` over rcon. Expect `state=pending`, `selfStarted=1`,
   `teamLock=1` (rostered players will be placed on their assigned sides), a
   32-hex token, and a roster slot per player.
4. **The match id is the thing to watch.** Within a second or two the backend
   should adopt the match and rcon `sm_pug_setid` back. Re-run `sm_pug_status`:
   `match=` must be non-zero. If it stays 0, the adopt path failed and the
   dump will later be rejected for a match-id mismatch. Check
   `journalctl -u pug-web -f` for `[selfStarted]`.
5. Confirm the row: `sqlite3 /home/pug/app/data/pug.db "SELECT * FROM matches"`.
   State `live`, campaign derived from the map, `server_id` set.
6. Ready up and play. Scores, attribution and `MATCH_END` follow the existing
   backend-driven path, already verified 2026-09-06.
7. After the finale loads, the backend pulls `sm_pug_dump` automatically and
   completes the match. It should then appear at
   `https://riversidepug.com/matches`.

### Demo check (upstream issue #49)

Each map records `pug_<token>_<ordinal>_<map>.dem` in `left4dead/`. After a
multi-map match, pull **demo #3, not demo #1**, and play it back. Upstream
sourcetvsupport #49 reports that on L4D1 only the first demo per server restart
is reliably good. If #3 is corrupt, the fallback is one continuous demo for the
whole match instead of one per map.

### Things that will look wrong but are not

- **Spectators are not kicked.** Deliberate, and not specific to self-started
  matches: no match ever kicks a non-rostered client, so spectators are simply
  unscored. `teamLock=1` in status confirms the plugin is still placing the
  rostered eight; it says nothing about anyone else, who is left alone.
- **`sm_pug_min_orient` is currently 1** from `stage.sh --solo`. `pug_match.cfg`
  sets it back to 3 on exec, so `!load_4v4p` self-heals this. Check status
  after loading if you care.

## Round capture verification

This runbook verifies that round-level event capture works end to end on the live
server: that the plugin fires hooks, encodes timing, and that the backend parser
reads team orientation correctly across map halves. **WARNING: This changes the
live server. Real players are usually connected. Before you start, run `R "status"`
to see who is online and get the owner's explicit go-ahead before proceeding.**

### 1. Stage the plugin

    ./stage.sh

Expected: `Plugin PUG Match reloaded successfully.` This copies one file and calls
`sm plugins load`. No server restart; the plugin stays inert until a match is
configured.

### 2. Play or simulate one full map of a PUG

Both halves must go live and end normally. If debugging the orientation mapping
is needed, set `sm_pug_debug 1` first; otherwise the default output is sufficient.

You can play with bots, simulate with a full human roster, or use the existing
`!load_4v4p` flow. The point is that each half must transition from pending to
live to ended, so the plugin records `ROUND_START` and `ROUND_END` for both half 1
and half 2.

### 3. Confirm the rounds landed and the sides are opposite

    sqlite3 data/pug.db "SELECT match_id, ordinal, half, surv_team, score, reliable FROM match_rounds ORDER BY match_id DESC, ordinal, half LIMIT 10;"

Expected: two rows per map, one for half 1 and one for half 2, with **different**
`surv_team` values between the two halves (one row should have `surv_team=a` and
the other `surv_team=b`, or vice versa). If both halves show the same `surv_team`,
the orientation mapping is being read too early and this is the bug the check
exists to catch.

### 4. Confirm events carry timing

    sqlite3 data/pug.db "SELECT kind, half, t_ms FROM match_live_events WHERE t_ms >= 0 ORDER BY match_id DESC, seq DESC LIMIT 10;"

Expected: all `t_ms` values are non-negative, and within each half they increase
in sequence. The `half` column should reflect which round the event occurred in.
If all values are -1, the staged plugin did not actually reload and the event
capture is not running.

### 5. Confirm the new event kinds actually fire

    sqlite3 data/pug.db "SELECT kind, COUNT(*) FROM match_live_events GROUP BY kind ORDER BY 2 DESC;"

Expected: after one full map you should see `pinned`, `cleared`, `incap`, `death`,
`ff` and `si_spawn` all present with nonzero counts. A kind showing zero rows after
a full map is either a hook that did not fire or an event name mismatched to this
engine, both of which need investigation before future work builds on the timeline.

Note that `tank_take` and `tank_give` legitimately show zero if tank control never
changed hands during the half, `skeet` and `dp` show zero on a server with no `skill_detect`
loaded (both kinds cannot be captured without it), and `car_alarm` and
the witch events (`witch_aggro`, `witch_killed`) are map-dependent and may be absent
on maps that do not have them.

`ff` is coalesced: damage to a teammate is accumulated per attacker/victim pair and
flushed once a second, at 50 damage, or at round end. So expect far fewer `ff` rows
than shots fired, each carrying the total of a burst. The authoritative per-player
friendly fire total is still the counter in the dump, not a count of these rows.

### 6. Confirm per-round attribution through the API

Pick a player who you know played both sides (survivor and infected). Then query
the match from the backend:

    curl -s localhost:8080/api/matches/<match_id> | python3 -m json.tool | head -60

Expected: the `rounds` array has two entries per map. For your chosen player, their
survivor-side keys appear only in the round(s) where their assigned pug team held
survivor, and their infected-side keys appear only in the other half. If a player's
keys appear in both halves on the same side, the attribution is wrong and the
team-to-side binding is unstable across the map.

The keys to look at, using their real names:

- survivor side, present in every match: `ck` (common kills), `sidmg` (SI damage),
  `sikill` (SI kills), `ff` (friendly fire dealt), `rev` (revives), `tank_damage`
- infected side, present in every match: `damage_as_si`, `tank_punches`,
  `boomer_spawns`, `boom_successes`, `boomed_vomit`, `boomed_proxy`
- with `skill_detect` loaded, also `skeets` and the rest of the skill keys on the
  survivor side, and `dps_landed` / `biles_landed` on the infected side

`hp` is deliberately absent from both halves: it is a health reading at one moment,
not a counter that accrues, so there is no half it can honestly belong to.

Also check `endedAt` on each round. A round with `endedAt: null` never received a
`ROUND_END`, which makes its `score` the column default rather than a result; do not
read a zero there as "they scored nothing".

### 7. Check the SourceMod log for failed event hooks

    ssh root@$L4D_HOST 'tail -100 /home/l4d/l4d1-server/left4dead/addons/sourcemod/logs/L*.log' | grep -i "hook\|failed"

Look for any error lines about hooking. The specific event `triggered_car_alarm` is
unverified on L4D1: it is commented out and L4D2-gated in `l4d2_skill_detect.sp`,
so it may not exist on this engine. A log line saying it failed to hook is an
expected, tolerable outcome, not a failure of the deployment. If `triggered_car_alarm`
fails to hook, `car_alarm` is simply absent and nothing else is affected. An entity
hook on `prop_car_alarm` is NOT a drop-in fallback: an entity hook fires game code,
not a game event, so it produces no event for `HookEventEx` to catch and would need
its own emission written against whatever the hook can see. Treat that as unbuilt
work rather than as a switch to flip.

### 8. What a mid-round restart does now

An admin restarting a live round mid-half used to break the rest of the map: the
half was a counter that `OnRoundIsLive` incremented unconditionally, so a re-fire
pushed it past 2, the backend dropped that round entirely, and every later event
carried `half=-1`. The half is now read from `m_bInSecondHalfOfRound` each time a
round goes live, so a restart re-reads the same value and the rows stay correct.

What a restart still costs is the round's accrued stats: the counters are not
rewound, so damage and kills from before the restart remain in that half's totals.
`match_rounds.reliable` does not detect this. If a restart happens during
verification, record it in your notes and treat that half's stats as approximate.

## Replay recording verification

This runbook verifies that replay recording works end to end on the live server:
that the plugin's binary writer and `src/replayFormat.ts`'s reader agree on the
byte layout, that the frame-time cost is affordable at 100 tick, and that chat and
indexing land alongside the file. The TypeScript tests only prove the TypeScript
encoder and decoder agree with each other; they say nothing about the Pawn writer,
which is a second, by-hand implementation of the same layout. This is the runbook
that closes that loop. **WARNING: This changes the live server. Real players are
usually connected. Before you start, run `R "status"` to see who is online and get
the owner's explicit go-ahead before proceeding.**

**The single most likely failure is a layout disagreement**, where the Pawn writer
and `replayFormat.ts` put a field at different offsets. The symptom is not an
error: it is plausible-looking nonsense, for example health in the thousands or
positions that jump wildly between frames. If Step 3 below produces anything that
looks off, do not assume a gameplay explanation before comparing the offsets in
`RplOpen` / `Timer_RplFrame` against `OFF` and the record layouts in
`src/replayFormat.ts` field by field.

### 1. Stage the plugin

    ./stage.sh --solo

Expected: `Plugin PUG Match reloaded successfully.` `--solo` also sets
`sm_pug_min_orient 1` and `sm_pug_debug 1`, which is what makes a one-person test
produce a settled orientation mapping and verbose logging. `stage.sh` copies one
file and calls `sm plugins load`: no restart, no map change, nobody dropped.

### 2. Confirm the cvars exist and recording is on

    ./stage.sh --status

Expected: `sm_pug_replay_hz 10`, `sm_pug_replay_entity_hz 10`,
`sm_pug_replay_dir replays`, `sm_pug_replay_max_mb 64`. A missing cvar means the
staged `.smx` is the old one and nothing below is meaningful.

- [ ] All four cvars present: ____

### 3. Play a round solo

Start a match with `!load_4v4p`, ready up, and play a few minutes of a half, then
end the round. Move around, get bots into the shot, shoot commons, and if you can,
get pinned once. The point is to produce variety in the recording, not to play
well.

### 4. Confirm the file exists and is growing

    ls -la /home/l4d/l4d1-server/left4dead/replays/

Expected: one `pug_<token>_<ordinal>_<half>.rpl` per round played, tens to hundreds
of KB per minute. Zero bytes means `RplOpen` failed; check
`addons/sourcemod/logs/errors_*.log`.

- [ ] File(s) present and growing: ____

### 5. Pull a file back and read it

    scp l4d@<host>:/home/l4d/l4d1-server/left4dead/replays/pug_*.rpl /tmp/
    npx tsx scripts/dump-replay.ts /tmp/pug_<token>_1_1.rpl

Each of the following is a distinct thing that can be wrong, so check all of them
rather than stopping at the first one that looks fine:

- `header.token` matches the filename, `map` is the real map name, `ordinal` and
  `half` are right.
  - Result: ____
- `effective hz` is close to 10.00. Materially below means the timer is being
  starved and the sample rate is a lie.
  - Result: ____
- `truncatedBytes` is 0 and `index` is non-zero. Non-zero truncation on a cleanly
  ended round means `RplClose` did not run.
  - Result: ____
- `header.slots[0]` is your SteamID64. A wrong or zero value means
  `StringToInt64` packing is wrong and every slot mapping in the viewer will be
  wrong.
  - Result: ____
- Your player record's `pos` changes between frames and is within roughly
  +/- 16384.
  - Result: ____
- `hp` is 100 or below with a plausible temp value, `wep`/`clip`/`reserve` match
  what you were holding.
  - Result: ____
- `entities` in the middle frame contains `SURVIVOR_BOT` entries for the bots and
  `COMMON` entries for the commons.
  - Result: ____

Remember the warning above: if any of this looks wrong, it is far more likely to
be a layout disagreement between the plugin and `src/replayFormat.ts` than a real
gameplay artifact. Compare offsets field by field before chasing anything else.

### 6. Run the frame-time gate

This is the acceptance criterion, not a footnote. The box's recorded baseline p99
is 11.25ms against a 10ms budget at 100 tick, so roughly 1% of frames already
overrun and there is no headroom to spend carelessly.

With `l4d_tickstats` capturing, play roughly five minutes at each setting,
changing it live by rcon:

    R "sm_pug_replay_hz 0"
    # play ~5 minutes, capture with l4d_tickstats
    R "sm_pug_replay_hz 10"
    # play ~5 minutes, capture with l4d_tickstats

Compare p99 and p999 between the two captures.

- p99/p999 at `sm_pug_replay_hz 0`: ____
- p99/p999 at `sm_pug_replay_hz 10`: ____

Then follow the escalation ladder and record whatever it lands on:

- **p99 unchanged:** ship at 10Hz.
- **p99 moves measurably:** set `sm_pug_replay_entity_hz 5` and re-measure.
  Entities are the larger half of the per-frame work, and halving them is visually
  identical after viewer interpolation.
  - p99/p999 at `sm_pug_replay_entity_hz 5`: ____
- **Still moving with entities at 5Hz:** set `sm_pug_replay_hz 5` and re-measure.
  - p99/p999 at `sm_pug_replay_hz 5`: ____
- **Still moving at 5Hz/5Hz:** stop. The design's cost estimate is wrong, and that
  is a finding worth having before anything is built on top of it. Leave
  `sm_pug_replay_hz 0` on the box and write up what was measured.

Record both numbers at every setting tested, whatever the outcome, and note here
which rung of the ladder this landed on: ____

### 7. Confirm chat landed

    sqlite3 data/pug.db "SELECT seq, half, t_ms, team, message FROM match_chat ORDER BY seq DESC LIMIT 10;"

Expected: what you typed, intact, including any message containing spaces. No
rows at all means `player_say` did not hook; check the SourceMod error log for the
`LogError` from Task 6.

Also say something with an `=` in it and confirm it survives whole, since `=` is
the kind of character a naive delimiter-based encoding would eat.

- [ ] Chat rows present and intact: ____
- [ ] Message containing `=` survived whole: ____

### 8. Confirm indexing happened on its own

Indexing is wired into `round_end` and into match completion, so no manual step
should be needed. Check:

    sqlite3 data/pug.db "SELECT match_id, ordinal, half, frames, sample_hz, bytes FROM match_replays;"

Expected: one row per round file, `frames` matching what `dump-replay.ts` reported,
`sample_hz` 10.

- [ ] Rows present, `frames` matches `dump-replay.ts`: ____

No rows at all, with files present on disk, is the likeliest configuration mistake
in the whole piece: `REPLAY_DIR` and `sm_pug_replay_dir` disagree. Those are two
separate settings on separate sides of the box and nothing forces them to agree.
`sm_pug_replay_dir` is relative to the game dir, so `replays` means
`<gamedir>/left4dead/replays`, and `REPLAY_DIR` must be the absolute path to that
same directory.

## Pause limits verification

There is no unit harness for SourcePawn in this repo, so this is the test for
`pug-pause.inc`. Run it solo; two of the steps need a second client, noted
where they do.

Settings, both live-changeable over rcon:

    R "sm_pug_pause_seconds"   # 120
    R "sm_pug_pause_limit"     # 3

Shorten the ceiling first so the whole thing takes a minute rather than ten:

    R "sm_pug_pause_seconds 20"

### 1. A pause is charged once, and announced with what is left

With a match live, type `!pause` in chat as a rostered player.

Expect chat: `Team A pause 0:20 max. 2 pauses left this campaign.`

    R "sm_pug_status" | grep pause

Expect `pause limit=3 seconds=20 used_a=1 used_b=0` and a `pause active` line.

- [ ] Charged to the right team, count 1: ____

### 2. The ceiling fires, with warnings

Stay paused and watch chat. At 10 seconds left expect
`Unpausing in 10 seconds`, then `Team A's pause has run out. Unpausing.` and
the game resumes on Rotoblin's countdown.

The warning marks are 30 and 10 seconds remaining, so with `seconds 20` only
the 10 mark can fire. Set `seconds 60` if you want to see both.

- [ ] Unpaused on its own, warning seen, game actually resumed: ____

### 3. `!ready` still ends a pause early

Pause again, then both teams `!ready` before the ceiling. Expect the normal
Rotoblin unpause. The budget is not refunded: the pause happened.

- [ ] Ended early, `used_a=2`: ____

### 4. The budget runs out and the pause is refused

Spend the third pause, let it expire, then try a fourth.

Expect chat: `Team A has used all 3 pauses for this campaign.` and the game
does NOT pause. `sm_pug_status` still shows `used_a=3`, not 4.

- [ ] Refused, not charged, game unpaused: ____

### 5. A refused pause does not block the other team

As a Team B player, `!pause`. It must work: the budget is per team.

- [ ] Team B still has its own 3: ____

### 6. A disconnect pause is neither charged nor capped

Needs a second client. With a match live, have a rostered player disconnect.
The game pauses from `pug-leave.inc`.

Expect: no `Team X pause` line, `used_a` and `used_b` unchanged, and the pause
does NOT expire after `sm_pug_pause_seconds`. It ends when they reconnect.

- [ ] Not charged, not capped: ____

This is the case most likely to regress, because it depends on
`PauseAllowInternal()` being called immediately before the leave module's own
`sm_pause`. If a disconnect ever starts costing a team a pause, that call is
what to look at.

### 7. The ceiling clock stops while someone is away

Needs a second client. Call a pause, then have a player disconnect while it is
running. The ceiling must stop counting down until they are back, so a player
pause cannot expire under someone still loading in.

- [ ] Did not expire while a player was absent: ____

### 8. The budget is per campaign, not per map

Spend a pause, then finish the map and let the next one load. `used_a` must
still show the pause. Then reset the match (`!load_4v4p` or a new match) and it
must go back to 0.

- [ ] Survived a map change, cleared on a new match: ____

Put `sm_pug_pause_seconds` back to 120 when you are done:

    R "sm_pug_pause_seconds 120"

## Reconnect clock control (`sm_pug_leave`, 0.3.4)

There is no unit harness for SourcePawn in this repo, so this is the test for
the admin hold in `pug-leave.inc`. It needs one real client, and that client
can be you: you are the player who drops, and the rcon shell keeps working while
you are disconnected.

`T` below is any throwaway 32 hex token and `ME` is your SteamID64:

    T=$(openssl rand -hex 16); ME=76561198030413993

### A. Empty server: the command exists and refuses correctly

No client needed. Only with the server empty (`R status` shows 0 humans).

    R "sm_pug_match 999999 $T NoMercy"
    R "sm_pug_leave"
    R "sm_pug_leave 00000000000000000000000000000000 $ME hold"
    R "sm_pug_leave $T"
    R "sm_pug_leave $T $ME hold"
    R "sm_pug_leave_hold_max"
    R "sm_pug_status"
    R "sm_pug_abort $T"

- [ ] `PUGOK match=999999`: ____
- [ ] no arguments answers `PUGERR token required`: ____
- [ ] the wrong token answers `PUGERR bad token`: ____
- [ ] the token alone answers `PUGERR usage: sm_pug_leave ...`: ____
- [ ] an unrostered id answers `PUGERR not rostered`: ____
- [ ] the cvar prints `1800`: ____
- [ ] status has `STATUS leave abandoner=none ... holdmax=1800`: ____
- [ ] `PUGOK aborted`: ____

Hold, release and end need a rostered player who has actually dropped, so they
cannot be checked on an empty server. That is part B.

### B. Real client

Shorten both clocks first so the whole thing takes five minutes, not forty:

    R "sm_pug_match 999 $T no_mercy"
    R "sm_pug_roster \"$ME:a\""
    R "sm_pug_leave_budget 180"
    R "sm_pug_leave_hold_max 20"

Join the server. `R sm_pug_status` must show your slot with `connected=1`.
To watch the log lines, use the `nc -ul 27500` recipe from section 4.

1. **Pre-grant.** While connected: `R "sm_pug_leave $T $ME add 60"`.
   - [ ] `PUGOK leave steamid=... absent=0 remaining=240 held=0 hold_left=0`: ____
   - [ ] a `RETURN steamid=... remaining=240` line, and a chat line about more reconnect time: ____
2. **Hold is refused while connected.** `R "sm_pug_leave $T $ME hold"`.
   - [ ] `PUGERR not dropped`: ____
3. **Drop.** Disconnect from the game. Wait ten seconds.
   - [ ] status shows `absent=1 remaining=` near 230 and falling: ____
4. **Hold.** `R "sm_pug_leave $T $ME hold"`, then status twice, ten seconds apart.
   - [ ] `PUGOK ... absent=1 remaining=N held=1 hold_left=20`: ____
   - [ ] `remaining` is the SAME in both status reads: ____
   - [ ] a `LEAVE ... held=1 hold_left=... auto=0` line: ____
5. **The ceiling.** Wait until 25 seconds after the hold.
   - [ ] a `LEAVE ... held=0 hold_left=0 auto=1` line: ____
   - [ ] status shows `held=0` and `remaining` falling again: ____
6. **Release is idempotent.** `R "sm_pug_leave $T $ME release"` twice.
   - [ ] both answer `PUGOK ... held=0`: ____
7. **Hold across a map change.** `R "sm_pug_leave_hold_max 600"`, hold again, note `remaining`, then
   `R "changelevel l4d_hospital02_subway"`. After the map loads:
   - [ ] status still shows `held=1` and the same `remaining`: ____
   - [ ] the SourceMod error log has no `Invalid timer handle` or `Invalid Handle` from pug-match: ____
8. **Return while held.** Still held, join the server again.
   - [ ] chat says you are back; status shows `absent=0 held=0`: ____
   - [ ] `remaining` is what it was at the hold, not less: ____
9. **Match end while held.** Disconnect, hold, then `R "sm_pug_abort $T"`. Set the same match up again
   (`sm_pug_match`, `sm_pug_roster`).
   - [ ] status shows no `STATUS leave slot=` line at all: ____
10. **End now.** Join, disconnect, then `R "sm_pug_leave $T $ME end"`.
    - [ ] `PUGOK ... absent=1 remaining=0 held=0`: ____
    - [ ] within two seconds: the "did not reconnect in time" chat line and a `PUG ... ABANDON steamid=...` line: ____
    - [ ] status shows `STATUS leave abandoner=<your id>`: ____
    - [ ] a further `R "sm_pug_leave $T $ME add 60"` answers `PUGERR match already abandoned`: ____

Put everything back:

    R "sm_pug_abort $T"
    R "sm_pug_leave_budget 300"
    R "sm_pug_leave_hold_max 1800"

## Teardown (`sm_pug_abort <token> teardown <map>`)

Needs a REAL client connected to the local test server (`/home/volence/l4d1-ds`,
LAN address 192.168.4.85, `sv_allow_lobby_connect_only 0` after each map load).
Rotoblin must be loaded. Over RCON:

1. `sm_pug_match 999 <32 hex chars> no_mercy`, then `sm_pug_roster "<your steamid64>:a"`.
2. Join the server. Confirm `sm_pug_status` shows you rostered.
3. Unpaused case: `sm_pug_abort <token> teardown l4d_hospital01_apartment`.
   Expect within ~6 s: the "[PUG] Match #999 cancelled." chat line, a kick whose
   dialog reads "Match #999 cancelled.", then `status` over RCON shows
   `map : l4d_hospital01_apartment` and 0 humans.
4. Paused case: repeat 1 and 2, then type `!pause` in game. Run the same abort.
   With only one client connected, `LeaveUnpauseNow` can send `sm_ready` for
   only one team, so Rotoblin's both-teams-ready countdown may legitimately
   never complete; either outcome below is expected, not a bug, with a single
   tester:
   (a) The game unpauses within 10 s: the kick and map change happen as in
       step 3, and the srcds console shows no `PROBLEM` line.
   (b) The 10 s wait times out: the console shows
       `PUG <token> PROBLEM code=unpause_timeout`, then the kick still runs.
       Record whether the map changed afterward too, that is the open
       changelevel-while-paused question from the spec; note the answer in
       the spec's spike table.
   Record which of (a) or (b) happened. A second real client on the other
   team turns this step into a real test of the unpause path, since only then
   can both teams actually ready up.
5. Bad map: `sm_pug_abort <token> teardown "l4d_hospital01_apartment; sv_cheats 1"`.
   Expect the kick, no map change, and no cvar change.
6. Plain abort still plain: configure again, `sm_pug_abort <token>`. Expect no
   kick and no map change (the routine post-report path is unchanged).

`sm_addban` cannot be tested here: on a LAN server it is a silent no-op.

## Balance inventory verification

Run 2026-09-23 on the isolated local instance `/home/volence/l4d1-ds-skyprobe/server`
(port 27045, `-insecure`, `sv_lan 1`, bound to 127.0.0.1), never on a live box.
That instance already carries the full stripper tree
(`addons/stripper/Roto-AZMod/maps`, 139 files, 4.1 MB, 138 of them `.cfg`), which
is larger than the 59 files in `deploy/overrides`, so the timing below is a worst
case, not a flattering one.

### Setup

Modelled on `plugin/skypounce/rig/run.sh roto`. The instance is shared with other
test workstreams, so its own plugins dir and `server.cfg` are backed up first and
put back afterwards. Every path is absolute except where a `cd` says otherwise.

    # 0. Nothing may already be on the port. If this prints anything, stop.
    pgrep -af "srcds_linux.*-port 27045"

    # 1. Build (from the plugin dir of your checkout or worktree).
    cd /home/volence/l4d/pug/plugin && ./build.sh

    # 2. Back up the instance's own plugins dir and server.cfg.
    INST=/home/volence/l4d1-ds-skyprobe/server
    SM=$INST/left4dead/addons/sourcemod
    BK=$(mktemp -d)
    cp -a $SM/plugins $BK/plugins
    cp -a $INST/left4dead/cfg/server.cfg $BK/server.cfg

    # 3. The Rotoblin set from the shared install (READ only), minus the other
    #    sessions' test plugins, plus the fresh build.
    rm -rf $SM/plugins && mkdir -p $SM/plugins
    cp -a /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins/. $SM/plugins/
    rm -f $SM/plugins/{l4d_probe,skyprobe,skyrig,l4d_skypounce}.smx
    cp /home/volence/l4d/pug/plugin/pug-match.smx $SM/plugins/pug-match.smx

    # 4. Start srcds with stdin on a FIFO so console commands can be fed to it.
    mkfifo $BK/fifo
    cd $INST && ( exec 3<>$BK/fifo; timeout 1500 ./srcds_run -console -game left4dead \
        -ip 127.0.0.1 -port 27045 -tickrate 100 -maxplayers 8 -norestart -insecure \
        -nomaster +sv_lan 1 +mp_gamemode versus +exec server +sv_logecho 1 \
        +map l4d_hospital01_apartment <&3 > $BK/console.log 2>&1 ) &

    # Send a command (the timeout keeps the shell from blocking forever on the
    # FIFO if srcds has died):
    timeout 5 sh -c "echo 'sm_pug_debug 1' > $BK/fifo"

Read results from `$SM/logs/L<yyyymmdd>.log` (the SourceMod log, timestamped),
not from `console.log`: srcds's stdout lags by one command, so the line a
command produced often shows up there only after the NEXT command is sent.

Teardown, always:

    timeout 5 sh -c "echo quit > $BK/fifo"
    pgrep -af "srcds_linux.*-port 27045"          # must print nothing
    rm -rf $SM/plugins && cp -a $BK/plugins $SM/plugins
    diff -r $BK/plugins $SM/plugins && diff $BK/server.cfg $INST/left4dead/cfg/server.cfg

### 1. Scan cost

`sm_pug_debug 1` can only be set after boot, so the boot scan itself is not
logged. `sm plugins reload pug-match` builds a fresh plugin with an empty cache
and rescans at once, which is the same cold scan the first map pays. Warm scans
are map changes:

    sm_pug_debug 1
    sm plugins reload pug-match          # cold: "balance scan: N items in X ms"
    changelevel l4d_hospital02_subway    # warm
    changelevel l4d_hospital03_sewers    # warm

Gate: cold under 250 ms, warm under 20 ms.

Cold samples on the final build (commit f17b73a), one reload every 8 s,
`/proc/loadavg` read immediately before each reload was sent (16-core host):

| Sample | Cold scan | loadavg (1, 5, 15 min) |
|---|---|---|
| 1 | 133.6 ms | 2.62 2.92 3.04 |
| 2 | 134.5 ms | 2.65 2.92 3.04 |
| 3 | 134.9 ms | 2.63 2.91 3.03 |
| 4 | 133.6 ms | 2.38 2.84 3.01 |
| 5 | 139.1 ms | 2.27 2.81 3.00 |
| 6 | 137.6 ms | 2.40 2.82 3.00 |
| 7 | 139.3 ms | 2.44 2.82 3.00 |
| 8 | 135.3 ms | 2.38 2.80 2.99 |
| 9 | 136.0 ms | 3.00 2.92 3.03 |
| 10 | 142.3 ms | 2.92 2.90 3.02 |

All ten under 250 ms; max 142.3 ms. The same process gave 21 more cold samples
earlier, 134.2 to 142.0 ms, at a 1-minute load of about 1.8 to 3.0.

Every measurement, by build (read from the SourceMod log):

| Build | Cold | Warm |
|---|---|---|
| Original | 134.6 ms (1 sample) | 76.3, 78.1, 78.9 ms |
| Directory cache fix and later (runs 3 to 5) | 37 samples 133.6 to 142.3 ms, plus 2 over the gate: 256.9 and 268.8 ms (see below) | 22 samples, 1.2 to 2.4 ms |

The directory cache fix: `BalScanDir` used to refold every stripper config's
bytes at every map start. It now folds each file's cached `size.hash8` (from
`BalFileValue`, cached by path, size and mtime), keeping the `count.hash8` output
and sorted-name order. The directory hash VALUES changed once with that fix.

The two samples over 250 ms both came from run 3, at 11:35:42 (256.9 ms) and
11:40:31 (268.8 ms), with five normal samples (134.5 to 136.9 ms) between them.
Load was not sampled per reload in that run; the one reading, taken about 20 s
after the 268.8 ms sample, was `10.01 5.04 3.37` (1, 5, 15 min), so the host was
busy with other workloads across that window. At a 1-minute load of 1.8 to 3.0
none of 31 later samples went past 142.3 ms. A cold scan is paid once per server
boot, during a map load; what it costs on a busy production box is not measured
here.

(Run 2 also measured one cold scan of 149.9 ms, but that build carried temporary
debug instrumentation in the damage hooks, so it is left out of the numbers
above.)

### 2. Wire output

A backend-shaped match with a fake roster, bots on the survivor side, and
readyup's own force start:

    exec pug_match
    sv_hibernate_when_empty 0            # this instance's server.cfg sets it; keep it off
    sm_pug_debug 1
    sm_pug_min_orient 1
    sm_pug_match 999 testtoken3 l4d_hospital01_apartment
    sm_pug_roster "76561198000000001:a"   # ... through 76561198000000008, 5-8 on b
    changelevel l4d_hospital01_apartment
    sb_add                               # x4: with no human, no survivor bots exist, and
                                         # sm_forcestart does nothing until they do
    sm_forcestart                        # l4dready's admin force start, runs as root from the console
    director_force_panic_event           # needs sv_cheats 1, which this instance's server.cfg sets
    a4d_spawn_infected hunter            # all4dead; plain z_spawn from the console places nothing
    sm_slay @survivors                   # ends the round

In a shell, write the roster ids as `${i}:a`, not `$i:a`: zsh reads `$i:a` as a
path modifier.

Checked against the captured lines:

- 20 `BALANCE` parts plus `BALANCE_END half=1 parts=20 items=289`. The items
  across the parts count to exactly 289, with no duplicate keys.
- Line bodies (after `PUG <token> `) are strictly under 600 bytes: 481 to 597 on
  the final build. Before commit f17b73a a body could reach exactly 600.
- All 43 cvars from `balance/knobs.json` appear: 41 as `c:`, and
  `x:l4d_skypounce_enable=missing`, `x:l4d_skypounce_mode=missing` (skypounce is
  not loaded here).
- `p:pug-match.smx=...` once, the 7 `f:` files, and
  `d:addons/stripper/Roto-AZMod/maps=138.<hash8>`.
- `ROUND_MARK half=1 kind=panic t=25800` after the forced panic.
- `ROUND_STATS_END half=1 players=8 sd=1` then `ROUND_END` after the slay.
  No `ROUND_STAT` line: every rostered id is fake and never connects, and only
  nonzero values go out.
- A second go-live on half 2 sent the same inventory as half 1.
- Weapon names, with a temporary `PugDebug` in `player_hurt`, `player_death`
  and `infected_death` for bot survivors (reverted, never committed):
  `player_hurt` carries `pumpshotgun` and `smg`, `player_death` carries
  `pumpshotgun`, the held weapon for common kills is `weapon_pumpshotgun`,
  `weapon_smg`, `weapon_pistol`. `WpnIndex` mapped every one to its own key,
  none to `other`, so it needed no fix.

A bug this found and fixed: `ReadPlugin` hands back a null handle for a plugin
that failed to load, and plugin natives read null as the calling plugin, so each
of the nine plugins failing on missing extensions here (GeoIP, CollisionHook,
Actions) was listed as another `p:pug-match.smx`: 298 items before, 289 after.

### 3. Backend parser round trip

Captured lines, with the token swapped for 32 hex characters (the parser requires
one), fed through `parseLogDatagram(framed(line))` in a throwaway test: BALANCE
part 0 and part 19 gave `balance_part`, `BALANCE_END` gave `balance_end` with
items 289, `ROUND_MARK` gave `round_mark`, `ROUND_STATS_END` gave
`round_stats_end`. All 20 parts parsed back to 289 items in total.

### Pending for the owner (needs two people in game)

`ROUND_STAT` with `w_<weapon>_sidmg` keys cannot be produced alone: SI damage is
credited only to a rostered, connected survivor and only against a
player-controlled (not bot) SI. On the local test server, or staged per section 0:

1. Both people connect. Configure a match that rosters person A on team a and
   person B on team b, then set the test cvars:

       sm_pug_match 999 <32 hex chars> no_mercy
       sm_pug_roster "<A's steamid64>:a"
       sm_pug_roster "<B's steamid64>:b"
       sm_pug_min_orient 1
       sm_pug_debug 1

2. Get A on survivors and B on infected before going live. On map 1 pug team a
   starts as survivors, and the team lock moves each rostered player to their
   side within about 4 s on its own. If someone is on the wrong side, they type
   `!survivors` (A) or `!infected` (B) in chat; these are l4dready's
   `sm_survivors` / `sm_infected`, which work during ready-up. `!spectate` gets
   out of the way. The M key (`jointeam`) is blocked by l4dready once the round
   has left the saferoom, so use the chat commands. Check with `sm_pug_status`:
   A `side=survivor`, B `side=infected`.
3. Go live (`sm_forcestart` over the console or rcon, or both type `!ready`). A
   shoots B's SI with two or more weapons (the pumpshotgun and a tier 2, a
   molotov if you can) and kills it at least once.
4. End the round (`sm_slay @survivors`). Expect a
   `ROUND_STAT half=1 steamid=<A> ...` line with `w_pumpshotgun_sidmg=`,
   `w_pumpshotgun_sikill=` and the other weapon's keys, and no damage filed under
   `w_other_*` unless a weapon outside the list was used. The `w_*_sidmg` values
   should sum to the line's `sidmg=`.
5. Optional: trigger a car alarm or a crescendo button on a real map and see
   `ROUND_MARK kind=panic` from a natural panic, not a forced one.

## Balance control panel verification

Run 2026-09-24 on the same isolated instance (`/home/volence/l4d1-ds-skyprobe/server`,
127.0.0.1:27045, `-insecure -nomaster +sv_lan 1`), with `pug-match.smx` built
from the branch. Question: does a value the site writes to `cfg/pug_balance.cfg`
come back in the plugin's `c:` items byte for byte, and does the site's
predicted fingerprint equal the real one?

### Recipe

Setup and teardown as in "Balance inventory verification" above, plus: back up
`cfg/rotoblin_pug_4v4_map.cfg` (and `cfg/pug_balance.cfg` if one exists), append
the hook exactly as the owner runbook adds it, at the very end of the map config:

    //-----------------------------------------
    // Balance knobs set from riversidepug.com (Admin > Balance > Knobs). The site
    // writes cfg/pug_balance.cfg; it must never be committed here. Must stay last.
    exec pug_balance.cfg

and write each draft with the site's own code: a scratch `tsx` script calling
`renderBalanceCfg(loadBalanceKnobs(), validateDraft(knobs, draft, baselines).values,
{ number: 0, name: 'rig' })`, copied to `cfg/pug_balance.cfg`. Then, for each
draft, a fresh fake match the way the backend starts one:

    sm_pug_abort <previous token>
    exec pug_match
    sm_pug_debug 1
    sm_pug_min_orient 1
    sm_pug_match 99N <32 hex token> l4d_hospital01_apartment
    sm_pug_roster "76561198000000001:a"   # ... 1-4 on a, 5-8 on b
    changelevel l4d_hospital01_apartment
    sb_add                               # x4
    sm_forcestart

Use a 32 hex character token, so the game log lines (`left4dead/logs/L127_*.log`)
go straight through `parseLogDatagram` and `BalanceAssembler` with no rewriting.
Real fingerprint: `fingerprintOf(withoutIgnored(sighting, ignored), versionless)`.
Predicted: `fingerprintOf(predictInventory(A, knobs, draft), versionless)`, with
A the baseline sighting. Afterwards restore the map config, delete
`pug_balance.cfg` if it was not there before, and delete the run's
`left4dead/replays/pug_<token>_*.rpl` files.

How the file gets run: `rotoblin_pug_4v4.cfg` sets `l4d_ready_server_cfg
"rotoblin_pug_4v4_map.cfg"`, and l4dready execs that file in every
`OnMapStart`; `exec pug_match` also runs it once directly. On every map load
the SM log shows the chain setting `versus_boss_flow_max 0.90` and then
`pug_balance.cfg` setting the draft's value in the same second. Nothing in
`cfg/sourcemod/` (plugin autoexec configs, which run later) sets any of the 16
knobs, on this instance or in the deploy repo.

### Result: all pass

| Run | Draft | `c:` strings | Predicted fp | Real fp |
|---|---|---|---|---|
| 1 | baseline (A) | 16/16 equal | 10acfaf57a8ab35b | 10acfaf57a8ab35b |
| 2 | B: `z_tank_health 7500`, `versus_boss_flow_min 0.15` | 16/16 equal | 8ce5644d1313f1c8 | 8ce5644d1313f1c8 |
| 3 | C: `versus_boss_flow_min 0.10`, `versus_boss_flow_max 0.85` | 16/16 equal | a17d0fa09f167283 | a17d0fa09f167283 |
| 4 | every knob at `min` | 16/16 equal | 25e74e29c690b7ce | 25e74e29c690b7ce |
| 5 | every knob at `max` | 16/16 equal | a7fbb6bf3a21d931 | a7fbb6bf3a21d931 |

- Floats keep their written form: `0.10`, `0.15`, `0.30`, `0.70`, `0.85` and
  `0.90` came back as written, never `0.100000`. No bound was clamped or
  rewritten, so no range in `balance/knobs.json` needed to shrink.
- Run 3 followed run 2 with a `changelevel` only (no `exec pug_match`), so the
  map-load path (l4dready `OnMapStart`) is what applied it.
- `l4d_antibaiter_delay` is 9999 in this instance's (older) config chain and
  came back as the draft's 15, 10 or 30: the file set it, not the chain.
- Apart from the knob values, every inventory key was identical across the
  five sightings (290 items each), so only the knobs moved the fingerprint.
- Nothing re-asserts a knob after the configs: in run 5 all 16 values read
  back unchanged with `sm_cvar <name>` about a minute into the live round
  (after a forced panic and a spawned hunter) and again after half 2 went
  live, and half 2's sighting had the same fingerprint as half 1.
- `pug_balance.cfg` deleted, then `changelevel`: the console prints
  `exec: couldn't exec pug_balance.cfg` and every knob falls back to the
  config chain's value (this instance's chain sets all 16).

Not covered here: the production chain itself (this instance's copy of
`rotoblin_pug_4v4_map.cfg` predates the votes block, which sets no knob), and
the web app writing the file over each box's transport. Both are steps 2 to 5
of the owner runbook.
