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

## 3. Non-rostered kick

Have someone not on the roster join, or temporarily roster only fake IDs and
join yourself. Expect a kick with the roster message.

Then check `sm_pug_status` shows `connected=0` again.

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

Expect `PUGOK aborted`. After this, rostered enforcement stops: a non-rostered
player joining is no longer kicked. Verify that, since a stuck enforcer would
kick your casual players.

## 11. Heartbeats

`PUG <token> HEARTBEAT` every 30s while a match is configured, none at
`state=none`.

## Skill stats verification

This runbook is run against a live ranked match to verify the skill-detection
integration end to end. Everything above is unproven until this passes.

### 1. Stage the plugin

    ./stage.sh --solo

Expected: `Plugin PUG Match reloaded successfully.` Do NOT accept a `FAILED to load` message without checking `sm plugins list` for `"PUG Match"` yourself; that grep was wrong until 2026-09-06.

### 2. Confirm the capability flag samples correctly

With skill_detect loaded, set up a match and take it live, then:

    R "sm_pug_dump testtoken" | head -1

Expected: `DUMP match=<id> skilldetect=1`

Then unload skill_detect (`sm plugins unload l4d2_skill_detect`), set up a fresh match, take it live, and dump again. Expected: `skilldetect=0`, and `SKILL` lines carrying only `tank_damage`, `damage_as_si` and `tank_punches`. This is the check that proves "not measured" cannot be persisted as zero.

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
