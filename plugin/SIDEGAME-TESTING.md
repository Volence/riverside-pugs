# pug-sidegame: local test runbook

This drives `pug-sidegame.smx` by rcon on the shared local test server,
`/home/volence/l4d1-ds`, without a game client. It never touches a
remote/live box.

## 0. Before touching the server

The box is shared with other sessions and the owner. Check first:

```
python3 /home/volence/l4d1-ds/rcon-local.py status
```

If any human players are listed (not bots), or the server is not running,
**stop here**. Do not start, restart, or load/unload anything on it. Skip
the rest of this runbook and note the skip in the task report.

## 1. Start clean

```
cd /home/volence/l4d1-ds && ./start-test.sh     # not cheats: this test needs rotoblin_hardcore_2v2/3v3
cp /home/volence/l4d/pug/.claude/worktrees/side-games/plugin/pug-sidegame.smx \
   server/left4dead/addons/sourcemod/plugins/
python3 rcon-local.py "sm plugins load pug-sidegame"
```

## 2. Arm a side game and check the basics

```
python3 rcon-local.py "sm_side_start deadbeef01 side_deadbeef" \
                       'sm_side_roster "<your id64>:A" "<stranger id64>:S"' \
                       "exec rotoblin_hardcore_2v2" \
                       "sm_pug_auto_track"
```

Expect:
- `sm_side_start` replies `PUGOK side start`.
- `sm_side_roster` replies `PUGOK roster=2`. Each seat is quoted, as the
  site sends it: unquoted, Source's tokenizer splits `id:A` on ':' (the
  plugin still accepts that split form, and refuses any seat it cannot read
  with `PUGERR bad seat: ...`).
- `sm_pug_auto_track` reads `0` (was whatever it was before `sm_side_start`).
- Your client is walked onto its assigned side within ~2s (`sm_sur`/`sm_inf`
  fired via the lock timer); the stranger's seat (`S`) is pushed to
  spectate.
- `sv_password` equals `side_deadbeef` (`python3 rcon-local.py sv_password`).

## 3. Password survives a changelevel (the controller ruling)

```
python3 rcon-local.py "sv_password" "changelevel <current map>" 
# wait for the map to finish loading, then:
python3 rcon-local.py "sv_password"
```

Expect `sv_password` unchanged across the changelevel. Without the
`OnConfigsExecuted` re-assertion this reverts to the standing password
within about a second of the new map's configs running (server.cfg ->
local.cfg -> secrets.cfg).

## 4. Signed PUGSIDE lines

In one terminal:

```
python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('0.0.0.0', 9999))
while True:
    data, addr = s.recvfrom(65535)
    print(data.decode('utf-8', 'replace'))
"
```

In another:

```
python3 /home/volence/l4d1-ds/rcon-local.py "logaddress_add 192.168.4.85:9999"   # LAN address: 127.0.0.1 never delivers
```

Rejoin or reconnect to trigger `event=join`, and watch for the `mapstart`
line from step 3's changelevel. Expect lines shaped like:

```
PUGSIDE event=join token=deadbeef01 steamid=765611980xxxxxxxx lseq=... mac=...
PUGSIDE event=mapstart token=deadbeef01 map=l4d_vs_hospital01_apartment lseq=... mac=...
```

(`lseq=`/`mac=` only appear once `sm_pug_log_secret` is set to 32-64
lowercase hex; set it back to "" afterwards so its data file is removed; empty locally is
fine, the line still carries `event=`/`token=`/`map=`/`steamid=` in order.)

## 5. Queue pop and in-game ready

```
python3 rcon-local.py "sm_side_popped"
```

Expect: seated players moved to spectate, center text "QUEUE POPPED: type
!ready", and typing `!ready` in chat:
- prints a `PUGSIDE event=ready token=... steamid=...` line on the listener
  from step 4;
