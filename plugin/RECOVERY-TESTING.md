# Crash recovery: local test runbook and deploy order

Plan 5 (crash recovery for booked game servers). This drives `sm_pug_resume`
(pug-match 0.3.19), the `l4d_booking_id` boot marker (l4d_booking 1.4.0) and
the l4dscores seed (8.5.9-riverside3) on the local test server,
`/home/volence/l4d1-ds`. It never touches a remote or live box.

**Status: NOT YET RUN.** No step below has been carried out. Fill in what each
step printed, and any fix made, when it is run.

## 0. Before touching the server

The local server is shared. Other sessions' srcds (ports 27015 and 27045) load
the same plugin directory, so swapping a plugin there changes their servers
too. Swap plugins only when nobody else is using it. Check first:

```
python3 /home/volence/l4d1-ds/rcon-local.py status
ps -ef | grep [s]rcds_linux
```

If any human is listed, or an srcds you did not start is running on the shared
plugin dir, **stop here** and ask the owner. Local in-game tests use cheats
mode (`start-cheats.sh`, config `rotoblin_cheats_4v4`).

## 1. Stage the three builds on the local server only

```
cd /home/volence/l4d/pug/.claude/worktrees/competitive-f5/plugin
./build.sh && ./build-booking.sh
PLUG=/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins
cp pug-match.smx l4d_booking.smx "$PLUG/"
cp /home/volence/l4d/deploy/overrides/left4dead/addons/sourcemod/plugins/l4dscores.smx "$PLUG/"
cd /home/volence/l4d1-ds && ./start-cheats.sh
python3 rcon-local.py "sm plugins list" l4d_booking_version l4d_booking_id
```

Expected: `sm plugins list` shows pug-match 0.3.19 and l4dscores
8.5.9-riverside3; `l4d_booking_version` is `1.4.0`; `l4d_booking_id` exists
and is empty (`""`).

Result: _not run_

## 2. Resume with no clients (the plugin contract)

```
cd /home/volence/l4d1-ds
python3 rcon-local.py "sm_pug_resume 999 abc123 l4d_vs_hospital01_apartment b 50" \
  "sm_pug_resume_map l4d_vs_hospital01_apartment 400 300" \
  'sm_pug_roster "76561199000000001:a:0"' \
  'sm_pug_roster "76561199000000002:b:0"' \
  "sm_pug_resume_commit"
python3 rcon-local.py "changelevel l4d_vs_hospital02_subway"
python3 rcon-local.py sm_pug_status
```

Expected:
- `PUGOK resume=999`, `PUGOK resume_map=1`, `PUGOK roster=1`, `PUGOK roster=2`,
  then `PUGOK resumed maps=1 roster=2`.
- After the changelevel, `sm_pug_status` shows `STATUS state=pending match=999`,
  `campaign=l4d_vs_hospital02_subway` (OnMapStart takes the campaign from the
  replayed map for a Pending self-started match; the `<firstmap>` argument only
  holds until then), one `STATUS map ordinal=0 ... a=400 b=300` line and
  `seedHold=1`.
- The SourceMod log shows `[pug] map l4d_vs_hospital02_subway: resumed match,
  pug team b survives first`, and a heartbeat with token `abc123` arrives on
  the log feed.

Result: _not run_

Step 2 was run 2026-10-01 on a private copy of the local server (port 27065):
PUGOK resume, resume_map, roster x2 (quoted), resumed maps=1 roster=2; after
changelevel state=pending, seedHold=1, pug team b survives first. Unquoted
roster args are refused by the console tokenizer (found by this run).

## 3. With the owner's client plus bots (needs the owner)

Only on the owner's go-ahead: launch their client through the HUD harness and
join on the LAN address (`connect 192.168.4.85:27015`). Repeat step 2 with the
owner's steamid rostered as team `b` and `b` surviving first.

Expected:
- The owner is placed on survivors.
- At go-live the log shows `[pug] resumed match 999 live: l4dscores seeded
  survivors=300 infected=400 (pug team b on survivors)` and
  `[l4dscores] seeded: survivors=300 infected=400 mapCounter=...`;
  `sm_printscores` shows those totals.