- does NOT ready you up in the pause/readyup system (that command,
  `sm_ready`, is intercepted and `Plugin_Handled` while popped).

## 6. Vote

```
python3 rcon-local.py 'sm_side_vote "no_mercy=No Mercy" "death_toll=Death Toll"'
```

Expect a menu on seated clients; picking an option prints `PUGOK vote=2` on
the rcon reply and, on pick, a listener line
`PUGSIDE event=vote token=... steamid=... campaign=no_mercy` (or
`death_toll`).

## 7. Stop and confirm cleanup

```
python3 rcon-local.py "sm_side_stop deadbeef01" "sm_pug_auto_track" "sv_password"
```

Expect:
- `PUGOK side stop`.
- `sm_pug_auto_track` back to its pre-step-2 value.
- `sv_password` **unchanged** (the plugin never blanks it on stop; a real
  stop from the site is always followed by `ServerReleaser.release(...,
  { forceRestart: true })`, which itself ends in `exec secrets.cfg`).

## 8. Confirm nothing was recorded

```
python3 rcon-local.py "sm_pug_status"
```

Expect no match shown, consistent with the global constraint that a side
game leaves no `matches` row, no SR, no replay, and no site history.

## 9. Clean up

```
python3 rcon-local.py "sm plugins unload pug-sidegame" \
                       "logaddress_del 192.168.4.85:9999"
rm /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins/pug-sidegame.smx
python3 rcon-local.py "exec secrets.cfg"   # restore the standing sv_password if present
```

Leave the server exactly as found (stop it if it was not already running
before this runbook, otherwise leave it running).

---

## Results

**2026-09-29, ~06:13 UTC.** Ran `python3 /home/volence/l4d1-ds/rcon-local.py
status` before touching anything, per step 0:

```
hostname: [TS] Dallas L4D1 Versus - Rotoblin
map     : l4d_vs_hospital01_apartment
players : 1 humans, 0 bots (19 max) (not hibernating) (unreserved)
#  8 1 "Mal" STEAM_1:1:35074132 32:17 10 0 active 100000 192.168.4.85:27005
```

A human player ("Mal") is connected. Per the runbook rule (any human
players present -> do not touch the server), the live runbook (steps 1-9)
was **skipped entirely**. Nothing was copied, loaded, started, or changed on
`/home/volence/l4d1-ds`.

Verified instead, offline:
- `./build-sidegame.sh` compiles `pug-sidegame.sp` clean: the only compiler
  warning is `include\halflife.inc(655): symbol "CreateDialog" is
  deprecated`, inside a vendored stock include this plugin does not call
  into (same pre-existing warning `build-tvwatch.sh`/`l4d_tvwatch.sp`
  produces); nothing in `pug-sidegame.sp` itself triggers a warning.
- Read through the command contract against `src/sideGames.ts` on this
  branch to confirm argument order and command names (`sm_side_start
  <token> <password>`, `sm_side_roster <id64>:<A|B|S> ...`,
  `sm_side_popped`, `sm_side_resume`, `sm_side_vote "slug=Name" ...`,
  `sm_side_notice <id64> "text"`, `sm_side_stop <token>`), and the exact
  `PUGSIDE` line shape against `src/logParse.ts`'s parser (token
  `/^[0-9a-f]{8,64}$/`, map `/^[A-Za-z0-9_.-]{1,64}$/`, campaign
  `/^[a-z0-9_]{1,64}$/`, key order `event= token= [steamid=] [map=]
  [campaign=]`).
- Confirmed `sm_ready` is the pause module's unpause/ready command
  (`rotoblin.pause.sp`, `RegConsoleCmd("sm_ready", Unpause_Cmd, ...)`),
  reachable via SourceMod's own "!"/"/" chat-trigger resolution for any
  registered console command (hence `!ready` reaching it) - not from
  `l4dready.sp`, whose own ready-up is chat-substring matched
  (`!r`/`/r`/"ready...") and has no `sm_ready` command of its own.
  `AddCommandListener(Listen_Ready, "sm_ready")` intercepts the right
  command either way, since it is a console-command listener, not tied to
  which plugin owns the handler.