- After the map, the next map's survivor-first order follows the totals.
- `sm_pug_dump abc123` at the end lists map 1 at 400/300 plus the played map.

Note whether `mapCounter` = map number or 1 is right for the finale swap, and
fix `SeedL4dscoresTally` if needed.

Result: _not run_

## 3b. The engine's campaign score (ruling 6)

In the same session, during ready-up of the resumed match, load a throwaway
scratch plugin with an admin command that calls
`L4D_SetCampaignScores(300, 400)` (left4dhooks; the L4D1 linux symbol
`_ZN16CTerrorGameRules17SetCampaignScoresEii` is in its gamedata). Then read
the scoreboard (Tab) on the owner's client and `L4D_GetCampaignScores` /
`m_iCampaignScore` on both logical teams.

- If the 300 lands on the team on survivors (or provably on a fixed logical
  team that maps from `g_iLogicalOfPugA`), add the call to
  `SeedL4dscoresTally` with that mapping, rebuild, re-check, and ship it as
  part of pug-match 0.3.19.
- If the mapping cannot be pinned in one session, leave it out (the owner
  accepted that) and write here what was seen.

Result: _not run_

## 4. A real crash under the site (dev server)

Point the dev API (scratch DB, API on 8091, `/api/dev/login`) at the local box
as a pool server, turn the competitive switch on for admins, and make a
booking. Let it go ready (`l4d_booking_id` now holds the booking id), then:

```
kill -9 $(pgrep -f 'srcds_linux.*-port 27015')
```

Expected within 2 minutes:
- An admin event `Booking <id>: <server> restarted; setting it up again`.
- The box is set up again: `l4d_booking_password`, `sv_password` and
  `l4d_booking_id` are back (`python3 rcon-local.py l4d_booking_id` prints the
  booking id).
- Then `Booking <id>: restored on <server>` in the admin feed, and the accepted
  players get the booking_recovered notice with the connect line.
- With a live game on a map before the finale, the game comes back on the map
  it was on, with `say [Booking] Restored after a server restart: ...`. A game
  lost on the finale is aborted (server_lost) and the booking carries on.

Result: _not run_

## 6. Deploy order (for the owner's go-ahead, not done by this plan)

1. **Web first.** Safe alone: with l4d_booking 1.4.0 unstaged, setup refuses
   every box (no `l4d_booking_id`), and nothing recovers.
   **No booking may be running when the web change deploys.** A booking set up
   by the old site has an empty boot marker, and the new site would read that
   as an srcds restart and set it up again.
2. Then stage, on every pool box (dallas, riverside-3, riverside-4,
   riverside-5, riverside-6; Chicago is out of the pool):
   - `l4dscores` 8.5.9-riverside3 (deploy repo commit 4edc162),
   - `pug-match` 0.3.19 (carries 0.3.18's unshipped seed-and-hold),
   - `l4d_booking` 1.4.0,

   through `deploy/tools/stage-on-restart.sh`, so each goes live at the box's
   next srcds restart and never mid-match. Copy the two pug builds into the
   deploy overrides first, then for each target:

   ```
   cd /home/volence/l4d/deploy
   cp /home/volence/l4d/pug/plugin/pug-match.smx /home/volence/l4d/pug/plugin/l4d_booking.smx \
      overrides/left4dead/addons/sourcemod/plugins/
   tools/stage-on-restart.sh <target> \
      addons/sourcemod/plugins/l4dscores.smx \
      addons/sourcemod/plugins/pug-match.smx \
      addons/sourcemod/plugins/l4d_booking.smx
   tools/stage-on-restart.sh <target> --status
   ```

   (Check where l4d_booking.smx lives on the boxes today before staging: at
   the time of writing it is not tracked in the deploy repo overrides.)
3. **Verify per box** after its restart: `l4d_booking_version` is `1.4.0`,
   `l4d_booking_id` exists, and `sm plugins list` shows pug-match 0.3.19 and
   l4dscores 8.5.9-riverside3.