- Confirmed the `sv_password` re-assertion pattern against
  `pug-match.sp`'s own `OnConfigsExecuted` (its comment on why the
  re-assertion has to happen there, not from the backend, because
  `OnConfigsExecuted` is the one hook that fires after `secrets.cfg` has
  already run for the map).

**Not verified this session** (blocked by the human player on the shared
box): the plugin actually loading without error on a live srcds process,
the team-lock timer moving a real client, the in-game `!ready` interception
in practice, the vote menu rendering, and the signed `PUGSIDE` lines
actually appearing on a UDP listener. Re-run steps 1-9 above once the box is
confirmed empty.

---

## Step 1 results, 2026-09-29 (this session, run for real)

The shared local box still had a human player connected (see Results
above), so only the offline suite was run. All four commands were run for
real, from the worktree `/home/volence/l4d/pug/.claude/worktrees/side-games`:

- `npx vitest run`: **513 test files passed, 8157 tests passed.** No
  failures. The run prints a handful of `ECONNRESET`/`ECONNREFUSED` stack
  traces to stderr; those are expected noise from tests that exercise
  unreachable-server error paths, not failures (the summary line confirms
  0 failed). Duration about 39 s.
- `npm run typecheck`: **clean**, no output beyond the two `tsc --noEmit`
  invocations it runs (root, then `web/tsconfig.json`). No errors.
- `npm run build`: **succeeded** (`vite build`, 375 modules transformed).
  One pre-existing warning, unrelated to side games: the main JS chunk
  (`dist/public/assets/index-*.js`, ~1.17 MB) is larger than the 500 kB
  chunk-size guideline Vite warns about by default.
- `plugin/build-sidegame.sh`: **succeeded**, output
  `plugin/pug-sidegame.smx` (28708 bytes code, 8332 bytes data). One
  compiler warning, the same pre-existing one noted in the Results section
  above: `include\halflife.inc(655): symbol "CreateDialog" is marked as
  deprecated`, inside a vendored stock include this plugin does not call
  into. Nothing in `pug-sidegame.sp` itself triggers a warning. The `.smx`
  is covered by `plugin/*.smx` in `.gitignore` and was not committed.

## End-to-end rehearsal, 2026-09-29 ~02:40-03:03 local (run for real)

Box checked first: no game client running (`pgrep -af '[l]eft4dead\.exe'`
empty), `status` showed 0 humans on `/home/volence/l4d1-ds` (port 27015,
already running, not started by this session). A second srcds on 27025
(`l4d1-ds-tankrules`) belongs to someone else and was not touched.
Baseline recorded: map `l4d_vs_hospital01_apartment`, `sv_password
"dunged"`, `sm_pug_auto_track 0`, `survivor_limit`/`z_max_player_zombies`
4, `l4d_ready_server_cfg rotoblin_pub_map.cfg`, no logaddress,
`sm_pug_log_secret ""`, no `data/pug_logauth_27015.txt`. The cheats config
was not loaded (this test needs the side game's own configs).

Batches that the site sends were driven through the site's own
`RconClient` (src/rcon.ts, one connection, commands in order, exactly like
`realServerRcon`), not only through `rcon-local.py`, because
`rcon-local.py` dies on the `exec` (the config's `sm_restartmap` reloads
the map about 2 s later and resets the socket), which would hide the
batch's later replies. Log lines went to a UDP listener on
`192.168.4.85:27599` via `logaddress_add` (a 127.0.0.1 logaddress never
delivers on this box).

### A. Plugin checks (steps 1-9 above)

- PASS: plugin loads (`sm plugins load pug-sidegame`, status running).
- PASS: replies before arming: `sm_side_roster`/`sm_side_popped` ->
  `PUGERR not active`, `sm_side_vote` -> `PUGERR not popped`,
  `sm_side_start short x` -> `PUGERR bad token`, one arg -> `PUGERR usage`,
  `sm_side_stop` while unarmed -> `PUGOK side stop` (no-op).
- FAIL, then FIXED: the site's open batch replied `PUGOK roster=0` for a
  five-seat roster. Source's tokenizer splits unquoted `id:A` on ':'.
  Fixed on both sides (site quotes each seat; plugin accepts quoted or
  split seats and answers `PUGERR bad seat: ...` for anything it cannot
  read). Re-run: quoted roster -> `PUGOK roster=5`, unquoted -> `PUGOK
  roster=3` (3 seats sent), `7656119000000000x:B` -> `PUGERR bad seat`,
  `...:Q` -> `PUGERR bad seat`.
- PASS: the open batch (`sv_password`, `exec rotoblin_hardcore_2v2`,
  `sm_side_start`, `sm_side_roster`, `changelevel`): `PUGOK side start`,
  `sm_pug_auto_track` went 1 -> 0 (set to 1 beforehand to make the
  save/restore visible), `sv_password` = side password.
- PASS (the key ruling): `sv_password` still equals the side password
  after the batch's `changelevel` (smalltown01, then airport01), after
  plain `changelevel`s, and after each `exec` restart. After
  `sm_side_stop` a changelevel does NOT re-assert it (secrets.cfg's
  standing password came back).
- PASS: `exec rotoblin_hardcore_2v2` -> `survivor_limit` and
  `z_max_player_zombies` 2; `exec rotoblin_hardcore_3v3` -> 3; back to 2v2
  -> 2. Each exec restarts the map (about 2 s later) and a new `mapstart`
  line arrives; no `mapend` from those restarts.
- PASS: `PUGSIDE event=mapstart token=... map=...` on every map load while
  armed; none after stop. With a 32-hex `sm_pug_log_secret` the lines
  carry `lseq=<boot>.<n> mac=...`; the site's own `parseLogDatagram`
  parsed them as `kind: 'side'` and `macOf` verified every MAC. (A secret
  that is not 32-64 lowercase hex is ignored by pug-logauth and lines go
  out unsigned; that is by design.)
- PASS: `sm_side_popped` -> `PUGOK popped`; `sm_side_vote` with three
  options -> `PUGOK vote=3`; `sm_side_notice <id> "..."` -> `PUGOK
  notice` (text with an apostrophe inside the quotes is fine);
  `sm_side_resume` -> `PUGOK resume`, after which `sm_side_vote` is
  `PUGERR not popped` again.
- PASS: `sm_side_stop <wrong>` -> `PUGERR token`; the right token ->
  `PUGOK side stop`, `sm_pug_auto_track` restored to 1, `sv_password`
  left alone.
- PASS: `sm_pug_status` -> `state=none match=0` throughout (nothing
  tracked).
- SKIPPED: `mapend`. It needs a half that went live (readyup
  `OnRoundIsLive`) and a second-half round_end, i.e. two teams actually
  playing a map. Not reachable with one client. Covered by the negative
  check above (no `mapend` from exec restarts).

Client checks (owner's L4D1 client through
`/home/volence/l4d/hud/ingame-harness`, `flock .lock ./run.sh none
<steps> <out>`, restore verified both runs). The client must set
`password <pw>` as its own console line BEFORE `connect`; `password X;
connect ...` on one line left it on the "Server Requires Password"
dialog (first run timed out and was restored cleanly).

- PASS (needs the sv_lan fallback, fixed): `PUGSIDE event=join ...
  steamid=76561198030413993` for STEAM_1:1:35074132 on the sv_lan 1 box.
- PASS: team lock. Seated A -> stayed on Infected (orientation read from
  where A stands); roster to S -> moved to Spectator within 2 s; back to A
  -> moved to Infected; S then B -> moved to Survivor via `sm_sur`.
- PASS: `sm_side_popped` moved the client to Spectator, chat "[Side] The
  queue popped. Type !ready now ...". `say !ready` -> `PUGSIDE
  event=ready ... steamid=76561198030413993`; no readyup/pause reaction
  in the client console.
- PASS: `sm_side_vote` showed the menu "Queue popped: campaign vote" with
  No Mercy / Dead Air / Death Toll (screenshot), `menuselect 2` ->
  `PUGSIDE event=vote ... campaign=airport` and chat "[Side] Vote sent.";
  `sm_side_notice` text arrived in chat.
- PASS: `disconnect` -> `PUGSIDE event=part ... steamid=...`.

Clean-up: `sm_side_stop`, `sm_pug_auto_track 0`, `exec rotoblin_pub`,
`changelevel l4d_vs_hospital01_apartment`, `sm_pug_log_secret ""` (its data
file removed again), plugin unloaded and its .smx removed, logaddress
deleted, listener stopped. Verified after: map hospital01, `sv_password
dunged`, sizes 4/4, `rotoblin_pub_map.cfg`, `sm_pug_auto_track 0`, no
logaddress, no side game plugin. Left behind, harmless: `sm_pug_log_seq`
advanced to 8 under the process's boot stamp.

### B. Full web-queue end-to-end: SKIPPED

Not practical safely on this box. Every side-game close goes through
`ServerReleaser.release(id, { restart: true, forceRestart: true })`,
which ends in `quit` (src/serverRestart.ts `kickThenQuit`). The shared
local srcds runs with `-norestart` and was not started by the rehearsal,
so the first close (or the popped match's abort) would stop it for good.
A non-dev backend also runs its fleet jobs (log address and secret push,
ban/admin sync, reconcile) against every server row. What it would take:
a srcds the rehearsal starts itself on a spare port under a restart loop
(no `-norestart`, so `quit` comes back), a scratch `DB_PATH` holding only
that box, `sidegames_enabled 1`, `LOG_PUBLIC_ADDRESS` on the LAN address,
signed session cookies (`@fastify/cookie` HMAC-SHA256 of
`<id>.<issuedAt>.<epoch>` with `COOKIE_SECRET`) for 8 fake players, and a
client joining with `password` set before `connect`.

Checks, all **SKIPPED** for that reason:

- [ ] SKIPPED: the side game opens on the box, the site shows the connect
  line, and you are placed in game.
- [ ] SKIPPED: a 5th opt-in appears as `S` and is seated at the next map.
- [ ] SKIPPED: four more joins pop the queue; `!ready` in game readies you
  on the site.
- [ ] SKIPPED: the match goes onto the same box and
  `side_games.end_reason = 'match'`.
- [ ] SKIPPED: no `matches` row exists for the side game period and no
  replay was written.

## Go-live notes (not executed)

These are notes for going live, not a record of anything done. No live box
has been touched.

1. Stage `pug-sidegame.smx` on all pool boxes via
   `deploy/tools/stage-on-restart.sh` so it lands between matches.
2. Deploy web with `deploy-web.sh`.
3. Turn on `sidegames_enabled` from the admin panel while the owner watches
   the first one.
4. Turn the setting on only after the live rehearsal above (sections A and
   B) has actually passed, not before, and not on the strength of the
   offline Step 1 results alone.
5. Before turning the setting on, confirm the plugin is staged on *every*
   pool box, not just one or a few. A side game can open on any idle box
   the matchmaker would otherwise claim; a side game opened on a box that
   does not have `pug-sidegame.smx` loaded would get back `PUGERR` or an
   unknown-command error from `sm_side_start`, and the site treats that
   exactly like any other refused open: `rcon_failed`, and it closes the
   side game right away.
6. Live boxes are never touched without the owner's explicit go-ahead.
